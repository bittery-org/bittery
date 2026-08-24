mod bootstrap;
mod create;
#[cfg(test)]
mod create_tests;
mod dispatch;
#[cfg(test)]
mod dispatch_tests;
mod install;
mod lock;
mod open;
#[cfg(test)]
mod operation_fixtures;
mod outcome;
#[cfg(test)]
mod outcome_tests;

use dispatch::DispatchLeases;
use lock::AccessRetirement;

#[cfg(test)]
use crate::replica::PlanResult;
use crate::{
    auth_http::{AuthClientConfig, AuthHttpClient},
    authentication::{authenticate, AuthenticationInput, VerifiedAuthentication},
    authentication_installation::{
        prepare_authenticated_installation, prepare_quick_unlock, unwrap_master_unlock_key,
        AuthenticationInstallationEvidence, Clock, InstallationEntropy, PreparedQuickUnlock,
        SystemClock, SystemInstallationEntropy,
    },
    device_timer::{DeviceTimer, SystemDeviceTimer},
    http_transport::{HttpTransport, SerializedHttpExecutor},
    platform_storage::{
        DeviceCatalogAccount, DeviceCatalogDocument, DeviceKeyDocument,
        PendingAccountInstallIntent, PlatformStorage, SerializedPlatformStorageExecutor,
    },
    replica::{
        AuthorityVaultRole, AuthorityVaultType, GuardedCommitPlan, InMemoryReplica,
        OperationRecord, PlanMutation, RecomputedPlanResult, Replica, ReplicaItemRecord,
        ReplicaPersistence, ReplicaSnapshot, SerializedReplicaExecutor,
        SerializedReplicaPersistence,
    },
    AccountAccessState, AccountId, AccountStatus, AccountWaitingReason, ItemProjectionStatus,
    ItemsProjection, LoginItemProjection, ObservationRequest, ObservationSink, RequestCancellation,
    RuntimeError, RuntimeErrorCode, RuntimeProjection, RuntimeRequest, RuntimeResponse,
    RuntimeStatusProjection, VaultProjection, VaultProjectionRole, VaultProjectionType,
};
use std::{
    cell::RefCell,
    collections::{HashMap, HashSet, VecDeque},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Condvar, Mutex, Weak,
    },
    thread::ThreadId,
};
use zeroize::{Zeroize, Zeroizing};

thread_local! {
    static ACTIVE_RUNTIME_DELIVERIES: RefCell<HashMap<usize, usize>> = RefCell::new(HashMap::new());
}

struct ActiveRuntimeDelivery {
    runtime_identity: usize,
}

impl ActiveRuntimeDelivery {
    fn enter(runtime_identity: usize) -> Self {
        ACTIVE_RUNTIME_DELIVERIES.with(|deliveries| {
            *deliveries.borrow_mut().entry(runtime_identity).or_insert(0) += 1;
        });
        Self { runtime_identity }
    }

    fn is_active(runtime_identity: usize) -> bool {
        ACTIVE_RUNTIME_DELIVERIES.with(|deliveries| {
            deliveries
                .borrow()
                .get(&runtime_identity)
                .is_some_and(|depth| *depth > 0)
        })
    }
}

impl Drop for ActiveRuntimeDelivery {
    fn drop(&mut self) {
        ACTIVE_RUNTIME_DELIVERIES.with(|deliveries| {
            let mut deliveries = deliveries.borrow_mut();
            let depth = deliveries
                .get_mut(&self.runtime_identity)
                .expect("active Runtime delivery depth must exist");
            *depth -= 1;
            if *depth == 0 {
                deliveries.remove(&self.runtime_identity);
            }
        });
    }
}

#[derive(Clone, PartialEq, Eq)]
struct DeliveryGeneration {
    incarnation: crate::protocol::Incarnation,
    epoch: u64,
}

struct LiveMasterUnlockKey(Zeroizing<[u8; 32]>);

#[derive(Clone, Copy)]
struct RecoveryAccountStatus {
    replica_revision: u64,
}

impl LiveMasterUnlockKey {
    fn new(value: Zeroizing<[u8; 32]>) -> Self {
        Self(value)
    }

    fn copy_bytes(&self) -> Zeroizing<[u8; 32]> {
        Zeroizing::new(*self.0)
    }
}

impl Drop for LiveMasterUnlockKey {
    fn drop(&mut self) {
        self.0.zeroize();
        #[cfg(test)]
        if self.0.iter().all(|byte| *byte == 0) {
            LIVE_MASTER_UNLOCK_KEY_DROPS_AFTER_ZEROIZE.with(|drops| drops.set(drops.get() + 1));
        }
    }
}

#[cfg(test)]
thread_local! {
    static LIVE_MASTER_UNLOCK_KEY_DROPS_AFTER_ZEROIZE: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
fn take_zeroized_live_master_unlock_key_drops() -> usize {
    LIVE_MASTER_UNLOCK_KEY_DROPS_AFTER_ZEROIZE.with(|drops| drops.replace(0))
}

struct DeliveryToken {
    state: Mutex<DeliveryTokenState>,
    finished: Condvar,
}

struct DeliveryTokenState {
    invalidated: bool,
    active: HashMap<ThreadId, usize>,
}

impl DeliveryToken {
    fn new() -> Self {
        Self {
            state: Mutex::new(DeliveryTokenState {
                invalidated: false,
                active: HashMap::new(),
            }),
            finished: Condvar::new(),
        }
    }

    fn begin(self: &Arc<Self>) -> Option<DeliveryLease> {
        let thread = std::thread::current().id();
        let mut state = self.state.lock().expect("delivery token lock poisoned");
        if state.invalidated {
            return None;
        }
        *state.active.entry(thread).or_insert(0) += 1;
        Some(DeliveryLease {
            token: Arc::clone(self),
            thread,
        })
    }

    fn invalidate(&self) {
        self.state
            .lock()
            .expect("delivery token lock poisoned")
            .invalidated = true;
    }

    fn wait_for_other_threads(&self) {
        let current = std::thread::current().id();
        let mut state = self.state.lock().expect("delivery token lock poisoned");
        while state
            .active
            .iter()
            .any(|(thread, depth)| *thread != current && *depth > 0)
        {
            state = self
                .finished
                .wait(state)
                .expect("delivery token lock poisoned while invalidating");
        }
    }
}

struct DeliveryLease {
    token: Arc<DeliveryToken>,
    thread: ThreadId,
}

impl Drop for DeliveryLease {
    fn drop(&mut self) {
        let mut state = self
            .token
            .state
            .lock()
            .expect("delivery token lock poisoned");
        let depth = state
            .active
            .get_mut(&self.thread)
            .expect("delivery lease depth must exist");
        *depth -= 1;
        if *depth == 0 {
            state.active.remove(&self.thread);
        }
        self.token.finished.notify_all();
    }
}

struct ProjectedDelivery {
    projection: RuntimeProjection,
    generation: Option<DeliveryGeneration>,
    token: Option<Arc<DeliveryToken>>,
}

struct QueuedDelivery {
    projection: RuntimeProjection,
    token: Option<Arc<DeliveryToken>>,
}

struct Subscription {
    request: ObservationRequest,
    sink: Arc<dyn ObservationSink>,
    delivery: Mutex<DeliveryState>,
    delivery_finished: Condvar,
    runtime_identity: usize,
}

#[derive(Default)]
struct DeliveryState {
    closed: bool,
    delivering_thread: Option<ThreadId>,
    last_queued: Option<(Option<DeliveryGeneration>, u64)>,
    queue: VecDeque<QueuedDelivery>,
}

struct DeliveryGuard<'a> {
    subscription: &'a Subscription,
    armed: bool,
}

