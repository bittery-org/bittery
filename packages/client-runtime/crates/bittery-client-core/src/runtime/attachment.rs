//! Foreground ordinary Attachment requests.
//!
//! The module keeps crypto, authenticated HTTP, authoritative probing, and guarded Replica
//! publication behind the Runtime request seam. These requests are deliberately not Operations.

use super::*;
use crate::{
    auth_http::{
        AttachmentDeleteAnswer, AttachmentDownloadGrant, AttachmentDownloadGrantAnswer,
        AttachmentMetadataCreateAnswer, AttachmentRenameAnswer, AttachmentUploadGrantAnswer,
        AuthenticatedOutcome,
    },
    platform_storage::CurrentSessionDocument,
    replica::{
        AuthorityAttachmentRecord, AuthorityItemRecord, AuthorityVaultRole,
        ForegroundAttachmentCommitPlan, ForegroundAttachmentCommitResult,
    },
    server_contract::{
        AttachmentUploadBody, CreateAttachmentBody, UpdateAttachmentBody, VaultAttachmentResponse,
    },
};
use base64::{
    engine::general_purpose::{STANDARD as BASE64, URL_SAFE_NO_PAD},
    Engine,
};
use bittery_crypto_core::{
    attachment_move::{
        AttachmentBlobDecryptor, AttachmentBlobEncryptor, AttachmentBlobScope,
        AttachmentEnvelopeScanner, MAX_ATTACHMENT_ENVELOPE_INPUT_CHUNK,
    },
    decrypt_vault_key_with_muk, decrypt_with_aad, encrypt_with_aad, generate_encryption_key,
    AadContext, EncryptedData, WrappedVaultKeyData,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttachmentUploadSourceError {
    Source,
    Cancelled,
    Invariant,
}

#[cfg(not(target_arch = "wasm32"))]
#[async_trait::async_trait]
pub trait AttachmentUploadSource: Send {
    async fn begin(
        &mut self,
        cancellation: RequestCancellation,
    ) -> Result<(), AttachmentUploadSourceError>;
    async fn next_chunk(
        &mut self,
        cancellation: RequestCancellation,
    ) -> Result<Option<Vec<u8>>, AttachmentUploadSourceError>;
    async fn close(&mut self) -> Result<(), AttachmentUploadSourceError>;
}
#[cfg(target_arch = "wasm32")]
#[async_trait::async_trait(?Send)]
pub trait AttachmentUploadSource {
    async fn begin(
        &mut self,
        cancellation: RequestCancellation,
    ) -> Result<(), AttachmentUploadSourceError>;
    async fn next_chunk(
        &mut self,
        cancellation: RequestCancellation,
    ) -> Result<Option<Vec<u8>>, AttachmentUploadSourceError>;
    async fn close(&mut self) -> Result<(), AttachmentUploadSourceError>;
}

#[cfg(not(target_arch = "wasm32"))]
#[async_trait::async_trait]
pub trait AttachmentUploadSourcePort: Send + Sync {
    async fn claim(
        &self,
        account_id: &AccountId,
        item_id: &str,
        name: &str,
        content_type: &str,
        capability_id: &str,
        expected_bytes: u64,
    ) -> Result<Box<dyn AttachmentUploadSource>, AttachmentUploadSourceError>;
    async fn retire_account(
        &self,
        account_id: &AccountId,
    ) -> Result<(), AttachmentUploadSourceError>;
    async fn complete_account_retirement(
        &self,
        account_id: &AccountId,
    ) -> Result<(), AttachmentUploadSourceError>;
    async fn retire_runtime(&self) -> Result<(), AttachmentUploadSourceError>;
}
#[cfg(target_arch = "wasm32")]
#[async_trait::async_trait(?Send)]
pub trait AttachmentUploadSourcePort {
    async fn claim(
        &self,
        account_id: &AccountId,
        item_id: &str,
        name: &str,
        content_type: &str,
        capability_id: &str,
        expected_bytes: u64,
    ) -> Result<Box<dyn AttachmentUploadSource>, AttachmentUploadSourceError>;
    async fn retire_account(
        &self,
        account_id: &AccountId,
    ) -> Result<(), AttachmentUploadSourceError>;
    async fn complete_account_retirement(
        &self,
        account_id: &AccountId,
    ) -> Result<(), AttachmentUploadSourceError>;
    async fn retire_runtime(&self) -> Result<(), AttachmentUploadSourceError>;
}

#[cfg(not(target_arch = "wasm32"))]
#[async_trait::async_trait]
pub trait AttachmentUploadBinary: Send {
    async fn write(
        &mut self,
        bytes: &[u8],
        cancellation: RequestCancellation,
    ) -> Result<(), AttachmentMoveTransferError>;
    async fn finish(
        &mut self,
        ciphertext_sha256: &str,
        cancellation: RequestCancellation,
    ) -> Result<AttachmentUploadBinaryOutcome, AttachmentMoveTransferError>;
    async fn abort(&mut self) -> Result<(), AttachmentMoveTransferError>;
}
#[cfg(target_arch = "wasm32")]
#[async_trait::async_trait(?Send)]
pub trait AttachmentUploadBinary {
    async fn write(
        &mut self,
        bytes: &[u8],
        cancellation: RequestCancellation,
    ) -> Result<(), AttachmentMoveTransferError>;
    async fn finish(
        &mut self,
        ciphertext_sha256: &str,
        cancellation: RequestCancellation,
    ) -> Result<AttachmentUploadBinaryOutcome, AttachmentMoveTransferError>;
    async fn abort(&mut self) -> Result<(), AttachmentMoveTransferError>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AttachmentUploadBinaryOutcome {
    Uploaded { ciphertext_sha256: String },
    NotDispatched,
    Rejected { status: u16 },
    Ambiguous,
    Cancelled,
}

#[cfg(not(target_arch = "wasm32"))]
#[async_trait::async_trait]
pub trait AttachmentUploadTransferPort: Send + Sync {
    async fn open(
        &self,
        account_id: &AccountId,
        attachment_id: &str,
        upload_url: &str,
        expected_bytes: u64,
        cancellation: RequestCancellation,
    ) -> Result<Box<dyn AttachmentUploadBinary>, AttachmentMoveTransferError>;
}
#[cfg(target_arch = "wasm32")]
#[async_trait::async_trait(?Send)]
pub trait AttachmentUploadTransferPort {
    async fn open(
        &self,
        account_id: &AccountId,
        attachment_id: &str,
        upload_url: &str,
        expected_bytes: u64,
        cancellation: RequestCancellation,
    ) -> Result<Box<dyn AttachmentUploadBinary>, AttachmentMoveTransferError>;
}

#[derive(Clone)]
pub struct AttachmentUploadFacade {
    sources: Arc<dyn AttachmentUploadSourcePort>,
    transfer: Arc<dyn AttachmentUploadTransferPort>,
}

pub(super) struct UploadAttachmentRequest {
    pub account_id: AccountId,
    pub item_id: String,
    pub name: String,
    pub content_type: String,
    pub file_size: u64,
    pub source_capability_id: String,
}

pub(super) struct PreparedAttachmentUpload {
    request: UploadAttachmentRequest,
    facade: AttachmentUploadFacade,
    source: UploadSourceOwner,
}
impl AttachmentUploadFacade {
    pub fn new(
        sources: Arc<dyn AttachmentUploadSourcePort>,
        transfer: Arc<dyn AttachmentUploadTransferPort>,
    ) -> Self {
        Self { sources, transfer }
    }
}

struct UploadSourceOwner {
    source: Option<Box<dyn AttachmentUploadSource>>,
    lifecycle: Option<super::foreground_attachment_lifecycle::ForegroundAttachmentGuard>,
    timer: Arc<dyn crate::device_timer::DeviceTimer>,
}
impl UploadSourceOwner {
    fn new(
        source: Box<dyn AttachmentUploadSource>,
        lifecycle: super::foreground_attachment_lifecycle::ForegroundAttachmentGuard,
        timer: Arc<dyn crate::device_timer::DeviceTimer>,
    ) -> Self {
        Self {
            source: Some(source),
            lifecycle: Some(lifecycle),
            timer,
        }
    }
    async fn begin(
        &mut self,
        cancellation: RequestCancellation,
    ) -> Result<(), AttachmentUploadSourceError> {
        self.source
            .as_mut()
            .expect("Upload source armed")
            .begin(cancellation)
            .await
    }
    async fn next_chunk(
        &mut self,
        cancellation: RequestCancellation,
    ) -> Result<Option<Vec<u8>>, AttachmentUploadSourceError> {
        self.source
            .as_mut()
            .expect("Upload source armed")
            .next_chunk(cancellation)
            .await
    }
    async fn close_until_clean(&mut self) {
        let mut failures = 0;
        while self
            .source
            .as_mut()
            .expect("Upload source armed")
            .close()
            .await
            .is_err()
        {
            wait_for_download_cleanup_retry(self.timer.as_ref(), failures).await;
            failures = failures.saturating_add(1);
        }
        self.source.take();
        self.lifecycle.take();
    }
}
impl Drop for UploadSourceOwner {
    fn drop(&mut self) {
        if let (Some(mut source), Some(lifecycle)) = (self.source.take(), self.lifecycle.take()) {
            let timer = Arc::clone(&self.timer);
            #[cfg(not(target_arch = "wasm32"))]
            tokio::spawn(async move {
                let mut failures = 0;
                while source.close().await.is_err() {
                    wait_for_download_cleanup_retry(timer.as_ref(), failures).await;
                    failures = failures.saturating_add(1);
                }
                drop(lifecycle);
            });
            #[cfg(target_arch = "wasm32")]
            wasm_bindgen_futures::spawn_local(async move {
                let mut failures = 0;
                while source.close().await.is_err() {
                    wait_for_download_cleanup_retry(timer.as_ref(), failures).await;
                    failures = failures.saturating_add(1);
                }
                drop(lifecycle);
            });
        }
    }
}

struct UploadBinaryOwner {
    upload: Option<Box<dyn AttachmentUploadBinary>>,
    timer: Arc<dyn crate::device_timer::DeviceTimer>,
    lifecycle: Option<super::foreground_attachment_lifecycle::ForegroundAttachmentGuard>,
}
impl UploadBinaryOwner {
    fn new(
        upload: Box<dyn AttachmentUploadBinary>,
        timer: Arc<dyn crate::device_timer::DeviceTimer>,
        lifecycle: super::foreground_attachment_lifecycle::ForegroundAttachmentGuard,
    ) -> Self {
        Self {
            upload: Some(upload),
            timer,
            lifecycle: Some(lifecycle),
        }
    }
    async fn write(
        &mut self,
        bytes: &[u8],
        cancellation: RequestCancellation,
    ) -> Result<(), AttachmentMoveTransferError> {
        self.upload
            .as_mut()
            .expect("Upload binary armed")
            .write(bytes, cancellation)
            .await
    }
    async fn finish(
        &mut self,
        ciphertext_sha256: &str,
        cancellation: RequestCancellation,
    ) -> Result<AttachmentUploadBinaryOutcome, AttachmentMoveTransferError> {
        let result = self
            .upload
            .as_mut()
            .expect("Upload binary armed")
            .finish(ciphertext_sha256, cancellation)
            .await;
        if matches!(result, Ok(AttachmentUploadBinaryOutcome::Uploaded { .. })) {
            self.upload.take();
            self.lifecycle.take();
        }
        result
    }
    async fn abort_until_clean(&mut self) {
        let Some(upload) = self.upload.as_mut() else {
            self.lifecycle.take();
            return;
        };
        let mut failures = 0;
        while upload.abort().await.is_err() {
            wait_for_download_cleanup_retry(self.timer.as_ref(), failures).await;
            failures = failures.saturating_add(1);
        }
        self.upload.take();
        self.lifecycle.take();
    }
}
impl Drop for UploadBinaryOwner {
    fn drop(&mut self) {
        if let (Some(mut upload), Some(lifecycle)) = (self.upload.take(), self.lifecycle.take()) {
            let timer = Arc::clone(&self.timer);
            #[cfg(not(target_arch = "wasm32"))]
            tokio::spawn(async move {
                let mut failures = 0;
                while upload.abort().await.is_err() {
                    wait_for_download_cleanup_retry(timer.as_ref(), failures).await;
                    failures = failures.saturating_add(1);
                }
                drop(lifecycle);
            });
            #[cfg(target_arch = "wasm32")]
            wasm_bindgen_futures::spawn_local(async move {
                let mut failures = 0;
                while upload.abort().await.is_err() {
                    wait_for_download_cleanup_retry(timer.as_ref(), failures).await;
                    failures = failures.saturating_add(1);
                }
                drop(lifecycle);
            });
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttachmentDownloadSinkError {
    Sink,
    Cancelled,
    Invariant,
}

#[cfg(not(target_arch = "wasm32"))]
#[async_trait::async_trait]
pub trait AttachmentDownloadSink: Send {
    async fn begin(&mut self) -> Result<(), AttachmentDownloadSinkError>;
    async fn write(&mut self, bytes: &[u8]) -> Result<(), AttachmentDownloadSinkError>;
    async fn commit(&mut self) -> Result<(), AttachmentDownloadSinkError>;
    async fn discard(&mut self) -> Result<(), AttachmentDownloadSinkError>;
}

#[cfg(target_arch = "wasm32")]
#[async_trait::async_trait(?Send)]
pub trait AttachmentDownloadSink {
    async fn begin(&mut self) -> Result<(), AttachmentDownloadSinkError>;
    async fn write(&mut self, bytes: &[u8]) -> Result<(), AttachmentDownloadSinkError>;
    async fn commit(&mut self) -> Result<(), AttachmentDownloadSinkError>;
    async fn discard(&mut self) -> Result<(), AttachmentDownloadSinkError>;
}

#[cfg(not(target_arch = "wasm32"))]
#[async_trait::async_trait]
pub trait AttachmentDownloadSinkPort: Send + Sync {
    fn claim(
        &self,
        account_id: &AccountId,
        attachment_id: &str,
        capability_id: &str,
    ) -> Result<Box<dyn AttachmentDownloadSink>, AttachmentDownloadSinkError>;

    async fn retire_account(
        &self,
        account_id: &AccountId,
    ) -> Result<(), AttachmentDownloadSinkError>;

    async fn complete_account_retirement(
        &self,
        account_id: &AccountId,
    ) -> Result<(), AttachmentDownloadSinkError>;

    async fn retire_runtime(&self) -> Result<(), AttachmentDownloadSinkError>;
}

#[cfg(target_arch = "wasm32")]
#[async_trait::async_trait(?Send)]
pub trait AttachmentDownloadSinkPort {
    fn claim(
        &self,
        account_id: &AccountId,
        attachment_id: &str,
        capability_id: &str,
    ) -> Result<Box<dyn AttachmentDownloadSink>, AttachmentDownloadSinkError>;

    async fn retire_account(
        &self,
        account_id: &AccountId,
    ) -> Result<(), AttachmentDownloadSinkError>;

    async fn complete_account_retirement(
        &self,
        account_id: &AccountId,
    ) -> Result<(), AttachmentDownloadSinkError>;

    async fn retire_runtime(&self) -> Result<(), AttachmentDownloadSinkError>;
}

#[derive(Clone)]
pub struct AttachmentDownloadFacade {
    transfer: Arc<dyn AttachmentMoveTransferPort>,
    sinks: Arc<dyn AttachmentDownloadSinkPort>,
}

struct AttachmentDownloadSinkOwner {
    sink: Option<Box<dyn AttachmentDownloadSink>>,
    lifecycle: Option<super::foreground_attachment_lifecycle::ForegroundAttachmentGuard>,
    timer: Arc<dyn crate::device_timer::DeviceTimer>,
}

impl AttachmentDownloadSinkOwner {
    fn new(
        sink: Box<dyn AttachmentDownloadSink>,
        lifecycle: super::foreground_attachment_lifecycle::ForegroundAttachmentGuard,
        timer: Arc<dyn crate::device_timer::DeviceTimer>,
    ) -> Self {
        Self {
            sink: Some(sink),
            lifecycle: Some(lifecycle),
            timer,
        }
    }

    async fn begin(&mut self) -> Result<(), AttachmentDownloadSinkError> {
        self.sink
            .as_mut()
            .expect("Download sink owner is armed")
            .begin()
            .await
    }

    async fn write(&mut self, bytes: &[u8]) -> Result<(), AttachmentDownloadSinkError> {
        self.sink
            .as_mut()
            .expect("Download sink owner is armed")
            .write(bytes)
            .await
    }

    async fn commit(&mut self) -> Result<(), AttachmentDownloadSinkError> {
        let result = self
            .sink
            .as_mut()
            .expect("Download sink owner is armed")
            .commit()
            .await;
        if result.is_ok() {
            self.sink.take();
            self.lifecycle.take();
        }
        result
    }

    async fn discard_until_clean(&mut self) {
        let mut failure_count = 0_u32;
        loop {
            if self
                .sink
                .as_mut()
                .expect("Download sink owner is armed")
                .discard()
                .await
                .is_ok()
            {
                self.sink.take();
                self.lifecycle.take();
                return;
            }
            wait_for_download_cleanup_retry(self.timer.as_ref(), failure_count).await;
            failure_count = failure_count.saturating_add(1);
        }
    }

    fn lifecycle(&self) -> &super::foreground_attachment_lifecycle::ForegroundAttachmentGuard {
        self.lifecycle
            .as_ref()
            .expect("Download sink owner has lifecycle ownership")
    }
}

impl Drop for AttachmentDownloadSinkOwner {
    fn drop(&mut self) {
        if let (Some(sink), Some(lifecycle)) = (self.sink.take(), self.lifecycle.take()) {
            spawn_download_cleanup(sink, lifecycle, Arc::clone(&self.timer));
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn spawn_download_cleanup(
    mut sink: Box<dyn AttachmentDownloadSink>,
    lifecycle: super::foreground_attachment_lifecycle::ForegroundAttachmentGuard,
    timer: Arc<dyn crate::device_timer::DeviceTimer>,
) {
    tokio::spawn(async move {
        let mut failure_count = 0_u32;
        while sink.discard().await.is_err() {
            wait_for_download_cleanup_retry(timer.as_ref(), failure_count).await;
            failure_count = failure_count.saturating_add(1);
        }
        drop(lifecycle);
    });
}

#[cfg(target_arch = "wasm32")]
fn spawn_download_cleanup(
    mut sink: Box<dyn AttachmentDownloadSink>,
    lifecycle: super::foreground_attachment_lifecycle::ForegroundAttachmentGuard,
    timer: Arc<dyn crate::device_timer::DeviceTimer>,
) {
    wasm_bindgen_futures::spawn_local(async move {
        let mut failure_count = 0_u32;
        while sink.discard().await.is_err() {
            wait_for_download_cleanup_retry(timer.as_ref(), failure_count).await;
            failure_count = failure_count.saturating_add(1);
        }
        drop(lifecycle);
    });
}

async fn wait_for_download_cleanup_retry(
    timer: &dyn crate::device_timer::DeviceTimer,
    failure_count: u32,
) {
    let exponent = failure_count.min(7);
    timer.sleep_ms(10_u64 << exponent).await;
}

pub(super) struct PreparedAttachmentDownload {
    account_id: AccountId,
    attachment_id: String,
    sink_capability_id: String,
    facade: AttachmentDownloadFacade,
    sink: AttachmentDownloadSinkOwner,
}

impl AttachmentDownloadFacade {
    pub fn new(
        transfer: Arc<dyn AttachmentMoveTransferPort>,
        sinks: Arc<dyn AttachmentDownloadSinkPort>,
    ) -> Self {
        Self { transfer, sinks }
    }
}

impl Runtime {
    pub(super) async fn retire_attachment_upload_account(&self, account_id: &AccountId) {
        let sources = self
            .attachment_upload
            .lock()
            .expect("Attachment Upload facade lock poisoned")
            .as_ref()
            .map(|facade| Arc::clone(&facade.sources));
        let Some(sources) = sources else { return };
        let mut failures = 0;
        while sources.retire_account(account_id).await.is_err() {
            wait_for_download_cleanup_retry(self.device_timer.as_ref(), failures).await;
            failures = failures.saturating_add(1);
        }
    }
    pub(super) async fn complete_attachment_upload_account_retirement(
        &self,
        account_id: &AccountId,
    ) {
        let sources = self
            .attachment_upload
            .lock()
            .expect("Attachment Upload facade lock poisoned")
            .as_ref()
            .map(|facade| Arc::clone(&facade.sources));
        let Some(sources) = sources else { return };
        let mut failures = 0;
        while sources
            .complete_account_retirement(account_id)
            .await
            .is_err()
        {
            wait_for_download_cleanup_retry(self.device_timer.as_ref(), failures).await;
            failures = failures.saturating_add(1);
        }
    }
    pub(super) async fn retire_all_attachment_uploads(&self) {
        let sources = self
            .attachment_upload
            .lock()
            .expect("Attachment Upload facade lock poisoned")
            .as_ref()
            .map(|facade| Arc::clone(&facade.sources));
        let Some(sources) = sources else { return };
        let mut failures = 0;
        while sources.retire_runtime().await.is_err() {
            wait_for_download_cleanup_retry(self.device_timer.as_ref(), failures).await;
            failures = failures.saturating_add(1);
        }
    }

    pub(super) async fn retire_attachment_download_account(&self, account_id: &AccountId) {
        let sinks = self
            .attachment_download
            .lock()
            .expect("Attachment Download facade lock poisoned")
            .as_ref()
            .map(|facade| Arc::clone(&facade.sinks));
        let Some(sinks) = sinks else { return };
        let mut failure_count = 0_u32;
        while sinks.retire_account(account_id).await.is_err() {
            wait_for_download_cleanup_retry(self.device_timer.as_ref(), failure_count).await;
            failure_count = failure_count.saturating_add(1);
        }
    }

    pub(super) async fn complete_attachment_download_account_retirement(
        &self,
        account_id: &AccountId,
    ) {
        let sinks = self
            .attachment_download
            .lock()
            .expect("Attachment Download facade lock poisoned")
            .as_ref()
            .map(|facade| Arc::clone(&facade.sinks));
        let Some(sinks) = sinks else { return };
        let mut failure_count = 0_u32;
        while sinks.complete_account_retirement(account_id).await.is_err() {
            wait_for_download_cleanup_retry(self.device_timer.as_ref(), failure_count).await;
            failure_count = failure_count.saturating_add(1);
        }
    }

    pub(super) async fn retire_all_attachment_downloads(&self) {
        let sinks = self
            .attachment_download
            .lock()
            .expect("Attachment Download facade lock poisoned")
            .as_ref()
            .map(|facade| Arc::clone(&facade.sinks));
        let Some(sinks) = sinks else { return };
        let mut failure_count = 0_u32;
        while sinks.retire_runtime().await.is_err() {
            wait_for_download_cleanup_retry(self.device_timer.as_ref(), failure_count).await;
            failure_count = failure_count.saturating_add(1);
        }
    }

    pub(super) fn prepare_attachment_download(
        &self,
        account_id: AccountId,
        attachment_id: String,
        sink_capability_id: String,
        cancellation: RequestCancellation,
    ) -> Result<PreparedAttachmentDownload, RuntimeError> {
        if !is_canonical_sink_capability_id(&sink_capability_id) {
            return Err(invariant("Attachment Download sink capability is invalid"));
        }
        let facade = self
            .attachment_download
            .lock()
            .expect("Attachment Download facade lock poisoned")
            .clone()
            .ok_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::SinkFailure,
                    "Attachment Download sink is unavailable",
                )
            })?;
        let lifecycle = self
            .foreground_attachments
            .register_unresolved(&account_id, cancellation)?;
        let sink = facade
            .sinks
            .claim(&account_id, &attachment_id, &sink_capability_id)
            .map_err(sink_error)?;
        Ok(PreparedAttachmentDownload {
            account_id,
            attachment_id,
            sink_capability_id,
            facade,
            sink: AttachmentDownloadSinkOwner::new(sink, lifecycle, Arc::clone(&self.device_timer)),
        })
    }

    pub(super) async fn download_attachment(
        &self,
        mut prepared: PreparedAttachmentDownload,
        cancellation: RequestCancellation,
    ) -> Result<RuntimeResponse, RuntimeError> {
        let account_id = prepared.account_id.clone();
        let attachment_id = prepared.attachment_id.clone();
        let sink_capability_id = prepared.sink_capability_id.clone();
        let facade = prepared.facade.clone();
        let teardown_admission = tokio::select! {
            biased;
            () = cancellation.cancelled() => {
                prepared.sink.discard_until_clean().await;
                return Err(cancelled());
            }
            guard = self.teardown_admission.read() => guard,
        };

        let transfer = async {
			self.reject_request_during_pending_teardown(&RuntimeRequest::DownloadAttachment {
				account_id: account_id.clone(),
				attachment_id: attachment_id.clone(),
				sink_capability_id: sink_capability_id.clone(),
			})?;
			let claimed_snapshot = self.require_snapshot(&account_id);
			tokio::select! {
				biased;
				result = prepared.sink.begin() => result.map_err(sink_error)?,
				() = cancellation.cancelled() => return Err(cancelled()),
			}
			let execution_lock = self.account_execution_lock(&account_id)?;
			let execution_guard = tokio::select! {
				biased;
				() = cancellation.cancelled() => return Err(cancelled()),
				guard = execution_lock.lock() => guard,
			};
			self.ensure_attachment_admission(&account_id, &cancellation)?;
			let snapshot = self.require_snapshot(&account_id)?;
			if let Ok(claimed_snapshot) = &claimed_snapshot {
				if claimed_snapshot.incarnation != snapshot.incarnation {
					return Err(retryable("Account authority changed during sink begin"));
				}
			}
			drop(execution_guard);
			if snapshot.failure.is_some() {
				return Err(RuntimeError::new(
					RuntimeErrorCode::AccountFailed,
					"the selected Account module has failed",
				));
			}
			let (source, vault) = attachment_and_vault(&snapshot, &attachment_id)?;
			let attachment_key = open_attachment_key(self, &snapshot, &source, &vault)?;
            let metadata = self
                .platform_storage
                .load_account_metadata(&account_id, &snapshot.incarnation)
                .await
                .map_err(|_| retryable("Account metadata could not be loaded"))?
                .ok_or_else(authentication_required)?;
            if metadata.user_id != snapshot.user_id {
                return Err(invariant("Account metadata authority changed"));
            }
            let mut session = self
                .platform_storage
                .load_current_session(&account_id, &snapshot.incarnation)
                .await
                .map_err(|_| retryable("Session could not be loaded"))?
                .ok_or_else(authentication_required)?;
            let auth_config = self.auth_client_config.clone().ok_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::AuthenticationUnavailable,
                    "authentication is not configured for this Runtime",
                )
            })?;
            let http = AuthHttpClient::new(
                &self.http_transport,
                &metadata.normalized_server_url,
                metadata.insecure_transport_confirmed,
                auth_config,
            )?;
            let mut renewed = false;
            let mut answer = http
                .create_attachment_download_grant(
                    session.token.as_ref(),
                    &attachment_id,
                    cancellation.clone(),
                )
                .await?;
            if matches!(answer, AuthenticatedOutcome::ReauthenticationRequired) {
                renew_once(
                    self,
                    &account_id,
                    &http,
                    &mut session,
                    &mut renewed,
                    cancellation.clone(),
                )
                .await?;
                answer = http
                    .create_attachment_download_grant(
                        session.token.as_ref(),
                        &attachment_id,
                        cancellation.clone(),
                    )
                    .await?;
            }
            let grant = match answer {
                AuthenticatedOutcome::Ok(answer) => validate_download_grant(answer, &source)?,
                AuthenticatedOutcome::Transient => {
                    return Err(retryable("Attachment download grant failed"));
                }
                AuthenticatedOutcome::ReauthenticationRequired => {
                    self.mark_reauthentication_required(&account_id);
                    return Err(authentication_required());
                }
            };
            let max_response_bytes = attachment_response_bound(source.file_size)?;
            let request = || AttachmentMoveDownloadRequest {
                download_url: grant.download_url.clone(),
                headers: Vec::new(),
                max_response_bytes,
                max_chunk_bytes: MAX_ATTACHMENT_ENVELOPE_INPUT_CHUNK as u32,
            };
            let mut first = tokio::select! {
                biased;
                () = cancellation.cancelled() => return Err(cancelled()),
                value = facade.transfer.open_source(request()) => value.map_err(download_transfer_error)?,
            };
            let mut scanner = AttachmentEnvelopeScanner::new();
            loop {
                let chunk = tokio::select! {
                    biased;
                    () = cancellation.cancelled() => return Err(cancelled()),
                    value = first.next_chunk() => value.map_err(download_transfer_error)?,
                };
                let Some(chunk) = chunk else { break };
                scanner
                    .push(&chunk)
                    .map_err(|_| retryable("Attachment ciphertext is invalid"))?;
            }
            let scan = scanner
                .finish()
                .map_err(|_| retryable("Attachment ciphertext is invalid"))?;
            let mut decryptor = AttachmentBlobDecryptor::new(
                scan,
                *attachment_key,
                AttachmentBlobScope::new(
                    source.vault_id.clone(),
                    source.id.clone(),
                    source.uploaded_by.clone(),
                ),
            )
            .map_err(|_| invariant("Attachment decryptor could not be created"))?;
            let mut second = tokio::select! {
                biased;
                () = cancellation.cancelled() => return Err(cancelled()),
                value = facade.transfer.open_source(request()) => value.map_err(download_transfer_error)?,
            };
            let mut plaintext_bytes = 0_u64;
            loop {
                let chunk = tokio::select! {
                    biased;
                    () = cancellation.cancelled() => return Err(cancelled()),
                    value = second.next_chunk() => value.map_err(download_transfer_error)?,
                };
                let Some(chunk) = chunk else { break };
                let plaintext = Zeroizing::new(
                    decryptor
                        .push(&chunk)
                        .map_err(|_| retryable("Attachment ciphertext authentication failed"))?,
                );
                plaintext_bytes = plaintext_bytes
                    .checked_add(plaintext.len() as u64)
                    .ok_or_else(|| size_rejected("Attachment plaintext is too large"))?;
                if plaintext_bytes > source.file_size as u64 {
                    return Err(size_rejected("Attachment plaintext exceeds its authority"));
                }
                if !plaintext.is_empty() {
                    prepared.sink.write(&plaintext).await.map_err(sink_error)?;
                }
            }
            let final_plaintext = Zeroizing::new(
                decryptor
                    .finish()
                    .map_err(|_| retryable("Attachment ciphertext authentication failed"))?,
            );
            plaintext_bytes = plaintext_bytes
                .checked_add(final_plaintext.len() as u64)
                .ok_or_else(|| size_rejected("Attachment plaintext is too large"))?;
            if plaintext_bytes != source.file_size as u64 {
                return Err(retryable("Attachment plaintext length is not authoritative"));
            }
            if !final_plaintext.is_empty() {
                prepared.sink.write(&final_plaintext).await.map_err(sink_error)?;
            }
            Ok(())
        }
        .await;

        let result = match transfer {
            Ok(())
                if self
                    .foreground_attachments
                    .admit_finalization(prepared.sink.lifecycle(), &cancellation) =>
            {
                match prepared.sink.commit().await {
                    Ok(()) => Ok(()),
                    Err(error) => {
                        prepared.sink.discard_until_clean().await;
                        Err(sink_error(error))
                    }
                }
            }
            Ok(()) => {
                prepared.sink.discard_until_clean().await;
                Err(cancelled())
            }
            Err(error) => {
                prepared.sink.discard_until_clean().await;
                Err(error)
            }
        };
        drop(teardown_admission);
        result?;
        Ok(RuntimeResponse::AttachmentDownloaded {
            account_id,
            attachment_id,
        })
    }

    pub(super) async fn prepare_attachment_upload(
        &self,
        request: UploadAttachmentRequest,
        cancellation: RequestCancellation,
    ) -> Result<PreparedAttachmentUpload, RuntimeError> {
        validate_upload_input(
            &request.name,
            &request.content_type,
            request.file_size,
            &request.source_capability_id,
        )?;
        let facade = self
            .attachment_upload
            .lock()
            .expect("Attachment Upload facade lock poisoned")
            .clone()
            .ok_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::SourceFailure,
                    "Attachment Upload source is unavailable",
                )
            })?;
        let lifecycle = self
            .foreground_attachments
            .register_unresolved(&request.account_id, cancellation)?;
        let source = facade
            .sources
            .claim(
                &request.account_id,
                &request.item_id,
                &request.name,
                &request.content_type,
                &request.source_capability_id,
                request.file_size,
            )
            .await
            .map_err(upload_source_error)?;
        Ok(PreparedAttachmentUpload {
            request,
            facade,
            source: UploadSourceOwner::new(source, lifecycle, Arc::clone(&self.device_timer)),
        })
    }

    pub(super) async fn upload_attachment(
        &self,
        mut prepared: PreparedAttachmentUpload,
        cancellation: RequestCancellation,
    ) -> Result<RuntimeResponse, RuntimeError> {
        let teardown_admission = tokio::select! {
            biased;
            () = cancellation.cancelled() => {
                prepared.source.close_until_clean().await;
                return Err(cancelled());
            }
            guard = self.teardown_admission.read() => guard,
        };
        let UploadAttachmentRequest {
            account_id,
            item_id,
            name,
            content_type,
            file_size,
            source_capability_id,
        } = prepared.request;
        let facade = prepared.facade;
        let mut source = prepared.source;
        let result = async {
        self.reject_request_during_pending_teardown(&RuntimeRequest::UploadAttachment {
            account_id: account_id.clone(),
            item_id: item_id.clone(),
            name: name.clone(),
            content_type: content_type.clone(),
            file_size,
            source_capability_id: source_capability_id.clone(),
        })?;
        let initial = self.require_snapshot(&account_id)?;
        let item_lock = self.item_mutation_lock(&account_id, &item_id);
        let item_guard = tokio::select! { biased; () = cancellation.cancelled() => return Err(cancelled()), guard = item_lock.lock() => guard };
        let execution_lock = self.account_execution_lock(&account_id)?;
        let execution_guard = tokio::select! { biased; () = cancellation.cancelled() => return Err(cancelled()), guard = execution_lock.lock() => guard };
        self.ensure_attachment_admission(&account_id, &cancellation)?;
        let snapshot = self.require_snapshot(&account_id)?;
        if snapshot.incarnation != initial.incarnation {
            return Err(retryable(
                "Account authority changed before Attachment Upload",
            ));
        }
        let (_item, vault) = item_and_vault(&snapshot, &item_id)?;
        if item_has_optimistic_owner(&snapshot, &item_id) {
            return Err(retryable(
                "an optimistic Item owner must reconcile before Attachment Upload",
            ));
        }
        if vault.role == AuthorityVaultRole::ReadOnly {
            return Err(RuntimeError::new(
                RuntimeErrorCode::ReadOnly,
                "the Item belongs to a read-only Vault",
            ));
        }
        let auth_config = self.auth_client_config.clone().ok_or_else(|| {
            RuntimeError::new(
                RuntimeErrorCode::AuthenticationUnavailable,
                "authentication is not configured for this Runtime",
            )
        })?;
        let crypto_authority =
            prepare_upload_crypto(self, &snapshot, &vault, &name, &content_type)?;
        drop(execution_guard);

        let upload_result = async {
            source
                .begin(cancellation.clone())
                .await
                .map_err(upload_source_error)?;
            let metadata = self.platform_storage.load_account_metadata(&account_id, &snapshot.incarnation).await.map_err(|_| retryable("Account metadata could not be loaded"))?.ok_or_else(authentication_required)?;
            if metadata.user_id != snapshot.user_id { return Err(invariant("Account metadata authority changed")); }
            let mut session = self.platform_storage.load_current_session(&account_id, &snapshot.incarnation).await.map_err(|_| retryable("Session could not be loaded"))?.ok_or_else(authentication_required)?;
            let http = AuthHttpClient::new(&self.http_transport, &metadata.normalized_server_url, metadata.insecure_transport_confirmed, auth_config)?;
            let mut renewed = false;
            let file_size_i32 = i32::try_from(file_size).map_err(|_| size_rejected("Attachment plaintext is too large"))?;
            let grant_body = AttachmentUploadBody { file_name: format!("{}.enc", URL_SAFE_NO_PAD.encode(&crypto_authority.attachment_key[..16])), content_type: "application/octet-stream".into(), file_size: file_size_i32 };
            let mut grant = http.create_attachment_upload_grant(session.token.as_ref(), &item_id, &grant_body, cancellation.clone()).await?;
            if matches!(grant, AuthenticatedOutcome::ReauthenticationRequired) {
                renew_once(self, &account_id, &http, &mut session, &mut renewed, cancellation.clone()).await?;
                grant = http.create_attachment_upload_grant(session.token.as_ref(), &item_id, &grant_body, cancellation.clone()).await?;
            }
            let grant = match grant {
                AuthenticatedOutcome::Ok(AttachmentUploadGrantAnswer::Grant(grant)) => grant,
                AuthenticatedOutcome::Ok(AttachmentUploadGrantAnswer::AccessDenied) => return Err(RuntimeError::new(RuntimeErrorCode::AccessDenied, "Attachment Upload was denied")),
                AuthenticatedOutcome::Ok(AttachmentUploadGrantAnswer::QuotaRejected) => return Err(RuntimeError::new(RuntimeErrorCode::QuotaExceeded, "Attachment quota was exceeded")),
                AuthenticatedOutcome::Ok(AttachmentUploadGrantAnswer::SizeRejected) => return Err(size_rejected("Attachment size was rejected")),
                AuthenticatedOutcome::Transient => return Err(retryable("Attachment Upload grant failed")),
                AuthenticatedOutcome::ReauthenticationRequired => { self.mark_reauthentication_required(&account_id); return Err(authentication_required()); }
            };
            if grant.attachment_id.is_empty() || grant.key.is_empty() || grant.upload_url.is_empty() { return Err(invariant("Attachment Upload grant is malformed")); }
            let prepared_crypto = crypto_authority.seal(&grant.attachment_id)?;
            let envelope_bytes = encrypted_attachment_storage_size(file_size)?;
            let binary_lifecycle = self.foreground_attachments.register(
                &account_id,
                &snapshot.incarnation,
                cancellation.clone(),
            )?;
            let upload = facade
                .transfer
                .open(
                    &account_id,
                    &grant.attachment_id,
                    &grant.upload_url,
                    envelope_bytes,
                    cancellation.clone(),
                )
                .await
                .map_err(|error| {
                    if cancellation.is_cancelled() {
                        cancelled()
                    } else {
                        upload_transfer_error(error)
                    }
                })?;
            let mut upload = UploadBinaryOwner::new(
                upload,
                Arc::clone(&self.device_timer),
                binary_lifecycle,
            );
            let mut encryptor = AttachmentBlobEncryptor::new(*prepared_crypto.attachment_key, AttachmentBlobScope::new(vault.id.clone(), grant.attachment_id.clone(), snapshot.user_id.clone())).map_err(|_| invariant("Attachment blob encryptor could not be created"))?;
            let streamed = async {
                let mut plaintext_bytes = 0_u64;
                loop {
                    let chunk = source
                        .next_chunk(cancellation.clone())
                        .await
                        .map_err(upload_source_error)?;
                    let Some(mut chunk) = chunk else { break };
                    if chunk.len() > MAX_ATTACHMENT_ENVELOPE_INPUT_CHUNK { chunk.zeroize(); return Err(size_rejected("Attachment source chunk is too large")); }
                    plaintext_bytes = plaintext_bytes.checked_add(chunk.len() as u64).ok_or_else(|| size_rejected("Attachment plaintext is too large"))?;
                    if plaintext_bytes > file_size { chunk.zeroize(); return Err(size_rejected("Attachment source exceeds its declared size")); }
                    let encrypted = encryptor.push(&chunk).map_err(|_| invariant("Attachment blob encryption failed"))?;
                    chunk.zeroize();
                    if !encrypted.is_empty() {
                        upload
                            .write(&encrypted, cancellation.clone())
                            .await
                            .map_err(|error| {
                                if cancellation.is_cancelled() {
                                    cancelled()
                                } else {
                                    upload_transfer_error(error)
                                }
                            })?;
                    }
                }
                if plaintext_bytes != file_size { return Err(size_rejected("Attachment source length does not match its declaration")); }
                let finish = encryptor.finish().map_err(|_| invariant("Attachment blob encryption failed"))?;
                if finish.byte_length != envelope_bytes || finish.plaintext_length != file_size { return Err(invariant("Attachment encrypted size is inconsistent")); }
                upload
                    .write(&finish.final_chunk, cancellation.clone())
                    .await
                    .map_err(|error| {
                        if cancellation.is_cancelled() {
                            cancelled()
                        } else {
                            upload_transfer_error(error)
                        }
                    })?;
                let finish_result = upload
                    .finish(&finish.ciphertext_sha256, cancellation.clone())
                    .await;
                Ok::<_, RuntimeError>((finish, finish_result))
            }.await;
            let (finish, finish_result) = match streamed {
                Ok(streamed) => streamed,
                Err(error) => {
                    upload.abort_until_clean().await;
                    return Err(error);
                }
            };
            let upload_was_ambiguous = match finish_result {
                Ok(AttachmentUploadBinaryOutcome::Uploaded { ciphertext_sha256 }) if ciphertext_sha256 == finish.ciphertext_sha256 => false,
                Ok(AttachmentUploadBinaryOutcome::Uploaded { .. }) => return Err(invariant("Attachment binary executor digest did not match Rust")),
                Ok(AttachmentUploadBinaryOutcome::Rejected { status }) if !(300..=599).contains(&status) => {
                    upload.abort_until_clean().await;
                    return Err(invariant("Attachment binary executor returned an invalid rejection status"));
                }
                Ok(AttachmentUploadBinaryOutcome::NotDispatched | AttachmentUploadBinaryOutcome::Rejected { .. }) => {
                    upload.abort_until_clean().await;
                    return Err(retryable("Attachment binary upload definitely failed"));
                }
                Ok(AttachmentUploadBinaryOutcome::Ambiguous) => {
                    upload.abort_until_clean().await;
                    true
                }
                Ok(AttachmentUploadBinaryOutcome::Cancelled) => {
                    upload.abort_until_clean().await;
                    return Err(cancelled());
                }
                Err(_) if cancellation.is_cancelled() => {
                    upload.abort_until_clean().await;
                    return Err(cancelled());
                }
                Err(AttachmentMoveTransferError::Invariant) => {
                    upload.abort_until_clean().await;
                    return Err(invariant("Attachment binary executor failed invariant validation"));
                }
                Err(_) => {
                    upload.abort_until_clean().await;
                    true
                }
            };
            let body = prepared_crypto.into_body(grant.attachment_id.clone(), grant.key.clone(), file_size_i32);
            let mut create = http.create_attachment_metadata(session.token.as_ref(), &item_id, &body, cancellation.clone()).await?;
            if matches!(create, AuthenticatedOutcome::ReauthenticationRequired) {
                renew_once(self, &account_id, &http, &mut session, &mut renewed, cancellation.clone()).await?;
                create = http.create_attachment_metadata(session.token.as_ref(), &item_id, &body, cancellation.clone()).await?;
            }
            match create {
                AuthenticatedOutcome::Ok(AttachmentMetadataCreateAnswer::Created(created)) if created.attachment_id == grant.attachment_id => {},
                AuthenticatedOutcome::Ok(AttachmentMetadataCreateAnswer::Created(_)) => return Err(invariant("Attachment metadata returned a foreign identity")),
                AuthenticatedOutcome::Ok(AttachmentMetadataCreateAnswer::AccessDenied) => return Err(RuntimeError::new(RuntimeErrorCode::AccessDenied, "Attachment metadata creation was denied")),
                AuthenticatedOutcome::Ok(AttachmentMetadataCreateAnswer::Missing) => return Err(RuntimeError::new(RuntimeErrorCode::AuthorityMissing, "Item authority is missing")),
                AuthenticatedOutcome::Ok(AttachmentMetadataCreateAnswer::Rejected) if !upload_was_ambiguous => return Err(retryable("Attachment metadata was rejected")),
                AuthenticatedOutcome::Ok(AttachmentMetadataCreateAnswer::Rejected) => {},
                AuthenticatedOutcome::Ok(AttachmentMetadataCreateAnswer::Ambiguous) | AuthenticatedOutcome::Transient => {},
                AuthenticatedOutcome::ReauthenticationRequired => { self.mark_reauthentication_required(&account_id); return Err(authentication_required()); }
            }
            let authority = fetch_item_authority(self, &http, AttachmentAuthority { account_id: &account_id, item_id: &item_id, attachment_id: &grant.attachment_id, expectation: AttachmentAuthorityExpectation::Uploaded { vault_id: &vault.id, uploaded_by: &snapshot.user_id, body: &body }, cancellation: cancellation.clone() }, &mut session, &mut renewed).await?;
            let execution_guard = tokio::select! { biased; () = cancellation.cancelled() => return Err(cancelled()), guard = execution_lock.lock() => guard };
            self.ensure_attachment_admission(&account_id, &cancellation)?;
            let result = self.replica.execute_foreground_attachment_exact(ForegroundAttachmentCommitPlan::new(account_id.clone(), snapshot.incarnation.clone(), snapshot.revision, snapshot.lock_epoch, grant.attachment_id.clone(), true, authority)).await?;
            let replica_revision = match result {
                ForegroundAttachmentCommitResult::Applied { replica_revision } => replica_revision,
                _ => return Err(retryable("Replica authority changed before Attachment Upload publication")),
            };
            let publication = self.foreground_attachments.publication(source.lifecycle.as_ref().expect("source lifecycle"));
            let prepared_publications = self.decrypt_visible_items_for_foreground_attachment(&account_id)?;
            drop(execution_guard);
            Ok((grant.attachment_id, replica_revision, publication, prepared_publications))
        }.await;
        drop(item_guard);
        let (attachment_id, replica_revision, publication, prepared_publications) = upload_result?;
        if let Some(prepared_publications) = prepared_publications {
            prepared_publications.publish(publication);
        }
        Ok(RuntimeResponse::AttachmentUploaded {
            attachment_id,
            replica_revision,
        })
        }.await;
        source.close_until_clean().await;
        drop(teardown_admission);
        result
    }

    pub(super) async fn delete_attachment(
        &self,
        account_id: AccountId,
        attachment_id: String,
        cancellation: RequestCancellation,
        teardown_admission: tokio::sync::RwLockReadGuard<'_, ()>,
    ) -> Result<RuntimeResponse, RuntimeError> {
        let initial = self.require_snapshot(&account_id)?;
        if initial.failure.is_some() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::AccountFailed,
                "the selected Account module has failed",
            ));
        }
        let (item_id, vault_id) = find_attachment_address(&initial, &attachment_id)?;
        let item_lock = self.item_mutation_lock(&account_id, &item_id);
        let item_guard = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(cancelled()),
            guard = item_lock.lock() => guard,
        };
        let execution_lock = self.account_execution_lock(&account_id)?;
        let execution_guard = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(cancelled()),
            guard = execution_lock.lock() => guard,
        };
        self.ensure_attachment_admission(&account_id, &cancellation)?;
        let snapshot = self.require_snapshot(&account_id)?;
        let (current_item_id, current_vault_id) =
            find_attachment_address(&snapshot, &attachment_id)?;
        if current_item_id != item_id || current_vault_id != vault_id {
            return Err(retryable("Attachment authority changed before Delete"));
        }
        if item_has_optimistic_owner(&snapshot, &item_id) {
            return Err(retryable(
                "an optimistic Item owner must reconcile before Attachment Delete",
            ));
        }
        let (_, vault) = attachment_and_vault(&snapshot, &attachment_id)?;
        if vault.role == AuthorityVaultRole::ReadOnly {
            return Err(RuntimeError::new(
                RuntimeErrorCode::ReadOnly,
                "the Attachment belongs to a read-only Vault",
            ));
        }
        let foreground_guard = self.foreground_attachments.register(
            &account_id,
            &snapshot.incarnation,
            cancellation.clone(),
        )?;
        let auth_config = self.auth_client_config.clone().ok_or_else(|| {
            RuntimeError::new(
                RuntimeErrorCode::AuthenticationUnavailable,
                "authentication is not configured for this Runtime",
            )
        })?;
        drop(execution_guard);

        let metadata = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(cancelled()),
            result = self.platform_storage.load_account_metadata(&account_id, &snapshot.incarnation) => {
                result.map_err(|_| retryable("Account metadata could not be loaded"))?
                    .ok_or_else(authentication_required)?
            }
        };
        let mut session = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(cancelled()),
            result = self.platform_storage.load_current_session(&account_id, &snapshot.incarnation) => {
                result.map_err(|_| retryable("Session could not be loaded"))?
                    .ok_or_else(authentication_required)?
            }
        };
        let http = AuthHttpClient::new(
            &self.http_transport,
            &metadata.normalized_server_url,
            metadata.insecure_transport_confirmed,
            auth_config,
        )?;
        let mut renewed = false;
        let mut deletion = http
            .delete_attachment(session.token.as_ref(), &attachment_id, cancellation.clone())
            .await?;
        if matches!(deletion, AuthenticatedOutcome::ReauthenticationRequired) {
            renew_once(
                self,
                &account_id,
                &http,
                &mut session,
                &mut renewed,
                cancellation.clone(),
            )
            .await?;
            deletion = http
                .delete_attachment(session.token.as_ref(), &attachment_id, cancellation.clone())
                .await?;
        }
        match deletion {
            AuthenticatedOutcome::Ok(
                AttachmentDeleteAnswer::Deleted
                | AttachmentDeleteAnswer::Ambiguous
                | AttachmentDeleteAnswer::Missing,
            )
            | AuthenticatedOutcome::Transient => {}
            AuthenticatedOutcome::Ok(AttachmentDeleteAnswer::AccessDenied) => {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::AccessDenied,
                    "Attachment Delete was denied",
                ));
            }
            AuthenticatedOutcome::ReauthenticationRequired => {
                self.mark_reauthentication_required(&account_id);
                return Err(authentication_required());
            }
        }

        let item = fetch_item_authority(
            self,
            &http,
            AttachmentAuthority {
                account_id: &account_id,
                item_id: &item_id,
                attachment_id: &attachment_id,
                expectation: AttachmentAuthorityExpectation::Deleted {
                    vault_id: &vault_id,
                },
                cancellation: cancellation.clone(),
            },
            &mut session,
            &mut renewed,
        )
        .await?;
        if cancellation.is_cancelled() {
            return Err(cancelled());
        }

        let execution_guard = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(cancelled()),
            guard = execution_lock.lock() => guard,
        };
        self.ensure_attachment_admission(&account_id, &cancellation)?;
        let current = self.require_snapshot(&account_id)?;
        if current.incarnation != snapshot.incarnation {
            return Err(retryable(
                "Account incarnation changed before Attachment Delete publication",
            ));
        }
        let result = self
            .replica
            .execute_foreground_attachment_exact(ForegroundAttachmentCommitPlan::new(
                account_id.clone(),
                snapshot.incarnation.clone(),
                snapshot.revision,
                snapshot.lock_epoch,
                attachment_id.clone(),
                false,
                item,
            ))
            .await?;
        match result {
            ForegroundAttachmentCommitResult::Applied { .. } => {}
            ForegroundAttachmentCommitResult::StaleReplica { .. }
            | ForegroundAttachmentCommitResult::StaleAuthority { .. } => {
                return Err(retryable(
                    "Replica authority changed before Attachment Delete publication",
                ));
            }
            ForegroundAttachmentCommitResult::Missing => {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::AccountMissing,
                    "Account disappeared before Attachment Delete publication",
                ));
            }
        };
        let publication = self.foreground_attachments.publication(&foreground_guard);
        let prepared_publications =
            self.decrypt_visible_items_for_foreground_attachment(&account_id)?;
        let response = RuntimeResponse::AttachmentDeleted {
            account_id,
            attachment_id,
        };
        drop(execution_guard);
        drop(foreground_guard);
        drop(item_guard);
        drop(teardown_admission);
        if let Some(prepared_publications) = prepared_publications {
            prepared_publications.publish(publication);
        }
        Ok(response)
    }

    pub(super) async fn rename_attachment(
        &self,
        account_id: AccountId,
        attachment_id: String,
        name: String,
        cancellation: RequestCancellation,
        teardown_admission: tokio::sync::RwLockReadGuard<'_, ()>,
    ) -> Result<RuntimeResponse, RuntimeError> {
        validate_rename_name(&name)?;
        let initial = self.require_snapshot(&account_id)?;
        if initial.failure.is_some() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::AccountFailed,
                "the selected Account module has failed",
            ));
        }
        let (item_id, _) = find_attachment_address(&initial, &attachment_id)?;
        let item_lock = self.item_mutation_lock(&account_id, &item_id);
        let item_guard = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(cancelled()),
            guard = item_lock.lock() => guard,
        };
        let execution_lock = self.account_execution_lock(&account_id)?;
        let execution_guard = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(cancelled()),
            guard = execution_lock.lock() => guard,
        };
        self.ensure_attachment_admission(&account_id, &cancellation)?;
        let snapshot = self.require_snapshot(&account_id)?;
        let (current_item_id, _) = find_attachment_address(&snapshot, &attachment_id)?;
        if current_item_id != item_id {
            return Err(retryable("Attachment authority changed before Rename"));
        }
        if item_has_optimistic_owner(&snapshot, &item_id) {
            return Err(retryable(
                "an optimistic Item owner must reconcile before Attachment Rename",
            ));
        }
        let (source_attachment, vault) = attachment_and_vault(&snapshot, &attachment_id)?;
        if vault.role == AuthorityVaultRole::ReadOnly {
            return Err(RuntimeError::new(
                RuntimeErrorCode::ReadOnly,
                "the Attachment belongs to a read-only Vault",
            ));
        }
        let foreground_guard = self.foreground_attachments.register(
            &account_id,
            &snapshot.incarnation,
            cancellation.clone(),
        )?;
        let body = encrypt_attachment_name(self, &snapshot, &source_attachment, &vault, &name)?;
        let auth_config = self.auth_client_config.clone().ok_or_else(|| {
            RuntimeError::new(
                RuntimeErrorCode::AuthenticationUnavailable,
                "authentication is not configured for this Runtime",
            )
        })?;
        drop(execution_guard);

        let metadata = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(cancelled()),
            result = self.platform_storage.load_account_metadata(&account_id, &snapshot.incarnation) => {
                result.map_err(|_| retryable("Account metadata could not be loaded"))?
                    .ok_or_else(authentication_required)?
            }
        };
        let mut session = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(cancelled()),
            result = self.platform_storage.load_current_session(&account_id, &snapshot.incarnation) => {
                result.map_err(|_| retryable("Session could not be loaded"))?
                    .ok_or_else(authentication_required)?
            }
        };
        let http = AuthHttpClient::new(
            &self.http_transport,
            &metadata.normalized_server_url,
            metadata.insecure_transport_confirmed,
            auth_config,
        )?;
        let mut renewed = false;
        let mut rename = http
            .rename_attachment(
                session.token.as_ref(),
                &attachment_id,
                &body,
                cancellation.clone(),
            )
            .await?;
        if matches!(rename, AuthenticatedOutcome::ReauthenticationRequired) {
            renew_once(
                self,
                &account_id,
                &http,
                &mut session,
                &mut renewed,
                cancellation.clone(),
            )
            .await?;
            rename = http
                .rename_attachment(
                    session.token.as_ref(),
                    &attachment_id,
                    &body,
                    cancellation.clone(),
                )
                .await?;
        }
        let ambiguous = match rename {
            AuthenticatedOutcome::Ok(AttachmentRenameAnswer::Updated) => false,
            AuthenticatedOutcome::Ok(AttachmentRenameAnswer::Ambiguous) => true,
            AuthenticatedOutcome::Ok(AttachmentRenameAnswer::Missing) => {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::AuthorityMissing,
                    "Attachment authority is missing",
                ));
            }
            AuthenticatedOutcome::Ok(AttachmentRenameAnswer::AccessDenied) => {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::AccessDenied,
                    "Attachment Rename was denied",
                ));
            }
            AuthenticatedOutcome::ReauthenticationRequired => {
                self.mark_reauthentication_required(&account_id);
                return Err(authentication_required());
            }
            AuthenticatedOutcome::Transient => true,
        };

        let item = fetch_item_authority(
            self,
            &http,
            AttachmentAuthority {
                account_id: &account_id,
                item_id: &item_id,
                attachment_id: &attachment_id,
                expectation: AttachmentAuthorityExpectation::Renamed {
                    body: &body,
                    source_attachment: &source_attachment,
                },
                cancellation: cancellation.clone(),
            },
            &mut session,
            &mut renewed,
        )
        .await?;
        if cancellation.is_cancelled() {
            return Err(cancelled());
        }
        if ambiguous && !attachment_matches_rename(&item, &attachment_id, &body) {
            return Err(retryable(
                "authoritative state did not prove the ambiguous Attachment Rename",
            ));
        }

        let execution_guard = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(cancelled()),
            guard = execution_lock.lock() => guard,
        };
        self.ensure_attachment_admission(&account_id, &cancellation)?;
        let current = self.require_snapshot(&account_id)?;
        if current.incarnation != snapshot.incarnation {
            return Err(retryable(
                "Account incarnation changed before Attachment Rename publication",
            ));
        }
        let result = self
            .replica
            .execute_foreground_attachment_exact(ForegroundAttachmentCommitPlan::new(
                account_id.clone(),
                snapshot.incarnation.clone(),
                snapshot.revision,
                snapshot.lock_epoch,
                attachment_id.clone(),
                true,
                item,
            ))
            .await?;
        match result {
            ForegroundAttachmentCommitResult::Applied { .. } => {}
            ForegroundAttachmentCommitResult::StaleReplica { .. }
            | ForegroundAttachmentCommitResult::StaleAuthority { .. } => {
                return Err(retryable(
                    "Replica authority changed before Attachment Rename publication",
                ));
            }
            ForegroundAttachmentCommitResult::Missing => {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::AccountMissing,
                    "Account disappeared before Attachment Rename publication",
                ));
            }
        };
        let publication = self.foreground_attachments.publication(&foreground_guard);
        let prepared_publications =
            self.decrypt_visible_items_for_foreground_attachment(&account_id)?;
        let response = RuntimeResponse::AttachmentRenamed {
            account_id,
            attachment_id,
        };
        drop(execution_guard);
        drop(foreground_guard);
        drop(item_guard);
        drop(teardown_admission);
        if let Some(prepared_publications) = prepared_publications {
            prepared_publications.publish(publication);
        }
        Ok(response)
    }

    fn ensure_attachment_admission(
        &self,
        account_id: &AccountId,
        cancellation: &RequestCancellation,
    ) -> Result<(), RuntimeError> {
        self.ensure_open()?;
        if cancellation.is_cancelled() || self.account_access_retirement_is_pending(account_id) {
            return Err(cancelled());
        }
        if self
            .account_access
            .lock()
            .expect("Account access lock poisoned")
            .get(account_id)
            != Some(&AccountAccessState::Unlocked)
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::AuthenticationRequired,
                "foreground Attachment mutation requires an unlocked Account",
            ));
        }
        Ok(())
    }
}

