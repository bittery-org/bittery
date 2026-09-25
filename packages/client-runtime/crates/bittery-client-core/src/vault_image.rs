//! Bounded Vault-image ingress and protected publication, with legacy raw compatibility.
//!
//! This existing store owns image publication and cleanup. Core separately admits Operations,
//! gates plaintext access and dispatches network work.

use crate::{AccountId, RequestCancellation, RuntimeError, RuntimeErrorCode};
use async_trait::async_trait;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
};
use zeroize::{Zeroize, Zeroizing};

mod inventory;
pub use inventory::{
    VaultImageInventoryContinuation, VaultImageInventoryFamily, VaultImageInventoryPage,
    VaultImageInventorySchema, VaultImagePhysicalKey,
};
pub(crate) mod protected;
#[cfg(not(target_arch = "wasm32"))]
pub(crate) mod sqlite;
#[cfg(test)]
mod tests;
#[cfg(not(target_arch = "wasm32"))]
pub use sqlite::SqliteVaultImageArtifactStore;

pub const VAULT_IMAGE_CHUNK_BYTES: usize = 256 * 1024;
pub const VAULT_IMAGE_MAX_BYTES: u64 = 2_097_152;
const ALLOWED_CONTENT_TYPES: [&str; 5] = [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "image/avif",
];

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct VaultImageArtifactScope {
    account_id: AccountId,
    operation_id: String,
    publication_id: Option<String>,
}
impl VaultImageArtifactScope {
    pub fn new(
        account_id: AccountId,
        operation_id: impl Into<String>,
    ) -> Result<Self, RuntimeError> {
        let operation_id = operation_id.into();
        validate_identity(account_id.as_str(), "Account")?;
        validate_identity(&operation_id, "Operation")?;
        Ok(Self {
            account_id,
            operation_id,
            publication_id: None,
        })
    }
    pub fn account_id(&self) -> &AccountId {
        &self.account_id
    }
    pub fn operation_id(&self) -> &str {
        &self.operation_id
    }
    pub fn publication_id(&self) -> Option<&str> {
        self.publication_id.as_deref()
    }
    pub fn for_publication(&self, publication_id: &str) -> Result<Self, RuntimeError> {
        validate_identity(publication_id, "Image publication")?;
        Ok(Self {
            account_id: self.account_id.clone(),
            operation_id: self.operation_id.clone(),
            publication_id: Some(publication_id.to_owned()),
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VaultImageArtifactMetadata {
    scope: VaultImageArtifactScope,
    vault_id: String,
    byte_length: u64,
    content_type: String,
    sha256: String,
    protected: Option<protected::ProtectedImageMetadata>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VaultImageArtifactGeneration {
    pub scope: VaultImageArtifactScope,
    pub metadata: Option<VaultImageArtifactMetadata>,
}
impl VaultImageArtifactMetadata {
    pub fn new(
        scope: VaultImageArtifactScope,
        vault_id: impl Into<String>,
        byte_length: u64,
        content_type: impl Into<String>,
        sha256: impl Into<String>,
    ) -> Result<Self, RuntimeError> {
        let vault_id = vault_id.into();
        let content_type = content_type.into();
        let sha256 = sha256.into();
        if scope.publication_id().is_some() {
            return Err(invariant(
                "Raw Vault image has a protected publication identity",
            ));
        }
        validate_identity(&vault_id, "Vault")?;
        validate_image_shape(byte_length, &content_type)?;
        if !is_lowercase_sha256(&sha256) {
            return Err(invariant("Vault image digest is invalid"));
        }
        Ok(Self {
            scope,
            vault_id,
            byte_length,
            content_type,
            sha256,
            protected: None,
        })
    }
    pub fn with_protection(
        self,
        protected: protected::ProtectedImageMetadata,
    ) -> Result<Self, RuntimeError> {
        if self.protected.is_some() || !protected.matches_original(&self)? {
            return Err(invariant("Protected Vault image metadata conflicts"));
        }
        protected::validate_protected_metadata(&self, &protected)?;
        Ok(Self {
            scope: self
                .scope
                .for_publication(&protected.witness.publication_id)?,
            protected: Some(protected),
            ..self
        })
    }
    pub fn protection(&self) -> Option<&protected::ProtectedImageMetadata> {
        self.protected.as_ref()
    }
    pub fn scope(&self) -> &VaultImageArtifactScope {
        &self.scope
    }
    pub fn account_id(&self) -> &AccountId {
        self.scope.account_id()
    }
    pub fn operation_id(&self) -> &str {
        self.scope.operation_id()
    }
    pub fn vault_id(&self) -> &str {
        &self.vault_id
    }
    pub fn byte_length(&self) -> u64 {
        self.byte_length
    }
    pub fn content_type(&self) -> &str {
        &self.content_type
    }
    pub fn sha256(&self) -> &str {
        &self.sha256
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreparedVaultImage {
    metadata: VaultImageArtifactMetadata,
}
impl PreparedVaultImage {
    pub fn metadata(&self) -> &VaultImageArtifactMetadata {
        &self.metadata
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VaultImageSourceGrant {
    pub runtime_incarnation: String,
    pub account_id: AccountId,
    pub operation_id: String,
    pub vault_id: String,
    pub capability_id: String,
    pub content_type: String,
    pub byte_length: u64,
}
impl VaultImageSourceGrant {
    fn validate(&self) -> Result<VaultImageArtifactScope, RuntimeError> {
        validate_identity(&self.runtime_incarnation, "Runtime incarnation")?;
        validate_identity(&self.capability_id, "Vault image capability")?;
        validate_identity(&self.vault_id, "Vault")?;
        validate_image_shape(self.byte_length, &self.content_type)?;
        VaultImageArtifactScope::new(self.account_id.clone(), self.operation_id.clone())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VaultImageSourceError {
    Source,
    Cancelled,
    Invariant,
}
#[cfg(not(target_arch = "wasm32"))]
#[async_trait]
pub trait VaultImageSource: Send {
    async fn next_chunk(
        &mut self,
        max_bytes: usize,
    ) -> Result<Option<Vec<u8>>, VaultImageSourceError>;
    async fn close(&mut self) -> Result<(), VaultImageSourceError>;
}
#[cfg(target_arch = "wasm32")]
#[async_trait(?Send)]
pub trait VaultImageSource {
    async fn next_chunk(
        &mut self,
        max_bytes: usize,
    ) -> Result<Option<Vec<u8>>, VaultImageSourceError>;
    async fn close(&mut self) -> Result<(), VaultImageSourceError>;
}
#[cfg(not(target_arch = "wasm32"))]
#[async_trait]
pub trait VaultImageSourcePort: Send + Sync {
    async fn claim(
        &self,
        grant: &VaultImageSourceGrant,
    ) -> Result<Box<dyn VaultImageSource>, VaultImageSourceError>;
    async fn retire_account(
        &self,
        runtime_incarnation: &str,
        account_id: &AccountId,
    ) -> Result<(), VaultImageSourceError>;
    async fn complete_account_retirement(
        &self,
        runtime_incarnation: &str,
        account_id: &AccountId,
    ) -> Result<(), VaultImageSourceError>;
    async fn begin_acceptance(
        &self,
        runtime_incarnation: &str,
        account_id: &AccountId,
        operation_id: &str,
    ) -> Result<(), VaultImageSourceError>;
    async fn end_acceptance(
        &self,
        runtime_incarnation: &str,
        account_id: &AccountId,
        operation_id: &str,
    ) -> Result<(), VaultImageSourceError>;
    async fn retire_vaults(
        &self,
        runtime_incarnation: &str,
        account_id: &AccountId,
        vault_ids: &[String],
    ) -> Result<(), VaultImageSourceError>;
    async fn complete_vault_retirement(
        &self,
        runtime_incarnation: &str,
        account_id: &AccountId,
        vault_ids: &[String],
    ) -> Result<(), VaultImageSourceError>;
    async fn forget_account_vault_retirements(
        &self,
        runtime_incarnation: &str,
        account_id: &AccountId,
    ) -> Result<(), VaultImageSourceError>;
    async fn retire_runtime(&self, runtime_incarnation: &str) -> Result<(), VaultImageSourceError>;
}
#[cfg(target_arch = "wasm32")]
#[async_trait(?Send)]
pub trait VaultImageSourcePort {
    async fn claim(
        &self,
        grant: &VaultImageSourceGrant,
    ) -> Result<Box<dyn VaultImageSource>, VaultImageSourceError>;
    async fn retire_account(
        &self,
        runtime_incarnation: &str,
        account_id: &AccountId,
    ) -> Result<(), VaultImageSourceError>;
    async fn complete_account_retirement(
        &self,
        runtime_incarnation: &str,
        account_id: &AccountId,
    ) -> Result<(), VaultImageSourceError>;
    async fn begin_acceptance(
        &self,
        runtime_incarnation: &str,
        account_id: &AccountId,
        operation_id: &str,
    ) -> Result<(), VaultImageSourceError>;
    async fn end_acceptance(
        &self,
        runtime_incarnation: &str,
        account_id: &AccountId,
        operation_id: &str,
    ) -> Result<(), VaultImageSourceError>;
    async fn retire_vaults(
        &self,
        runtime_incarnation: &str,
        account_id: &AccountId,
        vault_ids: &[String],
    ) -> Result<(), VaultImageSourceError>;
    async fn complete_vault_retirement(
        &self,
        runtime_incarnation: &str,
        account_id: &AccountId,
        vault_ids: &[String],
    ) -> Result<(), VaultImageSourceError>;
    async fn forget_account_vault_retirements(
        &self,
        runtime_incarnation: &str,
        account_id: &AccountId,
    ) -> Result<(), VaultImageSourceError>;
    async fn retire_runtime(&self, runtime_incarnation: &str) -> Result<(), VaultImageSourceError>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VaultImageChunkWrite {
    Stored,
    AlreadyStored,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VaultImagePublication {
    Published,
    AlreadyPublished,
}
#[cfg(not(target_arch = "wasm32"))]
#[async_trait]
pub trait VaultImageArtifactPort: Send + Sync {
    /// Complete physical-key census through this owner. Unsupported adapters must fail closed;
    /// ordinary CoreOnly startup does not require this profile-admission capability.
    async fn inventory_page(
        &self,
        _cursor: Option<&str>,
    ) -> Result<VaultImageInventoryPage, RuntimeError> {
        Err(inventory::invalid("Vault image inventory is unavailable"))
    }
    async fn begin(&self, scope: &VaultImageArtifactScope) -> Result<(), RuntimeError>;
    async fn write_chunk(
        &self,
        scope: &VaultImageArtifactScope,
        chunk_index: u32,
        bytes: &[u8],
    ) -> Result<VaultImageChunkWrite, RuntimeError>;
    async fn publish(
        &self,
        metadata: &VaultImageArtifactMetadata,
    ) -> Result<VaultImagePublication, RuntimeError>;
    async fn read_chunk(
        &self,
        metadata: &VaultImageArtifactMetadata,
        chunk_index: u32,
    ) -> Result<Option<Vec<u8>>, RuntimeError>;
    /// One ordered generation in this Account/Operation family; empty cursor names legacy raw.
    async fn read_generation(
        &self,
        family: &VaultImageArtifactScope,
        after_publication_id: Option<&str>,
    ) -> Result<Option<VaultImageArtifactGeneration>, RuntimeError>;
    /// Delete exactly this generation, retaining every sibling publication.
    async fn delete_generation(&self, scope: &VaultImageArtifactScope) -> Result<(), RuntimeError>;
    async fn delete(&self, scope: &VaultImageArtifactScope) -> Result<(), RuntimeError>;
    async fn delete_account(&self, account_id: &AccountId) -> Result<(), RuntimeError>;
    async fn wipe(&self) -> Result<(), RuntimeError>;
    async fn sweep_orphans(
        &self,
        account_id: &AccountId,
        referenced_operations: &HashSet<String>,
    ) -> Result<(), RuntimeError>;
}
#[cfg(target_arch = "wasm32")]
#[async_trait(?Send)]
pub trait VaultImageArtifactPort {
    /// Complete physical-key census through this owner. Unsupported adapters must fail closed;
    /// ordinary CoreOnly startup does not require this profile-admission capability.
    async fn inventory_page(
        &self,
        _cursor: Option<&str>,
    ) -> Result<VaultImageInventoryPage, RuntimeError> {
        Err(inventory::invalid("Vault image inventory is unavailable"))
    }
    async fn begin(&self, scope: &VaultImageArtifactScope) -> Result<(), RuntimeError>;
    async fn write_chunk(
        &self,
        scope: &VaultImageArtifactScope,
        chunk_index: u32,
        bytes: &[u8],
    ) -> Result<VaultImageChunkWrite, RuntimeError>;
    async fn publish(
        &self,
        metadata: &VaultImageArtifactMetadata,
    ) -> Result<VaultImagePublication, RuntimeError>;
    async fn read_chunk(
        &self,
        metadata: &VaultImageArtifactMetadata,
        chunk_index: u32,
    ) -> Result<Option<Vec<u8>>, RuntimeError>;
    /// One ordered generation in this Account/Operation family; empty cursor names legacy raw.
    async fn read_generation(
        &self,
        family: &VaultImageArtifactScope,
        after_publication_id: Option<&str>,
    ) -> Result<Option<VaultImageArtifactGeneration>, RuntimeError>;
    /// Delete exactly this generation, retaining every sibling publication.
    async fn delete_generation(&self, scope: &VaultImageArtifactScope) -> Result<(), RuntimeError>;
    async fn delete(&self, scope: &VaultImageArtifactScope) -> Result<(), RuntimeError>;
    async fn delete_account(&self, account_id: &AccountId) -> Result<(), RuntimeError>;
    async fn wipe(&self) -> Result<(), RuntimeError>;
    async fn sweep_orphans(
        &self,
        account_id: &AccountId,
        referenced_operations: &HashSet<String>,
    ) -> Result<(), RuntimeError>;
}

#[derive(Clone, Default)]
pub struct MemoryVaultImageArtifactStore {
    inner: Arc<Mutex<MemoryState>>,
}
#[derive(Default)]
struct MemoryState {
    artifacts: HashMap<VaultImageArtifactScope, MemoryArtifact>,
}
#[derive(Default)]
struct MemoryArtifact {
    chunks: Vec<Vec<u8>>,
    metadata: Option<VaultImageArtifactMetadata>,
}
impl Drop for MemoryArtifact {
    fn drop(&mut self) {
        for chunk in &mut self.chunks {
            chunk.zeroize();
        }
    }
}
impl MemoryVaultImageArtifactStore {
    pub async fn read_all(
        &self,
        metadata: &VaultImageArtifactMetadata,
    ) -> Result<Vec<u8>, RuntimeError> {
        let state = self
            .inner
            .lock()
            .expect("Vault image memory store lock poisoned");
        let artifact = state
            .artifacts
            .get(metadata.scope())
            .ok_or_else(|| invariant("Vault image artifact is missing"))?;
        if artifact.metadata.as_ref() != Some(metadata) {
            return Err(invariant("Vault image artifact metadata conflicts"));
        }
        Ok(artifact.chunks.concat())
    }
    fn begin_sync(&self, scope: &VaultImageArtifactScope) {
        self.inner
            .lock()
            .expect("Vault image memory store lock poisoned")
            .artifacts
            .entry(scope.clone())
            .or_default();
    }
    fn write_sync(
        &self,
        scope: &VaultImageArtifactScope,
        index: u32,
        bytes: &[u8],
    ) -> Result<VaultImageChunkWrite, RuntimeError> {
        if bytes.is_empty() || bytes.len() > VAULT_IMAGE_CHUNK_BYTES {
            return Err(invariant("Vault image artifact chunk is invalid"));
        }
        let mut state = self
            .inner
            .lock()
            .expect("Vault image memory store lock poisoned");
        let artifact = state
            .artifacts
            .get_mut(scope)
            .ok_or_else(|| invariant("Vault image artifact was not begun"))?;
        if artifact.metadata.is_some() {
            return Err(invariant("Published Vault image artifact is immutable"));
        }
        let index = index as usize;
        if index > artifact.chunks.len() {
            return Err(invariant("Vault image chunks must be contiguous"));
        }
        if index < artifact.chunks.len() {
            return if artifact.chunks[index] == bytes {
                Ok(VaultImageChunkWrite::AlreadyStored)
            } else {
                Err(invariant("Vault image artifact chunk conflicts"))
            };
        }
        artifact.chunks.push(bytes.to_vec());
        Ok(VaultImageChunkWrite::Stored)
    }
    fn publish_sync(
        &self,
        metadata: &VaultImageArtifactMetadata,
    ) -> Result<VaultImagePublication, RuntimeError> {
        let mut state = self
            .inner
            .lock()
            .expect("Vault image memory store lock poisoned");
        let artifact = state
            .artifacts
            .get_mut(metadata.scope())
            .ok_or_else(|| invariant("Vault image artifact was not begun"))?;
        if let Some(existing) = &artifact.metadata {
            return if existing == metadata {
                Ok(VaultImagePublication::AlreadyPublished)
            } else {
                Err(invariant("Vault image artifact publication conflicts"))
            };
        }
        verify_chunks(metadata, &artifact.chunks)?;
        artifact.metadata = Some(metadata.clone());
        Ok(VaultImagePublication::Published)
    }
    fn read_sync(
        &self,
        metadata: &VaultImageArtifactMetadata,
        index: u32,
    ) -> Result<Option<Vec<u8>>, RuntimeError> {
        let state = self
            .inner
            .lock()
            .expect("Vault image memory store lock poisoned");
        let Some(artifact) = state.artifacts.get(metadata.scope()) else {
            return Ok(None);
        };
        if artifact.metadata.as_ref() != Some(metadata) {
            return Err(invariant("Vault image artifact metadata conflicts"));
        }
        Ok(artifact.chunks.get(index as usize).cloned())
    }
}

#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
#[cfg_attr(target_arch="wasm32", async_trait(?Send))]
impl VaultImageArtifactPort for MemoryVaultImageArtifactStore {
    async fn begin(&self, scope: &VaultImageArtifactScope) -> Result<(), RuntimeError> {
        self.begin_sync(scope);
        Ok(())
    }
    async fn write_chunk(
        &self,
        scope: &VaultImageArtifactScope,
        index: u32,
        bytes: &[u8],
    ) -> Result<VaultImageChunkWrite, RuntimeError> {
        self.write_sync(scope, index, bytes)
    }
    async fn publish(
        &self,
        metadata: &VaultImageArtifactMetadata,
    ) -> Result<VaultImagePublication, RuntimeError> {
        self.publish_sync(metadata)
    }
    async fn read_chunk(
        &self,
        metadata: &VaultImageArtifactMetadata,
        index: u32,
    ) -> Result<Option<Vec<u8>>, RuntimeError> {
        self.read_sync(metadata, index)
    }
    async fn read_generation(
        &self,
        family: &VaultImageArtifactScope,
        after: Option<&str>,
    ) -> Result<Option<VaultImageArtifactGeneration>, RuntimeError> {
        if let Some(after) = after.filter(|value| !value.is_empty()) {
            validate_identity(after, "Image publication cursor")?;
        }
        let state = self
            .inner
            .lock()
            .expect("Vault image memory store lock poisoned");
        Ok(state
            .artifacts
            .iter()
            .filter(|(scope, _)| {
                scope.account_id() == family.account_id()
                    && scope.operation_id() == family.operation_id()
                    && after.is_none_or(|after| scope.publication_id().unwrap_or("") > after)
            })
            .min_by(|(a, _), (b, _)| {
                a.publication_id()
                    .unwrap_or("")
                    .cmp(b.publication_id().unwrap_or(""))
            })
            .map(|(scope, artifact)| VaultImageArtifactGeneration {
                scope: scope.clone(),
                metadata: artifact.metadata.clone(),
            }))
    }
    async fn delete_generation(&self, scope: &VaultImageArtifactScope) -> Result<(), RuntimeError> {
        self.inner
            .lock()
            .expect("Vault image memory store lock poisoned")
            .artifacts
            .remove(scope);
        Ok(())
    }
    async fn delete(&self, scope: &VaultImageArtifactScope) -> Result<(), RuntimeError> {
        self.inner
            .lock()
            .expect("Vault image memory store lock poisoned")
            .artifacts
            .retain(|candidate, _| {
                candidate.account_id() != scope.account_id()
                    || candidate.operation_id() != scope.operation_id()
            });
        Ok(())
    }
    async fn delete_account(&self, account_id: &AccountId) -> Result<(), RuntimeError> {
        self.inner
            .lock()
            .expect("Vault image memory store lock poisoned")
            .artifacts
            .retain(|scope, _| scope.account_id() != account_id);
        Ok(())
    }
    async fn wipe(&self) -> Result<(), RuntimeError> {
        self.inner
            .lock()
            .expect("Vault image memory store lock poisoned")
            .artifacts
            .clear();
        Ok(())
    }
    async fn sweep_orphans(
        &self,
        account_id: &AccountId,
        refs: &HashSet<String>,
    ) -> Result<(), RuntimeError> {
        self.inner
            .lock()
            .expect("Vault image memory store lock poisoned")
            .artifacts
            .retain(|scope, _| {
                scope.account_id() != account_id || refs.contains(scope.operation_id())
            });
        Ok(())
    }
}

#[derive(Clone)]
pub struct VaultImageIngressFacade {
    runtime_incarnation: String,
    sources: Arc<dyn VaultImageSourcePort>,
    artifacts: Arc<dyn VaultImageArtifactPort>,
}

/// Ephemeral Core-only access to the existing Device key; never sent through host controls.
pub(crate) struct VaultImageProtection<'a> {
    pub user_id: &'a str,
    pub device_key: &'a [u8],
}

impl VaultImageIngressFacade {
    pub fn new(
        runtime_incarnation: impl Into<String>,
        sources: Arc<dyn VaultImageSourcePort>,
        artifacts: Arc<dyn VaultImageArtifactPort>,
    ) -> Result<Self, RuntimeError> {
        let runtime_incarnation = runtime_incarnation.into();
        validate_identity(&runtime_incarnation, "Runtime incarnation")?;
        Ok(Self {
            runtime_incarnation,
            sources,
            artifacts,
        })
    }
    pub async fn prepare(
        &self,
        grant: VaultImageSourceGrant,
        cancellation: &RequestCancellation,
    ) -> Result<PreparedVaultImage, RuntimeError> {
        if grant.runtime_incarnation != self.runtime_incarnation {
            return Err(invariant("Vault image Runtime incarnation conflicts"));
        }
        prepare_image(
            self.sources.as_ref(),
            self.artifacts.as_ref(),
            grant,
            cancellation,
        )
        .await
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "binds the same exact Runtime image identities with ephemeral Core protection"
    )]
    pub(crate) async fn prepare_bound_protected(
        &self,
        account_id: AccountId,
        operation_id: String,
        vault_id: String,
        capability_id: String,
        content_type: String,
        byte_length: u64,
        cancellation: &RequestCancellation,
        protection: VaultImageProtection<'_>,
    ) -> Result<PreparedVaultImage, RuntimeError> {
        prepare_image_with_protection(
            self.sources.as_ref(),
            self.artifacts.as_ref(),
            VaultImageSourceGrant {
                runtime_incarnation: self.runtime_incarnation.clone(),
                account_id,
                operation_id,
                vault_id,
                capability_id,
                content_type,
                byte_length,
            },
            cancellation,
            Some(protection),
        )
        .await
    }

    pub(crate) async fn read_published_bound(
        &self,
        account_id: AccountId,
        operation_id: String,
        vault_id: String,
        byte_length: u64,
        content_type: String,
        sha256: String,
    ) -> Result<Zeroizing<Vec<u8>>, RuntimeError> {
        let metadata = VaultImageArtifactMetadata::new(
            VaultImageArtifactScope::new(account_id, operation_id)?,
            vault_id,
            byte_length,
            content_type,
            sha256,
        )?;
        let mut bytes = Zeroizing::new(Vec::with_capacity(byte_length as usize));
        let mut chunk_index = 0_u32;
        while bytes.len() < byte_length as usize {
            let chunk = self
                .artifacts
                .read_chunk(&metadata, chunk_index)
                .await?
                .ok_or_else(|| {
                    invariant("Vault image artifact ended before its declared length")
                })?;
            bytes.extend_from_slice(&chunk);
            chunk_index = chunk_index
                .checked_add(1)
                .ok_or_else(|| invariant("Vault image chunk index exhausted"))?;
        }
        if bytes.len() != byte_length as usize
            || self
                .artifacts
                .read_chunk(&metadata, chunk_index)
                .await?
                .is_some()
        {
            return Err(invariant(
                "Vault image artifact length changed after acceptance",
            ));
        }
        let mut digest = Sha256::new();
        digest.update(bytes.as_slice());
        if format!("{:x}", digest.finalize()) != metadata.sha256() {
            return Err(invariant(
                "Vault image artifact digest changed after acceptance",
            ));
        }
        Ok(bytes)
    }
    /// Caller holds the exact accepted legacy Operation's execution fence. This prepares a
    /// replacement only; witness commit and raw cleanup remain separate guarded Core steps.
    pub(crate) async fn protect_legacy_bound(
        &self,
        original: &VaultImageArtifactMetadata,
        protection: VaultImageProtection<'_>,
        cancellation: &RequestCancellation,
    ) -> Result<VaultImageArtifactMetadata, RuntimeError> {
        if original.scope().publication_id().is_some() || original.protection().is_some() {
            return Err(invariant(
                "Legacy image conversion requires original raw evidence",
            ));
        }
        let mut after = String::new();
        loop {
            if cancellation.is_cancelled() {
                return Err(cancelled());
            }
            let Some(generation) = self
                .artifacts
                .read_generation(original.scope(), Some(&after))
                .await?
            else {
                break;
            };
            let publication = generation
                .scope
                .publication_id()
                .ok_or_else(|| invariant("Protected image cursor returned raw publication"))?;
            if generation.scope.account_id() != original.account_id()
                || generation.scope.operation_id() != original.operation_id()
                || publication <= after.as_str()
            {
                return Err(invariant("Protected image cursor changed scope"));
            }
            after = publication.to_owned();
            if let Some(metadata) = generation.metadata {
                if metadata.scope() != &generation.scope {
                    return Err(invariant("Protected candidate metadata changed scope"));
                }
                let protected = metadata
                    .protection()
                    .ok_or_else(|| invariant("Protected publication has raw metadata"))?;
                let chunks = self.read_protected_chunks(&metadata, cancellation).await?;
                protected::verify_protected_publication(
                    original,
                    protection.user_id,
                    &protected.witness,
                    protected,
                    &chunks,
                    protection.device_key,
                )?;
                return Ok(metadata);
            }
            // This accepted legacy Operation has no concurrent host ingress. An unfinished
            // replacement is abandoned output; raw authority remains intact during its removal.
            self.artifacts.delete_generation(&generation.scope).await?;
        }
        let bytes = self
            .read_published_bound(
                original.account_id().clone(),
                original.operation_id().into(),
                original.vault_id().into(),
                original.byte_length(),
                original.content_type().into(),
                original.sha256().into(),
            )
            .await?;
        if cancellation.is_cancelled() {
            return Err(cancelled());
        }
        let source = Box::new(LegacyImageSource { bytes, offset: 0 });
        Ok(publish_image_source(
            source,
            self.artifacts.as_ref(),
            original.scope().clone(),
            original.vault_id().into(),
            original.content_type().into(),
            original.byte_length(),
            cancellation,
            Some(protection),
        )
        .await?
        .metadata)
    }

    pub(crate) async fn read_protected_bound(
        &self,
        original: &VaultImageArtifactMetadata,
        witness: &protected::ProtectedImageWitness,
        protection: VaultImageProtection<'_>,
        cancellation: &RequestCancellation,
    ) -> Result<Zeroizing<Vec<u8>>, RuntimeError> {
        let (metadata, chunks) = self
            .read_protected_publication(original, witness, protection.user_id, cancellation)
            .await?;
        let protected_metadata = metadata
            .protection()
            .ok_or_else(|| invariant("Accepted protected image has raw metadata"))?;
        let bytes = protected::read_protected_image(
            original,
            protection.user_id,
            witness,
            protected_metadata,
            &chunks,
            protection.device_key,
        )?;
        if cancellation.is_cancelled() {
            return Err(cancelled());
        }
        Ok(bytes)
    }

    /// Cleanup verifies the accepted opaque dependency without unwrapping a key or reading image plaintext.
    pub(crate) async fn verify_protected_bound(
        &self,
        original: &VaultImageArtifactMetadata,
        witness: &protected::ProtectedImageWitness,
        user_id: &str,
        cancellation: &RequestCancellation,
    ) -> Result<(), RuntimeError> {
        let (metadata, chunks) = self
            .read_protected_publication(original, witness, user_id, cancellation)
            .await?;
        protected::verify_ciphertext(
            original,
            metadata
                .protection()
                .ok_or_else(|| invariant("Accepted protected image has raw metadata"))?,
            &chunks,
        )
    }

    async fn read_protected_publication(
        &self,
        original: &VaultImageArtifactMetadata,
        witness: &protected::ProtectedImageWitness,
        user_id: &str,
        cancellation: &RequestCancellation,
    ) -> Result<(VaultImageArtifactMetadata, Vec<Vec<u8>>), RuntimeError> {
        protected::validate_witness(witness, original.byte_length())?;
        let family =
            VaultImageArtifactScope::new(original.account_id().clone(), original.operation_id())?;
        // Skip the legacy raw generation. Candidates are individually bounded and ordered by the
        // existing store; only the immutable accepted publication may supply its wrapper/chunks.
        let mut after = String::new();
        let metadata = loop {
            if cancellation.is_cancelled() {
                return Err(cancelled());
            }
            let generation = self
                .artifacts
                .read_generation(&family, Some(&after))
                .await?
                .ok_or_else(|| invariant("Accepted protected image publication is missing"))?;
            let publication = generation
                .scope
                .publication_id()
                .ok_or_else(|| invariant("Protected image cursor returned raw publication"))?;
            if generation.scope.account_id() != family.account_id()
                || generation.scope.operation_id() != family.operation_id()
                || publication <= after.as_str()
            {
                return Err(invariant(
                    "Protected image publication cursor changed scope",
                ));
            }
            match publication.cmp(&witness.publication_id) {
                std::cmp::Ordering::Less => after = publication.to_owned(),
                std::cmp::Ordering::Greater => {
                    return Err(invariant("Accepted protected image publication is missing"));
                }
                std::cmp::Ordering::Equal => {
                    break generation
                        .metadata
                        .ok_or_else(|| invariant("Accepted protected image is unpublished"))?;
                }
            }
        };
        let protected_metadata = metadata
            .protection()
            .ok_or_else(|| invariant("Accepted protected image has raw metadata"))?;
        protected::validate_metadata_scope(original, user_id, witness, protected_metadata)?;
        if metadata.scope() != &family.for_publication(&witness.publication_id)? {
            return Err(invariant(
                "Protected image metadata changed publication scope",
            ));
        }
        let chunks = self.read_protected_chunks(&metadata, cancellation).await?;
        Ok((metadata, chunks))
    }

    async fn read_protected_chunks(
        &self,
        metadata: &VaultImageArtifactMetadata,
        cancellation: &RequestCancellation,
    ) -> Result<Vec<Vec<u8>>, RuntimeError> {
        let protected = metadata
            .protection()
            .ok_or_else(|| invariant("Protected publication has raw metadata"))?;
        let witness = &protected.witness;
        protected::validate_witness(witness, metadata.byte_length())?;
        let mut chunks = Vec::with_capacity(witness.chunk_count as usize);
        for index in 0..witness.chunk_count {
            if cancellation.is_cancelled() {
                return Err(cancelled());
            }
            let chunk = self
                .artifacts
                .read_chunk(metadata, index)
                .await?
                .ok_or_else(|| invariant("Accepted protected image chunk is missing"))?;
            if chunk.is_empty() || chunk.len() > VAULT_IMAGE_CHUNK_BYTES {
                return Err(invariant("Protected image chunk exceeded shared bound"));
            }
            chunks.push(chunk);
        }
        if self
            .artifacts
            .read_chunk(metadata, witness.chunk_count)
            .await?
            .is_some()
        {
            return Err(invariant("Protected image contains extra chunks"));
        }
        if cancellation.is_cancelled() {
            return Err(cancelled());
        }
        Ok(chunks)
    }

    pub(crate) async fn delete_raw_generation(
        &self,
        original: &VaultImageArtifactMetadata,
    ) -> Result<(), RuntimeError> {
        if original.scope().publication_id().is_some() {
            return Err(invariant("Raw cleanup requires raw scope"));
        }
        self.artifacts.delete_generation(original.scope()).await
    }

    pub(crate) async fn delete_bound(
        &self,
        account_id: AccountId,
        operation_id: String,
    ) -> Result<(), RuntimeError> {
        self.artifacts
            .delete(&VaultImageArtifactScope::new(account_id, operation_id)?)
            .await
    }
    pub async fn retire_vaults(
        &self,
        account_id: &AccountId,
        vault_ids: &[String],
    ) -> Result<(), RuntimeError> {
        self.sources
            .retire_vaults(&self.runtime_incarnation, account_id, vault_ids)
            .await
            .map_err(source_error)
    }
    pub async fn complete_vault_retirement(
        &self,
        account_id: &AccountId,
        vault_ids: &[String],
    ) -> Result<(), RuntimeError> {
        self.sources
            .complete_vault_retirement(&self.runtime_incarnation, account_id, vault_ids)
            .await
            .map_err(source_error)
    }
    pub async fn forget_account_vault_retirements(
        &self,
        account_id: &AccountId,
    ) -> Result<(), RuntimeError> {
        self.sources
            .forget_account_vault_retirements(&self.runtime_incarnation, account_id)
            .await
            .map_err(source_error)
    }
    pub async fn retire_account(&self, account_id: &AccountId) -> Result<(), RuntimeError> {
        self.sources
            .retire_account(&self.runtime_incarnation, account_id)
            .await
            .map_err(source_error)
    }
    pub async fn complete_account_retirement(
        &self,
        account_id: &AccountId,
    ) -> Result<(), RuntimeError> {
        self.sources
            .complete_account_retirement(&self.runtime_incarnation, account_id)
            .await
            .map_err(source_error)
    }
    pub async fn begin_acceptance(
        &self,
        account_id: &AccountId,
        operation_id: &str,
    ) -> Result<(), RuntimeError> {
        validate_identity(operation_id, "Operation")?;
        self.sources
            .begin_acceptance(&self.runtime_incarnation, account_id, operation_id)
            .await
            .map_err(source_error)
    }
    pub async fn end_acceptance(
        &self,
        account_id: &AccountId,
        operation_id: &str,
    ) -> Result<(), RuntimeError> {
        validate_identity(operation_id, "Operation")?;
        self.sources
            .end_acceptance(&self.runtime_incarnation, account_id, operation_id)
            .await
            .map_err(source_error)
    }
    pub async fn retire_runtime(&self) -> Result<(), RuntimeError> {
        self.sources
            .retire_runtime(&self.runtime_incarnation)
            .await
            .map_err(source_error)
    }
    pub(crate) async fn inventory_page(
        &self,
        cursor: Option<&str>,
    ) -> Result<VaultImageInventoryPage, RuntimeError> {
        self.artifacts.inventory_page(cursor).await
    }
    /// Durable deletion belongs only to explicit Remove/Wipe after source retirement has drained.
    pub(crate) async fn delete_account_artifacts(
        &self,
        account_id: &AccountId,
    ) -> Result<(), RuntimeError> {
        self.artifacts.delete_account(account_id).await
    }
    pub(crate) async fn wipe_artifacts(&self) -> Result<(), RuntimeError> {
        self.artifacts.wipe().await
    }
    pub async fn sweep_account(
        &self,
        account_id: &AccountId,
        referenced_operations: &HashSet<String>,
    ) -> Result<(), RuntimeError> {
        self.artifacts
            .sweep_orphans(account_id, referenced_operations)
            .await
    }
}

pub struct VaultImageIngress<S, A> {
    sources: S,
    artifacts: A,
}
impl<S, A> VaultImageIngress<S, A> {
    pub fn new(sources: S, artifacts: A) -> Self {
        Self { sources, artifacts }
    }
}
impl<S: VaultImageSourcePort, A: VaultImageArtifactPort> VaultImageIngress<S, A> {
    pub async fn prepare(
        &self,
        grant: VaultImageSourceGrant,
    ) -> Result<PreparedVaultImage, RuntimeError> {
        self.prepare_with_cancellation(grant, &RequestCancellation::new())
            .await
    }
    pub async fn prepare_with_cancellation(
        &self,
        grant: VaultImageSourceGrant,
        cancellation: &RequestCancellation,
    ) -> Result<PreparedVaultImage, RuntimeError> {
        prepare_image(&self.sources, &self.artifacts, grant, cancellation).await
    }
    pub async fn retire_account(
        &self,
        incarnation: &str,
        account_id: &AccountId,
    ) -> Result<(), RuntimeError> {
        self.sources
            .retire_account(incarnation, account_id)
            .await
            .map_err(source_error)
    }
    pub async fn retire_runtime(&self, incarnation: &str) -> Result<(), RuntimeError> {
        self.sources
            .retire_runtime(incarnation)
            .await
            .map_err(source_error)
    }
}

async fn prepare_image<S: VaultImageSourcePort + ?Sized, A: VaultImageArtifactPort + ?Sized>(
    sources: &S,
    artifacts: &A,
    grant: VaultImageSourceGrant,
    cancellation: &RequestCancellation,
) -> Result<PreparedVaultImage, RuntimeError> {
    prepare_image_with_protection(sources, artifacts, grant, cancellation, None).await
}

async fn prepare_image_with_protection<
    S: VaultImageSourcePort + ?Sized,
    A: VaultImageArtifactPort + ?Sized,
>(
    sources: &S,
    artifacts: &A,
    grant: VaultImageSourceGrant,
    cancellation: &RequestCancellation,
    protection: Option<VaultImageProtection<'_>>,
) -> Result<PreparedVaultImage, RuntimeError> {
    let scope = grant.validate()?;
    let source = sources.claim(&grant).await.map_err(source_error)?;
    publish_image_source(
        source,
        artifacts,
        scope,
        grant.vault_id,
        grant.content_type,
        grant.byte_length,
        cancellation,
        protection,
    )
    .await
}

/// An ephemeral internal reader for verified legacy bytes, not a host grant or persisted owner.
struct LegacyImageSource {
    bytes: Zeroizing<Vec<u8>>,
    offset: usize,
}
#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
impl VaultImageSource for LegacyImageSource {
    async fn next_chunk(
        &mut self,
        max_bytes: usize,
    ) -> Result<Option<Vec<u8>>, VaultImageSourceError> {
        if self.offset == self.bytes.len() {
            return Ok(None);
        }
        let end = (self.offset + max_bytes).min(self.bytes.len());
        let bytes = self.bytes[self.offset..end].to_vec();
        self.offset = end;
        Ok(Some(bytes))
    }
    async fn close(&mut self) -> Result<(), VaultImageSourceError> {
        self.bytes.zeroize();
        self.bytes.clear();
        self.offset = 0;
        Ok(())
    }
}

#[allow(
    clippy::too_many_arguments,
    reason = "one publisher shares source lifetime and exact image binding across fresh and legacy ingress"
)]
async fn publish_image_source<A: VaultImageArtifactPort + ?Sized>(
    mut source: Box<dyn VaultImageSource>,
    artifacts: &A,
    scope: VaultImageArtifactScope,
    vault_id: String,
    content_type: String,
    byte_length: u64,
    cancellation: &RequestCancellation,
    protection: Option<VaultImageProtection<'_>>,
) -> Result<PreparedVaultImage, RuntimeError> {
    let mut cleanup_scope = None;
    let result = async {
        let mut writer = protection
            .as_ref()
            .map(|context| {
                protected::ProtectedImageWriter::new(scope.clone(), &vault_id, context.user_id)
            })
            .transpose()?;
        let storage_scope = match writer.as_ref() {
            Some(writer) => scope.clone().for_publication(writer.publication_id())?,
            None => scope.clone(),
        };
        cleanup_scope = Some(storage_scope.clone());
        let chunk_bound = if writer.is_some() {
            protected::PROTECTED_IMAGE_PLAINTEXT_CHUNK_BYTES
        } else {
            VAULT_IMAGE_CHUNK_BYTES
        };
        artifacts.begin(&storage_scope).await?;
        let mut digest = Sha256::new();
        let mut read = 0u64;
        let mut index = 0u32;
        while read < byte_length {
            if cancellation.is_cancelled() {
                return Err(cancelled());
            }
            let remaining = usize::try_from(byte_length - read).unwrap_or(VAULT_IMAGE_CHUNK_BYTES);
            let limit = remaining.min(chunk_bound);
            let mut bytes = Zeroizing::new(Vec::with_capacity(limit));
            while bytes.len() < limit {
                if cancellation.is_cancelled() {
                    return Err(cancelled());
                }
                let available = limit - bytes.len();
                let chunk = Zeroizing::new(
                    source
                        .next_chunk(available)
                        .await
                        .map_err(source_error)?
                        .ok_or_else(|| {
                            invariant("Vault image source ended before its declared length")
                        })?,
                );
                if chunk.is_empty() || chunk.len() > available {
                    return Err(invariant("Vault image source violated the bounded read"));
                }
                bytes.extend_from_slice(&chunk);
            }
            if cancellation.is_cancelled() {
                return Err(cancelled());
            }
            digest.update(bytes.as_slice());
            let encoded = writer
                .as_mut()
                .map(|writer| writer.push(&bytes))
                .transpose()?;
            artifacts
                .write_chunk(
                    &storage_scope,
                    index,
                    encoded.as_deref().unwrap_or(bytes.as_slice()),
                )
                .await?;
            read += bytes.len() as u64;
            index = index
                .checked_add(1)
                .ok_or_else(|| invariant("Vault image chunk index exhausted"))?;
        }
        if let Some(extra) = source.next_chunk(1).await.map_err(source_error)? {
            let _extra = Zeroizing::new(extra);
            return Err(invariant("Vault image source exceeded its declared length"));
        }
        let metadata = VaultImageArtifactMetadata::new(
            scope.clone(),
            vault_id,
            read,
            content_type,
            format!("{:x}", digest.finalize()),
        )?;
        let metadata = match (writer, protection.as_ref()) {
            (Some(writer), Some(context)) => {
                let protected = writer.finish(&metadata, context.device_key)?;
                metadata.with_protection(protected)?
            }
            (None, None) => metadata,
            _ => return Err(invariant("Vault image protection context conflicts")),
        };
        if cancellation.is_cancelled() {
            return Err(cancelled());
        }
        artifacts.publish(&metadata).await?;
        Ok(PreparedVaultImage { metadata })
    }
    .await;
    let close = source.close().await.map_err(source_error);
    let error = match (result, close) {
        (Ok(value), Ok(())) if !cancellation.is_cancelled() => return Ok(value),
        (Ok(_), Ok(())) => cancelled(),
        (Ok(_), Err(error)) | (Err(error), _) => error,
    };
    if let Some(scope) = cleanup_scope {
        artifacts.delete_generation(&scope).await?;
    }
    Err(error)
}

fn validate_image_shape(length: u64, content_type: &str) -> Result<(), RuntimeError> {
    if !(1..=VAULT_IMAGE_MAX_BYTES).contains(&length) {
        return Err(invariant("Vault image length is outside the shared bound"));
    }
    if !ALLOWED_CONTENT_TYPES.contains(&content_type) {
        return Err(invariant("Vault image content type is not allowed"));
    }
    Ok(())
}
pub(crate) fn validate_identity(value: &str, label: &str) -> Result<(), RuntimeError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'~' | b'-'))
    {
        return Err(invariant(&format!("{label} identity is invalid")));
    }
    Ok(())
}
fn is_lowercase_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn verify_chunks<B: AsRef<[u8]>>(
    metadata: &VaultImageArtifactMetadata,
    chunks: &[B],
) -> Result<(), RuntimeError> {
    if let Some(protection) = metadata.protection() {
        return protected::verify_ciphertext(metadata, protection, chunks);
    }
    if chunks.is_empty()
        || chunks
            .iter()
            .take(chunks.len().saturating_sub(1))
            .any(|chunk| chunk.as_ref().len() != VAULT_IMAGE_CHUNK_BYTES)
        || chunks.iter().any(|chunk| {
            chunk.as_ref().is_empty() || chunk.as_ref().len() > VAULT_IMAGE_CHUNK_BYTES
        })
    {
        return Err(invariant("Vault image artifact chunks are incomplete"));
    }
    let total = chunks
        .iter()
        .try_fold(0u64, |total, chunk| {
            total.checked_add(chunk.as_ref().len() as u64)
        })
        .ok_or_else(|| invariant("Vault image artifact length overflow"))?;
    let mut digest = Sha256::new();
    for chunk in chunks {
        digest.update(chunk.as_ref())
    }
    if total != metadata.byte_length() || format!("{:x}", digest.finalize()) != metadata.sha256() {
        return Err(invariant(
            "Vault image artifact does not match immutable metadata",
        ));
    }
    Ok(())
}
fn source_error(error: VaultImageSourceError) -> RuntimeError {
    match error {
        VaultImageSourceError::Cancelled => cancelled(),
        VaultImageSourceError::Source => {
            RuntimeError::new(RuntimeErrorCode::SourceFailure, "Vault image source failed")
        }
        VaultImageSourceError::Invariant => invariant("Vault image source violated its contract"),
    }
}
fn invariant(message: &str) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::InvariantViolation, message)
}
fn cancelled() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::Cancelled,
        "Vault image ingress was cancelled",
    )
}
