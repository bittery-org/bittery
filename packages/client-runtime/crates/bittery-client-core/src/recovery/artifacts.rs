//! Streaming integrity for Account-scoped durable binary dependencies. No artifact bytes are kept.
use super::limits::exceeded;
use super::{
    archive::{DecodedRecord, EntryHeader},
    transfer::invalid,
};
use crate::RecoveryBound;
use crate::RuntimeError;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

const MAX_ARTIFACTS: usize = 4096;
const MAX_SUMMARY_BYTES: usize = 16 * 1024 * 1024;
#[derive(Default)]
struct Chunks {
    count: u32,
    byte_length: u64,
    hash: Sha256,
}
impl Chunks {
    fn push(
        &mut self,
        index: u32,
        declared_hash: Option<&str>,
        bytes: &[u8],
    ) -> Result<(), RuntimeError> {
        if bytes.len() > 256 * 1024 {
            return Err(exceeded(RecoveryBound::ChunkBytes));
        }
        if index != self.count
            || bytes.is_empty()
            || declared_hash.is_some_and(|hash| hash != format!("{:x}", Sha256::digest(bytes)))
        {
            return Err(invalid());
        }
        self.count = self.count.checked_add(1).ok_or_else(invalid)?;
        self.byte_length = self
            .byte_length
            .checked_add(bytes.len() as u64)
            .ok_or_else(invalid)?;
        if self.byte_length > 1024 * 1024 * 1024 {
            return Err(exceeded(RecoveryBound::ArchiveBytes));
        }
        self.hash.update(bytes);
        Ok(())
    }
    fn complete(&self, byte_length: u64, count: u32, hash: &str) -> bool {
        self.byte_length == byte_length
            && self.count == count
            && format!("{:x}", self.hash.clone().finalize()) == hash
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArtifactMetadata {
    account_id: String,
    operation_id: String,
    attachment_id: String,
    artifact_id: String,
    #[serde(with = "crate::wire::decimal_u64")]
    byte_length: u64,
    chunk_count: u32,
    ciphertext_sha256: String,
    publication_state: String,
    durable_chunk_count: u32,
    #[serde(default)]
    physical_generation: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProvisionalMetadata {
    account_id: String,
    operation_id: String,
    attachment_id: String,
    generation: String,
    current: bool,
    publication_state: u8,
    durable_chunk_count: u32,
    durable_byte_length: u64,
    #[serde(default)]
    minimum_chunk_index: Option<u32>,
    #[serde(default)]
    maximum_chunk_index: Option<u32>,
    #[serde(default)]
    artifact_id: Option<String>,
    #[serde(default)]
    ciphertext_sha256: Option<String>,
    #[serde(default)]
    byte_length: Option<String>,
    #[serde(default)]
    chunk_count: Option<u32>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImageMetadata {
    account_id: String,
    operation_id: String,
    vault_id: String,
    #[serde(with = "crate::wire::decimal_u64")]
    byte_length: u64,
    content_type: String,
    sha256: String,
    published: bool,
}
struct Artifact {
    metadata: ArtifactMetadata,
    chunks: Chunks,
}
struct Provisional {
    metadata: ProvisionalMetadata,
    chunks: Chunks,
}
struct Image {
    metadata: ImageMetadata,
    chunks: Chunks,
}
type ProvisionalKey = (String, String, String);

pub(crate) struct ArtifactInventory {
    account_id: String,
    artifacts: HashMap<String, Artifact>,
    provisional: HashMap<ProvisionalKey, Provisional>,
    images: HashMap<String, Image>,
    pub record_hashes: HashMap<String, [u8; 32]>,
    summary_bytes: usize,
}
impl ArtifactInventory {
    pub(crate) fn new(account_id: String) -> Self {
        Self {
            account_id,
            artifacts: HashMap::new(),
            provisional: HashMap::new(),
            images: HashMap::new(),
            record_hashes: HashMap::new(),
            summary_bytes: 0,
        }
    }
    pub(crate) fn observe(&mut self, record: &DecodedRecord) -> Result<(), RuntimeError> {
        let key = record_key(&record.header)?;
        if self.record_hashes.contains_key(&key) {
            return Err(invalid());
        }
        self.summary_bytes = self
            .summary_bytes
            .checked_add(key.len() + 32)
            .ok_or_else(|| exceeded(RecoveryBound::SummaryBytes))?;
        if self.summary_bytes > MAX_SUMMARY_BYTES {
            return Err(exceeded(RecoveryBound::SummaryBytes));
        }
        let mut hash = Sha256::new();
        hash.update(key.as_bytes());
        hash.update(record.body.as_slice());
        self.record_hashes.insert(key, hash.finalize().into());
        let metadata = matches!(
            record.header,
            EntryHeader::ArtifactMetadata { .. }
                | EntryHeader::ProvisionalMetadata { .. }
                | EntryHeader::VaultImageMetadata { .. }
        );
        if metadata {
            if record.body.len() > 64 * 1024 {
                return Err(exceeded(RecoveryBound::RecordBytes));
            }
            if self.artifacts.len() + self.provisional.len() + self.images.len() >= MAX_ARTIFACTS {
                return Err(exceeded(RecoveryBound::ArtifactCount));
            }
            self.summary_bytes = self
                .summary_bytes
                .checked_add(record.body.len())
                .ok_or_else(|| exceeded(RecoveryBound::SummaryBytes))?;
            if self.summary_bytes > MAX_SUMMARY_BYTES {
                return Err(exceeded(RecoveryBound::SummaryBytes));
            }
        }
        match &record.header {
            EntryHeader::ArtifactMetadata {
                account_id,
                artifact_id,
            } => {
                let value: ArtifactMetadata =
                    serde_json::from_slice(&record.body).map_err(|_| invalid())?;
                if account_id != &self.account_id
                    || value.account_id != *account_id
                    || value.artifact_id != *artifact_id
                    || !id(&value.operation_id)
                    || !id(&value.attachment_id)
                    || !sha(&value.ciphertext_sha256)
                    || !sha(artifact_id)
                    || value.byte_length == 0
                    || value.chunk_count == 0
                    || value.durable_chunk_count > value.chunk_count
                    || !matches!(
                        value.publication_state.as_str(),
                        "incomplete" | "verifying" | "published"
                    )
                    || value
                        .physical_generation
                        .as_ref()
                        .is_some_and(|value| !id(value))
                {
                    return Err(invalid());
                }
                self.artifacts.insert(
                    artifact_id.clone(),
                    Artifact {
                        metadata: value,
                        chunks: Chunks::default(),
                    },
                );
            }
            EntryHeader::ArtifactChunk {
                account_id,
                artifact_id,
                chunk_index,
                chunk_sha256,
            } => {
                if account_id != &self.account_id {
                    return Err(invalid());
                }
                self.artifacts
                    .get_mut(artifact_id)
                    .ok_or_else(invalid)?
                    .chunks
                    .push(*chunk_index, Some(chunk_sha256), &record.body)?;
            }
            EntryHeader::ProvisionalMetadata {
                account_id,
                operation_id,
                attachment_id,
                generation,
            } => {
                let value: ProvisionalMetadata =
                    serde_json::from_slice(&record.body).map_err(|_| invalid())?;
                if account_id != &self.account_id
                    || value.account_id != *account_id
                    || value.operation_id != *operation_id
                    || value.attachment_id != *attachment_id
                    || value.generation != *generation
                    || !id(operation_id)
                    || !id(attachment_id)
                    || !id(generation)
                    || value.publication_state > 2
                {
                    return Err(invalid());
                }
                self.provisional.insert(
                    (
                        operation_id.clone(),
                        attachment_id.clone(),
                        generation.clone(),
                    ),
                    Provisional {
                        metadata: value,
                        chunks: Chunks::default(),
                    },
                );
            }
            EntryHeader::ProvisionalChunk {
                account_id,
                operation_id,
                attachment_id,
                generation,
                chunk_index,
                chunk_sha256,
            } => {
                if account_id != &self.account_id {
                    return Err(invalid());
                }
                self.provisional
                    .get_mut(&(
                        operation_id.clone(),
                        attachment_id.clone(),
                        generation.clone(),
                    ))
                    .ok_or_else(invalid)?
                    .chunks
                    .push(*chunk_index, Some(chunk_sha256), &record.body)?;
            }
            EntryHeader::VaultImageMetadata {
                account_id,
                operation_id,
            } => {
                let value: ImageMetadata =
                    serde_json::from_slice(&record.body).map_err(|_| invalid())?;
                if account_id != &self.account_id
                    || value.account_id != *account_id
                    || value.operation_id != *operation_id
                    || !id(operation_id)
                    || !id(&value.vault_id)
                    || value.byte_length == 0
                    || value.byte_length > 2 * 1024 * 1024
                    || !sha(&value.sha256)
                    || !matches!(
                        value.content_type.as_str(),
                        "image/jpeg" | "image/png" | "image/webp" | "image/gif" | "image/avif"
                    )
                {
                    return Err(invalid());
                }
                self.images.insert(
                    operation_id.clone(),
                    Image {
                        metadata: value,
                        chunks: Chunks::default(),
                    },
                );
            }
            EntryHeader::VaultImageChunk {
                account_id,
                operation_id,
                chunk_index,
            } => {
                if account_id != &self.account_id {
                    return Err(invalid());
                }
                self.images
                    .get_mut(operation_id)
                    .ok_or_else(invalid)?
                    .chunks
                    .push(*chunk_index, None, &record.body)?;
            }
            _ => return Err(invalid()),
        }
        Ok(())
    }
}
fn id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || b"._~-".contains(&value))
}
fn sha(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|value| value.is_ascii_digit() || (b'a'..=b'f').contains(&value))
}
pub(crate) fn record_key(header: &EntryHeader) -> Result<String, RuntimeError> {
    serde_json::to_string(header).map_err(|_| invalid())
}

/// Only entries selected by validated accepted work may be included in a complete archive/repair.
#[derive(Default)]
pub(crate) struct ArtifactSelection {
    pub artifact_ids: HashSet<String>,
    pub direct_artifact_ids: HashSet<String>,
    pub provisional: HashSet<ProvisionalKey>,
    pub image_operations: HashSet<String>,
}
impl ArtifactSelection {
    pub(crate) fn includes(&self, header: &EntryHeader) -> bool {
        match header {
            EntryHeader::ArtifactMetadata { artifact_id, .. } => {
                self.artifact_ids.contains(artifact_id)
            }
            EntryHeader::ArtifactChunk { artifact_id, .. } => {
                self.direct_artifact_ids.contains(artifact_id)
            }
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
            } => self.provisional.contains(&(
                operation_id.clone(),
                attachment_id.clone(),
                generation.clone(),
            )),
            EntryHeader::VaultImageMetadata { operation_id, .. }
            | EntryHeader::VaultImageChunk { operation_id, .. } => {
                self.image_operations.contains(operation_id)
            }
            _ => false,
        }
    }
}