pub(super) fn is_canonical_sink_capability_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'~' | b'-'))
}

fn item_has_optimistic_owner(snapshot: &crate::replica::ReplicaSnapshot, item_id: &str) -> bool {
    snapshot
        .operations
        .iter()
        .any(|operation| operation.item_id == item_id)
        || snapshot
            .attachment_move_preparations
            .iter()
            .any(|preparation| preparation.item_id == item_id)
        || snapshot
            .items
            .iter()
            .any(|overlay| overlay.item_id == item_id)
}

fn validate_upload_input(
    name: &str,
    content_type: &str,
    file_size: u64,
    capability: &str,
) -> Result<(), RuntimeError> {
    if name.trim().is_empty() || name.len() > 255 {
        return Err(size_rejected("Attachment name is invalid"));
    }
    if content_type.trim().is_empty() || content_type.len() > 255 {
        return Err(size_rejected("Attachment content type is invalid"));
    }
    if file_size == 0 || file_size > i32::MAX as u64 {
        return Err(size_rejected("Attachment size is invalid"));
    }
    if !is_canonical_sink_capability_id(capability) {
        return Err(invariant("Attachment Upload source capability is invalid"));
    }
    Ok(())
}

fn encrypted_attachment_storage_size(file_size: u64) -> Result<u64, RuntimeError> {
    let b64 = |length: u64| length.checked_add(2).map(|value| value / 3 * 4);
    let plaintext = b64(file_size).ok_or_else(|| size_rejected("Attachment is too large"))?;
    let ciphertext = b64(plaintext
        .checked_add(16)
        .ok_or_else(|| size_rejected("Attachment is too large"))?)
    .ok_or_else(|| size_rejected("Attachment is too large"))?;
    40_u64
        .checked_add(ciphertext)
        .and_then(|value| value.checked_add(16))
        .and_then(|value| value.checked_add(14))
        .ok_or_else(|| size_rejected("Attachment is too large"))
}

