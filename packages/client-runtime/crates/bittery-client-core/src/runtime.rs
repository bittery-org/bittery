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
    http_transport::{HttpTransport, SerializedHttpExecutor},
    platform_storage::{
        DeviceCatalogAccount, DeviceCatalogDocument, DeviceKeyDocument,
        PendingAccountInstallIntent, PlatformStorage, SerializedPlatformStorageExecutor,
    },
    replica::{
        GuardedCommitPlan, InMemoryReplica, OperationRecord, PlanMutation, RecomputedPlanResult,
        Replica, ReplicaItemRecord, ReplicaPersistence, SerializedReplicaExecutor,
        SerializedReplicaPersistence,
    },
    AccountAccessState, AccountId, AccountStatus, ItemProjectionStatus, ItemsProjection,
    LoginItemProjection, ObservationRequest, ObservationSink, RequestCancellation, RuntimeError,
    RuntimeErrorCode, RuntimeProjection, RuntimeRequest, RuntimeResponse, RuntimeStatusProjection,
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
    delivery_tokens: Mutex<HashMap<AccountId, (DeliveryGeneration, Arc<DeliveryToken>)>>,
    account_execution_locks: Mutex<HashMap<AccountId, Arc<tokio::sync::Mutex<()>>>>,
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
            #[cfg(test)]
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
    fn with_persistence(
        persistence: Arc<dyn ReplicaPersistence>,
        platform_storage: Arc<PlatformStorage>,
        http_transport: Arc<HttpTransport>,
        auth_client_config: Option<AuthClientConfig>,
        ready: bool,
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
            delivery_tokens: Mutex::new(HashMap::new()),
            account_execution_locks: Mutex::new(HashMap::new()),
        })
    }

    /// Restores the durable Device catalog before the production Runtime accepts work.
    pub async fn open(&self) -> Result<(), RuntimeError> {
        let _catalog_guard = self.catalog_transition.lock().await;
        self.ensure_not_closed()?;
        if self.ready.load(Ordering::SeqCst) {
            return Ok(());
        }

        let Some(catalog) = self.platform_storage.load_device_catalog().await? else {
            let _publication = self.publication.lock().expect("publication lock poisoned");
            self.ensure_not_closed()?;
            self.publish_restored_accounts(&[]);
            self.ready.store(true, Ordering::SeqCst);
            return Ok(());
        };

        let mut reconciled_accounts = Vec::with_capacity(catalog.accounts.len());
        let mut restored = Vec::with_capacity(catalog.accounts.len());
        let mut orphaned_generations = Vec::new();
        let mut corrected = false;

        for account in &catalog.accounts {
            self.ensure_not_closed()?;
            let snapshot = self.replica.load_uncached(&account.account_id).await?;
            let (active, orphaned) = reconcile_catalog_account(account, snapshot.as_ref())?;
            corrected |= active != account.active_incarnation || account.pending_install.is_some();
            if let Some(orphaned) = orphaned {
                orphaned_generations.push((account.account_id.clone(), orphaned));
            }
            let Some(active) = active else {
                continue;
            };
            let snapshot = snapshot
                .ok_or_else(|| startup_invariant("active Account has no durable Replica"))?;
            let metadata = self
                .platform_storage
                .load_account_metadata(&account.account_id, &active)
                .await?
                .ok_or_else(|| startup_invariant("active Account has no generation metadata"))?;
            if snapshot.account_id != account.account_id
                || snapshot.incarnation != active
                || snapshot.user_id != metadata.user_id
            {
                return Err(startup_invariant(
                    "active Account Replica and generation metadata disagree",
                ));
            }
            reconciled_accounts.push(DeviceCatalogAccount {
                account_id: account.account_id.clone(),
                active_incarnation: Some(active),
                pending_install: None,
            });
            restored.push(snapshot);
        }

        if corrected {
            self.ensure_not_closed()?;
            let reconciled = DeviceCatalogDocument::new(reconciled_accounts)?;
            self.platform_storage
                .store_device_catalog(&reconciled)
                .await?;
            for (account_id, incarnation) in orphaned_generations {
                let _ = self
                    .platform_storage
                    .remove_account_metadata(&account_id, &incarnation)
                    .await;
                let _ = self
                    .platform_storage
                    .remove_quick_unlock(&account_id, &incarnation)
                    .await;
                let _ = self
                    .platform_storage
                    .remove_current_session(&account_id, &incarnation)
                    .await;
            }
        }

        let _publication = self.publication.lock().expect("publication lock poisoned");
        self.ensure_not_closed()?;
        self.publish_restored_accounts(&restored);
        self.ready.store(true, Ordering::SeqCst);
        Ok(())
    }

    fn publish_restored_accounts(&self, restored: &[crate::replica::ReplicaSnapshot]) {
        self.recovery_accounts
            .lock()
            .expect("recovery Account lock poisoned")
            .clear();
        self.live_master_unlock_keys
            .lock()
            .expect("live master unlock key lock poisoned")
            .clear();
        self.replica.replace_cache(restored);
        *self
            .account_access
            .lock()
            .expect("Account access lock poisoned") = restored
            .iter()
            .map(|snapshot| (snapshot.account_id.clone(), AccountAccessState::SignedOut))
            .collect();
        self.unlocked_items
            .lock()
            .expect("unlocked projection lock poisoned")
            .clear();
        *self
            .account_lock_epochs
            .lock()
            .expect("Account lock epoch lock poisoned") = restored
            .iter()
            .map(|snapshot| (snapshot.account_id.clone(), snapshot.lock_epoch))
            .collect();
        self.lock_epoch_pending
            .lock()
            .expect("pending lock epoch lock poisoned")
            .clear();
        self.device_revision.fetch_add(1, Ordering::SeqCst);
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

    #[cfg(test)]
    pub(crate) fn install_account(
        &self,
        account_id: AccountId,
        user_id: String,
        incarnation: crate::protocol::Incarnation,
    ) -> Result<(), RuntimeError> {
        self.ensure_open()?;
        let _publication = self.publication.lock().expect("publication lock poisoned");
        self.test_persistence
            .as_ref()
            .expect("test Account installation requires in-memory persistence")
            .install(account_id.clone(), user_id, incarnation)?;
        self.replica.cache(
            self.test_persistence
                .as_ref()
                .expect("test Account installation requires in-memory persistence")
                .snapshot(&account_id)
                .expect("installed Account must have a snapshot"),
        );
        self.recovery_accounts
            .lock()
            .expect("recovery Account lock poisoned")
            .remove(&account_id);
        self.unlocked_items
            .lock()
            .expect("unlocked projection lock poisoned")
            .entry(account_id.clone())
            .or_default();
        self.account_access
            .lock()
            .expect("Account access lock poisoned")
            .insert(account_id.clone(), AccountAccessState::Unlocked);
        self.account_lock_epochs
            .lock()
            .expect("Account lock epoch lock poisoned")
            .entry(account_id.clone())
            .or_insert(0);
        self.device_revision.fetch_add(1, Ordering::SeqCst);
        drop(_publication);
        self.publish_all();
        Ok(())
    }

    #[doc(hidden)]
    pub async fn install_or_replace_account(
        &self,
        account_id: AccountId,
        user_id: String,
        incarnation: crate::protocol::Incarnation,
    ) -> Result<(), RuntimeError> {
        let _catalog_guard = self.catalog_transition.lock().await;
        let execution_lock = self.account_execution_lock(&account_id)?;
        let _execution_guard = execution_lock.lock().await;
        self.ensure_open()?;
        let snapshot = self
            .replica
            .install_or_replace(account_id.clone(), user_id, incarnation)
            .await?;
        let next_lock_epoch = snapshot.lock_epoch;
        let _publication = self.publication.lock().expect("publication lock poisoned");
        let invalidated_delivery = self.invalidate_delivery(&account_id);
        self.replica.cache(snapshot);
        self.recovery_accounts
            .lock()
            .expect("recovery Account lock poisoned")
            .remove(&account_id);
        self.unlocked_items
            .lock()
            .expect("unlocked projection lock poisoned")
            .remove(&account_id);
        self.clear_live_master_unlock_keys_for_account(&account_id);
        self.account_access
            .lock()
            .expect("Account access lock poisoned")
            .insert(account_id.clone(), AccountAccessState::SignedOut);
        self.account_lock_epochs
            .lock()
            .expect("Account lock epoch lock poisoned")
            .insert(account_id.clone(), next_lock_epoch);
        self.lock_epoch_pending
            .lock()
            .expect("pending lock epoch lock poisoned")
            .remove(&account_id);
        self.device_revision.fetch_add(1, Ordering::SeqCst);
        drop(_publication);
        drop(_execution_guard);
        drop(_catalog_guard);
        if let Some(token) = invalidated_delivery {
            token.wait_for_other_threads();
        }
        self.publish_all();
        Ok(())
    }

    /// Installs one fully authenticated Account generation without exposing authentication policy
    /// to bindings.
    pub(crate) async fn install_verified_authentication(
        &self,
        verified: VerifiedAuthentication,
        evidence: AuthenticationInstallationEvidence,
    ) -> Result<RuntimeResponse, RuntimeError> {
        self.install_verified_authentication_with(
            verified,
            evidence,
            &SystemClock,
            &SystemInstallationEntropy,
        )
        .await
    }

    async fn install_verified_authentication_with(
        &self,
        verified: VerifiedAuthentication,
        evidence: AuthenticationInstallationEvidence,
        clock: &dyn Clock,
        entropy: &dyn InstallationEntropy,
    ) -> Result<RuntimeResponse, RuntimeError> {
        let catalog_guard = self.catalog_transition.lock().await;
        self.ensure_open()?;
        let original_catalog = self.platform_storage.load_device_catalog().await?;
        let catalog = original_catalog
            .clone()
            .unwrap_or(DeviceCatalogDocument::new(Vec::new())?);
        if catalog
            .accounts
            .iter()
            .any(|account| account.pending_install.is_some())
        {
            return Err(startup_invariant(
                "Device catalog must reconcile pending installation before Sign-in",
            ));
        }

        let mut matching_accounts = Vec::new();
        let mut active_metadata = HashMap::new();
        for account in &catalog.accounts {
            let active = account.active_incarnation.as_ref().ok_or_else(|| {
                startup_invariant("active catalog Account has no active incarnation")
            })?;
            let metadata = self
                .platform_storage
                .load_account_metadata(&account.account_id, active)
                .await?
                .ok_or_else(|| {
                    startup_invariant("active catalog Account has no generation metadata")
                })?;
            if metadata.normalized_server_url == verified.normalized_server_url
                && metadata.user_id == verified.user.id
            {
                matching_accounts.push(account.account_id.clone());
            }
            active_metadata.insert(account.account_id.clone(), metadata);
        }
        if matching_accounts.len() > 1 {
            return Err(startup_invariant(
                "Device catalog contains duplicate Server Account identity",
            ));
        }

        let matched_account_id = matching_accounts.pop();
        let is_replacement = matched_account_id.is_some();
        let account_id =
            matched_account_id.unwrap_or_else(|| AccountId::from(entropy.generate_uuid()));
        if account_id.as_str().is_empty()
            || (!is_replacement
                && catalog
                    .accounts
                    .iter()
                    .any(|account| account.account_id == account_id))
        {
            return Err(startup_invariant(
                "generated Account identity collides with the Device catalog",
            ));
        }
        let previous_metadata = active_metadata.get(&account_id);
        let existing_catalog_account = catalog
            .accounts
            .iter()
            .find(|account| account.account_id == account_id);
        let expected_active_incarnation =
            existing_catalog_account.and_then(|account| account.active_incarnation.clone());
        let incarnation = crate::protocol::Incarnation::from(entropy.generate_uuid());
        if incarnation.as_str().is_empty()
            || catalog.accounts.iter().any(|account| {
                account.active_incarnation.as_ref() == Some(&incarnation)
                    || account
                        .pending_install
                        .as_ref()
                        .is_some_and(|pending| pending.incarnation == incarnation)
            })
        {
            return Err(startup_invariant(
                "generated Account incarnation collides with the Device catalog",
            ));
        }

        let execution_lock = self.account_execution_lock(&account_id)?;
        let execution_guard = execution_lock.lock().await;
        self.ensure_open()?;
        let previous_snapshot = self.replica.snapshot(&account_id);
        match (&expected_active_incarnation, &previous_snapshot) {
            (Some(expected), Some(snapshot))
                if snapshot.incarnation == *expected && snapshot.user_id == verified.user.id => {}
            (None, None) => {}
            _ => {
                return Err(startup_invariant(
                    "Device catalog and Runtime Replica disagree before Account installation",
                ));
            }
        }

        let device_key = match self.platform_storage.load_device_key().await? {
            Some(document) => document,
            None => {
                let document = DeviceKeyDocument::new(entropy.generate_device_key());
                self.ensure_not_closed()?;
                self.platform_storage.store_device_key(&document).await?;
                document
            }
        };
        let prepared = prepare_authenticated_installation(
            verified,
            evidence,
            account_id.clone(),
            incarnation.clone(),
            previous_metadata,
            &device_key.key_bytes,
            clock,
        )?;

        let staged_catalog = stage_catalog_install(
            &catalog,
            account_id.clone(),
            incarnation.clone(),
            expected_active_incarnation.clone(),
        )?;
        self.ensure_not_closed()?;
        if let Err(error) = self
            .platform_storage
            .store_device_catalog(&staged_catalog)
            .await
        {
            self.rollback_pre_replica_install(original_catalog.as_ref(), &account_id, &incarnation)
                .await;
            return Err(error);
        }
        if let Err(error) = self.ensure_not_closed() {
            self.rollback_pre_replica_install(original_catalog.as_ref(), &account_id, &incarnation)
                .await;
            return Err(error);
        }
        if let Err(error) = self
            .platform_storage
            .store_account_metadata(&prepared.metadata)
            .await
        {
            self.rollback_pre_replica_install(original_catalog.as_ref(), &account_id, &incarnation)
                .await;
            return Err(error);
        }
        if let Err(error) = self.ensure_not_closed() {
            self.rollback_pre_replica_install(original_catalog.as_ref(), &account_id, &incarnation)
                .await;
            return Err(error);
        }
        if let Err(error) = self
            .platform_storage
            .store_quick_unlock(&prepared.quick_unlock)
            .await
        {
            self.rollback_pre_replica_install(original_catalog.as_ref(), &account_id, &incarnation)
                .await;
            return Err(error);
        }
        if let Err(error) = self.ensure_not_closed() {
            self.rollback_pre_replica_install(original_catalog.as_ref(), &account_id, &incarnation)
                .await;
            return Err(error);
        }

        let installed_snapshot = match self
            .replica
            .install_or_replace(
                account_id.clone(),
                prepared.metadata.user_id.clone(),
                incarnation.clone(),
            )
            .await
        {
            Ok(snapshot) => snapshot,
            Err(error) => match self.replica.load_uncached(&account_id).await {
                Ok(durable)
                    if durable_installation_is_unchanged(
                        durable.as_ref(),
                        previous_snapshot.as_ref(),
                    ) =>
                {
                    self.rollback_pre_replica_install(
                        original_catalog.as_ref(),
                        &account_id,
                        &incarnation,
                    )
                    .await;
                    return Err(error);
                }
                Ok(Some(snapshot))
                    if snapshot.incarnation == incarnation
                        && snapshot.user_id == prepared.metadata.user_id =>
                {
                    let invalidated =
                        self.fence_authenticated_installation(Some(snapshot), &account_id);
                    drop(execution_guard);
                    drop(catalog_guard);
                    finish_generation_fence(invalidated);
                    self.publish_all_unless_closed();
                    return Err(error);
                }
                Ok(Some(third_head)) => {
                    let invalidated =
                        self.fence_authenticated_installation(Some(third_head), &account_id);
                    drop(execution_guard);
                    drop(catalog_guard);
                    finish_generation_fence(invalidated);
                    self.publish_all_unless_closed();
                    return Err(startup_invariant(
                        "Replica changed to an unexpected generation during installation",
                    ));
                }
                Ok(None) | Err(_) => {
                    let invalidated = self.fence_authenticated_installation(None, &account_id);
                    drop(execution_guard);
                    drop(catalog_guard);
                    finish_generation_fence(invalidated);
                    self.publish_all_unless_closed();
                    return Err(startup_invariant(
                        "Replica installation outcome could not be established",
                    ));
                }
            },
        };

        if let Err(error) = self.ensure_not_closed() {
            let invalidated =
                self.fence_authenticated_installation(Some(installed_snapshot), &account_id);
            drop(execution_guard);
            drop(catalog_guard);
            finish_generation_fence(invalidated);
            self.publish_all_unless_closed();
            return Err(error);
        }

        let promoted_catalog =
            match promote_catalog_install(&staged_catalog, &account_id, &incarnation) {
                Ok(catalog) => catalog,
                Err(error) => {
                    let invalidated = self
                        .fence_authenticated_installation(Some(installed_snapshot), &account_id);
                    drop(execution_guard);
                    drop(catalog_guard);
                    finish_generation_fence(invalidated);
                    self.publish_all_unless_closed();
                    return Err(error);
                }
            };
        if let Err(error) = self
            .platform_storage
            .store_device_catalog(&promoted_catalog)
            .await
        {
            let invalidated =
                self.fence_authenticated_installation(Some(installed_snapshot), &account_id);
            drop(execution_guard);
            drop(catalog_guard);
            finish_generation_fence(invalidated);
            self.publish_all_unless_closed();
            return Err(error);
        }
        if let Err(error) = self.ensure_not_closed() {
            let invalidated =
                self.fence_authenticated_installation(Some(installed_snapshot), &account_id);
            drop(execution_guard);
            drop(catalog_guard);
            finish_generation_fence(invalidated);
            self.publish_all_unless_closed();
            return Err(error);
        }
        if let Err(error) = self
            .platform_storage
            .store_current_session(&prepared.current_session)
            .await
        {
            let invalidated =
                self.fence_authenticated_installation(Some(installed_snapshot), &account_id);
            drop(execution_guard);
            drop(catalog_guard);
            finish_generation_fence(invalidated);
            self.publish_all_unless_closed();
            return Err(error);
        }

        let publication = self.publish_authenticated_installation(
            installed_snapshot.clone(),
            account_id.clone(),
            incarnation.clone(),
            prepared.master_unlock_key,
        );
        let invalidated = match publication {
            Ok(invalidated) if !self.is_closed() => invalidated,
            Ok(first_invalidated) => {
                let invalidated =
                    self.fence_authenticated_installation(Some(installed_snapshot), &account_id);
                drop(execution_guard);
                drop(catalog_guard);
                finish_generation_fence(first_invalidated);
                finish_generation_fence(invalidated);
                self.publish_all_unless_closed();
                return Err(RuntimeError::new(
                    RuntimeErrorCode::RuntimeClosed,
                    "Runtime was closed during Account installation",
                ));
            }
            Err(error) => {
                let invalidated =
                    self.fence_authenticated_installation(Some(installed_snapshot), &account_id);
                drop(execution_guard);
                drop(catalog_guard);
                finish_generation_fence(invalidated);
                self.publish_all_unless_closed();
                return Err(error);
            }
        };
        drop(execution_guard);
        drop(catalog_guard);
        finish_generation_fence(invalidated);
        self.publish_all_unless_closed();

        if let Some(old_incarnation) = expected_active_incarnation {
            let _ = self
                .platform_storage
                .remove_account_metadata(&account_id, &old_incarnation)
                .await;
            let _ = self
                .platform_storage
                .remove_quick_unlock(&account_id, &old_incarnation)
                .await;
            let _ = self
                .platform_storage
                .remove_current_session(&account_id, &old_incarnation)
                .await;
        }

        Ok(RuntimeResponse::SignedIn {
            account_id,
            user_id: prepared.metadata.user_id,
        })
    }

    async fn rollback_pre_replica_install(
        &self,
        original_catalog: Option<&DeviceCatalogDocument>,
        account_id: &AccountId,
        incarnation: &crate::protocol::Incarnation,
    ) {
        match original_catalog {
            Some(catalog) => {
                let _ = self.platform_storage.store_device_catalog(catalog).await;
            }
            None => {
                let _ = self.platform_storage.remove_device_catalog().await;
            }
        }
        let _ = self
            .platform_storage
            .remove_account_metadata(account_id, incarnation)
            .await;
        let _ = self
            .platform_storage
            .remove_quick_unlock(account_id, incarnation)
            .await;
        let _ = self
            .platform_storage
            .remove_current_session(account_id, incarnation)
            .await;
    }

    fn fence_authenticated_installation(
        &self,
        snapshot: Option<crate::replica::ReplicaSnapshot>,
        account_id: &AccountId,
    ) -> Option<Arc<DeliveryToken>> {
        let _publication = self.publication.lock().expect("publication lock poisoned");
        let invalidated = self.invalidate_delivery(account_id);
        let previous_revision = self
            .replica
            .snapshot(account_id)
            .map_or(0, |snapshot| snapshot.revision);
        let lock_epoch = snapshot.as_ref().map(|snapshot| snapshot.lock_epoch);
        if let Some(snapshot) = snapshot {
            self.replica.cache(snapshot);
            self.recovery_accounts
                .lock()
                .expect("recovery Account lock poisoned")
                .remove(account_id);
        } else {
            self.replica.remove_cached(account_id);
            self.recovery_accounts
                .lock()
                .expect("recovery Account lock poisoned")
                .insert(
                    account_id.clone(),
                    RecoveryAccountStatus {
                        replica_revision: previous_revision,
                    },
                );
        }
        self.unlocked_items
            .lock()
            .expect("unlocked projection lock poisoned")
            .remove(account_id);
        self.clear_live_master_unlock_keys_for_account(account_id);
        let mut account_access = self
            .account_access
            .lock()
            .expect("Account access lock poisoned");
        let mut lock_epochs = self
            .account_lock_epochs
            .lock()
            .expect("Account lock epoch lock poisoned");
        if let Some(lock_epoch) = lock_epoch {
            account_access.insert(account_id.clone(), AccountAccessState::SignedOut);
            lock_epochs.insert(account_id.clone(), lock_epoch);
        } else {
            account_access.remove(account_id);
            lock_epochs.remove(account_id);
        }
        self.lock_epoch_pending
            .lock()
            .expect("pending lock epoch lock poisoned")
            .remove(account_id);
        self.device_revision.fetch_add(1, Ordering::SeqCst);
        invalidated
    }

    fn publish_authenticated_installation(
        &self,
        snapshot: crate::replica::ReplicaSnapshot,
        account_id: AccountId,
        incarnation: crate::protocol::Incarnation,
        master_unlock_key: Zeroizing<[u8; 32]>,
    ) -> Result<Option<Arc<DeliveryToken>>, RuntimeError> {
        let _publication = self.publication.lock().expect("publication lock poisoned");
        if self.is_closed() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::RuntimeClosed,
                "Runtime was closed during Account installation",
            ));
        }
        let invalidated = self.invalidate_delivery(&account_id);
        self.replica.cache(snapshot);
        self.recovery_accounts
            .lock()
            .expect("recovery Account lock poisoned")
            .remove(&account_id);
        self.unlocked_items
            .lock()
            .expect("unlocked projection lock poisoned")
            .insert(account_id.clone(), Vec::new());
        self.clear_live_master_unlock_keys_for_account(&account_id);
        self.live_master_unlock_keys
            .lock()
            .expect("live master unlock key lock poisoned")
            .insert(
                (account_id.clone(), incarnation),
                LiveMasterUnlockKey::new(master_unlock_key),
            );
        self.account_access
            .lock()
            .expect("Account access lock poisoned")
            .insert(account_id.clone(), AccountAccessState::Unlocked);
        self.account_lock_epochs
            .lock()
            .expect("Account lock epoch lock poisoned")
            .insert(account_id.clone(), 0);
        self.lock_epoch_pending
            .lock()
            .expect("pending lock epoch lock poisoned")
            .remove(&account_id);
        self.device_revision.fetch_add(1, Ordering::SeqCst);
        Ok(invalidated)
    }

    async fn commit_quick_unlock(
        &self,
        snapshot: crate::replica::ReplicaSnapshot,
        prepared: PreparedQuickUnlock,
        execution_guard: tokio::sync::MutexGuard<'_, ()>,
    ) -> Result<RuntimeResponse, RuntimeError> {
        let account_id = snapshot.account_id.clone();
        let user_id = snapshot.user_id.clone();

        if let Err(error) = self
            .platform_storage
            .store_account_metadata(&prepared.metadata)
            .await
        {
            return self
                .finish_failed_quick_unlock(&snapshot, execution_guard, error)
                .await;
        }
        if let Err(error) = self
            .platform_storage
            .store_quick_unlock(&prepared.quick_unlock)
            .await
        {
            return self
                .finish_failed_quick_unlock(&snapshot, execution_guard, error)
                .await;
        }
        if let Err(error) = self
            .platform_storage
            .store_current_session(&prepared.current_session)
            .await
        {
            return self
                .finish_failed_quick_unlock(&snapshot, execution_guard, error)
                .await;
        }

        let publication = self.publish_quick_unlock(&snapshot, prepared.master_unlock_key);
        let invalidated = match publication {
            Ok(invalidated) if !self.is_closed() => invalidated,
            Ok(first_invalidated) => {
                let invalidated = self.fence_quick_unlock(&snapshot);
                drop(execution_guard);
                finish_generation_fence(first_invalidated);
                finish_generation_fence(invalidated);
                self.publish_all_unless_closed();
                return Err(RuntimeError::new(
                    RuntimeErrorCode::RuntimeClosed,
                    "Runtime was closed during Quick Unlock",
                ));
            }
            Err(error) => {
                let invalidated = self.fence_quick_unlock(&snapshot);
                drop(execution_guard);
                finish_generation_fence(invalidated);
                self.publish_all_unless_closed();
                return Err(error);
            }
        };
        drop(execution_guard);
        finish_generation_fence(invalidated);
        self.publish_all_unless_closed();
        Ok(RuntimeResponse::SignedIn {
            account_id,
            user_id,
        })
    }

    async fn finish_failed_quick_unlock(
        &self,
        snapshot: &crate::replica::ReplicaSnapshot,
        execution_guard: tokio::sync::MutexGuard<'_, ()>,
        error: RuntimeError,
    ) -> Result<RuntimeResponse, RuntimeError> {
        let invalidated = self.fence_quick_unlock(snapshot);
        drop(execution_guard);
        finish_generation_fence(invalidated);
        self.publish_all_unless_closed();
        Err(error)
    }

    fn publish_quick_unlock(
        &self,
        expected: &crate::replica::ReplicaSnapshot,
        master_unlock_key: Zeroizing<[u8; 32]>,
    ) -> Result<Option<Arc<DeliveryToken>>, RuntimeError> {
        let _publication = self.publication.lock().expect("publication lock poisoned");
        if self.is_closed() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::RuntimeClosed,
                "Runtime was closed during Quick Unlock",
            ));
        }
        let current = self.replica.snapshot(&expected.account_id).ok_or_else(|| {
            RuntimeError::new(RuntimeErrorCode::AccountMissing, "account is not installed")
        })?;
        if current.incarnation != expected.incarnation
            || current.user_id != expected.user_id
            || current.revision != expected.revision
            || current.lock_epoch != expected.lock_epoch
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::AuthenticationRequired,
                "Account generation changed during Quick Unlock",
            ));
        }

        let invalidated = self.invalidate_delivery(&expected.account_id);
        self.unlocked_items
            .lock()
            .expect("unlocked projection lock poisoned")
            .insert(expected.account_id.clone(), Vec::new());
        self.clear_live_master_unlock_keys_for_account(&expected.account_id);
        self.live_master_unlock_keys
            .lock()
            .expect("live master unlock key lock poisoned")
            .insert(
                (expected.account_id.clone(), expected.incarnation.clone()),
                LiveMasterUnlockKey::new(master_unlock_key),
            );
        self.account_access
            .lock()
            .expect("Account access lock poisoned")
            .insert(expected.account_id.clone(), AccountAccessState::Unlocked);
        self.device_revision.fetch_add(1, Ordering::SeqCst);
        Ok(invalidated)
    }

    fn fence_quick_unlock(
        &self,
        expected: &crate::replica::ReplicaSnapshot,
    ) -> Option<Arc<DeliveryToken>> {
        let _publication = self.publication.lock().expect("publication lock poisoned");
        let current = self.replica.snapshot(&expected.account_id)?;
        if current.incarnation != expected.incarnation || current.user_id != expected.user_id {
            return None;
        }
        let invalidated = self.invalidate_delivery(&expected.account_id);
        self.unlocked_items
            .lock()
            .expect("unlocked projection lock poisoned")
            .remove(&expected.account_id);
        self.clear_live_master_unlock_keys_for_account(&expected.account_id);
        self.account_access
            .lock()
            .expect("Account access lock poisoned")
            .insert(expected.account_id.clone(), AccountAccessState::SignedOut);
        self.device_revision.fetch_add(1, Ordering::SeqCst);
        invalidated
    }

    #[doc(hidden)]
    pub async fn restore_known_accounts(
        &self,
        account_ids: Vec<AccountId>,
    ) -> Result<(), RuntimeError> {
        let _catalog_guard = self.catalog_transition.lock().await;
        self.ensure_open()?;
        let mut unique = HashSet::with_capacity(account_ids.len());
        for account_id in &account_ids {
            if !unique.insert(account_id.clone()) {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::InvariantViolation,
                    "known Account identity is duplicated",
                ));
            }
        }
        let mut lock_ids: HashSet<_> = self
            .replica
            .snapshots()
            .into_iter()
            .map(|snapshot| snapshot.account_id)
            .collect();
        lock_ids.extend(account_ids.iter().cloned());
        let mut lock_ids: Vec<_> = lock_ids.into_iter().collect();
        lock_ids.sort_by(|a, b| a.as_str().cmp(b.as_str()));
        let execution_locks: Vec<_> = lock_ids
            .iter()
            .map(|account_id| self.account_execution_lock(account_id))
            .collect::<Result<_, _>>()?;
        let mut execution_guards = Vec::with_capacity(execution_locks.len());
        for lock in &execution_locks {
            execution_guards.push(lock.lock().await);
        }
        self.ensure_open()?;
        let restored = self.replica.restore_known_accounts(&account_ids).await?;
        let _publication = self.publication.lock().expect("publication lock poisoned");
        let invalidated_deliveries: Vec<_> = lock_ids
            .iter()
            .filter_map(|account_id| self.invalidate_delivery(account_id))
            .collect();
        self.replica.replace_cache(&restored);
        self.recovery_accounts
            .lock()
            .expect("recovery Account lock poisoned")
            .clear();
        {
            let mut access = self
                .account_access
                .lock()
                .expect("Account access lock poisoned");
            *access = restored
                .iter()
                .map(|snapshot| (snapshot.account_id.clone(), AccountAccessState::SignedOut))
                .collect();
        }
        self.unlocked_items
            .lock()
            .expect("unlocked projection lock poisoned")
            .clear();
        self.live_master_unlock_keys
            .lock()
            .expect("live master unlock key lock poisoned")
            .clear();
        *self
            .account_lock_epochs
            .lock()
            .expect("Account lock epoch lock poisoned") = restored
            .iter()
            .map(|snapshot| (snapshot.account_id.clone(), snapshot.lock_epoch))
            .collect();
        self.lock_epoch_pending
            .lock()
            .expect("pending lock epoch lock poisoned")
            .clear();
        self.device_revision.fetch_add(1, Ordering::SeqCst);
        drop(_publication);
        drop(execution_guards);
        drop(_catalog_guard);
        for token in invalidated_deliveries {
            token.wait_for_other_threads();
        }
        self.publish_all();
        Ok(())
    }

    #[cfg(test)]
    pub(crate) async fn unlock_account(&self, account_id: &AccountId) -> Result<(), RuntimeError> {
        let execution_lock = self.account_execution_lock(account_id)?;
        let _execution_guard = execution_lock.lock().await;
        self.ensure_open()?;
        if self
            .lock_epoch_pending
            .lock()
            .expect("pending lock epoch lock poisoned")
            .contains_key(account_id)
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "Account lock epoch persistence is pending",
            ));
        }
        let snapshot = self.replica.snapshot(account_id).ok_or_else(|| {
            RuntimeError::new(RuntimeErrorCode::AccountMissing, "account is not installed")
        })?;
        if snapshot.lock_epoch == u64::MAX {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "Account lock epoch is exhausted",
            ));
        }
        let _publication = self.publication.lock().expect("publication lock poisoned");
        self.account_access
            .lock()
            .expect("Account access lock poisoned")
            .insert(account_id.clone(), AccountAccessState::Unlocked);
        self.unlocked_items
            .lock()
            .expect("unlocked projection lock poisoned")
            .entry(account_id.clone())
            .or_default();
        self.account_lock_epochs
            .lock()
            .expect("Account lock epoch lock poisoned")
            .entry(account_id.clone())
            .or_insert(0);
        Ok(())
    }

    #[doc(hidden)]
    pub async fn mark_account_locked(&self, account_id: &AccountId) -> Result<(), RuntimeError> {
        let execution_lock = self.account_execution_lock(account_id)?;
        let execution_guard = execution_lock.lock().await;
        self.ensure_open()?;
        let snapshot = self.replica.snapshot(account_id).ok_or_else(|| {
            RuntimeError::new(RuntimeErrorCode::AccountMissing, "account is not installed")
        })?;
        let pending_epoch = self
            .lock_epoch_pending
            .lock()
            .expect("pending lock epoch lock poisoned")
            .get(account_id)
            .copied();
        let overflowed = snapshot.lock_epoch == u64::MAX;
        let desired_epoch = if overflowed {
            snapshot.lock_epoch
        } else {
            pending_epoch.unwrap_or(snapshot.lock_epoch + 1)
        };
        let _publication = self.publication.lock().expect("publication lock poisoned");
        let invalidated_delivery = self.invalidate_delivery(account_id);
        self.unlocked_items
            .lock()
            .expect("unlocked projection lock poisoned")
            .remove(account_id);
        self.clear_live_master_unlock_keys_for_account(account_id);
        self.account_access
            .lock()
            .expect("Account access lock poisoned")
            .insert(account_id.clone(), AccountAccessState::Locked);
        self.account_lock_epochs
            .lock()
            .expect("Account lock epoch lock poisoned")
            .insert(account_id.clone(), desired_epoch);
        if overflowed {
            self.lock_epoch_pending
                .lock()
                .expect("pending lock epoch lock poisoned")
                .remove(account_id);
        } else {
            self.lock_epoch_pending
                .lock()
                .expect("pending lock epoch lock poisoned")
                .insert(account_id.clone(), desired_epoch);
        }
        self.device_revision.fetch_add(1, Ordering::SeqCst);
        drop(_publication);
        drop(execution_guard);
        if let Some(token) = invalidated_delivery {
            token.wait_for_other_threads();
        }
        self.publish_all();
        if overflowed {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "Account lock epoch overflowed",
            ));
        }
        let _execution_guard = execution_lock.lock().await;
        let durable = self
            .replica
            .advance_lock_epoch(
                account_id,
                &snapshot.user_id,
                &snapshot.incarnation,
                desired_epoch,
            )
            .await?;
        let _publication = self.publication.lock().expect("publication lock poisoned");
        self.replica.cache(durable);
        self.account_lock_epochs
            .lock()
            .expect("Account lock epoch lock poisoned")
            .insert(account_id.clone(), desired_epoch);
        self.lock_epoch_pending
            .lock()
            .expect("pending lock epoch lock poisoned")
            .remove(account_id);
        Ok(())
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
            RuntimeRequest::CreateLoginItem {
                account_id,
                vault_id,
                draft,
            } => {
                self.ensure_open()?;
                if cancellation.is_cancelled() {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::Cancelled,
                        "caller cancelled before durable acceptance",
                    ));
                }
                let execution_lock = self.account_execution_lock(&account_id)?;
                let _execution_guard = execution_lock.lock().await;
                self.ensure_open()?;
                let snapshot = self.replica.snapshot(&account_id).ok_or_else(|| {
                    RuntimeError::new(RuntimeErrorCode::AccountMissing, "account is not installed")
                })?;
                if snapshot.failure.is_some() {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::AccountFailed,
                        "the selected Account module has failed",
                    ));
                }
                if snapshot.lock_epoch == u64::MAX {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::AuthenticationRequired,
                        "Account lock epoch is exhausted",
                    ));
                }
                if self
                    .account_access
                    .lock()
                    .expect("Account access lock poisoned")
                    .get(&account_id)
                    != Some(&AccountAccessState::Unlocked)
                {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::AuthenticationRequired,
                        "the selected Account is signed out or locked",
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
                let lock_epoch = *self
                    .account_lock_epochs
                    .lock()
                    .expect("Account lock epoch lock poisoned")
                    .entry(account_id.clone())
                    .or_insert(0);
                let operation_id = bittery_crypto_core::generate_uuid();
                let item_id = bittery_crypto_core::generate_uuid();
                let projection = LoginItemProjection {
                    account_id: account_id.clone(),
                    item_id: item_id.clone(),
                    vault_id: vault_id.clone(),
                    title: draft.title,
                    url: draft.url,
                    urls: draft.urls,
                    username: draft.username,
                    password: draft.password,
                    notes: draft.notes,
                    note: draft.note,
                    custom_fields: draft.custom_fields,
                    tags: draft.tags,
                    status: ItemProjectionStatus::Pending,
                };
                // Ticket 21 replaces this marker with existing crypto-core encryption and AAD.
                // This foundation never persists the plaintext draft.
                let sealed_item = ReplicaItemRecord {
                    account_id: account_id.clone(),
                    item_id: item_id.clone(),
                    vault_id,
                    ciphertext: format!("simulated-sealed:{item_id}").into_bytes(),
                    optimistic: true,
                };
                let result = self
                    .replica
                    .execute_recomputing(GuardedCommitPlan::new(
                        account_id.clone(),
                        snapshot.incarnation,
                        snapshot.revision,
                        lock_epoch,
                        vec![
                            PlanMutation::AcceptOperation(OperationRecord {
                                operation_id: operation_id.clone(),
                                item_id: item_id.clone(),
                                request_bytes: format!("simulated-sealed-request:{item_id}")
                                    .into_bytes(),
                            }),
                            PlanMutation::PutOptimisticItem(sealed_item),
                        ],
                    ))
                    .await?;
                let (replica_revision, next_snapshot) = match result {
                    RecomputedPlanResult::Applied { snapshot } => (snapshot.revision, snapshot),
                    RecomputedPlanResult::Fenced { snapshot } => {
                        let _publication =
                            self.publication.lock().expect("publication lock poisoned");
                        let invalidated_delivery = self.invalidate_delivery(&account_id);
                        self.replica.cache(snapshot.clone());
                        self.unlocked_items
                            .lock()
                            .expect("unlocked projection lock poisoned")
                            .remove(&account_id);
                        self.clear_live_master_unlock_keys_for_account(&account_id);
                        self.account_access
                            .lock()
                            .expect("Account access lock poisoned")
                            .insert(account_id.clone(), AccountAccessState::Locked);
                        self.account_lock_epochs
                            .lock()
                            .expect("Account lock epoch lock poisoned")
                            .insert(account_id.clone(), snapshot.lock_epoch);
                        self.device_revision.fetch_add(1, Ordering::SeqCst);
                        drop(_publication);
                        drop(_execution_guard);
                        if let Some(token) = invalidated_delivery {
                            token.wait_for_other_threads();
                        }
                        self.publish_all();
                        return Err(RuntimeError::new(
                            RuntimeErrorCode::AuthenticationRequired,
                            "Account was locked while accepting work",
                        ));
                    }
                    RecomputedPlanResult::Missing => {
                        let _publication =
                            self.publication.lock().expect("publication lock poisoned");
                        self.replica.remove_cached(&account_id);
                        self.recovery_accounts
                            .lock()
                            .expect("recovery Account lock poisoned")
                            .remove(&account_id);
                        self.unlocked_items
                            .lock()
                            .expect("unlocked projection lock poisoned")
                            .remove(&account_id);
                        self.clear_live_master_unlock_keys_for_account(&account_id);
                        self.device_revision.fetch_add(1, Ordering::SeqCst);
                        drop(_publication);
                        drop(_execution_guard);
                        self.publish_all();
                        return Err(RuntimeError::new(
                            RuntimeErrorCode::AccountMissing,
                            "account was removed during durable acceptance",
                        ));
                    }
                };
                let _publication = self.publication.lock().expect("publication lock poisoned");
                self.replica.cache(next_snapshot);
                if self
                    .account_lock_epochs
                    .lock()
                    .expect("Account lock epoch lock poisoned")
                    .get(&account_id)
                    == Some(&lock_epoch)
                {
                    self.unlocked_items
                        .lock()
                        .expect("unlocked projection lock poisoned")
                        .entry(account_id)
                        .or_default()
                        .push(projection);
                }
                self.device_revision.fetch_add(1, Ordering::SeqCst);
                drop(_publication);
                accepted();
                drop(_execution_guard);
                self.publish_all();
                if cancellation.is_cancelled() {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::Cancelled,
                        "caller cancelled after durable acceptance",
                    ));
                }
                Ok(RuntimeResponse::Accepted {
                    operation_id,
                    item_id,
                    replica_revision,
                })
            }
        }
    }

    async fn resolve_sign_in_kdf_pin(
        &self,
        normalized_server_url: &str,
        normalized_email: &str,
    ) -> Result<Option<bittery_crypto_core::KdfProfile>, RuntimeError> {
        let _catalog_guard = self.catalog_transition.lock().await;
        self.ensure_open()?;
        let Some(catalog) = self.platform_storage.load_device_catalog().await? else {
            return Ok(None);
        };
        let mut matching_profile = None;
        for account in catalog.accounts {
            let incarnation = account.active_incarnation.ok_or_else(|| {
                startup_invariant("active catalog Account has no active incarnation")
            })?;
            let metadata = self
                .platform_storage
                .load_account_metadata(&account.account_id, &incarnation)
                .await?
                .ok_or_else(|| {
                    startup_invariant("active catalog Account has no generation metadata")
                })?;
            if metadata.normalized_server_url == normalized_server_url
                && bittery_crypto_core::normalize_email(&metadata.email) == normalized_email
            {
                if matching_profile.is_some() {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::AuthenticationUnavailable,
                        "Device catalog has ambiguous authentication downgrade evidence",
                    ));
                }
                matching_profile = Some(metadata.pinned_kdf_profile);
            }
        }
        Ok(matching_profile)
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
mod startup_tests {
    use super::*;
    use crate::{
        platform_storage::{AccountMetadataDocument, PendingAccountInstallIntent},
        protocol::Incarnation,
        replica::{
            InMemoryReplica, ReplicaPersistence, ReplicaPersistenceRequest,
            SerializedReplicaExecutor,
        },
        ObservationSink, RequestCancellation, RuntimeRequest,
    };
    use async_trait::async_trait;
    use serde_json::{json, Value};
    use std::sync::atomic::AtomicUsize;
    use std::{future::Future, task::Wake, thread};

