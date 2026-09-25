//! Stopped legacy Create: retained lookup can prove an old effect, never authorize a new one.
use crate::http_transport::{HttpHeader, HttpMethod};
use crate::replica::{
    create_item_fingerprint, AuthorityItemCategory, ImmutableHttpRequest, LegacyOperationAdmission,
    OperationKind, OperationRecord, ResourceRef, LEGACY_OPERATION_ADMISSION_VERSION,
};
use crate::runtime::operation_fixtures::*;
use crate::runtime::*;
use crate::test_fixtures::{TEST_VAULT_ID, TEST_VAULT_KEY};
use crate::Incarnation;
use serde_json::json;

const HELD: &str = "held-semantic";
const ITEM: &str = "held-item";

async fn held(status: &str) -> Harness {
    held_scheduled(status, 0, 0).await
}

async fn held_scheduled(status: &str, retries: u64, deadline: u64) -> Harness {
    held_fixture(status, retries, deadline, false).await
}

async fn held_fixture(status: &str, retries: u64, deadline: u64, captured: bool) -> Harness {
    let harness = seeded(true).await;
    let snapshot = harness
        .runtime
        .replica
        .snapshot(&harness.account_id)
        .unwrap();
    let mut evidence = json!({
        "version": LEGACY_OPERATION_ADMISSION_VERSION,
        "admissionId": "held-admission",
        "sourceQueueIndex": "0",
        "sourceCommand": {
            "accountId": ACCOUNT, "id":"source-command", "operationId":HELD, "attemptId":"source-attempt",
            "type":"create", "entityId":ITEM, "vaultId":TEST_VAULT_ID, "category":"login",
            "encryptedPayload":{"encryptionVersion":1,"encryptedByUserId":USER},
            "baseVersion":0, "timestamp":START_MS.to_string(), "retryCount":retries.to_string(), "status":status,
            "nextAttemptAt":deadline.to_string()
        },
        "disposition": if status == "failed" { "legacyFailed" } else { "legacyConflicted" }
    });
    if captured {
        evidence["capturedFailureCode"] = json!("item_id_conflict");
    }
    let admission: LegacyOperationAdmission = serde_json::from_value(evidence).unwrap();
    let encrypted = bittery_crypto_core::encrypt_with_aad(
        &create::item_plaintext(&draft()).unwrap(),
        &TEST_VAULT_KEY,
        &bittery_crypto_core::AadContext {
            vault_id: TEST_VAULT_ID.into(),
            entity_id: ITEM.into(),
            entity_type: "item".into(),
            version: 1,
            user_id: USER.into(),
        },
    )
    .unwrap();
    // Legacy producer order differs from the generated Rust Server DTO field order.
    let body = format!(
        r#"{{"category":"login","encryptedData":{},"encryptionIv":{},"encryptionAlgorithm":{}}}"#,
        serde_json::to_string(&encrypted.ciphertext).unwrap(),
        serde_json::to_string(&encrypted.iv).unwrap(),
        serde_json::to_string(&encrypted.algorithm).unwrap(),
    )
    .into_bytes();
    let operation = OperationRecord {
        operation_id: HELD.into(),
        kind: OperationKind::CreateItem,
        target: ResourceRef::Item {
            item_id: ITEM.into(),
            vault_id: TEST_VAULT_ID.into(),
        },
        request_fingerprint: create_item_fingerprint(TEST_VAULT_ID, ITEM, &body),
        request: ImmutableHttpRequest {
            method: HttpMethod::Put,
            path: format!("/api/v1/vaults/{TEST_VAULT_ID}/items/{ITEM}"),
            headers: vec![HttpHeader {
                name: "Content-Type".into(),
                value: "application/json".into(),
            }],
            body,
        },
        accepted_item_category: Some(AuthorityItemCategory::Login),
        attachment_move_recovery: None,
        create_vault: None,
        update_vault: None,
        scheduling: admission.initial_scheduling(),
        legacy_admission: Some(Box::new(admission)),
    };
    let mut mutations = vec![];
    if captured {
        mutations.push(PlanMutation::PutOptimisticItem(captured_overlay(
            &operation,
        )));
    }
    mutations.insert(0, PlanMutation::AcceptOperation(operation));
    harness
        .runtime
        .replica
        .execute(GuardedCommitPlan::new(
            snapshot.account_id,
            snapshot.incarnation,
            snapshot.revision,
            snapshot.lock_epoch,
            mutations,
        ))
        .await
        .unwrap();
    harness
}

