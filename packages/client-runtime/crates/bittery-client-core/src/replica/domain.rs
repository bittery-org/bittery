use crate::{protocol::Incarnation, AccountId, RuntimeError, RuntimeErrorCode};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub(super) mod decimal_u64 {
    use serde::{Deserialize, Deserializer, Serializer};

    #[cfg(feature = "persistence-contract-schema")]
    pub fn json_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
        schemars::json_schema!({
            "type": "string",
            "pattern": canonical_pattern()
        })
    }

    #[cfg(feature = "persistence-contract-schema")]
    fn canonical_pattern() -> String {
        let maximum = u64::MAX.to_string();
        let mut maximum_length_alternatives = Vec::new();
        for (index, digit) in maximum.bytes().enumerate() {
            let lower = if index == 0 { b'1' } else { b'0' };
            if digit <= lower {
                continue;
            }
            let prefix = &maximum[..index];
            let upper = digit - 1;
            let range = if lower == upper {
                char::from(lower).to_string()
            } else {
                format!("[{}-{}]", char::from(lower), char::from(upper))
            };
            let remaining = maximum.len() - index - 1;
            maximum_length_alternatives.push(format!("{prefix}{range}[0-9]{{{remaining}}}"));
        }
        maximum_length_alternatives.push(maximum.clone());
        format!(
            "^(?:0|[1-9][0-9]{{0,{}}}|(?:{}))$",
            maximum.len() - 2,
            maximum_length_alternatives.join("|")
        )
    }

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
#[cfg_attr(feature = "persistence-contract-schema", derive(schemars::JsonSchema))]
pub(crate) enum PlanResult {
    Applied {
        #[serde(with = "decimal_u64")]
        #[cfg_attr(
            feature = "persistence-contract-schema",
            schemars(schema_with = "decimal_u64::json_schema")
        )]
        replica_revision: u64,
    },
    Stale {
        #[serde(with = "decimal_u64")]
        #[cfg_attr(
            feature = "persistence-contract-schema",
            schemars(schema_with = "decimal_u64::json_schema")
        )]
        actual_revision: u64,
    },
    Missing,
}

pub(crate) enum RecomputedPlanResult {
    Applied { replica_revision: u64 },
    Missing,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReplicaSnapshot {
    pub account_id: AccountId,
    pub user_id: String,
    pub incarnation: Incarnation,
    #[serde(with = "decimal_u64")]
    pub revision: u64,
    pub items: Vec<ReplicaItemRecord>,
    pub operations: Vec<OperationRecord>,
    pub failure: Option<RuntimeErrorCode>,
}

pub(super) fn apply_plan(
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
pub(super) struct AccountReplica {
    pub(super) account_id: AccountId,
    pub(super) user_id: String,
    pub(super) incarnation: Incarnation,
    pub(super) revision: u64,
    pub(super) items: HashMap<String, ReplicaItemRecord>,
    pub(super) operations: HashMap<String, OperationRecord>,
    pub(super) failure: Option<RuntimeErrorCode>,
}

impl AccountReplica {
    pub(super) fn from_snapshot(snapshot: ReplicaSnapshot) -> Self {
        Self {
            account_id: snapshot.account_id,
            user_id: snapshot.user_id,
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

    pub(super) fn snapshot(&self) -> ReplicaSnapshot {
        let mut items: Vec<_> = self.items.values().cloned().collect();
        items.sort_by(|a, b| a.item_id.cmp(&b.item_id));
        let mut operations: Vec<_> = self.operations.values().cloned().collect();
        operations.sort_by(|a, b| a.operation_id.cmp(&b.operation_id));
        ReplicaSnapshot {
            account_id: self.account_id.clone(),
            user_id: self.user_id.clone(),
            incarnation: self.incarnation.clone(),
            revision: self.revision,
            items,
            operations,
            failure: self.failure,
        }
    }
}
