//! Account-scoped scheduling for durable Attachment Move preparation.
//!
//! The scheduler is the only Runtime owner allowed to drive C2. Platform composition supplies
//! primitive ports; it never receives the worker itself or chooses which accepted work to run.

use super::{
    attachment_move_preparation::{
        AttachmentMovePreparationWorker, AttachmentMoveSecretProvider, AttachmentMoveSecrets,
        AttachmentMoveTransfer, Manifest, ManifestRequest, PreparationDriveRequest,
        PreparationDriveResult, PreparationTransportError, SourceDownload, SourceDownloadRequest,
        StagingUpload, UploadGrant,
    },
    LiveMasterUnlockKey,
};
use crate::{
    attachment_artifact_store::{
        AttachmentArtifactOwner, AttachmentArtifactStore, ProvisionalAttachmentArtifactStore,
    },
    auth_http::{
        AttachmentDownloadGrant, AttachmentDownloadGrantAnswer, AttachmentMoveManifestAnswer,
        AttachmentMoveManifestHttpEntry, AttachmentMoveManifestHttpRequest, AuthHttpClient,
        AuthenticatedOutcome,
    },
    replica::{
        AttachmentMovePreparationRecord, AuthorityAttachmentRecord, AuthorityVaultRecord,
        PreparedMoveAttachment, Replica,
    },
    AccountId, RuntimeError, RuntimeErrorCode,
};
use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use bittery_crypto_core::{
    decrypt_vault_key_with_muk, decrypt_with_aad, encrypt_with_aad, AadContext, EncryptedData,
    WrappedVaultKeyData,
};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, Weak},
};
use zeroize::{Zeroize, Zeroizing};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttachmentMoveDownloadPass {
    Scan,
    Transcrypt,
}

#[derive(Clone, PartialEq, Eq)]
pub struct AttachmentMoveDownloadRequest {
    /// Invocation-scoped capability. Implementations must not persist or log it.
    pub download_url: String,
    /// Invocation-scoped signed headers. The current Server route returns none.
    pub headers: Vec<(String, String)>,
    pub max_response_bytes: u64,
    pub max_chunk_bytes: u32,
}

#[derive(Clone, PartialEq, Eq)]
pub struct AttachmentMoveUploadGrant {
    pub attachment_id: String,
    pub storage_key: String,
    /// Invocation-scoped authority. Implementations must not persist or log it.
    pub upload_url: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttachmentMoveTransferError {
    Transient,
    Busy,
    StaleAuthority,
    Invariant,
}

#[cfg(not(target_arch = "wasm32"))]
#[async_trait]
pub trait AttachmentMoveDownload: Send {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, AttachmentMoveTransferError>;
}

#[cfg(target_arch = "wasm32")]
#[async_trait(?Send)]
pub trait AttachmentMoveDownload {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, AttachmentMoveTransferError>;
}

#[cfg(not(target_arch = "wasm32"))]
#[async_trait]
pub trait AttachmentMoveUpload: Send {
    async fn write_chunk(&mut self, bytes: &[u8]) -> Result<(), AttachmentMoveTransferError>;
    async fn finish(self: Box<Self>) -> Result<(), AttachmentMoveTransferError>;
}

#[cfg(target_arch = "wasm32")]
#[async_trait(?Send)]
pub trait AttachmentMoveUpload {
    async fn write_chunk(&mut self, bytes: &[u8]) -> Result<(), AttachmentMoveTransferError>;
    async fn finish(self: Box<Self>) -> Result<(), AttachmentMoveTransferError>;
}

#[cfg(not(target_arch = "wasm32"))]
#[async_trait]
pub trait AttachmentMoveTransferPort: Send + Sync {
    async fn open_source(
        &self,
        request: AttachmentMoveDownloadRequest,
    ) -> Result<Box<dyn AttachmentMoveDownload>, AttachmentMoveTransferError>;
    async fn open_upload(
        &self,
        account_id: &AccountId,
        operation_id: &str,
        grant: &AttachmentMoveUploadGrant,
        owner: &AttachmentArtifactOwner,
    ) -> Result<Box<dyn AttachmentMoveUpload>, AttachmentMoveTransferError>;
}

#[cfg(target_arch = "wasm32")]
#[async_trait(?Send)]
pub trait AttachmentMoveTransferPort {
    async fn open_source(
        &self,
        request: AttachmentMoveDownloadRequest,
    ) -> Result<Box<dyn AttachmentMoveDownload>, AttachmentMoveTransferError>;
    async fn open_upload(
        &self,
        account_id: &AccountId,
        operation_id: &str,
        grant: &AttachmentMoveUploadGrant,
        owner: &AttachmentArtifactOwner,
    ) -> Result<Box<dyn AttachmentMoveUpload>, AttachmentMoveTransferError>;
}

#[derive(Clone)]
pub struct AttachmentMovePreparationFacade {
    provisional_artifacts: Arc<dyn ProvisionalAttachmentArtifactStore>,
    artifacts: Arc<dyn AttachmentArtifactStore>,
    transfer: Arc<dyn AttachmentMoveTransferPort>,
}

impl AttachmentMovePreparationFacade {
    pub fn new(
        provisional_artifacts: Arc<dyn ProvisionalAttachmentArtifactStore>,
        artifacts: Arc<dyn AttachmentArtifactStore>,
        transfer: Arc<dyn AttachmentMoveTransferPort>,
    ) -> Self {
        Self {
            provisional_artifacts,
            artifacts,
            transfer,
        }
    }

