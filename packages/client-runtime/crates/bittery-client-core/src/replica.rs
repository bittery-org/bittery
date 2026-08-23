use crate::protocol::Incarnation;
use crate::{AccountId, RuntimeError, RuntimeErrorCode};
use async_trait::async_trait;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

mod domain;
mod persistence_contract;

#[cfg(test)]
use domain::apply_plan;
use domain::AccountReplica;
pub(crate) use domain::{
    GuardedCommitPlan, OperationRecord, PlanMutation, PlanResult, RecomputedPlanResult,
    ReplicaItemRecord, ReplicaSnapshot,
};
#[cfg(feature = "persistence-contract-schema")]
#[doc(hidden)]
pub use persistence_contract::persistence_contract_schema;
pub(crate) use persistence_contract::ReplicaPersistenceRequest;
use persistence_contract::{
    apply_prepared_writes_to_rows, prepare_commit, prepare_install, reconstruct_snapshot,
    replica_invariant, snapshot_rows, ExpectedReplicaInstall, PreparedCommitOutcome,
    ReplicaInstallResult,
};
use persistence_contract::{ReplicaHead, ReplicaPersistenceResponse};
#[cfg(test)]
use persistence_contract::{ReplicaRowKey, ReplicaStore, StoredReplicaRow};

#[cfg(not(target_arch = "wasm32"))]
pub(crate) trait PersistenceRequirements: Send + Sync {}
#[cfg(not(target_arch = "wasm32"))]
impl<T: Send + Sync> PersistenceRequirements for T {}

#[cfg(target_arch = "wasm32")]
pub(crate) trait PersistenceRequirements {}
#[cfg(target_arch = "wasm32")]
impl<T> PersistenceRequirements for T {}

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
pub(crate) trait ReplicaPersistence: PersistenceRequirements {
    async fn invoke(
        &self,
        request: ReplicaPersistenceRequest,
    ) -> Result<ReplicaPersistenceResponse, RuntimeError>;
}

#[cfg(not(target_arch = "wasm32"))]
#[async_trait]
#[doc(hidden)]
pub trait SerializedReplicaExecutor: Send + Sync {
    async fn invoke(&self, request_json: String) -> Result<String, RuntimeError>;
}

#[cfg(target_arch = "wasm32")]
#[async_trait(?Send)]
#[doc(hidden)]
pub trait SerializedReplicaExecutor {
    async fn invoke(&self, request_json: String) -> Result<String, RuntimeError>;
}

pub(crate) struct SerializedReplicaPersistence {
    executor: Arc<dyn SerializedReplicaExecutor>,
}

impl SerializedReplicaPersistence {
    pub(crate) fn new(executor: Arc<dyn SerializedReplicaExecutor>) -> Self {
        Self { executor }
    }
}

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
impl ReplicaPersistence for SerializedReplicaPersistence {
    async fn invoke(
        &self,
        request: ReplicaPersistenceRequest,
    ) -> Result<ReplicaPersistenceResponse, RuntimeError> {
        let request_json = serde_json::to_string(&request).map_err(|_| {
            RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "Replica persistence request could not be serialized",
            )
        })?;
        let response_json = self.executor.invoke(request_json).await?;
        serde_json::from_str(&response_json).map_err(|_| {
            RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "Replica persistence returned an invalid response",
            )
        })
    }
}

pub(crate) struct Replica {
    persistence: Arc<dyn ReplicaPersistence>,
    snapshots: Mutex<HashMap<AccountId, ReplicaSnapshot>>,
}

impl Replica {
    pub(crate) fn new(persistence: Arc<dyn ReplicaPersistence>) -> Self {
        Self {
            persistence,
            snapshots: Mutex::new(HashMap::new()),
        }
    }