fn captured_overlay(operation: &OperationRecord) -> crate::replica::ReplicaItemRecord {
    let body: serde_json::Value = serde_json::from_slice(&operation.request.body).unwrap();
    let timestamp = crate::replica::source_timestamp(START_MS).unwrap();
    crate::replica::ReplicaItemRecord {
        account_id: ACCOUNT.into(),
        item_id: ITEM.into(),
        vault_id: TEST_VAULT_ID.into(),
        operation_id: HELD.into(),
        category: AuthorityItemCategory::Login,
        encrypted_data: body["encryptedData"].as_str().unwrap().into(),
        encryption_iv: body["encryptionIv"].as_str().unwrap().into(),
        encryption_algorithm: body["encryptionAlgorithm"].as_str().unwrap().into(),
        encryption_version: 1,
        encrypted_by_user_id: USER.into(),
        favorite: false,
        version: 1,
        created_at: timestamp.clone(),
        updated_at: timestamp,
        deleted_at: None,
        attachments: vec![],
        permanently_deleted: false,
    }
}

fn visible_held_item(harness: &Harness) -> crate::ItemProjection {
    harness
        .runtime
        .decrypt_visible_items(&harness.account_id)
        .unwrap();
    let RuntimeProjection::Items(items) = harness
        .runtime
        .projection(&ObservationRequest::Items {
            account_id: harness.account_id.clone(),
        })
        .unwrap()
        .projection
    else {
        panic!("expected Items");
    };
    items
        .items
        .into_iter()
        .find(|item| item.item_id == ITEM)
        .expect("captured ciphertext remains visible")
}

#[tokio::test]
async fn captured_failed_create_projects_failed_without_synthetic_rejection_while_refresh_required()
{
    let mut harness = held_fixture("failed", 0, 0, true).await;
    let before = harness
        .runtime
        .replica
        .snapshot(&harness.account_id)
        .unwrap();
    harness
        .runtime
        .replica
        .mark_refresh_required(crate::replica::MarkRefreshRequiredPlan {
            guard: crate::replica::BootstrapGuard {
                account_id: harness.account_id.clone(),
                user_id: before.user_id,
                incarnation: before.incarnation,
                expected_replica_revision: before.revision,
                expected_lock_epoch: before.lock_epoch,
            },
        })
        .await
        .unwrap();
    let before = harness
        .runtime
        .replica
        .snapshot(&harness.account_id)
        .unwrap();
    assert_eq!(
        before.bootstrap.state,
        crate::replica::ReplicaState::RefreshRequired
    );
    assert!(!before.item_has_optimistic_owner(ITEM));
    assert_eq!(
        serde_json::to_value(&before.operations[0].legacy_admission).unwrap()
            ["capturedFailureCode"],
        "item_id_conflict"
    );
    assert!(!before
        .bootstrap
        .snapshot()
        .visible_items
        .iter()
        .any(|item| item.id == ITEM));
    assert_eq!(
        visible_held_item(&harness).status,
        crate::ItemProjectionStatus::Failed
    );
    assert_eq!(
        visible_held_item(&harness).data,
        crate::PublicItemDraft::from(&draft())
    );
    let RuntimeProjection::Operations(operations) = harness
        .runtime
        .projection(&ObservationRequest::Operations {
            account_id: harness.account_id.clone(),
        })
        .unwrap()
        .projection
    else {
        panic!("expected Operations");
    };
    assert_eq!(
        operations.operations[0].resolution,
        crate::OperationResolution::LegacyFailed
    );
    assert_eq!(operations.operations[0].next_attempt_at_ms, None);
    assert_eq!(operations.operations[0].rejection_code, None);
    assert!(matches!(
        harness.runtime.dispatch_eligible_operations().await,
        dispatch::DispatchPass::Parked
    ));
    assert!(matches!(
        sync(&harness).await,
        outcome::CompletionResult::Retry
    ));
    assert_eq!(
        harness
            .runtime
            .replica
            .snapshot(&harness.account_id)
            .unwrap(),
        before
    );
    assert_eq!(harness.server.outcome_lookups(), 2);
    assert_eq!(harness.server.creates(), 0);
    assert!(harness.timer.requested().is_empty());
    let replica = harness.replica.clone();
    reopen(&mut harness, replica).await;
    assert_eq!(
        visible_held_item(&harness).status,
        crate::ItemProjectionStatus::Failed
    );
    assert_eq!(
        harness
            .runtime
            .replica
            .snapshot(&harness.account_id)
            .unwrap()
            .items,
        before.items
    );
    harness.runtime.close().await;
}

async fn reopen(
    harness: &mut Harness,
    replica: Arc<dyn crate::replica::SerializedReplicaExecutor>,
) {
    harness.runtime.close().await;
    harness.runtime = Runtime::with_test_dispatch_environment(
        replica,
        harness.platform.clone(),
        harness.server.clone(),
        auth_config(),
        harness.clock.clone(),
        harness.timer.clone(),
    );
    harness
        .runtime
        .replica
        .load(&harness.account_id)
        .await
        .unwrap();
    harness
        .runtime
        .unlock_account(&harness.account_id)
        .await
        .unwrap();
}