impl DeliveryGuard<'_> {
    fn finish(&mut self, delivery: &mut DeliveryState) {
        delivery.delivering_thread = None;
        self.subscription.delivery_finished.notify_all();
        self.armed = false;
    }
}

impl Drop for DeliveryGuard<'_> {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let mut delivery = self
            .subscription
            .delivery
            .lock()
            .expect("observation delivery lock poisoned");
        delivery.delivering_thread = None;
        self.subscription.delivery_finished.notify_all();
    }
}

impl Subscription {
    fn new(
        request: ObservationRequest,
        sink: Arc<dyn ObservationSink>,
        runtime_identity: usize,
    ) -> Self {
        Self {
            request,
            sink,
            delivery: Mutex::new(DeliveryState::default()),
            delivery_finished: Condvar::new(),
            runtime_identity,
        }
    }

    fn publish(&self, projected: ProjectedDelivery) {
        let revision = projected.projection.revision();
        let current_thread = std::thread::current().id();
        {
            let mut delivery = self
                .delivery
                .lock()
                .expect("observation delivery lock poisoned");
            if delivery.closed {
                return;
            }
            if delivery
                .last_queued
                .as_ref()
                .is_some_and(|(generation, last)| {
                    generation == &projected.generation && revision <= *last
                })
            {
                return;
            }
            delivery.last_queued = Some((projected.generation.clone(), revision));
            delivery.queue.push_back(QueuedDelivery {
                projection: projected.projection,
                token: projected.token,
            });
            if delivery.delivering_thread.is_some() {
                return;
            }
            delivery.delivering_thread = Some(current_thread);
        }

        let mut delivery_guard = DeliveryGuard {
            subscription: self,
            armed: true,
        };
        loop {
            let next = {
                let mut delivery = self
                    .delivery
                    .lock()
                    .expect("observation delivery lock poisoned");
                if delivery.closed {
                    delivery.queue.clear();
                    delivery_guard.finish(&mut delivery);
                    return;
                }
                let Some(next) = delivery.queue.pop_front() else {
                    delivery_guard.finish(&mut delivery);
                    return;
                };
                next
            };
            let _lease = match next.token {
                Some(token) => match token.begin() {
                    Some(lease) => Some(lease),
                    None => continue,
                },
                None => None,
            };
            let _active_delivery = ActiveRuntimeDelivery::enter(self.runtime_identity);
            self.sink.publish(next.projection);
        }
    }

    fn close(&self) {
        let current_thread = std::thread::current().id();
        let mut delivery = self
            .delivery
            .lock()
            .expect("observation delivery lock poisoned");
        delivery.closed = true;
        delivery.queue.clear();
        while delivery
            .delivering_thread
            .is_some_and(|owner| owner != current_thread)
        {
            delivery = self
                .delivery_finished
                .wait(delivery)
                .expect("observation delivery lock poisoned while closing");
        }
    }
}

pub struct Runtime {
    replica: Arc<Replica>,
    platform_storage: Arc<PlatformStorage>,
    http_transport: Arc<HttpTransport>,
    auth_client_config: Option<AuthClientConfig>,
    #[cfg(test)]
    test_persistence: Option<Arc<InMemoryReplica>>,
    observers: Mutex<HashMap<u64, Arc<Subscription>>>,
    next_observer_id: AtomicU64,
    device_revision: AtomicU64,
    closed: AtomicBool,
    ready: AtomicBool,
    close_complete: AtomicBool,
    close_state_cleaned: AtomicBool,
    close_finished: tokio::sync::Notify,
    catalog_transition: tokio::sync::Mutex<()>,
    publication: Mutex<()>,
    unlocked_items: Mutex<HashMap<AccountId, Vec<LoginItemProjection>>>,
    live_master_unlock_keys:
        Mutex<HashMap<(AccountId, crate::protocol::Incarnation), LiveMasterUnlockKey>>,
    account_access: Mutex<HashMap<AccountId, AccountAccessState>>,
    recovery_accounts: Mutex<HashMap<AccountId, RecoveryAccountStatus>>,
    account_lock_epochs: Mutex<HashMap<AccountId, u64>>,
    lock_epoch_pending: Mutex<HashMap<AccountId, u64>>,
    waiting_reasons: Mutex<HashMap<AccountId, AccountWaitingReason>>,
    delivery_tokens: Mutex<HashMap<AccountId, (DeliveryGeneration, Arc<DeliveryToken>)>>,
    account_execution_locks: Mutex<HashMap<AccountId, Arc<tokio::sync::Mutex<()>>>>,
    clock: Arc<dyn Clock>,
    device_timer: Arc<dyn DeviceTimer>,
    /// Wakes the dispatcher when something that can change eligibility happened: work was
    /// accepted, a Session arrived, or the Runtime is closing.
    dispatch_wake: tokio::sync::Notify,
    dispatch_leases: Arc<DispatchLeases>,
}

