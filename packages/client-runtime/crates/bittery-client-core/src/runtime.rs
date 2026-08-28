mod attachment_move_lifecycle;
#[cfg(test)]
pub(crate) use attachment_move_lifecycle::live_artifact_owners;
#[cfg(test)]
mod attachment_move_lifecycle_tests;
#[allow(
    dead_code,
    reason = "Ticket 28 C2 lands the preparation worker before C4 composes its production ports"
)]
mod attachment_move_preparation;
#[cfg(test)]
mod attachment_move_preparation_tests;
#[allow(
    dead_code,
    reason = "the obsolete download-pass enum stays private until the scheduler module is simplified"
)]
mod attachment_move_scheduler;
#[cfg(test)]
mod attachment_move_scheduler_tests;
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
mod server_account_deletion;
#[cfg(test)]
mod share_outcome_tests;
mod teardown;
#[cfg(test)]
mod teardown_tests;

#[doc(hidden)]
pub use attachment_move_lifecycle::{AttachmentMoveAccountLease, AttachmentMoveAccountLeasePort};
use attachment_move_lifecycle::{AttachmentMoveLifecycle, LifecyclePass};
#[cfg(test)]
use attachment_move_scheduler::AttachmentMovePreparationDriver;
#[doc(hidden)]
pub use attachment_move_scheduler::{
    AttachmentMoveDownload, AttachmentMoveDownloadRequest, AttachmentMovePreparationFacade,
    AttachmentMoveTransferError, AttachmentMoveTransferPort, AttachmentMoveUpload,
    AttachmentMoveUploadGrant,
};
use attachment_move_scheduler::{
    AttachmentMovePreparationScheduler, PreparationCandidate, SchedulerPass,
};
use dispatch::DispatchLeases;
use lock::AccessRetirement;
pub use teardown::{TeardownHostCleanup, TeardownHostCleanupRequest, TeardownHostCleanupResponse};

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
        AuthorityVaultRole, AuthorityVaultType, GuardedCommitPlan, InMemoryReplica, OperationKind,
        OperationOutcomeResult, OperationRecord, PlanMutation, RecomputedPlanResult, Replica,
        ReplicaItemRecord, ReplicaPersistence, ReplicaSnapshot, SerializedReplicaExecutor,
        SerializedReplicaPersistence,
    },
    AccountAccessState, AccountDisplayIdentity, AccountId, AccountStatus, AccountWaitingReason,
    ItemProjectionStatus, ItemsProjection, LoginItemProjection, ObservationRequest,
    ObservationSink, PendingShareResult, PendingShareResultsProjection, RequestCancellation,
    RuntimeError, RuntimeErrorCode, RuntimeProjection, RuntimeRequest, RuntimeResponse,
    RuntimeStatusProjection, TeardownPhase, TeardownScope, TeardownStatus, VaultProjection,
    VaultProjectionRole, VaultProjectionType,
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