fn item_and_vault(
    snapshot: &crate::replica::ReplicaSnapshot,
    item_id: &str,
) -> Result<(AuthorityItemRecord, crate::replica::AuthorityVaultRecord), RuntimeError> {
    let bootstrap = snapshot.bootstrap.snapshot();
    let item = bootstrap
        .visible_items
        .iter()
        .find(|item| item.id == item_id)
        .cloned()
        .ok_or_else(|| {
            RuntimeError::new(
                RuntimeErrorCode::AuthorityMissing,
                "Item authority is missing",
            )
        })?;
    let vault = bootstrap
        .visible_vaults
        .iter()
        .find(|vault| vault.id == item.vault_id)
        .cloned()
        .ok_or_else(|| invariant("Item Vault authority is missing"))?;
    Ok((item, vault))
}

struct UploadCryptoAuthority {
    attachment_key: Zeroizing<[u8; 32]>,
    vault_key: Zeroizing<Vec<u8>>,
    vault_id: String,
    user_id: String,
    name: String,
    content_type: String,
}
struct PreparedUploadCrypto {
    attachment_key: Zeroizing<[u8; 32]>,
    encrypted_attachment_key: EncryptedData,
    encrypted_name: EncryptedData,
    encrypted_content_type: EncryptedData,
}
impl UploadCryptoAuthority {
    fn seal(self, attachment_id: &str) -> Result<PreparedUploadCrypto, RuntimeError> {
        let scope = |kind: &str| AadContext {
            vault_id: self.vault_id.clone(),
            entity_id: attachment_id.to_owned(),
            entity_type: kind.into(),
            version: 1,
            user_id: self.user_id.clone(),
        };
        let encrypted_attachment_key = encrypt_with_aad(
            &BASE64.encode(*self.attachment_key),
            &self.vault_key,
            &scope("attachment_key"),
        )
        .map_err(|_| invariant("Attachment key could not be sealed"))?;
        let encrypted_name = encrypt_with_aad(
            &self.name,
            self.attachment_key.as_slice(),
            &scope("attachment_name"),
        )
        .map_err(|_| invariant("Attachment name could not be encrypted"))?;
        let encrypted_content_type = encrypt_with_aad(
            &self.content_type,
            self.attachment_key.as_slice(),
            &scope("attachment_content_type"),
        )
        .map_err(|_| invariant("Attachment content type could not be encrypted"))?;
        Ok(PreparedUploadCrypto {
            attachment_key: self.attachment_key,
            encrypted_attachment_key,
            encrypted_name,
            encrypted_content_type,
        })
    }
}
impl PreparedUploadCrypto {
    fn into_body(
        self,
        attachment_id: String,
        storage_key: String,
        file_size: i32,
    ) -> CreateAttachmentBody {
        CreateAttachmentBody {
            attachment_id,
            storage_key,
            encrypted_attachment_key: self.encrypted_attachment_key.ciphertext,
            attachment_key_iv: self.encrypted_attachment_key.iv,
            attachment_key_algorithm: self.encrypted_attachment_key.algorithm,
            envelope_version: 1,
            encrypted_name: self.encrypted_name.ciphertext,
            encrypted_content_type: self.encrypted_content_type.ciphertext,
            encryption_iv: self.encrypted_name.iv,
            encrypted_content_type_iv: self.encrypted_content_type.iv,
            encryption_algorithm: self.encrypted_name.algorithm,
            file_size,
        }
    }
}