impl Runtime {
    #[cfg_attr(
        target_arch = "wasm32",
        allow(
            clippy::arc_with_non_send_sync,
            reason = "WASM is single-threaded, while Arc keeps the Runtime lifetime identical across bindings"
        )
    )]
    pub fn new() -> Arc<Self> {
        let in_memory = Arc::new(InMemoryReplica::default());
        let persistence: Arc<dyn ReplicaPersistence> = in_memory.clone();
        Self::with_persistence(
            persistence,
            Arc::new(PlatformStorage::unavailable()),
            Arc::new(HttpTransport::unavailable()),
            None,
            true,
            Arc::new(SystemClock),
            Arc::new(SystemDeviceTimer),
            #[cfg(test)]
            Some(in_memory),
        )
    }

    #[doc(hidden)]
    #[inline]
    #[cfg_attr(
        target_arch = "wasm32",
        allow(
            clippy::arc_with_non_send_sync,
            reason = "the serialized Web executor and Runtime share one single-threaded Worker"
        )
    )]
    pub fn with_serialized_replica_executor(
        executor: Arc<dyn SerializedReplicaExecutor>,
    ) -> Arc<Self> {
        let persistence: Arc<dyn ReplicaPersistence> =
            Arc::new(SerializedReplicaPersistence::new(executor));
        Self::with_persistence(
            persistence,
            Arc::new(PlatformStorage::unavailable()),
            Arc::new(HttpTransport::unavailable()),
            None,
            true,
            Arc::new(SystemClock),
            Arc::new(SystemDeviceTimer),
            #[cfg(test)]
            None,
        )
    }

    #[doc(hidden)]
    #[cfg_attr(
        target_arch = "wasm32",
        allow(
            clippy::arc_with_non_send_sync,
            reason = "the serialized Web executors and Runtime share one single-threaded Worker"
        )
    )]
    pub fn with_serialized_executors(
        replica: Arc<dyn SerializedReplicaExecutor>,
        platform: Arc<dyn SerializedPlatformStorageExecutor>,
        http: Arc<dyn SerializedHttpExecutor>,
    ) -> Arc<Self> {
        Self::with_serialized_executors_and_optional_auth_config(replica, platform, http, None)
    }

    /// Keeps authentication identity on the Runtime instance. Production bindings deliberately
    /// pass a configuration only when their host-specific wiring slice lands.
    fn with_serialized_executors_and_optional_auth_config(
        replica: Arc<dyn SerializedReplicaExecutor>,
        platform: Arc<dyn SerializedPlatformStorageExecutor>,
        http: Arc<dyn SerializedHttpExecutor>,
        auth_config: Option<AuthClientConfig>,
    ) -> Arc<Self> {
        let persistence: Arc<dyn ReplicaPersistence> =
            Arc::new(SerializedReplicaPersistence::new(replica));
        Self::with_persistence(
            persistence,
            Arc::new(PlatformStorage::new(platform)),
            Arc::new(HttpTransport::new(http)),
            auth_config,
            false,
            Arc::new(SystemClock),
            Arc::new(SystemDeviceTimer),
            #[cfg(test)]
            None,
        )
    }

    /// Builds a Runtime whose wall clock and delay are the test's, so dispatch scheduling can be
    /// asserted exactly instead of waited on.
    #[cfg(test)]
    pub(crate) fn with_test_dispatch_environment(
        replica: Arc<dyn SerializedReplicaExecutor>,
        platform: Arc<dyn SerializedPlatformStorageExecutor>,
        http: Arc<dyn SerializedHttpExecutor>,
        auth_config: AuthClientConfig,
        clock: Arc<dyn Clock>,
        device_timer: Arc<dyn DeviceTimer>,
    ) -> Arc<Self> {
        Self::with_persistence(
            Arc::new(SerializedReplicaPersistence::new(replica)),
            Arc::new(PlatformStorage::new(platform)),
            Arc::new(HttpTransport::new(http)),
            Some(auth_config),
            true,
            clock,
            device_timer,
            None,
        )
    }

    #[doc(hidden)]
    #[cfg_attr(
        target_arch = "wasm32",
        allow(
            clippy::arc_with_non_send_sync,
            reason = "the configured Web executors and Runtime share one single-threaded Worker"
        )
    )]
    pub fn with_configured_serialized_executors(
        replica: Arc<dyn SerializedReplicaExecutor>,
        platform: Arc<dyn SerializedPlatformStorageExecutor>,
        http: Arc<dyn SerializedHttpExecutor>,
        auth_config: AuthClientConfig,
    ) -> Arc<Self> {
        Self::with_serialized_executors_and_optional_auth_config(
            replica,
            platform,
            http,
            Some(auth_config),
        )
    }

    #[cfg_attr(
        target_arch = "wasm32",
        allow(
            clippy::arc_with_non_send_sync,
            reason = "the Web Runtime is confined to one Worker, while Arc preserves shared binding ownership"
        )
    )]
    #[allow(
        clippy::too_many_arguments,
        reason = "one private constructor owns every Runtime port, including the Device clock and timer"
    )]
    fn with_persistence(
        persistence: Arc<dyn ReplicaPersistence>,
        platform_storage: Arc<PlatformStorage>,
        http_transport: Arc<HttpTransport>,
        auth_client_config: Option<AuthClientConfig>,
        ready: bool,
        clock: Arc<dyn Clock>,
        device_timer: Arc<dyn DeviceTimer>,
        #[cfg(test)] test_persistence: Option<Arc<InMemoryReplica>>,
    ) -> Arc<Self> {
        Arc::new(Self {
            replica: Arc::new(Replica::new(persistence)),
            platform_storage,
            http_transport,
            auth_client_config,
            #[cfg(test)]
            test_persistence,
            observers: Mutex::new(HashMap::new()),
            next_observer_id: AtomicU64::new(1),
            device_revision: AtomicU64::new(0),
            closed: AtomicBool::new(false),
            ready: AtomicBool::new(ready),
            close_complete: AtomicBool::new(false),
            close_state_cleaned: AtomicBool::new(false),
            close_finished: tokio::sync::Notify::new(),
            catalog_transition: tokio::sync::Mutex::new(()),
            publication: Mutex::new(()),
            unlocked_items: Mutex::new(HashMap::new()),
            live_master_unlock_keys: Mutex::new(HashMap::new()),
            account_access: Mutex::new(HashMap::new()),
            recovery_accounts: Mutex::new(HashMap::new()),
            account_lock_epochs: Mutex::new(HashMap::new()),
            lock_epoch_pending: Mutex::new(HashMap::new()),
            waiting_reasons: Mutex::new(HashMap::new()),
            delivery_tokens: Mutex::new(HashMap::new()),
            account_execution_locks: Mutex::new(HashMap::new()),
            clock,
            device_timer,
            dispatch_wake: tokio::sync::Notify::new(),
            dispatch_leases: Arc::new(DispatchLeases::default()),
        })
    }

    #[cfg(test)]
    pub(crate) fn replica(&self) -> Arc<Replica> {
        Arc::clone(&self.replica)
    }

    #[cfg(test)]
    pub(crate) fn lock_epoch(&self, account_id: &AccountId) -> Option<u64> {
        self.account_lock_epochs
            .lock()
            .expect("Account lock epoch lock poisoned")
            .get(account_id)
            .copied()
    }

    #[cfg(test)]
    pub(crate) fn lock_epoch_is_pending(&self, account_id: &AccountId) -> bool {
        self.lock_epoch_pending
            .lock()
            .expect("pending lock epoch lock poisoned")
            .contains_key(account_id)
    }

    #[cfg(test)]
    pub(crate) fn account_access_state(
        &self,
        account_id: &AccountId,
    ) -> Option<AccountAccessState> {
        self.account_access
            .lock()
            .expect("Account access lock poisoned")
            .get(account_id)
            .copied()
    }

    #[cfg(test)]
    pub(crate) fn has_live_master_unlock_key(
        &self,
        account_id: &AccountId,
        incarnation: &crate::protocol::Incarnation,
    ) -> bool {
        self.live_master_unlock_keys
            .lock()
            .expect("live master unlock key lock poisoned")
            .contains_key(&(account_id.clone(), incarnation.clone()))
    }

    pub async fn request(
        &self,
        request: RuntimeRequest,
        cancellation: RequestCancellation,
    ) -> Result<RuntimeResponse, RuntimeError> {
        self.request_with_hooks(request, cancellation, || {}, || {})
            .await
    }

    #[cfg(test)]
    pub(crate) async fn request_with_acceptance_hook(
        &self,
        request: RuntimeRequest,
        cancellation: RequestCancellation,
        accepted: impl FnOnce(),
    ) -> Result<RuntimeResponse, RuntimeError> {
        self.request_with_hooks(request, cancellation, || {}, accepted)
            .await
    }

    async fn request_with_hooks(
        &self,
        request: RuntimeRequest,
        cancellation: RequestCancellation,
        before_acceptance: impl FnOnce(),
        accepted: impl FnOnce(),
    ) -> Result<RuntimeResponse, RuntimeError> {
        match request {
            RuntimeRequest::SignIn {
                server_url,
                email,
                master_password,
                secret_key,
                insecure_transport_confirmed,
            } => {
                let master_password = Zeroizing::new(master_password);
                let mut secret_key = Zeroizing::new(secret_key);
                self.ensure_open()?;
                if cancellation.is_cancelled() {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::Cancelled,
                        "caller cancelled before durable acceptance",
                    ));
                }
                let auth_config = self.auth_client_config.clone().ok_or_else(|| {
                    RuntimeError::new(
                        RuntimeErrorCode::AuthenticationUnavailable,
                        "authentication is implemented by a later vertical slice",
                    )
                })?;
                let normalized_email = bittery_crypto_core::normalize_email(&email);
                let http = AuthHttpClient::new(
                    &self.http_transport,
                    &server_url,
                    insecure_transport_confirmed,
                    auth_config,
                )?;
                if !bittery_crypto_core::validate_secret_key(&secret_key) {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::AuthenticationUnavailable,
                        "Secret Key is invalid",
                    ));
                }
                let pinned_kdf_profile = self
                    .resolve_sign_in_kdf_pin(&http.normalized_server_url(), &normalized_email)
                    .await?;
                let verified = authenticate(
                    &http,
                    AuthenticationInput {
                        email: &normalized_email,
                        master_password: &master_password,
                        secret_key: &secret_key,
                        pinned_kdf_profile: pinned_kdf_profile.as_ref(),
                    },
                    cancellation.clone(),
                )
                .await?;
                drop(master_password);
                before_acceptance();
                if cancellation.is_cancelled() {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::Cancelled,
                        "caller cancelled before durable Account acceptance",
                    ));
                }

                // Remote verification is complete. From this point the installer owns the accepted
                // generation and must either publish it or fence it despite later caller cancellation.
                accepted();
                let evidence = AuthenticationInstallationEvidence::new(
                    std::mem::take(&mut *secret_key),
                    insecure_transport_confirmed,
                );
                self.install_verified_authentication(verified, evidence)
                    .await
            }
            RuntimeRequest::QuickUnlock {
                account_id,
                master_password,
            } => {
                let master_password = Zeroizing::new(master_password);
                self.ensure_open()?;
                if cancellation.is_cancelled() {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::Cancelled,
                        "caller cancelled before durable acceptance",
                    ));
                }
                let auth_config = self.auth_client_config.clone().ok_or_else(|| {
                    RuntimeError::new(
                        RuntimeErrorCode::AuthenticationUnavailable,
                        "authentication is not configured for this Runtime",
                    )
                })?;
                let execution_lock = self.account_execution_lock(&account_id)?;
                let execution_guard = execution_lock.lock().await;
                self.ensure_open()?;
                if cancellation.is_cancelled() {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::Cancelled,
                        "caller cancelled before Quick Unlock preparation",
                    ));
                }
                if self
                    .lock_epoch_pending
                    .lock()
                    .expect("pending lock epoch lock poisoned")
                    .contains_key(&account_id)
                {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::InvariantViolation,
                        "Account lock epoch persistence is pending",
                    ));
                }
                let snapshot = self.replica.snapshot(&account_id).ok_or_else(|| {
                    RuntimeError::new(RuntimeErrorCode::AccountMissing, "account is not installed")
                })?;
                if snapshot.failure.is_some() {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::AccountFailed,
                        "the selected Account module has failed",
                    ));
                }
                let catalog = self
                    .platform_storage
                    .load_device_catalog()
                    .await?
                    .ok_or_else(quick_unlock_material_required)?;
                let catalog_account = catalog
                    .accounts
                    .iter()
                    .find(|candidate| candidate.account_id == account_id)
                    .ok_or_else(quick_unlock_material_required)?;
                if catalog_account.pending_install.is_some()
                    || catalog_account.active_incarnation.as_ref() != Some(&snapshot.incarnation)
                {
                    return Err(quick_unlock_material_required());
                }
                let metadata = self
                    .platform_storage
                    .load_account_metadata_for_authentication(&account_id, &snapshot.incarnation)
                    .await?
                    .ok_or_else(quick_unlock_material_required)?;
                if metadata.user_id != snapshot.user_id {
                    return Err(quick_unlock_material_required());
                }
                let quick_unlock = self
                    .platform_storage
                    .load_quick_unlock_for_authentication(&account_id, &snapshot.incarnation)
                    .await?
                    .ok_or_else(quick_unlock_material_required)?;
                let device_key = self
                    .platform_storage
                    .load_device_key_for_authentication()
                    .await?
                    .ok_or_else(quick_unlock_material_required)?;
                let stored_master_unlock_key = unwrap_master_unlock_key(
                    &quick_unlock.encrypted_master_unlock_key,
                    &device_key.key_bytes,
                )?;
                let normalized_email = bittery_crypto_core::normalize_email(&metadata.email);
                let http = AuthHttpClient::new(
                    &self.http_transport,
                    &metadata.normalized_server_url,
                    metadata.insecure_transport_confirmed,
                    auth_config,
                )?;
                let verified = authenticate(
                    &http,
                    AuthenticationInput {
                        email: &normalized_email,
                        master_password: &master_password,
                        secret_key: &quick_unlock.secret_key,
                        pinned_kdf_profile: Some(&metadata.pinned_kdf_profile),
                    },
                    cancellation.clone(),
                )
                .await?;
                drop(master_password);
                let prepared = prepare_quick_unlock(
                    verified,
                    metadata,
                    quick_unlock,
                    &stored_master_unlock_key,
                    &SystemClock,
                )?;
                drop(stored_master_unlock_key);
                before_acceptance();
                self.ensure_not_closed()?;
                if cancellation.is_cancelled() {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::Cancelled,
                        "caller cancelled before durable Quick Unlock acceptance",
                    ));
                }

                // Every remote and local equality check is complete. Cancellation no longer owns
                // the accepted session installation; it must finish or fence this exact generation.
                accepted();
                self.commit_quick_unlock(snapshot, prepared, execution_guard)
                    .await
            }
            // Retiring access is the one request a caller cannot take back. Cancellation is
            // never consulted, and the accepted Operations this Account already owes stay
            // durable: signing out is not a cancellation of committed Server work.
            RuntimeRequest::Lock { account_id } => self
                .retire_account_access(&account_id, AccessRetirement::Lock)
                .await
                .map(|access| RuntimeResponse::AccessChanged { account_id, access }),
            RuntimeRequest::SignOut { account_id } => self
                .retire_account_access(&account_id, AccessRetirement::SignOut)
                .await
                .map(|access| RuntimeResponse::AccessChanged { account_id, access }),
            RuntimeRequest::CreateLoginItem {
                account_id,
                vault_id,
                draft,
            } => {
                self.accept_create_login_item(account_id, vault_id, draft, cancellation, accepted)
                    .await
            }
            RuntimeRequest::UpdateLoginItem {
                account_id,
                item_id,
                draft,
            } => {
                self.accept_existing_item_operation(
                    account_id,
                    item_id,
                    create::ExistingItemIntent::Update(draft),
                    cancellation,
                    accepted,
                )
                .await
            }
            RuntimeRequest::SetItemFavorite {
                account_id,
                item_id,
                favorite,
            } => {
                self.accept_existing_item_operation(
                    account_id,
                    item_id,
                    create::ExistingItemIntent::SetFavorite(favorite),
                    cancellation,
                    accepted,
                )
                .await
            }
            RuntimeRequest::TrashItem {
                account_id,
                item_id,
            } => {
                self.accept_existing_item_operation(
                    account_id,
                    item_id,
                    create::ExistingItemIntent::Trash,
                    cancellation,
                    accepted,
                )
                .await
            }
            RuntimeRequest::RestoreItem {
                account_id,
                item_id,
            } => {
                self.accept_existing_item_operation(
                    account_id,
                    item_id,
                    create::ExistingItemIntent::Restore,
                    cancellation,
                    accepted,
                )
                .await
            }
            RuntimeRequest::MoveItem {
                account_id,
                item_id,
                target_vault_id,
            } => {
                self.accept_existing_item_operation(
                    account_id,
                    item_id,
                    create::ExistingItemIntent::Move { target_vault_id },
                    cancellation,
                    accepted,
                )
                .await
            }
            RuntimeRequest::PermanentlyDeleteItem {
                account_id,
                item_id,
            } => {
                self.accept_existing_item_operation(
                    account_id,
                    item_id,
                    create::ExistingItemIntent::PermanentlyDelete,
                    cancellation,
                    accepted,
                )
                .await
            }
        }
    }

    #[cfg(test)]
    pub(crate) async fn execute_plan(
        &self,
        plan: GuardedCommitPlan,
    ) -> Result<PlanResult, RuntimeError> {
        self.ensure_open()?;
        let result = self.replica.execute(plan).await?;
        if matches!(result, PlanResult::Applied { .. }) {
            self.device_revision.fetch_add(1, Ordering::SeqCst);
            self.publish_all();
        }
        Ok(result)
    }

    #[cfg(test)]
    pub(crate) fn fail_account(
        &self,
        account_id: &AccountId,
        code: RuntimeErrorCode,
    ) -> Result<(), RuntimeError> {
        self.ensure_open()?;
        self.test_persistence
            .as_ref()
            .expect("test Account failure requires in-memory persistence")
            .fail(account_id, code)?;
        self.replica.cache(
            self.test_persistence
                .as_ref()
                .expect("test Account failure requires in-memory persistence")
                .snapshot(account_id)
                .expect("failed Account must have a snapshot"),
        );
        self.device_revision.fetch_add(1, Ordering::SeqCst);
        self.publish_all();
        Ok(())
    }

    #[cfg_attr(
        target_arch = "wasm32",
        allow(
            clippy::arc_with_non_send_sync,
            reason = "WASM is single-threaded, while observation ownership still shares the Runtime"
        )
    )]
    pub fn observe(
        self: &Arc<Self>,
        request: ObservationRequest,
        sink: Arc<dyn ObservationSink>,
    ) -> Result<Arc<ObservationHandle>, RuntimeError> {
        let publication = self.publication.lock().expect("publication lock poisoned");
        self.ensure_open()?;
        let id = self.next_observer_id.fetch_add(1, Ordering::SeqCst);
        let subscription = Arc::new(Subscription::new(request, sink, self.identity()));
        self.observers
            .lock()
            .expect("observer lock poisoned")
            .insert(id, Arc::clone(&subscription));
        let initial = match self.projection_locked(&subscription.request) {
            Ok(initial) => initial,
            Err(error) => {
                self.observers
                    .lock()
                    .expect("observer lock poisoned")
                    .remove(&id);
                subscription.close();
                return Err(error);
            }
        };
        drop(publication);
        subscription.publish(initial);
        Ok(Arc::new(ObservationHandle {
            id,
            runtime: Arc::downgrade(self),
            subscription,
            closed: AtomicBool::new(false),
        }))
    }

    pub(crate) fn publish_all(&self) {
        let subscriptions: Vec<_> = self
            .observers
            .lock()
            .expect("observer lock poisoned")
            .values()
            .cloned()
            .collect();
        for subscription in subscriptions {
            if let Ok(projection) = self.projection(&subscription.request) {
                subscription.publish(projection);
            }
        }
    }

    fn publish_all_unless_closed(&self) {
        if !self.is_closed() {
            self.publish_all();
        }
    }

    pub async fn close(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            self.wake_dispatch();
            let reentrant_delivery = ActiveRuntimeDelivery::is_active(self.identity());
            loop {
                let finished = self.close_finished.notified();
                if self.close_complete.load(Ordering::SeqCst)
                    || (reentrant_delivery && self.close_state_cleaned.load(Ordering::SeqCst))
                {
                    return;
                }
                finished.await;
            }
        } else {
            self.wake_dispatch();
            let _catalog_guard = self.catalog_transition.lock().await;
            let mut execution_locks: Vec<_> = self
                .account_execution_locks
                .lock()
                .expect("Account execution lock map poisoned")
                .iter()
                .map(|(account_id, lock)| (account_id.clone(), Arc::clone(lock)))
                .collect();
            execution_locks.sort_by(|a, b| a.0.as_str().cmp(b.0.as_str()));
            let mut execution_guards = Vec::with_capacity(execution_locks.len());
            for (_, lock) in &execution_locks {
                execution_guards.push(lock.lock().await);
            }
            let pending = self
                .lock_epoch_pending
                .lock()
                .expect("pending lock epoch lock poisoned")
                .clone();
            let durable_advances: Vec<_> = self
                .replica
                .snapshots()
                .into_iter()
                .filter_map(|snapshot| {
                    if snapshot.lock_epoch == u64::MAX {
                        return None;
                    }
                    let desired = pending
                        .get(&snapshot.account_id)
                        .copied()
                        .or_else(|| snapshot.lock_epoch.checked_add(1))?;
                    Some((snapshot, desired))
                })
                .collect();
            let _publication = self.publication.lock().expect("publication lock poisoned");
            let invalidated_deliveries: Vec<_> = execution_locks
                .iter()
                .filter_map(|(account_id, _)| self.invalidate_delivery(account_id))
                .collect();
            let subscriptions: Vec<_> = self
                .observers
                .lock()
                .expect("observer lock poisoned")
                .values()
                .cloned()
                .collect();
            self.unlocked_items
                .lock()
                .expect("unlocked projection lock poisoned")
                .clear();
            self.live_master_unlock_keys
                .lock()
                .expect("live master unlock key lock poisoned")
                .clear();
            self.recovery_accounts
                .lock()
                .expect("recovery Account lock poisoned")
                .clear();
            self.account_access
                .lock()
                .expect("Account access lock poisoned")
                .clear();
            *self
                .account_lock_epochs
                .lock()
                .expect("Account lock epoch lock poisoned") = durable_advances
                .iter()
                .map(|(snapshot, epoch)| (snapshot.account_id.clone(), *epoch))
                .collect();
            drop(_publication);
            drop(execution_guards);
            drop(_catalog_guard);
            self.close_state_cleaned.store(true, Ordering::SeqCst);
            self.close_finished.notify_waiters();
            for token in invalidated_deliveries {
                token.wait_for_other_threads();
            }
            for subscription in subscriptions {
                subscription.close();
            }
            self.observers
                .lock()
                .expect("observer lock poisoned")
                .clear();
            for (snapshot, desired_epoch) in durable_advances {
                let _ = self
                    .replica
                    .advance_lock_epoch(
                        &snapshot.account_id,
                        &snapshot.user_id,
                        &snapshot.incarnation,
                        desired_epoch,
                    )
                    .await;
            }
            self.close_complete.store(true, Ordering::SeqCst);
            self.close_finished.notify_waiters();
        }
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    fn account_execution_lock(
        &self,
        account_id: &AccountId,
    ) -> Result<Arc<tokio::sync::Mutex<()>>, RuntimeError> {
        let mut locks = self
            .account_execution_locks
            .lock()
            .expect("Account execution lock map poisoned");
        self.ensure_open()?;
        Ok(locks
            .entry(account_id.clone())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone())
    }

    fn identity(&self) -> usize {
        std::ptr::from_ref(self).addr()
    }

    fn invalidate_delivery(&self, account_id: &AccountId) -> Option<Arc<DeliveryToken>> {
        let token = self
            .delivery_tokens
            .lock()
            .expect("delivery token map poisoned")
            .remove(account_id)
            .map(|(_, token)| token);
        if let Some(token) = &token {
            token.invalidate();
        }
        token
    }

    pub(crate) fn copy_live_master_unlock_key(
        &self,
        account_id: &AccountId,
        incarnation: &crate::protocol::Incarnation,
    ) -> Option<Zeroizing<[u8; 32]>> {
        self.live_master_unlock_keys
            .lock()
            .expect("live master unlock key lock poisoned")
            .get(&(account_id.clone(), incarnation.clone()))
            .map(LiveMasterUnlockKey::copy_bytes)
    }

    /// Puts the fixture master unlock key in memory, the way a real Sign-in or unlock leaves one.
    ///
    /// This is the only seam that publishes `TEST_MASTER_UNLOCK_KEY`, and it is compiled out of
    /// every non-test build together with the fixture module that owns the constant.
    #[cfg(test)]
    pub(crate) fn seed_live_master_unlock_key(
        &self,
        account_id: &AccountId,
        incarnation: &crate::protocol::Incarnation,
    ) {
        self.live_master_unlock_keys
            .lock()
            .expect("live master unlock key lock poisoned")
            .insert(
                (account_id.clone(), incarnation.clone()),
                LiveMasterUnlockKey::new(Zeroizing::new(
                    crate::test_fixtures::TEST_MASTER_UNLOCK_KEY,
                )),
            );
    }

    fn clear_live_master_unlock_keys_for_account(&self, account_id: &AccountId) {
        self.live_master_unlock_keys
            .lock()
            .expect("live master unlock key lock poisoned")
            .retain(|(installed_account_id, _), _| installed_account_id != account_id);
    }

    fn projection(&self, request: &ObservationRequest) -> Result<ProjectedDelivery, RuntimeError> {
        let _publication = self.publication.lock().expect("publication lock poisoned");
        self.projection_locked(request)
    }

    fn projection_locked(
        &self,
        request: &ObservationRequest,
    ) -> Result<ProjectedDelivery, RuntimeError> {
        match request {
            ObservationRequest::Items { account_id } => {
                let snapshot = self.replica.snapshot(account_id).ok_or_else(|| {
                    RuntimeError::new(RuntimeErrorCode::AccountMissing, "account is not installed")
                })?;
                if self
                    .account_access
                    .lock()
                    .expect("Account access lock poisoned")
                    .get(account_id)
                    != Some(&AccountAccessState::Unlocked)
                {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::AuthenticationRequired,
                        "the selected Account is signed out or locked",
                    ));
                }
                let epoch = *self
                    .account_lock_epochs
                    .lock()
                    .expect("Account lock epoch lock poisoned")
                    .get(account_id)
                    .unwrap_or(&0);
                let generation = DeliveryGeneration {
                    incarnation: snapshot.incarnation.clone(),
                    epoch,
                };
                let token = {
                    let mut tokens = self
                        .delivery_tokens
                        .lock()
                        .expect("delivery token map poisoned");
                    let entry = tokens
                        .entry(account_id.clone())
                        .or_insert_with(|| (generation.clone(), Arc::new(DeliveryToken::new())));
                    if entry.0 != generation {
                        *entry = (generation.clone(), Arc::new(DeliveryToken::new()));
                    }
                    Arc::clone(&entry.1)
                };
                Ok(ProjectedDelivery {
                    projection: RuntimeProjection::Items(ItemsProjection {
                        account_id: account_id.clone(),
                        replica_revision: snapshot.revision,
                        items: self
                            .unlocked_items
                            .lock()
                            .expect("unlocked projection lock poisoned")
                            .get(account_id)
                            .cloned()
                            .unwrap_or_default(),
                        vaults: visible_vaults(&snapshot),
                    }),
                    generation: Some(generation),
                    token: Some(token),
                })
            }
            ObservationRequest::RuntimeStatus { account_id } => {
                let recovery = self
                    .recovery_accounts
                    .lock()
                    .expect("recovery Account lock poisoned")
                    .clone();
                let snapshots = match account_id {
                    Some(account_id) => self.replica.snapshot(account_id).into_iter().collect(),
                    None => self.replica.snapshots(),
                };
                let mut accounts: Vec<_> = snapshots
                    .into_iter()
                    .map(|value| AccountStatus {
                        access: self
                            .account_access
                            .lock()
                            .expect("Account access lock poisoned")
                            .get(&value.account_id)
                            .copied()
                            .unwrap_or(AccountAccessState::SignedOut),
                        waiting_reason: self
                            .waiting_reasons
                            .lock()
                            .expect("waiting reason lock poisoned")
                            .get(&value.account_id)
                            .copied(),
                        account_id: value.account_id,
                        replica_revision: value.revision,
                        failure: value.failure,
                    })
                    .collect();
                let visible: HashSet<_> = accounts
                    .iter()
                    .map(|status| status.account_id.clone())
                    .collect();
                accounts.extend(
                    recovery
                        .into_iter()
                        .filter(|(recovery_account_id, _)| {
                            account_id
                                .as_ref()
                                .is_none_or(|requested| requested == recovery_account_id)
                                && !visible.contains(recovery_account_id)
                        })
                        .map(|(account_id, recovery)| AccountStatus {
                            account_id,
                            replica_revision: recovery.replica_revision,
                            access: AccountAccessState::SignedOut,
                            waiting_reason: None,
                            failure: None,
                        }),
                );
                if let Some(requested) = account_id {
                    if accounts.is_empty() {
                        return Err(RuntimeError::new(
                            RuntimeErrorCode::AccountMissing,
                            "account is not installed",
                        ));
                    }
                    debug_assert!(accounts
                        .iter()
                        .all(|status| &status.account_id == requested));
                }
                accounts.sort_by(|a, b| a.account_id.as_str().cmp(b.account_id.as_str()));
                let revision = self.device_revision.load(Ordering::SeqCst);
                Ok(ProjectedDelivery {
                    projection: RuntimeProjection::RuntimeStatus(RuntimeStatusProjection {
                        account_id: account_id.clone(),
                        revision,
                        accounts,
                        closed: self.is_closed(),
                    }),
                    generation: None,
                    token: None,
                })
            }
        }
    }

    fn ensure_open(&self) -> Result<(), RuntimeError> {
        self.ensure_not_closed()?;
        if !self.ready.load(Ordering::SeqCst) {
            Err(RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "Runtime must finish opening before it accepts work",
            ))
        } else {
            Ok(())
        }
    }

    fn ensure_not_closed(&self) -> Result<(), RuntimeError> {
        if self.is_closed() {
            Err(RuntimeError::new(
                RuntimeErrorCode::RuntimeClosed,
                "Runtime has been closed",
            ))
        } else {
            Ok(())
        }
    }
}

