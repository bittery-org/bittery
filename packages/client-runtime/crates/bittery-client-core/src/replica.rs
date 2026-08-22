use crate::{protocol::Incarnation, AccountId, RuntimeError, RuntimeErrorCode};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::Mutex};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GuardedCommitPlan {
    pub account_id: AccountId,
    pub expected_incarnation: Incarnation,
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
    rename_all_fields = "camelCase"
)]
pub(crate) enum PlanMutation {
    PutOptimisticItem(ReplicaItemRecord),
    AcceptOperation(OperationRecord),
    RemoveOperation { operation_id: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OperationRecord {
    pub operation_id: String,
    pub item_id: String,
    pub request_bytes: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReplicaItemRecord {
    pub account_id: AccountId,
    pub item_id: String,
    pub vault_id: String,
    pub ciphertext: Vec<u8>,
    pub optimistic: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum PlanResult {
    Applied { replica_revision: u64 },
    Stale { actual_revision: u64 },
    Missing,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ReplicaSnapshot {
    pub account_id: AccountId,
    pub incarnation: Incarnation,
    pub revision: u64,
    pub items: Vec<ReplicaItemRecord>,
    pub operations: Vec<OperationRecord>,
    pub failure: Option<RuntimeErrorCode>,
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

        let mut next = current.clone();
        for mutation in plan.mutations {
            next.apply(mutation)?;
        }
        next.revision += 1;
        let revision = next.revision;
        accounts.insert(plan.account_id, next);
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

    pub(crate) fn snapshots(&self) -> Vec<ReplicaSnapshot> {
        let mut values: Vec<_> = self
            .accounts
            .lock()
            .expect("replica lock poisoned")
            .values()
            .map(AccountReplica::snapshot)
            .collect();
        values.sort_by(|a, b| a.account_id.as_str().cmp(b.account_id.as_str()));
        values
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

impl AccountReplica {
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