    struct ThreadWake(thread::Thread);

    impl Wake for ThreadWake {
        fn wake(self: Arc<Self>) {
            self.0.unpark();
        }
    }

    fn block_on<F: Future>(future: F) -> F::Output {
        let waker = Arc::new(ThreadWake(thread::current())).into();
        let mut context = std::task::Context::from_waker(&waker);
        let mut future = Box::pin(future);
        loop {
            match future.as_mut().poll(&mut context) {
                std::task::Poll::Ready(value) => return value,
                std::task::Poll::Pending => thread::park(),
            }
        }
    }

    struct MemoryReplicaExecutor {
        state: InMemoryReplica,
        loads: AtomicUsize,
    }

    struct UnusedHttpExecutor;

    #[async_trait]
    impl SerializedHttpExecutor for UnusedHttpExecutor {
        async fn invoke(&self, _request_json: String) -> Result<String, RuntimeError> {
            panic!("startup tests must not invoke HTTP")
        }

        fn cancel(&self, _dispatch_id: &str) {
            panic!("startup tests must not cancel HTTP")
        }
    }

    impl Default for MemoryReplicaExecutor {
        fn default() -> Self {
            Self {
                state: InMemoryReplica::default(),
                loads: AtomicUsize::new(0),
            }
        }
    }