#[tokio::test]
async fn held_create_missing_outcome_parks_without_effect_change_or_timer() {
    for status in ["failed", "conflicted"] {
        let mut harness = held(status).await;
        let before = harness
            .runtime
            .replica
            .snapshot(&harness.account_id)
            .unwrap();
        for expected_probes in 1..=2 {
            assert!(matches!(
                harness.runtime.dispatch_eligible_operations().await,
                dispatch::DispatchPass::Parked
            ));
            assert_eq!(harness.server.outcome_lookups(), expected_probes);
            assert_eq!(harness.server.creates(), 0);
            assert_eq!(
                harness
                    .runtime
                    .replica
                    .snapshot(&harness.account_id)
                    .unwrap(),
                before
            );
            assert!(harness.timer.requested().is_empty());
        }
        let replica = harness.replica.clone();
        reopen(&mut harness, replica).await;
        assert!(matches!(
            harness.runtime.dispatch_eligible_operations().await,
            dispatch::DispatchPass::Parked
        ));
        assert_eq!(harness.server.outcome_lookups(), 3);
        assert_eq!(harness.server.creates(), 0);
        assert_eq!(harness.operation(), before.operations.first().cloned());
        harness.runtime.close().await;
    }
}

async fn accept_new_same_item(
    harness: &Harness,
) -> (OperationRecord, crate::replica::ReplicaItemRecord) {
    let mut operation = harness.operation().unwrap();
    operation.operation_id = "new-active".into();
    operation.legacy_admission = None;
    operation.scheduling = Default::default();
    let body: serde_json::Value = serde_json::from_slice(&operation.request.body).unwrap();
    let timestamp = crate::replica::source_timestamp(START_MS + 1).unwrap();
    let overlay = crate::replica::ReplicaItemRecord {
        account_id: harness.account_id.clone(),
        item_id: ITEM.into(),
        vault_id: TEST_VAULT_ID.into(),
        operation_id: operation.operation_id.clone(),
        category: AuthorityItemCategory::Login,
        encrypted_data: body["encryptedData"].as_str().unwrap().into(),
        encryption_iv: body["encryptionIv"].as_str().unwrap().into(),
        encryption_algorithm: body["encryptionAlgorithm"].as_str().unwrap().into(),
        encryption_version: 1,
        encrypted_by_user_id: USER.into(),
        favorite: false,
        version: 1,
        created_at: timestamp.clone(),
        updated_at: timestamp,
        deleted_at: None,
        attachments: vec![],
        permanently_deleted: false,
    };
    let snapshot = harness
        .runtime
        .replica
        .snapshot(&harness.account_id)
        .unwrap();
    harness
        .runtime
        .replica
        .execute(GuardedCommitPlan::new(
            snapshot.account_id,
            snapshot.incarnation,
            snapshot.revision,
            snapshot.lock_epoch,
            vec![
                PlanMutation::AcceptOperation(operation.clone()),
                PlanMutation::PutOptimisticItem(overlay.clone()),
            ],
        ))
        .await
        .unwrap();
    (operation, overlay)
}

#[tokio::test]
async fn held_create_retained_applied_and_rejected_proofs_preserve_new_same_item_work() {
    for status in ["failed", "conflicted"] {
        for through_sync in [false, true] {
            for rejected in [false, true] {
                let harness = held(status).await;
                let original = retain_old_effect(&harness, rejected);
                let (active, overlay) = accept_new_same_item(&harness).await;
                if through_sync {
                    assert!(matches!(
                        sync(&harness).await,
                        outcome::CompletionResult::Completed
                    ));
                } else {
                    harness
                        .runtime
                        .dispatch_once_ignoring_lease(&harness.account_id, HELD)
                        .await;
                }
                let after = harness
                    .runtime
                    .replica
                    .load(&harness.account_id)
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(after.operations, vec![active]);
                assert_eq!(after.items, vec![overlay]);
                assert_eq!(after.receipts.len(), 1);
                assert_eq!(after.receipts[0].operation_id, HELD);
                assert_eq!(
                    after.receipts[0]
                        .legacy_lineage
                        .as_ref()
                        .unwrap()
                        .source_status,
                    original
                        .legacy_admission
                        .as_ref()
                        .unwrap()
                        .source_command
                        .status
                );
                assert_eq!(harness.server.outcome_lookups(), 1);
                assert_eq!(harness.server.creates(), 2);
                assert_eq!(harness.server.created_items().len(), usize::from(!rejected));
                assert_eq!(
                    harness.server.create_requests()[0].body,
                    original.request.body
                );
                assert_eq!(
                    harness.server.create_requests()[0].header("Idempotency-Key"),
                    Some(HELD)
                );
                harness.runtime.close().await;
            }
        }
    }
}

