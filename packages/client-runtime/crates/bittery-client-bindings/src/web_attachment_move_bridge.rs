use bittery_client_core::AttachmentMoveTransferError;
use std::{cell::Cell, sync::Arc};

#[derive(Clone, Copy)]
enum TransferFailureClass {
    Transient,
    Cancelled,
    Invariant,
}

struct OnceFlag(Cell<bool>);

impl OnceFlag {
    fn new() -> Self {
        Self(Cell::new(false))
    }

    fn take(&self) -> bool {
        !self.0.replace(true)
    }

    fn is_set(&self) -> bool {
        self.0.get()
    }
}

fn bridge_transfer_error(failure: TransferFailureClass) -> AttachmentMoveTransferError {
    match failure {
        TransferFailureClass::Transient | TransferFailureClass::Cancelled => {
            AttachmentMoveTransferError::Transient
        }
        TransferFailureClass::Invariant => AttachmentMoveTransferError::Invariant,
    }
}

struct TransferIds {
    prefix: [u8; 16],
    next: Cell<u64>,
}

#[derive(Debug, PartialEq, Eq)]
struct UploadControlIdentity {
    transfer_id: String,
    account_id: String,
    operation_id: String,
    attachment_id: String,
    artifact_id: String,
    spool_generation: String,
    ciphertext_sha256: String,
    byte_length: u64,
}

fn upload_control_identity(
    transfer_id: String,
    account_id: &str,
    operation_id: &str,
    attachment_id: &str,
    artifact_id: &str,
    ciphertext_sha256: &str,
    byte_length: u64,
) -> UploadControlIdentity {
    UploadControlIdentity {
        spool_generation: transfer_id.clone(),
        transfer_id,
        account_id: account_id.to_owned(),
        operation_id: operation_id.to_owned(),
        attachment_id: attachment_id.to_owned(),
        artifact_id: artifact_id.to_owned(),
        ciphertext_sha256: ciphertext_sha256.to_owned(),
        byte_length,
    }
}

struct DownloadControlInput {
    transfer_id: String,
    url: String,
    headers: Vec<(String, String)>,
    max_response_bytes: u64,
    max_chunk_bytes: u32,
}

fn download_control_input(
    transfer_id: String,
    request: bittery_client_core::AttachmentMoveDownloadRequest,
) -> DownloadControlInput {
    DownloadControlInput {
        transfer_id,
        url: request.download_url,
        headers: request.headers,
        max_response_bytes: request.max_response_bytes,
        max_chunk_bytes: request.max_chunk_bytes,
    }
}

#[cfg_attr(
    target_arch = "wasm32",
    allow(
        clippy::arc_with_non_send_sync,
        reason = "Core's artifact facade uses Arc while the Web store is confined to one Worker"
    )
)]
fn shared_artifact_ports<T>(
    artifacts: Arc<T>,
) -> (
    Arc<dyn bittery_client_core::ProvisionalAttachmentArtifactStore>,
    Arc<dyn bittery_client_core::AttachmentArtifactStore>,
)
where
    T: bittery_client_core::ProvisionalAttachmentArtifactStore
        + bittery_client_core::AttachmentArtifactStore
        + 'static,
{
    let provisional: Arc<dyn bittery_client_core::ProvisionalAttachmentArtifactStore> =
        artifacts.clone();
    let published: Arc<dyn bittery_client_core::AttachmentArtifactStore> = artifacts;
    (provisional, published)
}

fn exact_surface_names(mut actual: Vec<String>, expected: &[&str]) -> bool {
    actual.sort();
    let mut expected = expected
        .iter()
        .map(|name| (*name).to_owned())
        .collect::<Vec<_>>();
    expected.sort();
    actual == expected
}

fn lease_acquire_argument(account_id: &bittery_client_core::AccountId) -> String {
    account_id.as_str().to_owned()
}

fn lifecycle_error_json(error: &bittery_client_core::RuntimeError) -> String {
    serde_json::json!({
        "code": error.code,
        "message": "Attachment Move preparation lifecycle failed",
    })
    .to_string()
}

impl TransferIds {
    fn from_prefix(prefix: [u8; 16]) -> Self {
        Self {
            prefix,
            next: Cell::new(0),
        }
    }

    fn next(&self) -> Result<String, AttachmentMoveTransferError> {
        let sequence = self.next.get();
        self.next.set(
            sequence
                .checked_add(1)
                .ok_or(AttachmentMoveTransferError::Invariant)?,
        );
        Ok(format!("{}-{sequence:016x}", hex(&self.prefix)))
    }
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut encoded, "{byte:02x}").expect("writing to a String cannot fail");
    }
    encoded
}