    #[async_trait]
    impl SerializedReplicaExecutor for MemoryReplicaExecutor {
        async fn invoke(&self, request_json: String) -> Result<String, RuntimeError> {
            let request: ReplicaPersistenceRequest = serde_json::from_str(&request_json).unwrap();
            if matches!(request, ReplicaPersistenceRequest::Load { .. }) {
                self.loads.fetch_add(1, Ordering::SeqCst);
            }
            serde_json::to_string(&self.state.invoke(request).await?)
                .map_err(|_| startup_invariant("test Replica response could not serialize"))
        }
    }

    #[derive(Default)]
    struct MemoryPlatformExecutor {
        values: Mutex<HashMap<(String, String), String>>,
        deletes: Mutex<Vec<String>>,
        fail_next_set: AtomicBool,
    }

    #[derive(Default)]
    struct PausingPlatformExecutor {
        inner: MemoryPlatformExecutor,
        reached: (Mutex<bool>, Condvar),
        released: (Mutex<bool>, Condvar),
    }

    impl PausingPlatformExecutor {
        fn wait_until_reached(&self) {
            let mut reached = self.reached.0.lock().unwrap();
            while !*reached {
                reached = self.reached.1.wait(reached).unwrap();
            }
        }

        fn release(&self) {
            *self.released.0.lock().unwrap() = true;
            self.released.1.notify_all();
        }
    }