fn prepare_upload_crypto(
    runtime: &Runtime,
    snapshot: &crate::replica::ReplicaSnapshot,
    vault: &crate::replica::AuthorityVaultRecord,
    name: &str,
    content_type: &str,
) -> Result<UploadCryptoAuthority, RuntimeError> {
    let muk = runtime
        .copy_live_master_unlock_key(&snapshot.account_id, &snapshot.incarnation)
        .ok_or_else(authentication_required)?;
    let wrapped: WrappedVaultKeyData = serde_json::from_str(&vault.encrypted_vault_key)
        .map_err(|_| invariant("Vault key authority is malformed"))?;
    if wrapped.context.vault_id != vault.id || wrapped.context.user_id != snapshot.user_id {
        return Err(invariant(
            "Vault key authority scope does not match the Account",
        ));
    }
    let vault_key = Zeroizing::new(
        decrypt_vault_key_with_muk(&vault.encrypted_vault_key, muk.as_slice(), &wrapped.context)
            .map_err(|_| invariant("Vault key could not be opened"))?,
    );
    let attachment_key = Zeroizing::new(generate_encryption_key());
    Ok(UploadCryptoAuthority {
        attachment_key,
        vault_key,
        vault_id: vault.id.clone(),
        user_id: snapshot.user_id.clone(),
        name: name.to_owned(),
        content_type: content_type.to_owned(),
    })
}