fn reconcile_catalog_account(
    account: &DeviceCatalogAccount,
    snapshot: Option<&crate::replica::ReplicaSnapshot>,
) -> Result<
    (
        Option<crate::protocol::Incarnation>,
        Option<crate::protocol::Incarnation>,
    ),
    RuntimeError,
> {
    let Some(pending) = &account.pending_install else {
        let active = account
            .active_incarnation
            .clone()
            .ok_or_else(|| startup_invariant("catalog Account has no active incarnation"))?;
        if snapshot.is_none_or(|snapshot| snapshot.incarnation != active) {
            return Err(startup_invariant(
                "active catalog incarnation does not match the durable Replica head",
            ));
        }
        return Ok((Some(active), None));
    };

    match snapshot.map(|snapshot| &snapshot.incarnation) {
        Some(head) if head == &pending.incarnation => Ok((
            Some(pending.incarnation.clone()),
            account.active_incarnation.clone(),
        )),
        Some(head) if Some(head) == account.active_incarnation.as_ref() => Ok((
            account.active_incarnation.clone(),
            Some(pending.incarnation.clone()),
        )),
        None if account.active_incarnation.is_none() => {
            Ok((None, Some(pending.incarnation.clone())))
        }
        _ => Err(startup_invariant(
            "pending Account installation cannot be reconciled with the durable Replica head",
        )),
    }
}

