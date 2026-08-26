use super::domain::{
    apply_plan, AccountReplica, AttachmentMovePreparationRecord, AuthorityItemRecord,
    AuthorityVaultRecord, BootstrapAuthority, BootstrapGenerationId, BootstrapGenerationRecord,
    BootstrapPageReceipt, GuardedCommitPlan, ObservedOutcome, OperationReceiptRecord,
    OperationRecord, PlanMutation, PlanResult, ProtectedShareCapabilityRecord, ReplicaItemRecord,
    ReplicaSnapshot, ReplicaState, SyncCursor,
};
use crate::wire::decimal_u64;
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
    AttachmentMovePreparations,
    ShareCapabilities,
    OperationReceipts,
    ReplicaMetadata,
    BootstrapGenerations,
    BootstrapPages,
    AuthorityVaults,
    AuthorityItems,
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
    #[serde(default)]
    pub writes: Vec<PreparedReplicaWrite>,
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
    let writes = match current {
        Some(current) => bootstrap_clear_writes(&current.account_id, &current.bootstrap)?,
        None => Vec::new(),
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
        writes,
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

    let next = apply_plan(current.clone(), plan.clone())?;
    let mut writes = Vec::with_capacity(plan.mutations.len());
    for mutation in &plan.mutations {
        // A completion touches several stores at once, so it contributes several writes.
        if let PlanMutation::ReconcileAppliedCreate { outcome, .. }
        | PlanMutation::RetainRejection { outcome, .. } = mutation
        {
            writes.extend(completion_writes(
                &plan.account_id,
                &current,
                &next,
                outcome,
            )?);
            continue;
        }
        if matches!(mutation, PlanMutation::FailAccount { .. }) {
            // The failure lives in the head, and no row moves because of it.
            continue;
        }
        if matches!(mutation, PlanMutation::RemoveAllProtectedShareCapabilities) {
            writes.extend(current.share_capabilities.iter().map(|capability| {
                PreparedReplicaWrite::Delete {
                    store: ReplicaStore::ShareCapabilities,
                    key: ReplicaRowKey {
                        account_id: plan.account_id.clone(),
                        record_id: capability.operation_id.clone(),
                    },
                }
            }));
            continue;
        }
        if let PlanMutation::FreezeAttachmentMoveRejection { operation_id, .. }
        | PlanMutation::PromoteAttachmentMovePreparation { operation_id, .. } = mutation
        {
            writes.push(PreparedReplicaWrite::Delete {
                store: ReplicaStore::AttachmentMovePreparations,
                key: ReplicaRowKey {
                    account_id: plan.account_id.clone(),
                    record_id: operation_id.clone(),
                },
            });
            let operation = next
                .operations
                .iter()
                .find(|operation| operation.operation_id == *operation_id)
                .ok_or_else(|| replica_invariant("promoted Attachment Move disappeared"))?;
            writes.push(PreparedReplicaWrite::Put {
                row: stored_row(
                    ReplicaStore::Operations,
                    &plan.account_id,
                    operation_id,
                    operation,
                )?,
            });
            continue;
        }
        if let PlanMutation::ReactivateAttachmentMovePreparation { operation_id, .. } = mutation {
            writes.push(PreparedReplicaWrite::Delete {
                store: ReplicaStore::Operations,
                key: ReplicaRowKey {
                    account_id: plan.account_id.clone(),
                    record_id: operation_id.clone(),
                },
            });
            let preparation = next
                .attachment_move_preparations
                .iter()
                .find(|preparation| preparation.operation_id == *operation_id)
                .ok_or_else(|| replica_invariant("reactivated Attachment Move disappeared"))?;
            writes.push(PreparedReplicaWrite::Put {
                row: stored_row(
                    ReplicaStore::AttachmentMovePreparations,
                    &plan.account_id,
                    operation_id,
                    preparation,
                )?,
            });
            continue;
        }
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
            PlanMutation::PutProtectedShareCapability(capability) => PreparedReplicaWrite::Put {
                row: stored_row(
                    ReplicaStore::ShareCapabilities,
                    &capability.account_id,
                    &capability.operation_id,
                    capability,
                )?,
            },
            PlanMutation::RemoveAllProtectedShareCapabilities => {
                unreachable!("bulk Share capability deletion is collected above")
            }
            PlanMutation::AcceptAttachmentMovePreparation(preparation) => {
                let operation_id = &preparation.operation_id;
                let preparation = next
                    .attachment_move_preparations
                    .iter()
                    .find(|preparation| preparation.operation_id == *operation_id)
                    .ok_or_else(|| replica_invariant("prepared Attachment Move row disappeared"))?;
                PreparedReplicaWrite::Put {
                    row: stored_row(
                        ReplicaStore::AttachmentMovePreparations,
                        &plan.account_id,
                        operation_id,
                        preparation,
                    )?,
                }
            }
            PlanMutation::RescheduleAttachmentMovePreparation(preparation) => {
                PreparedReplicaWrite::Put {
                    row: stored_row(
                        ReplicaStore::AttachmentMovePreparations,
                        &plan.account_id,
                        &preparation.operation_id,
                        preparation,
                    )?,
                }
            }
            PlanMutation::CheckpointAttachmentMove { operation_id, .. }
            | PlanMutation::ResetAttachmentMoveUpload { operation_id, .. } => {
                let preparation = next
                    .attachment_move_preparations
                    .iter()
                    .find(|preparation| preparation.operation_id == *operation_id)
                    .ok_or_else(|| replica_invariant("prepared Attachment Move row disappeared"))?;
                PreparedReplicaWrite::Put {
                    row: stored_row(
                        ReplicaStore::AttachmentMovePreparations,
                        &plan.account_id,
                        operation_id,
                        preparation,
                    )?,
                }
            }
            PlanMutation::RescheduleOperation(operation) => {
                let synchronized = next
                    .operations
                    .iter()
                    .find(|candidate| candidate.operation_id == operation.operation_id)
                    .ok_or_else(|| replica_invariant("rescheduled Operation disappeared"))?;
                PreparedReplicaWrite::Put {
                    row: stored_row(
                        ReplicaStore::Operations,
                        &plan.account_id,
                        &operation.operation_id,
                        synchronized,
                    )?,
                }
            }
            PlanMutation::RemoveOperation { operation_id } => PreparedReplicaWrite::Delete {
                store: ReplicaStore::Operations,
                key: ReplicaRowKey {
                    account_id: plan.account_id.clone(),
                    record_id: operation_id.clone(),
                },
            },
            PlanMutation::ReconcileAppliedCreate { .. }
            | PlanMutation::RetainRejection { .. }
            | PlanMutation::FailAccount { .. }
            | PlanMutation::FreezeAttachmentMoveRejection { .. }
            | PlanMutation::PromoteAttachmentMovePreparation { .. }
            | PlanMutation::ReactivateAttachmentMovePreparation { .. } => {
                unreachable!("completion and failure writes are collected above")
            }
        });
    }
    // Authority and Cursor rows are a diff of what the model decided, so one completion stays
    // one `Commit` request: nothing about it can be applied by halves.
    writes.extend(bootstrap_write_diff(
        &current.account_id,
        &current.bootstrap,
        &next.bootstrap,
    )?);
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