    #[allow(
        dead_code,
        reason = "used by the guarded persistence conformance surface"
    )]
    pub(crate) async fn load(
        &self,
        account_id: &AccountId,
    ) -> Result<Option<ReplicaSnapshot>, RuntimeError> {
        let snapshot = self.load_uncached(account_id).await?;
        let mut snapshots = self.snapshots.lock().expect("Replica cache lock poisoned");
        match &snapshot {
            Some(value) => {
                snapshots.insert(account_id.clone(), value.clone());
            }
            None => {
                snapshots.remove(account_id);
            }
        }
        Ok(snapshot)
    }

    async fn load_uncached(
        &self,
        account_id: &AccountId,
    ) -> Result<Option<ReplicaSnapshot>, RuntimeError> {
        let response = self
            .persistence
            .invoke(ReplicaPersistenceRequest::Load {
                account_id: account_id.clone(),
            })
            .await?;
        let ReplicaPersistenceResponse::Loaded { head, rows } = response else {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "Replica persistence returned a commit response for a load",
            ));
        };
        reconstruct_snapshot(account_id, head, rows)
    }

    pub(crate) async fn restore_known_accounts(
        &self,
        account_ids: &[AccountId],
    ) -> Result<Vec<ReplicaSnapshot>, RuntimeError> {
        let mut restored = Vec::with_capacity(account_ids.len());
        for account_id in account_ids {
            let snapshot = self.load_uncached(account_id).await?.ok_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::AccountMissing,
                    "known Account has no durable Replica installation",
                )
            })?;
            restored.push(snapshot);
        }
        Ok(restored)
    }

    pub(crate) async fn install_or_replace(
        &self,
        account_id: AccountId,
        user_id: String,
        incarnation: Incarnation,
    ) -> Result<ReplicaSnapshot, RuntimeError> {
        if account_id.as_str().is_empty() || user_id.is_empty() || incarnation.as_str().is_empty() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "Replica installation identities must not be empty",
            ));
        }
        loop {
            let current = self.load_uncached(&account_id).await?;
            if let Some(current) = &current {
                if current.user_id != user_id {
                    return Err(replica_invariant(
                        "installed Account identity cannot change User",
                    ));
                }
                if current.incarnation == incarnation {
                    if current.failure.is_some() {
                        return Err(replica_invariant(
                            "replayed Replica installation did not restore a clean head",
                        ));
                    }
                    return Ok(current.clone());
                }
            }
            let prepared = prepare_install(
                current.as_ref(),
                account_id.clone(),
                user_id.clone(),
                incarnation.clone(),
            )?;
            let response = self
                .persistence
                .invoke(ReplicaPersistenceRequest::Install {
                    prepared: prepared.clone(),
                })
                .await?;
            let ReplicaPersistenceResponse::Installed { result } = response else {
                return Err(replica_invariant(
                    "Replica persistence returned a non-install response for an install",
                ));
            };
            match result {
                ReplicaInstallResult::Applied => {
                    let snapshot = self.load_uncached(&account_id).await?.ok_or_else(|| {
                        replica_invariant("Replica persistence lost an applied installation")
                    })?;
                    if snapshot.account_id != prepared.next_head.account_id
                        || snapshot.user_id != prepared.next_head.user_id
                        || snapshot.incarnation != prepared.next_head.incarnation
                        || snapshot.revision != prepared.next_head.replica_revision
                        || snapshot.failure != prepared.next_head.failure
                        || !same_replica_rows(current.as_ref(), &snapshot)
                    {
                        return Err(replica_invariant(
                            "Replica persistence applied a different installation head",
                        ));
                    }
                    return Ok(snapshot);
                }
                ReplicaInstallResult::Stale => continue,
            }
        }
    }

    #[allow(
        dead_code,
        reason = "used by the guarded persistence conformance surface"
    )]
    pub(crate) async fn execute(
        &self,
        mut plan: GuardedCommitPlan,
    ) -> Result<PlanResult, RuntimeError> {
        let account_id = plan.account_id.clone();
        let expected_incarnation = plan.expected_incarnation.clone();
        let Some(mut current) = self.load(&account_id).await? else {
            return Ok(PlanResult::Missing);
        };
        if current.incarnation != plan.expected_incarnation
            || current.revision != plan.expected_replica_revision
        {
            return Ok(PlanResult::Stale {
                actual_revision: current.revision,
            });
        }

        loop {
            let PreparedCommitOutcome {
                wire: prepared,
                next_snapshot: next,
            } = prepare_commit(current.clone(), plan.clone())?;
            let response = self
                .persistence
                .invoke(ReplicaPersistenceRequest::Commit { prepared })
                .await?;
            let ReplicaPersistenceResponse::Committed { result } = response else {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::InvariantViolation,
                    "Replica persistence returned a load response for a commit",
                ));
            };
            match result {
                PlanResult::Applied { replica_revision } => {
                    if replica_revision != next.revision {
                        return Err(RuntimeError::new(
                            RuntimeErrorCode::InvariantViolation,
                            "Replica persistence committed an unexpected revision",
                        ));
                    }
                    self.snapshots
                        .lock()
                        .expect("Replica cache lock poisoned")
                        .insert(next.account_id.clone(), next);
                    return Ok(PlanResult::Applied { replica_revision });
                }
                PlanResult::Missing => {
                    self.load(&account_id).await?;
                    return Ok(PlanResult::Missing);
                }
                PlanResult::Stale { actual_revision } => {
                    let attempted_revision = plan.expected_replica_revision;
                    let latest = self.load(&account_id).await?;
                    let Some(latest) = latest else {
                        return Ok(PlanResult::Missing);
                    };
                    if latest.incarnation != expected_incarnation {
                        return Ok(PlanResult::Missing);
                    }
                    if latest.revision <= attempted_revision {
                        return Err(RuntimeError::new(
                            RuntimeErrorCode::InvariantViolation,
                            format!(
                                "Replica persistence reported stale revision {actual_revision} without durable progress"
                            ),
                        ));
                    }
                    plan.expected_replica_revision = latest.revision;
                    current = latest;
                }
            }
        }
    }

    pub(crate) async fn execute_recomputing(
        &self,
        mut plan: GuardedCommitPlan,
    ) -> Result<RecomputedPlanResult, RuntimeError> {
        let account_id = plan.account_id.clone();
        let expected_incarnation = plan.expected_incarnation.clone();
        loop {
            let attempted_revision = plan.expected_replica_revision;
            let Some(current) = self.load_uncached(&account_id).await? else {
                return Ok(RecomputedPlanResult::Missing);
            };
            if current.incarnation != expected_incarnation {
                return Ok(RecomputedPlanResult::Missing);
            }
            if current.revision != attempted_revision {
                if current.revision < attempted_revision {
                    return Err(replica_invariant(
                        "Replica revision moved backwards while recomputing",
                    ));
                }
                plan.expected_replica_revision = current.revision;
            }
            let PreparedCommitOutcome {
                wire: prepared,
                next_snapshot,
            } = prepare_commit(current, plan.clone())?;
            let response = self
                .persistence
                .invoke(ReplicaPersistenceRequest::Commit { prepared })
                .await?;
            let ReplicaPersistenceResponse::Committed { result } = response else {
                return Err(replica_invariant(
                    "Replica persistence returned a non-commit response for a commit",
                ));
            };
            match result {
                PlanResult::Applied { replica_revision }
                    if replica_revision == next_snapshot.revision =>
                {
                    return Ok(RecomputedPlanResult::Applied {
                        snapshot: next_snapshot,
                    });
                }
                PlanResult::Applied { .. } => {
                    return Err(replica_invariant(
                        "Replica persistence committed an unexpected revision",
                    ));
                }
                PlanResult::Missing => return Ok(RecomputedPlanResult::Missing),
                PlanResult::Stale { actual_revision } => {
                    if actual_revision <= attempted_revision {
                        return Err(replica_invariant(
                            "Replica persistence reported stale without durable progress",
                        ));
                    }
                    plan.expected_replica_revision = actual_revision;
                }
            }
        }
    }

    pub(crate) fn snapshot(&self, account_id: &AccountId) -> Option<ReplicaSnapshot> {
        self.snapshots
            .lock()
            .expect("Replica cache lock poisoned")
            .get(account_id)
            .cloned()
    }

    pub(crate) fn snapshots(&self) -> Vec<ReplicaSnapshot> {
        let mut values: Vec<_> = self
            .snapshots
            .lock()
            .expect("Replica cache lock poisoned")
            .values()
            .cloned()
            .collect();
        values.sort_by(|a, b| a.account_id.as_str().cmp(b.account_id.as_str()));
        values
    }

    pub(crate) fn cache(&self, snapshot: ReplicaSnapshot) {
        self.snapshots
            .lock()
            .expect("Replica cache lock poisoned")
            .insert(snapshot.account_id.clone(), snapshot);
    }

    pub(crate) fn replace_cache(&self, snapshots: &[ReplicaSnapshot]) {
        *self.snapshots.lock().expect("Replica cache lock poisoned") = snapshots
            .iter()
            .cloned()
            .map(|snapshot| (snapshot.account_id.clone(), snapshot))
            .collect();
    }

    pub(crate) fn remove_cached(&self, account_id: &AccountId) {
        self.snapshots
            .lock()
            .expect("Replica cache lock poisoned")
            .remove(account_id);
    }
}