#[tokio::test]
async fn held_create_missing_does_not_starve_new_same_item_or_unrelated_work() {
    let harness = held("failed").await;
    let (active, _) = accept_new_same_item(&harness).await;
    let (other, _) = harness.accept_create().await;
    for _ in 0..2 {
        assert!(matches!(
            harness.runtime.dispatch_eligible_operations().await,
            dispatch::DispatchPass::Progressed
        ));
    }
    let after = harness
        .runtime
        .replica
        .snapshot(&harness.account_id)
        .unwrap();
    assert_eq!(after.operations.len(), 1);
    assert_eq!(after.operations[0].operation_id, HELD);
    assert!(after
        .receipts
        .iter()
        .any(|receipt| receipt.operation_id == active.operation_id));
    assert!(after
        .receipts
        .iter()
        .any(|receipt| receipt.operation_id == other));
    assert_eq!(harness.server.creates(), 2);
    assert!(matches!(
        harness.runtime.dispatch_eligible_operations().await,
        dispatch::DispatchPass::Parked
    ));
    harness.runtime.close().await;
}

#[tokio::test]
async fn held_create_initial_deadline_delays_lookup_without_granting_replay_permission() {
    let harness = held_scheduled("failed", 7, START_MS + 5000).await;
    assert!(matches!(
        sync(&harness).await,
        outcome::CompletionResult::Retry
    ));
    assert!(matches!(
        harness.runtime.dispatch_eligible_operations().await,
        dispatch::DispatchPass::WaitFor { milliseconds: 5000 }
    ));
    assert_eq!(harness.server.outcome_lookups(), 0);
    harness.clock.advance(5000);
    assert!(matches!(
        harness.runtime.dispatch_eligible_operations().await,
        dispatch::DispatchPass::Parked
    ));
    assert_eq!(harness.server.outcome_lookups(), 1);
    assert_eq!(harness.operation().unwrap().scheduling.attempt_count, 7);
    assert_eq!(harness.server.creates(), 0);
    harness.runtime.close().await;
}

#[tokio::test]
async fn held_create_lost_replay_requires_a_new_lookup_after_backoff() {
    for through_sync in [false, true] {
        let harness = held("failed").await;
        retain_old_effect(&harness, false);
        harness.server.script([Fault::NetworkFailure]);
        if through_sync {
            assert!(matches!(
                sync(&harness).await,
                outcome::CompletionResult::Retry
            ));
        } else {
            harness
                .runtime
                .dispatch_once_ignoring_lease(&harness.account_id, HELD)
                .await;
        }
        let pending = harness.operation().unwrap();
        assert_eq!(pending.scheduling.attempt_count, 1);
        assert!(pending.scheduling.not_before_ms > harness.clock.now());
        harness.server.outcomes.lock().unwrap().clear();
        harness
            .clock
            .advance(pending.scheduling.not_before_ms - harness.clock.now());
        let before = harness
            .runtime
            .replica
            .snapshot(&harness.account_id)
            .unwrap();
        if through_sync {
            assert!(matches!(
                sync(&harness).await,
                outcome::CompletionResult::Retry
            ));
        } else {
            assert!(matches!(
                harness.runtime.dispatch_eligible_operations().await,
                dispatch::DispatchPass::Parked
            ));
        }
        assert_eq!(harness.server.outcome_lookups(), 2);
        assert_eq!(
            harness.server.creates(),
            2,
            "the failed replay does not leave permission to send again"
        );
        assert_eq!(
            harness
                .runtime
                .replica
                .snapshot(&harness.account_id)
                .unwrap(),
            before
        );
        harness.runtime.close().await;
    }
}

#[tokio::test]
async fn held_create_identity_reuse_and_auth_failure_preserve_the_hold() {
    for through_sync in [false, true] {
        for reused in [false, true] {
            let harness = held("failed").await;
            let original = retain_old_effect(&harness, false);
            if reused {
                harness
                    .server
                    .outcomes
                    .lock()
                    .unwrap()
                    .get_mut(HELD)
                    .unwrap()
                    .fingerprint = [0; 32];
            } else {
                harness
                    .server
                    .outcome_faults
                    .lock()
                    .unwrap()
                    .push_back(Fault::Status(401));
            }
            if through_sync {
                sync(&harness).await;
            } else {
                harness
                    .runtime
                    .dispatch_once_ignoring_lease(&harness.account_id, HELD)
                    .await;
            }
            let after = harness
                .runtime
                .replica
                .snapshot(&harness.account_id)
                .unwrap();
            assert_eq!(after.operations, vec![original]);
            assert!(after.receipts.is_empty());
            if reused {
                assert_eq!(after.failure, Some(RuntimeErrorCode::InvariantViolation));
            } else {
                assert_eq!(
                    harness.waiting_reason(),
                    Some(AccountWaitingReason::ReauthenticationRequired)
                );
            }
            assert_eq!(harness.server.creates(), if reused { 2 } else { 1 });
            assert_eq!(harness.server.created_items().len(), 1);
            harness.runtime.close().await;
        }
    }
}