impl ArtifactInventory {
    pub(crate) fn select(
        &self,
        proof: &crate::replica::recovery::CoverageProof,
    ) -> Result<ArtifactSelection, RuntimeError> {
        self.select_dependencies(
            &proof.head.account_id,
            &proof.required_attachments,
            &proof.required_images,
        )
    }
    fn select_dependencies(
        &self,
        account_id: &crate::AccountId,
        attachments: &[crate::replica::recovery::RequiredAttachment],
        images: &[crate::replica::recovery::RequiredImage],
    ) -> Result<ArtifactSelection, RuntimeError> {
        let mut selected = ArtifactSelection::default();
        for required in attachments {
            if let Some(reference) = &required.artifact {
                let artifact = self
                    .artifacts
                    .get(&reference.artifact_id)
                    .ok_or_else(invalid)?;
                let value = &artifact.metadata;
                let canonical = crate::replica::attachment_move_artifact_ref(
                    account_id,
                    &required.operation_id,
                    &required.attachment_id,
                    &reference.ciphertext_sha256,
                    reference.byte_length,
                )?;
                if canonical != *reference
                    || value.operation_id != required.operation_id
                    || value.attachment_id != required.attachment_id
                    || value.ciphertext_sha256 != reference.ciphertext_sha256
                    || value.byte_length != reference.byte_length
                    || value.publication_state != "published"
                    || value.durable_chunk_count != value.chunk_count
                {
                    return Err(invalid());
                }
                selected.artifact_ids.insert(reference.artifact_id.clone());
                if let Some(generation) = &value.physical_generation {
                    let key = (
                        required.operation_id.clone(),
                        required.attachment_id.clone(),
                        generation.clone(),
                    );
                    let provisional = self.provisional.get(&key).ok_or_else(invalid)?;
                    self.validate_provisional(provisional)?;
                    validate_published_mapping(artifact, provisional)?;
                    selected.provisional.insert(key);
                } else {
                    if !artifact.chunks.complete(
                        value.byte_length,
                        value.chunk_count,
                        &value.ciphertext_sha256,
                    ) {
                        return Err(invalid());
                    }
                    selected
                        .direct_artifact_ids
                        .insert(reference.artifact_id.clone());
                }
            } else {
                let matching: Vec<_> = self
                    .provisional
                    .iter()
                    .filter(|((operation, attachment, _), value)| {
                        operation == &required.operation_id
                            && attachment == &required.attachment_id
                            && value.metadata.current
                    })
                    .collect();
                if matching.len() > 1 {
                    return Err(invalid());
                }
                for (key, value) in matching {
                    self.validate_provisional(value)?;
                    selected.provisional.insert(key.clone());
                    if value.metadata.publication_state == 2 {
                        let artifact_id =
                            value.metadata.artifact_id.as_ref().ok_or_else(invalid)?;
                        let artifact = self.artifacts.get(artifact_id).ok_or_else(invalid)?;
                        validate_published_mapping(artifact, value)?;
                        selected.artifact_ids.insert(artifact_id.clone());
                    }
                }
            }
        }
        for required in images {
            let Some(image) = self.images.get(&required.operation_id) else {
                if required.required_bytes {
                    return Err(invalid());
                } else {
                    continue;
                }
            };
            let value = &image.metadata;
            let count = value.byte_length.div_ceil(256 * 1024) as u32;
            if !value.published
                || value.vault_id != required.vault_id
                || value.byte_length != required.image.byte_length
                || value.content_type != required.image.content_type
                || value.sha256 != required.image.sha256
                || !image
                    .chunks
                    .complete(value.byte_length, count, &value.sha256)
            {
                return Err(invalid());
            }
            selected
                .image_operations
                .insert(required.operation_id.clone());
        }
        Ok(selected)
    }
    pub(super) fn append_findings(
        &self,
        proof: &crate::replica::recovery::CoverageProof,
        read_complete: bool,
        findings: &mut super::report::Findings,
    ) {
        use super::report::RecoveryFinding;
        // An unfinished enumeration cannot prove an absent dependency or broken relationship.
        if !read_complete {
            return;
        }
        for required in &proof.required_attachments {
            if self
                .select_dependencies(&proof.head.account_id, std::slice::from_ref(required), &[])
                .is_ok()
            {
                continue;
            }
            let artifact_id = required
                .artifact
                .as_ref()
                .map(|value| value.artifact_id.clone());
            let missing = read_complete
                && artifact_id.as_ref().is_some_and(|id| {
                    let header = EntryHeader::ArtifactMetadata {
                        account_id: self.account_id.clone(),
                        artifact_id: id.clone(),
                    };
                    record_key(&header).is_ok_and(|key| !self.record_hashes.contains_key(&key))
                });
            findings.push(if missing {
                RecoveryFinding::MissingAttachmentDependency {
                    operation_id: required.operation_id.clone(),
                    attachment_id: required.attachment_id.clone(),
                    artifact_id,
                }
            } else {
                RecoveryFinding::InvalidAttachmentDependency {
                    operation_id: required.operation_id.clone(),
                    attachment_id: required.attachment_id.clone(),
                    artifact_id,
                }
            });
        }
        for required in &proof.required_images {
            if self
                .select_dependencies(&proof.head.account_id, &[], std::slice::from_ref(required))
                .is_ok()
            {
                continue;
            }
            let header = EntryHeader::VaultImageMetadata {
                account_id: self.account_id.clone(),
                operation_id: required.operation_id.clone(),
            };
            let missing = read_complete
                && record_key(&header).is_ok_and(|key| !self.record_hashes.contains_key(&key));
            findings.push(if missing {
                RecoveryFinding::MissingVaultImageDependency {
                    operation_id: required.operation_id.clone(),
                }
            } else {
                RecoveryFinding::InvalidVaultImageDependency {
                    operation_id: required.operation_id.clone(),
                }
            });
        }
    }
    fn validate_provisional(&self, value: &Provisional) -> Result<(), RuntimeError> {
        let metadata = &value.metadata;
        let count = value.chunks.count;
        if count != metadata.durable_chunk_count
            || value.chunks.byte_length != metadata.durable_byte_length
            || metadata.minimum_chunk_index != (count > 0).then_some(0)
            || metadata.maximum_chunk_index != (count > 0).then(|| count - 1)
        {
            return Err(invalid());
        }
        if metadata.publication_state > 0 {
            let length = metadata
                .byte_length
                .as_deref()
                .ok_or_else(invalid)?
                .parse::<u64>()
                .map_err(|_| invalid())?;
            if metadata.byte_length.as_deref() != Some(length.to_string().as_str()) {
                return Err(invalid());
            }
            let hash = metadata.ciphertext_sha256.as_deref().ok_or_else(invalid)?;
            if !value
                .chunks
                .complete(length, metadata.chunk_count.ok_or_else(invalid)?, hash)
            {
                return Err(invalid());
            }
            let owner = crate::replica::attachment_move_artifact_ref(
                &crate::AccountId::from(self.account_id.clone()),
                &metadata.operation_id,
                &metadata.attachment_id,
                hash,
                length,
            )?;
            if metadata.artifact_id.as_deref() != Some(owner.artifact_id.as_str()) {
                return Err(invalid());
            }
        }
        Ok(())
    }
}