fn upload_source_error(error: AttachmentUploadSourceError) -> RuntimeError {
    match error {
        AttachmentUploadSourceError::Source => RuntimeError::new(
            RuntimeErrorCode::SourceFailure,
            "Attachment Upload source failed",
        ),
        AttachmentUploadSourceError::Cancelled => cancelled(),
        AttachmentUploadSourceError::Invariant => {
            invariant("Attachment Upload source violated its contract")
        }
    }
}
fn upload_transfer_error(error: AttachmentMoveTransferError) -> RuntimeError {
    match error {
        AttachmentMoveTransferError::Transient | AttachmentMoveTransferError::Busy => {
            retryable("Attachment binary upload failed")
        }
        AttachmentMoveTransferError::StaleAuthority => {
            retryable("Attachment upload authority became stale")
        }
        AttachmentMoveTransferError::Invariant => {
            invariant("Attachment binary executor violated its contract")
        }
    }
}

struct AttachmentAuthority<'a> {
    account_id: &'a AccountId,
    item_id: &'a str,
    attachment_id: &'a str,
    expectation: AttachmentAuthorityExpectation<'a>,
    cancellation: RequestCancellation,
}

enum AttachmentAuthorityExpectation<'a> {
    Renamed {
        body: &'a UpdateAttachmentBody,
        source_attachment: &'a AuthorityAttachmentRecord,
    },
    Deleted {
        vault_id: &'a str,
    },
    Uploaded {
        vault_id: &'a str,
        uploaded_by: &'a str,
        body: &'a CreateAttachmentBody,
    },
}