async fn sync(harness: &Harness) -> outcome::CompletionResult {
    let snapshot = harness
        .runtime
        .replica
        .snapshot(&harness.account_id)
        .unwrap();
    let mut session = harness
        .runtime
        .platform_storage
        .load_current_session(&harness.account_id, &snapshot.incarnation)
        .await
        .unwrap()
        .unwrap();
    let http = crate::auth_http::AuthHttpClient::new(
        &harness.runtime.http_transport,
        SERVER_URL,
        false,
        auth_config(),
    )
    .unwrap();
    harness
        .runtime
        .reconcile_resolved_operation(&harness.account_id, HELD, &http, &mut session)
        .await
}

#[tokio::test]
async fn held_create_sync_lookup_failure_persists_backoff_and_both_paths_honor_it() {
    let harness = held("failed").await;
    harness
        .server
        .outcome_faults
        .lock()
        .unwrap()
        .push_back(Fault::NetworkFailure);
    assert!(matches!(
        sync(&harness).await,
        outcome::CompletionResult::Retry
    ));
    let scheduled = harness.operation().unwrap();
    assert_eq!(scheduled.scheduling.attempt_count, 1);
    assert!(scheduled.scheduling.not_before_ms > harness.clock.now());
    assert_eq!(harness.server.outcome_lookups(), 1);
    assert_eq!(harness.server.creates(), 0);
    assert!(matches!(
        sync(&harness).await,
        outcome::CompletionResult::Retry
    ));
    assert!(matches!(
        harness.runtime.dispatch_eligible_operations().await,
        dispatch::DispatchPass::WaitFor { .. }
    ));
    assert_eq!(
        harness.server.outcome_lookups(),
        1,
        "neither Sync nor dispatch may bypass backoff"
    );
    harness
        .clock
        .advance(scheduled.scheduling.not_before_ms - harness.clock.now());
    let before = harness
        .runtime
        .replica
        .snapshot(&harness.account_id)
        .unwrap();
    assert!(matches!(
        sync(&harness).await,
        outcome::CompletionResult::Retry
    ));
    assert_eq!(harness.server.outcome_lookups(), 2);
    assert_eq!(harness.server.creates(), 0);
    assert_eq!(
        harness
            .runtime
            .replica
            .snapshot(&harness.account_id)
            .unwrap(),
        before,
        "missing outcome leaves the hold and page cursor unchanged"
    );
    harness.runtime.close().await;
}

#[tokio::test]
async fn held_create_failed_schedule_commit_parks_without_claiming_progress() {
    let harness = held("failed").await;
    let before = harness
        .runtime
        .replica
        .snapshot(&harness.account_id)
        .unwrap();
    harness
        .server
        .outcome_faults
        .lock()
        .unwrap()
        .push_back(Fault::NetworkFailure);
    harness.replica.fail_next_commits(1);
    assert!(matches!(
        harness.runtime.dispatch_eligible_operations().await,
        dispatch::DispatchPass::Parked
    ));
    assert_eq!(harness.replica.failed_commits(), 1);
    assert_eq!(
        harness
            .runtime
            .replica
            .snapshot(&harness.account_id)
            .unwrap(),
        before
    );
    assert_eq!(harness.server.outcome_lookups(), 1);
    assert_eq!(harness.server.creates(), 0);
    assert!(harness.timer.requested().is_empty());
    harness.runtime.close().await;
}

fn retain_old_effect(harness: &Harness, rejected: bool) -> OperationRecord {
    let operation = harness.operation().unwrap();
    if rejected {
        harness.server.reject_next("vault_read_only");
    }
    let mut headers = operation
        .request
        .headers
        .iter()
        .map(|header| (header.name.clone(), header.value.clone()))
        .collect::<Vec<_>>();
    headers.push(("Authorization".into(), format!("Bearer {FIRST_TOKEN}")));
    headers.push(("Idempotency-Key".into(), HELD.into()));
    let response = harness.server.handle_create(&RecordedRequest {
        method: "PUT".into(),
        url: format!("{SERVER_URL}{}", operation.request.path),
        headers,
        body: operation.request.body.clone(),
    });
    assert_eq!(response["status"], 200);
    operation
}

#[tokio::test]
async fn held_create_inconsistent_lookup_and_replay_fences_without_a_receipt() {
    for through_sync in [false, true] {
        let harness = held("conflicted").await;
        let operation = retain_old_effect(&harness, false);
        harness.server.answer_next_lookup_with(outcome_body(
            HELD,
            &StoredResult::ItemRejected {
                code: "vault_read_only",
            },
        ));
        if through_sync {
            assert!(matches!(
                sync(&harness).await,
                outcome::CompletionResult::Failed
            ));
        } else {
            harness
                .runtime
                .dispatch_once_ignoring_lease(&harness.account_id, HELD)
                .await;
        }
        let after = harness
            .runtime
            .replica
            .snapshot(&harness.account_id)
            .unwrap();
        assert_eq!(after.failure, Some(RuntimeErrorCode::InvariantViolation));
        assert_eq!(after.operations, vec![operation]);
        assert!(after.receipts.is_empty());
        assert!(after.items.is_empty());
        assert_eq!(harness.server.outcome_lookups(), 1);
        assert_eq!(harness.server.created_items(), vec![ITEM.to_string()]);
        harness.runtime.close().await;
    }
}