    #[allow(
        dead_code,
        reason = "Ticket 46 Slice C composes the exclusive lifecycle"
    )]
    pub(crate) fn provisional_artifacts(&self) -> Arc<dyn ProvisionalAttachmentArtifactStore> {
        Arc::clone(&self.provisional_artifacts)
    }

    #[allow(
        dead_code,
        reason = "Ticket 46 Slice C composes the exclusive lifecycle"
    )]
    pub(crate) fn artifacts(&self) -> Arc<dyn AttachmentArtifactStore> {
        Arc::clone(&self.artifacts)
    }

    #[allow(
        dead_code,
        reason = "Ticket 46 Slice C composes the exclusive lifecycle"
    )]
    pub(crate) fn transfer(&self) -> Arc<dyn AttachmentMoveTransferPort> {
        Arc::clone(&self.transfer)
    }
}

fn transfer_error(error: AttachmentMoveTransferError) -> PreparationTransportError {
    match error {
        AttachmentMoveTransferError::Transient => PreparationTransportError::Transient,
        AttachmentMoveTransferError::Busy => PreparationTransportError::Busy,
        AttachmentMoveTransferError::StaleAuthority => PreparationTransportError::StaleAuthority,
        AttachmentMoveTransferError::Invariant => PreparationTransportError::Invariant,
    }
}

pub(crate) struct TransferAdapter {
    binary: Arc<dyn AttachmentMoveTransferPort>,
    runtime: Weak<super::Runtime>,
}
struct DownloadAdapter(Box<dyn AttachmentMoveDownload>);
struct UploadAdapter(Box<dyn AttachmentMoveUpload>);

impl TransferAdapter {
    pub(crate) fn new(
        binary: Arc<dyn AttachmentMoveTransferPort>,
        runtime: Weak<super::Runtime>,
    ) -> Self {
        Self { binary, runtime }
    }

    fn manifest_answer(
        answer: AttachmentMoveManifestAnswer,
    ) -> Result<Manifest, PreparationTransportError> {
        match answer {
            AttachmentMoveManifestAnswer::Prepared(manifest) => Ok(Manifest {
                operation_id: manifest.operation_id,
                uploads: manifest
                    .attachments
                    .into_iter()
                    .map(|grant| UploadGrant {
                        attachment_id: grant.attachment_id,
                        storage_key: grant.storage_key,
                        upload_url: grant.upload_url,
                    })
                    .collect(),
            }),
            AttachmentMoveManifestAnswer::Busy => Err(PreparationTransportError::Busy),
            AttachmentMoveManifestAnswer::StaleAuthority => {
                Err(PreparationTransportError::StaleAuthority)
            }
        }
    }

