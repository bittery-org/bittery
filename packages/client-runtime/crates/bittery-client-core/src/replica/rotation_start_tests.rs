use super::*;

/// Server rotation::fingerprint for the closed Team-leave route, an empty body and team-1.
const TEAM_LEAVE_START_FINGERPRINT: &str =
    "7a6deb2215d2e2f11538109abe9d6195e32123b831bebc09a9140b975c20106a";

fn team_leave_start(operation_id: &str) -> OperationRecord {
    serde_json::from_value(serde_json::json!({
        "operationId": operation_id,
        "kind": "create_team_leave_rotation_plans",
        "target": {"type": "team", "teamId": "team-1"},
        "request": {
            "method": "POST",
            "path": "/api/v1/teams/team-1/leave-rotation-plans",
            "headers": [],
            "body": []
        },
        "requestFingerprint": TEAM_LEAVE_START_FINGERPRINT,
        "scheduling": {"attemptCount": "0", "notBeforeMs": "0"}
    }))
    .expect("closed Team target and Rotation kind must decode")
}

fn empty_team_start_completion(operation_id: &str) -> PlanMutation {
    serde_json::from_value(serde_json::json!({
        "type": "reconcileRotationStart",
        "outcome": {
            "operationId": operation_id,
            "requestFingerprint": TEAM_LEAVE_START_FINGERPRINT,
            "result": {"type": "rotationStartApplied", "plans": []}
        },
        "intent": {"type": "teamLeave", "teamId": "team-1"},
        "validatedPlans": []
    }))
    .expect("the applied Rotation start needs a closed atomic journal mutation")
}

#[test]
fn team_leave_start_retains_the_empty_request_with_a_real_team_target() {
    let operation = team_leave_start("rotation-start-1");

    let state = InMemoryReplica::default();
    let account = AccountId::from("rotation-account");
    state
        .install(
            account.clone(),
            "user-1".into(),
            Incarnation::from("incarnation-1"),
        )
        .unwrap();
    let before = state.snapshot(&account).unwrap();
    state
        .execute(GuardedCommitPlan::new(
            account.clone(),
            before.incarnation,
            before.revision,
            before.lock_epoch,
            vec![PlanMutation::AcceptOperation(operation.clone())],
        ))
        .expect("the empty Server start request must be durable before HTTP");
    let accepted = state.snapshot(&account).unwrap();
    assert_eq!(accepted.operations, vec![operation.clone()]);
    assert_eq!(
        operation.accepted_vault_ids().unwrap(),
        Vec::<String>::new()
    );
}

#[test]
fn empty_team_start_commits_its_receipt_and_attempt_in_one_replica_revision() {
    let operation = team_leave_start("rotation-start-2");
    let state = InMemoryReplica::default();
    let account = AccountId::from("rotation-account");
    state
        .install(
            account.clone(),
            "user-1".into(),
            Incarnation::from("incarnation-1"),
        )
        .unwrap();
    let initial = state.snapshot(&account).unwrap();
    state
        .execute(GuardedCommitPlan::new(
            account.clone(),
            initial.incarnation.clone(),
            initial.revision,
            initial.lock_epoch,
            vec![PlanMutation::AcceptOperation(operation)],
        ))
        .unwrap();
    let accepted = state.snapshot(&account).unwrap();
    assert_eq!(accepted.operations.len(), 1);
    assert!(accepted.receipts.is_empty());
    assert!(serde_json::to_value(&accepted)
        .unwrap()
        .get("rotationAttempts")
        .is_none());

    // SHA-256 of the canonical empty plan list `[]`; the compact receipt keeps only this digest,
    // while the attempt owns the complete list, including the valid empty Team result.
    state
        .execute(GuardedCommitPlan::new(
            account.clone(),
            accepted.incarnation.clone(),
            accepted.revision,
            accepted.lock_epoch,
            vec![empty_team_start_completion("rotation-start-2")],
        ))
        .unwrap();
    let completed = state.snapshot(&account).unwrap();
    assert!(completed.operations.is_empty());
    assert_eq!(completed.receipts.len(), 1);
    assert_eq!(completed.receipts[0].operation_id, "rotation-start-2");
    assert_eq!(
        serde_json::to_value(&completed.receipts[0].result).unwrap(),
        serde_json::json!({
            "type": "rotationStartAppliedReceipt",
            "planSetFingerprint": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
            "planCount": 0
        })
    );
    let value = serde_json::to_value(&completed).unwrap();
    assert_eq!(value["rotationAttempts"].as_array().unwrap().len(), 1);
    assert_eq!(value["rotationAttempts"][0]["plans"], serde_json::json!([]));
    assert_eq!(value["rotationAttempts"][0]["phase"]["type"], "prepared");
}