#[tokio::test]
async fn held_create_failed_authority_reconciliation_backs_off_or_parks_if_write_fails() {
    for (through_sync, fail_write) in [(false, false), (false, true), (true, false), (true, true)] {
        let harness = held("failed").await;
        let original = retain_old_effect(&harness, false);
        harness.server.script_item_faults([Fault::NetworkFailure]);
        if fail_write {
            harness.replica.fail_next_commits(1);
        }
        if through_sync {
            assert!(matches!(
                sync(&harness).await,
                outcome::CompletionResult::Retry
            ));
        } else {
            let pass = harness.runtime.dispatch_eligible_operations().await;
            assert!(if fail_write {
                matches!(pass, dispatch::DispatchPass::Parked)
            } else {
                matches!(pass, dispatch::DispatchPass::Progressed)
            });
        }
        let pending = harness.operation().unwrap();
        assert_eq!(pending.request, original.request);
        assert_eq!(pending.legacy_admission, original.legacy_admission);
        if fail_write {
            assert_eq!(pending, original);
            assert_eq!(harness.replica.failed_commits(), 1);
        } else {
            assert_eq!(pending.scheduling.attempt_count, 1);
            assert!(pending.scheduling.not_before_ms > harness.clock.now());
        }
        assert!(harness
            .runtime
            .replica
            .snapshot(&harness.account_id)
            .unwrap()
            .receipts
            .is_empty());
        assert_eq!(harness.server.created_items(), vec![ITEM.to_owned()]);
        harness.runtime.close().await;
    }
}

struct LookupGate {
    server: Arc<FakeServer>,
    arrived: tokio::sync::Notify,
    release: tokio::sync::Notify,
}

#[async_trait::async_trait]
impl crate::http_transport::SerializedHttpExecutor for LookupGate {
    fn cancel(&self, dispatch_id: &str) {
        crate::http_transport::SerializedHttpExecutor::cancel(self.server.as_ref(), dispatch_id);
    }
    async fn invoke(&self, request: zeroize::Zeroizing<String>) -> Result<String, RuntimeError> {
        let value: serde_json::Value = serde_json::from_str(&request).unwrap();
        let lookup = value["url"].as_str().unwrap().contains("/operations/");
        let result =
            crate::http_transport::SerializedHttpExecutor::invoke(self.server.as_ref(), request)
                .await;
        if lookup {
            self.arrived.notify_one();
            self.release.notified().await;
        }
        result
    }
}

#[tokio::test]
async fn held_create_scope_loss_during_lookup_cannot_authorize_a_later_replay() {
    for (through_sync, replace_incarnation) in
        [(false, false), (true, false), (false, true), (true, true)]
    {
        let mut harness = held("failed").await;
        retain_old_effect(&harness, false);
        let gate = Arc::new(LookupGate {
            server: harness.server.clone(),
            arrived: tokio::sync::Notify::new(),
            release: tokio::sync::Notify::new(),
        });
        let runtime = Runtime::with_test_dispatch_environment(
            harness.replica.clone(),
            harness.platform.clone(),
            gate.clone(),
            auth_config(),
            harness.clock.clone(),
            harness.timer.clone(),
        );
        runtime.replica.load(&harness.account_id).await.unwrap();
        runtime.unlock_account(&harness.account_id).await.unwrap();
        let old = std::mem::replace(&mut harness.runtime, runtime.clone());
        old.close().await;
        let account = harness.account_id.clone();
        let running = tokio::spawn(async move {
            if through_sync {
                let snapshot = runtime.replica.snapshot(&account).unwrap();
                let mut session = runtime
                    .platform_storage
                    .load_current_session(&account, &snapshot.incarnation)
                    .await
                    .unwrap()
                    .unwrap();
                let http = crate::auth_http::AuthHttpClient::new(
                    &runtime.http_transport,
                    SERVER_URL,
                    false,
                    auth_config(),
                )
                .unwrap();
                runtime
                    .reconcile_resolved_operation(&account, HELD, &http, &mut session)
                    .await;
            } else {
                runtime.dispatch_once_ignoring_lease(&account, HELD).await;
            }
        });
        gate.arrived.notified().await;
        if replace_incarnation {
            harness
                .replica
                .state
                .invoke(crate::replica::ReplicaPersistenceRequest::DeleteAccount {
                    account_id: harness.account_id.clone(),
                })
                .await
                .unwrap();
            harness
                .replica
                .state
                .install(
                    harness.account_id.clone(),
                    USER.into(),
                    Incarnation::from("replacement-incarnation"),
                )
                .unwrap();
            crate::test_fixtures::seed_ready_personal_vault(
                &harness.replica.state,
                &harness.account_id,
            )
            .unwrap();
            let replacement = harness
                .runtime
                .replica
                .load(&harness.account_id)
                .await
                .unwrap()
                .unwrap();
            gate.release.notify_one();
            running.await.unwrap();
            assert_eq!(
                harness.server.creates(),
                1,
                "the old lookup cannot authorize replay in a replacement incarnation"
            );
            assert_eq!(
                harness
                    .runtime
                    .replica
                    .snapshot(&harness.account_id)
                    .unwrap(),
                replacement
            );
            assert_eq!(
                harness.replica.state.snapshot(&harness.account_id).unwrap(),
                replacement
            );
            harness.runtime.close().await;
            continue;
        }
        let runtime = harness.runtime.clone();
        let closing = tokio::spawn(async move {
            runtime.close().await;
        });
        until("Runtime close fences held lookup", || {
            harness.runtime.is_closed()
        })
        .await;
        gate.release.notify_one();
        running.await.unwrap();
        closing.await.unwrap();
        assert_eq!(
            harness.server.creates(),
            1,
            "only the historical effect ran; no post-close replay"
        );
        assert_eq!(
            harness
                .replica
                .state
                .snapshot(&harness.account_id)
                .unwrap()
                .operations
                .len(),
            1
        );
    }
}