    impl MemoryPlatformExecutor {
        fn put<T: serde::Serialize>(&self, area: &str, key: String, value: &T) {
            self.values
                .lock()
                .unwrap()
                .insert((area.into(), key), serde_json::to_string(value).unwrap());
        }

        fn catalog(&self) -> Option<DeviceCatalogDocument> {
            self.values
                .lock()
                .unwrap()
                .get(&("devicePlain".into(), catalog_key()))
                .map(|value| serde_json::from_str(value).unwrap())
        }
    }

    #[async_trait]
    impl SerializedPlatformStorageExecutor for MemoryPlatformExecutor {
        async fn invoke(
            &self,
            request_json: zeroize::Zeroizing<String>,
        ) -> Result<zeroize::Zeroizing<String>, RuntimeError> {
            let request: Value = serde_json::from_str(&request_json).unwrap();
            let area = request["area"].as_str().unwrap().to_owned();
            let key = request["key"].as_str().unwrap().to_owned();
            match request["type"].as_str().unwrap() {
                "get" => Ok(zeroize::Zeroizing::new(
                    json!({
                        "type": "value",
                        "value": self.values.lock().unwrap().get(&(area, key)).cloned()
                    })
                    .to_string(),
                )),
                "set" => {
                    if self.fail_next_set.swap(false, Ordering::SeqCst) {
                        return Err(startup_invariant("injected catalog write failure"));
                    }
                    self.values
                        .lock()
                        .unwrap()
                        .insert((area, key), request["value"].as_str().unwrap().to_owned());
                    Ok(zeroize::Zeroizing::new(json!({"type": "done"}).to_string()))
                }
                "delete" => {
                    self.values.lock().unwrap().remove(&(area, key.clone()));
                    self.deletes.lock().unwrap().push(key);
                    Ok(zeroize::Zeroizing::new(json!({"type": "done"}).to_string()))
                }
                _ => unreachable!(),
            }
        }
    }

    #[async_trait]
    impl SerializedPlatformStorageExecutor for PausingPlatformExecutor {
        async fn invoke(
            &self,
            request_json: zeroize::Zeroizing<String>,
        ) -> Result<zeroize::Zeroizing<String>, RuntimeError> {
            if serde_json::from_str::<Value>(&request_json).unwrap()["type"] == "get" {
                *self.reached.0.lock().unwrap() = true;
                self.reached.1.notify_all();
                let mut released = self.released.0.lock().unwrap();
                while !*released {
                    released = self.released.1.wait(released).unwrap();
                }
            }
            self.inner.invoke(request_json).await
        }
    }

    #[derive(Default)]
    struct Sink(Mutex<Vec<RuntimeProjection>>);

    impl ObservationSink for Sink {
        fn publish(&self, projection: RuntimeProjection) {
            self.0.lock().unwrap().push(projection);
        }
    }

    fn catalog_key() -> String {
        "bittery:runtime:platform-storage:device-catalog".into()
    }

    fn generation_key(account: &str, incarnation: &str, document: &str) -> String {
        format!(
            "bittery:runtime:platform-storage:account:{}:{account}:incarnation:{}:{incarnation}:{document}",
            account.len(),
            incarnation.len()
        )
    }

    fn account(value: &str) -> AccountId {
        AccountId::from(value)
    }

    fn incarnation(value: &str) -> Incarnation {
        Incarnation::from(value)
    }

    fn metadata(account_id: &str, generation: &str, user_id: &str) -> AccountMetadataDocument {
        AccountMetadataDocument::new(
            account(account_id),
            incarnation(generation),
            user_id.into(),
            "user@example.com".into(),
            "User".into(),
            "https://vault.example.com".into(),
            None,
            None,
            "A3-TEST".into(),
            1,
            2,
            false,
            false,
            bittery_crypto_core::KdfProfile {
                schema_version: 1,
                algorithm: "pbkdf2-sha256".into(),
                iterations: 600_000,
            },
            None,
        )
        .unwrap()
    }

    fn seed_catalog(platform: &MemoryPlatformExecutor, accounts: Vec<DeviceCatalogAccount>) {
        platform.put(
            "devicePlain",
            catalog_key(),
            &DeviceCatalogDocument::new(accounts).unwrap(),
        );
    }

    fn seed_metadata(
        platform: &MemoryPlatformExecutor,
        account_id: &str,
        generation: &str,
        user_id: &str,
    ) {
        platform.put(
            "devicePlain",
            generation_key(account_id, generation, "metadata"),
            &metadata(account_id, generation, user_id),
        );
    }

    fn production_runtime(
        replica: Arc<MemoryReplicaExecutor>,
        platform: Arc<MemoryPlatformExecutor>,
    ) -> Arc<Runtime> {
        Runtime::with_serialized_executors(replica, platform, Arc::new(UnusedHttpExecutor))
    }

    fn active(account_id: &str, generation: &str) -> DeviceCatalogAccount {
        DeviceCatalogAccount {
            account_id: account(account_id),
            active_incarnation: Some(incarnation(generation)),
            pending_install: None,
        }
    }

    fn pending(account_id: &str, active: Option<&str>, pending: &str) -> DeviceCatalogAccount {
        DeviceCatalogAccount {
            account_id: account(account_id),
            active_incarnation: active.map(incarnation),
            pending_install: Some(PendingAccountInstallIntent {
                incarnation: incarnation(pending),
                expected_active_incarnation: active.map(incarnation),
            }),
        }
    }

    #[tokio::test]
    async fn production_runtime_is_cold_and_missing_catalog_opens_without_scanning_replica() {
        let replica = Arc::new(MemoryReplicaExecutor::default());
        let platform = Arc::new(MemoryPlatformExecutor::default());
        let runtime = production_runtime(replica.clone(), platform);
        let error = runtime
            .request(
                RuntimeRequest::SignIn {
                    email: "user@example.com".into(),
                    master_password: "password".into(),
                    secret_key: "A3-TEST".into(),
                    server_url: "https://vault.example.com".into(),
                    insecure_transport_confirmed: false,
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
        assert!(runtime
            .observe(
                ObservationRequest::RuntimeStatus { account_id: None },
                Arc::new(Sink::default()),
            )
            .is_err());

        runtime.open().await.unwrap();
        runtime.open().await.unwrap();
        assert_eq!(replica.loads.load(Ordering::SeqCst), 0);
        assert!(runtime.replica.snapshots().is_empty());
    }

    #[tokio::test]
    async fn open_restores_final_active_accounts_signed_out_once() {
        let replica = Arc::new(MemoryReplicaExecutor::default());
        replica
            .state
            .install(
                account("account-1"),
                "user-1".into(),
                incarnation("generation-1"),
            )
            .unwrap();
        let platform = Arc::new(MemoryPlatformExecutor::default());
        seed_catalog(&platform, vec![active("account-1", "generation-1")]);
        seed_metadata(&platform, "account-1", "generation-1", "user-1");
        let runtime = production_runtime(replica.clone(), platform);

        runtime.open().await.unwrap();
        runtime.open().await.unwrap();

        assert_eq!(replica.loads.load(Ordering::SeqCst), 1);
        assert_eq!(runtime.device_revision.load(Ordering::SeqCst), 1);
        assert_eq!(
            runtime.account_access_state(&account("account-1")),
            Some(AccountAccessState::SignedOut)
        );
        assert_eq!(runtime.lock_epoch(&account("account-1")), Some(0));
    }

    #[tokio::test]
    async fn open_promotes_or_rolls_back_pending_install_from_the_replica_head() {
        for (head, expected_active, expected_orphan) in
            [("new", "new", "old"), ("old", "old", "new")]
        {
            let replica = Arc::new(MemoryReplicaExecutor::default());
            replica
                .state
                .install(account("account"), "user".into(), incarnation(head))
                .unwrap();
            let platform = Arc::new(MemoryPlatformExecutor::default());
            seed_catalog(&platform, vec![pending("account", Some("old"), "new")]);
            seed_metadata(&platform, "account", head, "user");
            let runtime = production_runtime(replica, platform.clone());

            runtime.open().await.unwrap();

            let catalog = platform.catalog().unwrap();
            assert_eq!(
                catalog.accounts[0].active_incarnation,
                Some(incarnation(expected_active))
            );
            assert!(catalog.accounts[0].pending_install.is_none());
            assert!(platform
                .deletes
                .lock()
                .unwrap()
                .iter()
                .any(|key| key.contains(expected_orphan)));
        }
    }

    #[tokio::test]
    async fn open_removes_an_uncommitted_first_install() {
        let replica = Arc::new(MemoryReplicaExecutor::default());
        let platform = Arc::new(MemoryPlatformExecutor::default());
        seed_catalog(&platform, vec![pending("account", None, "new")]);
        let runtime = production_runtime(replica, platform.clone());

        runtime.open().await.unwrap();

        assert!(platform.catalog().unwrap().accounts.is_empty());
        assert!(runtime.replica.snapshots().is_empty());
    }

    #[tokio::test]
    async fn open_fails_atomically_for_missing_third_or_metadata_mismatched_heads() {
        for scenario in ["missing", "third", "user"] {
            let replica = Arc::new(MemoryReplicaExecutor::default());
            if scenario != "missing" {
                let generation = if scenario == "third" { "third" } else { "old" };
                replica
                    .state
                    .install(account("account"), "user".into(), incarnation(generation))
                    .unwrap();
            }
            let platform = Arc::new(MemoryPlatformExecutor::default());
            seed_catalog(&platform, vec![active("account", "old")]);
            if scenario == "user" {
                seed_metadata(&platform, "account", "old", "another-user");
            }
            let runtime = production_runtime(replica, platform);

            assert!(runtime.open().await.is_err(), "scenario {scenario}");
            assert!(runtime.replica.snapshots().is_empty());
            assert!(runtime
                .observe(
                    ObservationRequest::RuntimeStatus { account_id: None },
                    Arc::new(Sink::default()),
                )
                .is_err());
        }
    }

    #[tokio::test]
    async fn corrective_catalog_write_failure_exposes_nothing_and_open_retries() {
        let replica = Arc::new(MemoryReplicaExecutor::default());
        replica
            .state
            .install(account("account"), "user".into(), incarnation("old"))
            .unwrap();
        let platform = Arc::new(MemoryPlatformExecutor::default());
        seed_catalog(&platform, vec![pending("account", Some("old"), "new")]);
        seed_metadata(&platform, "account", "old", "user");
        platform.fail_next_set.store(true, Ordering::SeqCst);
        let runtime = production_runtime(replica, platform.clone());

        assert!(runtime.open().await.is_err());
        assert!(runtime.replica.snapshots().is_empty());
        assert!(platform.catalog().unwrap().accounts[0]
            .pending_install
            .is_some());
        runtime.open().await.unwrap();
        assert!(platform.catalog().unwrap().accounts[0]
            .pending_install
            .is_none());
        assert_eq!(runtime.replica.snapshots().len(), 1);
    }

    #[tokio::test]
    async fn closed_cold_runtime_never_opens() {
        let runtime = production_runtime(
            Arc::new(MemoryReplicaExecutor::default()),
            Arc::new(MemoryPlatformExecutor::default()),
        );
        runtime.close().await;
        let error = runtime.open().await.unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::RuntimeClosed);
        assert!(runtime.replica.snapshots().is_empty());
    }

    #[test]
    fn close_racing_open_prevents_startup_publication() {
        let platform = Arc::new(PausingPlatformExecutor::default());
        let runtime = Runtime::with_serialized_executors(
            Arc::new(MemoryReplicaExecutor::default()),
            platform.clone(),
            Arc::new(UnusedHttpExecutor),
        );
        let opening = {
            let runtime = runtime.clone();
            thread::spawn(move || block_on(runtime.open()))
        };
        platform.wait_until_reached();
        let closing = {
            let runtime = runtime.clone();
            thread::spawn(move || block_on(runtime.close()))
        };
        while !runtime.is_closed() {
            thread::yield_now();
        }
        platform.release();

        let error = opening.join().unwrap().unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::RuntimeClosed);
        closing.join().unwrap();
        assert!(runtime.replica.snapshots().is_empty());
    }
}

#[cfg(test)]
mod authenticated_installation_tests {
    use super::*;
    use crate::{
        auth_http::{AuthClientConfig, ClientPlatform},
        authentication_installation::{
            AuthenticationInstallationEvidence, FixedClock, InstallationEntropy,
        },
        platform_storage::SerializedPlatformStorageExecutor,
        protocol::Incarnation,
        replica::{
            InMemoryReplica, ReplicaPersistence, ReplicaPersistenceRequest,
            SerializedReplicaExecutor,
        },
        server_contract::{
            AuthVaultKeyResponse, LoginUserResponse, TravelModeResponse, VaultRole, VaultType,
        },
    };
    use async_trait::async_trait;
    use bittery_crypto_core::{
        current_kdf_profile, derive_keys,
        srp6a::{HashAlgorithm, PrimeGroup},
        SrpClient, SrpServer,
    };
    use serde_json::{json, Value};
    use std::collections::VecDeque;

