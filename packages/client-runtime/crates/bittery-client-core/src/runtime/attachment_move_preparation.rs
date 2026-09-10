//! Restart-safe preparation of Attachment-bearing Move Operations.
//!
//! The module deliberately exposes one Account/Operation-scoped drive call. It owns the remote
//! preparation protocol and the ordering between binary artifact publication and the guarded
//! Replica checkpoint; hosts only supply streaming transport and ephemeral cryptographic material.

use crate::{
    attachment_artifact_store::{
        AttachmentArtifactOwner, AttachmentArtifactStore, AttachmentArtifactStoreRequest,
        AttachmentArtifactStoreResponse, ProvisionalAttachmentArtifactScope,
        ProvisionalAttachmentArtifactStore, ProvisionalAttachmentArtifactStoreRequest,
        ProvisionalAttachmentArtifactStoreResponse, ProvisionalAttachmentArtifactWriter,
        ARTIFACT_CHUNK_BYTES,
    },
    replica::{
        AttachmentMovePreparationRecord, AttachmentMoveProgress, AttachmentMoveUploadState,
        AuthorityAttachmentRecord, GuardedCommitPlan, OperationSchedulingState, PlanMutation,
        PreparedMoveAttachment, RecomputedPlanResult, Replica, ReplicaSnapshot, Sha256Fingerprint,
    },
    AccountId, RuntimeError, RuntimeErrorCode,
};
use async_trait::async_trait;
use bittery_crypto_core::attachment_move::{
    AttachmentBlobScope, AttachmentEnvelopeScanner, AttachmentMoveTranscryptor,
    AttachmentPublicationIdentity,
};
use std::sync::Arc;
use zeroize::Zeroizing;