struct LostReceiptReply {
    replica: Arc<PlainReplica>,
    armed: AtomicBool,
}

#[async_trait::async_trait]
impl crate::replica::SerializedReplicaExecutor for LostReceiptReply {
    async fn invoke(&self, request_json: String) -> Result<String, RuntimeError> {
        use crate::replica::persistence_contract::{
            PreparedReplicaWrite, ReplicaPersistenceRequest, ReplicaStore,
        };
        let request: ReplicaPersistenceRequest = serde_json::from_str(&request_json).unwrap();
        let receipt = matches!(&request,ReplicaPersistenceRequest::Commit{prepared} if prepared.writes.iter().any(|write| matches!(write,PreparedReplicaWrite::Put{row} if row.store==ReplicaStore::OperationReceipts)));
        let result =
            crate::replica::SerializedReplicaExecutor::invoke(self.replica.as_ref(), request_json)
                .await?;
        if receipt && self.armed.swap(false, Ordering::SeqCst) {
            return Err(RuntimeError::new(
                RuntimeErrorCode::SourceFailure,
                "injected lost receipt acknowledgement",
            ));
        }
        Ok(result)
    }
}

#[tokio::test]
async fn held_create_lost_receipt_acknowledgement_reopens_without_replaying_or_losing_new_work() {
    for through_sync in [false, true] {
        let mut harness = held("failed").await;
        retain_old_effect(&harness, false);
        let (active, overlay) = accept_new_same_item(&harness).await;
        let ambiguous = Arc::new(LostReceiptReply {
            replica: harness.replica.clone(),
            armed: AtomicBool::new(true),
        });
        reopen(&mut harness, ambiguous.clone()).await;
        if through_sync {
            sync(&harness).await;
        } else {
            harness
                .runtime
                .dispatch_once_ignoring_lease(&harness.account_id, HELD)
                .await;
        }
        assert!(!ambiguous.armed.load(Ordering::SeqCst));
        let replica = harness.replica.clone();
        reopen(&mut harness, replica).await;
        let after = harness
            .runtime
            .replica
            .snapshot(&harness.account_id)
            .unwrap();
        assert_eq!(after.operations, vec![active]);
        assert_eq!(after.items, vec![overlay]);
        assert_eq!(after.receipts.len(), 1);
        assert_eq!(after.receipts[0].operation_id, HELD);
        let calls = harness.server.requests.lock().unwrap().len();
        harness
            .runtime
            .dispatch_once_ignoring_lease(&harness.account_id, HELD)
            .await;
        assert!(matches!(
            sync(&harness).await,
            outcome::CompletionResult::Completed
        ));
        assert_eq!(harness.server.requests.lock().unwrap().len(), calls);
        assert_eq!(harness.server.created_items(), vec![ITEM.to_owned()]);
        harness.runtime.close().await;
    }
}

