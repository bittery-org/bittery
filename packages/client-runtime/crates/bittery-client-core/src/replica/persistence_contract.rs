use super::domain::{
    apply_plan, decimal_u64, AccountReplica, GuardedCommitPlan, OperationRecord, PlanMutation,
    PlanResult, ReplicaItemRecord, ReplicaSnapshot,
};
use crate::{protocol::Incarnation, AccountId, RuntimeError, RuntimeErrorCode};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

mod required_option {
    use serde::{Deserialize, Deserializer};

    pub fn deserialize<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
    where
        D: Deserializer<'de>,
        T: Deserialize<'de>,
    {
        Option::<T>::deserialize(deserializer)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "persistence-contract-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) enum ReplicaStore {
    OptimisticItems,
    Operations,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "persistence-contract-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReplicaRowKey {
    #[cfg_attr(feature = "persistence-contract-schema", schemars(with = "String"))]
    pub account_id: AccountId,
    pub record_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "persistence-contract-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StoredReplicaRow {
    pub store: ReplicaStore,
    pub key: ReplicaRowKey,
    pub payload_json: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "persistence-contract-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReplicaHead {
    #[cfg_attr(feature = "persistence-contract-schema", schemars(with = "String"))]
    pub account_id: AccountId,
    pub user_id: String,
    #[cfg_attr(feature = "persistence-contract-schema", schemars(with = "String"))]
    pub incarnation: Incarnation,
    #[serde(with = "decimal_u64")]
    #[cfg_attr(
        feature = "persistence-contract-schema",
        schemars(schema_with = "decimal_u64::json_schema")
    )]
    pub replica_revision: u64,
    #[serde(with = "decimal_u64")]
    #[cfg_attr(
        feature = "persistence-contract-schema",
        schemars(schema_with = "decimal_u64::json_schema")
    )]
    pub lock_epoch: u64,
    #[serde(deserialize_with = "required_option::deserialize")]
    pub failure: Option<RuntimeErrorCode>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "persistence-contract-schema", derive(schemars::JsonSchema))]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum ExpectedReplicaInstall {
    Missing {
        #[cfg_attr(feature = "persistence-contract-schema", schemars(with = "String"))]
        account_id: AccountId,
    },
    Present {
        #[cfg_attr(feature = "persistence-contract-schema", schemars(with = "String"))]
        account_id: AccountId,
        user_id: String,
        #[cfg_attr(feature = "persistence-contract-schema", schemars(with = "String"))]
        incarnation: Incarnation,
        #[serde(with = "decimal_u64")]
        #[cfg_attr(
            feature = "persistence-contract-schema",
            schemars(schema_with = "decimal_u64::json_schema")
        )]
        replica_revision: u64,
        #[serde(with = "decimal_u64")]
        #[cfg_attr(
            feature = "persistence-contract-schema",
            schemars(schema_with = "decimal_u64::json_schema")
        )]
        lock_epoch: u64,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "persistence-contract-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PreparedReplicaInstall {
    pub expected: ExpectedReplicaInstall,
    pub next_head: ReplicaHead,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "persistence-contract-schema", derive(schemars::JsonSchema))]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum ReplicaInstallResult {
    Applied,
    Stale,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "persistence-contract-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExpectedReplicaHead {
    #[cfg_attr(feature = "persistence-contract-schema", schemars(with = "String"))]
    pub account_id: AccountId,
    #[cfg_attr(feature = "persistence-contract-schema", schemars(with = "String"))]
    pub incarnation: Incarnation,
    pub user_id: String,
    #[serde(with = "decimal_u64")]
    #[cfg_attr(
        feature = "persistence-contract-schema",
        schemars(schema_with = "decimal_u64::json_schema")
    )]
    pub replica_revision: u64,
    #[serde(with = "decimal_u64")]
    #[cfg_attr(
        feature = "persistence-contract-schema",
        schemars(schema_with = "decimal_u64::json_schema")
    )]
    pub lock_epoch: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "persistence-contract-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PreparedLockEpochAdvance {
    pub expected: ExpectedReplicaHead,
    pub next_head: ReplicaHead,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "persistence-contract-schema", derive(schemars::JsonSchema))]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum LockEpochAdvanceResult {
    Applied {
        #[serde(with = "decimal_u64")]
        #[cfg_attr(
            feature = "persistence-contract-schema",
            schemars(schema_with = "decimal_u64::json_schema")
        )]
        lock_epoch: u64,
    },
    Stale,
    Missing,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "persistence-contract-schema", derive(schemars::JsonSchema))]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum PreparedReplicaWrite {
    Put {
        row: StoredReplicaRow,
    },
    Delete {
        store: ReplicaStore,
        key: ReplicaRowKey,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "persistence-contract-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PreparedReplicaCommit {
    pub expected: ExpectedReplicaHead,
    pub next_head: ReplicaHead,
    pub writes: Vec<PreparedReplicaWrite>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "persistence-contract-schema", derive(schemars::JsonSchema))]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum ReplicaPersistenceRequest {
    Load {
        #[cfg_attr(feature = "persistence-contract-schema", schemars(with = "String"))]
        account_id: AccountId,
    },
    Install {
        prepared: PreparedReplicaInstall,
    },
    Commit {
        prepared: PreparedReplicaCommit,
    },
    AdvanceLockEpoch {
        prepared: PreparedLockEpochAdvance,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "persistence-contract-schema", derive(schemars::JsonSchema))]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum ReplicaPersistenceResponse {
    Loaded {
        #[cfg_attr(
            feature = "persistence-contract-schema",
            schemars(with = "Option<ReplicaHead>")
        )]
        #[serde(deserialize_with = "required_option::deserialize")]
        head: Option<ReplicaHead>,
        rows: Vec<StoredReplicaRow>,
    },
    Installed {
        result: ReplicaInstallResult,
    },
    Committed {
        result: PlanResult,
    },
    LockEpochAdvanced {
        result: LockEpochAdvanceResult,
    },
}