const BASE_BACKOFF_MS: u64 = 1_000;
const MAX_BACKOFF_MS: u64 = 5 * 60 * 1_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DownloadPass {
    Scan,
    Transcrypt,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SourceDownloadRequest {
    pub account_id: AccountId,
    pub operation_id: String,
    pub attachment_id: String,
    pub storage_key: String,
    pub pass: DownloadPass,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ManifestAttachment {
    pub attachment_id: String,
    pub envelope_version: i32,
    pub ciphertext_sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ManifestRequest {
    pub account_id: AccountId,
    pub operation_id: String,
    pub item_id: String,
    pub source_vault_id: String,
    pub target_vault_id: String,
    pub attachments: Vec<ManifestAttachment>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct UploadGrant {
    pub attachment_id: String,
    pub storage_key: String,
    pub upload_url: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Manifest {
    pub operation_id: String,
    pub uploads: Vec<UploadGrant>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PreparationTransportError {
    Transient,
    Busy,
    StaleAuthority,
    Invariant,
}

#[cfg(not(target_arch = "wasm32"))]
#[async_trait]
pub(crate) trait SourceDownload: Send {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, PreparationTransportError>;
}

#[cfg(target_arch = "wasm32")]
#[async_trait(?Send)]
pub(crate) trait SourceDownload {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, PreparationTransportError>;
}

#[cfg(not(target_arch = "wasm32"))]
#[async_trait]
pub(crate) trait StagingUpload: Send {
    async fn write_chunk(&mut self, bytes: &[u8]) -> Result<(), PreparationTransportError>;
    async fn finish(self: Box<Self>) -> Result<(), PreparationTransportError>;
}

#[cfg(target_arch = "wasm32")]
#[async_trait(?Send)]
pub(crate) trait StagingUpload {
    async fn write_chunk(&mut self, bytes: &[u8]) -> Result<(), PreparationTransportError>;
    async fn finish(self: Box<Self>) -> Result<(), PreparationTransportError>;
}

#[cfg(not(target_arch = "wasm32"))]
#[async_trait]
pub(crate) trait AttachmentMoveTransfer: Send + Sync {
    async fn open_source(
        &self,
        request: SourceDownloadRequest,
    ) -> Result<Box<dyn SourceDownload>, PreparationTransportError>;

    async fn renew_manifest(
        &self,
        request: ManifestRequest,
    ) -> Result<Manifest, PreparationTransportError>;

    async fn open_upload(
        &self,
        account_id: &AccountId,
        operation_id: &str,
        grant: &UploadGrant,
        owner: &AttachmentArtifactOwner,
    ) -> Result<Box<dyn StagingUpload>, PreparationTransportError>;
}

#[cfg(target_arch = "wasm32")]
#[async_trait(?Send)]
pub(crate) trait AttachmentMoveTransfer {
    async fn open_source(
        &self,
        request: SourceDownloadRequest,
    ) -> Result<Box<dyn SourceDownload>, PreparationTransportError>;

    async fn renew_manifest(
        &self,
        request: ManifestRequest,
    ) -> Result<Manifest, PreparationTransportError>;

    async fn open_upload(
        &self,
        account_id: &AccountId,
        operation_id: &str,
        grant: &UploadGrant,
        owner: &AttachmentArtifactOwner,
    ) -> Result<Box<dyn StagingUpload>, PreparationTransportError>;
}

pub(crate) struct AttachmentMoveSecrets {
    pub source_key: Zeroizing<[u8; 32]>,
    pub target_key: Zeroizing<[u8; 32]>,
    pub prepared_metadata: PreparedMoveAttachment,
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) trait AttachmentMoveSecretProvider: Send + Sync {
    fn resolve(
        &self,
        preparation: &AttachmentMovePreparationRecord,
        source: &AuthorityAttachmentRecord,
    ) -> Result<AttachmentMoveSecrets, RuntimeError>;

    /// Re-seals target metadata from immutable source authority for an already-published blob.
    /// The implementation must unwrap the same durable Attachment key; it must not mint a new key.
    fn recover_published_metadata(
        &self,
        preparation: &AttachmentMovePreparationRecord,
        source: &AuthorityAttachmentRecord,
        owner: &AttachmentArtifactOwner,
    ) -> Result<PreparedMoveAttachment, RuntimeError>;
}

#[cfg(target_arch = "wasm32")]
pub(crate) trait AttachmentMoveSecretProvider {
    fn resolve(
        &self,
        preparation: &AttachmentMovePreparationRecord,
        source: &AuthorityAttachmentRecord,
    ) -> Result<AttachmentMoveSecrets, RuntimeError>;

    fn recover_published_metadata(
        &self,
        preparation: &AttachmentMovePreparationRecord,
        source: &AuthorityAttachmentRecord,
        owner: &AttachmentArtifactOwner,
    ) -> Result<PreparedMoveAttachment, RuntimeError>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PreparationDriveResult {
    Progressed,
    BackingOff { not_before_ms: u64 },
    ReadyForDispatch,
    FrozenStaleAuthority,
}

pub(crate) enum PreparationDriveRequest {
    Advance {
        account_id: AccountId,
        operation_id: String,
        now_ms: u64,
    },
    ReactivateStagingIncomplete {
        account_id: AccountId,
        operation_id: String,
        expected_request_fingerprint: Sha256Fingerprint,
    },
}

pub(crate) struct AttachmentMovePreparationWorker {
    replica: Arc<Replica>,
    provisional_artifacts: Arc<dyn ProvisionalAttachmentArtifactStore>,
    artifacts: Arc<dyn AttachmentArtifactStore>,
    transfer: Arc<dyn AttachmentMoveTransfer>,
    secrets: Arc<dyn AttachmentMoveSecretProvider>,
}

impl AttachmentMovePreparationWorker {
    pub(crate) fn new(
        replica: Arc<Replica>,
        provisional_artifacts: Arc<dyn ProvisionalAttachmentArtifactStore>,
        artifacts: Arc<dyn AttachmentArtifactStore>,
        transfer: Arc<dyn AttachmentMoveTransfer>,
        secrets: Arc<dyn AttachmentMoveSecretProvider>,
    ) -> Self {
        Self {
            replica,
            provisional_artifacts,
            artifacts,
            transfer,
            secrets,
        }
    }

    pub(crate) async fn drive(
        &self,
        request: PreparationDriveRequest,
    ) -> Result<PreparationDriveResult, RuntimeError> {
        match request {
            PreparationDriveRequest::Advance {
                account_id,
                operation_id,
                now_ms,
            } => self.advance(account_id, operation_id, now_ms).await,
            PreparationDriveRequest::ReactivateStagingIncomplete {
                account_id,
                operation_id,
                expected_request_fingerprint,
            } => {
                let snapshot = self.scoped_snapshot(&account_id, &operation_id, false)?;
                self.commit(
                    &snapshot,
                    PlanMutation::ReactivateAttachmentMovePreparation {
                        operation_id,
                        expected_request_fingerprint,
                    },
                )
                .await?;
                Ok(PreparationDriveResult::Progressed)
            }
        }
    }

    async fn advance(
        &self,
        account_id: AccountId,
        operation_id: String,
        now_ms: u64,
    ) -> Result<PreparationDriveResult, RuntimeError> {
        let snapshot = self.scoped_snapshot(&account_id, &operation_id, true)?;
        let preparation = snapshot
            .attachment_move_preparations
            .iter()
            .find(|candidate| candidate.operation_id == operation_id)
            .cloned()
            .ok_or_else(|| invariant("Attachment Move preparation is not active"))?;
        if preparation.scheduling.not_before_ms > now_ms {
            return Ok(PreparationDriveResult::BackingOff {
                not_before_ms: preparation.scheduling.not_before_ms,
            });
        }

        if let Some((index, pending)) = preparation
            .progress
            .iter()
            .enumerate()
            .find(|(_, progress)| matches!(progress, AttachmentMoveProgress::Pending { .. }))
        {
            let source = preparation
                .source_attachments
                .get(index)
                .ok_or_else(|| invariant("Attachment Move source authority is incomplete"))?;
            return match self.prepare_artifact(&preparation, source, pending).await {
                Ok(next) => {
                    self.commit(
                        &snapshot,
                        PlanMutation::CheckpointAttachmentMove {
                            operation_id,
                            expected_intent_fingerprint: preparation.intent_fingerprint,
                            expected: pending.clone(),
                            next,
                        },
                    )
                    .await?;
                    Ok(PreparationDriveResult::Progressed)
                }
                Err(PreparationFailure::Retryable) => {
                    self.persist_backoff(&snapshot, preparation, now_ms).await
                }
                Err(PreparationFailure::Invariant) => Err(invariant(
                    "Attachment Move preparation transport violated its closed contract",
                )),
                Err(PreparationFailure::Local(error)) => Err(error),
                Err(PreparationFailure::StaleAuthority) => {
                    self.freeze_stale(&snapshot, &preparation).await
                }
            };
        }

        let needs_upload = preparation.progress.iter().position(|progress| {
            matches!(
                progress,
                AttachmentMoveProgress::Encrypted {
                    upload: AttachmentMoveUploadState::NeedsUpload,
                    ..
                }
            )
        });
        if let Some(index) = needs_upload {
            let manifest = match self
                .transfer
                .renew_manifest(manifest_request(&preparation)?)
                .await
            {
                Ok(manifest) => manifest,
                Err(PreparationTransportError::StaleAuthority) => {
                    return self.freeze_stale(&snapshot, &preparation).await;
                }
                Err(PreparationTransportError::Transient | PreparationTransportError::Busy) => {
                    return self.persist_backoff(&snapshot, preparation, now_ms).await;
                }
                Err(PreparationTransportError::Invariant) => {
                    return Err(invariant("Attachment Move manifest response is invalid"));
                }
            };
            let current = preparation.progress[index].clone();
            let next = match self.upload_artifact(&preparation, &current, manifest).await {
                Ok(next) => next,
                Err(PreparationFailure::Retryable) => {
                    return self.persist_backoff(&snapshot, preparation, now_ms).await;
                }
                Err(PreparationFailure::Invariant) => {
                    return Err(invariant("Attachment Move upload response is invalid"));
                }
                Err(PreparationFailure::Local(error)) => return Err(error),
                Err(PreparationFailure::StaleAuthority) => {
                    return self.freeze_stale(&snapshot, &preparation).await;
                }
            };
            self.commit(
                &snapshot,
                PlanMutation::CheckpointAttachmentMove {
                    operation_id,
                    expected_intent_fingerprint: preparation.intent_fingerprint,
                    expected: current,
                    next,
                },
            )
            .await?;
            return Ok(PreparationDriveResult::Progressed);
        }

        self.commit(
            &snapshot,
            PlanMutation::PromoteAttachmentMovePreparation {
                operation_id,
                expected_intent_fingerprint: preparation.intent_fingerprint,
            },
        )
        .await?;
        Ok(PreparationDriveResult::ReadyForDispatch)
    }

    fn scoped_snapshot(
        &self,
        account_id: &AccountId,
        operation_id: &str,
        require_preparation: bool,
    ) -> Result<ReplicaSnapshot, RuntimeError> {
        let snapshot = self.replica.snapshot(account_id).ok_or_else(|| {
            RuntimeError::new(RuntimeErrorCode::AccountMissing, "Account is not installed")
        })?;
        let preparation_matches = snapshot
            .attachment_move_preparations
            .iter()
            .any(|candidate| {
                candidate.account_id == *account_id && candidate.operation_id == operation_id
            });
        let operation_matches = snapshot.operations.iter().any(|candidate| {
            candidate.operation_id == operation_id && candidate.attachment_move_recovery.is_some()
        });
        if (require_preparation && !preparation_matches)
            || (!require_preparation && !preparation_matches && !operation_matches)
        {
            return Err(invariant(
                "Attachment Move drive scope does not identify durable work",
            ));
        }
        Ok(snapshot)
    }

    async fn prepare_artifact(
        &self,
        preparation: &AttachmentMovePreparationRecord,
        source: &AuthorityAttachmentRecord,
        pending: &AttachmentMoveProgress,
    ) -> Result<AttachmentMoveProgress, PreparationFailure> {
        let scope = ProvisionalAttachmentArtifactScope::new(
            preparation.account_id.clone(),
            preparation.operation_id.clone(),
            source.id.clone(),
        )
        .map_err(|_| PreparationFailure::Invariant)?;
        let writer = ProvisionalAttachmentArtifactWriter::new(scope);
        let (owner, prepared_metadata) = match self
            .provisional_artifacts
            .invoke_provisional(ProvisionalAttachmentArtifactStoreRequest::Begin {
                writer: writer.clone(),
            })
            .await
            .map_err(PreparationFailure::Local)?
        {
            ProvisionalAttachmentArtifactStoreResponse::Begun(writer) => {
                self.transcrypt_into_writer(preparation, source, writer)
                    .await?
            }
            ProvisionalAttachmentArtifactStoreResponse::RecoveryAvailable(recovery) => {
                match self
                    .provisional_artifacts
                    .invoke_provisional(
                        ProvisionalAttachmentArtifactStoreRequest::ResumeRecovered { recovery },
                    )
                    .await
                    .map_err(PreparationFailure::Local)?
                {
                    ProvisionalAttachmentArtifactStoreResponse::Finalized(owner) => {
                        let metadata = self
                            .secrets
                            .recover_published_metadata(preparation, source, &owner)
                            .map_err(PreparationFailure::Local)?;
                        (owner, metadata)
                    }
                    _ => return Err(PreparationFailure::Invariant),
                }
            }
            _ => return Err(PreparationFailure::Invariant),
        };
        Ok(AttachmentMoveProgress::Encrypted {
            attachment_id: pending.attachment_id().to_owned(),
            expected_envelope_version: pending.expected_envelope_version(),
            artifact: crate::replica::attachment_move_artifact_ref(
                owner.account_id(),
                owner.operation_id(),
                owner.attachment_id(),
                owner.ciphertext_sha256(),
                owner.byte_length(),
            )
            .map_err(|_| PreparationFailure::Invariant)?,
            payload: Box::new(prepared_metadata),
            upload: AttachmentMoveUploadState::NeedsUpload,
        })
    }

    async fn transcrypt_into_writer(
        &self,
        preparation: &AttachmentMovePreparationRecord,
        source: &AuthorityAttachmentRecord,
        writer: ProvisionalAttachmentArtifactWriter,
    ) -> Result<(AttachmentArtifactOwner, PreparedMoveAttachment), PreparationFailure> {
        let mut first = self
            .transfer
            .open_source(source_request(preparation, source, DownloadPass::Scan))
            .await
            .map_err(PreparationFailure::from_transport)?;
        let mut scanner = AttachmentEnvelopeScanner::new();
        while let Some(chunk) = first
            .next_chunk()
            .await
            .map_err(PreparationFailure::from_transport)?
        {
            scanner
                .push(&chunk)
                .map_err(|_| PreparationFailure::Retryable)?;
        }
        // Scanner, stream, authentication, and envelope failures can be caused by a failed or
        // corrupted download. They are retryable preparation work, never a semantic outcome.
        let scan = scanner
            .finish()
            .map_err(|_| PreparationFailure::Retryable)?;
        let secrets = self
            .secrets
            .resolve(preparation, source)
            .map_err(PreparationFailure::Local)?;
        let AttachmentMoveSecrets {
            source_key,
            target_key,
            prepared_metadata,
        } = secrets;
        let identity = AttachmentPublicationIdentity::new(
            preparation.account_id.as_str().to_owned(),
            source.uploaded_by.clone(),
            preparation.operation_id.clone(),
            source.id.clone(),
        )
        .map_err(|_| PreparationFailure::Invariant)?;
        let mut transcryptor = AttachmentMoveTranscryptor::new(
            scan,
            *source_key,
            AttachmentBlobScope::new(
                preparation.source_vault_id.clone(),
                source.id.clone(),
                source.uploaded_by.clone(),
            ),
            *target_key,
            AttachmentBlobScope::new(
                preparation.target_vault_id.clone(),
                source.id.clone(),
                source.uploaded_by.clone(),
            ),
            identity,
        )
        .map_err(|_| PreparationFailure::Retryable)?;
        let mut second = self
            .transfer
            .open_source(source_request(
                preparation,
                source,
                DownloadPass::Transcrypt,
            ))
            .await
            .map_err(PreparationFailure::from_transport)?;
        let mut chunks = ArtifactChunker::default();
        while let Some(chunk) = second
            .next_chunk()
            .await
            .map_err(PreparationFailure::from_transport)?
        {
            let output = transcryptor
                .push(&chunk)
                .map_err(|_| PreparationFailure::Retryable)?;
            chunks
                .push(&writer, &output, self.provisional_artifacts.as_ref())
                .await?;
        }
        let finished = transcryptor
            .finish()
            .map_err(|_| PreparationFailure::Retryable)?;
        chunks
            .push(
                &writer,
                &finished.final_chunk,
                self.provisional_artifacts.as_ref(),
            )
            .await?;
        chunks
            .finish(&writer, self.provisional_artifacts.as_ref())
            .await?;
        match self
            .provisional_artifacts
            .invoke_provisional(ProvisionalAttachmentArtifactStoreRequest::Finalize {
                writer,
                publication_proof: finished.publication_proof,
            })
            .await
            .map_err(PreparationFailure::Local)?
        {
            ProvisionalAttachmentArtifactStoreResponse::Finalized(owner) => {
                Ok((owner, prepared_metadata))
            }
            _ => Err(PreparationFailure::Invariant),
        }
    }

    async fn upload_artifact(
        &self,
        preparation: &AttachmentMovePreparationRecord,
        current: &AttachmentMoveProgress,
        manifest: Manifest,
    ) -> Result<AttachmentMoveProgress, PreparationFailure> {
        if !valid_manifest(preparation, &manifest) {
            return Err(PreparationFailure::Invariant);
        }
        let AttachmentMoveProgress::Encrypted {
            attachment_id,
            expected_envelope_version,
            artifact,
            payload,
            upload: AttachmentMoveUploadState::NeedsUpload,
        } = current
        else {
            return Err(PreparationFailure::Invariant);
        };
        let grant = manifest
            .uploads
            .iter()
            .find(|grant| grant.attachment_id == *attachment_id)
            .ok_or(PreparationFailure::Invariant)?;
        let owner = AttachmentArtifactOwner::from_reference_parts(
            preparation.account_id.clone(),
            preparation.operation_id.clone(),
            attachment_id.clone(),
            artifact.artifact_id.clone(),
            artifact.ciphertext_sha256.clone(),
            artifact.byte_length,
        )
        .map_err(|_| PreparationFailure::Invariant)?;
        let mut upload = self
            .transfer
            .open_upload(
                &preparation.account_id,
                &preparation.operation_id,
                grant,
                &owner,
            )
            .await
            .map_err(PreparationFailure::from_transport)?;
        let mut index = 0u32;
        loop {
            let response = self
                .artifacts
                .invoke(AttachmentArtifactStoreRequest::ReadChunk {
                    owner: owner.clone(),
                    chunk_index: index,
                })
                .await
                .map_err(PreparationFailure::Local)?;
            let AttachmentArtifactStoreResponse::ChunkRead(chunk) = response else {
                return Err(PreparationFailure::Invariant);
            };
            upload
                .write_chunk(&chunk.bytes)
                .await
                .map_err(PreparationFailure::from_transport)?;
            if chunk.is_last {
                break;
            }
            index = index.checked_add(1).ok_or(PreparationFailure::Invariant)?;
        }
        upload
            .finish()
            .await
            .map_err(PreparationFailure::from_transport)?;
        Ok(AttachmentMoveProgress::Encrypted {
            attachment_id: attachment_id.clone(),
            expected_envelope_version: *expected_envelope_version,
            artifact: artifact.clone(),
            payload: payload.clone(),
            upload: AttachmentMoveUploadState::Uploaded,
        })
    }

    async fn persist_backoff(
        &self,
        snapshot: &ReplicaSnapshot,
        mut preparation: AttachmentMovePreparationRecord,
        now_ms: u64,
    ) -> Result<PreparationDriveResult, RuntimeError> {
        let attempt_count = preparation.scheduling.attempt_count.saturating_add(1);
        let not_before_ms = now_ms.saturating_add(backoff_ms(attempt_count));
        preparation.scheduling = OperationSchedulingState {
            attempt_count,
            not_before_ms,
        };
        self.commit(
            snapshot,
            PlanMutation::RescheduleAttachmentMovePreparation(preparation),
        )
        .await?;
        Ok(PreparationDriveResult::BackingOff { not_before_ms })
    }

    async fn freeze_stale(
        &self,
        snapshot: &ReplicaSnapshot,
        preparation: &AttachmentMovePreparationRecord,
    ) -> Result<PreparationDriveResult, RuntimeError> {
        self.commit(
            snapshot,
            PlanMutation::FreezeAttachmentMoveRejection {
                operation_id: preparation.operation_id.clone(),
                expected_intent_fingerprint: preparation.intent_fingerprint,
            },
        )
        .await?;
        Ok(PreparationDriveResult::FrozenStaleAuthority)
    }

    async fn commit(
        &self,
        snapshot: &ReplicaSnapshot,
        mutation: PlanMutation,
    ) -> Result<ReplicaSnapshot, RuntimeError> {
        match self
            .replica
            .execute_recomputing(GuardedCommitPlan::new(
                snapshot.account_id.clone(),
                snapshot.incarnation.clone(),
                snapshot.revision,
                snapshot.lock_epoch,
                vec![mutation],
            ))
            .await?
        {
            RecomputedPlanResult::Applied { snapshot } => {
                self.replica.cache(snapshot.clone());
                Ok(snapshot)
            }
            RecomputedPlanResult::Fenced { .. } => Err(RuntimeError::new(
                RuntimeErrorCode::AuthenticationRequired,
                "Attachment Move preparation was fenced by Account lock",
            )),
            RecomputedPlanResult::Missing => Err(RuntimeError::new(
                RuntimeErrorCode::AccountMissing,
                "Account was removed during Attachment Move preparation",
            )),
        }
    }
}

fn valid_manifest(preparation: &AttachmentMovePreparationRecord, manifest: &Manifest) -> bool {
    if manifest.operation_id != preparation.operation_id
        || manifest.uploads.len() != preparation.progress.len()
    {
        return false;
    }
    let expected: std::collections::HashSet<_> = preparation
        .progress
        .iter()
        .map(AttachmentMoveProgress::attachment_id)
        .collect();
    let actual: std::collections::HashSet<_> = manifest
        .uploads
        .iter()
        .map(|grant| grant.attachment_id.as_str())
        .collect();
    expected == actual
        && actual.len() == manifest.uploads.len()
        && manifest
            .uploads
            .iter()
            .all(|grant| !grant.storage_key.is_empty() && !grant.upload_url.is_empty())
}

enum PreparationFailure {
    Retryable,
    StaleAuthority,
    Invariant,
    Local(RuntimeError),
}

impl PreparationFailure {
    fn from_transport(error: PreparationTransportError) -> Self {
        match error {
            PreparationTransportError::Transient | PreparationTransportError::Busy => {
                Self::Retryable
            }
            PreparationTransportError::StaleAuthority => Self::StaleAuthority,
            PreparationTransportError::Invariant => Self::Invariant,
        }
    }
}

#[derive(Default)]
struct ArtifactChunker {
    pending: Vec<u8>,
    next_index: u32,
}

impl ArtifactChunker {
    async fn push(
        &mut self,
        writer: &ProvisionalAttachmentArtifactWriter,
        mut bytes: &[u8],
        store: &dyn ProvisionalAttachmentArtifactStore,
    ) -> Result<(), PreparationFailure> {
        while !bytes.is_empty() {
            let take = (ARTIFACT_CHUNK_BYTES - self.pending.len()).min(bytes.len());
            self.pending.extend_from_slice(&bytes[..take]);
            bytes = &bytes[take..];
            if self.pending.len() == ARTIFACT_CHUNK_BYTES {
                self.flush(writer, store).await?;
            }
        }
        Ok(())
    }

    async fn finish(
        &mut self,
        writer: &ProvisionalAttachmentArtifactWriter,
        store: &dyn ProvisionalAttachmentArtifactStore,
    ) -> Result<(), PreparationFailure> {
        if !self.pending.is_empty() {
            self.flush(writer, store).await?;
        }
        Ok(())
    }

    async fn flush(
        &mut self,
        writer: &ProvisionalAttachmentArtifactWriter,
        store: &dyn ProvisionalAttachmentArtifactStore,
    ) -> Result<(), PreparationFailure> {
        let bytes = std::mem::take(&mut self.pending);
        let response = store
            .invoke_provisional(ProvisionalAttachmentArtifactStoreRequest::WriteChunk {
                writer: writer.clone(),
                chunk_index: self.next_index,
                bytes,
            })
            .await
            .map_err(PreparationFailure::Local)?;
        if !matches!(
            response,
            ProvisionalAttachmentArtifactStoreResponse::ChunkWritten(_)
        ) {
            return Err(PreparationFailure::Invariant);
        }
        self.next_index = self
            .next_index
            .checked_add(1)
            .ok_or(PreparationFailure::Invariant)?;
        Ok(())
    }
}

fn source_request(
    preparation: &AttachmentMovePreparationRecord,
    source: &AuthorityAttachmentRecord,
    pass: DownloadPass,
) -> SourceDownloadRequest {
    SourceDownloadRequest {
        account_id: preparation.account_id.clone(),
        operation_id: preparation.operation_id.clone(),
        attachment_id: source.id.clone(),
        storage_key: source.storage_key.clone(),
        pass,
    }
}

fn manifest_request(
    preparation: &AttachmentMovePreparationRecord,
) -> Result<ManifestRequest, RuntimeError> {
    let attachments = preparation
        .progress
        .iter()
        .map(|progress| match progress {
            AttachmentMoveProgress::Encrypted {
                attachment_id,
                expected_envelope_version,
                artifact,
                ..
            } => Ok(ManifestAttachment {
                attachment_id: attachment_id.clone(),
                envelope_version: *expected_envelope_version,
                ciphertext_sha256: artifact.ciphertext_sha256.clone(),
            }),
            AttachmentMoveProgress::Pending { .. } => Err(invariant(
                "Attachment Move manifest cannot precede complete encryption",
            )),
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ManifestRequest {
        account_id: preparation.account_id.clone(),
        operation_id: preparation.operation_id.clone(),
        item_id: preparation.item_id.clone(),
        source_vault_id: preparation.source_vault_id.clone(),
        target_vault_id: preparation.target_vault_id.clone(),
        attachments,
    })
}

fn backoff_ms(attempt_count: u64) -> u64 {
    let exponent = u32::try_from(attempt_count.saturating_sub(1).min(20)).unwrap_or(20);
    (BASE_BACKOFF_MS << exponent).min(MAX_BACKOFF_MS)
}

fn invariant(message: impl Into<String>) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::InvariantViolation, message)
}