    const SECRET_KEY: &str = "A3-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXYZ2";
    const MASTER_PASSWORD: &str = "correct horse battery staple";
    const NORMALIZED_EMAIL: &str = "user-1@example.com";
    const SRP_SALT: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
    const NOW_MS: u64 = 1_700_000_000_000;

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum PersistenceStep {
        DeviceKey,
        PendingCatalog,
        Metadata,
        QuickUnlock,
        Replica,
        PromotedCatalog,
        CurrentSession,
    }

    #[derive(Clone, Copy)]
    enum ReplicaFault {
        BeforeApply,
        ApplyThenError,
        ApplyThenUnreadable,
        ThirdHead,
    }

    struct Pause {
        step: PersistenceStep,
        reached: AtomicBool,
        released: AtomicBool,
        reached_notify: tokio::sync::Notify,
        release_notify: tokio::sync::Notify,
    }

    impl Pause {
        fn new(step: PersistenceStep) -> Arc<Self> {
            Arc::new(Self {
                step,
                reached: AtomicBool::new(false),
                released: AtomicBool::new(false),
                reached_notify: tokio::sync::Notify::new(),
                release_notify: tokio::sync::Notify::new(),
            })
        }

        async fn wait_until_reached(&self) {
            while !self.reached.load(Ordering::SeqCst) {
                self.reached_notify.notified().await;
            }
        }

        fn release(&self) {
            self.released.store(true, Ordering::SeqCst);
            self.release_notify.notify_waiters();
        }
    }

    #[derive(Default)]
    struct InstallationPlatform {
        values: Mutex<HashMap<(String, String), String>>,
        events: Arc<Mutex<Vec<PersistenceStep>>>,
        invocations: AtomicU64,
        fault: Mutex<Option<PersistenceStep>>,
        read_fault: Mutex<Option<RuntimeError>>,
        pause: Mutex<Option<Arc<Pause>>>,
        cancel_on_next_write: Mutex<Option<RequestCancellation>>,
    }

    impl InstallationPlatform {
        fn fail_at(&self, step: PersistenceStep) {
            *self.fault.lock().unwrap() = Some(step);
        }

        fn fail_next_read(&self, error: RuntimeError) {
            *self.read_fault.lock().unwrap() = Some(error);
        }

        fn pause_at(&self, pause: Arc<Pause>) {
            *self.pause.lock().unwrap() = Some(pause);
        }

        fn clear_events(&self) {
            self.events.lock().unwrap().clear();
            self.invocations.store(0, Ordering::SeqCst);
        }

        fn cancel_on_next_write(&self, cancellation: RequestCancellation) {
            *self.cancel_on_next_write.lock().unwrap() = Some(cancellation);
        }

        fn events(&self) -> Vec<PersistenceStep> {
            self.events.lock().unwrap().clone()
        }

        fn invocation_count(&self) -> u64 {
            self.invocations.load(Ordering::SeqCst)
        }

        fn catalog(&self) -> Option<DeviceCatalogDocument> {
            self.values
                .lock()
                .unwrap()
                .get(&(
                    "devicePlain".into(),
                    "bittery:runtime:platform-storage:device-catalog".into(),
                ))
                .map(|value| serde_json::from_str(value).unwrap())
        }

        fn put_document<T: serde::Serialize>(&self, area: &str, key: String, value: &T) {
            self.values
                .lock()
                .unwrap()
                .insert((area.into(), key), serde_json::to_string(value).unwrap());
        }
    }

    fn classify_set(key: &str, serialized: &str) -> PersistenceStep {
        if key.ends_with("device-key") {
            PersistenceStep::DeviceKey
        } else if key.ends_with("device-catalog") {
            let value: Value = serde_json::from_str(serialized).unwrap();
            if value["accounts"].as_array().is_some_and(|accounts| {
                accounts
                    .iter()
                    .any(|account| !account["pendingInstall"].is_null())
            }) {
                PersistenceStep::PendingCatalog
            } else {
                PersistenceStep::PromotedCatalog
            }
        } else if key.ends_with("metadata") {
            PersistenceStep::Metadata
        } else if key.ends_with("quick-unlock") {
            PersistenceStep::QuickUnlock
        } else if key.ends_with("current-session") {
            PersistenceStep::CurrentSession
        } else {
            panic!("unknown installation test key: {key}")
        }
    }

    #[async_trait]
    impl SerializedPlatformStorageExecutor for InstallationPlatform {
        async fn invoke(
            &self,
            request_json: Zeroizing<String>,
        ) -> Result<Zeroizing<String>, RuntimeError> {
            self.invocations.fetch_add(1, Ordering::SeqCst);
            let request: Value = serde_json::from_str(&request_json).unwrap();
            let area = request["area"].as_str().unwrap().to_owned();
            let key = request["key"].as_str().unwrap().to_owned();
            match request["type"].as_str().unwrap() {
                "get" => Ok(Zeroizing::new(
                    if let Some(error) = self.read_fault.lock().unwrap().take() {
                        return Err(error);
                    } else {
                        json!({
                            "type": "value",
                            "value": self.values.lock().unwrap().get(&(area, key)).cloned()
                        })
                        .to_string()
                    },
                )),
                "set" => {
                    let serialized = request["value"].as_str().unwrap().to_owned();
                    let step = classify_set(&key, &serialized);
                    self.events.lock().unwrap().push(step);
                    if let Some(cancellation) = self.cancel_on_next_write.lock().unwrap().take() {
                        cancellation.cancel();
                    }
                    let should_fail = {
                        let mut fault = self.fault.lock().unwrap();
                        if *fault == Some(step) {
                            fault.take();
                            true
                        } else {
                            false
                        }
                    };
                    if should_fail {
                        return Err(startup_invariant("injected platform write failure"));
                    }
                    self.values.lock().unwrap().insert((area, key), serialized);
                    let pause = self.pause.lock().unwrap().clone();
                    if let Some(pause) = pause.filter(|pause| pause.step == step) {
                        pause.reached.store(true, Ordering::SeqCst);
                        pause.reached_notify.notify_waiters();
                        while !pause.released.load(Ordering::SeqCst) {
                            pause.release_notify.notified().await;
                        }
                    }
                    Ok(Zeroizing::new(json!({"type": "done"}).to_string()))
                }
                "delete" => {
                    self.values.lock().unwrap().remove(&(area, key));
                    Ok(Zeroizing::new(json!({"type": "done"}).to_string()))
                }
                _ => unreachable!(),
            }
        }
    }

    struct InstallationReplica {
        state: InMemoryReplica,
        events: Arc<Mutex<Vec<PersistenceStep>>>,
        fault: Mutex<Option<ReplicaFault>>,
        fail_next_load: AtomicBool,
    }

    impl InstallationReplica {
        fn new(events: Arc<Mutex<Vec<PersistenceStep>>>) -> Self {
            Self {
                state: InMemoryReplica::default(),
                events,
                fault: Mutex::new(None),
                fail_next_load: AtomicBool::new(false),
            }
        }

        fn fail_with(&self, fault: ReplicaFault) {
            *self.fault.lock().unwrap() = Some(fault);
        }
    }

    #[async_trait]
    impl SerializedReplicaExecutor for InstallationReplica {
        async fn invoke(&self, request_json: String) -> Result<String, RuntimeError> {
            let mut request: ReplicaPersistenceRequest =
                serde_json::from_str(&request_json).unwrap();
            if matches!(request, ReplicaPersistenceRequest::Load { .. })
                && self.fail_next_load.swap(false, Ordering::SeqCst)
            {
                return Err(startup_invariant("injected Replica reread failure"));
            }
            if let ReplicaPersistenceRequest::Install { prepared } = &mut request {
                self.events.lock().unwrap().push(PersistenceStep::Replica);
                let fault = self.fault.lock().unwrap().take();
                match fault {
                    Some(ReplicaFault::BeforeApply) => {
                        return Err(startup_invariant("injected Replica failure"));
                    }
                    Some(ReplicaFault::ApplyThenError) => {
                        self.state.invoke(request).await?;
                        return Err(startup_invariant("lost Replica apply response"));
                    }
                    Some(ReplicaFault::ApplyThenUnreadable) => {
                        self.state.invoke(request).await?;
                        self.fail_next_load.store(true, Ordering::SeqCst);
                        return Err(startup_invariant("lost Replica apply response"));
                    }
                    Some(ReplicaFault::ThirdHead) => {
                        prepared.next_head.incarnation = Incarnation::from("third-generation");
                    }
                    None => {}
                }
            }
            serde_json::to_string(&self.state.invoke(request).await?)
                .map_err(|_| startup_invariant("test Replica response could not serialize"))
        }
    }

    struct FixedEntropy {
        ids: Mutex<VecDeque<String>>,
    }

    impl FixedEntropy {
        fn new(ids: &[&str]) -> Self {
            Self {
                ids: Mutex::new(ids.iter().map(|value| (*value).to_owned()).collect()),
            }
        }
    }

    impl InstallationEntropy for FixedEntropy {
        fn generate_uuid(&self) -> String {
            self.ids
                .lock()
                .unwrap()
                .pop_front()
                .expect("test UUID script exhausted")
        }

        fn generate_device_key(&self) -> [u8; 32] {
            [0x5A; 32]
        }
    }

    struct UnusedHttp;

    #[derive(Default)]
    struct Sink(Mutex<Vec<RuntimeProjection>>);

    impl ObservationSink for Sink {
        fn publish(&self, projection: RuntimeProjection) {
            self.0.lock().unwrap().push(projection);
        }
    }

    #[async_trait]
    impl SerializedHttpExecutor for UnusedHttp {
        async fn invoke(&self, _request_json: String) -> Result<String, RuntimeError> {
            panic!("installation coordinator tests do not use HTTP")
        }

        fn cancel(&self, _dispatch_id: &str) {}
    }

    #[derive(Clone, Copy)]
    enum RoutingAuthBehavior {
        Success,
        BadProof,
        FollowUpError,
        CancelAfterStart,
        UserMismatch,
    }

    struct RoutingAuthHttp {
        state: Mutex<RoutingAuthState>,
        kdf_profile: bittery_crypto_core::KdfProfile,
        behavior: RoutingAuthBehavior,
        cancellation: Option<RequestCancellation>,
    }

    struct RoutingAuthState {
        requests: Vec<Value>,
        server: SrpServer,
        verifier: String,
        server_ephemeral: bittery_crypto_core::srp6a::Ephemeral,
    }

    impl RoutingAuthHttp {
        fn new(
            kdf_profile: bittery_crypto_core::KdfProfile,
            behavior: RoutingAuthBehavior,
            cancellation: Option<RequestCancellation>,
        ) -> Self {
            let srp = SrpClient::new(HashAlgorithm::Sha256, PrimeGroup::G4096);
            let server = SrpServer::new(HashAlgorithm::Sha256, PrimeGroup::G4096);
            let derived =
                derive_keys(MASTER_PASSWORD, SECRET_KEY, NORMALIZED_EMAIL, &kdf_profile).unwrap();
            let password = Zeroizing::new(String::from_utf8_lossy(&derived.auth_key).into_owned());
            let private_key = Zeroizing::new(
                srp.derive_safe_private_key(SRP_SALT, &password, None)
                    .unwrap(),
            );
            let verifier = srp.derive_verifier(&private_key).unwrap();
            let server_ephemeral = server.generate_ephemeral(&verifier).unwrap();
            Self {
                state: Mutex::new(RoutingAuthState {
                    requests: Vec::new(),
                    server,
                    verifier,
                    server_ephemeral,
                }),
                kdf_profile,
                behavior,
                cancellation,
            }
        }

        fn requests(&self) -> Vec<Value> {
            self.state.lock().unwrap().requests.clone()
        }

        fn clear_requests(&self) {
            self.state.lock().unwrap().requests.clear();
        }
    }

    #[async_trait]
    impl SerializedHttpExecutor for RoutingAuthHttp {
        async fn invoke(&self, request_json: String) -> Result<String, RuntimeError> {
            let request: Value = serde_json::from_str(&request_json).unwrap();
            assert_auth_headers(&request);
            let url = request["url"].as_str().unwrap().to_owned();
            let mut state = self.state.lock().unwrap();
            state.requests.push(request);

            if url.ends_with("/api/v1/auth/login-attempts") {
                let body = routing_request_body(state.requests.last().unwrap());
                assert_eq!(body["email"], NORMALIZED_EMAIL);
                if matches!(self.behavior, RoutingAuthBehavior::CancelAfterStart) {
                    self.cancellation.as_ref().unwrap().cancel();
                }
                return Ok(routing_completed(
                    201,
                    json!({
                        "attemptId": "attempt-1",
                        "kdfParams": {
                            "algorithm": self.kdf_profile.algorithm,
                            "iterations": self.kdf_profile.iterations,
                            "schemaVersion": self.kdf_profile.schema_version
                        },
                        "salt": SRP_SALT,
                        "serverPublicKey": state.server_ephemeral.public
                    }),
                ));
            }

            if url.ends_with("/api/v1/auth/login-attempts/attempt-1/finish") {
                let body = routing_request_body(state.requests.last().unwrap());
                let session = state
                    .server
                    .derive_session(
                        &state.server_ephemeral.secret,
                        body["clientPublicKey"].as_str().unwrap(),
                        SRP_SALT,
                        "",
                        &state.verifier,
                        body["clientProof"].as_str().unwrap(),
                    )
                    .expect("the Runtime must produce the unchanged SRP proof");
                let proof = if matches!(self.behavior, RoutingAuthBehavior::BadProof) {
                    "00".to_owned()
                } else {
                    session.proof.clone()
                };
                return Ok(routing_completed(
                    200,
                    json!({
                        "expiresAt": "2099-01-01T00:00:00Z",
                        "serverProof": proof,
                        "sessionId": "session-1",
                        "token": "fresh-token",
                        "user": {
                            "email": NORMALIZED_EMAIL,
                            "encryptedPrivateKey": "encrypted-private-key",
                            "id": if matches!(self.behavior, RoutingAuthBehavior::UserMismatch) { "user-2" } else { "user-1" },
                            "name": "User One",
                            "publicKey": "public-key",
                            "secretKeyHint": "A3-ABCDEF",
                            "teamAvatarUrl": null,
                            "teamName": "User One"
                        },
                        "vaultKeys": { "hasMore": false, "items": [], "nextCursor": null }
                    }),
                ));
            }

            if url.ends_with("/api/v1/travel-mode") {
                if matches!(self.behavior, RoutingAuthBehavior::FollowUpError) {
                    return Ok(routing_completed(500, json!({"error": "injected"})));
                }
                return Ok(routing_completed(
                    200,
                    json!({
                        "enabled": false,
                        "enabledAt": null,
                        "hiddenVaultIds": [],
                        "updatedAt": "2029-01-02T00:00:00Z"
                    }),
                ));
            }

            Err(startup_invariant("unexpected authentication test request"))
        }

