//! Streaming integrity for Account-scoped durable binary dependencies. No artifact bytes are kept.
use super::limits::exceeded;
use super::{
    archive::{DecodedRecord, EntryHeader},
    transfer::invalid,
};
use crate::vault_image::{
    protected::{recovery::PortableImageKey, validate_metadata_scope, ProtectedImageMetadata},
    VaultImageArtifactMetadata, VaultImageArtifactScope,
};
use crate::RecoveryBound;
use crate::RuntimeError;
use serde::{Deserialize, Serialize};
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
pub(super) struct ArtifactMetadata {
    pub(super) account_id: String,
    pub(super) operation_id: String,
    pub(super) attachment_id: String,
    pub(super) artifact_id: String,
    #[serde(with = "crate::wire::decimal_u64")]
    pub(super) byte_length: u64,
    pub(super) chunk_count: u32,
    pub(super) ciphertext_sha256: String,
    pub(super) publication_state: String,
    pub(super) durable_chunk_count: u32,
    #[serde(default)]
    pub(super) physical_generation: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ProvisionalMetadata {
    pub(super) account_id: String,
    pub(super) operation_id: String,
    pub(super) attachment_id: String,
    pub(super) generation: String,
    pub(super) current: bool,
    pub(super) publication_state: u8,
    pub(super) durable_chunk_count: u32,
    pub(super) durable_byte_length: u64,
    #[serde(default)]
    pub(super) minimum_chunk_index: Option<u32>,
    #[serde(default)]
    pub(super) maximum_chunk_index: Option<u32>,
    #[serde(default)]
    pub(super) artifact_id: Option<String>,
    #[serde(default)]
    pub(super) ciphertext_sha256: Option<String>,
    #[serde(default)]
    pub(super) byte_length: Option<String>,
    #[serde(default)]
    pub(super) chunk_count: Option<u32>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ImageMetadata {
    pub(super) account_id: String,
    pub(super) operation_id: String,
    pub(super) vault_id: String,
    #[serde(with = "crate::wire::decimal_u64")]
    pub(super) byte_length: u64,
    pub(super) content_type: String,
    pub(super) sha256: String,
    pub(super) published: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) publication_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) protection: Option<ProtectedImageMetadata>,
}
impl ImageMetadata {
    pub(super) fn original(&self) -> Result<VaultImageArtifactMetadata, RuntimeError> {
        VaultImageArtifactMetadata::new(
            VaultImageArtifactScope::new(self.account_id.clone().into(), &self.operation_id)?,
            &self.vault_id,
            self.byte_length,
            &self.content_type,
            &self.sha256,
        )
    }
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
    portable_key: bool,
}
type ProvisionalKey = (String, String, String);