fn same_replica_rows(current: Option<&ReplicaSnapshot>, next: &ReplicaSnapshot) -> bool {
    let Some(current) = current else {
        return next.items.is_empty() && next.operations.is_empty();
    };
    let current_items: HashMap<_, _> = current
        .items
        .iter()
        .map(|item| (&item.item_id, item))
        .collect();
    let next_items: HashMap<_, _> = next
        .items
        .iter()
        .map(|item| (&item.item_id, item))
        .collect();
    let current_operations: HashMap<_, _> = current
        .operations
        .iter()
        .map(|operation| (&operation.operation_id, operation))
        .collect();
    let next_operations: HashMap<_, _> = next
        .operations
        .iter()
        .map(|operation| (&operation.operation_id, operation))
        .collect();
    current_items == next_items && current_operations == next_operations
}

#[derive(Default)]
pub(crate) struct InMemoryReplica {
    accounts: Mutex<HashMap<AccountId, AccountReplica>>,
}

impl InMemoryReplica {
    #[cfg(test)]
    pub(crate) fn install(
        &self,
        account_id: AccountId,
        user_id: String,
        incarnation: Incarnation,
    ) -> Result<(), RuntimeError> {
        let mut accounts = self.accounts.lock().expect("replica lock poisoned");
        if accounts.contains_key(&account_id) {
            return Err(RuntimeError::new(
                RuntimeErrorCode::AccountAlreadyInstalled,
                "account is already installed",
            ));
        }
        accounts.insert(
            account_id.clone(),
            AccountReplica {
                account_id,
                user_id,
                incarnation,
                revision: 0,
                items: HashMap::new(),
                operations: HashMap::new(),
                failure: None,
            },
        );
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn execute(&self, plan: GuardedCommitPlan) -> Result<PlanResult, RuntimeError> {
        let mut accounts = self.accounts.lock().expect("replica lock poisoned");
        let Some(current) = accounts.get(&plan.account_id) else {
            return Ok(PlanResult::Missing);
        };
        if current.incarnation != plan.expected_incarnation
            || current.revision != plan.expected_replica_revision
        {
            return Ok(PlanResult::Stale {
                actual_revision: current.revision,
            });
        }

        let account_id = plan.account_id.clone();
        let next = apply_plan(current.snapshot(), plan)?;
        let revision = next.revision;
        accounts.insert(account_id, AccountReplica::from_snapshot(next));
        Ok(PlanResult::Applied {
            replica_revision: revision,
        })
    }

    #[cfg(test)]
    pub(crate) fn remove(&self, account_id: &AccountId) {
        self.accounts
            .lock()
            .expect("replica lock poisoned")
            .remove(account_id);
    }

    pub(crate) fn snapshot(&self, account_id: &AccountId) -> Option<ReplicaSnapshot> {
        self.accounts
            .lock()
            .expect("replica lock poisoned")
            .get(account_id)
            .map(AccountReplica::snapshot)
    }

    #[cfg(test)]
    pub(crate) fn fail(
        &self,
        account_id: &AccountId,
        code: RuntimeErrorCode,
    ) -> Result<(), RuntimeError> {
        let mut accounts = self.accounts.lock().expect("replica lock poisoned");
        let account = accounts.get_mut(account_id).ok_or_else(|| {
            RuntimeError::new(RuntimeErrorCode::AccountMissing, "account is not installed")
        })?;
        account.failure = Some(code);
        account.revision += 1;
        Ok(())
    }
}

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
impl ReplicaPersistence for InMemoryReplica {
    async fn invoke(
        &self,
        request: ReplicaPersistenceRequest,
    ) -> Result<ReplicaPersistenceResponse, RuntimeError> {
        match request {
            ReplicaPersistenceRequest::Load { account_id } => {
                let snapshot = self.snapshot(&account_id);
                let (head, rows) = match snapshot {
                    Some(snapshot) => (
                        Some(ReplicaHead {
                            account_id: snapshot.account_id.clone(),
                            user_id: snapshot.user_id.clone(),
                            incarnation: snapshot.incarnation.clone(),
                            replica_revision: snapshot.revision,
                            failure: snapshot.failure,
                        }),
                        snapshot_rows(snapshot)?,
                    ),
                    None => (None, vec![]),
                };
                Ok(ReplicaPersistenceResponse::Loaded { head, rows })
            }
            ReplicaPersistenceRequest::Install { prepared } => {
                let mut accounts = self.accounts.lock().expect("replica lock poisoned");
                let account_id = prepared.next_head.account_id.clone();
                let matches = match (&prepared.expected, accounts.get(&account_id)) {
                    (
                        ExpectedReplicaInstall::Missing {
                            account_id: expected,
                        },
                        None,
                    ) => expected == &account_id,
                    (
                        ExpectedReplicaInstall::Present {
                            account_id: expected_account,
                            user_id,
                            incarnation,
                            replica_revision,
                        },
                        Some(current),
                    ) => {
                        expected_account == &account_id
                            && current.user_id == *user_id
                            && current.incarnation == *incarnation
                            && current.revision == *replica_revision
                    }
                    _ => false,
                };
                if !matches {
                    return Ok(ReplicaPersistenceResponse::Installed {
                        result: ReplicaInstallResult::Stale,
                    });
                }
                match accounts.get_mut(&account_id) {
                    Some(current) => {
                        current.user_id = prepared.next_head.user_id;
                        current.incarnation = prepared.next_head.incarnation;
                        current.revision = prepared.next_head.replica_revision;
                        current.failure = prepared.next_head.failure;
                    }
                    None => {
                        let head = prepared.next_head;
                        accounts.insert(
                            account_id,
                            AccountReplica {
                                account_id: head.account_id,
                                user_id: head.user_id,
                                incarnation: head.incarnation,
                                revision: head.replica_revision,
                                items: HashMap::new(),
                                operations: HashMap::new(),
                                failure: head.failure,
                            },
                        );
                    }
                }
                Ok(ReplicaPersistenceResponse::Installed {
                    result: ReplicaInstallResult::Applied,
                })
            }
            ReplicaPersistenceRequest::Commit { prepared } => {
                let mut accounts = self.accounts.lock().expect("replica lock poisoned");
                let Some(current) = accounts.get(&prepared.expected.account_id) else {
                    return Ok(ReplicaPersistenceResponse::Committed {
                        result: PlanResult::Missing,
                    });
                };
                if current.incarnation != prepared.expected.incarnation
                    || current.revision != prepared.expected.replica_revision
                {
                    return Ok(ReplicaPersistenceResponse::Committed {
                        result: PlanResult::Stale {
                            actual_revision: current.revision,
                        },
                    });
                }
                let expected_next_revision = current
                    .revision
                    .checked_add(1)
                    .ok_or_else(|| replica_invariant("Replica revision overflowed"))?;
                if prepared.next_head.account_id != prepared.expected.account_id
                    || prepared.next_head.user_id != current.user_id
                    || prepared.next_head.incarnation != prepared.expected.incarnation
                    || prepared.next_head.replica_revision != expected_next_revision
                {
                    return Err(replica_invariant(
                        "prepared Replica head transition is invalid",
                    ));
                }
                let rows = apply_prepared_writes_to_rows(
                    snapshot_rows(current.snapshot())?,
                    &prepared.writes,
                );
                let next = reconstruct_snapshot(
                    &prepared.expected.account_id,
                    Some(prepared.next_head),
                    rows,
                )?
                .ok_or_else(|| replica_invariant("prepared Replica commit lost its head"))?;
                accounts.insert(next.account_id.clone(), AccountReplica::from_snapshot(next));
                Ok(ReplicaPersistenceResponse::Committed {
                    result: PlanResult::Applied {
                        replica_revision: expected_next_revision,
                    },
                })
            }
        }
    }
}

#[cfg(test)]
mod persistence_contract_tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    struct HostileCrossUserExecutor {
        install_called: AtomicBool,
    }