#[cfg(target_arch = "wasm32")]
#[allow(
    clippy::arc_with_non_send_sync,
    reason = "Core's facade owns Arc ports while the Web composition is confined to one Worker"
)]
mod wasm {
    use super::{
        bridge_transfer_error, download_control_input, exact_surface_names, lease_acquire_argument,
        lifecycle_error_json, shared_artifact_ports, upload_control_identity, OnceFlag,
        TransferFailureClass, TransferIds,
    };
    use crate::{
        web_attachment_artifact_store::JsAttachmentArtifactStore,
        web_binary_transfer::{
            BinaryTransferFailure, JsBinaryTransferExecutor, JsSourceDownload, JsStagingUpload,
        },
        web_binary_transfer_policy::MAX_TRANSFER_CHUNK_BYTES,
    };
    use async_trait::async_trait;
    use bittery_client_core as core;
    use js_sys::{Function, Promise, Reflect};
    use std::{
        cell::{Cell, RefCell},
        collections::HashMap,
        future::Future,
        pin::Pin,
        rc::{Rc, Weak},
        sync::Arc,
        task::{Context, Poll, Waker},
    };
    use tokio::sync::Notify;
    use wasm_bindgen::{JsCast, JsValue};
    use wasm_bindgen_futures::{spawn_local, JsFuture};

    fn binary_error(failure: BinaryTransferFailure) -> core::AttachmentMoveTransferError {
        bridge_transfer_error(match failure {
            BinaryTransferFailure::Transient => TransferFailureClass::Transient,
            BinaryTransferFailure::Cancelled => TransferFailureClass::Cancelled,
            BinaryTransferFailure::Invariant => TransferFailureClass::Invariant,
        })
    }

    pub(crate) struct JsAttachmentMoveTransferPort {
        executor: Arc<JsBinaryTransferExecutor>,
        transfer_ids: TransferIds,
    }

    impl JsAttachmentMoveTransferPort {
        fn new(executor: Arc<JsBinaryTransferExecutor>) -> Result<Self, JsValue> {
            let mut prefix = [0_u8; 16];
            getrandom::fill(&mut prefix)
                .map_err(|_| JsValue::from_str("Binary transfer identity is unavailable"))?;
            Ok(Self {
                executor,
                transfer_ids: TransferIds::from_prefix(prefix),
            })
        }
    }

    struct Download(JsSourceDownload);

    #[async_trait(?Send)]
    impl core::AttachmentMoveDownload for Download {
        async fn next_chunk(
            &mut self,
        ) -> Result<Option<Vec<u8>>, core::AttachmentMoveTransferError> {
            self.0.next_chunk().await.map_err(binary_error)
        }
    }

    struct Upload(JsStagingUpload);

    #[async_trait(?Send)]
    impl core::AttachmentMoveUpload for Upload {
        async fn write_chunk(
            &mut self,
            bytes: &[u8],
        ) -> Result<(), core::AttachmentMoveTransferError> {
            self.0.write_chunk(bytes).await.map_err(binary_error)
        }

        async fn finish(self: Box<Self>) -> Result<(), core::AttachmentMoveTransferError> {
            self.0.finish().await.map_err(binary_error)
        }
    }

    #[async_trait(?Send)]
    impl core::AttachmentMoveTransferPort for JsAttachmentMoveTransferPort {
        async fn open_source(
            &self,
            request: core::AttachmentMoveDownloadRequest,
        ) -> Result<Box<dyn core::AttachmentMoveDownload>, core::AttachmentMoveTransferError>
        {
            let transfer_id = self.transfer_ids.next()?;
            let input = download_control_input(transfer_id, request);
            let max_chunk_bytes = usize::try_from(input.max_chunk_bytes)
                .map_err(|_| core::AttachmentMoveTransferError::Invariant)?;
            self.executor
                .open_download(
                    input.transfer_id,
                    input.url,
                    input.headers,
                    input.max_response_bytes,
                    max_chunk_bytes,
                )
                .await
                .map(|handle| Box::new(Download(handle)) as Box<dyn core::AttachmentMoveDownload>)
                .map_err(binary_error)
        }

