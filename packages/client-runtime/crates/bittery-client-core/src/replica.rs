use crate::{protocol::Incarnation, AccountId, RuntimeError, RuntimeErrorCode};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

mod decimal_u64 {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S>(value: &u64, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&value.to_string())
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<u64, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        let parsed: u64 = value.parse().map_err(serde::de::Error::custom)?;
        if parsed.to_string() != value {
            return Err(serde::de::Error::custom(
                "expected a canonical unsigned decimal string",
            ));
        }
        Ok(parsed)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GuardedCommitPlan {
    pub account_id: AccountId,
    pub expected_incarnation: Incarnation,
    #[serde(with = "decimal_u64")]
    pub expected_replica_revision: u64,
    pub mutations: Vec<PlanMutation>,
}

impl GuardedCommitPlan {
    pub(crate) fn new(
        account_id: AccountId,
        expected_incarnation: Incarnation,
        expected_replica_revision: u64,
        mutations: Vec<PlanMutation>,
    ) -> Self {
        Self {
            account_id,
            expected_incarnation,
            expected_replica_revision,
            mutations,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum PlanMutation {
    PutOptimisticItem(ReplicaItemRecord),
    AcceptOperation(OperationRecord),
    RemoveOperation { operation_id: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OperationRecord {
    pub operation_id: String,
    pub item_id: String,
    pub request_bytes: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReplicaItemRecord {
    pub account_id: AccountId,
    pub item_id: String,
    pub vault_id: String,
    pub ciphertext: Vec<u8>,
    pub optimistic: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum PlanResult {
    Applied {
        #[serde(with = "decimal_u64")]
        replica_revision: u64,
    },
    Stale {
        #[serde(with = "decimal_u64")]
        actual_revision: u64,
    },
    Missing,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReplicaSnapshot {
    pub account_id: AccountId,
    pub incarnation: Incarnation,
    #[serde(with = "decimal_u64")]
    pub revision: u64,
    pub items: Vec<ReplicaItemRecord>,
    pub operations: Vec<OperationRecord>,
    pub failure: Option<RuntimeErrorCode>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum ReplicaPersistenceRequest {
    Load { account_id: AccountId },
    Commit { plan: GuardedCommitPlan },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum ReplicaPersistenceResponse {
    Loaded { snapshot: Option<ReplicaSnapshot> },
    Committed { result: PlanResult },
}

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

    pub(crate) async fn load(
        &self,
        account_id: &AccountId,
    ) -> Result<Option<ReplicaSnapshot>, RuntimeError> {
        let response = self
            .persistence
            .invoke(ReplicaPersistenceRequest::Load {
                account_id: account_id.clone(),
            })
            .await?;
        let ReplicaPersistenceResponse::Loaded { snapshot } = response else {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "Replica persistence returned a commit response for a load",
            ));
        };
        if snapshot
            .as_ref()
            .is_some_and(|value| value.account_id != *account_id)
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "Replica persistence returned another Account's snapshot",
            ));
        }
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

    pub(crate) async fn execute(
        &self,
        plan: GuardedCommitPlan,
    ) -> Result<PlanResult, RuntimeError> {
        let Some(current) = self.load(&plan.account_id).await? else {
            return Ok(PlanResult::Missing);
        };
        if current.incarnation != plan.expected_incarnation
            || current.revision != plan.expected_replica_revision
        {
            return Ok(PlanResult::Stale {
                actual_revision: current.revision,
            });
        }

        let next = apply_plan(current, plan.clone())?;
        let response = self
            .persistence
            .invoke(ReplicaPersistenceRequest::Commit { plan })
            .await?;
        let ReplicaPersistenceResponse::Committed { result } = response else {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "Replica persistence returned a load response for a commit",
            ));
        };
        if let PlanResult::Applied { replica_revision } = result {
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
        }
        Ok(result)
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

    #[cfg(test)]
    pub(crate) fn cache(&self, snapshot: ReplicaSnapshot) {
        self.snapshots
            .lock()
            .expect("Replica cache lock poisoned")
            .insert(snapshot.account_id.clone(), snapshot);
    }
}

fn apply_plan(
    current: ReplicaSnapshot,
    plan: GuardedCommitPlan,
) -> Result<ReplicaSnapshot, RuntimeError> {
    let mut next = AccountReplica::from_snapshot(current);
    for mutation in plan.mutations {
        next.apply(mutation)?;
    }
    next.revision = next.revision.checked_add(1).ok_or_else(|| {
        RuntimeError::new(
            RuntimeErrorCode::InvariantViolation,
            "Replica revision overflowed",
        )
    })?;
    Ok(next.snapshot())
}

#[derive(Clone)]
struct AccountReplica {
    account_id: AccountId,
    incarnation: Incarnation,
    revision: u64,
    items: HashMap<String, ReplicaItemRecord>,
    operations: HashMap<String, OperationRecord>,
    failure: Option<RuntimeErrorCode>,
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
        _user_id: String,
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
                incarnation,
                revision: 0,
                items: HashMap::new(),
                operations: HashMap::new(),
                failure: None,
            },
        );
        Ok(())
    }

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
                Ok(ReplicaPersistenceResponse::Loaded {
                    snapshot: self.snapshot(&account_id),
                })
            }
            ReplicaPersistenceRequest::Commit { plan } => {
                Ok(ReplicaPersistenceResponse::Committed {
                    result: self.execute(plan)?,
                })
            }
        }
    }
}

