use crate::{
    AccountId, AccountStatus, GuardedCommitPlan, InMemoryReplica, ItemProjectionStatus,
    ItemsProjection, LoginItemProjection, ObservationRequest, ObservationSink, OperationRecord,
    PlanMutation, PlanResult, ReplicaItemRecord, RequestCancellation, RuntimeError,
    RuntimeErrorCode, RuntimeProjection, RuntimeRequest, RuntimeResponse, RuntimeStatusProjection,
};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, Weak,
    },
};

struct Subscription {
    request: ObservationRequest,
    sink: Arc<dyn ObservationSink>,
}

pub struct Runtime {
    replica: Arc<InMemoryReplica>,
    observers: Mutex<HashMap<u64, Subscription>>,
    next_observer_id: AtomicU64,
    device_revision: AtomicU64,
    closed: AtomicBool,
    unlocked_items: Mutex<HashMap<AccountId, Vec<LoginItemProjection>>>,
}

impl Runtime {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            replica: Arc::new(InMemoryReplica::default()),
            observers: Mutex::new(HashMap::new()),
            next_observer_id: AtomicU64::new(1),
            device_revision: AtomicU64::new(0),
            closed: AtomicBool::new(false),
            unlocked_items: Mutex::new(HashMap::new()),
        })
    }

    pub fn replica(&self) -> Arc<InMemoryReplica> {
        Arc::clone(&self.replica)
    }

    pub fn install_account(
        &self,
        account_id: AccountId,
        user_id: String,
        incarnation: crate::Incarnation,
    ) -> Result<(), RuntimeError> {
        self.ensure_open()?;
        self.replica
            .install(account_id.clone(), user_id, incarnation)?;
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

    pub async fn request_with_acceptance_hook(
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
                let result = self.replica.execute(GuardedCommitPlan::new(
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
                ))?;
                let PlanResult::Applied { replica_revision } = result else {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::InvariantViolation,
                        "in-process Account plan became stale",
                    ));
                };
                self.unlocked_items
                    .lock()
                    .expect("unlocked projection lock poisoned")
                    .entry(account_id)
                    .or_default()
                    .push(projection);
                self.device_revision.fetch_add(1, Ordering::SeqCst);
                self.publish_all();
                accepted();
                // Cancellation after this commit stops only the caller's wait. The accepted
                // Operation remains Runtime-owned and is observable through the Replica.
                Ok(RuntimeResponse::Accepted {
                    operation_id,
                    item_id,
                    replica_revision,
                })
            }
        }
    }

    pub fn execute_plan(&self, plan: GuardedCommitPlan) -> Result<PlanResult, RuntimeError> {
        self.ensure_open()?;
        let result = self.replica.execute(plan)?;
        if matches!(result, PlanResult::Applied { .. }) {
            self.device_revision.fetch_add(1, Ordering::SeqCst);
            self.publish_all();
        }
        Ok(result)
    }

    pub fn fail_account(
        &self,
        account_id: &AccountId,
        code: RuntimeErrorCode,
    ) -> Result<(), RuntimeError> {
        self.replica.fail(account_id, code)?;
        self.device_revision.fetch_add(1, Ordering::SeqCst);
        self.publish_all();
        Ok(())
    }

    pub fn observe(
        self: &Arc<Self>,
        request: ObservationRequest,
        sink: Arc<dyn ObservationSink>,
    ) -> Result<Arc<ObservationHandle>, RuntimeError> {
        self.ensure_open()?;
        let initial = self.projection(&request)?;
        let id = self.next_observer_id.fetch_add(1, Ordering::SeqCst);
        self.observers
            .lock()
            .expect("observer lock poisoned")
            .insert(
                id,
                Subscription {
                    request,
                    sink: Arc::clone(&sink),
                },
            );
        sink.publish(initial);
        Ok(Arc::new(ObservationHandle {
            id,
            runtime: Arc::downgrade(self),
            closed: AtomicBool::new(false),
        }))
    }

    pub fn publish_all(&self) {
        let publications: Vec<_> = self
            .observers
            .lock()
            .expect("observer lock poisoned")
            .values()
            .filter_map(|subscription| {
                self.projection(&subscription.request)
                    .ok()
                    .map(|projection| (Arc::clone(&subscription.sink), projection))
            })
            .collect();
        for (sink, projection) in publications {
            sink.publish(projection);
        }
    }

    pub fn close(&self) {
        if !self.closed.swap(true, Ordering::SeqCst) {
            self.observers
                .lock()
                .expect("observer lock poisoned")
                .clear();
        }
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
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
    }
}

impl Drop for ObservationHandle {
    fn drop(&mut self) {
        self.close();
    }
}