#[tokio::test]
async fn captured_failed_create_proof_completes_only_its_overlay_and_preserves_newer_work() {
    for through_sync in [false, true] {
        for rejected in [false, true] {
            for replacement in [false, true] {
                let harness = held_fixture("failed", 0, 0, true).await;
                let original = retain_old_effect(&harness, rejected);
                let captured = captured_overlay(&original);
                assert_eq!(
                    visible_held_item(&harness).status,
                    crate::ItemProjectionStatus::Failed
                );
                let newer = if replacement {
                    let newer = accept_new_same_item(&harness).await;
                    assert_eq!(
                        visible_held_item(&harness).status,
                        crate::ItemProjectionStatus::Pending
                    );
                    Some(newer)
                } else {
                    None
                };
                if through_sync {
                    assert!(matches!(
                        sync(&harness).await,
                        outcome::CompletionResult::Completed
                    ));
                } else {
                    harness
                        .runtime
                        .dispatch_once_ignoring_lease(&harness.account_id, HELD)
                        .await;
                }
                let after = harness
                    .runtime
                    .replica
                    .load(&harness.account_id)
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(after.receipts.len(), 1);
                assert_eq!(after.receipts[0].operation_id, HELD);
                assert_eq!(
                    after.receipts[0].request_fingerprint,
                    original.request_fingerprint
                );
                if rejected {
                    assert!(
                        matches!(
                            after.receipts[0].result,
                            crate::replica::OperationOutcomeResult::Rejected {
                                code: crate::replica::OperationRejectionCode::VaultReadOnly,
                                ..
                            }
                        ),
                        "captured item_id_conflict is not the fresh proven rejection"
                    );
                } else {
                    assert!(matches!(
                        after.receipts[0].result,
                        crate::replica::OperationOutcomeResult::Applied { .. }
                    ));
                }
                if let Some((operation, overlay)) = newer {
                    assert_eq!(after.operations, vec![operation]);
                    assert_eq!(after.items, vec![overlay]);
                    assert_eq!(
                        visible_held_item(&harness).status,
                        crate::ItemProjectionStatus::Pending
                    );
                } else {
                    assert!(after.operations.is_empty());
                    if rejected {
                        assert_eq!(after.items, vec![captured]);
                        assert_eq!(
                            visible_held_item(&harness).status,
                            crate::ItemProjectionStatus::Failed
                        );
                    } else {
                        assert!(after.items.is_empty());
                        assert_eq!(
                            visible_held_item(&harness).status,
                            crate::ItemProjectionStatus::Authoritative
                        );
                    }
                }
                assert_eq!(harness.server.outcome_lookups(), 1);
                assert_eq!(harness.server.creates(), 2);
                assert_eq!(harness.server.created_items().len(), usize::from(!rejected));
                harness.runtime.close().await;
            }
        }
    }
}

#[tokio::test]
async fn captured_failed_create_retirement_erases_visibility_without_losing_or_reviving_work() {
    for rejected in [false, true] {
        let harness = held_fixture("failed", 0, 0, true).await;
        assert_eq!(
            visible_held_item(&harness).status,
            crate::ItemProjectionStatus::Failed
        );
        let original = harness.operation().unwrap();
        let snapshot = harness
            .runtime
            .replica
            .snapshot(&harness.account_id)
            .unwrap();
        harness
            .runtime
            .replica
            .execute(GuardedCommitPlan::new(
                snapshot.account_id,
                snapshot.incarnation,
                snapshot.revision,
                snapshot.lock_epoch,
                vec![PlanMutation::RetireVaults {
                    vault_ids: vec![TEST_VAULT_ID.into()],
                }],
            ))
            .await
            .unwrap();
        let retired = harness
            .runtime
            .replica
            .load(&harness.account_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(retired.operations, vec![original.clone()]);
        assert!(retired.items.is_empty());
        assert!(retired
            .bootstrap
            .pending_vault_retirements
            .contains(&TEST_VAULT_ID.to_owned()));
        let assert_hidden = || {
            harness
                .runtime
                .decrypt_visible_items(&harness.account_id)
                .unwrap();
            let RuntimeProjection::Items(items) = harness
                .runtime
                .projection(&ObservationRequest::Items {
                    account_id: harness.account_id.clone(),
                })
                .unwrap()
                .projection
            else {
                panic!("expected Items");
            };
            assert!(!items.items.iter().any(|item| item.item_id == ITEM));
        };
        assert_hidden();
        assert!(matches!(
            sync(&harness).await,
            outcome::CompletionResult::Retry
        ));
        assert_eq!(
            harness
                .runtime
                .replica
                .snapshot(&harness.account_id)
                .unwrap(),
            retired
        );
        assert_eq!(harness.server.outcome_lookups(), 1);
        assert_eq!(harness.server.creates(), 0);
        assert!(harness.timer.requested().is_empty());
        // A previously in-flight original request can become retained after the missing probe.
        // Its actual Server result still cannot resurrect retired local read authority.
        retain_old_effect(&harness, rejected);
        assert!(matches!(
            sync(&harness).await,
            outcome::CompletionResult::Completed
        ));
        let completed = harness
            .runtime
            .replica
            .load(&harness.account_id)
            .await
            .unwrap()
            .unwrap();
        assert!(completed.operations.is_empty());
        assert!(completed.items.is_empty());
        assert!(!completed
            .bootstrap
            .snapshot()
            .visible_items
            .iter()
            .any(|item| item.id == ITEM));
        assert_eq!(completed.receipts.len(), 1);
        assert_eq!(
            completed.receipts[0].request_fingerprint,
            original.request_fingerprint
        );
        assert_eq!(
            harness.server.creates(),
            2,
            "one external original effect and one exact retained-proof replay"
        );
        assert_eq!(harness.server.created_items().len(), usize::from(!rejected));
        assert_hidden();
        harness.runtime.close().await;
    }
}