fn validate_published_mapping(
    artifact: &Artifact,
    provisional: &Provisional,
) -> Result<(), RuntimeError> {
    let published = &artifact.metadata;
    let staged = &provisional.metadata;
    if staged.publication_state != 2
        || published.publication_state != "published"
        || published.account_id != staged.account_id
        || published.operation_id != staged.operation_id
        || published.attachment_id != staged.attachment_id
        || published.physical_generation.as_ref() != Some(&staged.generation)
        || staged.artifact_id.as_ref() != Some(&published.artifact_id)
        || staged.ciphertext_sha256.as_ref() != Some(&published.ciphertext_sha256)
        || staged.byte_length.as_deref() != Some(published.byte_length.to_string().as_str())
        || staged.chunk_count != Some(published.chunk_count)
        || published.durable_chunk_count != published.chunk_count
    {
        return Err(invalid());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::replica::{
        attachment_move_artifact_ref,
        persistence_contract::ReplicaHead,
        recovery::{CoverageProof, RequiredAttachment},
    };
    use serde_json::json;
    use zeroize::Zeroizing;
    fn record(header: EntryHeader, body: Vec<u8>) -> DecodedRecord {
        DecodedRecord {
            header,
            body: Zeroizing::new(body),
        }
    }
    #[test]
    fn pending_published_provisional_requires_exact_published_metadata_binding() {
        let bytes = b"retained encrypted provisional chunk";
        let hash = format!("{:x}", Sha256::digest(bytes));
        let owner = attachment_move_artifact_ref(
            &"account".into(),
            "operation",
            "attachment",
            &hash,
            bytes.len() as u64,
        )
        .unwrap();
        let published = json!({"accountId":"account","operationId":"operation","attachmentId":"attachment","artifactId":owner.artifact_id,"byteLength":bytes.len().to_string(),"chunkCount":1,"ciphertextSha256":hash,"publicationState":"published","durableChunkCount":1,"physicalGeneration":"generation"});
        let provisional = json!({"accountId":"account","operationId":"operation","attachmentId":"attachment","generation":"generation","current":true,"publicationState":2,"durableChunkCount":1,"durableByteLength":bytes.len(),"minimumChunkIndex":0,"maximumChunkIndex":0,"artifactId":owner.artifact_id,"ciphertextSha256":hash,"byteLength":bytes.len().to_string(),"chunkCount":1});
        let proof = CoverageProof {
            head: ReplicaHead {
                account_id: "account".into(),
                user_id: "user".into(),
                incarnation: "incarnation".into(),
                replica_revision: 1,
                lock_epoch: 1,
                failure: None,
            },
            rows: Vec::new(),
            operation_count: 0,
            preparation_count: 1,
            receipt_count: 0,
            required_attachments: vec![RequiredAttachment {
                operation_id: "operation".into(),
                attachment_id: "attachment".into(),
                artifact: None,
            }],
            required_images: Vec::new(),
            authority_valid: true,
        };
        for change in [
            None,
            Some(("ciphertextSha256", json!("f".repeat(64)))),
            Some(("byteLength", json!((bytes.len() + 1).to_string()))),
            Some(("chunkCount", json!(2))),
            Some(("durableChunkCount", json!(0))),
        ] {
            let mut published = published.clone();
            if let Some((field, value)) = &change {
                published[*field] = value.clone();
            }
            let mut inventory = ArtifactInventory::new("account".into());
            inventory
                .observe(&record(
                    EntryHeader::ArtifactMetadata {
                        account_id: "account".into(),
                        artifact_id: owner.artifact_id.clone(),
                    },
                    serde_json::to_vec(&published).unwrap(),
                ))
                .unwrap();
            inventory
                .observe(&record(
                    EntryHeader::ProvisionalMetadata {
                        account_id: "account".into(),
                        operation_id: "operation".into(),
                        attachment_id: "attachment".into(),
                        generation: "generation".into(),
                    },
                    serde_json::to_vec(&provisional).unwrap(),
                ))
                .unwrap();
            inventory
                .observe(&record(
                    EntryHeader::ProvisionalChunk {
                        account_id: "account".into(),
                        operation_id: "operation".into(),
                        attachment_id: "attachment".into(),
                        generation: "generation".into(),
                        chunk_index: 0,
                        chunk_sha256: hash.clone(),
                    },
                    bytes.to_vec(),
                ))
                .unwrap();
            assert_eq!(
                inventory.select(&proof).is_ok(),
                change.is_none(),
                "published/provisional metadata mismatch must never be Complete"
            );
        }
    }
}