    fn source_grant_answer(
        answer: AttachmentDownloadGrantAnswer,
        source: &AuthorityAttachmentRecord,
    ) -> Result<AttachmentDownloadGrant, PreparationTransportError> {
        let grant = match answer {
            AttachmentDownloadGrantAnswer::Grant(grant) => *grant,
            AttachmentDownloadGrantAnswer::StaleAuthority => {
                return Err(PreparationTransportError::StaleAuthority);
            }
        };
        if grant.attachment_id != source.id
            || grant.item_id != source.item_id
            || grant.vault_id != source.vault_id
            || grant.storage_key != source.storage_key
            || grant.envelope_version != source.envelope_version
            || grant.uploaded_by != source.uploaded_by
            || grant.encrypted_name != source.encrypted_name
            || grant.encrypted_content_type != source.encrypted_content_type
            || grant.encryption_iv != source.encryption_iv
            || grant.encrypted_content_type_iv != source.encrypted_content_type_iv
            || grant.encryption_algorithm != source.encryption_algorithm
            || grant.file_size != source.file_size
        {
            return Err(PreparationTransportError::StaleAuthority);
        }
        let invocation_url = url::Url::parse(&grant.download_url)
            .map_err(|_| PreparationTransportError::Invariant)?;
        if !matches!(invocation_url.scheme(), "http" | "https") {
            return Err(PreparationTransportError::Invariant);
        }
        Ok(grant)
    }

    fn source_response_bound(file_size: i32) -> Result<u64, PreparationTransportError> {
        let plaintext_bytes =
            u64::try_from(file_size).map_err(|_| PreparationTransportError::Invariant)?;
        let encoded_plaintext_bytes = base64_encoded_length(plaintext_bytes)?;
        let ciphertext_bytes = encoded_plaintext_bytes
            .checked_add(16)
            .ok_or(PreparationTransportError::Invariant)?;
        let encoded_ciphertext_bytes = base64_encoded_length(ciphertext_bytes)?;
        let fixed_envelope_bytes = (r#"{"ciphertext":""#.len()
            + r#"","iv":""#.len()
            + 16
            + r#"","algorithm":"AES-GCM-AAD-V1"}"#.len()) as u64;
        encoded_ciphertext_bytes
            .checked_add(fixed_envelope_bytes)
            .ok_or(PreparationTransportError::Invariant)
    }
}

fn base64_encoded_length(byte_length: u64) -> Result<u64, PreparationTransportError> {
    byte_length
        .checked_add(2)
        .and_then(|bytes| bytes.checked_div(3))
        .and_then(|groups| groups.checked_mul(4))
        .ok_or(PreparationTransportError::Invariant)
}

#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
impl SourceDownload for DownloadAdapter {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, PreparationTransportError> {
        self.0.next_chunk().await.map_err(transfer_error)
    }
}

#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
impl StagingUpload for UploadAdapter {
    async fn write_chunk(&mut self, bytes: &[u8]) -> Result<(), PreparationTransportError> {
        self.0.write_chunk(bytes).await.map_err(transfer_error)
    }