        async fn open_upload(
            &self,
            account_id: &core::AccountId,
            operation_id: &str,
            grant: &core::AttachmentMoveUploadGrant,
            owner: &core::AttachmentArtifactOwner,
        ) -> Result<Box<dyn core::AttachmentMoveUpload>, core::AttachmentMoveTransferError>
        {
            if owner.account_id() != account_id
                || owner.operation_id() != operation_id
                || owner.attachment_id() != grant.attachment_id
            {
                return Err(core::AttachmentMoveTransferError::Invariant);
            }
            let transfer_id = self.transfer_ids.next()?;
            let identity = upload_control_identity(
                transfer_id,
                account_id.as_str(),
                operation_id,
                &grant.attachment_id,
                owner.artifact_id(),
                owner.ciphertext_sha256(),
                owner.byte_length(),
            );
            self.executor
                .open_upload(
                    identity.transfer_id,
                    identity.account_id,
                    identity.operation_id,
                    identity.attachment_id,
                    identity.artifact_id,
                    identity.spool_generation,
                    grant.upload_url.clone(),
                    Vec::new(),
                    identity.ciphertext_sha256,
                    identity.byte_length,
                    MAX_TRANSFER_CHUNK_BYTES,
                )
                .await
                .map(|handle| Box::new(Upload(handle)) as Box<dyn core::AttachmentMoveUpload>)
                .map_err(binary_error)
        }
    }

    struct LeaseState {
        handle: JsValue,
        released: OnceFlag,
        released_signal: Notify,
    }

    impl LeaseState {
        fn release(&self) {
            if !self.released.take() {
                return;
            }
            if let Ok(release) = function(&self.handle, "release") {
                let _ = release.call0(&self.handle);
            }
            self.released_signal.notify_one();
        }

        fn is_live(&self) -> bool {
            if self.released.is_set() {
                return false;
            }
            function(&self.handle, "isLive")
                .and_then(|live| live.call0(&self.handle))
                .ok()
                .and_then(|live| live.as_bool())
                .unwrap_or(false)
        }

        async fn lost(&self) {
            if !self.is_live() {
                return;
            }
            let lost = function(&self.handle, "lost")
                .and_then(|lost| lost.call0(&self.handle))
                .ok()
                .and_then(|lost| lost.dyn_into::<Promise>().ok());
            let Some(lost) = lost else {
                return;
            };
            tokio::select! {
                _ = JsFuture::from(lost) => {},
                _ = self.released_signal.notified() => {},
            }
        }
    }

    struct LeaseGuard {
        id: u64,
        state: Rc<LeaseState>,
        active: Rc<RefCell<HashMap<u64, Weak<LeaseState>>>>,
    }

    impl Drop for LeaseGuard {
        fn drop(&mut self) {
            self.state.release();
            self.active.borrow_mut().remove(&self.id);
        }
    }

    #[async_trait(?Send)]
    impl core::AttachmentMoveAccountLease for LeaseGuard {
        fn is_live(&self) -> bool {
            self.state.is_live()
        }

        async fn lost(&self) {
            self.state.lost().await;
        }
    }

    pub(crate) struct JsAttachmentMoveAccountLeasePort {
        executor: JsValue,
        next_id: Cell<u64>,
        active: Rc<RefCell<HashMap<u64, Weak<LeaseState>>>>,
        closed: Cell<bool>,
    }

    impl JsAttachmentMoveAccountLeasePort {
        fn new(executor: JsValue) -> Result<Self, JsValue> {
            validate_exact_surface(&executor, &["acquire"])?;
            Ok(Self {
                executor,
                next_id: Cell::new(0),
                active: Rc::new(RefCell::new(HashMap::new())),
                closed: Cell::new(false),
            })
        }

        fn close(&self) {
            self.closed.set(true);
            let active: Vec<_> = self
                .active
                .borrow()
                .values()
                .filter_map(Weak::upgrade)
                .collect();
            for state in active {
                state.release();
            }
            self.active.borrow_mut().clear();
        }

        #[cfg(feature = "binding-test-harness")]
        fn exhaust_identity_for_test(&self) {
            self.next_id.set(u64::MAX);
        }
    }