        fn cancel(&self, _dispatch_id: &str) {}
    }

    fn assert_auth_headers(request: &Value) {
        let headers = request["headers"].as_array().unwrap();
        for (name, value) in [
            ("Bittery-Client-Id", "client-routing"),
            ("Bittery-Client-Platform", "desktop"),
            ("Bittery-Client-Version", "0.5.2-test"),
        ] {
            assert!(headers
                .iter()
                .any(|header| header["name"] == name && header["value"] == value));
        }
    }

    fn routing_request_body(request: &Value) -> Value {
        let body: Vec<u8> = serde_json::from_value(request["body"].clone()).unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    fn routing_completed(status: u16, body: Value) -> String {
        json!({
            "type": "completed",
            "status": status,
            "headers": [{"name": "Content-Type", "value": "application/json"}],
            "body": serde_json::to_vec(&body).unwrap()
        })
        .to_string()
    }

    fn vault_key(id: &str) -> AuthVaultKeyResponse {
        AuthVaultKeyResponse {
            encrypted_vault_key: format!("wrapped-{id}"),
            role: VaultRole::Owner,
            vault_icon: None,
            vault_id: id.into(),
            vault_image_url: None,
            vault_name: id.into(),
            vault_type: VaultType::Personal,
        }
    }

    fn verified(user_id: &str) -> VerifiedAuthentication {
        VerifiedAuthentication {
            normalized_server_url: "https://vault.example.com".into(),
            kdf_profile: bittery_crypto_core::current_kdf_profile(),
            master_unlock_key: Zeroizing::new([0xA5; 32]),
            token: Zeroizing::new("session-token".into()),
            session_id: "session-id".into(),
            expires_at: "2030-01-01T00:00:00Z".into(),
            user: LoginUserResponse {
                email: format!("{user_id}@example.com"),
                encrypted_private_key: "encrypted-private-key".into(),
                id: user_id.into(),
                name: "User".into(),
                public_key: "public-key".into(),
                secret_key_hint: "A3-A••••".into(),
                team_avatar_url: None,
                team_name: None,
            },
            vault_keys: vec![vault_key("visible"), vault_key("hidden")],
            travel_mode: TravelModeResponse {
                enabled: true,
                enabled_at: Some("2029-01-01T00:00:00Z".into()),
                hidden_vault_ids: vec!["hidden".into()],
                updated_at: "2029-01-02T00:00:00Z".into(),
            },
        }
    }

    fn evidence() -> AuthenticationInstallationEvidence {
        AuthenticationInstallationEvidence::new(SECRET_KEY.into(), false)
    }

    async fn harness() -> (
        Arc<Runtime>,
        Arc<InstallationReplica>,
        Arc<InstallationPlatform>,
    ) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let replica = Arc::new(InstallationReplica::new(events.clone()));
        let platform = Arc::new(InstallationPlatform {
            events,
            ..InstallationPlatform::default()
        });
        let runtime = Runtime::with_serialized_executors(
            replica.clone(),
            platform.clone(),
            Arc::new(UnusedHttp),
        );
        runtime.open().await.unwrap();
        platform.clear_events();
        (runtime, replica, platform)
    }