    async fn finish(self: Box<Self>) -> Result<(), PreparationTransportError> {
        self.0.finish().await.map_err(transfer_error)
    }
}

#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
impl AttachmentMoveTransfer for TransferAdapter {
    async fn open_source(
        &self,
        request: SourceDownloadRequest,
    ) -> Result<Box<dyn SourceDownload>, PreparationTransportError> {
        let runtime = self
            .runtime
            .upgrade()
            .ok_or(PreparationTransportError::Transient)?;
        let snapshot = runtime
            .replica
            .snapshot(&request.account_id)
            .ok_or(PreparationTransportError::Invariant)?;
        let mut preparations = snapshot
            .attachment_move_preparations
            .iter()
            .filter(|preparation| preparation.operation_id == request.operation_id);
        let preparation = preparations
            .next()
            .ok_or(PreparationTransportError::Invariant)?;
        if preparations.next().is_some() || preparation.account_id != request.account_id {
            return Err(PreparationTransportError::Invariant);
        }
        let mut sources = preparation
            .source_attachments
            .iter()
            .filter(|source| source.id == request.attachment_id);
        let source = sources.next().ok_or(PreparationTransportError::Invariant)?;
        if sources.next().is_some()
            || source.item_id != preparation.item_id
            || source.vault_id != preparation.source_vault_id
            || source.storage_key != request.storage_key
        {
            return Err(PreparationTransportError::Invariant);
        }
        let max_response_bytes = Self::source_response_bound(source.file_size)?;
        let metadata = runtime
            .platform_storage
            .load_account_metadata(&request.account_id, &snapshot.incarnation)
            .await
            .map_err(source_grant_http_error)?
            .ok_or(PreparationTransportError::Transient)?;
        if metadata.user_id != snapshot.user_id {
            return Err(PreparationTransportError::Invariant);
        }
        let session = runtime
            .platform_storage
            .load_current_session(&request.account_id, &snapshot.incarnation)
            .await
            .map_err(source_grant_http_error)?
            .ok_or(PreparationTransportError::Transient)?;
        let auth_config = runtime
            .auth_client_config
            .clone()
            .ok_or(PreparationTransportError::Transient)?;
        let http = AuthHttpClient::new(
            &runtime.http_transport,
            &metadata.normalized_server_url,
            metadata.insecure_transport_confirmed,
            auth_config,
        )
        .map_err(|_| PreparationTransportError::Invariant)?;
        let first = http
            .create_attachment_download_grant(
                session.token.as_ref(),
                &source.id,
                crate::RequestCancellation::new(),
            )
            .await
            .map_err(source_grant_http_error)?;
        let grant = match first {
            AuthenticatedOutcome::Ok(answer) => Self::source_grant_answer(answer, source)?,
            AuthenticatedOutcome::Transient => return Err(PreparationTransportError::Transient),
            AuthenticatedOutcome::ReauthenticationRequired => {
                let renewed = runtime
                    .renew_session(
                        &request.account_id,
                        &session,
                        &http,
                        crate::RequestCancellation::new(),
                    )
                    .await
                    .map_err(source_grant_http_error)?;
                match http
                    .create_attachment_download_grant(
                        renewed.token.as_ref(),
                        &source.id,
                        crate::RequestCancellation::new(),
                    )
                    .await
                    .map_err(source_grant_http_error)?
                {
                    AuthenticatedOutcome::Ok(answer) => Self::source_grant_answer(answer, source)?,
                    AuthenticatedOutcome::ReauthenticationRequired
                    | AuthenticatedOutcome::Transient => {
                        return Err(PreparationTransportError::Transient);
                    }
                }
            }
        };
        self.binary
            .open_source(AttachmentMoveDownloadRequest {
                download_url: grant.download_url,
                headers: Vec::new(),
                max_response_bytes,
                max_chunk_bytes:
                    bittery_crypto_core::attachment_move::MAX_ATTACHMENT_ENVELOPE_INPUT_CHUNK
                        as u32,
            })
            .await
            .map(|download| Box::new(DownloadAdapter(download)) as Box<dyn SourceDownload>)
            .map_err(transfer_error)
    }

    async fn renew_manifest(
        &self,
        request: ManifestRequest,
    ) -> Result<Manifest, PreparationTransportError> {
        let runtime = self
            .runtime
            .upgrade()
            .ok_or(PreparationTransportError::Transient)?;
        let snapshot = runtime
            .replica
            .snapshot(&request.account_id)
            .ok_or(PreparationTransportError::Invariant)?;
        let metadata = runtime
            .platform_storage
            .load_account_metadata(&request.account_id, &snapshot.incarnation)
            .await
            .map_err(|_| PreparationTransportError::Transient)?
            .ok_or(PreparationTransportError::Transient)?;
        if metadata.user_id != snapshot.user_id {
            return Err(PreparationTransportError::Invariant);
        }
        let session = runtime
            .platform_storage
            .load_current_session(&request.account_id, &snapshot.incarnation)
            .await
            .map_err(|_| PreparationTransportError::Transient)?
            .ok_or(PreparationTransportError::Transient)?;
        let auth_config = runtime
            .auth_client_config
            .clone()
            .ok_or(PreparationTransportError::Transient)?;
        let http = AuthHttpClient::new(
            &runtime.http_transport,
            &metadata.normalized_server_url,
            metadata.insecure_transport_confirmed,
            auth_config,
        )
        .map_err(|_| PreparationTransportError::Invariant)?;
        let operation_id = request.operation_id;
        let wire_request = AttachmentMoveManifestHttpRequest {
            item_id: request.item_id,
            source_vault_id: request.source_vault_id,
            target_vault_id: request.target_vault_id,
            attachments: request
                .attachments
                .into_iter()
                .map(|entry| AttachmentMoveManifestHttpEntry {
                    attachment_id: entry.attachment_id,
                    envelope_version: entry.envelope_version,
                    ciphertext_sha256: entry.ciphertext_sha256,
                })
                .collect(),
        };
        let first = http
            .renew_attachment_move_manifest(
                session.token.as_ref(),
                &operation_id,
                &wire_request,
                crate::RequestCancellation::new(),
            )
            .await
            .map_err(|error| match error.code {
                RuntimeErrorCode::AuthenticationUnavailable
                | RuntimeErrorCode::InvariantViolation => PreparationTransportError::Invariant,
                _ => PreparationTransportError::Transient,
            })?;
        match first {
            AuthenticatedOutcome::Ok(answer) => Self::manifest_answer(answer),
            AuthenticatedOutcome::Transient => Err(PreparationTransportError::Transient),
            AuthenticatedOutcome::ReauthenticationRequired => {
                let renewed = runtime
                    .renew_session(
                        &request.account_id,
                        &session,
                        &http,
                        crate::RequestCancellation::new(),
                    )
                    .await
                    .map_err(|_| PreparationTransportError::Transient)?;
                match http
                    .renew_attachment_move_manifest(
                        renewed.token.as_ref(),
                        &operation_id,
                        &wire_request,
                        crate::RequestCancellation::new(),
                    )
                    .await
                    .map_err(|error| match error.code {
                        RuntimeErrorCode::AuthenticationUnavailable
                        | RuntimeErrorCode::InvariantViolation => {
                            PreparationTransportError::Invariant
                        }
                        _ => PreparationTransportError::Transient,
                    })? {
                    AuthenticatedOutcome::Ok(answer) => Self::manifest_answer(answer),
                    AuthenticatedOutcome::ReauthenticationRequired
                    | AuthenticatedOutcome::Transient => Err(PreparationTransportError::Transient),
                }
            }
        }
    }

