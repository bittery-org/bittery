//! Rust-owned persistence histories shared by every Replica adapter.
//!
//! Expectations do not come from an adapter. Existing Domain logic first establishes the expected
//! logical `ReplicaSnapshot`; the existing closed persistence serializer then produces its literal
//! rows. The corpus declares the response implied by that Domain result. Adapters only consume the
//! resulting requests and checkpoints, so neither reference adapter can certify itself.

use super::{
    attachment_move_artifact_ref, attachment_move_intent_fingerprint,
    domain::AccountReplica,
    persistence_contract::{
        apply_prepared_writes_to_rows, prepare_bootstrap_commit, prepare_commit, prepare_install,
        reconstruct_snapshot, snapshot_rows, ExpectedReplicaHead, LockEpochAdvanceResult,
        PreparedLockEpochAdvance, ReplicaHead, ReplicaInstallResult, ReplicaPersistenceRequest,
        ReplicaPersistenceResponse, ReplicaStore, StoredReplicaRow,
    },
    AttachmentMovePreparationRecord, AttachmentMoveProgress, AttachmentMoveUploadState,
    AuthorityAttachmentRecord, AuthorityItemCategory, AuthorityItemRecord, AuthorityVaultRecord,
    AuthorityVaultRole, AuthorityVaultType, BeginBootstrapPlan, BootstrapContinuation,
    BootstrapGenerationId, BootstrapGuard, BootstrapPageCursor, BootstrapPageIdentity,
    CursorAdvance, GuardedCommitPlan, ImmutableHttpRequest, ObservedOutcome, OperationKind,
    OperationOutcomeResult, OperationRecord, OperationRejectionCode, OperationSchedulingState,
    PlanMutation, PlanResult, PreparedMoveAttachment, PromoteBootstrapPlan, ReplicaItemRecord,
    ReplicaSnapshot, Sha256Fingerprint, StageBootstrapPagePlan, SyncCursor,
};
use crate::{
    http_transport::{HttpHeader, HttpMethod},
    protocol::Incarnation,
    AccountId, RuntimeError, RuntimeErrorCode,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[cfg(test)]
use super::{BootstrapAuthority, InMemoryReplica, ReplicaPersistence, SqliteReplica};
#[cfg(test)]
use std::sync::Arc;

const FORMAT_VERSION: u32 = 1;
const KNOWN_PLAINTEXT_MARKER: &str = "KNOWN-PLAINTEXT-LOGIN-PASSWORD-DO-NOT-PERSIST";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Corpus {
    format_version: u32,
    oracle: String,
    plaintext_causality: String,
    forbidden_durable_row_markers: Vec<String>,
    histories: Vec<History>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct History {
    name: String,
    coverage: Vec<String>,
    steps: Vec<Step>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Step {
    label: String,
    request: ReplicaPersistenceRequest,
    expected_response: ReplicaPersistenceResponse,
    expected_loaded_state: Vec<LoadedState>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LoadedState {
    account_id: AccountId,
    response: ReplicaPersistenceResponse,
}

struct HistoryBuilder {
    name: String,
    coverage: Vec<String>,
    watched_accounts: Vec<AccountId>,
    snapshots: BTreeMap<String, ReplicaSnapshot>,
    steps: Vec<Step>,
}

impl HistoryBuilder {
    fn new(name: &str, coverage: &[&str], watched_accounts: &[&str]) -> Self {
        Self {
            name: name.to_owned(),
            coverage: coverage.iter().map(|value| (*value).to_owned()).collect(),
            watched_accounts: watched_accounts
                .iter()
                .map(|account_id| AccountId::from(*account_id))
                .collect(),
            snapshots: BTreeMap::new(),
            steps: Vec::new(),
        }
    }

    fn finish(self) -> History {
        History {
            name: self.name,
            coverage: self.coverage,
            steps: self.steps,
        }
    }

    fn snapshot(&self, account_id: &str) -> Option<&ReplicaSnapshot> {
        self.snapshots.get(account_id)
    }

    fn insert_snapshot(&mut self, snapshot: ReplicaSnapshot) {
        self.snapshots
            .insert(snapshot.account_id.as_str().to_owned(), snapshot);
    }

    fn expected_loaded_state(&self) -> Result<Vec<LoadedState>, RuntimeError> {
        self.watched_accounts
            .iter()
            .map(|account_id| {
                Ok(LoadedState {
                    account_id: account_id.clone(),
                    response: loaded_response(self.snapshots.get(account_id.as_str()).cloned())?,
                })
            })
            .collect()
    }

    fn push(
        &mut self,
        label: &str,
        request: ReplicaPersistenceRequest,
        expected_response: ReplicaPersistenceResponse,
    ) -> Result<(), RuntimeError> {
        self.steps.push(Step {
            label: label.to_owned(),
            request,
            expected_response: normalize_response(expected_response),
            expected_loaded_state: self.expected_loaded_state()?,
        });
        Ok(())
    }

    fn load(&mut self, label: &str, account_id: &str) -> Result<(), RuntimeError> {
        let account_id = AccountId::from(account_id);
        self.push(
            label,
            ReplicaPersistenceRequest::Load {
                account_id: account_id.clone(),
            },
            loaded_response(self.snapshots.get(account_id.as_str()).cloned())?,
        )
    }

    fn install(
        &mut self,
        label: &str,
        account_id: &str,
        incarnation_suffix: &str,
    ) -> Result<ReplicaPersistenceRequest, RuntimeError> {
        let account = AccountId::from(account_id);
        let current = self.snapshot(account_id).cloned();
        let prepared = prepare_install(
            current.as_ref(),
            account.clone(),
            format!("user-{account_id}"),
            incarnation(account_id, incarnation_suffix),
        )?;
        let current_rows = current
            .clone()
            .map(snapshot_rows)
            .transpose()?
            .unwrap_or_default();
        let next_rows = apply_prepared_writes_to_rows(current_rows, &prepared.writes);
        let next = reconstruct_snapshot(&account, Some(prepared.next_head.clone()), next_rows)?
            .ok_or_else(|| oracle_error("install oracle produced no snapshot"))?;
        let request = ReplicaPersistenceRequest::Install { prepared };
        self.insert_snapshot(next);
        self.push(
            label,
            request.clone(),
            ReplicaPersistenceResponse::Installed {
                result: ReplicaInstallResult::Applied,
            },
        )?;
        Ok(request)
    }

    fn commit_plan(
        &mut self,
        label: &str,
        plan: GuardedCommitPlan,
    ) -> Result<ReplicaPersistenceRequest, RuntimeError> {
        let current = self
            .snapshot(plan.account_id.as_str())
            .cloned()
            .ok_or_else(|| oracle_error("commit oracle Account is missing"))?;
        let prepared = prepare_commit(current, plan)?;
        let revision = prepared.next_snapshot.revision;
        let request = ReplicaPersistenceRequest::Commit {
            prepared: prepared.wire,
        };
        self.insert_snapshot(prepared.next_snapshot);
        self.push(
            label,
            request.clone(),
            ReplicaPersistenceResponse::Committed {
                result: PlanResult::Applied {
                    replica_revision: revision,
                },
            },
        )?;
        Ok(request)
    }

    fn begin_bootstrap(
        &mut self,
        label: &str,
        plan: BeginBootstrapPlan,
    ) -> Result<(), RuntimeError> {
        let account_id = plan.guard.account_id.as_str().to_owned();
        let current = self
            .snapshot(&account_id)
            .cloned()
            .ok_or_else(|| oracle_error("Bootstrap oracle Account is missing"))?;
        let mut oracle = AccountReplica::from_snapshot(current.clone());
        let result = oracle.begin_bootstrap(plan)?;
        let PlanResult::Applied { replica_revision } = result else {
            return Err(oracle_error("begin Bootstrap oracle was not applied"));
        };
        let prepared = prepare_bootstrap_commit(current, oracle.snapshot(), true)?;
        let request = ReplicaPersistenceRequest::Commit {
            prepared: prepared.wire,
        };
        self.insert_snapshot(prepared.next_snapshot);
        self.push(
            label,
            request,
            ReplicaPersistenceResponse::Committed {
                result: PlanResult::Applied { replica_revision },
            },
        )
    }

    fn stage_bootstrap(
        &mut self,
        label: &str,
        plan: StageBootstrapPagePlan,
    ) -> Result<ReplicaPersistenceRequest, RuntimeError> {
        let account_id = plan.guard.account_id.as_str().to_owned();
        let current = self
            .snapshot(&account_id)
            .cloned()
            .ok_or_else(|| oracle_error("Bootstrap page oracle Account is missing"))?;
        let mut oracle = AccountReplica::from_snapshot(current.clone());
        let result = oracle.stage_bootstrap_page(plan)?;
        if result != super::StageBootstrapPageResult::Applied {
            return Err(oracle_error("Bootstrap page oracle was not applied"));
        }
        let prepared = prepare_bootstrap_commit(current, oracle.snapshot(), false)?;
        let revision = prepared.next_snapshot.revision;
        let request = ReplicaPersistenceRequest::Commit {
            prepared: prepared.wire,
        };
        self.insert_snapshot(prepared.next_snapshot);
        self.push(
            label,
            request.clone(),
            ReplicaPersistenceResponse::Committed {
                result: PlanResult::Applied {
                    replica_revision: revision,
                },
            },
        )?;
        Ok(request)
    }

    fn promote_bootstrap(
        &mut self,
        label: &str,
        plan: PromoteBootstrapPlan,
    ) -> Result<(), RuntimeError> {
        let account_id = plan.guard.account_id.as_str().to_owned();
        let current = self
            .snapshot(&account_id)
            .cloned()
            .ok_or_else(|| oracle_error("Bootstrap promotion oracle Account is missing"))?;
        let mut oracle = AccountReplica::from_snapshot(current.clone());
        let result = oracle.promote_bootstrap(plan)?;
        let PlanResult::Applied { replica_revision } = result else {
            return Err(oracle_error("Bootstrap promotion oracle was not applied"));
        };
        let prepared = prepare_bootstrap_commit(current, oracle.snapshot(), true)?;
        let request = ReplicaPersistenceRequest::Commit {
            prepared: prepared.wire,
        };
        self.insert_snapshot(prepared.next_snapshot);
        self.push(
            label,
            request,
            ReplicaPersistenceResponse::Committed {
                result: PlanResult::Applied { replica_revision },
            },
        )
    }

    fn replay(
        &mut self,
        label: &str,
        request: ReplicaPersistenceRequest,
        expected_response: ReplicaPersistenceResponse,
    ) -> Result<(), RuntimeError> {
        self.push(label, request, expected_response)
    }

    fn advance_lock_epoch(&mut self, label: &str, account_id: &str) -> Result<(), RuntimeError> {
        let current = self
            .snapshot(account_id)
            .cloned()
            .ok_or_else(|| oracle_error("lock oracle Account is missing"))?;
        let next_epoch = current
            .lock_epoch
            .checked_add(1)
            .ok_or_else(|| oracle_error("lock oracle epoch overflowed"))?;
        let prepared = PreparedLockEpochAdvance {
            expected: ExpectedReplicaHead {
                account_id: current.account_id.clone(),
                incarnation: current.incarnation.clone(),
                user_id: current.user_id.clone(),
                replica_revision: current.revision,
                lock_epoch: current.lock_epoch,
            },
            next_head: ReplicaHead {
                account_id: current.account_id.clone(),
                user_id: current.user_id.clone(),
                incarnation: current.incarnation.clone(),
                replica_revision: current.revision,
                lock_epoch: next_epoch,
                failure: current.failure,
            },
        };
        let mut next = current;
        next.lock_epoch = next_epoch;
        self.insert_snapshot(next);
        self.push(
            label,
            ReplicaPersistenceRequest::AdvanceLockEpoch { prepared },
            ReplicaPersistenceResponse::LockEpochAdvanced {
                result: LockEpochAdvanceResult::Applied {
                    lock_epoch: next_epoch,
                },
            },
        )
    }
}

fn loaded_response(
    snapshot: Option<ReplicaSnapshot>,
) -> Result<ReplicaPersistenceResponse, RuntimeError> {
    let Some(snapshot) = snapshot else {
        return Ok(ReplicaPersistenceResponse::Loaded {
            head: None,
            rows: Vec::new(),
        });
    };
    let head = ReplicaHead {
        account_id: snapshot.account_id.clone(),
        user_id: snapshot.user_id.clone(),
        incarnation: snapshot.incarnation.clone(),
        replica_revision: snapshot.revision,
        lock_epoch: snapshot.lock_epoch,
        failure: snapshot.failure,
    };
    Ok(normalize_response(ReplicaPersistenceResponse::Loaded {
        head: Some(head),
        rows: snapshot_rows(snapshot)?,
    }))
}

fn normalize_response(response: ReplicaPersistenceResponse) -> ReplicaPersistenceResponse {
    match response {
        ReplicaPersistenceResponse::Loaded { head, mut rows } => {
            rows.sort_by(|left, right| row_key(left).cmp(&row_key(right)));
            ReplicaPersistenceResponse::Loaded { head, rows }
        }
        other => other,
    }
}

fn row_key(row: &StoredReplicaRow) -> (u8, &str, &str) {
    let store = match row.store {
        ReplicaStore::OptimisticItems => 0,
        ReplicaStore::Operations => 1,
        ReplicaStore::OperationReceipts => 2,
        ReplicaStore::ReplicaMetadata => 3,
        ReplicaStore::BootstrapGenerations => 4,
        ReplicaStore::BootstrapPages => 5,
        ReplicaStore::AuthorityVaults => 6,
        ReplicaStore::AuthorityItems => 7,
        ReplicaStore::AttachmentMovePreparations => 8,
    };
    (store, row.key.account_id.as_str(), &row.key.record_id)
}

fn oracle_error(message: &str) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::InvariantViolation, message)
}

fn incarnation(account_id: &str, suffix: &str) -> Incarnation {
    Incarnation::from(format!("incarnation-{account_id}-{suffix}"))
}

fn operation(operation_id: &str, item_id: &str) -> OperationRecord {
    let body =
        format!(r#"{{"itemId":"{item_id}","encryptedData":"opaque-ciphertext"}}"#).into_bytes();
    OperationRecord {
        operation_id: operation_id.to_owned(),
        kind: OperationKind::CreateItem,
        item_id: item_id.to_owned(),
        vault_id: "vault-1".to_owned(),
        request: ImmutableHttpRequest {
            method: HttpMethod::Put,
            path: format!("/api/v1/vaults/vault-1/items/{item_id}"),
            headers: vec![HttpHeader {
                name: "Content-Type".to_owned(),
                value: "application/json".to_owned(),
            }],
            body: body.clone(),
        },
        request_fingerprint: Sha256Fingerprint::of_bytes(&body),
        attachment_move_recovery: None,
        scheduling: OperationSchedulingState::default(),
    }
}

fn overlay(account_id: &str, operation_id: &str, item_id: &str) -> ReplicaItemRecord {
    ReplicaItemRecord {
        account_id: AccountId::from(account_id),
        item_id: item_id.to_owned(),
        vault_id: "vault-1".to_owned(),
        operation_id: operation_id.to_owned(),
        category: AuthorityItemCategory::Login,
        encrypted_data: format!("opaque-sealed-{item_id}"),
        encryption_iv: "AAAAAAAAAAAAAAAA".to_owned(),
        encryption_algorithm: "AES-GCM-AAD-V1".to_owned(),
        encryption_version: 1,
        encrypted_by_user_id: format!("user-{account_id}"),
        favorite: false,
        version: 1,
        created_at: "2026-08-24T00:00:00Z".to_owned(),
        updated_at: "2026-08-24T00:00:00Z".to_owned(),
        deleted_at: None,
        attachments: Vec::new(),
        permanently_deleted: false,
    }
}

fn vault(account_id: &str) -> AuthorityVaultRecord {
    AuthorityVaultRecord {
        id: "vault-1".to_owned(),
        name: "Personal".to_owned(),
        vault_type: AuthorityVaultType::Personal,
        icon: None,
        image_url: None,
        encrypted_vault_key: format!("opaque-wrapped-vault-key-{account_id}"),
        role: AuthorityVaultRole::Owner,
    }
}

fn authority_item(account_id: &str, item_id: &str, version: i32) -> AuthorityItemRecord {
    AuthorityItemRecord {
        id: item_id.to_owned(),
        vault_id: "vault-1".to_owned(),
        category: AuthorityItemCategory::Login,
        favorite: false,
        encrypted_data: format!("authoritative-opaque-ciphertext-{item_id}"),
        encryption_iv: "BBBBBBBBBBBBBBBB".to_owned(),
        encryption_algorithm: "AES-GCM-AAD-V1".to_owned(),
        version,
        encryption_version: 1,
        encrypted_by_user_id: format!("user-{account_id}"),
        last_modified_by: format!("user-{account_id}"),
        created_at: "2026-08-24T00:00:00Z".to_owned(),
        updated_at: "2026-08-24T00:01:00Z".to_owned(),
        deleted_at: None,
        attachments: (item_id == "existing-item")
            .then(|| authority_attachment(account_id, item_id))
            .into_iter()
            .collect(),
    }
}

fn authority_attachment(account_id: &str, item_id: &str) -> AuthorityAttachmentRecord {
    AuthorityAttachmentRecord {
        id: "attachment-1".into(),
        item_id: item_id.into(),
        vault_id: "vault-1".into(),
        storage_key: "opaque/source/storage-key".into(),
        encrypted_name: "opaque-source-name".into(),
        encryption_iv: "source-name-iv".into(),
        encryption_algorithm: "AES-GCM-AAD-V1".into(),
        encrypted_attachment_key: "opaque-source-wrapped-key".into(),
        attachment_key_iv: "source-key-iv".into(),
        attachment_key_algorithm: "AES-GCM-AAD-V1".into(),
        encrypted_content_type: "opaque-source-content-type".into(),
        encrypted_content_type_iv: "source-content-type-iv".into(),
        envelope_version: 1,
        file_size: 42,
        uploaded_by: format!("user-{account_id}"),
        created_at: "2026-08-24T00:00:00Z".into(),
    }
}

fn attachment_move_preparation() -> AttachmentMovePreparationRecord {
    let mut preparation = AttachmentMovePreparationRecord {
        account_id: AccountId::from("account-operations"),
        operation_id: "operation-attachment-move".into(),
        item_id: "existing-item".into(),
        source_vault_id: "vault-1".into(),
        target_vault_id: "vault-2".into(),
        expected_item_version: 1,
        target_encrypted_data: "opaque-target-item".into(),
        target_encryption_algorithm: "AES-GCM-AAD-V1".into(),
        target_encryption_iv: "target-item-iv".into(),
        source_attachments: vec![authority_attachment("account-operations", "existing-item")],
        progress: vec![AttachmentMoveProgress::Pending {
            attachment_id: "attachment-1".into(),
            expected_envelope_version: 1,
        }],
        intent_fingerprint: Sha256Fingerprint([0; 32]),
        scheduling: OperationSchedulingState::default(),
    };
    preparation.intent_fingerprint = attachment_move_intent_fingerprint(&preparation).unwrap();
    preparation
}

fn attachment_move_overlay() -> ReplicaItemRecord {
    let mut value = overlay(
        "account-operations",
        "operation-attachment-move",
        "existing-item",
    );
    value.vault_id = "vault-2".into();
    value.attachments = vec![authority_attachment("account-operations", "existing-item")];
    value
}

fn guard(account_id: &str, revision: u64, lock_epoch: u64) -> BootstrapGuard {
    BootstrapGuard {
        account_id: AccountId::from(account_id),
        user_id: format!("user-{account_id}"),
        incarnation: incarnation(account_id, "first"),
        expected_replica_revision: revision,
        expected_lock_epoch: lock_epoch,
    }
}

#[allow(
    clippy::too_many_arguments,
    reason = "closed Bootstrap plan fields stay explicit"
)]
fn stage_page(
    account_id: &str,
    revision: u64,
    page_identity: u64,
    request_cursor: BootstrapPageCursor,
    watermark: SyncCursor,
    continuation: BootstrapContinuation,
    item_id: &str,
) -> StageBootstrapPagePlan {
    let phase = request_cursor.phase();
    StageBootstrapPagePlan {
        guard: guard(account_id, revision, 0),
        generation_id: BootstrapGenerationId("generation-1".to_owned()),
        page_identity: match phase {
            super::BootstrapPhase::Vaults => BootstrapPageIdentity::vaults(page_identity),
            super::BootstrapPhase::Items => BootstrapPageIdentity::items(page_identity),
        },
        request_cursor,
        raw_response_fingerprint: Sha256Fingerprint::of_bytes(item_id.as_bytes()),
        pinned_watermark: watermark,
        continuation,
        vaults: (phase == super::BootstrapPhase::Vaults)
            .then(|| vault(account_id))
            .into_iter()
            .collect(),
        items: (phase == super::BootstrapPhase::Items)
            .then(|| authority_item(account_id, item_id, 1))
            .into_iter()
            .collect(),
    }
}

fn installation_history() -> Result<History, RuntimeError> {
    let mut history = HistoryBuilder::new(
        "installation-guards-account-isolation-and-incarnation",
        &[
            "install/load",
            "missing and stale guards",
            "exact revision and lock epoch",
            "Account isolation",
            "remove-readd incarnation fencing",
        ],
        &["account-a", "account-b", "account-missing"],
    );
    history.load("load missing Account", "account-missing")?;
    history.install("install account-a first incarnation", "account-a", "first")?;
    history.install("install isolated account-b", "account-b", "first")?;

    let accepted_request = history.commit_plan(
        "accept Account-scoped encrypted Operation and overlay",
        GuardedCommitPlan::new(
            AccountId::from("account-a"),
            incarnation("account-a", "first"),
            0,
            0,
            vec![
                PlanMutation::AcceptOperation(operation("operation-a", "item-a")),
                PlanMutation::PutOptimisticItem(overlay("account-a", "operation-a", "item-a")),
            ],
        ),
    )?;
    history.replay(
        "replay exact accepted commit at stale revision",
        accepted_request.clone(),
        ReplicaPersistenceResponse::Committed {
            result: PlanResult::Stale { actual_revision: 1 },
        },
    )?;

    let mut missing_request = accepted_request.clone();
    if let ReplicaPersistenceRequest::Commit { prepared } = &mut missing_request {
        prepared.expected.account_id = AccountId::from("account-missing");
        prepared.next_head.account_id = AccountId::from("account-missing");
    }
    history.replay(
        "commit guarded by missing Account",
        missing_request,
        ReplicaPersistenceResponse::Committed {
            result: PlanResult::Missing,
        },
    )?;
    history.advance_lock_epoch(
        "advance exact lock epoch without changing revision",
        "account-a",
    )?;
    history.replay(
        "replay old-epoch commit after lock fencing",
        accepted_request.clone(),
        ReplicaPersistenceResponse::Committed {
            result: PlanResult::Stale { actual_revision: 1 },
        },
    )?;
    history.install(
        "remove and re-add with replacement incarnation",
        "account-a",
        "replacement",
    )?;
    history.replay(
        "old incarnation request remains fenced",
        accepted_request,
        ReplicaPersistenceResponse::Committed {
            result: PlanResult::Stale { actual_revision: 2 },
        },
    )?;
    Ok(history.finish())
}

fn bootstrap_history() -> Result<History, RuntimeError> {
    let mut history = HistoryBuilder::new(
        "bootstrap-staging-promotion-and-tagged-cursor",
        &[
            "Bootstrap staging",
            "exact page retry/replay",
            "atomic promotion",
            "CapturedEmpty distinct from Cold",
            "tagged Sync cursor",
        ],
        &["account-bootstrap"],
    );
    history.install("install Bootstrap Account", "account-bootstrap", "first")?;
    history.begin_bootstrap(
        "begin staged Bootstrap generation",
        BeginBootstrapPlan {
            guard: guard("account-bootstrap", 0, 0),
            generation_id: BootstrapGenerationId("generation-1".to_owned()),
        },
    )?;
    let page_commit = history.stage_bootstrap(
        "stage standalone Bootstrap Vault authority",
        stage_page(
            "account-bootstrap",
            1,
            0,
            BootstrapPageCursor::VaultsInitial,
            SyncCursor::CapturedEmpty,
            BootstrapContinuation::Final,
            "vault-phase",
        ),
    )?;
    history.replay(
        "retry exact staged page persistence request",
        page_commit,
        ReplicaPersistenceResponse::Committed {
            result: PlanResult::Applied {
                replica_revision: 1,
            },
        },
    )?;
    history.stage_bootstrap(
        "stage first Item page and accumulate authority",
        stage_page(
            "account-bootstrap",
            1,
            0,
            BootstrapPageCursor::ItemsInitial,
            SyncCursor::CapturedEmpty,
            BootstrapContinuation::More {
                next_cursor: "page-2".to_owned(),
            },
            "bootstrap-item-1",
        ),
    )?;
    history.stage_bootstrap(
        "stage final Bootstrap Item page",
        stage_page(
            "account-bootstrap",
            1,
            1,
            BootstrapPageCursor::ItemsAfter {
                cursor: "page-2".to_owned(),
            },
            SyncCursor::CapturedEmpty,
            BootstrapContinuation::Final,
            "bootstrap-item-2",
        ),
    )?;
    history.promote_bootstrap(
        "promote captured-empty Bootstrap generation atomically",
        PromoteBootstrapPlan {
            guard: guard("account-bootstrap", 1, 0),
            generation_id: BootstrapGenerationId("generation-1".to_owned()),
        },
    )?;
    Ok(history.finish())
}

fn ready_operation_history(history: &mut HistoryBuilder) -> Result<(), RuntimeError> {
    history.install("install Operation Account", "account-operations", "first")?;
    history.begin_bootstrap(
        "begin Operation Account Bootstrap",
        BeginBootstrapPlan {
            guard: guard("account-operations", 0, 0),
            generation_id: BootstrapGenerationId("generation-1".to_owned()),
        },
    )?;
    history.stage_bootstrap(
        "stage ready Operation Account Vault authority",
        stage_page(
            "account-operations",
            1,
            0,
            BootstrapPageCursor::VaultsInitial,
            SyncCursor::CapturedValue {
                id: "cursor-captured".to_owned(),
            },
            BootstrapContinuation::Final,
            "vault-phase",
        ),
    )?;
    history.stage_bootstrap(
        "stage ready Operation Account Item authority",
        stage_page(
            "account-operations",
            1,
            0,
            BootstrapPageCursor::ItemsInitial,
            SyncCursor::CapturedValue {
                id: "cursor-captured".to_owned(),
            },
            BootstrapContinuation::Final,
            "existing-item",
        ),
    )?;
    history.promote_bootstrap(
        "promote ready Operation Account authority",
        PromoteBootstrapPlan {
            guard: guard("account-operations", 1, 0),
            generation_id: BootstrapGenerationId("generation-1".to_owned()),
        },
    )
}

fn operation_history() -> Result<History, RuntimeError> {
    let mut history = HistoryBuilder::new(
        "operation-retry-outcome-and-receipt-reconciliation",
        &[
            "accepted Operation and encrypted optimistic overlay",
            "attempt count beyond five and exact replay",
            "applied outcome and receipt reconciliation",
            "rejected outcome retains encrypted overlay",
            "Attachment Move preparation checkpoint and atomic promotion",
            "known plaintext marker absent from durable rows",
        ],
        &["account-operations"],
    );
    ready_operation_history(&mut history)?;

    let mut accepted = operation("operation-applied", "item-applied");
    history.commit_plan(
        "accept durable Operation and encrypted optimistic overlay",
        GuardedCommitPlan::new(
            AccountId::from("account-operations"),
            incarnation("account-operations", "first"),
            2,
            0,
            vec![
                PlanMutation::AcceptOperation(accepted.clone()),
                PlanMutation::PutOptimisticItem(overlay(
                    "account-operations",
                    "operation-applied",
                    "item-applied",
                )),
            ],
        ),
    )?;
    accepted.scheduling = OperationSchedulingState {
        attempt_count: 7,
        not_before_ms: 1_700_000_005_000,
    };
    let retry_request = history.commit_plan(
        "persist seventh retry without discarding accepted Operation",
        GuardedCommitPlan::new(
            AccountId::from("account-operations"),
            incarnation("account-operations", "first"),
            3,
            0,
            vec![PlanMutation::RescheduleOperation(accepted.clone())],
        ),
    )?;
    history.replay(
        "replay exact seventh-retry persistence request",
        retry_request,
        ReplicaPersistenceResponse::Committed {
            result: PlanResult::Stale { actual_revision: 4 },
        },
    )?;
    history.commit_plan(
        "reconcile applied outcome receipt authority and Cursor",
        GuardedCommitPlan::new(
            AccountId::from("account-operations"),
            incarnation("account-operations", "first"),
            4,
            0,
            vec![PlanMutation::ReconcileAppliedCreate {
                outcome: ObservedOutcome {
                    operation_id: accepted.operation_id.clone(),
                    request_fingerprint: accepted.request_fingerprint,
                    result: OperationOutcomeResult::Applied {
                        entity_id: accepted.item_id.clone(),
                        version: 1,
                    },
                },
                item: Box::new(authority_item("account-operations", "item-applied", 1)),
                cursor: Some(CursorAdvance {
                    expected: SyncCursor::CapturedValue {
                        id: "cursor-captured".to_owned(),
                    },
                    next: SyncCursor::CapturedValue {
                        id: "cursor-after-applied".to_owned(),
                    },
                }),
            }],
        ),
    )?;

    let rejected = operation("operation-rejected", "item-rejected");
    history.commit_plan(
        "accept second encrypted Operation",
        GuardedCommitPlan::new(
            AccountId::from("account-operations"),
            incarnation("account-operations", "first"),
            5,
            0,
            vec![
                PlanMutation::AcceptOperation(rejected.clone()),
                PlanMutation::PutOptimisticItem(overlay(
                    "account-operations",
                    "operation-rejected",
                    "item-rejected",
                )),
            ],
        ),
    )?;
    history.commit_plan(
        "retain rejected outcome receipt and encrypted overlay",
        GuardedCommitPlan::new(
            AccountId::from("account-operations"),
            incarnation("account-operations", "first"),
            6,
            0,
            vec![PlanMutation::RetainRejection {
                outcome: ObservedOutcome {
                    operation_id: rejected.operation_id,
                    request_fingerprint: rejected.request_fingerprint,
                    result: OperationOutcomeResult::Rejected {
                        code: OperationRejectionCode::VaultReadOnly,
                    },
                },
                cursor: None,
            }],
        ),
    )?;

    let preparation = attachment_move_preparation();
    history.commit_plan(
        "accept Attachment Move preparation outside ready Operations",
        GuardedCommitPlan::new(
            AccountId::from("account-operations"),
            incarnation("account-operations", "first"),
            7,
            0,
            vec![
                PlanMutation::AcceptAttachmentMovePreparation(preparation.clone()),
                PlanMutation::PutOptimisticItem(attachment_move_overlay()),
            ],
        ),
    )?;
    let pending = preparation.progress[0].clone();
    let encrypted = AttachmentMoveProgress::Encrypted {
        attachment_id: "attachment-1".into(),
        expected_envelope_version: 1,
        artifact: attachment_move_artifact_ref(
            &AccountId::from("account-operations"),
            "operation-attachment-move",
            "attachment-1",
            "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
            4,
        )?,
        payload: Box::new(PreparedMoveAttachment {
            encrypted_name: "opaque-target-name".into(),
            encryption_iv: "target-name-iv".into(),
            encryption_algorithm: "AES-GCM-AAD-V1".into(),
            encrypted_attachment_key: "opaque-target-key".into(),
            attachment_key_iv: "target-key-iv".into(),
            attachment_key_algorithm: "AES-GCM-AAD-V1".into(),
            encrypted_content_type: "opaque-target-content-type".into(),
            encrypted_content_type_iv: "target-content-type-iv".into(),
        }),
        upload: AttachmentMoveUploadState::NeedsUpload,
    };
    history.commit_plan(
        "checkpoint one encrypted Attachment without a ready Operation",
        GuardedCommitPlan::new(
            AccountId::from("account-operations"),
            incarnation("account-operations", "first"),
            8,
            0,
            vec![PlanMutation::CheckpointAttachmentMove {
                operation_id: preparation.operation_id.clone(),
                expected_intent_fingerprint: preparation.intent_fingerprint,
                expected: pending,
                next: encrypted.clone(),
            }],
        ),
    )?;
    let uploaded = match encrypted.clone() {
        AttachmentMoveProgress::Encrypted {
            attachment_id,
            expected_envelope_version,
            artifact,
            payload,
            ..
        } => AttachmentMoveProgress::Encrypted {
            attachment_id,
            expected_envelope_version,
            artifact,
            payload,
            upload: AttachmentMoveUploadState::Uploaded,
        },
        AttachmentMoveProgress::Pending { .. } => unreachable!(),
    };
    history.commit_plan(
        "checkpoint the stable ciphertext upload",
        GuardedCommitPlan::new(
            AccountId::from("account-operations"),
            incarnation("account-operations", "first"),
            9,
            0,
            vec![PlanMutation::CheckpointAttachmentMove {
                operation_id: preparation.operation_id.clone(),
                expected_intent_fingerprint: preparation.intent_fingerprint,
                expected: encrypted,
                next: uploaded,
            }],
        ),
    )?;
    history.commit_plan(
        "atomically promote complete preparation into immutable ready Operation",
        GuardedCommitPlan::new(
            AccountId::from("account-operations"),
            incarnation("account-operations", "first"),
            10,
            0,
            vec![PlanMutation::PromoteAttachmentMovePreparation {
                operation_id: preparation.operation_id,
                expected_intent_fingerprint: preparation.intent_fingerprint,
            }],
        ),
    )?;
    let promoted_fingerprint =
        history.snapshot("account-operations").unwrap().operations[0].request_fingerprint;
    let mut promoted_reschedule =
        history.snapshot("account-operations").unwrap().operations[0].clone();
    promoted_reschedule.scheduling.attempt_count = 3;
    promoted_reschedule.scheduling.not_before_ms = 3_000;
    history.commit_plan(
        "reschedule promoted Attachment Move and synchronize its recovery",
        GuardedCommitPlan::new(
            AccountId::from("account-operations"),
            incarnation("account-operations", "first"),
            11,
            0,
            vec![PlanMutation::RescheduleOperation(promoted_reschedule)],
        ),
    )?;
    history.commit_plan(
        "atomically reactivate promoted Attachment Move recovery after staging incomplete",
        GuardedCommitPlan::new(
            AccountId::from("account-operations"),
            incarnation("account-operations", "first"),
            12,
            0,
            vec![PlanMutation::ReactivateAttachmentMovePreparation {
                operation_id: "operation-attachment-move".into(),
                expected_request_fingerprint: promoted_fingerprint,
            }],
        ),
    )?;
    history.commit_plan(
        "freeze stale-authority request with single-record recovery",
        GuardedCommitPlan::new(
            AccountId::from("account-operations"),
            incarnation("account-operations", "first"),
            13,
            0,
            vec![PlanMutation::FreezeAttachmentMoveRejection {
                operation_id: "operation-attachment-move".into(),
                expected_intent_fingerprint: preparation.intent_fingerprint,
            }],
        ),
    )?;
    let rejected_fingerprint =
        history.snapshot("account-operations").unwrap().operations[0].request_fingerprint;
    let mut rejection_reschedule =
        history.snapshot("account-operations").unwrap().operations[0].clone();
    rejection_reschedule.scheduling.attempt_count = 4;
    rejection_reschedule.scheduling.not_before_ms = 4_000;
    history.commit_plan(
        "reschedule stale-authority request and synchronize its recovery",
        GuardedCommitPlan::new(
            AccountId::from("account-operations"),
            incarnation("account-operations", "first"),
            14,
            0,
            vec![PlanMutation::RescheduleOperation(rejection_reschedule)],
        ),
    )?;
    history.commit_plan(
        "atomically reactivate stale-authority recovery after staging incomplete",
        GuardedCommitPlan::new(
            AccountId::from("account-operations"),
            incarnation("account-operations", "first"),
            15,
            0,
            vec![PlanMutation::ReactivateAttachmentMovePreparation {
                operation_id: "operation-attachment-move".into(),
                expected_request_fingerprint: rejected_fingerprint,
            }],
        ),
    )?;
    Ok(history.finish())
}

fn build_corpus() -> Result<Corpus, RuntimeError> {
    Ok(Corpus {
        format_version: FORMAT_VERSION,
        oracle: "rustDomainLogicalSnapshots".to_owned(),
        plaintext_causality: "encryptedCreatePlanInput".to_owned(),
        forbidden_durable_row_markers: vec![KNOWN_PLAINTEXT_MARKER.to_owned()],
        histories: vec![
            installation_history()?,
            bootstrap_history()?,
            operation_history()?,
        ],
    })
}

/// Generates deterministic JSON from Domain results without executing a persistence adapter.
pub async fn generate_replica_conformance_corpus() -> Result<String, RuntimeError> {
    let corpus = build_corpus()?;
    let mut json = serde_json::to_string_pretty(&corpus)
        .map_err(|_| oracle_error("Replica conformance corpus could not be serialized"))?;
    json.push('\n');
    Ok(json)
}

#[cfg(test)]
async fn assert_adapter_matches_corpus(
    corpus: &Corpus,
    adapter_factory: impl Fn(&str) -> Arc<dyn ReplicaPersistence>,
) {
    for history in &corpus.histories {
        let adapter = adapter_factory(&history.name);
        for step in &history.steps {
            let actual = normalize_response(
                adapter
                    .invoke(step.request.clone())
                    .await
                    .unwrap_or_else(|error| panic!("{} / {}: {error}", history.name, step.label)),
            );
            assert_eq!(
                actual, step.expected_response,
                "{} / {}",
                history.name, step.label
            );
            for expected in &step.expected_loaded_state {
                let loaded = normalize_response(
                    adapter
                        .invoke(ReplicaPersistenceRequest::Load {
                            account_id: expected.account_id.clone(),
                        })
                        .await
                        .unwrap(),
                );
                assert_eq!(
                    loaded,
                    expected.response,
                    "{} / {} / load {}",
                    history.name,
                    step.label,
                    expected.account_id.as_str()
                );
            }
        }
    }
}

#[cfg(test)]
fn corpus_path() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../generated/replica-conformance/history-corpus.json")
}