async fn fetch_item_authority(
    runtime: &Runtime,
    http: &AuthHttpClient<'_>,
    authority: AttachmentAuthority<'_>,
    session: &mut CurrentSessionDocument,
    renewed: &mut bool,
) -> Result<AuthorityItemRecord, RuntimeError> {
    let AttachmentAuthority {
        account_id,
        item_id,
        attachment_id,
        expectation,
        cancellation,
    } = authority;
    let mut item = http
        .fetch_item_or_absent_for_attachment(session.token.as_ref(), item_id, cancellation.clone())
        .await
        .map_err(authority_probe_error)?;
    if matches!(item, AuthenticatedOutcome::ReauthenticationRequired) {
        renew_once(
            runtime,
            account_id,
            http,
            session,
            renewed,
            cancellation.clone(),
        )
        .await?;
        item = http
            .fetch_item_or_absent_for_attachment(
                session.token.as_ref(),
                item_id,
                cancellation.clone(),
            )
            .await
            .map_err(authority_probe_error)?;
    }
    let item = classify_authority(item, runtime, account_id, "Item")?.ok_or_else(|| {
        RuntimeError::new(
            RuntimeErrorCode::AuthorityMissing,
            "Item authority is missing",
        )
    })?;
    if item.id != item_id {
        return Err(RuntimeError::new(
            RuntimeErrorCode::InvariantViolation,
            "Item authority returned a foreign identity",
        ));
    }
    let item_vault_id = item.vault_id.clone();

    let mut attachments = http
        .fetch_attachment_authority(session.token.as_ref(), item_id, cancellation.clone())
        .await
        .map_err(authority_probe_error)?;
    if matches!(attachments, AuthenticatedOutcome::ReauthenticationRequired) {
        renew_once(
            runtime,
            account_id,
            http,
            session,
            renewed,
            cancellation.clone(),
        )
        .await?;
        attachments = http
            .fetch_attachment_authority(session.token.as_ref(), item_id, cancellation)
            .await
            .map_err(authority_probe_error)?;
    }
    let attachments = classify_authority(attachments, runtime, account_id, "Attachment")?;
    if attachments.iter().any(|attachment| {
        attachment.id != attachment_id
            && (attachment.item_id != item.id || attachment.vault_id != item.vault_id)
    }) {
        return Err(RuntimeError::new(
            RuntimeErrorCode::InvariantViolation,
            "foreign Attachment authority appeared on the Item endpoint",
        ));
    }
    if attachments
        .iter()
        .find(|attachment| attachment.id == attachment_id)
        .is_some_and(|attachment| {
            attachment.item_id != item.id || attachment.vault_id != item.vault_id
        })
    {
        return Err(retryable(
            "Attachment address authority changed during probe",
        ));
    }
    let mut authority = super::bootstrap::authority_item_from_dto(item)?;
    authority.attachments = attachments
        .into_iter()
        .map(authority_attachment_from_dto)
        .collect();
    match expectation {
        AttachmentAuthorityExpectation::Renamed {
            body,
            source_attachment,
        } => {
            if !attachment_matches_rename(&authority, attachment_id, body) {
                return Err(retryable(
                    "authoritative state did not retain the requested Attachment Rename",
                ));
            }
            let fetched_attachment = authority
                .attachments
                .iter()
                .find(|attachment| attachment.id == attachment_id)
                .expect("the requested Attachment was matched above");
            if !attachment_key_authority_is_unchanged(source_attachment, fetched_attachment) {
                return Err(retryable(
                    "Attachment key-envelope authority changed during Rename",
                ));
            }
        }
        AttachmentAuthorityExpectation::Deleted { vault_id } => {
            if item_vault_id != vault_id {
                return Err(retryable(
                    "owning Item authority changed during Attachment Delete",
                ));
            }
            if authority
                .attachments
                .iter()
                .any(|attachment| attachment.id == attachment_id)
            {
                return Err(retryable(
                    "authoritative state did not prove the Attachment Delete",
                ));
            }
        }
        AttachmentAuthorityExpectation::Uploaded {
            vault_id,
            uploaded_by,
            body,
        } => {
            if item_vault_id != vault_id {
                return Err(retryable(
                    "owning Item authority changed during Attachment Upload",
                ));
            }
            let Some(uploaded) = authority
                .attachments
                .iter()
                .find(|attachment| attachment.id == attachment_id)
            else {
                return Err(retryable(
                    "authoritative state did not prove the Attachment Upload",
                ));
            };
            if uploaded.item_id != item_id
                || uploaded.vault_id != vault_id
                || uploaded.storage_key != body.storage_key
                || uploaded.encrypted_attachment_key != body.encrypted_attachment_key
                || uploaded.attachment_key_iv != body.attachment_key_iv
                || uploaded.attachment_key_algorithm != body.attachment_key_algorithm
                || uploaded.envelope_version != body.envelope_version
                || uploaded.encrypted_name != body.encrypted_name
                || uploaded.encrypted_content_type != body.encrypted_content_type
                || uploaded.encryption_iv != body.encryption_iv
                || uploaded.encrypted_content_type_iv != body.encrypted_content_type_iv
                || uploaded.encryption_algorithm != body.encryption_algorithm
                || uploaded.file_size != body.file_size
                || uploaded.uploaded_by != uploaded_by
            {
                return Err(retryable(
                    "authoritative Attachment Upload effect did not match exactly",
                ));
            }
        }
    }
    Ok(authority)
}