    async fn open_upload(
        &self,
        account_id: &AccountId,
        operation_id: &str,
        grant: &UploadGrant,
        owner: &AttachmentArtifactOwner,
    ) -> Result<Box<dyn StagingUpload>, PreparationTransportError> {
        self.binary
            .open_upload(
                account_id,
                operation_id,
                &AttachmentMoveUploadGrant {
                    attachment_id: grant.attachment_id.clone(),
                    storage_key: grant.storage_key.clone(),
                    upload_url: grant.upload_url.clone(),
                },
                owner,
            )
            .await
            .map(|upload| Box::new(UploadAdapter(upload)) as Box<dyn StagingUpload>)
            .map_err(transfer_error)
    }
}

fn source_grant_http_error(error: RuntimeError) -> PreparationTransportError {
    match error.code {
        RuntimeErrorCode::AuthenticationUnavailable | RuntimeErrorCode::InvariantViolation => {
            PreparationTransportError::Invariant
        }
        _ => PreparationTransportError::Transient,
    }
}

pub(crate) struct RuntimeAttachmentMoveSecrets {
    replica: Arc<Replica>,
    live_master_unlock_keys:
        Arc<Mutex<HashMap<(AccountId, crate::protocol::Incarnation), LiveMasterUnlockKey>>>,
}

impl RuntimeAttachmentMoveSecrets {
    pub(crate) fn new(
        replica: Arc<Replica>,
        live_master_unlock_keys: Arc<
            Mutex<HashMap<(AccountId, crate::protocol::Incarnation), LiveMasterUnlockKey>>,
        >,
    ) -> Self {
        Self {
            replica,
            live_master_unlock_keys,
        }
    }

