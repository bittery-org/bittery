#[cfg(test)]
use crate::replica::PlanResult;
use crate::{
    replica::{
        GuardedCommitPlan, InMemoryReplica, OperationRecord, PlanMutation, RecomputedPlanResult,
        Replica, ReplicaItemRecord, ReplicaPersistence, SerializedReplicaExecutor,
        SerializedReplicaPersistence,
    },
    AccountId, AccountStatus, ItemProjectionStatus, ItemsProjection, LoginItemProjection,
    ObservationRequest, ObservationSink, RequestCancellation, RuntimeError, RuntimeErrorCode,
    RuntimeProjection, RuntimeRequest, RuntimeResponse, RuntimeStatusProjection,
};
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Condvar, Mutex, Weak,
    },
    thread::ThreadId,
};

struct Subscription {
    request: ObservationRequest,
    sink: Arc<dyn ObservationSink>,
    delivery: Mutex<DeliveryState>,
    delivery_finished: Condvar,
}

#[derive(Default)]
struct DeliveryState {
    closed: bool,
    delivering_thread: Option<ThreadId>,
    last_queued_revision: Option<u64>,
    queue: VecDeque<RuntimeProjection>,
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
    fn new(request: ObservationRequest, sink: Arc<dyn ObservationSink>) -> Self {
        Self {
            request,
            sink,
            delivery: Mutex::new(DeliveryState::default()),
            delivery_finished: Condvar::new(),
        }
    }

    fn publish(&self, projection: RuntimeProjection) {
        let revision = projection.revision();
        let current_thread = std::thread::current().id();
        {
            let mut delivery = self
                .delivery
                .lock()
                .expect("observation delivery lock poisoned");
            if delivery.closed
                || delivery
                    .last_queued_revision
                    .is_some_and(|last| revision <= last)
            {
                return;
            }
            delivery.last_queued_revision = Some(revision);
            delivery.queue.push_back(projection);
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
            self.sink.publish(next);
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
    #[cfg(test)]
    test_persistence: Option<Arc<InMemoryReplica>>,
    observers: Mutex<HashMap<u64, Arc<Subscription>>>,
    next_observer_id: AtomicU64,
    device_revision: AtomicU64,
    closed: AtomicBool,
    unlocked_items: Mutex<HashMap<AccountId, Vec<LoginItemProjection>>>,
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
            #[cfg(test)]
            None,
        )
    }

    fn with_persistence(
        persistence: Arc<dyn ReplicaPersistence>,
        #[cfg(test)] test_persistence: Option<Arc<InMemoryReplica>>,
    ) -> Arc<Self> {
        Arc::new(Self {
            replica: Arc::new(Replica::new(persistence)),
            #[cfg(test)]
            test_persistence,
            observers: Mutex::new(HashMap::new()),
            next_observer_id: AtomicU64::new(1),
            device_revision: AtomicU64::new(0),
            closed: AtomicBool::new(false),
            unlocked_items: Mutex::new(HashMap::new()),
            account_execution_locks: Mutex::new(HashMap::new()),
        })
    }

    #[cfg(test)]
    pub(crate) fn replica(&self) -> Arc<Replica> {
        Arc::clone(&self.replica)
    }

    #[cfg(test)]
    pub(crate) fn install_account(
        &self,
        account_id: AccountId,
        user_id: String,
        incarnation: crate::protocol::Incarnation,
    ) -> Result<(), RuntimeError> {
        self.ensure_open()?;
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
            .entry(account_id)
            .or_default();
        self.device_revision.fetch_add(1, Ordering::SeqCst);
        self.publish_all();
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
                let execution_lock = self.account_execution_lock(&account_id);
                let execution_guard = execution_lock.lock().await;
                let snapshot = self.replica.snapshot(&account_id).ok_or_else(|| {
                    RuntimeError::new(RuntimeErrorCode::AccountMissing, "account is not installed")
                })?;
                if snapshot.failure.is_some() {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::AccountFailed,
                        "the selected Account module has failed",
                    ));
                }
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
                let replica_revision = match result {
                    RecomputedPlanResult::Applied { replica_revision } => replica_revision,
                    RecomputedPlanResult::Missing => {
                        self.unlocked_items
                            .lock()
                            .expect("unlocked projection lock poisoned")
                            .remove(&account_id);
                        self.device_revision.fetch_add(1, Ordering::SeqCst);
                        drop(execution_guard);
                        self.publish_all();
                        return Err(RuntimeError::new(
                            RuntimeErrorCode::AccountMissing,
                            "account was removed during durable acceptance",
                        ));
                    }
                };
                self.unlocked_items
                    .lock()
                    .expect("unlocked projection lock poisoned")
                    .entry(account_id)
                    .or_default()
                    .push(projection);
                self.device_revision.fetch_add(1, Ordering::SeqCst);
                drop(execution_guard);
                self.publish_all();
                accepted();
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
        self.ensure_open()?;
        let id = self.next_observer_id.fetch_add(1, Ordering::SeqCst);
        let subscription = Arc::new(Subscription::new(request, sink));
        self.observers
            .lock()
            .expect("observer lock poisoned")
            .insert(id, Arc::clone(&subscription));
        let initial = match self.projection(&subscription.request) {
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
        if !self.closed.swap(true, Ordering::SeqCst) {
            let subscriptions: Vec<_> = self
                .observers
                .lock()
                .expect("observer lock poisoned")
                .drain()
                .map(|(_, subscription)| subscription)
                .collect();
            for subscription in subscriptions {
                subscription.close();
            }
        }
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    fn account_execution_lock(&self, account_id: &AccountId) -> Arc<tokio::sync::Mutex<()>> {
        self.account_execution_locks
            .lock()
            .expect("Account execution lock map poisoned")
            .entry(account_id.clone())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    fn projection(&self, request: &ObservationRequest) -> Result<RuntimeProjection, RuntimeError> {
        match request {
            ObservationRequest::Items { account_id } => {
                let snapshot = self.replica.snapshot(account_id).ok_or_else(|| {
                    RuntimeError::new(RuntimeErrorCode::AccountMissing, "account is not installed")
                })?;
                Ok(RuntimeProjection::Items(ItemsProjection {
                    account_id: account_id.clone(),
                    replica_revision: snapshot.revision,
                    items: self
                        .unlocked_items
                        .lock()
                        .expect("unlocked projection lock poisoned")
                        .get(account_id)
                        .cloned()
                        .unwrap_or_default(),
                }))
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
                let revision = account_id
                    .as_ref()
                    .and_then(|id| self.replica.snapshot(id).map(|value| value.revision))
                    .unwrap_or_else(|| self.device_revision.load(Ordering::SeqCst));
                Ok(RuntimeProjection::RuntimeStatus(RuntimeStatusProjection {
                    account_id: account_id.clone(),
                    revision,
                    accounts: snapshots
                        .into_iter()
                        .map(|value| AccountStatus {
                            account_id: value.account_id,
                            replica_revision: value.revision,
                            failure: value.failure,
                        })
                        .collect(),
                    closed: self.is_closed(),
                }))
            }
        }
    }

    fn ensure_open(&self) -> Result<(), RuntimeError> {
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