#[cfg(test)]
#[tokio::test]
async fn checked_in_corpus_is_current_and_both_rust_adapters_execute_its_domain_oracle() {
    let generated = generate_replica_conformance_corpus().await.unwrap();
    let checked_in = std::fs::read_to_string(corpus_path()).unwrap();
    assert_eq!(checked_in, generated, "generated Replica corpus drifted");
    let corpus: Corpus = serde_json::from_str(&checked_in).unwrap();

    assert_adapter_matches_corpus(&corpus, |_| Arc::new(InMemoryReplica::default())).await;
    assert_adapter_matches_corpus(&corpus, |_| {
        Arc::new(SqliteReplica::open(":memory:").unwrap())
    })
    .await;
}

#[cfg(test)]
#[test]
fn known_plaintext_marker_is_encrypted_before_the_create_plan_reaches_durable_rows() {
    use bittery_crypto_core::{decrypt_with_aad, encrypt_with_aad, AadContext};

    let account_id = AccountId::from("account-plaintext-proof");
    let snapshot = ReplicaSnapshot {
        account_id: account_id.clone(),
        user_id: "user-plaintext-proof".to_owned(),
        incarnation: Incarnation::from("incarnation-plaintext-proof"),
        revision: 0,
        lock_epoch: 0,
        items: Vec::new(),
        operations: Vec::new(),
        attachment_move_preparations: Vec::new(),
        receipts: Vec::new(),
        failure: None,
        bootstrap: BootstrapAuthority::default(),
    };
    let key = [17_u8; 32];
    let aad = AadContext {
        vault_id: "vault-1".to_owned(),
        entity_id: "item-plaintext-proof".to_owned(),
        entity_type: "item".to_owned(),
        version: 1,
        user_id: snapshot.user_id.clone(),
    };
    let draft_json = serde_json::json!({
        "title": "Causal plaintext proof",
        "password": KNOWN_PLAINTEXT_MARKER,
    })
    .to_string();
    let sealed = encrypt_with_aad(&draft_json, &key, &aad).unwrap();
    assert_eq!(decrypt_with_aad(&sealed, &key, &aad).unwrap(), draft_json);

    let body = serde_json::to_vec(&sealed).unwrap();
    let request_fingerprint = Sha256Fingerprint::of_bytes(&body);
    let plan = GuardedCommitPlan::new(
        account_id.clone(),
        snapshot.incarnation.clone(),
        0,
        0,
        vec![
            PlanMutation::AcceptOperation(OperationRecord {
                operation_id: "operation-plaintext-proof".to_owned(),
                kind: OperationKind::CreateItem,
                item_id: "item-plaintext-proof".to_owned(),
                vault_id: "vault-1".to_owned(),
                request: ImmutableHttpRequest {
                    method: HttpMethod::Put,
                    path: "/api/v1/vaults/vault-1/items/item-plaintext-proof".to_owned(),
                    headers: Vec::new(),
                    body,
                },
                request_fingerprint,
                attachment_move_recovery: None,
                scheduling: OperationSchedulingState::default(),
            }),
            PlanMutation::PutOptimisticItem(ReplicaItemRecord {
                account_id,
                item_id: "item-plaintext-proof".to_owned(),
                vault_id: "vault-1".to_owned(),
                operation_id: "operation-plaintext-proof".to_owned(),
                category: AuthorityItemCategory::Login,
                encrypted_data: sealed.ciphertext,
                encryption_iv: sealed.iv,
                encryption_algorithm: sealed.algorithm,
                encryption_version: 1,
                encrypted_by_user_id: "user-plaintext-proof".to_owned(),
                favorite: false,
                version: 1,
                created_at: "2026-08-24T00:00:00Z".to_owned(),
                updated_at: "2026-08-24T00:00:00Z".to_owned(),
                deleted_at: None,
                attachments: Vec::new(),
                permanently_deleted: false,
            }),
        ],
    );
    let prepared = prepare_commit(snapshot, plan).unwrap();
    let durable_json = serde_json::to_string(&ReplicaPersistenceRequest::Commit {
        prepared: prepared.wire,
    })
    .unwrap();
    assert!(!durable_json.contains(KNOWN_PLAINTEXT_MARKER));
    assert!(!snapshot_rows(prepared.next_snapshot)
        .unwrap()
        .iter()
        .any(|row| row.payload_json.contains(KNOWN_PLAINTEXT_MARKER)));
}

#[cfg(test)]
#[test]
fn corpus_loaded_rows_exclude_every_known_plaintext_marker() {
    let checked_in = std::fs::read_to_string(corpus_path()).unwrap();
    let corpus: Corpus = serde_json::from_str(&checked_in).unwrap();
    for history in &corpus.histories {
        for step in &history.steps {
            for state in &step.expected_loaded_state {
                if let ReplicaPersistenceResponse::Loaded { rows, .. } = &state.response {
                    for row in rows {
                        for marker in &corpus.forbidden_durable_row_markers {
                            assert!(!row.payload_json.contains(marker));
                        }
                    }
                }
            }
        }
    }
}
