//! Durable plaintext ingress for an optional Vault image.
//!
//! This port is intentionally unrelated to the encrypted Attachment artifact port. A later
//! create-Vault slice may reference a published artifact, but this module cannot accept an
//! Operation or dispatch network work.

use crate::{AccountId, RequestCancellation, RuntimeError, RuntimeErrorCode};
use async_trait::async_trait;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
};
use zeroize::{Zeroize, Zeroizing};

#[cfg(not(target_arch = "wasm32"))]
mod sqlite;
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
        })
    }
    pub fn account_id(&self) -> &AccountId {
        &self.account_id
    }
    pub fn operation_id(&self) -> &str {
        &self.operation_id
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VaultImageArtifactMetadata {
    scope: VaultImageArtifactScope,
    vault_id: String,
    byte_length: u64,
    content_type: String,
    sha256: String,
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
        })
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
    async fn delete(&self, scope: &VaultImageArtifactScope) -> Result<(), RuntimeError> {
        self.inner
            .lock()
            .expect("Vault image memory store lock poisoned")
            .artifacts
            .remove(scope);
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
    pub async fn retire_account(&self, account_id: &AccountId) -> Result<(), RuntimeError> {
        let source = self
            .sources
            .retire_account(&self.runtime_incarnation, account_id)
            .await
            .map_err(source_error);
        let artifact = self.artifacts.delete_account(account_id).await;
        source.and(artifact)
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
        let source = self
            .sources
            .retire_runtime(&self.runtime_incarnation)
            .await
            .map_err(source_error);
        let artifact = self.artifacts.wipe().await;
        source.and(artifact)
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
            .map_err(source_error)?;
        self.artifacts.delete_account(account_id).await
    }
    pub async fn retire_runtime(&self, incarnation: &str) -> Result<(), RuntimeError> {
        self.sources
            .retire_runtime(incarnation)
            .await
            .map_err(source_error)?;
        self.artifacts.wipe().await
    }
}

async fn prepare_image<S: VaultImageSourcePort + ?Sized, A: VaultImageArtifactPort + ?Sized>(
    sources: &S,
    artifacts: &A,
    grant: VaultImageSourceGrant,
    cancellation: &RequestCancellation,
) -> Result<PreparedVaultImage, RuntimeError> {
    let scope = grant.validate()?;
    let mut source = sources.claim(&grant).await.map_err(source_error)?;
    let result = async {
        artifacts.begin(&scope).await?;
        let mut digest = Sha256::new();
        let mut read = 0u64;
        let mut index = 0u32;
        while read < grant.byte_length {
            if cancellation.is_cancelled() {
                return Err(cancelled());
            }
            let remaining =
                usize::try_from(grant.byte_length - read).unwrap_or(VAULT_IMAGE_CHUNK_BYTES);
            let limit = remaining.min(VAULT_IMAGE_CHUNK_BYTES);
            let bytes = source
                .next_chunk(limit)
                .await
                .map_err(source_error)?
                .ok_or_else(|| invariant("Vault image source ended before its declared length"))?;
            let bytes = Zeroizing::new(bytes);
            if bytes.is_empty() || bytes.len() > limit {
                return Err(invariant("Vault image source violated the bounded read"));
            }
            digest.update(bytes.as_slice());
            artifacts
                .write_chunk(&scope, index, bytes.as_slice())
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
            grant.vault_id,
            read,
            grant.content_type,
            format!("{:x}", digest.finalize()),
        )?;
        artifacts.publish(&metadata).await?;
        Ok(PreparedVaultImage { metadata })
    }
    .await;
    let close = source.close().await.map_err(source_error);
    match (result, close) {
        (Ok(value), Ok(())) => Ok(value),
        (Ok(_), Err(error)) => {
            artifacts.delete(&scope).await?;
            Err(error)
        }
        (Err(error), _) => {
            artifacts.delete(&scope).await?;
            Err(error)
        }
    }
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
fn validate_identity(value: &str, label: &str) -> Result<(), RuntimeError> {
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
