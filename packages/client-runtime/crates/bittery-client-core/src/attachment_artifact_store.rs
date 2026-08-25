use crate::{
    replica::{attachment_move_artifact_ref, AttachmentMoveArtifactRef},
    AccountId, RuntimeError,
};
use async_trait::async_trait;

#[cfg(not(target_arch = "wasm32"))]
mod sqlite;
#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests;

#[cfg(not(target_arch = "wasm32"))]
pub use sqlite::SqliteAttachmentArtifactStore;
#[cfg(all(test, not(target_arch = "wasm32")))]
pub(crate) use sqlite::SqliteFailureOperation;

pub const ARTIFACT_CHUNK_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttachmentArtifactOwner {
    account_id: AccountId,
    operation_id: String,
    attachment_id: String,
    artifact: AttachmentMoveArtifactRef,
}

impl AttachmentArtifactOwner {
    pub(crate) fn new(
        account_id: AccountId,
        operation_id: impl Into<String>,
        attachment_id: impl Into<String>,
        artifact: AttachmentMoveArtifactRef,
    ) -> Result<Self, RuntimeError> {
        let operation_id = operation_id.into();
        let attachment_id = attachment_id.into();
        let canonical = attachment_move_artifact_ref(
            &account_id,
            &operation_id,
            &attachment_id,
            &artifact.ciphertext_sha256,
            artifact.byte_length,
        )?;
        if canonical != artifact {
            return Err(artifact_error(
                "Attachment artifact reference is not canonical",
            ));
        }
        Ok(Self {
            account_id,
            operation_id,
            attachment_id,
            artifact,
        })
    }

    pub fn from_reference_parts(
        account_id: AccountId,
        operation_id: impl Into<String>,
        attachment_id: impl Into<String>,
        artifact_id: impl Into<String>,
        ciphertext_sha256: impl Into<String>,
        byte_length: u64,
    ) -> Result<Self, RuntimeError> {
        let operation_id = operation_id.into();
        let attachment_id = attachment_id.into();
        let artifact_id = artifact_id.into();
        let ciphertext_sha256 = ciphertext_sha256.into();
        let artifact = attachment_move_artifact_ref(
            &account_id,
            &operation_id,
            &attachment_id,
            &ciphertext_sha256,
            byte_length,
        )?;
        if artifact.artifact_id != artifact_id {
            return Err(artifact_error(
                "Attachment artifact reference is not canonical",
            ));
        }
        Self::new(account_id, operation_id, attachment_id, artifact)
    }

    pub fn account_id(&self) -> &AccountId {
        &self.account_id
    }

    pub fn operation_id(&self) -> &str {
        &self.operation_id
    }

    pub fn attachment_id(&self) -> &str {
        &self.attachment_id
    }

    pub fn artifact_id(&self) -> &str {
        &self.artifact.artifact_id
    }

    pub fn ciphertext_sha256(&self) -> &str {
        &self.artifact.ciphertext_sha256
    }

    pub fn byte_length(&self) -> u64 {
        self.artifact.byte_length
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ArtifactChunkWrite {
    Stored,
    AlreadyStored,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ArtifactPublication {
    Published,
    AlreadyPublished,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublishedArtifactChunk {
    pub bytes: Vec<u8>,
    pub is_last: bool,
}

pub struct ExclusiveStartupBoundary {
    _private: (),
}

impl ExclusiveStartupBoundary {
    pub(crate) fn proven_by_runtime_startup() -> Self {
        Self { _private: () }
    }
}

pub enum AttachmentArtifactStoreRequest {
    WriteChunk {
        owner: AttachmentArtifactOwner,
        chunk_index: u32,
        bytes: Vec<u8>,
    },
    Publish {
        owner: AttachmentArtifactOwner,
    },
    ReadChunk {
        owner: AttachmentArtifactOwner,
        chunk_index: u32,
    },
    DeleteAccount {
        account_id: AccountId,
    },
    SweepOrphans {
        boundary: ExclusiveStartupBoundary,
        account_id: AccountId,
        live: Vec<AttachmentArtifactOwner>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AttachmentArtifactStoreResponse {
    ChunkWritten(ArtifactChunkWrite),
    Published(ArtifactPublication),
    ChunkRead(PublishedArtifactChunk),
    AccountDeleted,
    OrphansSwept { deleted: usize },
}

#[cfg(not(target_arch = "wasm32"))]
#[async_trait]
pub trait AttachmentArtifactStore: Send + Sync {
    async fn invoke(
        &self,
        request: AttachmentArtifactStoreRequest,
    ) -> Result<AttachmentArtifactStoreResponse, RuntimeError>;
}

#[cfg(target_arch = "wasm32")]
#[async_trait(?Send)]
pub trait AttachmentArtifactStore {
    async fn invoke(
        &self,
        request: AttachmentArtifactStoreRequest,
    ) -> Result<AttachmentArtifactStoreResponse, RuntimeError>;
}

fn artifact_error(message: impl Into<String>) -> RuntimeError {
    RuntimeError::new(crate::RuntimeErrorCode::InvariantViolation, message)
}