    #[async_trait]
    impl ReplicaPersistence for HostileCrossUserExecutor {
        async fn invoke(
            &self,
            request: ReplicaPersistenceRequest,
        ) -> Result<ReplicaPersistenceResponse, RuntimeError> {
            match request {
                ReplicaPersistenceRequest::Load { account_id } => {
                    Ok(ReplicaPersistenceResponse::Loaded {
                        head: Some(ReplicaHead {
                            account_id,
                            user_id: "hostile-user".into(),
                            incarnation: Incarnation::from("hostile-incarnation"),
                            replica_revision: 7,
                            failure: None,
                        }),
                        rows: vec![],
                    })
                }
                ReplicaPersistenceRequest::Install { .. } => {
                    self.install_called.store(true, Ordering::SeqCst);
                    Ok(ReplicaPersistenceResponse::Installed {
                        result: ReplicaInstallResult::Applied,
                    })
                }
                ReplicaPersistenceRequest::Commit { .. } => unreachable!(),
            }
        }
    }

    struct InstallRaceExecutor {
        state: InMemoryReplica,
        raced: AtomicBool,
        install_calls: AtomicUsize,
    }

    struct LyingAppliedExecutor {
        state: InMemoryReplica,
    }

    #[derive(Clone, Copy)]
    enum RowCorruption {
        Delete,
        Add,
        Change,
    }

