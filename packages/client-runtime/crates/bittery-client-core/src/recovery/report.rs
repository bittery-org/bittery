//! Bounded authenticated findings; no row payloads or credentials are copied into this report.
use super::limits::exceeded;
use super::{archive::EntryHeader, control::RecoveryPhysicalSchemas, transfer::invalid};
use crate::RecoveryBound;
use crate::{replica::persistence_contract::ReplicaStore, RuntimeError, RuntimeErrorCode};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

pub(super) const MAX_REPORT_BYTES: usize = 64 * 1024;
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RecoveryReport {
    pub version: u32,
    pub physical_schemas: RecoveryPhysicalSchemas,
    pub source_read_complete: bool,
    pub export_read_complete: bool,
    pub accepted_work_validated: bool,
    pub artifact_dependencies_validated: bool,
    pub exported_record_count: u32,
    pub findings: Vec<RecoveryFinding>,
}
impl RecoveryReport {
    pub fn encode(&self) -> Result<Vec<u8>, RuntimeError> {
        let bytes = serde_json::to_vec(self).map_err(|_| invalid())?;
        if bytes.len() > MAX_REPORT_BYTES {
            return Err(bound());
        }
        Ok(bytes)
    }
    pub fn decode(bytes: &[u8]) -> Result<Self, RuntimeError> {
        if bytes.len() > MAX_REPORT_BYTES {
            return Err(bound());
        }
        let report: Self = serde_json::from_slice(bytes).map_err(|_| invalid())?;
        if report.version != 1
            || report.physical_schemas.replica_version == 0
            || report.physical_schemas.attachment_artifacts_version == 0
            || report.physical_schemas.vault_images_version == 0
        {
            return Err(invalid());
        }
        Ok(report)
    }
    pub fn proves_complete(&self, count: u32) -> bool {
        self.source_read_complete
            && self.export_read_complete
            && self.accepted_work_validated
            && self.artifact_dependencies_validated
            && self.findings.is_empty()
            && self.exported_record_count == count
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(super) enum RecoveryFinding {
    InvalidReplicaHead,
    MissingReplicaHead,
    InvalidAcceptedRelationships,
    InvalidReplicaRow {
        store: ReplicaStore,
        record_id: String,
    },
    InvalidArtifactRecord {
        artifact_id: String,
        chunk_index: Option<u32>,
    },
    InvalidProvisionalRecord {
        operation_id: String,
        attachment_id: String,
        generation: String,
        chunk_index: Option<u32>,
    },
    InvalidVaultImageRecord {
        operation_id: String,
        chunk_index: Option<u32>,
    },
    MissingAttachmentDependency {
        operation_id: String,
        attachment_id: String,
        artifact_id: Option<String>,
    },
    InvalidAttachmentDependency {
        operation_id: String,
        attachment_id: String,
        artifact_id: Option<String>,
    },
    MissingVaultImageDependency {
        operation_id: String,
    },
    InvalidVaultImageDependency {
        operation_id: String,
    },
    InvalidAuthorityRelationships,
    IdentityUnavailable,
    ReadFailure {
        phase: ReadPhase,
        code: RuntimeErrorCode,
    },
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum ReadPhase {
    Capture,
    Export,
}
#[derive(Clone, Default)]
pub(super) struct Findings {
    values: Vec<RecoveryFinding>,
    identities: HashSet<String>,
    bytes: usize,
    overflow: bool,
}
impl Findings {
    pub fn push(&mut self, finding: RecoveryFinding) {
        if self.overflow {
            return;
        }
        let mut encoded = BoundedReportWriter(Vec::new());
        if serde_json::to_writer(&mut encoded, &finding).is_err() {
            self.overflow = true;
            return;
        }
        let Ok(identity) = String::from_utf8(encoded.0) else {
            self.overflow = true;
            return;
        };
        if self.identities.contains(&identity) {
            return;
        }
        let Some(bytes) = self.bytes.checked_add(identity.len() + 1) else {
            self.overflow = true;
            return;
        };
        // Reserve enough for the fixed report fields before retaining each additional finding.
        if bytes > MAX_REPORT_BYTES - 1024 {
            self.overflow = true;
            return;
        }
        self.bytes = bytes;
        self.identities.insert(identity);
        self.values.push(finding);
    }
    pub fn finish(&self) -> Result<Vec<RecoveryFinding>, RuntimeError> {
        if self.overflow {
            Err(bound())
        } else {
            Ok(self.values.clone())
        }
    }
    pub fn record_invalid(&mut self, header: &EntryHeader) {
        let identity_bytes = match header {
            EntryHeader::ReplicaRow { record_id, .. } => record_id.len(),
            EntryHeader::ArtifactMetadata { artifact_id, .. }
            | EntryHeader::ArtifactChunk { artifact_id, .. } => artifact_id.len(),
            EntryHeader::ProvisionalMetadata {
                operation_id,
                attachment_id,
                generation,
                ..
            }
            | EntryHeader::ProvisionalChunk {
                operation_id,
                attachment_id,
                generation,
                ..
            } => operation_id
                .len()
                .saturating_add(attachment_id.len())
                .saturating_add(generation.len()),
            EntryHeader::VaultImageMetadata { operation_id, .. }
            | EntryHeader::VaultImageChunk { operation_id, .. } => operation_id.len(),
            _ => 0,
        };
        if identity_bytes > MAX_REPORT_BYTES {
            self.overflow = true;
            return;
        }
        use RecoveryFinding::*;
        let finding = match header {
            EntryHeader::ReplicaHead { .. } => InvalidReplicaHead,
            EntryHeader::ReplicaRow {
                store, record_id, ..
            } => InvalidReplicaRow {
                store: *store,
                record_id: record_id.clone(),
            },
            EntryHeader::ArtifactMetadata { artifact_id, .. } => InvalidArtifactRecord {
                artifact_id: artifact_id.clone(),
                chunk_index: None,
            },
            EntryHeader::ArtifactChunk {
                artifact_id,
                chunk_index,
                ..
            } => InvalidArtifactRecord {
                artifact_id: artifact_id.clone(),
                chunk_index: Some(*chunk_index),
            },
            EntryHeader::ProvisionalMetadata {
                operation_id,
                attachment_id,
                generation,
                ..
            } => InvalidProvisionalRecord {
                operation_id: operation_id.clone(),
                attachment_id: attachment_id.clone(),
                generation: generation.clone(),
                chunk_index: None,
            },
            EntryHeader::ProvisionalChunk {
                operation_id,
                attachment_id,
                generation,
                chunk_index,
                ..
            } => InvalidProvisionalRecord {
                operation_id: operation_id.clone(),
                attachment_id: attachment_id.clone(),
                generation: generation.clone(),
                chunk_index: Some(*chunk_index),
            },
            EntryHeader::VaultImageMetadata { operation_id, .. } => InvalidVaultImageRecord {
                operation_id: operation_id.clone(),
                chunk_index: None,
            },
            EntryHeader::VaultImageChunk {
                operation_id,
                chunk_index,
                ..
            } => InvalidVaultImageRecord {
                operation_id: operation_id.clone(),
                chunk_index: Some(*chunk_index),
            },
            _ => return,
        };
        self.push(finding);
    }
}
fn bound() -> RuntimeError {
    exceeded(RecoveryBound::ReportBytes)
}

struct BoundedReportWriter(Vec<u8>);
impl std::io::Write for BoundedReportWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > MAX_REPORT_BYTES.saturating_sub(self.0.len()) {
            return Err(std::io::Error::other("Recovery report bound exceeded"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