#[test]
fn applied_start_receipt_without_its_attempt_refuses_reload_and_complete_recovery() {
    use crate::replica::{
        persistence_contract::{reconstruct_snapshot, snapshot_rows, ReplicaHead, ReplicaStore},
        recovery::RecoveryCoverage,
    };

    let state = InMemoryReplica::default();
    let account = AccountId::from("rotation-account");
    state
        .install(
            account.clone(),
            "user-1".into(),
            Incarnation::from("incarnation-1"),
        )
        .unwrap();
    let initial = state.snapshot(&account).unwrap();
    state
        .execute(GuardedCommitPlan::new(
            account.clone(),
            initial.incarnation,
            initial.revision,
            initial.lock_epoch,
            vec![PlanMutation::AcceptOperation(team_leave_start(
                "lost-attempt",
            ))],
        ))
        .unwrap();
    let accepted = state.snapshot(&account).unwrap();
    state
        .execute(GuardedCommitPlan::new(
            account.clone(),
            accepted.incarnation,
            accepted.revision,
            accepted.lock_epoch,
            vec![empty_team_start_completion("lost-attempt")],
        ))
        .unwrap();
    let complete = state.snapshot(&account).unwrap();
    let head = ReplicaHead {
        account_id: complete.account_id.clone(),
        user_id: complete.user_id.clone(),
        incarnation: complete.incarnation.clone(),
        replica_revision: complete.revision,
        lock_epoch: complete.lock_epoch,
        failure: complete.failure,
    };
    let rows = snapshot_rows(complete.clone()).unwrap();
    assert!(reconstruct_snapshot(&account, Some(head.clone()), rows.clone()).is_ok());
    let mut intact = RecoveryCoverage::new(head.clone()).unwrap();
    for row in &rows {
        intact
            .push_row(row.store, &row.key.record_id, &row.payload_json)
            .unwrap();
    }
    intact.finish().unwrap();

    let missing_attempt: Vec<_> = rows
        .into_iter()
        .filter(|row| row.store != ReplicaStore::RotationAttempts)
        .collect();
    assert_eq!(missing_attempt.len(), 1);
    assert!(reconstruct_snapshot(&account, Some(head.clone()), missing_attempt.clone()).is_err());
    let mut recovery = RecoveryCoverage::new(head.clone()).unwrap();
    for row in &missing_attempt {
        recovery
            .push_row(row.store, &row.key.record_id, &row.payload_json)
            .unwrap();
    }
    assert!(recovery.finish().is_err());

    let mut changed_fingerprint = snapshot_rows(complete.clone()).unwrap();
    let receipt_row = changed_fingerprint
        .iter_mut()
        .find(|row| row.store == ReplicaStore::OperationReceipts)
        .unwrap();
    let mut receipt: OperationReceiptRecord =
        serde_json::from_str(&receipt_row.payload_json).unwrap();
    receipt.request_fingerprint = Sha256Fingerprint::of_bytes(b"changed-start-request");
    receipt_row.payload_json = serde_json::to_string(&receipt).unwrap();
    assert!(reconstruct_snapshot(&account, Some(head.clone()), changed_fingerprint).is_err());

    // A corrupt Vault receipt with the new Team target must be rejected as stored data,
    // before any Vault-only accessor can panic during load or recovery capture.
    let mut wrong_kind = snapshot_rows(complete).unwrap();
    let (record_id, payload_json) = {
        let receipt_row = wrong_kind
            .iter_mut()
            .find(|row| row.store == ReplicaStore::OperationReceipts)
            .unwrap();
        let mut receipt: OperationReceiptRecord =
            serde_json::from_str(&receipt_row.payload_json).unwrap();
        receipt.kind = OperationKind::CreateVault;
        receipt.result = OperationOutcomeResult::VaultApplied {
            vault_id: "vault-1".into(),
        };
        receipt_row.payload_json = serde_json::to_string(&receipt).unwrap();
        (
            receipt_row.key.record_id.clone(),
            receipt_row.payload_json.clone(),
        )
    };
    assert!(reconstruct_snapshot(&account, Some(head.clone()), wrong_kind.clone()).is_err());
    let mut recovery = RecoveryCoverage::new(head).unwrap();
    assert!(recovery
        .push_row(ReplicaStore::OperationReceipts, &record_id, &payload_json)
        .is_err());
}