fn classify_authority<T>(
    result: AuthenticatedOutcome<T>,
    runtime: &Runtime,
    account_id: &AccountId,
    entity: &str,
) -> Result<T, RuntimeError> {
    match result {
        AuthenticatedOutcome::Ok(value) => Ok(value),
        AuthenticatedOutcome::Transient => Err(retryable(format!(
            "{entity} authority could not be fetched"
        ))),
        AuthenticatedOutcome::ReauthenticationRequired => {
            runtime.mark_reauthentication_required(account_id);
            Err(authentication_required())
        }
    }
}

fn authority_probe_error(error: RuntimeError) -> RuntimeError {
    if error.code == RuntimeErrorCode::AuthenticationUnavailable {
        RuntimeError::new(
            RuntimeErrorCode::InvariantViolation,
            "Attachment authority response violated the protocol",
        )
    } else {
        error
    }
}

async fn renew_once(
    runtime: &Runtime,
    account_id: &AccountId,
    http: &AuthHttpClient<'_>,
    session: &mut CurrentSessionDocument,
    renewed: &mut bool,
    cancellation: RequestCancellation,
) -> Result<(), RuntimeError> {
    if *renewed {
        runtime.mark_reauthentication_required(account_id);
        return Err(authentication_required());
    }
    *renewed = true;
    *session = runtime
        .renew_session(account_id, session, http, cancellation)
        .await
        .map_err(|error| {
            if error.code == RuntimeErrorCode::AuthenticationRequired {
                runtime.mark_reauthentication_required(account_id);
                error
            } else if (error.code == RuntimeErrorCode::AuthenticationUnavailable
                && error.message == "Server request failed")
                || (error.code == RuntimeErrorCode::InvariantViolation
                    && error.message == "Session refresh failed")
            {
                retryable("Session renewal failed")
            } else {
                error
            }
        })?;
    Ok(())
}

fn find_attachment_address(
    snapshot: &crate::replica::ReplicaSnapshot,
    attachment_id: &str,
) -> Result<(String, String), RuntimeError> {
    let bootstrap = snapshot.bootstrap.snapshot();
    let found: Vec<_> = bootstrap
        .visible_items
        .iter()
        .flat_map(|item| {
            item.attachments
                .iter()
                .filter(move |attachment| attachment.id == attachment_id)
                .map(move |attachment| (item.id.clone(), attachment.vault_id.clone()))
        })
        .collect();
    match found.as_slice() {
        [(item_id, vault_id)] => Ok((item_id.clone(), vault_id.clone())),
        [] => Err(RuntimeError::new(
            RuntimeErrorCode::AuthorityMissing,
            "Attachment authority is missing",
        )),
        _ => Err(RuntimeError::new(
            RuntimeErrorCode::InvariantViolation,
            "Attachment identity is duplicated in the Replica",
        )),
    }
}

fn attachment_and_vault(
    snapshot: &crate::replica::ReplicaSnapshot,
    attachment_id: &str,
) -> Result<
    (
        AuthorityAttachmentRecord,
        crate::replica::AuthorityVaultRecord,
    ),
    RuntimeError,
> {
    let bootstrap = snapshot.bootstrap.snapshot();
    let attachment = bootstrap
        .visible_items
        .iter()
        .flat_map(|item| &item.attachments)
        .find(|attachment| attachment.id == attachment_id)
        .ok_or_else(|| {
            RuntimeError::new(RuntimeErrorCode::AuthorityMissing, "Attachment missing")
        })?;
    let vault = bootstrap
        .visible_vaults
        .iter()
        .find(|vault| vault.id == attachment.vault_id)
        .ok_or_else(|| {
            RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "Attachment Vault authority is missing",
            )
        })?;
    Ok((attachment.clone(), vault.clone()))
}