    struct LyingRowsExecutor {
        current: ReplicaSnapshot,
        next_head: Mutex<Option<ReplicaHead>>,
        corruption: RowCorruption,
    }

    #[async_trait]
    impl ReplicaPersistence for LyingRowsExecutor {
        async fn invoke(
            &self,
            request: ReplicaPersistenceRequest,
        ) -> Result<ReplicaPersistenceResponse, RuntimeError> {
            match request {
                ReplicaPersistenceRequest::Load { .. } => {
                    let next_head = self.next_head.lock().unwrap().clone();
                    let mut snapshot = self.current.clone();
                    let head = next_head.unwrap_or_else(|| ReplicaHead {
                        account_id: snapshot.account_id.clone(),
                        user_id: snapshot.user_id.clone(),
                        incarnation: snapshot.incarnation.clone(),
                        replica_revision: snapshot.revision,
                        failure: snapshot.failure,
                    });
                    if head.incarnation != snapshot.incarnation {
                        snapshot.incarnation = head.incarnation.clone();
                        snapshot.revision = head.replica_revision;
                        match self.corruption {
                            RowCorruption::Delete => {
                                snapshot.items.clear();
                                snapshot.operations.clear();
                            }
                            RowCorruption::Add => {
                                snapshot.items.push(item("account-1", "hostile-item"));
                                snapshot
                                    .operations
                                    .push(operation("hostile-operation", "hostile-item"));
                            }
                            RowCorruption::Change => {
                                snapshot.items[0].ciphertext = b"hostile-ciphertext".to_vec();
                                snapshot.operations[0].request_bytes = b"hostile-request".to_vec();
                            }
                        }
                    }
                    Ok(ReplicaPersistenceResponse::Loaded {
                        head: Some(head),
                        rows: snapshot_rows(snapshot)?,
                    })
                }
                ReplicaPersistenceRequest::Install { prepared } => {
                    *self.next_head.lock().unwrap() = Some(prepared.next_head);
                    Ok(ReplicaPersistenceResponse::Installed {
                        result: ReplicaInstallResult::Applied,
                    })
                }
                ReplicaPersistenceRequest::Commit { .. } => unreachable!(),
            }
        }
    }

    #[async_trait]
    impl ReplicaPersistence for LyingAppliedExecutor {
        async fn invoke(
            &self,
            request: ReplicaPersistenceRequest,
        ) -> Result<ReplicaPersistenceResponse, RuntimeError> {
            match request {
                ReplicaPersistenceRequest::Install { prepared } => {
                    self.state
                        .install(
                            prepared.next_head.account_id,
                            "hostile-user".into(),
                            Incarnation::from("hostile-incarnation"),
                        )
                        .unwrap();
                    Ok(ReplicaPersistenceResponse::Installed {
                        result: ReplicaInstallResult::Applied,
                    })
                }
                other => self.state.invoke(other).await,
            }
        }
    }

    #[async_trait]
    impl ReplicaPersistence for InstallRaceExecutor {
        async fn invoke(
            &self,
            request: ReplicaPersistenceRequest,
        ) -> Result<ReplicaPersistenceResponse, RuntimeError> {
            if let ReplicaPersistenceRequest::Install { prepared } = &request {
                self.install_calls.fetch_add(1, Ordering::SeqCst);
                if !self.raced.swap(true, Ordering::SeqCst) {
                    self.state
                        .install(
                            prepared.next_head.account_id.clone(),
                            prepared.next_head.user_id.clone(),
                            Incarnation::from("competing-incarnation"),
                        )
                        .unwrap();
                }
            }
            self.state.invoke(request).await
        }
    }

    struct SerializedFakeExecutor {
        state: InMemoryReplica,
        commit_calls: AtomicUsize,
    }