#[test]
fn rotation_start_refuses_a_changed_plan_list_and_generic_completion() {
    let state = InMemoryReplica::default();
    let account = AccountId::from("rotation-account");
    state
        .install(
            account.clone(),
            "user-1".into(),
            Incarnation::from("incarnation-1"),
        )
        .unwrap();
    let initial = state.snapshot(&account).unwrap();
    state
        .execute(GuardedCommitPlan::new(
            account.clone(),
            initial.incarnation,
            initial.revision,
            initial.lock_epoch,
            vec![PlanMutation::AcceptOperation(team_leave_start(
                "rotation-start-3",
            ))],
        ))
        .unwrap();
    let accepted = state.snapshot(&account).unwrap();
    let mut changed = empty_team_start_completion("rotation-start-3");
    let PlanMutation::ReconcileRotationStart {
        validated_plans, ..
    } = &mut changed
    else {
        unreachable!();
    };
    validated_plans.push(RotationPlanRecord {
        plan_id: "unexpected-plan".into(),
        vault_id: "vault-1".into(),
        initiator_user_id: "user-1".into(),
        expected_key_version: 1,
        idle_expires_at: "2026-09-23T12:00:00Z".into(),
        absolute_expires_at: "2026-09-23T12:00:00Z".into(),
    });
    let attempted = |mutation| {
        GuardedCommitPlan::new(
            account.clone(),
            accepted.incarnation.clone(),
            accepted.revision,
            accepted.lock_epoch,
            vec![mutation],
        )
    };
    assert!(state.execute(attempted(changed)).is_err());
    assert!(state
        .execute(attempted(PlanMutation::ReconcileRetainedResult {
            outcome: ObservedOutcome {
                operation_id: "rotation-start-3".into(),
                request_fingerprint: team_leave_start("rotation-start-3").request_fingerprint,
                result: OperationOutcomeResult::RotationStartApplied { plans: Vec::new() },
            },
        }))
        .is_err());
    assert!(state
        .execute(attempted(PlanMutation::RemoveOperation {
            operation_id: "rotation-start-3".into(),
        }))
        .is_err());
    assert_eq!(state.snapshot(&account).unwrap(), accepted);
}