fn encrypt_attachment_name(
    runtime: &Runtime,
    snapshot: &crate::replica::ReplicaSnapshot,
    attachment: &AuthorityAttachmentRecord,
    vault: &crate::replica::AuthorityVaultRecord,
    name: &str,
) -> Result<UpdateAttachmentBody, RuntimeError> {
    let muk = runtime
        .copy_live_master_unlock_key(&snapshot.account_id, &snapshot.incarnation)
        .ok_or_else(authentication_required)?;
    let wrapped: WrappedVaultKeyData =
        serde_json::from_str(&vault.encrypted_vault_key).map_err(|_| {
            RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "Vault key authority is malformed",
            )
        })?;
    if wrapped.context.vault_id != vault.id || wrapped.context.user_id != snapshot.user_id {
        return Err(RuntimeError::new(
            RuntimeErrorCode::InvariantViolation,
            "Vault key authority scope does not match the Account",
        ));
    }
    let vault_key = Zeroizing::new(
        decrypt_vault_key_with_muk(&vault.encrypted_vault_key, muk.as_slice(), &wrapped.context)
            .map_err(|_| {
                RuntimeError::new(
                    RuntimeErrorCode::InvariantViolation,
                    "Vault key could not be opened",
                )
            })?,
    );
    let scope = |entity_type: &str, version: u64| AadContext {
        vault_id: attachment.vault_id.clone(),
        entity_id: attachment.id.clone(),
        entity_type: entity_type.to_owned(),
        version,
        user_id: attachment.uploaded_by.clone(),
    };
    let mut encoded_key = decrypt_with_aad(
        &EncryptedData {
            ciphertext: attachment.encrypted_attachment_key.clone(),
            iv: attachment.attachment_key_iv.clone(),
            algorithm: attachment.attachment_key_algorithm.clone(),
        },
        &vault_key,
        &scope("attachment_key", attachment.envelope_version as u64),
    )
    .map_err(|_| {
        RuntimeError::new(
            RuntimeErrorCode::InvariantViolation,
            "Attachment key could not be opened",
        )
    })?;
    let attachment_key = Zeroizing::new(BASE64.decode(encoded_key.as_bytes()).map_err(|_| {
        RuntimeError::new(
            RuntimeErrorCode::InvariantViolation,
            "Attachment key is malformed",
        )
    })?);
    encoded_key.zeroize();
    if attachment_key.len() != 32 {
        return Err(RuntimeError::new(
            RuntimeErrorCode::InvariantViolation,
            "Attachment key has an invalid length",
        ));
    }
    let encrypted =
        encrypt_with_aad(name, &attachment_key, &scope("attachment_name", 1)).map_err(|_| {
            RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "Attachment name could not be encrypted",
            )
        })?;
    Ok(UpdateAttachmentBody {
        encrypted_name: encrypted.ciphertext,
        encryption_iv: encrypted.iv,
        encryption_algorithm: encrypted.algorithm,
    })
}

fn open_attachment_key(
    runtime: &Runtime,
    snapshot: &crate::replica::ReplicaSnapshot,
    attachment: &AuthorityAttachmentRecord,
    vault: &crate::replica::AuthorityVaultRecord,
) -> Result<Zeroizing<[u8; 32]>, RuntimeError> {
    let muk = runtime
        .copy_live_master_unlock_key(&snapshot.account_id, &snapshot.incarnation)
        .ok_or_else(authentication_required)?;
    let wrapped: WrappedVaultKeyData = serde_json::from_str(&vault.encrypted_vault_key)
        .map_err(|_| invariant("Vault key authority is malformed"))?;
    if wrapped.context.vault_id != vault.id || wrapped.context.user_id != snapshot.user_id {
        return Err(invariant(
            "Vault key authority scope does not match the Account",
        ));
    }
    let vault_key = Zeroizing::new(
        decrypt_vault_key_with_muk(&vault.encrypted_vault_key, muk.as_slice(), &wrapped.context)
            .map_err(|_| invariant("Vault key could not be opened"))?,
    );
    let scope = AadContext {
        vault_id: attachment.vault_id.clone(),
        entity_id: attachment.id.clone(),
        entity_type: "attachment_key".into(),
        version: attachment.envelope_version as u64,
        user_id: attachment.uploaded_by.clone(),
    };
    let mut encoded_key = decrypt_with_aad(
        &EncryptedData {
            ciphertext: attachment.encrypted_attachment_key.clone(),
            iv: attachment.attachment_key_iv.clone(),
            algorithm: attachment.attachment_key_algorithm.clone(),
        },
        &vault_key,
        &scope,
    )
    .map_err(|_| invariant("Attachment key could not be opened"))?;
    let decoded = Zeroizing::new(
        BASE64
            .decode(encoded_key.as_bytes())
            .map_err(|_| invariant("Attachment key is malformed"))?,
    );
    encoded_key.zeroize();
    if decoded.len() != 32 {
        return Err(invariant("Attachment key has an invalid length"));
    }
    let mut key = [0_u8; 32];
    key.copy_from_slice(&decoded);
    Ok(Zeroizing::new(key))
}

fn validate_download_grant(
    answer: AttachmentDownloadGrantAnswer,
    source: &AuthorityAttachmentRecord,
) -> Result<AttachmentDownloadGrant, RuntimeError> {
    let grant = match answer {
        AttachmentDownloadGrantAnswer::Grant(grant) => *grant,
        AttachmentDownloadGrantAnswer::StaleAuthority => {
            return Err(RuntimeError::new(
                RuntimeErrorCode::AuthorityMissing,
                "Attachment authority is missing",
            ));
        }
        AttachmentDownloadGrantAnswer::AccessDenied => {
            return Err(RuntimeError::new(
                RuntimeErrorCode::AccessDenied,
                "Attachment Download was denied",
            ));
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
        return Err(retryable("Attachment download grant authority is stale"));
    }
    let url = url::Url::parse(&grant.download_url)
        .map_err(|_| invariant("Attachment download grant URL is invalid"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(invariant("Attachment download grant URL is invalid"));
    }
    Ok(grant)
}

fn attachment_response_bound(file_size: i32) -> Result<u64, RuntimeError> {
    let plaintext = u64::try_from(file_size)
        .map_err(|_| size_rejected("Attachment size authority is invalid"))?;
    let encoded_plaintext = base64_length(plaintext)?;
    let ciphertext = encoded_plaintext
        .checked_add(16)
        .ok_or_else(|| size_rejected("Attachment size is too large"))?;
    let encoded_ciphertext = base64_length(ciphertext)?;
    let fixed = (r#"{"ciphertext":""#.len()
        + r#"","iv":""#.len()
        + 16
        + r#"","algorithm":"AES-GCM-AAD-V1"}"#.len()) as u64;
    encoded_ciphertext
        .checked_add(fixed)
        .ok_or_else(|| size_rejected("Attachment size is too large"))
}

fn base64_length(length: u64) -> Result<u64, RuntimeError> {
    length
        .checked_add(2)
        .and_then(|value| value.checked_div(3))
        .and_then(|groups| groups.checked_mul(4))
        .ok_or_else(|| size_rejected("Attachment size is too large"))
}

fn download_transfer_error(error: AttachmentMoveTransferError) -> RuntimeError {
    match error {
        AttachmentMoveTransferError::Transient | AttachmentMoveTransferError::Busy => {
            retryable("Attachment binary download failed")
        }
        AttachmentMoveTransferError::StaleAuthority => {
            retryable("Attachment binary authority is stale")
        }
        AttachmentMoveTransferError::Invariant => {
            invariant("Attachment binary executor violated its contract")
        }
    }
}

fn sink_error(error: AttachmentDownloadSinkError) -> RuntimeError {
    match error {
        AttachmentDownloadSinkError::Sink => RuntimeError::new(
            RuntimeErrorCode::SinkFailure,
            "Attachment download sink failed",
        ),
        AttachmentDownloadSinkError::Cancelled => cancelled(),
        AttachmentDownloadSinkError::Invariant => {
            invariant("Attachment download sink violated its contract")
        }
    }
}

fn invariant(message: &str) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::InvariantViolation, message)
}

fn size_rejected(message: &str) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::SizeRejected, message)
}

pub(super) fn authority_attachment_from_dto(
    attachment: VaultAttachmentResponse,
) -> AuthorityAttachmentRecord {
    AuthorityAttachmentRecord {
        id: attachment.id,
        item_id: attachment.item_id,
        vault_id: attachment.vault_id,
        storage_key: attachment.storage_key,
        encrypted_name: attachment.encrypted_name,
        encryption_iv: attachment.encryption_iv,
        encryption_algorithm: attachment.encryption_algorithm,
        encrypted_attachment_key: attachment.encrypted_attachment_key,
        attachment_key_iv: attachment.attachment_key_iv,
        attachment_key_algorithm: attachment.attachment_key_algorithm,
        encrypted_content_type: attachment.encrypted_content_type,
        encrypted_content_type_iv: attachment.encrypted_content_type_iv,
        envelope_version: attachment.envelope_version,
        file_size: attachment.file_size,
        uploaded_by: attachment.uploaded_by,
        created_at: attachment.created_at,
    }
}

fn attachment_matches_rename(
    item: &AuthorityItemRecord,
    attachment_id: &str,
    body: &UpdateAttachmentBody,
) -> bool {
    item.attachments.iter().any(|attachment| {
        attachment.id == attachment_id
            && attachment.item_id == item.id
            && attachment.vault_id == item.vault_id
            && attachment.encrypted_name == body.encrypted_name
            && attachment.encryption_iv == body.encryption_iv
            && attachment.encryption_algorithm == body.encryption_algorithm
    })
}

fn attachment_key_authority_is_unchanged(
    source: &AuthorityAttachmentRecord,
    fetched: &AuthorityAttachmentRecord,
) -> bool {
    source.id == fetched.id
        && source.item_id == fetched.item_id
        && source.vault_id == fetched.vault_id
        && source.uploaded_by == fetched.uploaded_by
        && source.envelope_version == fetched.envelope_version
        && source.encrypted_attachment_key == fetched.encrypted_attachment_key
        && source.attachment_key_iv == fetched.attachment_key_iv
        && source.attachment_key_algorithm == fetched.attachment_key_algorithm
}

fn validate_rename_name(name: &str) -> Result<(), RuntimeError> {
    if name.trim().is_empty() || name.len() > 255 {
        return Err(RuntimeError::new(
            RuntimeErrorCode::SizeRejected,
            "Attachment name must contain between 1 and 255 UTF-8 bytes",
        ));
    }
    Ok(())
}

fn retryable(message: impl Into<String>) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::RetryableTransport, message)
}

fn authentication_required() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::AuthenticationRequired,
        "Session is missing or expired",
    )
}

fn cancelled() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::Cancelled,
        "Attachment Rename was cancelled",
    )
}