/// Every row one completed Operation moves: its receipt appears, and both halves of the
/// accepted work that the model decided to drop disappear.
fn completion_writes(
    account_id: &AccountId,
    current: &ReplicaSnapshot,
    next: &ReplicaSnapshot,
    outcome: &ObservedOutcome,
) -> Result<Vec<PreparedReplicaWrite>, RuntimeError> {
    let receipt = next
        .receipts
        .iter()
        .find(|receipt| receipt.operation_id == outcome.operation_id)
        .ok_or_else(|| replica_invariant("a completed Operation kept no receipt"))?;
    let mut writes = vec![PreparedReplicaWrite::Put {
        row: stored_row(
            ReplicaStore::OperationReceipts,
            account_id,
            &receipt.operation_id,
            receipt,
        )?,
    }];
    for operation in &current.operations {
        if operation.operation_id == outcome.operation_id
            && !next
                .operations
                .iter()
                .any(|kept| kept.operation_id == operation.operation_id)
        {
            writes.push(PreparedReplicaWrite::Delete {
                store: ReplicaStore::Operations,
                key: ReplicaRowKey {
                    account_id: account_id.clone(),
                    record_id: operation.operation_id.clone(),
                },
            });
        }
    }
    for item in &current.items {
        if item.operation_id == outcome.operation_id
            && !next.items.iter().any(|kept| kept.item_id == item.item_id)
        {
            writes.push(PreparedReplicaWrite::Delete {
                store: ReplicaStore::OptimisticItems,
                key: ReplicaRowKey {
                    account_id: account_id.clone(),
                    record_id: item.item_id.clone(),
                },
            });
        }
    }
    Ok(writes)
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
    let mut rows = Vec::with_capacity(
        snapshot.items.len()
            + snapshot.operations.len()
            + snapshot.share_capabilities.len()
            + snapshot.attachment_move_preparations.len()
            + snapshot.receipts.len()
            + snapshot.bootstrap.row_count(),
    );
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
    for capability in snapshot.share_capabilities {
        rows.push(stored_row(
            ReplicaStore::ShareCapabilities,
            &snapshot.account_id,
            &capability.operation_id,
            &capability,
        )?);
    }
    for preparation in snapshot.attachment_move_preparations {
        rows.push(stored_row(
            ReplicaStore::AttachmentMovePreparations,
            &snapshot.account_id,
            &preparation.operation_id,
            &preparation,
        )?);
    }
    for receipt in snapshot.receipts {
        rows.push(stored_row(
            ReplicaStore::OperationReceipts,
            &snapshot.account_id,
            &receipt.operation_id,
            &receipt,
        )?);
    }
    rows.extend(bootstrap_rows(&snapshot.account_id, &snapshot.bootstrap)?);
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
    let mut share_capabilities = HashMap::new();
    let mut attachment_move_preparations = HashMap::new();
    let mut receipts = HashMap::new();
    let mut bootstrap = BootstrapAuthority::default();
    let mut saw_metadata = false;
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
            ReplicaStore::AttachmentMovePreparations => {
                let preparation: AttachmentMovePreparationRecord =
                    serde_json::from_str(&row.payload_json).map_err(|_| {
                        replica_invariant("Replica Attachment Move preparation payload is invalid")
                    })?;
                if preparation.account_id != head.account_id
                    || preparation.operation_id != row.key.record_id
                {
                    return Err(replica_invariant(
                        "Replica Attachment Move preparation key does not match its payload",
                    ));
                }
                if attachment_move_preparations
                    .insert(preparation.operation_id.clone(), preparation)
                    .is_some()
                {
                    return Err(replica_invariant(
                        "Replica Attachment Move preparation key is duplicated",
                    ));
                }
            }
            ReplicaStore::ShareCapabilities => {
                let capability: ProtectedShareCapabilityRecord =
                    serde_json::from_str(&row.payload_json).map_err(|_| {
                        replica_invariant("Replica protected Share capability payload is invalid")
                    })?;
                if capability.account_id != head.account_id
                    || capability.operation_id != row.key.record_id
                {
                    return Err(replica_invariant(
                        "Replica protected Share capability key does not match its payload",
                    ));
                }
                if share_capabilities
                    .insert(capability.operation_id.clone(), capability)
                    .is_some()
                {
                    return Err(replica_invariant(
                        "Replica protected Share capability key is duplicated",
                    ));
                }
            }
            ReplicaStore::OperationReceipts => {
                let receipt: OperationReceiptRecord = serde_json::from_str(&row.payload_json)
                    .map_err(|_| replica_invariant("Replica receipt row payload is invalid"))?;
                if receipt.operation_id != row.key.record_id {
                    return Err(replica_invariant(
                        "Replica receipt row key does not match its payload",
                    ));
                }
                if receipts
                    .insert(receipt.operation_id.clone(), receipt)
                    .is_some()
                {
                    return Err(replica_invariant("Replica receipt row key is duplicated"));
                }
            }
            ReplicaStore::ReplicaMetadata => {
                if row.key.record_id != BOOTSTRAP_METADATA_ID {
                    return Err(replica_invariant(
                        "Replica metadata row key is not the Bootstrap head",
                    ));
                }
                let metadata: BootstrapMetadataRecord = serde_json::from_str(&row.payload_json)
                    .map_err(|_| replica_invariant("Replica Bootstrap metadata is invalid"))?;
                if saw_metadata {
                    return Err(replica_invariant(
                        "Replica Bootstrap metadata is duplicated",
                    ));
                }
                saw_metadata = true;
                bootstrap.state = metadata.state;
                bootstrap.active_generation = metadata.active_generation;
                bootstrap.active_cursor = metadata.active_cursor;
                bootstrap.staging_generation = metadata.staging_generation;
            }
            ReplicaStore::BootstrapGenerations => {
                let generation: BootstrapGenerationRecord = serde_json::from_str(&row.payload_json)
                    .map_err(|_| {
                        replica_invariant("Replica Bootstrap generation payload is invalid")
                    })?;
                if generation.generation_id.0 != row.key.record_id {
                    return Err(replica_invariant(
                        "Replica Bootstrap generation key does not match its payload",
                    ));
                }
                if bootstrap
                    .generations
                    .insert(generation.generation_id.clone(), generation)
                    .is_some()
                {
                    return Err(replica_invariant(
                        "Replica Bootstrap generation key is duplicated",
                    ));
                }
            }
            ReplicaStore::BootstrapPages => {
                let receipt: BootstrapPageReceipt = serde_json::from_str(&row.payload_json)
                    .map_err(|_| replica_invariant("Replica Bootstrap page payload is invalid"))?;
                if composite_record_id(&receipt.generation_id.0, &receipt.page_identity.record_id())
                    != row.key.record_id
                {
                    return Err(replica_invariant(
                        "Replica Bootstrap page key does not match its payload",
                    ));
                }
                if bootstrap
                    .pages
                    .insert(
                        (receipt.generation_id.clone(), receipt.page_identity),
                        receipt,
                    )
                    .is_some()
                {
                    return Err(replica_invariant(
                        "Replica Bootstrap page key is duplicated",
                    ));
                }
            }
            ReplicaStore::AuthorityVaults => {
                let (generation_id, vault_id) = split_composite_record_id(&row.key.record_id)?;
                let vault: AuthorityVaultRecord = serde_json::from_str(&row.payload_json)
                    .map_err(|_| replica_invariant("Replica Vault payload is invalid"))?;
                if vault.id != vault_id {
                    return Err(replica_invariant(
                        "Replica Vault key does not match its payload",
                    ));
                }
                if bootstrap
                    .vaults
                    .insert(
                        (BootstrapGenerationId(generation_id), vault.id.clone()),
                        vault,
                    )
                    .is_some()
                {
                    return Err(replica_invariant("Replica Vault key is duplicated"));
                }
            }
            ReplicaStore::AuthorityItems => {
                let (generation_id, item_id) = split_composite_record_id(&row.key.record_id)?;
                let item: AuthorityItemRecord = serde_json::from_str(&row.payload_json)
                    .map_err(|_| replica_invariant("Replica Item payload is invalid"))?;
                if item.id != item_id {
                    return Err(replica_invariant(
                        "Replica Item key does not match its payload",
                    ));
                }
                if bootstrap
                    .items
                    .insert(
                        (BootstrapGenerationId(generation_id), item.id.clone()),
                        item,
                    )
                    .is_some()
                {
                    return Err(replica_invariant("Replica Item key is duplicated"));
                }
            }
        }
    }
    if !saw_metadata && bootstrap != BootstrapAuthority::default() {
        return Err(replica_invariant(
            "Replica Bootstrap rows exist without metadata",
        ));
    }
    bootstrap
        .validate()
        .map_err(|_| replica_invariant("Replica Bootstrap authority is inconsistent"))?;

    let account = AccountReplica {
        account_id: head.account_id,
        user_id: head.user_id,
        incarnation: head.incarnation,
        revision: head.replica_revision,
        lock_epoch: head.lock_epoch,
        items,
        operations,
        share_capabilities,
        attachment_move_preparations,
        receipts,
        failure: head.failure,
        bootstrap,
    };
    account.validate_durable_work()?;
    Ok(Some(account.snapshot()))
}