#[tokio::test]
async fn sqlite_start_accept_atomically_freezes_original_preflight_generation() {
    use std::{path::PathBuf, sync::Arc};
    struct TemporaryDatabase(PathBuf);
    impl Drop for TemporaryDatabase {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    let path = std::env::temp_dir().join(format!(
        "bittery-rotation-start-bound-{}.sqlite3",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&path);
    let _cleanup = TemporaryDatabase(path.clone());
    let account = AccountId::from("rotation-account");
    let store = Replica::new(Arc::new(SqliteReplica::open(&path).unwrap()));
    store
        .install_or_replace(
            account.clone(),
            "user-1".into(),
            Incarnation::from("incarnation-1"),
        )
        .await
        .unwrap();
    let before = store.load(&account).await.unwrap().unwrap();
    drop(store);
    let accept = vec![
        PlanMutation::AcceptOperation(team_leave_start("bound-start")),
        PlanMutation::BindRotationStart {
            start_operation_id: "bound-start".into(),
            intent: RotationIntent::TeamLeave {
                team_id: "team-1".into(),
            },
            authority_generation_id: "original-proved-generation".into(),
            team_role: crate::server_contract::TeamRole::Member,
        },
    ];
    for boundary in 1..=2 {
        let failing = Replica::new(Arc::new(
            SqliteReplica::open_failing_after(&path, boundary).unwrap(),
        ));
        assert!(failing
            .execute(GuardedCommitPlan::new(
                account.clone(),
                before.incarnation.clone(),
                before.revision,
                before.lock_epoch,
                accept.clone(),
            ))
            .await
            .is_err());
        drop(failing);
        let reopened = Replica::new(Arc::new(SqliteReplica::open(&path).unwrap()));
        assert_eq!(reopened.load(&account).await.unwrap().unwrap(), before);
    }
    let accepted = Replica::new(Arc::new(SqliteReplica::open(&path).unwrap()));
    accepted
        .execute(GuardedCommitPlan::new(
            account.clone(),
            before.incarnation.clone(),
            before.revision,
            before.lock_epoch,
            accept,
        ))
        .await
        .unwrap();
    drop(accepted);
    let reopened = Replica::new(Arc::new(SqliteReplica::open(&path).unwrap()));
    let starting = reopened.load(&account).await.unwrap().unwrap();
    assert_eq!(starting.operations.len(), 1);
    assert!(matches!(
        starting.rotation_attempts[0].phase,
        RotationAttemptPhase::Starting
    ));
    assert_eq!(
        starting.rotation_attempts[0]
            .authority_generation_id
            .as_deref(),
        Some("original-proved-generation")
    );
    assert_eq!(
        starting.rotation_attempts[0].team_role,
        Some(crate::server_contract::TeamRole::Member)
    );
    assert!(!starting.rotation_attempts[0].presentation_acknowledged);
    let mut legacy_attempt = serde_json::to_value(&starting.rotation_attempts[0]).unwrap();
    legacy_attempt.as_object_mut().unwrap().remove("teamRole");
    legacy_attempt
        .as_object_mut()
        .unwrap()
        .remove("presentationAcknowledged");
    let loaded_legacy: RotationAttemptRecord = serde_json::from_value(legacy_attempt).unwrap();
    assert!(loaded_legacy.team_role.is_none());
    assert!(!loaded_legacy.presentation_acknowledged);
    reopened
        .execute(GuardedCommitPlan::new(
            account.clone(),
            starting.incarnation.clone(),
            starting.revision,
            starting.lock_epoch,
            vec![empty_team_start_completion("bound-start")],
        ))
        .await
        .unwrap();
    drop(reopened);
    let finished = Replica::new(Arc::new(SqliteReplica::open(&path).unwrap()))
        .load(&account)
        .await
        .unwrap()
        .unwrap();
    assert!(finished.operations.is_empty());
    assert_eq!(finished.receipts.len(), 1);
    assert!(matches!(
        finished.rotation_attempts[0].phase,
        RotationAttemptPhase::Prepared
    ));
    assert_eq!(
        finished.rotation_attempts[0]
            .authority_generation_id
            .as_deref(),
        Some("original-proved-generation")
    );
}

#[test]
fn rejected_team_start_keeps_a_typed_receipt_without_an_attempt() {
    let state = InMemoryReplica::default();
    let account = AccountId::from("rotation-account");
    state
        .install(
            account.clone(),
            "user-1".into(),
            Incarnation::from("incarnation-1"),
        )
        .unwrap();
    let initial = state.snapshot(&account).unwrap();
    state
        .execute(GuardedCommitPlan::new(
            account.clone(),
            initial.incarnation,
            initial.revision,
            initial.lock_epoch,
            vec![PlanMutation::AcceptOperation(team_leave_start(
                "rotation-start-4",
            ))],
        ))
        .unwrap();
    let accepted = state.snapshot(&account).unwrap();
    state
        .execute(GuardedCommitPlan::new(
            account.clone(),
            accepted.incarnation,
            accepted.revision,
            accepted.lock_epoch,
            vec![PlanMutation::ReconcileRotationStart {
                outcome: ObservedOutcome {
                    operation_id: "rotation-start-4".into(),
                    request_fingerprint: team_leave_start("rotation-start-4").request_fingerprint,
                    result: OperationOutcomeResult::RotationStartRejected {
                        code: RotationStartRejectionCode::TeamOwnerLeaveForbidden,
                    },
                },
                intent: RotationIntent::TeamLeave {
                    team_id: "team-1".into(),
                },
                validated_plans: Vec::new(),
            }],
        ))
        .unwrap();
    let completed = state.snapshot(&account).unwrap();
    assert!(completed.operations.is_empty());
    assert!(completed.rotation_attempts.is_empty());
    assert!(matches!(
        completed.receipts[0].result,
        OperationOutcomeResult::RotationStartRejected {
            code: RotationStartRejectionCode::TeamOwnerLeaveForbidden
        }
    ));
}

#[cfg(not(target_arch = "wasm32"))]
#[tokio::test]
async fn sqlite_start_commit_reopens_before_or_after_but_never_with_half_a_journal() {
    use std::{path::PathBuf, sync::Arc};
    struct TemporaryDatabase(PathBuf);
    impl Drop for TemporaryDatabase {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    let path = std::env::temp_dir().join(format!(
        "bittery-rotation-start-atomic-{}.sqlite3",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&path);
    let _cleanup = TemporaryDatabase(path.clone());
    let account = AccountId::from("rotation-account");
    let first = Replica::new(Arc::new(SqliteReplica::open(&path).unwrap()));
    first
        .install_or_replace(
            account.clone(),
            "user-1".into(),
            Incarnation::from("incarnation-1"),
        )
        .await
        .unwrap();
    let initial = first.load(&account).await.unwrap().unwrap();
    first
        .execute(GuardedCommitPlan::new(
            account.clone(),
            initial.incarnation,
            initial.revision,
            initial.lock_epoch,
            vec![PlanMutation::AcceptOperation(team_leave_start(
                "rotation-start-sqlite",
            ))],
        ))
        .await
        .unwrap();
    let accepted = first.load(&account).await.unwrap().unwrap();
    drop(first);
    for boundary in 1..=4 {
        let failing = Replica::new(Arc::new(
            SqliteReplica::open_failing_after(&path, boundary).unwrap(),
        ));
        let result = failing
            .execute(GuardedCommitPlan::new(
                account.clone(),
                accepted.incarnation.clone(),
                accepted.revision,
                accepted.lock_epoch,
                vec![empty_team_start_completion("rotation-start-sqlite")],
            ))
            .await;
        assert!(
            result.is_err(),
            "SQLite fault boundary {boundary} unexpectedly committed"
        );
        drop(failing);
        let reopened = Replica::new(Arc::new(SqliteReplica::open(&path).unwrap()));
        assert_eq!(reopened.load(&account).await.unwrap().unwrap(), accepted);
    }
    let succeeding = Replica::new(Arc::new(SqliteReplica::open(&path).unwrap()));
    succeeding
        .execute(GuardedCommitPlan::new(
            account.clone(),
            accepted.incarnation.clone(),
            accepted.revision,
            accepted.lock_epoch,
            vec![empty_team_start_completion("rotation-start-sqlite")],
        ))
        .await
        .unwrap();
    drop(succeeding);
    let reopened = Replica::new(Arc::new(SqliteReplica::open(&path).unwrap()));
    let complete = reopened.load(&account).await.unwrap().unwrap();
    assert!(complete.operations.is_empty());
    assert_eq!(complete.receipts.len(), 1);
    assert_eq!(complete.rotation_attempts.len(), 1);
    assert_eq!(
        complete.rotation_attempts[0].plans,
        Vec::<RotationPlanRecord>::new()
    );
}

#[cfg(not(target_arch = "wasm32"))]
#[tokio::test]
async fn sqlite_zero_plan_finalize_accept_and_terminal_receipt_are_atomic_after_consumption() {
    use std::{path::PathBuf, sync::Arc};
    struct TemporaryDatabase(PathBuf);
    impl Drop for TemporaryDatabase {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    let path = std::env::temp_dir().join(format!(
        "bittery-rotation-finalize-atomic-{}.sqlite3",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&path);
    let _cleanup = TemporaryDatabase(path.clone());
    let account = AccountId::from("rotation-account");
    let store = Replica::new(Arc::new(SqliteReplica::open(&path).unwrap()));
    store
        .install_or_replace(
            account.clone(),
            "user-1".into(),
            Incarnation::from("incarnation-1"),
        )
        .await
        .unwrap();
    let initial = store.load(&account).await.unwrap().unwrap();
    store
        .execute(GuardedCommitPlan::new(
            account.clone(),
            initial.incarnation.clone(),
            initial.revision,
            initial.lock_epoch,
            vec![PlanMutation::AcceptOperation(team_leave_start(
                "start-finalize-sqlite",
            ))],
        ))
        .await
        .unwrap();
    let accepted = store.load(&account).await.unwrap().unwrap();
    store
        .execute(GuardedCommitPlan::new(
            account.clone(),
            accepted.incarnation.clone(),
            accepted.revision,
            accepted.lock_epoch,
            vec![empty_team_start_completion("start-finalize-sqlite")],
        ))
        .await
        .unwrap();
    let prepared = store.load(&account).await.unwrap().unwrap();
    store
        .execute(GuardedCommitPlan::new(
            account.clone(),
            prepared.incarnation.clone(),
            prepared.revision,
            prepared.lock_epoch,
            vec![PlanMutation::ConsumeRotationAttempt {
                start_operation_id: "start-finalize-sqlite".into(),
                attempt_id: "attempt-once".into(),
            }],
        ))
        .await
        .unwrap();
    let consumed = store.load(&account).await.unwrap().unwrap();
    assert!(matches!(
        consumed.rotation_attempts[0].phase,
        RotationAttemptPhase::Consumed { .. }
    ));
    assert!(store
        .execute(GuardedCommitPlan::new(
            account.clone(),
            consumed.incarnation.clone(),
            consumed.revision,
            consumed.lock_epoch,
            vec![PlanMutation::ConsumeRotationAttempt {
                start_operation_id: "start-finalize-sqlite".into(),
                attempt_id: "attempt-twice".into(),
            }]
        ))
        .await
        .is_err());
    let finalize = team_leave_finalize_operation("team-1", &[]).unwrap();
    drop(store);
    for boundary in 1..=3 {
        let failing = Replica::new(Arc::new(
            SqliteReplica::open_failing_after(&path, boundary).unwrap(),
        ));
        let result = failing
            .execute(GuardedCommitPlan::new(
                account.clone(),
                consumed.incarnation.clone(),
                consumed.revision,
                consumed.lock_epoch,
                vec![PlanMutation::AcceptRotationFinalize {
                    start_operation_id: "start-finalize-sqlite".into(),
                    attempt_id: "attempt-once".into(),
                    operation: finalize.clone(),
                }],
            ))
            .await;
        assert!(
            result.is_err(),
            "finalize acceptance fault boundary {boundary} committed"
        );
        drop(failing);
        let reopened = Replica::new(Arc::new(SqliteReplica::open(&path).unwrap()));
        assert_eq!(reopened.load(&account).await.unwrap().unwrap(), consumed);
    }
    let succeeding = Replica::new(Arc::new(SqliteReplica::open(&path).unwrap()));
    succeeding
        .execute(GuardedCommitPlan::new(
            account.clone(),
            consumed.incarnation.clone(),
            consumed.revision,
            consumed.lock_epoch,
            vec![PlanMutation::AcceptRotationFinalize {
                start_operation_id: "start-finalize-sqlite".into(),
                attempt_id: "attempt-once".into(),
                operation: finalize.clone(),
            }],
        ))
        .await
        .unwrap();
    let finalizing = succeeding.load(&account).await.unwrap().unwrap();
    assert_eq!(finalizing.operations, vec![finalize.clone()]);
    assert!(matches!(
        finalizing.rotation_attempts[0].phase,
        RotationAttemptPhase::Finalizing { .. }
    ));
    drop(succeeding);
    let outcome = ObservedOutcome {
        operation_id: finalize.operation_id.clone(),
        request_fingerprint: finalize.request_fingerprint,
        result: OperationOutcomeResult::RotationFinalizeApplied {
            personal_team_id: "personal-1".into(),
            rotations: Vec::new(),
        },
    };
    for boundary in 1..=3 {
        let failing = Replica::new(Arc::new(
            SqliteReplica::open_failing_after(&path, boundary).unwrap(),
        ));
        let result = failing
            .execute(GuardedCommitPlan::new(
                account.clone(),
                finalizing.incarnation.clone(),
                finalizing.revision,
                finalizing.lock_epoch,
                vec![PlanMutation::ReconcileRotationFinalize {
                    start_operation_id: "start-finalize-sqlite".into(),
                    outcome: outcome.clone(),
                }],
            ))
            .await;
        assert!(
            result.is_err(),
            "terminal reconciliation fault boundary {boundary} committed"
        );
        drop(failing);
        let reopened = Replica::new(Arc::new(SqliteReplica::open(&path).unwrap()));
        assert_eq!(reopened.load(&account).await.unwrap().unwrap(), finalizing);
    }
    let succeeding = Replica::new(Arc::new(SqliteReplica::open(&path).unwrap()));
    succeeding
        .execute(GuardedCommitPlan::new(
            account.clone(),
            finalizing.incarnation.clone(),
            finalizing.revision,
            finalizing.lock_epoch,
            vec![PlanMutation::ReconcileRotationFinalize {
                start_operation_id: "start-finalize-sqlite".into(),
                outcome,
            }],
        ))
        .await
        .unwrap();
    drop(succeeding);
    let reopened = Replica::new(Arc::new(SqliteReplica::open(&path).unwrap()));
    let terminal = reopened.load(&account).await.unwrap().unwrap();
    assert!(terminal.operations.is_empty());
    assert_eq!(terminal.receipts.len(), 2);
    assert!(matches!(
        terminal.rotation_attempts[0].phase,
        RotationAttemptPhase::AppliedAwaitingRefresh { .. }
    ));
}