    fn resolve_material(
        &self,
        preparation: &AttachmentMovePreparationRecord,
        source: &AuthorityAttachmentRecord,
    ) -> Result<AttachmentMoveSecrets, RuntimeError> {
        let snapshot = self
            .replica
            .snapshot(&preparation.account_id)
            .ok_or_else(|| invariant("Attachment Move Account is not installed"))?;
        if source.item_id != preparation.item_id
            || source.vault_id != preparation.source_vault_id
            || !preparation
                .source_attachments
                .iter()
                .any(|candidate| candidate == source)
        {
            return Err(invariant("Attachment Move source authority is foreign"));
        }
        let target_envelope_version = source
            .envelope_version
            .checked_add(1)
            .ok_or_else(|| invariant("Attachment Move target envelope version overflowed"))?;
        let generation = snapshot
            .bootstrap
            .active_generation
            .as_ref()
            .ok_or_else(|| invariant("Attachment Move Account has no active authority"))?;
        let source_vault = snapshot
            .bootstrap
            .vaults
            .get(&(generation.clone(), preparation.source_vault_id.clone()))
            .ok_or_else(|| invariant("Attachment Move source Vault is unavailable"))?;
        let target_vault = snapshot
            .bootstrap
            .vaults
            .get(&(generation.clone(), preparation.target_vault_id.clone()))
            .ok_or_else(|| invariant("Attachment Move target Vault is unavailable"))?;
        let master_unlock_key = self
            .live_master_unlock_keys
            .lock()
            .expect("live master unlock key lock poisoned")
            .get(&(snapshot.account_id.clone(), snapshot.incarnation.clone()))
            .map(LiveMasterUnlockKey::copy_bytes)
            .ok_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::AuthenticationRequired,
                    "Attachment Move Account is locked",
                )
            })?;
        let source_vault_key = Zeroizing::new(unwrap_vault_key(
            source_vault,
            &snapshot.user_id,
            &master_unlock_key,
        )?);
        let target_vault_key = Zeroizing::new(unwrap_vault_key(
            target_vault,
            &snapshot.user_id,
            &master_unlock_key,
        )?);
        let source_scope = |entity_type: &str, version: u64| AadContext {
            vault_id: source.vault_id.clone(),
            entity_id: source.id.clone(),
            entity_type: entity_type.into(),
            version,
            user_id: source.uploaded_by.clone(),
        };
        let mut encoded_attachment_key = decrypt_with_aad(
            &EncryptedData {
                ciphertext: source.encrypted_attachment_key.clone(),
                iv: source.attachment_key_iv.clone(),
                algorithm: source.attachment_key_algorithm.clone(),
            },
            &source_vault_key,
            &source_scope("attachment_key", source.envelope_version as u64),
        )
        .map_err(|_| invariant("Attachment Move key authority could not be opened"))?;
        let decoded_attachment_key = BASE64.decode(encoded_attachment_key.as_bytes());
        encoded_attachment_key.zeroize();
        let decoded_attachment_key = Zeroizing::new(
            decoded_attachment_key
                .map_err(|_| invariant("Attachment Move key authority is invalid"))?,
        );
        if decoded_attachment_key.len() != 32 {
            return Err(invariant(
                "Attachment Move key authority has the wrong length",
            ));
        }
        let mut attachment_key = [0u8; 32];
        attachment_key.copy_from_slice(&decoded_attachment_key);
        let attachment_key = Zeroizing::new(attachment_key);
        let name = Zeroizing::new(
            decrypt_with_aad(
                &EncryptedData {
                    ciphertext: source.encrypted_name.clone(),
                    iv: source.encryption_iv.clone(),
                    algorithm: source.encryption_algorithm.clone(),
                },
                &attachment_key[..],
                &source_scope("attachment_name", 1),
            )
            .map_err(|_| invariant("Attachment Move name authority could not be opened"))?,
        );
        let content_type = Zeroizing::new(
            decrypt_with_aad(
                &EncryptedData {
                    ciphertext: source.encrypted_content_type.clone(),
                    iv: source.encrypted_content_type_iv.clone(),
                    algorithm: source.encryption_algorithm.clone(),
                },
                &attachment_key[..],
                &source_scope("attachment_content_type", 1),
            )
            .map_err(|_| invariant("Attachment Move content-type authority could not be opened"))?,
        );
        let target_scope = |entity_type: &str, version: u64| AadContext {
            vault_id: preparation.target_vault_id.clone(),
            entity_id: source.id.clone(),
            entity_type: entity_type.into(),
            version,
            user_id: source.uploaded_by.clone(),
        };
        let encrypted_name = encrypt_with_aad(
            &name,
            &attachment_key[..],
            &target_scope("attachment_name", 1),
        )
        .map_err(|_| invariant("Attachment Move target name could not be sealed"))?;
        let encrypted_content_type = encrypt_with_aad(
            &content_type,
            &attachment_key[..],
            &target_scope("attachment_content_type", 1),
        )
        .map_err(|_| invariant("Attachment Move target content type could not be sealed"))?;
        let encoded_target_key = Zeroizing::new(BASE64.encode(*attachment_key));
        let wrapped_attachment_key = encrypt_with_aad(
            &encoded_target_key,
            &target_vault_key,
            &target_scope("attachment_key", target_envelope_version as u64),
        )
        .map_err(|_| invariant("Attachment Move target key could not be wrapped"))?;
        Ok(AttachmentMoveSecrets {
            source_key: Zeroizing::new(*attachment_key),
            target_key: attachment_key,
            prepared_metadata: PreparedMoveAttachment {
                encrypted_name: encrypted_name.ciphertext,
                encryption_iv: encrypted_name.iv,
                encryption_algorithm: encrypted_name.algorithm,
                encrypted_attachment_key: wrapped_attachment_key.ciphertext,
                attachment_key_iv: wrapped_attachment_key.iv,
                attachment_key_algorithm: wrapped_attachment_key.algorithm,
                encrypted_content_type: encrypted_content_type.ciphertext,
                encrypted_content_type_iv: encrypted_content_type.iv,
            },
        })
    }
}