    #[async_trait(?Send)]
    impl core::AttachmentMoveAccountLeasePort for JsAttachmentMoveAccountLeasePort {
        async fn acquire(
            &self,
            account_id: &core::AccountId,
        ) -> Result<Option<Box<dyn core::AttachmentMoveAccountLease>>, core::RuntimeError> {
            if self.closed.get() {
                return Err(lease_error());
            }
            let acquire = function(&self.executor, "acquire").map_err(|_| lease_error())?;
            let promise = acquire
                .call1(
                    &self.executor,
                    &JsValue::from_str(&lease_acquire_argument(account_id)),
                )
                .map_err(|_| lease_error())?
                .dyn_into::<Promise>()
                .map_err(|_| lease_error())?;
            let handle = JsFuture::from(promise).await.map_err(|_| lease_error())?;
            if handle.is_null() {
                return Ok(None);
            }
            if self.closed.get() {
                best_effort_release(&handle);
                return Err(lease_error());
            }
            if validate_lease_handle(&handle).is_err() {
                best_effort_release(&handle);
                return Err(lease_error());
            }
            let id = self.next_id.get();
            let Some(next_id) = id.checked_add(1) else {
                best_effort_release(&handle);
                return Err(lease_error());
            };
            self.next_id.set(next_id);
            let state = Rc::new(LeaseState {
                handle,
                released: OnceFlag::new(),
                released_signal: Notify::new(),
            });
            self.active.borrow_mut().insert(id, Rc::downgrade(&state));
            Ok(Some(Box::new(LeaseGuard {
                id,
                state,
                active: Rc::clone(&self.active),
            })))
        }
    }

    fn validate_lease_handle(handle: &JsValue) -> Result<(), JsValue> {
        validate_exact_surface(handle, &["isLive", "lost", "release"])
    }

    fn validate_exact_surface(value: &JsValue, expected: &[&str]) -> Result<(), JsValue> {
        if value.is_null() || value.is_undefined() || !value.is_object() {
            return Err(JsValue::from_str(
                "Attachment Move lease surface is invalid",
            ));
        }
        let keys = Reflect::own_keys(value)?;
        let actual: Vec<String> = keys.iter().filter_map(|key| key.as_string()).collect();
        if actual.len() != keys.length() as usize {
            return Err(JsValue::from_str(
                "Attachment Move lease surface is invalid",
            ));
        }
        if !exact_surface_names(actual, expected) {
            return Err(JsValue::from_str(
                "Attachment Move lease surface is invalid",
            ));
        }
        for name in expected {
            function(value, name)?;
        }
        Ok(())
    }

    fn function(value: &JsValue, name: &str) -> Result<Function, JsValue> {
        Reflect::get(value, &JsValue::from_str(name))?.dyn_into::<Function>()
    }

    fn best_effort_release(handle: &JsValue) {
        if let Ok(release) = function(handle, "release") {
            let _ = release.call0(handle);
        }
    }

    fn lease_error() -> core::RuntimeError {
        core::RuntimeError {
            code: core::RuntimeErrorCode::InvariantViolation,
            message: "Attachment Move Account lease invocation failed".into(),
        }
    }

    type PreparationLifecycleFuture = Pin<Box<dyn Future<Output = Result<(), core::RuntimeError>>>>;

    struct PreparationLifecycleTask {
        future: RefCell<Option<PreparationLifecycleFuture>>,
        waker: RefCell<Option<Waker>>,
        lifecycle_error: Function,
        closed: OnceFlag,
        cancel_requested: Cell<bool>,
    }

    impl PreparationLifecycleTask {
        fn start(runtime: Arc<core::Runtime>, lifecycle_error: Function) -> Rc<Self> {
            Self::start_future(
                Box::pin(async move { runtime.run_attachment_move_preparation().await }),
                lifecycle_error,
            )
        }

        fn start_future(future: PreparationLifecycleFuture, lifecycle_error: Function) -> Rc<Self> {
            let task = Rc::new(Self {
                future: RefCell::new(Some(future)),
                waker: RefCell::new(None),
                lifecycle_error,
                closed: OnceFlag::new(),
                cancel_requested: Cell::new(false),
            });
            let weak = Rc::downgrade(&task);
            spawn_local(std::future::poll_fn(move |context| {
                let Some(task) = weak.upgrade() else {
                    return Poll::Ready(());
                };
                task.poll(context)
            }));
            task
        }

        fn poll(&self, context: &mut Context<'_>) -> Poll<()> {
            *self.waker.borrow_mut() = Some(context.waker().clone());
            let result = {
                let mut future = self.future.borrow_mut();
                let Some(future) = future.as_mut() else {
                    return Poll::Ready(());
                };
                future.as_mut().poll(context)
            };
            if self.cancel_requested.get() {
                let cancelled = self.future.borrow_mut().take().is_some();
                if cancelled {
                    record_lifecycle_cancellation();
                }
                self.waker.borrow_mut().take();
                return Poll::Ready(());
            }
            let Poll::Ready(result) = result else {
                return Poll::Pending;
            };

            self.future.borrow_mut().take();
            self.waker.borrow_mut().take();
            let _ = self.closed.take();
            if let Err(error) = result {
                let json = lifecycle_error_json(&error);
                let _ = self
                    .lifecycle_error
                    .call1(&JsValue::UNDEFINED, &JsValue::from_str(&json));
            }
            Poll::Ready(())
        }

