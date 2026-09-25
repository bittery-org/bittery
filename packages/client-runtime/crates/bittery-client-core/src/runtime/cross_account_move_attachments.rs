//! Cross-Account Attachment execution uses the existing HTTP, byte, lease, and artifact owners.
use super::*;
use crate::attachment_artifact_store::{
    AttachmentArtifactOwner, AttachmentArtifactStoreRequest, AttachmentArtifactStoreResponse,
    ProvisionalAttachmentArtifactScope, ProvisionalAttachmentArtifactStoreRequest,
    ProvisionalAttachmentArtifactStoreResponse, ProvisionalAttachmentArtifactWriter,
};
use crate::auth_http::{
    AttachmentDownloadGrantAnswer, AttachmentMetadataCreateAnswer, AttachmentUploadGrantAnswer,
};
use crate::replica::{
    attachment_move_artifact_ref, attachment_registration_matches, AuthorityAttachmentRecord,
    CrossAccountMoveAttachmentCheckpoint, CrossAccountMoveAttachmentEvidence,
    CrossAccountMoveAttachmentProgress,
};
use crate::runtime::attachment_move_scheduler::{
    source_response_bound, transfer_error, validate_source_grant, DownloadAdapter,
};
use crate::runtime::attachment_transcryption::{
    scan_source, transcrypt_source, DownloadPass, PreparationTransportError, SourceDownload,
    SourceOpen, TranscryptionError, TranscryptionMaterial,
};
use crate::server_contract::{AttachmentUploadBody, CreateAttachmentBody};
use crate::{
    AttachmentMoveAccountLease, AttachmentMoveDownloadRequest, AttachmentMovePreparationFacade,
    AttachmentMoveUploadGrant,
};
use async_trait::async_trait;
use bittery_crypto_core::attachment_move::{AttachmentBlobScope, AttachmentPublicationIdentity};
use sha2::{Digest, Sha256};

pub(super) struct AttachmentAccess {
    facade: AttachmentMovePreparationFacade,
    lease: Box<dyn AttachmentMoveAccountLease>,
}

impl AttachmentAccess {
    pub(super) async fn acquire(
        runtime: &Runtime,
        source: &ReplicaSnapshot,
        record: &CrossAccountMoveRecord,
    ) -> Result<Option<Self>, RuntimeError> {
        if record.attachments.is_empty() {
            return Ok(None);
        }
        let facade = runtime
            .attachment_move_scheduler
            .lock()
            .expect("Attachment scheduler lock poisoned")
            .as_ref()
            .and_then(|scheduler| scheduler.facade())
            .cloned();
        let lifecycle = runtime
            .attachment_move_lifecycle
            .lock()
            .expect("Attachment lifecycle lock poisoned")
            .clone();
        let (Some(facade), Some(lifecycle)) = (facade, lifecycle) else {
            return Err(move_error(
                "Move requires its existing Attachment capabilities",
            ));
        };
        let lease = lifecycle
            .acquire(&source.account_id)
            .await?
            .filter(|lease| lease.is_live())
            .ok_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::RetryableTransport,
                    "Attachment Account is busy",
                )
            })?;
        Ok(Some(Self { facade, lease }))
    }

    pub(super) fn is_live(&self) -> bool {
        self.lease.is_live()
    }
}

pub(super) async fn lease_lost(access: Option<&AttachmentAccess>) {
    match access {
        Some(access) => access.lease.lost().await,
        None => std::future::pending().await,
    }
}