fn stage_catalog_install(
    catalog: &DeviceCatalogDocument,
    account_id: AccountId,
    incarnation: crate::protocol::Incarnation,
    expected_active_incarnation: Option<crate::protocol::Incarnation>,
) -> Result<DeviceCatalogDocument, RuntimeError> {
    let mut accounts = catalog.accounts.clone();
    let pending = PendingAccountInstallIntent {
        incarnation,
        expected_active_incarnation: expected_active_incarnation.clone(),
    };
    match accounts
        .iter_mut()
        .find(|account| account.account_id == account_id)
    {
        Some(account) => {
            if account.active_incarnation != expected_active_incarnation {
                return Err(startup_invariant(
                    "catalog Account changed while staging installation",
                ));
            }
            account.pending_install = Some(pending);
        }
        None => accounts.push(DeviceCatalogAccount {
            account_id,
            active_incarnation: None,
            pending_install: Some(pending),
        }),
    }
    DeviceCatalogDocument::new(accounts)
}

fn promote_catalog_install(
    staged: &DeviceCatalogDocument,
    account_id: &AccountId,
    incarnation: &crate::protocol::Incarnation,
) -> Result<DeviceCatalogDocument, RuntimeError> {
    let mut accounts = staged.accounts.clone();
    let account = accounts
        .iter_mut()
        .find(|account| &account.account_id == account_id)
        .ok_or_else(|| startup_invariant("staged catalog Account disappeared"))?;
    if account
        .pending_install
        .as_ref()
        .is_none_or(|pending| &pending.incarnation != incarnation)
    {
        return Err(startup_invariant(
            "staged catalog Account has another pending incarnation",
        ));
    }
    account.active_incarnation = Some(incarnation.clone());
    account.pending_install = None;
    DeviceCatalogDocument::new(accounts)
}