        fn cancel(&self) {
            if !self.closed.take() {
                return;
            }
            self.cancel_requested.set(true);
            let cancelled = self
                .future
                .try_borrow_mut()
                .map(|mut future| future.take().is_some())
                .unwrap_or(false);
            if cancelled {
                record_lifecycle_cancellation();
            }
            if let Some(waker) = self.waker.borrow_mut().take() {
                waker.wake();
            }
        }
    }

    #[cfg(feature = "binding-test-harness")]
    thread_local! {
        static LIFECYCLE_CANCELLATIONS: Cell<u32> = const { Cell::new(0) };
    }

    #[cfg(feature = "binding-test-harness")]
    fn record_lifecycle_cancellation() {
        LIFECYCLE_CANCELLATIONS.with(|count| count.set(count.get() + 1));
    }

    #[cfg(not(feature = "binding-test-harness"))]
    fn record_lifecycle_cancellation() {}

    /// The Runtime's host-cleanup phase over the one production owner of the ciphertext spool.
    ///
    /// Only this executor holds the OPFS spool root, so the destructive scopes travel the same
    /// closed transfer-control seam as an upload. Runtime policy stays in Rust: the host answers
    /// the exact scope it destroyed or it answers nothing this phase can accept.
    struct JsSpoolTeardown(Arc<JsBinaryTransferExecutor>);

    #[async_trait(?Send)]
    impl core::TeardownHostCleanup for JsSpoolTeardown {
        async fn invoke(
            &self,
            request: core::TeardownHostCleanupRequest,
        ) -> Result<core::TeardownHostCleanupResponse, core::RuntimeError> {
            let (destroyed, answer) = match request {
                core::TeardownHostCleanupRequest::DeleteAccount { account_id } => (
                    self.0.delete_account(account_id.as_str().to_owned()).await,
                    core::TeardownHostCleanupResponse::AccountDeleted,
                ),
                core::TeardownHostCleanupRequest::WipeDevice => (
                    self.0.wipe_device().await,
                    core::TeardownHostCleanupResponse::DeviceWiped,
                ),
            };
            destroyed.map(|()| answer).map_err(|()| core::RuntimeError {
                code: core::RuntimeErrorCode::InvariantViolation,
                message: "Ciphertext spool cleanup failed".into(),
            })
        }
    }

    pub(crate) struct WebAttachmentMoveResources {
        binary: Arc<JsBinaryTransferExecutor>,
        leases: Arc<JsAttachmentMoveAccountLeasePort>,
        lifecycle: Rc<PreparationLifecycleTask>,
        closed: OnceFlag,
    }

    impl WebAttachmentMoveResources {
        pub(crate) fn close(&self) {
            if !self.closed.take() {
                return;
            }
            self.lifecycle.cancel();
            self.leases.close();
            self.binary.close();
        }
    }

