#[cfg(test)]
use crate::replica::PlanResult;
use crate::{
    platform_storage::{
        DeviceCatalogAccount, DeviceCatalogDocument, PlatformStorage,
        SerializedPlatformStorageExecutor,
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
    account_access: Mutex<HashMap<AccountId, AccountAccessState>>,
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
            true,
            #[cfg(test)]
            Some(in_memory),
        )
    }

    #[doc(hidden)]
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
    ) -> Arc<Self> {
        let persistence: Arc<dyn ReplicaPersistence> =
            Arc::new(SerializedReplicaPersistence::new(replica));
        Self::with_persistence(
            persistence,
            Arc::new(PlatformStorage::new(platform)),
            false,
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
    fn with_persistence(
        persistence: Arc<dyn ReplicaPersistence>,
        platform_storage: Arc<PlatformStorage>,
        ready: bool,
        #[cfg(test)] test_persistence: Option<Arc<InMemoryReplica>>,
    ) -> Arc<Self> {
        Arc::new(Self {
            replica: Arc::new(Replica::new(persistence)),
            platform_storage,
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
            account_access: Mutex::new(HashMap::new()),
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
        self.unlocked_items
            .lock()
            .expect("unlocked projection lock poisoned")
            .remove(&account_id);
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
        self.request_with_acceptance_hook(request, cancellation, || {})
            .await
    }

    pub(crate) async fn request_with_acceptance_hook(
        &self,
        request: RuntimeRequest,
        cancellation: RequestCancellation,
        accepted: impl FnOnce(),
    ) -> Result<RuntimeResponse, RuntimeError> {
        self.ensure_open()?;
        if cancellation.is_cancelled() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::Cancelled,
                "caller cancelled before durable acceptance",
            ));
        }

        match request {
            RuntimeRequest::SignIn { .. } => Err(RuntimeError::new(
                RuntimeErrorCode::AuthenticationUnavailable,
                "authentication is implemented by a later vertical slice",
            )),
            RuntimeRequest::CreateLoginItem {
                account_id,
                vault_id,
                draft,
            } => {
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
                        self.unlocked_items
                            .lock()
                            .expect("unlocked projection lock poisoned")
                            .remove(&account_id);
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
                let snapshots = match account_id {
                    Some(account_id) => {
                        vec![self.replica.snapshot(account_id).ok_or_else(|| {
                            RuntimeError::new(
                                RuntimeErrorCode::AccountMissing,
                                "account is not installed",
                            )
                        })?]
                    }
                    None => self.replica.snapshots(),
                };
                let revision = self.device_revision.load(Ordering::SeqCst);
                Ok(ProjectedDelivery {
                    projection: RuntimeProjection::RuntimeStatus(RuntimeStatusProjection {
                        account_id: account_id.clone(),
                        revision,
                        accounts: snapshots
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
                            .collect(),
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

fn startup_invariant(message: impl Into<String>) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::InvariantViolation, message)
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
        async fn invoke(&self, request_json: String) -> Result<String, RuntimeError> {
            let request: Value = serde_json::from_str(&request_json).unwrap();
            let area = request["area"].as_str().unwrap().to_owned();
            let key = request["key"].as_str().unwrap().to_owned();
            match request["type"].as_str().unwrap() {
                "get" => Ok(json!({
                    "type": "value",
                    "value": self.values.lock().unwrap().get(&(area, key)).cloned()
                })
                .to_string()),
                "set" => {
                    if self.fail_next_set.swap(false, Ordering::SeqCst) {
                        return Err(startup_invariant("injected catalog write failure"));
                    }
                    self.values
                        .lock()
                        .unwrap()
                        .insert((area, key), request["value"].as_str().unwrap().to_owned());
                    Ok(json!({"type": "done"}).to_string())
                }
                "delete" => {
                    self.values.lock().unwrap().remove(&(area, key.clone()));
                    self.deletes.lock().unwrap().push(key);
                    Ok(json!({"type": "done"}).to_string())
                }
                _ => unreachable!(),
            }
        }
    }

    #[async_trait]
    impl SerializedPlatformStorageExecutor for PausingPlatformExecutor {
        async fn invoke(&self, request_json: String) -> Result<String, RuntimeError> {
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
        Runtime::with_serialized_executors(replica, platform)
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