impl AttachmentMoveSecretProvider for RuntimeAttachmentMoveSecrets {
    fn resolve(
        &self,
        preparation: &AttachmentMovePreparationRecord,
        source: &AuthorityAttachmentRecord,
    ) -> Result<AttachmentMoveSecrets, RuntimeError> {
        self.resolve_material(preparation, source)
    }

    fn recover_published_metadata(
        &self,
        preparation: &AttachmentMovePreparationRecord,
        source: &AuthorityAttachmentRecord,
        owner: &AttachmentArtifactOwner,
    ) -> Result<PreparedMoveAttachment, RuntimeError> {
        if owner.account_id() != &preparation.account_id
            || owner.operation_id() != preparation.operation_id
            || owner.attachment_id() != source.id
        {
            return Err(invariant("Attachment Move published owner is foreign"));
        }
        self.resolve_material(preparation, source)
            .map(|material| material.prepared_metadata)
    }
}

fn unwrap_vault_key(
    vault: &AuthorityVaultRecord,
    user_id: &str,
    master_unlock_key: &[u8; 32],
) -> Result<Vec<u8>, RuntimeError> {
    let wrapped: WrappedVaultKeyData = serde_json::from_str(&vault.encrypted_vault_key)
        .map_err(|_| invariant("wrapped Vault key is invalid"))?;
    if wrapped.context.vault_id != vault.id || wrapped.context.user_id != user_id {
        return Err(invariant("wrapped Vault key context does not match"));
    }
    decrypt_vault_key_with_muk(
        &vault.encrypted_vault_key,
        master_unlock_key,
        &wrapped.context,
    )
    .map_err(|_| {
        RuntimeError::new(
            RuntimeErrorCode::AuthenticationRequired,
            "Vault key could not be unwrapped",
        )
    })
}

fn invariant(message: impl Into<String>) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::InvariantViolation, message)
}

#[cfg(not(target_arch = "wasm32"))]
#[async_trait]
pub(crate) trait AttachmentMovePreparationDriver: Send + Sync {
    async fn drive(
        &self,
        request: PreparationDriveRequest,
    ) -> Result<PreparationDriveResult, RuntimeError>;
}

#[cfg(target_arch = "wasm32")]
#[async_trait(?Send)]
pub(crate) trait AttachmentMovePreparationDriver {
    async fn drive(
        &self,
        request: PreparationDriveRequest,
    ) -> Result<PreparationDriveResult, RuntimeError>;
}