    impl Drop for WebAttachmentMoveResources {
        fn drop(&mut self) {
            self.close();
        }
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "the one fixed Web composition receives each primitive host executor explicitly"
    )]
    pub(crate) fn configured_runtime(
        replica: Arc<dyn core::SerializedReplicaExecutor>,
        platform: Arc<dyn core::SerializedPlatformStorageExecutor>,
        http: Arc<dyn core::SerializedHttpExecutor>,
        auth_config: core::AuthClientConfig,
        artifact_executor: JsValue,
        binary_executor: JsValue,
        lease_executor: JsValue,
        lifecycle_error: Function,
    ) -> Result<(Arc<core::Runtime>, WebAttachmentMoveResources), JsValue> {
        let artifacts = Arc::new(JsAttachmentArtifactStore::new(artifact_executor)?);
        let (provisional, published) = shared_artifact_ports(artifacts);
        let binary = Arc::new(JsBinaryTransferExecutor::new(binary_executor)?);
        let transfer: Arc<dyn core::AttachmentMoveTransferPort> =
            Arc::new(JsAttachmentMoveTransferPort::new(Arc::clone(&binary))?);
        let leases = Arc::new(JsAttachmentMoveAccountLeasePort::new(lease_executor)?);
        let lease_port: Arc<dyn core::AttachmentMoveAccountLeasePort> = leases.clone();
        let preparation =
            core::AttachmentMovePreparationFacade::new(provisional, published, transfer);
        let runtime =
            core::Runtime::with_configured_serialized_executors_and_attachment_move_preparation(
                replica,
                platform,
                http,
                auth_config,
                preparation,
                lease_port,
            );
        runtime.install_teardown_host_cleanup(Arc::new(JsSpoolTeardown(Arc::clone(&binary))));
        let lifecycle = PreparationLifecycleTask::start(Arc::clone(&runtime), lifecycle_error);
        Ok((
            runtime,
            WebAttachmentMoveResources {
                binary,
                leases,
                lifecycle,
                closed: OnceFlag::new(),
            },
        ))
    }

    #[cfg(feature = "binding-test-harness")]
    #[wasm_bindgen::prelude::wasm_bindgen]
    pub struct WebAttachmentMoveBridgeTestHarness {
        binary: Arc<JsBinaryTransferExecutor>,
        transfer: Arc<JsAttachmentMoveTransferPort>,
        leases: Arc<JsAttachmentMoveAccountLeasePort>,
        lease: RefCell<Option<Box<dyn core::AttachmentMoveAccountLease>>>,
        download: RefCell<Option<Box<dyn core::AttachmentMoveDownload>>>,
        upload: RefCell<Option<Box<dyn core::AttachmentMoveUpload>>>,
        lifecycle: RefCell<Option<Rc<PreparationLifecycleTask>>>,
        close_signal: Rc<Notify>,
    }

    #[cfg(feature = "binding-test-harness")]
    #[wasm_bindgen::prelude::wasm_bindgen]
    impl WebAttachmentMoveBridgeTestHarness {
        #[wasm_bindgen::prelude::wasm_bindgen(constructor)]
        pub fn new(binary_executor: JsValue, lease_executor: JsValue) -> Result<Self, JsValue> {
            let binary = Arc::new(JsBinaryTransferExecutor::new(binary_executor)?);
            let transfer = Arc::new(JsAttachmentMoveTransferPort::new(Arc::clone(&binary))?);
            let leases = Arc::new(JsAttachmentMoveAccountLeasePort::new(lease_executor)?);
            Ok(Self {
                binary,
                transfer,
                leases,
                lease: RefCell::new(None),
                download: RefCell::new(None),
                upload: RefCell::new(None),
                lifecycle: RefCell::new(None),
                close_signal: Rc::new(Notify::new()),
            })
        }

        pub async fn acquire_lease(&self, account_id: String) -> Result<bool, JsValue> {
            let acquired = core::AttachmentMoveAccountLeasePort::acquire(
                self.leases.as_ref(),
                &core::AccountId::from(account_id),
            )
            .await
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
            let Some(acquired) = acquired else {
                return Ok(false);
            };
            *self.lease.borrow_mut() = Some(acquired);
            Ok(true)
        }

        pub fn lease_is_live(&self) -> bool {
            self.lease
                .borrow()
                .as_ref()
                .is_some_and(|lease| lease.is_live())
        }

        pub fn wait_for_lease_loss(&self, callback: Function) -> Result<(), JsValue> {
            let lease = self
                .lease
                .borrow_mut()
                .take()
                .ok_or_else(|| JsValue::from_str("No test lease is held"))?;
            spawn_local(async move {
                lease.lost().await;
                let _ = callback.call0(&JsValue::UNDEFINED);
                drop(lease);
            });
            Ok(())
        }

        pub fn release_lease(&self) {
            self.lease.borrow_mut().take();
        }

        pub fn exhaust_lease_identity(&self) {
            self.leases.exhaust_identity_for_test();
        }

        pub async fn open_download(&self, url: String) -> Result<(), JsValue> {
            let request = core::AttachmentMoveDownloadRequest {
                download_url: url,
                headers: vec![("x-signed".into(), "opaque".into())],
                max_response_bytes: 1024,
                max_chunk_bytes: 256,
            };
            let download =
                core::AttachmentMoveTransferPort::open_source(self.transfer.as_ref(), request)
                    .await
                    .map_err(|error| JsValue::from_str(&format!("{error:?}")))?;
            *self.download.borrow_mut() = Some(download);
            Ok(())
        }

        pub fn drop_download(&self) {
            self.download.borrow_mut().take();
        }

        pub async fn open_upload(&self, server_storage_key: String) -> Result<(), JsValue> {
            use sha2::{Digest, Sha256};

            let account_id = core::AccountId::from("account-upload");
            let operation_id = "operation-upload";
            let attachment_id = "attachment-upload";
            let ciphertext_sha256 = format!("{:x}", Sha256::digest([42_u8]));
            let byte_length = 1_u64;
            let mut artifact = Sha256::new();
            let byte_length_bytes = byte_length.to_be_bytes();
            for part in [
                b"bittery.attachment-move-artifact.v1".as_slice(),
                account_id.as_str().as_bytes(),
                operation_id.as_bytes(),
                attachment_id.as_bytes(),
                ciphertext_sha256.as_bytes(),
                &byte_length_bytes,
            ] {
                artifact.update((part.len() as u64).to_be_bytes());
                artifact.update(part);
            }
            let owner = core::AttachmentArtifactOwner::from_reference_parts(
                account_id.clone(),
                operation_id,
                attachment_id,
                format!("{:x}", artifact.finalize()),
                ciphertext_sha256,
                byte_length,
            )
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
            let grant = core::AttachmentMoveUploadGrant {
                attachment_id: attachment_id.into(),
                storage_key: server_storage_key,
                upload_url: "https://objects.test/upload?opaque=credential".into(),
            };
            let upload = core::AttachmentMoveTransferPort::open_upload(
                self.transfer.as_ref(),
                &account_id,
                operation_id,
                &grant,
                &owner,
            )
            .await
            .map_err(|error| JsValue::from_str(&format!("{error:?}")))?;
            *self.upload.borrow_mut() = Some(upload);
            Ok(())
        }

        pub fn drop_upload(&self) {
            self.upload.borrow_mut().take();
        }

        pub fn start_pending_download(&self, url: String, callback: Function) {
            let transfer = Arc::clone(&self.transfer);
            let close_signal = Rc::clone(&self.close_signal);
            spawn_local(async move {
                let request = core::AttachmentMoveDownloadRequest {
                    download_url: url,
                    headers: Vec::new(),
                    max_response_bytes: 1024,
                    max_chunk_bytes: 256,
                };
                let open =
                    core::AttachmentMoveTransferPort::open_source(transfer.as_ref(), request);
                tokio::pin!(open);
                let result = tokio::select! {
                    _ = close_signal.notified() => "abandoned",
                    _ = &mut open => "completed",
                };
                let _ = callback.call1(&JsValue::UNDEFINED, &JsValue::from_str(result));
            });
        }

        pub fn observe_lifecycle_error(&self, callback: Function) {
            let error = core::RuntimeError {
                code: core::RuntimeErrorCode::InvariantViolation,
                message: "TEST_PRIVATE_LIFECYCLE_DETAIL".into(),
            };
            let _ = callback.call1(
                &JsValue::UNDEFINED,
                &JsValue::from_str(&lifecycle_error_json(&error)),
            );
        }

        pub fn reset_lifecycle_drop_probe(&self) {
            LIFECYCLE_CANCELLATIONS.with(|count| count.set(0));
        }

        pub fn lifecycle_drop_probe(&self) -> u32 {
            LIFECYCLE_CANCELLATIONS.with(Cell::get)
        }

        pub fn start_reentrant_lifecycle(&self, callback: Function) {
            let future = Box::pin(std::future::poll_fn(move |_| {
                let _ = callback.call0(&JsValue::UNDEFINED);
                Poll::<Result<(), core::RuntimeError>>::Pending
            }));
            *self.lifecycle.borrow_mut() = Some(PreparationLifecycleTask::start_future(
                future,
                Function::new_no_args(""),
            ));
        }

        pub fn close(&self) {
            self.close_signal.notify_waiters();
            if let Some(lifecycle) = self.lifecycle.borrow_mut().take() {
                lifecycle.cancel();
            }
            self.lease.borrow_mut().take();
            self.download.borrow_mut().take();
            self.upload.borrow_mut().take();
            self.leases.close();
            self.binary.close();
        }
    }

    #[cfg(feature = "binding-test-harness")]
    impl Drop for WebAttachmentMoveBridgeTestHarness {
        fn drop(&mut self) {
            self.close();
        }
    }
}