fn durable_installation_is_unchanged(
    durable: Option<&crate::replica::ReplicaSnapshot>,
    previous: Option<&crate::replica::ReplicaSnapshot>,
) -> bool {
    durable == previous
}

fn finish_generation_fence(token: Option<Arc<DeliveryToken>>) {
    if let Some(token) = token {
        token.wait_for_other_threads();
    }
}

/// The Vaults of the active Bootstrap generation, in the order a host can rely on.
///
/// This reads authority the Account already holds, so it needs no key and no decryption: a Vault
/// name has never been ciphertext. Nothing else is copied out of the authority record.
fn visible_vaults(snapshot: &ReplicaSnapshot) -> Vec<VaultProjection> {
    let Some(generation) = snapshot.bootstrap.active_generation.clone() else {
        return Vec::new();
    };
    let mut vaults: Vec<_> = snapshot
        .bootstrap
        .vaults
        .iter()
        .filter(|((vault_generation, _), _)| vault_generation == &generation)
        .map(|(_, vault)| VaultProjection {
            vault_id: vault.id.clone(),
            name: vault.name.clone(),
            vault_type: match vault.vault_type {
                AuthorityVaultType::Personal => VaultProjectionType::Personal,
                AuthorityVaultType::Team => VaultProjectionType::Team,
            },
            icon: vault.icon.clone(),
            image_url: vault.image_url.clone(),
            role: match vault.role {
                AuthorityVaultRole::Owner => VaultProjectionRole::Owner,
                AuthorityVaultRole::Admin => VaultProjectionRole::Admin,
                AuthorityVaultRole::Member => VaultProjectionRole::Member,
                AuthorityVaultRole::ReadOnly => VaultProjectionRole::ReadOnly,
            },
        })
        .collect();
    vaults.sort_by(|left, right| left.vault_id.cmp(&right.vault_id));
    vaults
}

fn startup_invariant(message: impl Into<String>) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::InvariantViolation, message)
}

fn quick_unlock_material_required() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::AuthenticationRequired,
        "Stored Quick Unlock material is unavailable",
    )
}

pub struct ObservationHandle {
    id: u64,
    runtime: Weak<Runtime>,
    subscription: Arc<Subscription>,
    closed: AtomicBool,
}

impl ObservationHandle {
    pub fn close(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Some(runtime) = self.runtime.upgrade() {
            runtime
                .observers
                .lock()
                .expect("observer lock poisoned")
                .remove(&self.id);
        }
        self.subscription.close();
    }
}

impl Drop for ObservationHandle {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod startup_tests;

#[cfg(test)]
mod authenticated_installation_tests;