    async fn routing_harness(
        http: Arc<RoutingAuthHttp>,
    ) -> (
        Arc<Runtime>,
        Arc<InstallationReplica>,
        Arc<InstallationPlatform>,
    ) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let replica = Arc::new(InstallationReplica::new(events.clone()));
        let platform = Arc::new(InstallationPlatform {
            events,
            ..InstallationPlatform::default()
        });
        let runtime = Runtime::with_configured_serialized_executors(
            replica.clone(),
            platform.clone(),
            http,
            AuthClientConfig::new(
                "client-routing".into(),
                ClientPlatform::Desktop,
                "0.5.2-test".into(),
            )
            .unwrap(),
        );
        runtime.open().await.unwrap();
        platform.clear_events();
        (runtime, replica, platform)
    }

    async fn install(
        runtime: &Runtime,
        user_id: &str,
        entropy: &FixedEntropy,
    ) -> Result<RuntimeResponse, RuntimeError> {
        runtime
            .install_verified_authentication_with(
                verified(user_id),
                evidence(),
                &FixedClock(NOW_MS),
                entropy,
            )
            .await
    }

    fn runtime_status(runtime: &Runtime) -> RuntimeStatusProjection {
        let projected = runtime
            .projection(&ObservationRequest::RuntimeStatus { account_id: None })
            .unwrap();
        let RuntimeProjection::RuntimeStatus(status) = projected.projection else {
            panic!("Runtime-status observation returned another projection");
        };
        status
    }

    fn create_request(account_id: &str) -> RuntimeRequest {
        RuntimeRequest::CreateLoginItem {
            account_id: AccountId::from(account_id),
            vault_id: "visible".into(),
            draft: crate::LoginItemDraft {
                title: "Login".into(),
                url: None,
                urls: Vec::new(),
                username: None,
                password: None,
                notes: None,
                note: None,
                custom_fields: Vec::new(),
                tags: Vec::new(),
            },
        }
    }

    fn sign_in_request(email: &str) -> RuntimeRequest {
        RuntimeRequest::SignIn {
            server_url: "https://vault.example.com".into(),
            email: email.into(),
            master_password: MASTER_PASSWORD.into(),
            secret_key: SECRET_KEY.into(),
            insecure_transport_confirmed: false,
        }
    }

    fn quick_unlock_request(account_id: &str) -> RuntimeRequest {
        RuntimeRequest::QuickUnlock {
            account_id: AccountId::from(account_id),
            master_password: MASTER_PASSWORD.into(),
        }
    }

    fn verified_with_derived_muk() -> VerifiedAuthentication {
        let mut result = verified("user-1");
        result.user.email = NORMALIZED_EMAIL.into();
        result.master_unlock_key = Zeroizing::new(
            derive_keys(
                MASTER_PASSWORD,
                SECRET_KEY,
                NORMALIZED_EMAIL,
                &result.kdf_profile,
            )
            .unwrap()
            .master_unlock_key,
        );
        result
    }

    async fn install_quick_unlock_account(runtime: &Runtime, platform: &InstallationPlatform) {
        runtime
            .install_verified_authentication_with(
                verified_with_derived_muk(),
                evidence(),
                &FixedClock(NOW_MS),
                &FixedEntropy::new(&["account-1", "generation-1"]),
            )
            .await
            .unwrap();
        runtime
            .mark_account_locked(&AccountId::from("account-1"))
            .await
            .unwrap();
        platform.clear_events();
    }

    #[tokio::test]
    async fn sign_in_routes_the_verified_ceremony_into_one_published_unlocked_account() {
        let http = Arc::new(RoutingAuthHttp::new(
            current_kdf_profile(),
            RoutingAuthBehavior::Success,
            None,
        ));
        let (runtime, _replica, platform) = routing_harness(http.clone()).await;
        let status_sink = Arc::new(Sink::default());
        let _status = runtime
            .observe(
                ObservationRequest::RuntimeStatus { account_id: None },
                status_sink.clone(),
            )
            .unwrap();

        let response = runtime
            .request(
                sign_in_request("  ＵＳＥＲ-1＠ＥＸＡＭＰＬＥ．ＣＯＭ  "),
                RequestCancellation::new(),
            )
            .await
            .unwrap();
        let RuntimeResponse::SignedIn {
            account_id,
            user_id,
        } = response
        else {
            panic!("Sign-in returned another response");
        };

        assert_eq!(user_id, "user-1");
        assert_eq!(http.requests().len(), 3);
        assert_eq!(platform.catalog().unwrap().accounts.len(), 1);
        let snapshot = runtime.replica.snapshot(&account_id).unwrap();
        assert!(runtime.has_live_master_unlock_key(&account_id, &snapshot.incarnation));
        assert_eq!(
            runtime.account_access_state(&account_id),
            Some(AccountAccessState::Unlocked)
        );
        let projections = status_sink.0.lock().unwrap();
        assert_eq!(projections.len(), 2);
        let RuntimeProjection::RuntimeStatus(status) = projections.last().unwrap() else {
            panic!("status observer received another projection");
        };
        assert_eq!(status.accounts.len(), 1);
        assert_eq!(status.accounts[0].account_id, account_id);
        assert_eq!(status.accounts[0].access, AccountAccessState::Unlocked);
    }

    #[tokio::test]
    async fn quick_unlock_reauthenticates_and_updates_only_the_existing_generation_session() {
        let http = Arc::new(RoutingAuthHttp::new(
            current_kdf_profile(),
            RoutingAuthBehavior::Success,
            None,
        ));
        let (runtime, _replica, platform) = routing_harness(http.clone()).await;
        install_quick_unlock_account(&runtime, &platform).await;
        {
            let key = (
                "deviceSecret".into(),
                "bittery:runtime:platform-storage:account:9:account-1:incarnation:12:generation-1:quick-unlock".into(),
            );
            let mut values = platform.values.lock().unwrap();
            let mut document: Value = serde_json::from_str(values.get(&key).unwrap()).unwrap();
            document["lastMasterPasswordEntryMs"] = json!(0);
            values.insert(key, document.to_string());
        }
        http.clear_requests();
        let before = runtime
            .replica
            .snapshot(&AccountId::from("account-1"))
            .unwrap();
        let catalog_before = platform.catalog().unwrap();
        let sink = Arc::new(Sink::default());
        let _observation = runtime
            .observe(
                ObservationRequest::RuntimeStatus {
                    account_id: Some(AccountId::from("account-1")),
                },
                sink.clone(),
            )
            .unwrap();

        let response = runtime
            .request(
                quick_unlock_request("account-1"),
                RequestCancellation::new(),
            )
            .await
            .unwrap();

        assert_eq!(
            response,
            RuntimeResponse::SignedIn {
                account_id: AccountId::from("account-1"),
                user_id: "user-1".into(),
            }
        );
        assert_eq!(http.requests().len(), 3);
        assert_eq!(
            platform.events(),
            vec![
                PersistenceStep::Metadata,
                PersistenceStep::QuickUnlock,
                PersistenceStep::CurrentSession,
            ]
        );
        assert_eq!(platform.catalog().unwrap(), catalog_before);
        let after = runtime
            .replica
            .snapshot(&AccountId::from("account-1"))
            .unwrap();
        assert_eq!(after, before);
        assert!(runtime.has_live_master_unlock_key(
            &AccountId::from("account-1"),
            &Incarnation::from("generation-1")
        ));
        assert_eq!(
            runtime.account_access_state(&AccountId::from("account-1")),
            Some(AccountAccessState::Unlocked)
        );
        let quick_unlock = runtime
            .platform_storage
            .load_quick_unlock(
                &AccountId::from("account-1"),
                &Incarnation::from("generation-1"),
            )
            .await
            .unwrap()
            .unwrap();
        assert!(quick_unlock.last_master_password_entry_ms.unwrap() > NOW_MS);
        assert_eq!(sink.0.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn quick_unlock_ordinary_failures_leave_generation_and_quick_material_untouched() {
        for behavior in [
            RoutingAuthBehavior::BadProof,
            RoutingAuthBehavior::FollowUpError,
        ] {
            let http = Arc::new(RoutingAuthHttp::new(current_kdf_profile(), behavior, None));
            let (runtime, _replica, platform) = routing_harness(http).await;
            install_quick_unlock_account(&runtime, &platform).await;
            let before = runtime
                .platform_storage
                .load_quick_unlock(
                    &AccountId::from("account-1"),
                    &Incarnation::from("generation-1"),
                )
                .await
                .unwrap()
                .unwrap();
            platform.clear_events();

            assert!(runtime
                .request(
                    quick_unlock_request("account-1"),
                    RequestCancellation::new(),
                )
                .await
                .is_err());
            assert!(platform.events().is_empty());
            let after = runtime
                .platform_storage
                .load_quick_unlock(
                    &AccountId::from("account-1"),
                    &Incarnation::from("generation-1"),
                )
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                after.last_master_password_entry_ms,
                before.last_master_password_entry_ms
            );
            assert_eq!(
                runtime.account_access_state(&AccountId::from("account-1")),
                Some(AccountAccessState::Locked)
            );
        }
    }

    #[tokio::test]
    async fn missing_quick_unlock_material_and_pending_lock_epoch_fail_before_http() {
        let http = Arc::new(RoutingAuthHttp::new(
            current_kdf_profile(),
            RoutingAuthBehavior::Success,
            None,
        ));
        let (runtime, _replica, platform) = routing_harness(http.clone()).await;
        install_quick_unlock_account(&runtime, &platform).await;
        http.clear_requests();
        runtime
            .platform_storage
            .remove_quick_unlock(
                &AccountId::from("account-1"),
                &Incarnation::from("generation-1"),
            )
            .await
            .unwrap();
        let error = runtime
            .request(
                quick_unlock_request("account-1"),
                RequestCancellation::new(),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::AuthenticationRequired);
        assert!(http.requests().is_empty());

        let http = Arc::new(RoutingAuthHttp::new(
            current_kdf_profile(),
            RoutingAuthBehavior::Success,
            None,
        ));
        let (runtime, _replica, platform) = routing_harness(http.clone()).await;
        install_quick_unlock_account(&runtime, &platform).await;
        http.clear_requests();
        runtime
            .lock_epoch_pending
            .lock()
            .unwrap()
            .insert(AccountId::from("account-1"), 2);
        let error = runtime
            .request(
                quick_unlock_request("account-1"),
                RequestCancellation::new(),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
        assert!(http.requests().is_empty());
    }

    #[tokio::test]
    async fn corrupt_quick_material_requires_full_sign_in_but_executor_errors_are_preserved() {
        let http = Arc::new(RoutingAuthHttp::new(
            current_kdf_profile(),
            RoutingAuthBehavior::Success,
            None,
        ));
        let (runtime, _replica, platform) = routing_harness(http.clone()).await;
        install_quick_unlock_account(&runtime, &platform).await;
        http.clear_requests();
        platform.values.lock().unwrap().insert(
            (
                "deviceSecret".into(),
                "bittery:runtime:platform-storage:account:9:account-1:incarnation:12:generation-1:quick-unlock".into(),
            ),
            "{broken".into(),
        );
        let error = runtime
            .request(
                quick_unlock_request("account-1"),
                RequestCancellation::new(),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::AuthenticationRequired);
        assert!(http.requests().is_empty());

        let http = Arc::new(RoutingAuthHttp::new(
            current_kdf_profile(),
            RoutingAuthBehavior::Success,
            None,
        ));
        let (runtime, _replica, platform) = routing_harness(http.clone()).await;
        install_quick_unlock_account(&runtime, &platform).await;
        http.clear_requests();
        platform.fail_next_read(RuntimeError::new(
            RuntimeErrorCode::AuthenticationUnavailable,
            "host storage is offline",
        ));
        let error = runtime
            .request(
                quick_unlock_request("account-1"),
                RequestCancellation::new(),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::AuthenticationUnavailable);
        assert_eq!(error.message, "host storage is offline");
        assert!(http.requests().is_empty());
    }

    #[tokio::test]
    async fn mismatched_local_muk_or_server_user_never_starts_quick_unlock_writes() {
        let http = Arc::new(RoutingAuthHttp::new(
            current_kdf_profile(),
            RoutingAuthBehavior::Success,
            None,
        ));
        let (runtime, _replica, platform) = routing_harness(http).await;
        install_quick_unlock_account(&runtime, &platform).await;
        let key = (
            "deviceSecret".into(),
            "bittery:runtime:platform-storage:account:9:account-1:incarnation:12:generation-1:quick-unlock".into(),
        );
        {
            let mut values = platform.values.lock().unwrap();
            let mut document: Value = serde_json::from_str(values.get(&key).unwrap()).unwrap();
            document["encryptedMasterUnlockKey"] = serde_json::to_value(
                crate::authentication_installation::wrap_master_unlock_key(
                    &[0x11; 32],
                    &[0x5A; 32],
                )
                .unwrap(),
            )
            .unwrap();
            values.insert(key, document.to_string());
        }
        platform.clear_events();
        let error = runtime
            .request(
                quick_unlock_request("account-1"),
                RequestCancellation::new(),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::AuthenticationRequired);
        assert!(platform.events().is_empty());

        let http = Arc::new(RoutingAuthHttp::new(
            current_kdf_profile(),
            RoutingAuthBehavior::UserMismatch,
            None,
        ));
        let (runtime, _replica, platform) = routing_harness(http).await;
        install_quick_unlock_account(&runtime, &platform).await;
        let error = runtime
            .request(
                quick_unlock_request("account-1"),
                RequestCancellation::new(),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::AuthenticationUnavailable);
        assert!(platform.events().is_empty());
    }

    #[tokio::test]
    async fn cancelled_waiter_and_close_cannot_publish_a_stale_quick_unlock() {
        let http = Arc::new(RoutingAuthHttp::new(
            current_kdf_profile(),
            RoutingAuthBehavior::Success,
            None,
        ));
        let (runtime, _replica, platform) = routing_harness(http.clone()).await;
        install_quick_unlock_account(&runtime, &platform).await;
        http.clear_requests();
        platform.clear_events();
        let lock = runtime
            .account_execution_lock(&AccountId::from("account-1"))
            .unwrap();
        let guard = lock.lock().await;
        let cancellation = RequestCancellation::new();
        let waiting = {
            let runtime = runtime.clone();
            let cancellation = cancellation.clone();
            tokio::spawn(async move {
                runtime
                    .request(quick_unlock_request("account-1"), cancellation)
                    .await
            })
        };
        tokio::task::yield_now().await;
        cancellation.cancel();
        drop(guard);
        assert_eq!(
            waiting.await.unwrap().unwrap_err().code,
            RuntimeErrorCode::Cancelled
        );
        assert_eq!(platform.invocation_count(), 0);
        assert!(http.requests().is_empty());

        let guard = lock.lock().await;
        let waiting = {
            let runtime = runtime.clone();
            tokio::spawn(async move {
                runtime
                    .request(
                        quick_unlock_request("account-1"),
                        RequestCancellation::new(),
                    )
                    .await
            })
        };
        tokio::task::yield_now().await;
        let closing = {
            let runtime = runtime.clone();
            tokio::spawn(async move { runtime.close().await })
        };
        while !runtime.is_closed() {
            tokio::task::yield_now().await;
        }
        drop(guard);
        assert_eq!(
            waiting.await.unwrap().unwrap_err().code,
            RuntimeErrorCode::RuntimeClosed
        );
        closing.await.unwrap();
        assert!(!runtime.has_live_master_unlock_key(
            &AccountId::from("account-1"),
            &Incarnation::from("generation-1")
        ));
    }

    #[tokio::test]
    async fn accepted_quick_unlock_write_failures_fence_without_replacing_the_replica() {
        for failure in [
            PersistenceStep::Metadata,
            PersistenceStep::QuickUnlock,
            PersistenceStep::CurrentSession,
        ] {
            let http = Arc::new(RoutingAuthHttp::new(
                current_kdf_profile(),
                RoutingAuthBehavior::Success,
                None,
            ));
            let (runtime, _replica, platform) = routing_harness(http).await;
            install_quick_unlock_account(&runtime, &platform).await;
            let before = runtime
                .replica
                .snapshot(&AccountId::from("account-1"))
                .unwrap();
            platform.fail_at(failure);

            assert!(runtime
                .request(
                    quick_unlock_request("account-1"),
                    RequestCancellation::new(),
                )
                .await
                .is_err());
            assert_eq!(
                runtime.account_access_state(&AccountId::from("account-1")),
                Some(AccountAccessState::SignedOut)
            );
            assert!(!runtime.has_live_master_unlock_key(
                &AccountId::from("account-1"),
                &Incarnation::from("generation-1")
            ));
            assert_eq!(
                runtime
                    .replica
                    .snapshot(&AccountId::from("account-1"))
                    .unwrap(),
                before
            );
            assert!(runtime
                .platform_storage
                .load_quick_unlock(
                    &AccountId::from("account-1"),
                    &Incarnation::from("generation-1"),
                )
                .await
                .unwrap()
                .is_some());

            runtime
                .request(
                    quick_unlock_request("account-1"),
                    RequestCancellation::new(),
                )
                .await
                .unwrap();
            assert_eq!(
                runtime.account_access_state(&AccountId::from("account-1")),
                Some(AccountAccessState::Unlocked)
            );
        }
    }

    #[tokio::test]
    async fn quick_unlock_cancellation_has_one_final_pre_write_acceptance_boundary() {
        let cancellation = RequestCancellation::new();
        let http = Arc::new(RoutingAuthHttp::new(
            current_kdf_profile(),
            RoutingAuthBehavior::Success,
            None,
        ));
        let (runtime, _replica, platform) = routing_harness(http).await;
        install_quick_unlock_account(&runtime, &platform).await;
        let error = runtime
            .request_with_hooks(
                quick_unlock_request("account-1"),
                cancellation.clone(),
                || cancellation.cancel(),
                || panic!("pre-acceptance cancellation must not be accepted"),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::Cancelled);
        assert!(platform.events().is_empty());

        let cancellation = RequestCancellation::new();
        let response = runtime
            .request_with_acceptance_hook(
                quick_unlock_request("account-1"),
                cancellation.clone(),
                || cancellation.cancel(),
            )
            .await
            .unwrap();
        assert!(matches!(response, RuntimeResponse::SignedIn { .. }));
        assert_eq!(
            platform.events(),
            vec![
                PersistenceStep::Metadata,
                PersistenceStep::QuickUnlock,
                PersistenceStep::CurrentSession,
            ]
        );
    }

    #[tokio::test]
    async fn confirmed_remote_http_is_used_and_persisted_as_account_local_evidence() {
        let http = Arc::new(RoutingAuthHttp::new(
            current_kdf_profile(),
            RoutingAuthBehavior::Success,
            None,
        ));
        let (runtime, _replica, _platform) = routing_harness(http.clone()).await;
        let mut request = sign_in_request(NORMALIZED_EMAIL);
        let RuntimeRequest::SignIn {
            server_url,
            insecure_transport_confirmed,
            ..
        } = &mut request
        else {
            unreachable!()
        };
        *server_url = "http://vault.example.com".into();
        *insecure_transport_confirmed = true;

        let RuntimeResponse::SignedIn { account_id, .. } = runtime
            .request(request, RequestCancellation::new())
            .await
            .unwrap()
        else {
            panic!("Sign-in returned another response");
        };
        assert!(http.requests().iter().all(|request| request["url"]
            .as_str()
            .unwrap()
            .starts_with("http://vault.example.com/")));
        let incarnation = runtime.replica.snapshot(&account_id).unwrap().incarnation;
        let metadata = runtime
            .platform_storage
            .load_account_metadata(&account_id, &incarnation)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(metadata.normalized_server_url, "http://vault.example.com");
        assert!(metadata.insecure_transport_confirmed);
    }

    #[tokio::test]
    async fn unavailable_invalid_and_pre_cancelled_sign_in_contact_no_host() {
        let (runtime, _replica, platform) = harness().await;
        let error = runtime
            .request(
                sign_in_request(NORMALIZED_EMAIL),
                RequestCancellation::new(),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::AuthenticationUnavailable);
        assert_eq!(platform.invocation_count(), 0);

        assert_eq!(
            AuthClientConfig::new("bad\rclient".into(), ClientPlatform::Web, "0.5.2".into(),)
                .unwrap_err()
                .code,
            RuntimeErrorCode::AuthenticationUnavailable
        );

        for (request, cancellation) in [
            {
                let mut request = sign_in_request(NORMALIZED_EMAIL);
                let RuntimeRequest::SignIn { secret_key, .. } = &mut request else {
                    unreachable!()
                };
                *secret_key = "invalid-secret-key".into();
                (request, RequestCancellation::new())
            },
            {
                let cancellation = RequestCancellation::new();
                cancellation.cancel();
                (sign_in_request(NORMALIZED_EMAIL), cancellation)
            },
            {
                let mut request = sign_in_request(NORMALIZED_EMAIL);
                let RuntimeRequest::SignIn {
                    server_url,
                    insecure_transport_confirmed,
                    ..
                } = &mut request
                else {
                    unreachable!()
                };
                *server_url = "http://vault.example.com".into();
                *insecure_transport_confirmed = false;
                (request, RequestCancellation::new())
            },
        ] {
            let http = Arc::new(RoutingAuthHttp::new(
                current_kdf_profile(),
                RoutingAuthBehavior::Success,
                None,
            ));
            let (runtime, _replica, platform) = routing_harness(http.clone()).await;
            assert!(runtime.request(request, cancellation).await.is_err());
            assert!(http.requests().is_empty());
            assert_eq!(platform.invocation_count(), 0);
            assert!(runtime.replica.snapshots().is_empty());
        }
    }

    #[tokio::test]
    async fn cancellation_and_remote_authentication_failures_never_start_installation() {
        for behavior in [
            RoutingAuthBehavior::CancelAfterStart,
            RoutingAuthBehavior::BadProof,
            RoutingAuthBehavior::FollowUpError,
        ] {
            let cancellation = RequestCancellation::new();
            let http = Arc::new(RoutingAuthHttp::new(
                current_kdf_profile(),
                behavior,
                Some(cancellation.clone()),
            ));
            let (runtime, _replica, platform) = routing_harness(http.clone()).await;
            assert!(runtime
                .request(sign_in_request(NORMALIZED_EMAIL), cancellation)
                .await
                .is_err());
            assert!(http.requests().len() <= 3);
            assert!(platform.events().is_empty());
            assert!(platform.catalog().is_none());
            assert!(runtime.replica.snapshots().is_empty());
            assert!(runtime_status(&runtime).accounts.is_empty());
        }
    }

    #[tokio::test]
    async fn final_cancellation_check_precedes_acceptance_and_later_cancellation_is_fenced() {
        let cancellation = RequestCancellation::new();
        let http = Arc::new(RoutingAuthHttp::new(
            current_kdf_profile(),
            RoutingAuthBehavior::Success,
            None,
        ));
        let (runtime, _replica, platform) = routing_harness(http).await;
        let error = runtime
            .request_with_hooks(
                sign_in_request(NORMALIZED_EMAIL),
                cancellation.clone(),
                || cancellation.cancel(),
                || panic!("cancelled authentication must not be accepted"),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::Cancelled);
        assert!(platform.events().is_empty());
        assert!(runtime.replica.snapshots().is_empty());

        for cancel_from_first_write in [false, true] {
            let cancellation = RequestCancellation::new();
            let http = Arc::new(RoutingAuthHttp::new(
                current_kdf_profile(),
                RoutingAuthBehavior::Success,
                None,
            ));
            let (runtime, _replica, platform) = routing_harness(http).await;
            if cancel_from_first_write {
                platform.cancel_on_next_write(cancellation.clone());
            }
            let response = if cancel_from_first_write {
                runtime
                    .request(sign_in_request(NORMALIZED_EMAIL), cancellation)
                    .await
            } else {
                runtime
                    .request_with_acceptance_hook(
                        sign_in_request(NORMALIZED_EMAIL),
                        cancellation.clone(),
                        || cancellation.cancel(),
                    )
                    .await
            }
            .unwrap();
            let RuntimeResponse::SignedIn { account_id, .. } = response else {
                panic!("accepted Sign-in returned another response");
            };
            let snapshot = runtime.replica.snapshot(&account_id).unwrap();
            assert!(runtime.has_live_master_unlock_key(&account_id, &snapshot.incarnation));
            assert_eq!(
                runtime.account_access_state(&account_id),
                Some(AccountAccessState::Unlocked)
            );
            assert!(platform.catalog().unwrap().accounts[0]
                .pending_install
                .is_none());
        }
    }

    #[tokio::test]
    async fn route_uses_only_matching_kdf_pin_and_existing_installation_fence() {
        let stronger = bittery_crypto_core::KdfProfile {
            iterations: current_kdf_profile().iterations + 1,
            ..current_kdf_profile()
        };
        let http = Arc::new(RoutingAuthHttp::new(
            current_kdf_profile(),
            RoutingAuthBehavior::Success,
            None,
        ));
        let (runtime, _replica, platform) = routing_harness(http.clone()).await;
        let mut existing = verified("user-1");
        existing.kdf_profile = stronger.clone();
        runtime
            .install_verified_authentication_with(
                existing,
                evidence(),
                &FixedClock(NOW_MS),
                &FixedEntropy::new(&["account-1", "generation-1"]),
            )
            .await
            .unwrap();
        platform.clear_events();
        let error = runtime
            .request(
                sign_in_request(NORMALIZED_EMAIL),
                RequestCancellation::new(),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::AuthenticationUnavailable);
        assert_eq!(http.requests().len(), 1);
        assert!(platform.events().is_empty());

        let http = Arc::new(RoutingAuthHttp::new(
            current_kdf_profile(),
            RoutingAuthBehavior::Success,
            None,
        ));
        let (runtime, _replica, platform) = routing_harness(http).await;
        let mut unrelated = verified("user-2");
        unrelated.kdf_profile = stronger;
        runtime
            .install_verified_authentication_with(
                unrelated,
                evidence(),
                &FixedClock(NOW_MS),
                &FixedEntropy::new(&["account-2", "generation-2"]),
            )
            .await
            .unwrap();
        platform.clear_events();
        platform.fail_at(PersistenceStep::CurrentSession);
        let error = runtime
            .request(
                sign_in_request(NORMALIZED_EMAIL),
                RequestCancellation::new(),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
        let status = runtime_status(&runtime);
        assert_eq!(status.accounts.len(), 2);
        assert!(status.accounts.iter().any(|account| {
            account.account_id != AccountId::from("account-2")
                && account.access == AccountAccessState::SignedOut
        }));
    }

    #[tokio::test]
    async fn first_install_obeys_the_exact_durable_order_before_publication() {
        let (runtime, _replica, platform) = harness().await;
        let response = install(
            &runtime,
            "user-1",
            &FixedEntropy::new(&["account-1", "generation-1"]),
        )
        .await
        .unwrap();

        assert_eq!(
            platform.events(),
            vec![
                PersistenceStep::DeviceKey,
                PersistenceStep::PendingCatalog,
                PersistenceStep::Metadata,
                PersistenceStep::QuickUnlock,
                PersistenceStep::Replica,
                PersistenceStep::PromotedCatalog,
                PersistenceStep::CurrentSession,
            ]
        );
        assert_eq!(
            response,
            RuntimeResponse::SignedIn {
                account_id: AccountId::from("account-1"),
                user_id: "user-1".into(),
            }
        );
        assert_eq!(
            runtime.account_access_state(&AccountId::from("account-1")),
            Some(AccountAccessState::Unlocked)
        );
        assert!(runtime.has_live_master_unlock_key(
            &AccountId::from("account-1"),
            &Incarnation::from("generation-1")
        ));
        let session = runtime
            .platform_storage
            .load_current_session(
                &AccountId::from("account-1"),
                &Incarnation::from("generation-1"),
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(session.vault_keys.len(), 1);
        assert_eq!(session.vault_keys[0].vault_id, "visible");
    }

    #[tokio::test]
    async fn replacement_keeps_the_account_id_and_duplicate_identity_rejects_before_writes() {
        let (runtime, replica, platform) = harness().await;
        install(
            &runtime,
            "user-1",
            &FixedEntropy::new(&["account-1", "generation-1"]),
        )
        .await
        .unwrap();
        platform.clear_events();
        let response = install(&runtime, "user-1", &FixedEntropy::new(&["generation-2"]))
            .await
            .unwrap();
        assert_eq!(
            response,
            RuntimeResponse::SignedIn {
                account_id: AccountId::from("account-1"),
                user_id: "user-1".into(),
            }
        );
        assert!(!runtime.has_live_master_unlock_key(
            &AccountId::from("account-1"),
            &Incarnation::from("generation-1")
        ));
        assert!(runtime.has_live_master_unlock_key(
            &AccountId::from("account-1"),
            &Incarnation::from("generation-2")
        ));

        replica
            .state
            .install(
                AccountId::from("duplicate"),
                "user-1".into(),
                Incarnation::from("duplicate-generation"),
            )
            .unwrap();
        let mut duplicate_metadata = runtime
            .platform_storage
            .load_account_metadata(
                &AccountId::from("account-1"),
                &Incarnation::from("generation-2"),
            )
            .await
            .unwrap()
            .unwrap();
        duplicate_metadata.account_id = AccountId::from("duplicate");
        duplicate_metadata.incarnation = Incarnation::from("duplicate-generation");
        platform.put_document(
            "devicePlain",
            generation_storage_key("duplicate", "duplicate-generation", "metadata"),
            &duplicate_metadata,
        );
        let mut catalog = platform.catalog().unwrap();
        catalog.accounts.push(DeviceCatalogAccount {
            account_id: AccountId::from("duplicate"),
            active_incarnation: Some(Incarnation::from("duplicate-generation")),
            pending_install: None,
        });
        platform.put_document(
            "devicePlain",
            "bittery:runtime:platform-storage:device-catalog".into(),
            &DeviceCatalogDocument::new(catalog.accounts).unwrap(),
        );
        platform.clear_events();

        let error = install(&runtime, "user-1", &FixedEntropy::new(&["unused"]))
            .await
            .unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
        assert!(platform.events().is_empty());
    }

    #[tokio::test]
    async fn persistence_failures_rollback_before_replica_and_fence_after_replica() {
        for step in [
            PersistenceStep::DeviceKey,
            PersistenceStep::PendingCatalog,
            PersistenceStep::Metadata,
            PersistenceStep::QuickUnlock,
        ] {
            let (runtime, _replica, platform) = harness().await;
            platform.fail_at(step);
            assert!(install(
                &runtime,
                "user-1",
                &FixedEntropy::new(&["account-1", "generation-1"]),
            )
            .await
            .is_err());
            assert!(runtime.replica.snapshots().is_empty());
            assert!(runtime
                .account_access_state(&AccountId::from("account-1"))
                .is_none());
            assert!(!runtime.has_live_master_unlock_key(
                &AccountId::from("account-1"),
                &Incarnation::from("generation-1")
            ));
        }

        for fault in [
            ReplicaFault::BeforeApply,
            ReplicaFault::ApplyThenError,
            ReplicaFault::ApplyThenUnreadable,
            ReplicaFault::ThirdHead,
        ] {
            let (runtime, replica, _platform) = harness().await;
            replica.fail_with(fault);
            assert!(install(
                &runtime,
                "user-1",
                &FixedEntropy::new(&["account-1", "generation-1"]),
            )
            .await
            .is_err());
            assert!(!runtime.has_live_master_unlock_key(
                &AccountId::from("account-1"),
                &Incarnation::from("generation-1")
            ));
            if matches!(fault, ReplicaFault::BeforeApply) {
                assert!(runtime.replica.snapshots().is_empty());
            } else {
                assert_ne!(
                    runtime.account_access_state(&AccountId::from("account-1")),
                    Some(AccountAccessState::Unlocked)
                );
            }
        }

        for step in [
            PersistenceStep::PromotedCatalog,
            PersistenceStep::CurrentSession,
        ] {
            let (runtime, _replica, platform) = harness().await;
            platform.fail_at(step);
            assert!(install(
                &runtime,
                "user-1",
                &FixedEntropy::new(&["account-1", "generation-1"]),
            )
            .await
            .is_err());
            assert_eq!(
                runtime.account_access_state(&AccountId::from("account-1")),
                Some(AccountAccessState::SignedOut)
            );
            assert!(!runtime.has_live_master_unlock_key(
                &AccountId::from("account-1"),
                &Incarnation::from("generation-1")
            ));
        }
    }

    #[tokio::test]
    async fn unreadable_replica_outcomes_remain_visible_signed_out_without_a_usable_account() {
        let (runtime, replica, platform) = harness().await;
        replica.fail_with(ReplicaFault::ApplyThenUnreadable);
        let error = install(
            &runtime,
            "user-1",
            &FixedEntropy::new(&["account-1", "generation-1"]),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
        assert_eq!(
            runtime_status(&runtime).accounts,
            vec![AccountStatus {
                account_id: AccountId::from("account-1"),
                replica_revision: 0,
                access: AccountAccessState::SignedOut,
                failure: None,
            }]
        );
        assert!(runtime
            .replica
            .snapshot(&AccountId::from("account-1"))
            .is_none());
        assert!(runtime
            .observe(
                ObservationRequest::Items {
                    account_id: AccountId::from("account-1"),
                },
                Arc::new(Sink::default()),
            )
            .is_err());
        assert_eq!(
            runtime
                .request(create_request("account-1"), RequestCancellation::new())
                .await
                .unwrap_err()
                .code,
            RuntimeErrorCode::AccountMissing
        );
        assert!(platform.catalog().unwrap().accounts[0]
            .pending_install
            .is_some());

        let (runtime, replica, platform) = harness().await;
        install(
            &runtime,
            "user-1",
            &FixedEntropy::new(&["account-1", "generation-1"]),
        )
        .await
        .unwrap();
        let items = Arc::new(Sink::default());
        let _items_handle = runtime
            .observe(
                ObservationRequest::Items {
                    account_id: AccountId::from("account-1"),
                },
                items.clone(),
            )
            .unwrap();
        let delivered_before = items.0.lock().unwrap().len();
        let _ = take_zeroized_live_master_unlock_key_drops();
        replica.fail_with(ReplicaFault::ApplyThenUnreadable);
        assert!(
            install(&runtime, "user-1", &FixedEntropy::new(&["generation-2"]),)
                .await
                .is_err()
        );

        let status = runtime_status(&runtime);
        assert_eq!(status.accounts.len(), 1);
        assert_eq!(status.accounts[0].account_id, AccountId::from("account-1"));
        assert_eq!(status.accounts[0].access, AccountAccessState::SignedOut);
        assert_eq!(items.0.lock().unwrap().len(), delivered_before);
        assert!(!runtime.has_live_master_unlock_key(
            &AccountId::from("account-1"),
            &Incarnation::from("generation-1")
        ));
        assert_eq!(take_zeroized_live_master_unlock_key_drops(), 1);
        assert_eq!(
            runtime
                .request(create_request("account-1"), RequestCancellation::new())
                .await
                .unwrap_err()
                .code,
            RuntimeErrorCode::AccountMissing
        );
        let catalog = platform.catalog().unwrap();
        assert_eq!(catalog.accounts.len(), 1);
        assert_eq!(catalog.accounts[0].account_id, AccountId::from("account-1"));
        assert_eq!(
            catalog.accounts[0].active_incarnation,
            Some(Incarnation::from("generation-1"))
        );
        assert_eq!(
            catalog.accounts[0]
                .pending_install
                .as_ref()
                .map(|pending| pending.incarnation.clone()),
            Some(Incarnation::from("generation-2"))
        );
    }

    #[tokio::test]
    async fn concurrent_same_identity_installations_serialize_to_one_stable_account() {
        let (runtime, _replica, platform) = harness().await;
        let status_sink = Arc::new(Sink::default());
        let _status_handle = runtime
            .observe(
                ObservationRequest::RuntimeStatus { account_id: None },
                status_sink.clone(),
            )
            .unwrap();
        let pause = Pause::new(PersistenceStep::CurrentSession);
        platform.pause_at(pause.clone());
        let first = {
            let runtime = runtime.clone();
            tokio::spawn(async move {
                install(
                    &runtime,
                    "user-1",
                    &FixedEntropy::new(&["account-1", "generation-1"]),
                )
                .await
            })
        };
        pause.wait_until_reached().await;
        assert!(runtime_status(&runtime).accounts.is_empty());
        let events_before_second = platform.events();
        let second_started = Arc::new(tokio::sync::Notify::new());
        let second = {
            let runtime = runtime.clone();
            let second_started = second_started.clone();
            tokio::spawn(async move {
                second_started.notify_one();
                install(&runtime, "user-1", &FixedEntropy::new(&["generation-2"])).await
            })
        };
        second_started.notified().await;
        tokio::task::yield_now().await;
        assert_eq!(platform.events(), events_before_second);
        assert!(runtime_status(&runtime).accounts.is_empty());
        let _ = take_zeroized_live_master_unlock_key_drops();
        pause.release();

        let first_response = first.await.unwrap().unwrap();
        let second_response = second.await.unwrap().unwrap();
        for response in [first_response, second_response] {
            assert_eq!(
                response,
                RuntimeResponse::SignedIn {
                    account_id: AccountId::from("account-1"),
                    user_id: "user-1".into(),
                }
            );
        }
        let catalog = platform.catalog().unwrap();
        assert_eq!(catalog.accounts.len(), 1);
        assert_eq!(
            catalog.accounts[0].active_incarnation,
            Some(Incarnation::from("generation-2"))
        );
        assert!(catalog.accounts[0].pending_install.is_none());
        assert_eq!(
            runtime
                .replica
                .snapshot(&AccountId::from("account-1"))
                .unwrap()
                .incarnation,
            Incarnation::from("generation-2")
        );
        assert!(!runtime.has_live_master_unlock_key(
            &AccountId::from("account-1"),
            &Incarnation::from("generation-1")
        ));
        assert!(runtime.has_live_master_unlock_key(
            &AccountId::from("account-1"),
            &Incarnation::from("generation-2")
        ));
        assert!(take_zeroized_live_master_unlock_key_drops() >= 1);
        for projection in status_sink.0.lock().unwrap().iter() {
            let RuntimeProjection::RuntimeStatus(status) = projection else {
                panic!("status sink received another projection");
            };
            assert!(status.accounts.len() <= 1);
            assert!(status
                .accounts
                .iter()
                .all(|status| status.account_id == AccountId::from("account-1")));
        }
    }

    #[tokio::test]
    async fn lock_close_and_close_racing_final_publication_retire_live_keys_without_callbacks() {
        let (runtime, _replica, platform) = harness().await;
        install(
            &runtime,
            "user-1",
            &FixedEntropy::new(&["account-1", "generation-1"]),
        )
        .await
        .unwrap();
        let _ = take_zeroized_live_master_unlock_key_drops();
        runtime
            .mark_account_locked(&AccountId::from("account-1"))
            .await
            .unwrap();
        assert_eq!(take_zeroized_live_master_unlock_key_drops(), 1);
        assert!(!runtime.has_live_master_unlock_key(
            &AccountId::from("account-1"),
            &Incarnation::from("generation-1")
        ));
        install(&runtime, "user-1", &FixedEntropy::new(&["generation-2"]))
            .await
            .unwrap();
        let _ = take_zeroized_live_master_unlock_key_drops();

        let sink = Arc::new(Sink::default());
        let _handle = runtime
            .observe(
                ObservationRequest::RuntimeStatus { account_id: None },
                sink.clone(),
            )
            .unwrap();
        let before_close = sink.0.lock().unwrap().len();
        let pause = Pause::new(PersistenceStep::CurrentSession);
        platform.pause_at(pause.clone());
        let installing = {
            let runtime = runtime.clone();
            tokio::spawn(async move {
                install(&runtime, "user-1", &FixedEntropy::new(&["generation-3"])).await
            })
        };
        pause.wait_until_reached().await;
        let closing = {
            let runtime = runtime.clone();
            tokio::spawn(async move { runtime.close().await })
        };
        while !runtime.is_closed() {
            tokio::task::yield_now().await;
        }
        pause.release();

        let error = installing.await.unwrap().unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::RuntimeClosed);
        closing.await.unwrap();
        assert_eq!(sink.0.lock().unwrap().len(), before_close);
        assert!(runtime.live_master_unlock_keys.lock().unwrap().is_empty());
        assert!(take_zeroized_live_master_unlock_key_drops() >= 1);
    }

    fn generation_storage_key(account: &str, incarnation: &str, document: &str) -> String {
        format!(
            "bittery:runtime:platform-storage:account:{}:{account}:incarnation:{}:{incarnation}:{document}",
            account.len(),
            incarnation.len()
        )
    }
}