#[cfg(all(target_arch = "wasm32", feature = "binding-test-harness"))]
pub use wasm::WebAttachmentMoveBridgeTestHarness;
#[cfg(target_arch = "wasm32")]
pub(crate) use wasm::{configured_runtime, WebAttachmentMoveResources};

#[cfg(test)]
mod tests {
    use super::{
        bridge_transfer_error, download_control_input, shared_artifact_ports, OnceFlag,
        TransferFailureClass, TransferIds,
    };
    use bittery_client_core::AttachmentMoveTransferError;

    #[test]
    fn binary_transfer_failures_follow_the_runtime_retry_contract() {
        assert_eq!(
            bridge_transfer_error(TransferFailureClass::Transient),
            AttachmentMoveTransferError::Transient
        );
        assert_eq!(
            bridge_transfer_error(TransferFailureClass::Cancelled),
            AttachmentMoveTransferError::Transient
        );
        assert_eq!(
            bridge_transfer_error(TransferFailureClass::Invariant),
            AttachmentMoveTransferError::Invariant
        );
    }

    #[test]
    fn transfer_ids_are_unique_and_do_not_embed_runtime_identity() {
        let ids = TransferIds::from_prefix([0xa5; 16]);
        let first = ids.next().unwrap();
        let second = ids.next().unwrap();

        assert_ne!(first, second);
        for identity in ["account-a", "operation-a", "attachment-a", "https://signed"] {
            assert!(!first.contains(identity));
            assert!(!second.contains(identity));
        }
    }