enum AttachmentCall<'a> {
    Download(&'a str),
    Grant(&'a AttachmentUploadBody),
    Register(&'a CreateAttachmentBody),
}

enum AttachmentAnswer {
    Download(AttachmentDownloadGrantAnswer),
    Grant(AttachmentUploadGrantAnswer),
    Register(AttachmentMetadataCreateAnswer),
}

fn map_answer<T>(
    answer: AuthenticatedOutcome<T>,
    wrap: impl FnOnce(T) -> AttachmentAnswer,
) -> AuthenticatedOutcome<AttachmentAnswer> {
    match answer {
        AuthenticatedOutcome::Ok(value) => AuthenticatedOutcome::Ok(wrap(value)),
        AuthenticatedOutcome::ReauthenticationRequired => {
            AuthenticatedOutcome::ReauthenticationRequired
        }
        AuthenticatedOutcome::Transient => AuthenticatedOutcome::Transient,
    }
}

impl Attempt<'_> {
    fn attachment_facade(&self) -> Result<&AttachmentMovePreparationFacade, MoveFailure> {
        self.attachment_access
            .map(|access| &access.facade)
            .ok_or(MoveFailure::Blocked(
                CrossAccountMoveBlockedReason::MissingArtifact,
            ))
    }

    async fn attachment_call(
        &self,
        snapshot: &ReplicaSnapshot,
        endpoint: &mut Endpoint<'_>,
        call: AttachmentCall<'_>,
    ) -> Result<AttachmentAnswer, MoveFailure> {
        loop {
            self.check()?;
            let answer = match &call {
                AttachmentCall::Download(id) => endpoint
                    .http
                    .create_attachment_download_grant(
                        endpoint.session.token.as_ref(),
                        id,
                        self.cancellation.clone(),
                    )
                    .await
                    .map(|answer| map_answer(answer, AttachmentAnswer::Download)),
                AttachmentCall::Grant(body) => endpoint
                    .http
                    .create_attachment_upload_grant(
                        endpoint.session.token.as_ref(),
                        &self.record.target.id,
                        body,
                        self.cancellation.clone(),
                    )
                    .await
                    .map(|answer| map_answer(answer, AttachmentAnswer::Grant)),
                AttachmentCall::Register(body) => endpoint
                    .http
                    .create_attachment_metadata(
                        endpoint.session.token.as_ref(),
                        &self.record.target.id,
                        body,
                        self.cancellation.clone(),
                    )
                    .await
                    .map(|answer| map_answer(answer, AttachmentAnswer::Register)),
            }
            .map_err(|_| MoveFailure::Retry)?;
            self.check()?;
            match answer {
                AuthenticatedOutcome::Ok(answer) => return Ok(answer),
                AuthenticatedOutcome::Transient => return Err(MoveFailure::Retry),
                AuthenticatedOutcome::ReauthenticationRequired => {
                    if !endpoint.budget.consume_renewal() {
                        return Err(MoveFailure::Parked);
                    }
                    endpoint.session = self
                        .runtime
                        .renew_session(
                            &snapshot.account_id,
                            &endpoint.session,
                            &endpoint.http,
                            self.cancellation.clone(),
                        )
                        .await
                        .map_err(|_| MoveFailure::Parked)?;
                }
            }
        }
    }

    pub(super) fn verify_target_attachments(
        &self,
        current: Option<&AuthorityItemRecord>,
        complete: bool,
    ) -> Result<Vec<AuthorityAttachmentRecord>, MoveFailure> {
        let Some(current) = current else {
            return Err(target_changed());
        };
        if !same_item_metadata(current, &self.record.target, false) {
            return Err(target_changed());
        }
        let mut additions = Vec::new();
        for attachment in &current.attachments {
            let Some(index) = self
                .record
                .attachments
                .iter()
                .position(|checkpoint| checkpoint.target_attachment_id == attachment.id)
            else {
                return Err(target_changed());
            };
            let registration = self.record.registration(index).ok_or_else(target_changed)?;
            let body: CreateAttachmentBody =
                serde_json::from_slice(&registration.request.body).map_err(|_| missing_proof())?;
            if !attachment_registration_matches(
                attachment,
                &body,
                &self.record.target.id,
                &self.record.target.vault_id,
                &self.record.destination_identity.user_id,
            ) {
                return Err(target_changed());
            }
            if registration.result.is_none() {
                additions.push(attachment.clone());
            }
        }
        for (index, checkpoint) in self.record.attachments.iter().enumerate() {
            let registration = self.record.registration(index);
            let present = current
                .attachments
                .iter()
                .any(|attachment| attachment.id == checkpoint.target_attachment_id);
            if (complete || registration.is_some_and(|registration| registration.result.is_some()))
                && !present
            {
                return Err(target_changed());
            }
            if complete && registration.is_none_or(|registration| registration.result.is_none()) {
                return Err(missing_proof());
            }
        }
        Ok(additions)
    }

    pub(super) async fn drive_attachment(
        &self,
        next_index: u32,
        target_item: Option<&AuthorityItemRecord>,
        source: &mut Endpoint<'_>,
        target: &mut Endpoint<'_>,
    ) -> Result<(CrossAccountMoveRecord, CrossAccountMoveSourceAuthority), MoveFailure> {
        self.verify_target_attachments(target_item, false)?;
        let current_source = self
            .current(self.source, &self.record.source.id, source)
            .await?;
        if !current_source
            .as_ref()
            .is_some_and(|item| same_item(item, &self.record.source, false))
        {
            return Err(MoveFailure::Blocked(
                CrossAccountMoveBlockedReason::SourceChanged,
            ));
        }
        let index = usize::try_from(next_index).map_err(|_| missing_proof())?;
        let checkpoint = self
            .record
            .attachments
            .get(index)
            .ok_or_else(missing_proof)?;
        let mut next = self.record.clone();
        next.disposition = CrossAccountMoveDisposition::Ready;
        if matches!(
            checkpoint.progress,
            CrossAccountMoveAttachmentProgress::Pending
        ) {
            let owner = self.prepare_attachment(checkpoint, source).await?;
            let artifact = attachment_move_artifact_ref(
                owner.account_id(),
                owner.operation_id(),
                owner.attachment_id(),
                owner.ciphertext_sha256(),
                owner.byte_length(),
            )
            .map_err(artifact_failure)?;
            let grant_request = self
                .record
                .attachment_grant_request(index, &artifact)
                .map_err(artifact_failure)?;
            next.attachments[index].progress = CrossAccountMoveAttachmentProgress::Encrypted {
                artifact,
                grant_request,
            };
            return Ok((next, CrossAccountMoveSourceAuthority::Unchanged));
        }
        let present = target_item.and_then(|item| {
            item.attachments
                .iter()
                .find(|attachment| attachment.id == checkpoint.target_attachment_id)
        });
        if let Some(registration) = self.record.registration(index) {
            if let Some(attachment) = present {
                if registration.result.is_none() {
                    set_registration_evidence(
                        &mut next,
                        index,
                        CrossAccountMoveAttachmentEvidence::VerifiedPresent {
                            attachment: Box::new(attachment.clone()),
                        },
                    )?;
                } else {
                    next.stage = if index + 1 == self.record.attachments.len() {
                        CrossAccountMoveStage::SourceTrash
                    } else {
                        CrossAccountMoveStage::Attachments {
                            next_index: next_index + 1,
                        }
                    };
                }
                return Ok((next, CrossAccountMoveSourceAuthority::Unchanged));
            }
            if registration.result.is_some() {
                return Err(target_changed());
            }
        }
        // The bounded current target read above proves this fixed registration is absent.
        let owner = self.attachment_owner(checkpoint)?;
        self.verify_artifact(&owner).await?;
        let grant = self.renew_attachment_grant(index, target).await?;
        let Some(registration) = self.record.registration(index) else {
            next.children
                .push(CrossAccountMoveChild::AttachmentRegistration(
                    self.record
                        .attachment_registration(index, &grant.storage_key)
                        .map_err(artifact_failure)?,
                ));
            return Ok((next, CrossAccountMoveSourceAuthority::Unchanged));
        };
        let body: CreateAttachmentBody =
            serde_json::from_slice(&registration.request.body).map_err(|_| missing_proof())?;
        if body.storage_key != grant.storage_key {
            return Err(target_changed());
        }
        self.upload_attachment(&owner, &grant).await?;
        let response = self
            .attachment_call(self.target, target, AttachmentCall::Register(&body))
            .await;
        if let Ok(AttachmentAnswer::Register(AttachmentMetadataCreateAnswer::Created(created))) =
            &response
        {
            if created.attachment_id != checkpoint.target_attachment_id {
                return Err(missing_proof());
            }
            set_registration_evidence(
                &mut next,
                index,
                CrossAccountMoveAttachmentEvidence::Acknowledged {
                    attachment_id: created.attachment_id.clone(),
                },
            )?;
            // Preserve the observed acknowledgment before any subsequent authority read.
            return Ok((next, CrossAccountMoveSourceAuthority::Unchanged));
        }
        let current = self
            .current(self.target, &self.record.target.id, target)
            .await?;
        let additions = self.verify_target_attachments(current.as_ref(), false)?;
        if let Some(attachment) = additions
            .into_iter()
            .find(|attachment| attachment.id == checkpoint.target_attachment_id)
        {
            set_registration_evidence(
                &mut next,
                index,
                CrossAccountMoveAttachmentEvidence::VerifiedPresent {
                    attachment: Box::new(attachment),
                },
            )?;
            return Ok((next, CrossAccountMoveSourceAuthority::Unchanged));
        }
        match response {
            Ok(AttachmentAnswer::Register(AttachmentMetadataCreateAnswer::AccessDenied)) => Err(
                MoveFailure::Waiting(CrossAccountMoveWaitingReason::AttachmentAccessDenied),
            ),
            Ok(AttachmentAnswer::Register(AttachmentMetadataCreateAnswer::QuotaRejected)) => Err(
                MoveFailure::Waiting(CrossAccountMoveWaitingReason::AttachmentQuotaExceeded),
            ),
            Ok(AttachmentAnswer::Register(AttachmentMetadataCreateAnswer::Conflict {
                retryable: false,
            })) => Err(missing_proof()),
            Err(MoveFailure::Parked) => Err(MoveFailure::Parked),
            _ => {
                self.renew_attachment_grant(index, target).await?;
                Err(MoveFailure::Retry)
            }
        }
    }

    fn attachment_owner(
        &self,
        checkpoint: &CrossAccountMoveAttachmentCheckpoint,
    ) -> Result<AttachmentArtifactOwner, MoveFailure> {
        let CrossAccountMoveAttachmentProgress::Encrypted { artifact, .. } = &checkpoint.progress
        else {
            return Err(MoveFailure::Blocked(
                CrossAccountMoveBlockedReason::MissingArtifact,
            ));
        };
        let owner = AttachmentArtifactOwner::new(
            self.source.account_id.clone(),
            self.record.operation_id.clone(),
            checkpoint.target_attachment_id.clone(),
            artifact.clone(),
        )
        .map_err(artifact_failure)?;
        self.check_attachment_owner(checkpoint, owner)
    }

    async fn prepare_attachment(
        &self,
        checkpoint: &CrossAccountMoveAttachmentCheckpoint,
        source: &mut Endpoint<'_>,
    ) -> Result<AttachmentArtifactOwner, MoveFailure> {
        let facade = self.attachment_facade()?;
        let store = facade.provisional_artifacts();
        let scope = ProvisionalAttachmentArtifactScope::new(
            self.source.account_id.clone(),
            self.record.operation_id.clone(),
            checkpoint.target_attachment_id.clone(),
        )
        .map_err(artifact_failure)?;
        let recovered = store
            .invoke_provisional(ProvisionalAttachmentArtifactStoreRequest::Recover {
                scope: scope.clone(),
            })
            .await
            .map_err(artifact_failure)?;
        self.check()?;
        let begun = match recovered {
            ProvisionalAttachmentArtifactStoreResponse::RecoveryAvailable(recovery) => {
                let response = store
                    .invoke_provisional(
                        ProvisionalAttachmentArtifactStoreRequest::ResumeRecovered { recovery },
                    )
                    .await
                    .map_err(artifact_failure)?;
                self.check()?;
                let ProvisionalAttachmentArtifactStoreResponse::Finalized(owner) = response else {
                    return Err(missing_artifact());
                };
                return self.check_attachment_owner(checkpoint, owner);
            }
            ProvisionalAttachmentArtifactStoreResponse::RecoveryUnavailable => store
                .invoke_provisional(ProvisionalAttachmentArtifactStoreRequest::Begin {
                    writer: ProvisionalAttachmentArtifactWriter::new(scope),
                })
                .await
                .map_err(artifact_failure)?,
            _ => return Err(missing_artifact()),
        };
        let ProvisionalAttachmentArtifactStoreResponse::Begun(writer) = begun else {
            return Err(missing_artifact());
        };
        self.check()?;
        let attachment = self
            .record
            .source
            .attachments
            .iter()
            .find(|attachment| attachment.id == checkpoint.source_attachment_id)
            .ok_or_else(missing_artifact)?;
        let mut download = CrossSource {
            attempt: self,
            endpoint: source,
            source: attachment,
        };
        let scan = scan_source(&mut download)
            .await
            .map_err(transcryption_failure)?;
        // Keep the ordinary two-pass contract: resolve secret material only after the scan.
        self.check()?;
        let source_vault_key =
            self.attachment_vault_key(self.source, &self.record.source.vault_id)?;
        let target_vault_key =
            self.attachment_vault_key(self.target, &self.record.target.vault_id)?;
        let source_key =
            super::super::attachment_crypto::source_key(attachment, &source_vault_key[..])
                .map_err(artifact_failure)?;
        let target_key = super::super::attachment_crypto::target_key(
            checkpoint,
            &self.record.target.vault_id,
            &self.record.destination_identity.user_id,
            &target_vault_key[..],
        )
        .map_err(artifact_failure)?;
        let identity = AttachmentPublicationIdentity::new(
            self.source.account_id.as_str().into(),
            self.record.destination_identity.user_id.clone(),
            self.record.operation_id.clone(),
            checkpoint.target_attachment_id.clone(),
        )
        .map_err(|_| missing_artifact())?;
        let material = TranscryptionMaterial {
            source_key,
            target_key,
            source_scope: AttachmentBlobScope::new(
                self.record.source.vault_id.clone(),
                attachment.id.clone(),
                attachment.uploaded_by.clone(),
            ),
            target_scope: AttachmentBlobScope::new(
                self.record.target.vault_id.clone(),
                checkpoint.target_attachment_id.clone(),
                self.record.destination_identity.user_id.clone(),
            ),
            identity,
        };
        let owner = transcrypt_source(&mut download, scan, material, writer, store.as_ref())
            .await
            .map_err(transcryption_failure)?;
        self.check()?;
        self.check_attachment_owner(checkpoint, owner)
    }

    fn check_attachment_owner(
        &self,
        checkpoint: &CrossAccountMoveAttachmentCheckpoint,
        owner: AttachmentArtifactOwner,
    ) -> Result<AttachmentArtifactOwner, MoveFailure> {
        let source = self
            .record
            .source
            .attachments
            .iter()
            .find(|attachment| attachment.id == checkpoint.source_attachment_id)
            .ok_or_else(missing_artifact)?;
        let expected_bytes =
            source_response_bound(source.file_size).map_err(|_| missing_artifact())?;
        if owner.account_id() != &self.source.account_id
            || owner.operation_id() != self.record.operation_id
            || owner.attachment_id() != checkpoint.target_attachment_id
            || owner.byte_length() != expected_bytes
        {
            return Err(missing_artifact());
        }
        Ok(owner)
    }

    fn attachment_vault_key(
        &self,
        snapshot: &ReplicaSnapshot,
        vault_id: &str,
    ) -> Result<Zeroizing<Vec<u8>>, MoveFailure> {
        let vault = self
            .runtime
            .require_cross_move_scope(snapshot, vault_id)
            .map_err(|_| MoveFailure::Parked)?;
        let material = self
            .runtime
            .copy_live_vault_key_material(&snapshot.account_id, &snapshot.incarnation)
            .ok_or(MoveFailure::Parked)?;
        unwrap_vault_key(&vault, &snapshot.user_id, &material)
            .map(Zeroizing::new)
            .map_err(|_| MoveFailure::Parked)
    }

    async fn renew_attachment_grant(
        &self,
        index: usize,
        target: &mut Endpoint<'_>,
    ) -> Result<AttachmentMoveUploadGrant, MoveFailure> {
        let checkpoint = &self.record.attachments[index];
        let CrossAccountMoveAttachmentProgress::Encrypted { grant_request, .. } =
            &checkpoint.progress
        else {
            return Err(missing_artifact());
        };
        let body: AttachmentUploadBody =
            serde_json::from_slice(&grant_request.body).map_err(|_| missing_artifact())?;
        let answer = self
            .attachment_call(self.target, target, AttachmentCall::Grant(&body))
            .await?;
        let grant = match answer {
            AttachmentAnswer::Grant(AttachmentUploadGrantAnswer::Grant(grant)) => grant,
            AttachmentAnswer::Grant(AttachmentUploadGrantAnswer::AccessDenied) => {
                return Err(MoveFailure::Waiting(
                    CrossAccountMoveWaitingReason::AttachmentAccessDenied,
                ));
            }
            AttachmentAnswer::Grant(AttachmentUploadGrantAnswer::QuotaRejected) => {
                return Err(MoveFailure::Waiting(
                    CrossAccountMoveWaitingReason::AttachmentQuotaExceeded,
                ));
            }
            AttachmentAnswer::Grant(AttachmentUploadGrantAnswer::SizeRejected) => {
                return Err(MoveFailure::Waiting(
                    CrossAccountMoveWaitingReason::AttachmentSizeRejected,
                ));
            }
            AttachmentAnswer::Grant(AttachmentUploadGrantAnswer::Conflict { retryable: true }) => {
                return Err(MoveFailure::Retry);
            }
            AttachmentAnswer::Grant(AttachmentUploadGrantAnswer::Conflict { retryable: false }) => {
                return Err(missing_proof());
            }
            _ => return Err(missing_proof()),
        };
        let url = url::Url::parse(&grant.upload_url).map_err(|_| missing_proof())?;
        if grant.attachment_id != checkpoint.target_attachment_id
            || grant.key.is_empty()
            || !matches!(url.scheme(), "http" | "https")
        {
            return Err(missing_proof());
        }
        let headers = grant
            .upload_headers
            .ok_or_else(missing_proof)?
            .into_iter()
            .map(|header| (header.name, header.value))
            .collect();
        let grant = AttachmentMoveUploadGrant {
            attachment_id: grant.attachment_id,
            storage_key: grant.key,
            upload_url: grant.upload_url,
            headers,
        };
        grant
            .validated_headers(&self.attachment_owner(checkpoint)?)
            .map_err(|_| missing_proof())?;
        Ok(grant)
    }

    pub(super) async fn verify_artifacts(&self) -> Result<(), MoveFailure> {
        for checkpoint in &self.record.attachments {
            match &checkpoint.progress {
                CrossAccountMoveAttachmentProgress::Encrypted { .. } => {
                    self.verify_artifact(&self.attachment_owner(checkpoint)?)
                        .await?
                }
                CrossAccountMoveAttachmentProgress::Pending => {
                    let scope = ProvisionalAttachmentArtifactScope::new(
                        self.source.account_id.clone(),
                        self.record.operation_id.clone(),
                        checkpoint.target_attachment_id.clone(),
                    )
                    .map_err(artifact_failure)?;
                    let response = self
                        .attachment_facade()?
                        .provisional_artifacts()
                        .invoke_provisional(ProvisionalAttachmentArtifactStoreRequest::Recover {
                            scope,
                        })
                        .await
                        .map_err(artifact_failure)?;
                    match response {
                        ProvisionalAttachmentArtifactStoreResponse::RecoveryAvailable(_)
                        | ProvisionalAttachmentArtifactStoreResponse::RecoveryUnavailable => {}
                        _ => return Err(missing_artifact()),
                    }
                    self.check()?;
                }
            }
        }
        Ok(())
    }

    async fn verify_artifact(&self, owner: &AttachmentArtifactOwner) -> Result<(), MoveFailure> {
        let store = self.attachment_facade()?.artifacts();
        let mut hash = Sha256::new();
        let mut bytes = 0_u64;
        let mut index = 0_u32;
        loop {
            let AttachmentArtifactStoreResponse::ChunkRead(chunk) = store
                .invoke(AttachmentArtifactStoreRequest::ReadChunk {
                    owner: owner.clone(),
                    chunk_index: index,
                })
                .await
                .map_err(artifact_failure)?
            else {
                return Err(missing_artifact());
            };
            self.check()?;
            bytes = bytes
                .checked_add(chunk.bytes.len() as u64)
                .ok_or_else(missing_artifact)?;
            if bytes > owner.byte_length()
                || chunk.bytes.len() > crate::ARTIFACT_CHUNK_BYTES
                || (!chunk.is_last && chunk.bytes.is_empty())
            {
                return Err(missing_artifact());
            }
            hash.update(&chunk.bytes);
            if chunk.is_last {
                break;
            }
            index = index.checked_add(1).ok_or_else(missing_artifact)?;
        }
        if bytes != owner.byte_length()
            || format!("{:x}", hash.finalize()) != owner.ciphertext_sha256()
        {
            return Err(missing_artifact());
        }
        Ok(())
    }

    async fn upload_attachment(
        &self,
        owner: &AttachmentArtifactOwner,
        grant: &AttachmentMoveUploadGrant,
    ) -> Result<(), MoveFailure> {
        let facade = self.attachment_facade()?;
        self.check()?;
        let mut upload = facade
            .transfer()
            .open_upload(
                &self.source.account_id,
                &self.record.operation_id,
                grant,
                owner,
            )
            .await
            .map_err(|error| transport_failure(transfer_error(error)))?;
        let mut index = 0_u32;
        loop {
            let AttachmentArtifactStoreResponse::ChunkRead(chunk) = facade
                .artifacts()
                .invoke(AttachmentArtifactStoreRequest::ReadChunk {
                    owner: owner.clone(),
                    chunk_index: index,
                })
                .await
                .map_err(artifact_failure)?
            else {
                return Err(missing_artifact());
            };
            self.check()?;
            upload
                .write_chunk(&chunk.bytes)
                .await
                .map_err(|error| transport_failure(transfer_error(error)))?;
            self.check()?;
            if chunk.is_last {
                break;
            }
            index = index.checked_add(1).ok_or_else(missing_artifact)?;
        }
        upload
            .finish()
            .await
            .map_err(|error| transport_failure(transfer_error(error)))?;
        self.check()
    }
}

struct CrossSource<'a, 'b, 'c> {
    attempt: &'a Attempt<'b>,
    endpoint: &'a mut Endpoint<'c>,
    source: &'a AuthorityAttachmentRecord,
}