#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
impl AttachmentMovePreparationDriver for AttachmentMovePreparationWorker {
    async fn drive(
        &self,
        request: PreparationDriveRequest,
    ) -> Result<PreparationDriveResult, RuntimeError> {
        AttachmentMovePreparationWorker::drive(self, request).await
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SchedulerDriveResult {
    Progressed,
    BackingOff { not_before_ms: u64 },
    ReadyForDispatch,
    FrozenStaleAuthority,
    WriterAlreadyActive,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PreparationCandidate {
    pub account_id: AccountId,
    pub operation_id: String,
    pub not_before_ms: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SchedulerPass {
    Progressed,
    DispatchReady,
    Parked,
    WaitFor { milliseconds: u64 },
}

pub(crate) struct AttachmentMovePreparationScheduler {
    driver: Arc<dyn AttachmentMovePreparationDriver>,
    active_accounts: Arc<Mutex<HashSet<AccountId>>>,
}

impl AttachmentMovePreparationScheduler {
    pub(crate) fn new(
        replica: Arc<Replica>,
        live_master_unlock_keys: Arc<
            Mutex<HashMap<(AccountId, crate::protocol::Incarnation), LiveMasterUnlockKey>>,
        >,
        facade: AttachmentMovePreparationFacade,
        runtime: Weak<super::Runtime>,
    ) -> Self {
        let transfer: Arc<dyn AttachmentMoveTransfer> =
            Arc::new(TransferAdapter::new(facade.transfer, runtime));
        let secrets: Arc<dyn AttachmentMoveSecretProvider> = Arc::new(
            RuntimeAttachmentMoveSecrets::new(replica.clone(), live_master_unlock_keys),
        );
        let worker = Arc::new(AttachmentMovePreparationWorker::new(
            replica,
            facade.provisional_artifacts,
            facade.artifacts,
            transfer,
            secrets,
        ));
        Self {
            driver: worker,
            active_accounts: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    #[cfg(test)]
    pub(crate) fn new_for_test(driver: Arc<dyn AttachmentMovePreparationDriver>) -> Self {
        Self {
            driver,
            active_accounts: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    pub(crate) async fn drive_one(
        &self,
        account_id: AccountId,
        operation_id: String,
        now_ms: u64,
    ) -> Result<SchedulerDriveResult, RuntimeError> {
        let Some(_writer) = AccountWriter::acquire(&self.active_accounts, account_id.clone())
        else {
            return Ok(SchedulerDriveResult::WriterAlreadyActive);
        };
        let result = self
            .driver
            .drive(PreparationDriveRequest::Advance {
                account_id,
                operation_id,
                now_ms,
            })
            .await?;
        Ok(match result {
            PreparationDriveResult::Progressed => SchedulerDriveResult::Progressed,
            PreparationDriveResult::BackingOff { not_before_ms } => {
                SchedulerDriveResult::BackingOff { not_before_ms }
            }
            PreparationDriveResult::ReadyForDispatch => SchedulerDriveResult::ReadyForDispatch,
            PreparationDriveResult::FrozenStaleAuthority => {
                SchedulerDriveResult::FrozenStaleAuthority
            }
        })
    }

    pub(crate) async fn drive_eligible(
        &self,
        candidates: Vec<PreparationCandidate>,
        unlocked_accounts: &HashSet<AccountId>,
        now_ms: u64,
    ) -> Result<SchedulerPass, RuntimeError> {
        let mut earliest = None;
        let mut writer_active = false;
        for candidate in candidates {
            if !unlocked_accounts.contains(&candidate.account_id) {
                continue;
            }
            if candidate.not_before_ms > now_ms {
                earliest = Some(earliest.map_or(candidate.not_before_ms, |current: u64| {
                    current.min(candidate.not_before_ms)
                }));
                continue;
            }
            match self
                .drive_one(candidate.account_id, candidate.operation_id, now_ms)
                .await?
            {
                SchedulerDriveResult::ReadyForDispatch => {
                    return Ok(SchedulerPass::DispatchReady);
                }
                SchedulerDriveResult::WriterAlreadyActive => writer_active = true,
                SchedulerDriveResult::Progressed
                | SchedulerDriveResult::BackingOff { .. }
                | SchedulerDriveResult::FrozenStaleAuthority => {
                    return Ok(SchedulerPass::Progressed);
                }
            }
        }
        match earliest {
            Some(deadline) => Ok(SchedulerPass::WaitFor {
                milliseconds: deadline.saturating_sub(now_ms).max(1),
            }),
            None if writer_active => Ok(SchedulerPass::WaitFor { milliseconds: 1 }),
            None => Ok(SchedulerPass::Parked),
        }
    }
}

struct AccountWriter {
    active_accounts: Arc<Mutex<HashSet<AccountId>>>,
    account_id: AccountId,
}

impl AccountWriter {
    fn acquire(
        active_accounts: &Arc<Mutex<HashSet<AccountId>>>,
        account_id: AccountId,
    ) -> Option<Self> {
        if !active_accounts
            .lock()
            .expect("Attachment Move scheduler writer lock poisoned")
            .insert(account_id.clone())
        {
            return None;
        }
        Some(Self {
            active_accounts: Arc::clone(active_accounts),
            account_id,
        })
    }
}

impl Drop for AccountWriter {
    fn drop(&mut self) {
        self.active_accounts
            .lock()
            .expect("Attachment Move scheduler writer lock poisoned")
            .remove(&self.account_id);
    }
}