#[cfg(feature = "persistence-contract-schema")]
#[derive(schemars::JsonSchema)]
#[allow(dead_code)]
struct ReplicaPersistenceContract {
    request: ReplicaPersistenceRequest,
    response: ReplicaPersistenceResponse,
}

#[cfg(feature = "persistence-contract-schema")]
#[doc(hidden)]
pub fn persistence_contract_schema() -> schemars::Schema {
    let mut settings = schemars::generate::SchemaSettings::draft2020_12();
    settings.contract = schemars::generate::Contract::Serialize;
    settings
        .into_generator()
        .into_root_schema_for::<ReplicaPersistenceContract>()
}

pub(super) struct PreparedCommitOutcome {
    pub(super) wire: PreparedReplicaCommit,
    pub(super) next_snapshot: ReplicaSnapshot,
}

pub(super) fn prepare_install(
    current: Option<&ReplicaSnapshot>,
    account_id: AccountId,
    user_id: String,
    incarnation: Incarnation,
) -> Result<PreparedReplicaInstall, RuntimeError> {
    let (expected, replica_revision) = match current {
        None => (
            ExpectedReplicaInstall::Missing {
                account_id: account_id.clone(),
            },
            0,
        ),
        Some(current) => {
            if current.account_id != account_id || current.user_id != user_id {
                return Err(replica_invariant(
                    "installed Account identity cannot change User",
                ));
            }
            let next_revision = current
                .revision
                .checked_add(1)
                .ok_or_else(|| replica_invariant("Replica revision overflow"))?;
            (
                ExpectedReplicaInstall::Present {
                    account_id: current.account_id.clone(),
                    user_id: current.user_id.clone(),
                    incarnation: current.incarnation.clone(),
                    replica_revision: current.revision,
                    lock_epoch: current.lock_epoch,
                },
                next_revision,
            )
        }
    };
    Ok(PreparedReplicaInstall {
        expected,
        next_head: ReplicaHead {
            account_id,
            user_id,
            incarnation,
            replica_revision,
            lock_epoch: 0,
            failure: None,
        },
    })
}

pub(super) fn prepare_commit(
    current: ReplicaSnapshot,
    plan: GuardedCommitPlan,
) -> Result<PreparedCommitOutcome, RuntimeError> {
    if current.account_id != plan.account_id
        || current.incarnation != plan.expected_incarnation
        || current.revision != plan.expected_replica_revision
        || current.lock_epoch != plan.expected_lock_epoch
    {
        return Err(replica_invariant(
            "cannot prepare a commit against a different Replica head",
        ));
    }

    let mut writes = Vec::with_capacity(plan.mutations.len());
    for mutation in &plan.mutations {
        writes.push(match mutation {
            PlanMutation::PutOptimisticItem(item) => PreparedReplicaWrite::Put {
                row: stored_row(
                    ReplicaStore::OptimisticItems,
                    &item.account_id,
                    &item.item_id,
                    item,
                )?,
            },
            PlanMutation::AcceptOperation(operation) => PreparedReplicaWrite::Put {
                row: stored_row(
                    ReplicaStore::Operations,
                    &plan.account_id,
                    &operation.operation_id,
                    operation,
                )?,
            },
            PlanMutation::RemoveOperation { operation_id } => PreparedReplicaWrite::Delete {
                store: ReplicaStore::Operations,
                key: ReplicaRowKey {
                    account_id: plan.account_id.clone(),
                    record_id: operation_id.clone(),
                },
            },
        });
    }
    let next = apply_plan(current.clone(), plan)?;
    Ok(PreparedCommitOutcome {
        wire: PreparedReplicaCommit {
            expected: ExpectedReplicaHead {
                account_id: current.account_id,
                incarnation: current.incarnation,
                user_id: current.user_id,
                replica_revision: current.revision,
                lock_epoch: current.lock_epoch,
            },
            next_head: ReplicaHead {
                account_id: next.account_id.clone(),
                user_id: next.user_id.clone(),
                incarnation: next.incarnation.clone(),
                replica_revision: next.revision,
                lock_epoch: next.lock_epoch,
                failure: next.failure,
            },
            writes,
        },
        next_snapshot: next,
    })
}