pub(super) fn replica_invariant(message: impl Into<String>) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::InvariantViolation, message)
}

const BOOTSTRAP_METADATA_ID: &str = "bootstrap";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BootstrapMetadataRecord {
    state: ReplicaState,
    #[serde(deserialize_with = "required_option::deserialize")]
    active_generation: Option<BootstrapGenerationId>,
    active_cursor: SyncCursor,
    #[serde(deserialize_with = "required_option::deserialize")]
    staging_generation: Option<BootstrapGenerationId>,
}

fn composite_record_id(left: &str, right: &str) -> String {
    format!("{left}/{right}")
}

fn split_composite_record_id(value: &str) -> Result<(String, String), RuntimeError> {
    let Some((left, right)) = value.split_once('/') else {
        return Err(replica_invariant("Replica composite row key is invalid"));
    };
    if left.is_empty() || right.is_empty() {
        return Err(replica_invariant("Replica composite row key is invalid"));
    }
    Ok((left.to_owned(), right.to_owned()))
}

fn bootstrap_rows(
    account_id: &crate::AccountId,
    bootstrap: &BootstrapAuthority,
) -> Result<Vec<StoredReplicaRow>, RuntimeError> {
    if bootstrap == &BootstrapAuthority::default() {
        return Ok(Vec::new());
    }
    let mut rows = Vec::with_capacity(bootstrap.row_count());
    rows.push(stored_row(
        ReplicaStore::ReplicaMetadata,
        account_id,
        BOOTSTRAP_METADATA_ID,
        &BootstrapMetadataRecord {
            state: bootstrap.state,
            active_generation: bootstrap.active_generation.clone(),
            active_cursor: bootstrap.active_cursor.clone(),
            staging_generation: bootstrap.staging_generation.clone(),
        },
    )?);
    for (generation_id, generation) in &bootstrap.generations {
        rows.push(stored_row(
            ReplicaStore::BootstrapGenerations,
            account_id,
            &generation_id.0,
            generation,
        )?);
    }
    for ((generation_id, page_identity), receipt) in &bootstrap.pages {
        rows.push(stored_row(
            ReplicaStore::BootstrapPages,
            account_id,
            &composite_record_id(&generation_id.0, &page_identity.record_id()),
            receipt,
        )?);
    }
    for ((generation_id, vault_id), vault) in &bootstrap.vaults {
        rows.push(stored_row(
            ReplicaStore::AuthorityVaults,
            account_id,
            &composite_record_id(&generation_id.0, vault_id),
            vault,
        )?);
    }
    for ((generation_id, item_id), item) in &bootstrap.items {
        rows.push(stored_row(
            ReplicaStore::AuthorityItems,
            account_id,
            &composite_record_id(&generation_id.0, item_id),
            item,
        )?);
    }
    Ok(rows)
}