    #[test]
    fn upload_control_uses_an_attempt_generation_and_excludes_server_storage_identity() {
        let identity = super::upload_control_identity(
            "opaque-transfer-7".into(),
            "account-a",
            "operation-a",
            "attachment-a",
            "artifact-a",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            417,
        );

        assert_eq!(identity.transfer_id, "opaque-transfer-7");
        assert_eq!(identity.spool_generation, "opaque-transfer-7");
        assert_eq!(identity.account_id, "account-a");
        assert_eq!(identity.operation_id, "operation-a");
        assert_eq!(identity.attachment_id, "attachment-a");
        assert_eq!(identity.artifact_id, "artifact-a");
        assert_eq!(identity.byte_length, 417);
    }

    #[test]
    fn both_download_passes_forward_only_the_invocation_capability_and_bounds() {
        let request = || bittery_client_core::AttachmentMoveDownloadRequest {
            download_url: "https://objects.test/source?opaque=credential".into(),
            headers: vec![("x-signed".into(), "opaque-header".into())],
            max_response_bytes: 991,
            max_chunk_bytes: 73,
        };
        let ids = TransferIds::from_prefix([0x5a; 16]);
        let scan = download_control_input(ids.next().unwrap(), request());
        let transcrypt = download_control_input(ids.next().unwrap(), request());

        assert_ne!(scan.transfer_id, transcrypt.transfer_id);
        for pass in [scan, transcrypt] {
            assert_eq!(pass.url, "https://objects.test/source?opaque=credential");
            assert_eq!(pass.headers, [("x-signed".into(), "opaque-header".into())]);
            assert_eq!(pass.max_response_bytes, 991);
            assert_eq!(pass.max_chunk_bytes, 73);
        }
    }

    #[test]
    fn one_artifact_instance_supplies_both_core_store_ports() {
        let path = std::env::temp_dir().join(format!(
            "bittery-binding-shared-artifact-{}.sqlite3",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        let store = std::sync::Arc::new(
            bittery_client_core::SqliteAttachmentArtifactStore::open(&path).unwrap(),
        );
        let (provisional, published) = shared_artifact_ports(store);

        assert_eq!(
            std::sync::Arc::as_ptr(&provisional) as *const (),
            std::sync::Arc::as_ptr(&published) as *const ()
        );
        drop(provisional);
        drop(published);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn lease_release_gate_allows_exactly_one_host_release() {
        let release = OnceFlag::new();

        assert!(release.take());
        assert!(!release.take());
        assert!(release.is_set());
    }

    #[test]
    fn lease_surface_is_closed_and_acquisition_receives_only_the_explicit_account() {
        assert!(super::exact_surface_names(
            vec!["acquire".into()],
            &["acquire"]
        ));
        assert!(super::exact_surface_names(
            vec!["release".into(), "isLive".into(), "lost".into()],
            &["isLive", "lost", "release"]
        ));
        assert!(!super::exact_surface_names(
            vec!["acquire".into(), "operationId".into()],
            &["acquire"]
        ));
        assert_eq!(
            super::lease_acquire_argument(&bittery_client_core::AccountId::from("account-a")),
            "account-a"
        );
    }

    #[test]
    fn lifecycle_error_observation_redacts_internal_details() {
        let error = bittery_client_core::RuntimeError {
            code: bittery_client_core::RuntimeErrorCode::InvariantViolation,
            message: "UNIQUE_SIGNED_URL_AND_HOST_DETAIL".into(),
        };

        assert_eq!(
            super::lifecycle_error_json(&error),
            r#"{"code":"INVARIANT_VIOLATION","message":"Attachment Move preparation lifecycle failed"}"#
        );
    }
}