#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
impl SourceOpen for CrossSource<'_, '_, '_> {
    type Error = MoveFailure;
    async fn open(&mut self, _pass: DownloadPass) -> Result<Box<dyn SourceDownload>, Self::Error> {
        let answer = self
            .attempt
            .attachment_call(
                self.attempt.source,
                self.endpoint,
                AttachmentCall::Download(&self.source.id),
            )
            .await?;
        let grant = match answer {
            AttachmentAnswer::Download(AttachmentDownloadGrantAnswer::Grant(grant)) => *grant,
            AttachmentAnswer::Download(AttachmentDownloadGrantAnswer::AccessDenied) => {
                return Err(MoveFailure::Waiting(
                    CrossAccountMoveWaitingReason::AttachmentAccessDenied,
                ));
            }
            AttachmentAnswer::Download(AttachmentDownloadGrantAnswer::StaleAuthority) => {
                return Err(MoveFailure::Blocked(
                    CrossAccountMoveBlockedReason::SourceChanged,
                ));
            }
            _ => return Err(missing_proof()),
        };
        let grant = validate_source_grant(grant, self.source).map_err(transport_failure)?;
        let download = self
            .attempt
            .attachment_facade()?
            .transfer()
            .open_source(AttachmentMoveDownloadRequest {
                download_url: grant.download_url,
                headers: Vec::new(),
                max_response_bytes: source_response_bound(self.source.file_size)
                    .map_err(transport_failure)?,
                max_chunk_bytes: crate::ARTIFACT_CHUNK_BYTES as u32,
            })
            .await
            .map_err(|error| transport_failure(transfer_error(error)))?;
        self.attempt.check()?;
        Ok(Box::new(DownloadAdapter(download)))
    }
}