fn stored_row<T: Serialize>(
    store: ReplicaStore,
    account_id: &AccountId,
    record_id: &str,
    payload: &T,
) -> Result<StoredReplicaRow, RuntimeError> {
    Ok(StoredReplicaRow {
        store,
        key: ReplicaRowKey {
            account_id: account_id.clone(),
            record_id: record_id.to_owned(),
        },
        payload_json: serde_json::to_string(payload)
            .map_err(|_| replica_invariant("Replica row payload could not be serialized"))?,
    })
}

pub(super) fn snapshot_rows(
    snapshot: ReplicaSnapshot,
) -> Result<Vec<StoredReplicaRow>, RuntimeError> {
    let mut rows = Vec::with_capacity(snapshot.items.len() + snapshot.operations.len());
    for item in snapshot.items {
        rows.push(stored_row(
            ReplicaStore::OptimisticItems,
            &snapshot.account_id,
            &item.item_id,
            &item,
        )?);
    }
    for operation in snapshot.operations {
        rows.push(stored_row(
            ReplicaStore::Operations,
            &snapshot.account_id,
            &operation.operation_id,
            &operation,
        )?);
    }
    Ok(rows)
}

pub(super) fn apply_prepared_writes_to_rows(
    mut rows: Vec<StoredReplicaRow>,
    writes: &[PreparedReplicaWrite],
) -> Vec<StoredReplicaRow> {
    for write in writes {
        let (store, key) = match write {
            PreparedReplicaWrite::Put { row } => (row.store, &row.key),
            PreparedReplicaWrite::Delete { store, key } => (*store, key),
        };
        rows.retain(|row| row.store != store || row.key != *key);
        if let PreparedReplicaWrite::Put { row } = write {
            rows.push(row.clone());
        }
    }
    rows
}

pub(super) fn reconstruct_snapshot(
    requested_account_id: &AccountId,
    head: Option<ReplicaHead>,
    rows: Vec<StoredReplicaRow>,
) -> Result<Option<ReplicaSnapshot>, RuntimeError> {
    let Some(head) = head else {
        if rows.is_empty() {
            return Ok(None);
        }
        return Err(replica_invariant("Replica rows exist without a head"));
    };
    if head.account_id != *requested_account_id {
        return Err(replica_invariant(
            "Replica persistence returned another Account's head",
        ));
    }
    if head.user_id.is_empty() {
        return Err(replica_invariant("Replica head User identity is empty"));
    }

    let mut items = HashMap::new();
    let mut operations = HashMap::new();
    for row in rows {
        if row.key.account_id != head.account_id {
            return Err(replica_invariant(
                "Replica row Account does not match its head",
            ));
        }
        match row.store {
            ReplicaStore::OptimisticItems => {
                let item: ReplicaItemRecord = serde_json::from_str(&row.payload_json)
                    .map_err(|_| replica_invariant("Replica item row payload is invalid"))?;
                if item.account_id != head.account_id || item.item_id != row.key.record_id {
                    return Err(replica_invariant(
                        "Replica item row key does not match its payload",
                    ));
                }
                if items.insert(item.item_id.clone(), item).is_some() {
                    return Err(replica_invariant("Replica item row key is duplicated"));
                }
            }
            ReplicaStore::Operations => {
                let operation: OperationRecord = serde_json::from_str(&row.payload_json)
                    .map_err(|_| replica_invariant("Replica operation row payload is invalid"))?;
                if operation.operation_id != row.key.record_id {
                    return Err(replica_invariant(
                        "Replica operation row key does not match its payload",
                    ));
                }
                if operations
                    .insert(operation.operation_id.clone(), operation)
                    .is_some()
                {
                    return Err(replica_invariant("Replica operation row key is duplicated"));
                }
            }
        }
    }

    Ok(Some(
        AccountReplica {
            account_id: head.account_id,
            user_id: head.user_id,
            incarnation: head.incarnation,
            revision: head.replica_revision,
            lock_epoch: head.lock_epoch,
            items,
            operations,
            failure: head.failure,
        }
        .snapshot(),
    ))
}

pub(super) fn replica_invariant(message: impl Into<String>) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::InvariantViolation, message)
}