#[derive(serde::Deserialize, Zeroize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DecryptedShareCapability {
    token: String,
    share_key: String,
}

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
        Arc<Mutex<HashMap<(AccountId, crate::protocol::Incarnation), LiveMasterUnlockKey>>>,
    account_access: Mutex<HashMap<AccountId, AccountAccessState>>,
    account_display_identities: Mutex<HashMap<AccountId, AccountDisplayIdentity>>,
    recovery_accounts: Mutex<HashMap<AccountId, RecoveryAccountStatus>>,
    account_lock_epochs: Mutex<HashMap<AccountId, u64>>,
    lock_epoch_pending: Mutex<HashMap<AccountId, u64>>,
    account_access_retirement_intents: Mutex<HashMap<AccountId, Arc<Mutex<usize>>>>,
    #[cfg(test)]
    before_plaintext_commit: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    waiting_reasons: Mutex<HashMap<AccountId, AccountWaitingReason>>,
    delivery_tokens: Mutex<HashMap<AccountId, (DeliveryGeneration, Arc<DeliveryToken>)>>,
    account_execution_locks: Mutex<HashMap<AccountId, Arc<tokio::sync::Mutex<()>>>>,
    clock: Arc<dyn Clock>,
    device_timer: Arc<dyn DeviceTimer>,
    /// Wakes the dispatcher when something that can change eligibility happened: work was
    /// accepted, a Session arrived, or the Runtime is closing.
    dispatch_wake: tokio::sync::Notify,
    dispatch_leases: Arc<DispatchLeases>,
    attachment_move_scheduler: Mutex<Option<Arc<AttachmentMovePreparationScheduler>>>,
    attachment_move_lifecycle: Mutex<Option<Arc<AttachmentMoveLifecycle>>>,
    attachment_move_lifecycle_active: AtomicBool,
    attachment_move_account_cursor: AtomicU64,
    teardown_admission: tokio::sync::RwLock<()>,
    teardown_host_cleanup: Mutex<Arc<dyn TeardownHostCleanup>>,
    pending_teardown: Mutex<teardown::PendingTeardown>,
}

struct AttachmentMoveLifecycleLease {
    runtime: Arc<Runtime>,
}

impl AttachmentMoveLifecycleLease {
    fn acquire(runtime: &Arc<Runtime>) -> Result<Self, RuntimeError> {
        runtime
            .attachment_move_lifecycle_active
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| {
                RuntimeError::new(
                    RuntimeErrorCode::InvariantViolation,
                    "Attachment Move preparation lifecycle is already running",
                )
            })?;
        Ok(Self {
            runtime: Arc::clone(runtime),
        })
    }
}