pub(crate) struct ArtifactInventory {
    account_id: String,
    artifacts: HashMap<String, Artifact>,
    provisional: HashMap<ProvisionalKey, Provisional>,
    images: HashMap<(String, String), Image>,
    requires_portable_keys: bool,
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
            requires_portable_keys: false,
            record_hashes: HashMap::new(),
            summary_bytes: 0,
        }
    }
    pub(super) fn translate_image_key(
        &mut self,
        record: &DecodedRecord,
        current: &Self,
        user_id: &str,
        device_key: &[u8],
    ) -> Result<(), RuntimeError> {
        let EntryHeader::ProtectedVaultImageKey {
            operation_id,
            publication_id,
            ..
        } = &record.header
        else {
            return Ok(());
        };
        let image = self
            .images
            .get_mut(&(operation_id.clone(), publication_id.clone()))
            .ok_or_else(invalid)?;
        let portable: PortableImageKey =
            serde_json::from_slice(&record.body).map_err(|_| invalid())?;
        let protection = image.metadata.protection.as_ref().ok_or_else(invalid)?;
        let existing = current
            .image_metadata(operation_id, publication_id)
            .and_then(|metadata| metadata.protection.as_ref());
        image.metadata.protection = Some(
            crate::vault_image::protected::recovery::rewrap_or_reuse_key(
                &image.metadata.original()?,
                user_id,
                &protection.witness,
                &portable,
                device_key,
                existing,
            )?,
        );
        Ok(())
    }
    pub(super) fn require_portable_keys(&mut self) {
        self.requires_portable_keys = true;
    }
    pub(super) fn has_protected_images(&self) -> bool {
        self.images
            .keys()
            .any(|(_, publication)| !publication.is_empty())
    }
    pub(super) fn image_metadata(
        &self,
        operation: &str,
        publication: &str,
    ) -> Option<&ImageMetadata> {
        self.images
            .get(&(operation.to_owned(), publication.to_owned()))
            .map(|image| &image.metadata)
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
                | EntryHeader::ProtectedVaultImageMetadata { .. }
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
            }
            | EntryHeader::ProtectedVaultImageMetadata {
                account_id,
                operation_id,
                ..
            } => {
                let publication = match &record.header {
                    EntryHeader::ProtectedVaultImageMetadata { publication_id, .. } => {
                        Some(publication_id)
                    }
                    _ => None,
                };
                let value: ImageMetadata =
                    serde_json::from_slice(&record.body).map_err(|_| invalid())?;
                if account_id != &self.account_id
                    || value.account_id != *account_id
                    || value.operation_id != *operation_id
                    || value.publication_id.as_ref() != publication
                    || value.protection.is_some() != publication.is_some()
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
                let original = value.original()?;
                if let Some(protection) = &value.protection {
                    if Some(&protection.witness.publication_id) != publication {
                        return Err(invalid());
                    }
                    original.with_protection(protection.clone())?;
                }
                self.images.insert(
                    (
                        operation_id.clone(),
                        publication.cloned().unwrap_or_default(),
                    ),
                    Image {
                        metadata: value,
                        chunks: Chunks::default(),
                        portable_key: false,
                    },
                );
            }
            EntryHeader::VaultImageChunk {
                account_id,
                operation_id,
                chunk_index,
            }
            | EntryHeader::ProtectedVaultImageChunk {
                account_id,
                operation_id,
                chunk_index,
                ..
            } => {
                if account_id != &self.account_id {
                    return Err(invalid());
                }
                self.images
                    .get_mut(&(
                        operation_id.clone(),
                        match &record.header {
                            EntryHeader::ProtectedVaultImageChunk { publication_id, .. } => {
                                publication_id.clone()
                            }
                            _ => String::new(),
                        },
                    ))
                    .ok_or_else(invalid)?
                    .chunks
                    .push(*chunk_index, None, &record.body)?;
            }
            EntryHeader::ProtectedVaultImageKey {
                account_id,
                operation_id,
                publication_id,
            } => {
                if account_id != &self.account_id || record.body.len() > 8192 {
                    return Err(invalid());
                }
                let image = self
                    .images
                    .get_mut(&(operation_id.clone(), publication_id.clone()))
                    .ok_or_else(invalid)?;
                let protection = image.metadata.protection.as_ref().ok_or_else(invalid)?;
                let key: PortableImageKey =
                    serde_json::from_slice(&record.body).map_err(|_| invalid())?;
                key.validate_metadata(&image.metadata.original()?, protection)?;
                image.portable_key = true;
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
    pub protected_images: HashSet<(String, String)>,
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
            EntryHeader::ProtectedVaultImageMetadata {
                operation_id,
                publication_id,
                ..
            }
            | EntryHeader::ProtectedVaultImageChunk {
                operation_id,
                publication_id,
                ..
            }
            | EntryHeader::ProtectedVaultImageKey {
                operation_id,
                publication_id,
                ..
            } => self
                .protected_images
                .contains(&(operation_id.clone(), publication_id.clone())),
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
            &proof.head.user_id,
            &proof.required_attachments,
            &proof.required_images,
        )
    }
    fn select_dependencies(
        &self,
        account_id: &crate::AccountId,
        user_id: &str,
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
            let publication = required
                .image
                .protected_witness
                .as_ref()
                .map(|witness| witness.publication_id.clone())
                .unwrap_or_default();
            let Some(image) = self
                .images
                .get(&(required.operation_id.clone(), publication.clone()))
            else {
                if required.required_bytes {
                    return Err(invalid());
                } else {
                    continue;
                }
            };
            let value = &image.metadata;
            if !value.published
                || value.vault_id != required.vault_id
                || value.byte_length != required.image.byte_length
                || value.content_type != required.image.content_type
                || value.sha256 != required.image.sha256
            {
                return Err(invalid());
            }
            if let Some(witness) = &required.image.protected_witness {
                let protection = value.protection.as_ref().ok_or_else(invalid)?;
                validate_metadata_scope(&value.original()?, user_id, witness, protection)?;
                if !image.chunks.complete(
                    witness.ciphertext_byte_length,
                    witness.chunk_count,
                    &witness.ciphertext_sha256,
                ) || (self.requires_portable_keys && !image.portable_key)
                {
                    return Err(invalid());
                }
                selected
                    .protected_images
                    .insert((required.operation_id.clone(), publication));
            } else {
                let count = value.byte_length.div_ceil(256 * 1024) as u32;
                if value.protection.is_some()
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
                .select_dependencies(
                    &proof.head.account_id,
                    &proof.head.user_id,
                    std::slice::from_ref(required),
                    &[],
                )
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
                .select_dependencies(
                    &proof.head.account_id,
                    &proof.head.user_id,
                    &[],
                    std::slice::from_ref(required),
                )
                .is_ok()
            {
                continue;
            }
            let header = match &required.image.protected_witness {
                Some(witness) => EntryHeader::ProtectedVaultImageMetadata {
                    account_id: self.account_id.clone(),
                    operation_id: required.operation_id.clone(),
                    publication_id: witness.publication_id.clone(),
                },
                None => EntryHeader::VaultImageMetadata {
                    account_id: self.account_id.clone(),
                    operation_id: required.operation_id.clone(),
                },
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
            pending_vault_retirements: Vec::new(),
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