    impl SerializedFakeExecutor {
        fn seeded() -> Self {
            let state = InMemoryReplica::default();
            state
                .install(
                    AccountId::from("account-1"),
                    "user-1".into(),
                    Incarnation::from("incarnation-1"),
                )
                .unwrap();
            Self {
                state,
                commit_calls: AtomicUsize::new(0),
            }
        }
    }

    #[async_trait]
    impl SerializedReplicaExecutor for SerializedFakeExecutor {
        async fn invoke(&self, request_json: String) -> Result<String, RuntimeError> {
            let request: ReplicaPersistenceRequest = serde_json::from_str(&request_json).unwrap();
            if matches!(request, ReplicaPersistenceRequest::Commit { .. }) {
                self.commit_calls.fetch_add(1, Ordering::SeqCst);
            }
            serde_json::to_string(&self.state.invoke(request).await?).map_err(|_| {
                RuntimeError::new(
                    RuntimeErrorCode::InvariantViolation,
                    "fake response could not be serialized",
                )
            })
        }
    }

    fn item(account_id: &str, item_id: &str) -> ReplicaItemRecord {
        ReplicaItemRecord {
            account_id: AccountId::from(account_id),
            item_id: item_id.into(),
            vault_id: "vault-1".into(),
            ciphertext: b"sealed-item".to_vec(),
            optimistic: true,
        }
    }

    fn operation(operation_id: &str, item_id: &str) -> OperationRecord {
        OperationRecord {
            operation_id: operation_id.into(),
            item_id: item_id.into(),
            request_bytes: b"sealed-request".to_vec(),
        }
    }