impl Drop for AttachmentMoveLifecycleLease {
    fn drop(&mut self) {
        self.runtime
            .attachment_move_lifecycle_active
            .store(false, Ordering::SeqCst);
    }
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
            None,
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
            None,
            true,
            clock,
            device_timer,
            None,
        )
    }

    #[cfg(test)]
    pub(crate) fn with_test_preparation_environment(
        persistence: Arc<InMemoryReplica>,
        driver: Arc<dyn AttachmentMovePreparationDriver>,
        clock: Arc<dyn Clock>,
        device_timer: Arc<dyn DeviceTimer>,
    ) -> Arc<Self> {
        Self::with_test_preparation_lifecycle_environment(
            persistence,
            driver,
            Arc::new(attachment_move_lifecycle::TestAccountLeasePort),
            Arc::new(attachment_move_lifecycle::TestArtifactStore),
            clock,
            device_timer,
        )
    }

    #[cfg(test)]
    pub(crate) fn with_test_preparation_lifecycle_environment(
        persistence: Arc<InMemoryReplica>,
        driver: Arc<dyn AttachmentMovePreparationDriver>,
        lease_port: Arc<dyn AttachmentMoveAccountLeasePort>,
        artifacts: Arc<dyn crate::attachment_artifact_store::AttachmentArtifactStore>,
        clock: Arc<dyn Clock>,
        device_timer: Arc<dyn DeviceTimer>,
    ) -> Arc<Self> {
        let replica_persistence: Arc<dyn ReplicaPersistence> = persistence.clone();
        let runtime = Self::with_persistence(
            replica_persistence,
            Arc::new(PlatformStorage::unavailable()),
            Arc::new(HttpTransport::unavailable()),
            None,
            None,
            true,
            clock,
            device_timer,
            Some(persistence),
        );
        *runtime
            .attachment_move_scheduler
            .lock()
            .expect("Attachment Move scheduler lock poisoned") = Some(Arc::new(
            AttachmentMovePreparationScheduler::new_for_test(driver),
        ));
        *runtime
            .attachment_move_lifecycle
            .lock()
            .expect("Attachment Move lifecycle lock poisoned") = Some(Arc::new(
            AttachmentMoveLifecycle::new(lease_port, artifacts),
        ));
        runtime
    }

    #[cfg(test)]
    pub(crate) fn with_test_teardown_environment(
        persistence: Arc<dyn ReplicaPersistence>,
        platform: Arc<dyn SerializedPlatformStorageExecutor>,
        artifacts: Arc<dyn crate::attachment_artifact_store::AttachmentArtifactStore>,
        cleanup: Arc<dyn TeardownHostCleanup>,
    ) -> Arc<Self> {
        let runtime = Self::with_persistence(
            persistence,
            Arc::new(PlatformStorage::new(platform)),
            Arc::new(HttpTransport::unavailable()),
            Some(
                AuthClientConfig::new("test-client".into(), crate::ClientPlatform::Web, "1".into())
                    .expect("test auth config is valid"),
            ),
            None,
            true,
            Arc::new(SystemClock),
            Arc::new(SystemDeviceTimer),
            None,
        );
        *runtime
            .attachment_move_lifecycle
            .lock()
            .expect("Attachment Move lifecycle lock poisoned") =
            Some(Arc::new(AttachmentMoveLifecycle::new(
                Arc::new(attachment_move_lifecycle::TestAccountLeasePort),
                artifacts,
            )));
        runtime.install_teardown_host_cleanup(cleanup);
        runtime
    }

    #[cfg(test)]
    pub(crate) fn restart_test_teardown_environment(
        persistence: Arc<dyn ReplicaPersistence>,
        platform: Arc<dyn SerializedPlatformStorageExecutor>,
        artifacts: Arc<dyn crate::attachment_artifact_store::AttachmentArtifactStore>,
        cleanup: Arc<dyn TeardownHostCleanup>,
    ) -> Arc<Self> {
        let runtime = Self::with_persistence(
            persistence,
            Arc::new(PlatformStorage::new(platform)),
            Arc::new(HttpTransport::unavailable()),
            None,
            None,
            false,
            Arc::new(SystemClock),
            Arc::new(SystemDeviceTimer),
            None,
        );
        *runtime
            .attachment_move_lifecycle
            .lock()
            .expect("Attachment Move lifecycle lock poisoned") =
            Some(Arc::new(AttachmentMoveLifecycle::new(
                Arc::new(attachment_move_lifecycle::TestAccountLeasePort),
                artifacts,
            )));
        runtime.install_teardown_host_cleanup(cleanup);
        runtime
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

    #[doc(hidden)]
    #[cfg_attr(
        target_arch = "wasm32",
        allow(
            clippy::arc_with_non_send_sync,
            reason = "the configured Web preparation ports and Runtime share one single-threaded Worker"
        )
    )]
    pub fn with_configured_serialized_executors_and_attachment_move_preparation(
        replica: Arc<dyn SerializedReplicaExecutor>,
        platform: Arc<dyn SerializedPlatformStorageExecutor>,
        http: Arc<dyn SerializedHttpExecutor>,
        auth_config: AuthClientConfig,
        preparation: AttachmentMovePreparationFacade,
        lease_port: Arc<dyn AttachmentMoveAccountLeasePort>,
    ) -> Arc<Self> {
        let persistence: Arc<dyn ReplicaPersistence> =
            Arc::new(SerializedReplicaPersistence::new(replica));
        Self::with_persistence(
            persistence,
            Arc::new(PlatformStorage::new(platform)),
            Arc::new(HttpTransport::new(http)),
            Some(auth_config),
            Some((preparation, lease_port)),
            false,
            Arc::new(SystemClock),
            Arc::new(SystemDeviceTimer),
            #[cfg(test)]
            None,
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
        attachment_move_preparation: Option<(
            AttachmentMovePreparationFacade,
            Arc<dyn AttachmentMoveAccountLeasePort>,
        )>,
        ready: bool,
        clock: Arc<dyn Clock>,
        device_timer: Arc<dyn DeviceTimer>,
        #[cfg(test)] test_persistence: Option<Arc<InMemoryReplica>>,
    ) -> Arc<Self> {
        let replica = Arc::new(Replica::new(persistence));
        let live_master_unlock_keys = Arc::new(Mutex::new(HashMap::new()));
        let runtime = Arc::new(Self {
            replica,
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
            live_master_unlock_keys,
            account_access: Mutex::new(HashMap::new()),
            account_display_identities: Mutex::new(HashMap::new()),
            recovery_accounts: Mutex::new(HashMap::new()),
            account_lock_epochs: Mutex::new(HashMap::new()),
            lock_epoch_pending: Mutex::new(HashMap::new()),
            account_access_retirement_intents: Mutex::new(HashMap::new()),
            #[cfg(test)]
            before_plaintext_commit: Mutex::new(None),
            waiting_reasons: Mutex::new(HashMap::new()),
            delivery_tokens: Mutex::new(HashMap::new()),
            account_execution_locks: Mutex::new(HashMap::new()),
            clock,
            device_timer,
            dispatch_wake: tokio::sync::Notify::new(),
            dispatch_leases: Arc::new(DispatchLeases::default()),
            attachment_move_scheduler: Mutex::new(None),
            attachment_move_lifecycle: Mutex::new(None),
            attachment_move_lifecycle_active: AtomicBool::new(false),
            attachment_move_account_cursor: AtomicU64::new(0),
            teardown_admission: tokio::sync::RwLock::new(()),
            teardown_host_cleanup: Mutex::new(Arc::new(teardown::UnavailableTeardownHostCleanup)),
            pending_teardown: Mutex::new(teardown::PendingTeardown::default()),
        });
        if let Some((facade, lease_port)) = attachment_move_preparation {
            runtime.install_attachment_move_preparation_with_lease(facade, lease_port);
        }
        runtime
    }

    #[cfg(test)]
    fn install_attachment_move_preparation(
        self: &Arc<Self>,
        facade: AttachmentMovePreparationFacade,
    ) {
        self.install_attachment_move_preparation_with_lease(
            facade,
            Arc::new(attachment_move_lifecycle::TestAccountLeasePort),
        );
    }

    fn install_attachment_move_preparation_with_lease(
        self: &Arc<Self>,
        facade: AttachmentMovePreparationFacade,
        lease_port: Arc<dyn AttachmentMoveAccountLeasePort>,
    ) {
        let lifecycle = Arc::new(AttachmentMoveLifecycle::new(lease_port, facade.artifacts()));
        let scheduler = Arc::new(AttachmentMovePreparationScheduler::new(
            Arc::clone(&self.replica),
            Arc::clone(&self.live_master_unlock_keys),
            facade,
            Arc::downgrade(self),
        ));
        *self
            .attachment_move_scheduler
            .lock()
            .expect("Attachment Move scheduler lock poisoned") = Some(scheduler);
        *self
            .attachment_move_lifecycle
            .lock()
            .expect("Attachment Move lifecycle lock poisoned") = Some(lifecycle);
    }

    /// Installs the host-owned ciphertext-spool cleanup primitive. Runtime policy remains in Rust.
    #[doc(hidden)]
    pub fn install_teardown_host_cleanup(&self, cleanup: Arc<dyn TeardownHostCleanup>) {
        *self
            .teardown_host_cleanup
            .lock()
            .expect("teardown host cleanup lock poisoned") = cleanup;
    }

    /// Runs the one core-owned preparation scheduler until the Runtime closes.
    ///
    /// Hosts drive this future beside ordinary dispatch after `open`. Restart and unlock state are
    /// read from durable Replica truth on every pass; no accepted preparation lives in this future.
    #[doc(hidden)]
    pub async fn run_attachment_move_preparation(self: Arc<Self>) -> Result<(), RuntimeError> {
        let _lifecycle_lease = AttachmentMoveLifecycleLease::acquire(&self)?;
        let Some(scheduler) = self
            .attachment_move_scheduler
            .lock()
            .expect("Attachment Move scheduler lock poisoned")
            .as_ref()
            .cloned()
        else {
            return Ok(());
        };
        let lifecycle = self
            .attachment_move_lifecycle
            .lock()
            .expect("Attachment Move lifecycle lock poisoned")
            .as_ref()
            .cloned()
            .ok_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::AuthenticationUnavailable,
                    "Attachment Move preparation has no exclusive Account lease port",
                )
            })?;
        loop {
            if self.is_closed() {
                return Ok(());
            }
            let mut wake = std::pin::pin!(self.dispatch_wake.notified());
            wake.as_mut().enable();
            if !self.ready.load(Ordering::SeqCst) {
                tokio::select! {
                    () = wake => {}
                    () = self.device_timer.sleep_ms(1) => {}
                }
                continue;
            }
            let now_ms = self.clock.now_ms()?;
            let unlocked_accounts: HashSet<_> = self
                .account_access
                .lock()
                .expect("Account access lock poisoned")
                .iter()
                .filter(|(_, access)| **access == AccountAccessState::Unlocked)
                .map(|(account_id, _)| account_id.clone())
                .collect();
            let snapshots: Vec<_> = self
                .replica
                .snapshots()
                .into_iter()
                .filter(|snapshot| snapshot.failure.is_none())
                .collect();
            let mut candidates: Vec<_> = snapshots
                .iter()
                .flat_map(|snapshot| {
                    snapshot
                        .attachment_move_preparations
                        .iter()
                        .map(move |preparation| PreparationCandidate {
                            account_id: snapshot.account_id.clone(),
                            operation_id: preparation.operation_id.clone(),
                            not_before_ms: preparation.scheduling.not_before_ms,
                        })
                })
                .collect();
            candidates.sort_by(|left, right| {
                left.account_id
                    .as_str()
                    .cmp(right.account_id.as_str())
                    .then_with(|| left.operation_id.cmp(&right.operation_id))
            });
            let mut scheduled_accounts = HashSet::new();
            let mut attempts: Vec<(&ReplicaSnapshot, Option<String>)> = candidates
                .iter()
                .filter(|candidate| {
                    unlocked_accounts.contains(&candidate.account_id)
                        && candidate.not_before_ms <= now_ms
                        && scheduled_accounts.insert(candidate.account_id.clone())
                })
                .filter_map(|candidate| {
                    snapshots
                        .iter()
                        .find(|snapshot| snapshot.account_id == candidate.account_id)
                        .map(|snapshot| (snapshot, Some(candidate.operation_id.clone())))
                })
                .collect();
            attempts.extend(snapshots.iter().filter_map(|snapshot| {
                (unlocked_accounts.contains(&snapshot.account_id)
                    && !scheduled_accounts.contains(&snapshot.account_id)
                    && !lifecycle.has_swept(&snapshot.account_id, &snapshot.incarnation))
                .then_some((snapshot, None))
            }));
            if !attempts.is_empty() {
                let cursor = self
                    .attachment_move_account_cursor
                    .fetch_add(1, Ordering::SeqCst) as usize
                    % attempts.len();
                attempts.rotate_left(cursor);
            }
            let attempted_accounts = !attempts.is_empty();

            let mut pass = None;
            for (snapshot, operation_id) in attempts {
                match lifecycle
                    .run_account(&self, &scheduler, snapshot, operation_id, now_ms)
                    .await?
                {
                    LifecyclePass::LeaseUnavailable => continue,
                    acquired => {
                        pass = Some(acquired);
                        break;
                    }
                }
            }
            let pass = if let Some(pass) = pass {
                pass
            } else if !attempted_accounts {
                let earliest = candidates
                    .iter()
                    .filter(|candidate| unlocked_accounts.contains(&candidate.account_id))
                    .map(|candidate| candidate.not_before_ms)
                    .min();
                match earliest {
                    Some(deadline) => {
                        let milliseconds = deadline.saturating_sub(now_ms).max(1);
                        tokio::select! {
                            () = wake => {}
                            () = self.device_timer.sleep_ms(milliseconds) => {}
                        }
                    }
                    None => wake.await,
                }
                continue;
            } else {
                // Cross-process lease contention is a resource wait, not a transport attempt.
                // A wake remains immediate, while the timer avoids a denied Account hot loop.
                tokio::select! {
                    () = wake => {}
                    () = self.device_timer.sleep_ms(250) => {}
                }
                continue;
            };
            if self.is_closed() {
                return Ok(());
            }
            match pass {
                LifecyclePass::Swept | LifecyclePass::GenerationRetired => continue,
                LifecyclePass::LeaseUnavailable => {
                    unreachable!("unavailable leases are tried fairly")
                }
                LifecyclePass::Driven(SchedulerPass::DispatchReady) => {
                    self.wake_dispatch();
                }
                LifecyclePass::Driven(SchedulerPass::Progressed) => continue,
                LifecyclePass::Driven(SchedulerPass::Parked) => wake.await,
                LifecyclePass::Driven(SchedulerPass::WaitFor { milliseconds }) => {
                    tokio::select! {
                        () = wake => {}
                        () = self.device_timer.sleep_ms(milliseconds) => {}
                    }
                }
            }
        }
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
        match &request {
            RuntimeRequest::RemoveAccount { account_id } => {
                return self.remove_account(account_id.clone()).await;
            }
            RuntimeRequest::Wipe => {
                return self.wipe_device().await;
            }
            _ => {}
        }
        let _admission = self.teardown_admission.read().await;
        self.reject_request_during_pending_teardown(&request)?;
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
            RuntimeRequest::DeleteServerAccount {
                account_id,
                confirm_email,
                request_id,
            } => {
                self.delete_server_account(account_id, confirm_email, request_id, cancellation)
                    .await
            }
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
            RuntimeRequest::CreateShare {
                account_id,
                item_id,
                draft,
            } => {
                self.accept_create_share(account_id, item_id, draft, cancellation, accepted)
                    .await
            }
            RuntimeRequest::AcknowledgeShareResult {
                account_id,
                operation_id,
            } => {
                let _ = accepted;
                self.acknowledge_share_result(account_id, operation_id, cancellation)
                    .await
            }
            // Teardown returns before ordinary admission. A Runtime bug must not abort the host,
            // so this reports an error rather than panicking on the request path.
            RuntimeRequest::RemoveAccount { .. } | RuntimeRequest::Wipe => Err(RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "teardown requests are handled before ordinary admission",
            )),
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
        if self.observation_teardown_is_pending(&request) {
            return Err(RuntimeError::new(
                RuntimeErrorCode::AccountMissing,
                "Account teardown is pending",
            ));
        }
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
            self.account_display_identities
                .lock()
                .expect("Account display identity lock poisoned")
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

    fn generation_is_preparation_eligible(&self, snapshot: &ReplicaSnapshot) -> bool {
        !self.is_closed()
            && self.ready.load(Ordering::SeqCst)
            && !self.account_teardown_is_pending(&snapshot.account_id)
            && snapshot.failure.is_none()
            && self
                .account_access
                .lock()
                .expect("Account access lock poisoned")
                .get(&snapshot.account_id)
                == Some(&AccountAccessState::Unlocked)
            && self
                .replica
                .snapshot(&snapshot.account_id)
                .is_some_and(|current| {
                    current.failure.is_none()
                        && current.incarnation == snapshot.incarnation
                        && current.lock_epoch == snapshot.lock_epoch
                })
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

    #[cfg(test)]
    pub(crate) fn seed_unlocked_preparation_account(&self, account_id: &AccountId) {
        let snapshot = self
            .replica
            .snapshot(account_id)
            .expect("preparation Account is loaded");
        self.seed_live_master_unlock_key(account_id, &snapshot.incarnation);
        self.account_access
            .lock()
            .expect("Account access lock poisoned")
            .insert(account_id.clone(), AccountAccessState::Unlocked);
        self.account_lock_epochs
            .lock()
            .expect("Account lock epoch lock poisoned")
            .insert(account_id.clone(), snapshot.lock_epoch);
        self.wake_dispatch();
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
            ObservationRequest::PendingShareResults { account_id } => {
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
                let master_unlock_key = self
                    .copy_live_master_unlock_key(account_id, &snapshot.incarnation)
                    .ok_or_else(|| {
                        RuntimeError::new(
                            RuntimeErrorCode::AuthenticationRequired,
                            "the selected Account has no live master unlock key",
                        )
                    })?;
                let mut results = Vec::new();
                for capability in snapshot
                    .share_capabilities
                    .iter()
                    .filter(|capability| capability.result.is_some())
                {
                    let context = bittery_crypto_core::ShareCapabilityAadContext::new(
                        account_id.as_str().to_owned(),
                        capability.operation_id.clone(),
                    )
                    .map_err(|_| {
                        RuntimeError::new(
                            RuntimeErrorCode::InvariantViolation,
                            "the pending Share result scope is invalid",
                        )
                    })?;
                    let plaintext = Zeroizing::new(
                        bittery_crypto_core::decrypt_share_capability(
                            &bittery_crypto_core::EncryptedData {
                                ciphertext: capability.ciphertext.clone(),
                                iv: capability.iv.clone(),
                                algorithm: capability.algorithm.clone(),
                            },
                            master_unlock_key.as_slice(),
                            &context,
                        )
                        .map_err(|_| {
                            RuntimeError::new(
                                RuntimeErrorCode::InvariantViolation,
                                "the pending Share capability could not be opened",
                            )
                        })?,
                    );
                    let opened = Zeroizing::new(
                        serde_json::from_str::<DecryptedShareCapability>(&plaintext).map_err(
                            |_| {
                                RuntimeError::new(
                                    RuntimeErrorCode::InvariantViolation,
                                    "the pending Share capability is invalid",
                                )
                            },
                        )?,
                    );
                    let applied = capability
                        .result
                        .as_ref()
                        .expect("filtered pending Share result must exist");
                    let receipt = snapshot
                        .receipts
                        .iter()
                        .find(|receipt| receipt.operation_id == capability.operation_id)
                        .ok_or_else(|| {
                            RuntimeError::new(
                                RuntimeErrorCode::InvariantViolation,
                                "the pending Share result has no Operation receipt",
                            )
                        })?;
                    match &receipt.result {
                        OperationOutcomeResult::ShareApplied {
                            share_link_id,
                            base_share_url,
                            expires_at,
                        } if receipt.kind == OperationKind::CreateShare
                            && share_link_id == &applied.share_link_id
                            && base_share_url == &applied.base_share_url
                            && expires_at == &applied.expires_at => {}
                        _ => {
                            return Err(RuntimeError::new(
                                RuntimeErrorCode::InvariantViolation,
                                "the pending Share result disagrees with its Operation receipt",
                            ));
                        }
                    }
                    results.push(PendingShareResult {
                        operation_id: capability.operation_id.clone(),
                        item_id: receipt.item_id.clone(),
                        share_link_id: applied.share_link_id.clone(),
                        share_url: format!(
                            "{}{}#{}",
                            applied.base_share_url, opened.token, opened.share_key
                        ),
                        expires_at: applied.expires_at.clone(),
                    });
                }
                Ok(ProjectedDelivery {
                    projection: RuntimeProjection::PendingShareResults(
                        PendingShareResultsProjection {
                            account_id: account_id.clone(),
                            replica_revision: snapshot.revision,
                            results,
                        },
                    ),
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
                        display_identity: self
                            .account_display_identities
                            .lock()
                            .expect("Account display identity lock poisoned")
                            .get(&value.account_id)
                            .cloned(),
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
                            display_identity: None,
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