fn set_registration_evidence(
    record: &mut CrossAccountMoveRecord,
    index: usize,
    evidence: CrossAccountMoveAttachmentEvidence,
) -> Result<(), MoveFailure> {
    let Some(CrossAccountMoveChild::AttachmentRegistration(registration)) =
        record.children.get_mut(index + 1)
    else {
        return Err(missing_proof());
    };
    if registration.result.is_some() {
        return Err(missing_proof());
    }
    registration.result = Some(evidence);
    Ok(())
}

fn missing_proof() -> MoveFailure {
    MoveFailure::Blocked(CrossAccountMoveBlockedReason::MissingProof)
}
fn missing_artifact() -> MoveFailure {
    MoveFailure::Blocked(CrossAccountMoveBlockedReason::MissingArtifact)
}
fn target_changed() -> MoveFailure {
    MoveFailure::Blocked(CrossAccountMoveBlockedReason::TargetChanged)
}
fn artifact_failure(error: RuntimeError) -> MoveFailure {
    if error.code == RuntimeErrorCode::StorageUnavailable {
        MoveFailure::Retry
    } else {
        missing_artifact()
    }
}
fn transport_failure(error: PreparationTransportError) -> MoveFailure {
    match error {
        PreparationTransportError::Transient | PreparationTransportError::Busy => {
            MoveFailure::Retry
        }
        PreparationTransportError::StaleAuthority => {
            MoveFailure::Blocked(CrossAccountMoveBlockedReason::SourceChanged)
        }
        PreparationTransportError::Invariant => missing_artifact(),
    }
}
fn transcryption_failure(error: TranscryptionError<MoveFailure>) -> MoveFailure {
    match error {
        TranscryptionError::Source(error) => error,
        TranscryptionError::Transport(error) => transport_failure(error),
        TranscryptionError::Artifact(error) => artifact_failure(error),
        TranscryptionError::InvalidInput | TranscryptionError::Invariant => missing_artifact(),
    }
}