fn bootstrap_clear_writes(
    account_id: &crate::AccountId,
    bootstrap: &BootstrapAuthority,
) -> Result<Vec<PreparedReplicaWrite>, RuntimeError> {
    Ok(bootstrap_rows(account_id, bootstrap)?
        .into_iter()
        .map(|row| PreparedReplicaWrite::Delete {
            store: row.store,
            key: row.key,
        })
        .collect())
}

pub(super) fn bootstrap_write_diff(
    account_id: &crate::AccountId,
    current: &BootstrapAuthority,
    next: &BootstrapAuthority,
) -> Result<Vec<PreparedReplicaWrite>, RuntimeError> {
    let current_rows = bootstrap_rows(account_id, current)?;
    let next_rows = bootstrap_rows(account_id, next)?;
    let mut writes = Vec::new();
    for row in &next_rows {
        let unchanged = current_rows.iter().any(|current_row| current_row == row);
        if !unchanged {
            writes.push(PreparedReplicaWrite::Put { row: row.clone() });
        }
    }
    for row in current_rows {
        if next_rows
            .iter()
            .all(|next_row| next_row.store != row.store || next_row.key != row.key)
        {
            writes.push(PreparedReplicaWrite::Delete {
                store: row.store,
                key: row.key,
            });
        }
    }
    Ok(writes)
}

#[allow(dead_code, reason = "orchestration prepares Bootstrap commits next")]
pub(super) fn prepare_bootstrap_commit(
    current: ReplicaSnapshot,
    next: ReplicaSnapshot,
    increment_revision: bool,
) -> Result<PreparedCommitOutcome, RuntimeError> {
    if current.account_id != next.account_id
        || current.user_id != next.user_id
        || current.incarnation != next.incarnation
        || current.lock_epoch != next.lock_epoch
        || current.items != next.items
        || current.operations != next.operations
        || current.receipts != next.receipts
        || current.failure != next.failure
    {
        return Err(replica_invariant(
            "Bootstrap commit cannot change non-authority Replica rows",
        ));
    }
    let expected_revision = if increment_revision {
        current
            .revision
            .checked_add(1)
            .ok_or_else(|| replica_invariant("Replica revision overflow"))?
    } else {
        current.revision
    };
    if next.revision != expected_revision {
        return Err(replica_invariant(
            "Bootstrap commit revision does not match the prepared transition",
        ));
    }
    let writes = bootstrap_write_diff(&current.account_id, &current.bootstrap, &next.bootstrap)?;
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