impl AccountReplica {
    fn from_snapshot(snapshot: ReplicaSnapshot) -> Self {
        Self {
            account_id: snapshot.account_id,
            incarnation: snapshot.incarnation,
            revision: snapshot.revision,
            items: snapshot
                .items
                .into_iter()
                .map(|item| (item.item_id.clone(), item))
                .collect(),
            operations: snapshot
                .operations
                .into_iter()
                .map(|operation| (operation.operation_id.clone(), operation))
                .collect(),
            failure: snapshot.failure,
        }
    }

    fn apply(&mut self, mutation: PlanMutation) -> Result<(), RuntimeError> {
        match mutation {
            PlanMutation::PutOptimisticItem(item) => {
                self.check_item_scope(&item)?;
                self.items.insert(item.item_id.clone(), item);
            }
            PlanMutation::AcceptOperation(operation) => {
                if self.operations.contains_key(&operation.operation_id) {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::InvariantViolation,
                        "operation identity was reused",
                    ));
                }
                self.operations
                    .insert(operation.operation_id.clone(), operation);
            }
            PlanMutation::RemoveOperation { operation_id } => {
                if self.operations.remove(&operation_id).is_none() {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::InvariantViolation,
                        "cannot remove an unknown operation",
                    ));
                }
            }
        }
        Ok(())
    }

    fn check_item_scope(&self, item: &ReplicaItemRecord) -> Result<(), RuntimeError> {
        if item.account_id == self.account_id {
            Ok(())
        } else {
            Err(RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "item Account scope does not match the guarded plan",
            ))
        }
    }

    fn snapshot(&self) -> ReplicaSnapshot {
        let mut items: Vec<_> = self.items.values().cloned().collect();
        items.sort_by(|a, b| a.item_id.cmp(&b.item_id));
        let mut operations: Vec<_> = self.operations.values().cloned().collect();
        operations.sort_by(|a, b| a.operation_id.cmp(&b.operation_id));
        ReplicaSnapshot {
            account_id: self.account_id.clone(),
            incarnation: self.incarnation.clone(),
            revision: self.revision,
            items,
            operations,
            failure: self.failure,
        }
    }
}

#[cfg(test)]
mod persistence_contract_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

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
        let request = ReplicaPersistenceRequest::Commit {
            plan: GuardedCommitPlan::new(
                AccountId::from("account-1"),
                Incarnation::from("incarnation-1"),
                41,
                vec![PlanMutation::RemoveOperation {
                    operation_id: "operation-1".into(),
                }],
            ),
        };

        assert_eq!(
            serde_json::to_value(request).unwrap(),
            serde_json::json!({
                "type": "commit",
                "plan": {
                    "accountId": "account-1",
                    "expectedIncarnation": "incarnation-1",
                    "expectedReplicaRevision": "41",
                    "mutations": [{
                        "type": "removeOperation",
                        "operationId": "operation-1"
                    }]
                }
            })
        );
        assert_eq!(
            serde_json::to_value(ReplicaPersistenceResponse::Loaded { snapshot: None }).unwrap(),
            serde_json::json!({ "type": "loaded", "snapshot": null })
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
                "type": "committed",
                "result": { "type": "missing" },
                "unexpected": true
            }))
            .is_err()
        );
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
    async fn serialized_executor_satisfies_the_same_guarded_plan_contract() {
        let executor = Arc::new(SerializedFakeExecutor::seeded());
        let persistence: Arc<dyn ReplicaPersistence> =
            Arc::new(SerializedReplicaPersistence::new(executor.clone()));
        assert_replica_conformance(&Replica::new(persistence)).await;
        assert_eq!(executor.commit_calls.load(Ordering::SeqCst), 2);
    }
}