    #[tokio::test]
    async fn rust_rejects_cross_user_install_before_a_hostile_executor_can_apply_it() {
        let persistence = Arc::new(HostileCrossUserExecutor {
            install_called: AtomicBool::new(false),
        });
        let replica = Replica::new(persistence.clone());
        let error = replica
            .install_or_replace(
                AccountId::from("account-1"),
                "desired-user".into(),
                Incarnation::from("desired-incarnation"),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
        assert!(!persistence.install_called.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn install_rereads_and_retries_after_a_stale_compare_and_swap() {
        let persistence = Arc::new(InstallRaceExecutor {
            state: InMemoryReplica::default(),
            raced: AtomicBool::new(false),
            install_calls: AtomicUsize::new(0),
        });
        let replica = Replica::new(persistence.clone());
        let snapshot = replica
            .install_or_replace(
                AccountId::from("account-1"),
                "user-1".into(),
                Incarnation::from("desired-incarnation"),
            )
            .await
            .unwrap();
        assert_eq!(persistence.install_calls.load(Ordering::SeqCst), 2);
        assert_eq!(
            snapshot.incarnation,
            Incarnation::from("desired-incarnation")
        );
        assert_eq!(snapshot.revision, 1);
    }

    #[tokio::test]
    async fn rust_rejects_an_applied_response_when_authoritative_head_differs() {
        let replica = Replica::new(Arc::new(LyingAppliedExecutor {
            state: InMemoryReplica::default(),
        }));
        let error = replica
            .install_or_replace(
                AccountId::from("account-1"),
                "user-1".into(),
                Incarnation::from("desired-incarnation"),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
        assert!(replica.snapshot(&AccountId::from("account-1")).is_none());
    }

    #[tokio::test]
    async fn rust_rejects_applied_when_preserved_rows_are_deleted_added_or_changed() {
        for corruption in [
            RowCorruption::Delete,
            RowCorruption::Add,
            RowCorruption::Change,
        ] {
            let replica = Replica::new(Arc::new(LyingRowsExecutor {
                current: ReplicaSnapshot {
                    account_id: AccountId::from("account-1"),
                    user_id: "user-1".into(),
                    incarnation: Incarnation::from("old-incarnation"),
                    revision: 1,
                    items: vec![item("account-1", "item-1")],
                    operations: vec![operation("operation-1", "item-1")],
                    failure: None,
                },
                next_head: Mutex::new(None),
                corruption,
            }));
            assert_eq!(
                replica
                    .install_or_replace(
                        AccountId::from("account-1"),
                        "user-1".into(),
                        Incarnation::from("new-incarnation"),
                    )
                    .await
                    .unwrap_err()
                    .code,
                RuntimeErrorCode::InvariantViolation
            );
            assert!(replica.snapshot(&AccountId::from("account-1")).is_none());
        }
    }

    async fn assert_replica_conformance(replica: &Replica) {
        let account_id = AccountId::from("account-1");
        let incarnation = Incarnation::from("incarnation-1");
        assert_eq!(
            replica.load(&account_id).await.unwrap().unwrap().revision,
            0
        );

        assert_eq!(
            replica
                .execute(GuardedCommitPlan::new(
                    AccountId::from("missing-account"),
                    incarnation.clone(),
                    0,
                    vec![],
                ))
                .await
                .unwrap(),
            PlanResult::Missing
        );
        assert_eq!(
            replica
                .execute(GuardedCommitPlan::new(
                    account_id.clone(),
                    incarnation.clone(),
                    7,
                    vec![],
                ))
                .await
                .unwrap(),
            PlanResult::Stale { actual_revision: 0 }
        );

        let invalid = replica
            .execute(GuardedCommitPlan::new(
                account_id.clone(),
                incarnation.clone(),
                0,
                vec![
                    PlanMutation::PutOptimisticItem(item("account-1", "item-invalid")),
                    PlanMutation::RemoveOperation {
                        operation_id: "unknown-operation".into(),
                    },
                ],
            ))
            .await
            .unwrap_err();
        assert_eq!(invalid.code, RuntimeErrorCode::InvariantViolation);
        let unchanged = replica.load(&account_id).await.unwrap().unwrap();
        assert_eq!(unchanged.revision, 0);
        assert!(unchanged.items.is_empty());

        let wrong_scope = replica
            .execute(GuardedCommitPlan::new(
                account_id.clone(),
                incarnation.clone(),
                0,
                vec![PlanMutation::PutOptimisticItem(item(
                    "account-2",
                    "item-cross-account",
                ))],
            ))
            .await
            .unwrap_err();
        assert_eq!(wrong_scope.code, RuntimeErrorCode::InvariantViolation);

        assert_eq!(
            replica
                .execute(GuardedCommitPlan::new(
                    account_id.clone(),
                    incarnation.clone(),
                    0,
                    vec![
                        PlanMutation::AcceptOperation(operation("operation-1", "item-1")),
                        PlanMutation::PutOptimisticItem(item("account-1", "item-1")),
                    ],
                ))
                .await
                .unwrap(),
            PlanResult::Applied {
                replica_revision: 1,
            }
        );
        let committed = replica.load(&account_id).await.unwrap().unwrap();
        assert_eq!(committed.revision, 1);
        assert_eq!(committed.items.len(), 1);
        assert_eq!(committed.operations.len(), 1);

        assert_eq!(
            replica
                .execute(GuardedCommitPlan::new(
                    account_id.clone(),
                    incarnation,
                    1,
                    vec![PlanMutation::RemoveOperation {
                        operation_id: "operation-1".into(),
                    }],
                ))
                .await
                .unwrap(),
            PlanResult::Applied {
                replica_revision: 2,
            }
        );
        assert_eq!(
            replica.load(&account_id).await.unwrap().unwrap().revision,
            2
        );
    }

    #[test]
    fn persistence_wire_uses_closed_tags_and_decimal_revision_strings() {
        assert_eq!(
            serde_json::to_value(ReplicaPersistenceRequest::Load {
                account_id: AccountId::from("account-1"),
            })
            .unwrap(),
            serde_json::json!({ "type": "load", "accountId": "account-1" })
        );
        let prepared = prepare_commit(
            ReplicaSnapshot {
                account_id: AccountId::from("account-1"),
                user_id: "user-1".into(),
                incarnation: Incarnation::from("incarnation-1"),
                revision: 41,
                items: vec![],
                operations: vec![operation("operation-1", "item-1")],
                failure: None,
            },
            GuardedCommitPlan::new(
                AccountId::from("account-1"),
                Incarnation::from("incarnation-1"),
                41,
                vec![PlanMutation::RemoveOperation {
                    operation_id: "operation-1".into(),
                }],
            ),
        )
        .unwrap()
        .wire;
        let request = ReplicaPersistenceRequest::Commit { prepared };

        assert_eq!(
            serde_json::to_value(request).unwrap(),
            serde_json::json!({
                "type": "commit",
                "prepared": {
                    "expected": {
                        "accountId": "account-1",
                        "incarnation": "incarnation-1",
                        "replicaRevision": "41"
                    },
                    "nextHead": {
                        "accountId": "account-1",
                        "userId": "user-1",
                        "incarnation": "incarnation-1",
                        "replicaRevision": "42",
                        "failure": null
                    },
                    "writes": [{
                        "type": "delete",
                        "store": "operations",
                        "key": { "accountId": "account-1", "recordId": "operation-1" }
                    }]
                }
            })
        );
        assert_eq!(
            serde_json::to_value(ReplicaPersistenceResponse::Loaded {
                head: None,
                rows: vec![],
            })
            .unwrap(),
            serde_json::json!({ "type": "loaded", "head": null, "rows": [] })
        );
        assert_eq!(
            serde_json::to_value(ReplicaPersistenceResponse::Committed {
                result: PlanResult::Applied {
                    replica_revision: 42,
                },
            })
            .unwrap(),
            serde_json::json!({
                "type": "committed",
                "result": { "type": "applied", "replicaRevision": "42" }
            })
        );
        assert!(
            serde_json::from_value::<ReplicaPersistenceResponse>(serde_json::json!({
                "type": "committed",
                "result": { "type": "stale", "actualRevision": 42 }
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<ReplicaPersistenceResponse>(serde_json::json!({
                "type": "loaded",
                "rows": []
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<ReplicaPersistenceResponse>(serde_json::json!({
                "type": "loaded",
                "head": {
                    "accountId": "account-1",
                    "incarnation": "incarnation-1",
                    "replicaRevision": "0"
                },
                "rows": []
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<ReplicaPersistenceResponse>(serde_json::json!({
                "type": "committed",
                "result": { "type": "missing" },
                "unexpected": true
            }))
            .is_err()
        );
    }

    #[test]
    fn valid_domain_plan_becomes_an_opaque_primitive_commit() {
        let current = ReplicaSnapshot {
            account_id: AccountId::from("account-1"),
            user_id: "user-1".into(),
            incarnation: Incarnation::from("incarnation-1"),
            revision: 4,
            items: vec![],
            operations: vec![operation("operation-old", "item-old")],
            failure: None,
        };
        let prepared = prepare_commit(
            current,
            GuardedCommitPlan::new(
                AccountId::from("account-1"),
                Incarnation::from("incarnation-1"),
                4,
                vec![
                    PlanMutation::AcceptOperation(operation("operation-new", "item-new")),
                    PlanMutation::PutOptimisticItem(item("account-1", "item-new")),
                    PlanMutation::RemoveOperation {
                        operation_id: "operation-old".into(),
                    },
                ],
            ),
        )
        .unwrap()
        .wire;

        let wire = serde_json::to_value(prepared).unwrap();
        assert_eq!(wire["expected"]["replicaRevision"], "4");
        assert_eq!(wire["nextHead"]["replicaRevision"], "5");
        assert_eq!(wire["writes"].as_array().unwrap().len(), 3);
        assert_eq!(wire["writes"][0]["type"], "put");
        assert_eq!(wire["writes"][0]["row"]["store"], "operations");
        assert!(wire["writes"][0]["row"]["payloadJson"].is_string());
        assert_eq!(wire["writes"][2]["type"], "delete");
        assert_eq!(wire["writes"][2]["store"], "operations");
        assert!(wire.to_string().find("acceptOperation").is_none());
        assert!(wire.to_string().find("removeOperation").is_none());
    }

    #[test]
    fn persisted_rows_are_reconstructed_and_validated_fail_closed() {
        let account_id = AccountId::from("account-1");
        let head = ReplicaHead {
            account_id: account_id.clone(),
            user_id: "user-1".into(),
            incarnation: Incarnation::from("incarnation-1"),
            replica_revision: 7,
            failure: None,
        };
        let mismatched = StoredReplicaRow {
            store: ReplicaStore::Operations,
            key: ReplicaRowKey {
                account_id: account_id.clone(),
                record_id: "operation-key".into(),
            },
            payload_json: serde_json::to_string(&operation("operation-payload", "item-1")).unwrap(),
        };

        let error = reconstruct_snapshot(&account_id, Some(head), vec![mismatched]).unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
        assert!(reconstruct_snapshot(
            &account_id,
            Some(ReplicaHead {
                account_id: account_id.clone(),
                user_id: String::new(),
                incarnation: Incarnation::from("incarnation-1"),
                replica_revision: 0,
                failure: None,
            }),
            vec![],
        )
        .is_err());
        assert!(reconstruct_snapshot(&account_id, None, vec![])
            .unwrap()
            .is_none());
        assert!(reconstruct_snapshot(
            &account_id,
            None,
            vec![StoredReplicaRow {
                store: ReplicaStore::Operations,
                key: ReplicaRowKey {
                    account_id: account_id.clone(),
                    record_id: "orphan".into(),
                },
                payload_json: "{}".into(),
            }],
        )
        .is_err());
    }

    #[tokio::test]
    async fn in_memory_replica_satisfies_the_guarded_plan_contract() {
        let persistence = Arc::new(InMemoryReplica::default());
        persistence
            .install(
                AccountId::from("account-1"),
                "user-1".into(),
                Incarnation::from("incarnation-1"),
            )
            .unwrap();
        let persistence: Arc<dyn ReplicaPersistence> = persistence;
        assert_replica_conformance(&Replica::new(persistence)).await;
    }

    #[tokio::test]
    async fn installation_and_commit_cannot_change_the_account_user_identity() {
        let persistence = Arc::new(InMemoryReplica::default());
        let replica = Replica::new(persistence.clone());
        let account_id = AccountId::from("account-1");
        replica
            .install_or_replace(
                account_id.clone(),
                "user-1".into(),
                Incarnation::from("incarnation-1"),
            )
            .await
            .unwrap();
        assert!(replica
            .install_or_replace(
                account_id.clone(),
                "user-2".into(),
                Incarnation::from("incarnation-2"),
            )
            .await
            .is_err());
        let current = replica.load(&account_id).await.unwrap().unwrap();
        assert_eq!(current.user_id, "user-1");
        assert_eq!(current.incarnation, Incarnation::from("incarnation-1"));

        let mut prepared = prepare_commit(
            current,
            GuardedCommitPlan::new(
                account_id.clone(),
                Incarnation::from("incarnation-1"),
                0,
                vec![],
            ),
        )
        .unwrap()
        .wire;
        prepared.next_head.user_id = "user-2".into();
        assert!(persistence
            .invoke(ReplicaPersistenceRequest::Commit { prepared })
            .await
            .is_err());
        assert_eq!(
            replica.load(&account_id).await.unwrap().unwrap().user_id,
            "user-1"
        );
    }

    #[tokio::test]
    async fn serialized_executor_satisfies_the_same_guarded_plan_contract() {
        let executor = Arc::new(SerializedFakeExecutor::seeded());
        let persistence: Arc<dyn ReplicaPersistence> =
            Arc::new(SerializedReplicaPersistence::new(executor.clone()));
        assert_replica_conformance(&Replica::new(persistence)).await;
        assert_eq!(executor.commit_calls.load(Ordering::SeqCst), 2);
    }
}
