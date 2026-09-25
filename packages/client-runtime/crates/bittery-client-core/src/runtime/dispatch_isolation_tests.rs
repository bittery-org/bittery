//! A finite dispatch scan skips selectively parked work while preserving Account-wide fences.
use super::*;
use crate::Incarnation;

async fn add_account(harness: &Harness) -> AccountId {
    let account = AccountId::from("account-2");
    harness
        .replica
        .state
        .install(account.clone(), USER.into(), Incarnation::from(INCARNATION))
        .unwrap();
    crate::test_fixtures::seed_ready_personal_vault(&harness.replica.state, &account).unwrap();
    harness.runtime.replica.load(&account).await.unwrap();
    harness.runtime.unlock_account(&account).await.unwrap();
    store_session(&harness.runtime, &account, FIRST_TOKEN).await;
    account
}

async fn accept_item(runtime: &Runtime, account: &AccountId) -> String {
    match runtime
        .request(
            RuntimeRequest::CreateItem {
                account_id: account.clone(),
                vault_id: TEST_VAULT_ID.into(),
                draft: draft(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    {
        RuntimeResponse::Accepted { operation_id, .. } => operation_id,
        response => panic!("expected actual Item acceptance, got {response:?}"),
    }
}

async fn account_wide_park(failure: bool) {
    let harness = seeded(false).await;
    accept_item(&harness.runtime, &harness.account_id).await;
    accept_item(&harness.runtime, &harness.account_id).await;
    let original = harness
        .runtime
        .replica
        .snapshot(&harness.account_id)
        .unwrap();
    let first = &original.operations[0];
    let blocked = &original.operations[1];
    let other_account = add_account(&harness).await;
    let other = accept_item(&harness.runtime, &other_account).await;
    if failure {
        // The existing Server fixture identifies reused identity from the exact request bytes.
        harness.server.outcomes.lock().unwrap().insert(
            first.operation_id.clone(),
            StoredOutcome {
                fingerprint: [0; 32],
                result: StoredResult::Applied {
                    item_id: "different-prior-item".into(),
                    version: 1,
                },
            },
        );
    } else {
        store_session(
            &harness.runtime,
            &harness.account_id,
            "refused-first-account-token",
        )
        .await;
    }
    assert!(matches!(
        harness.runtime.dispatch_eligible_operations().await,
        dispatch::DispatchPass::Progressed
    ));
    let after = harness
        .runtime
        .replica
        .snapshot(&harness.account_id)
        .unwrap();
    if failure {
        assert_eq!(after.failure, Some(RuntimeErrorCode::InvariantViolation));
    } else {
        assert_eq!(
            harness
                .runtime
                .waiting_reasons
                .lock()
                .unwrap()
                .get(&harness.account_id),
            Some(&AccountWaitingReason::ReauthenticationRequired)
        );
    }
    assert_eq!(after.operations.len(), 2);
    assert!(after
        .operations
        .iter()
        .any(|operation| operation == blocked));
    let completed = harness.runtime.replica.snapshot(&other_account).unwrap();
    assert!(completed.operations.is_empty());
    assert!(completed
        .receipts
        .iter()
        .any(|receipt| receipt.operation_id == other));
    {
        let requests = harness.server.requests.lock().unwrap();
        assert!(requests
            .iter()
            .any(|request| request.header("idempotency-key") == Some(&first.operation_id)));
        assert!(!requests
            .iter()
            .any(|request| request.header("idempotency-key") == Some(&blocked.operation_id)));
        assert!(requests
            .iter()
            .any(|request| request.header("idempotency-key") == Some(&other)));
    }
    let requests = harness.server.requests.lock().unwrap().len();
    assert!(matches!(
        harness.runtime.dispatch_eligible_operations().await,
        dispatch::DispatchPass::Parked
    ));
    assert_eq!(harness.server.requests.lock().unwrap().len(), requests);
    assert!(harness.timer.requested().is_empty());
    harness.runtime.close().await;
}

#[tokio::test]
async fn new_reauthentication_stops_the_account_but_not_another_account() {
    account_wide_park(false).await;
}

#[tokio::test]
async fn new_account_failure_stops_the_account_but_not_another_account() {
    account_wide_park(true).await;
}

#[tokio::test]
async fn parked_receipt_cleanup_preserves_its_duty_without_starving_another_account() {
    let harness = seeded(false).await;
    crate::runtime::create_vault_tests::seed_rejected_image_cleanup(
        &harness.replica.state,
        "cleanup-without-session",
    )
    .await;
    harness
        .runtime
        .replica
        .load(&harness.account_id)
        .await
        .unwrap();
    let original = harness
        .runtime
        .replica
        .snapshot(&harness.account_id)
        .unwrap();
    assert!(original.receipts[0]
        .create_vault_cleanup
        .as_ref()
        .is_some_and(|cleanup| cleanup.local_artifact_pending || cleanup.remote_staging_pending));
    harness
        .runtime
        .platform_storage
        .remove_current_session(&harness.account_id, &original.incarnation)
        .await
        .unwrap();
    let other_account = add_account(&harness).await;
    let other = accept_item(&harness.runtime, &other_account).await;
    assert!(matches!(
        harness.runtime.dispatch_eligible_operations().await,
        dispatch::DispatchPass::Progressed
    ));
    assert_eq!(
        harness
            .runtime
            .replica
            .snapshot(&harness.account_id)
            .unwrap(),
        original
    );
    assert!(harness
        .runtime
        .replica
        .snapshot(&other_account)
        .unwrap()
        .receipts
        .iter()
        .any(|receipt| receipt.operation_id == other));
    let requests = harness.server.requests.lock().unwrap().len();
    assert!(matches!(
        harness.runtime.dispatch_eligible_operations().await,
        dispatch::DispatchPass::Parked
    ));
    assert_eq!(harness.server.requests.lock().unwrap().len(), requests);
    assert!(harness.timer.requested().is_empty());
    harness.runtime.close().await;
}

#[tokio::test]
async fn newly_unauthenticated_account_does_not_reuse_an_earlier_operations_timer() {
    let harness = seeded(false).await;
    accept_item(&harness.runtime, &harness.account_id).await;
    accept_item(&harness.runtime, &harness.account_id).await;
    let original = harness
        .runtime
        .replica
        .snapshot(&harness.account_id)
        .unwrap();
    let first = original.operations[0].clone();
    let second = original.operations[1].clone();
    {
        let execution = harness
            .runtime
            .account_execution_lock(&harness.account_id)
            .unwrap();
        let _guard = execution.lock().await;
        assert!(harness.runtime.persist_backoff(&original, &first).await);
    }
    let delayed = harness
        .replica
        .state
        .snapshot(&harness.account_id)
        .unwrap()
        .operations[0]
        .clone();
    assert!(delayed.scheduling.not_before_ms > harness.clock.now());
    assert_eq!(delayed.request, first.request);
    assert_eq!(delayed.request_fingerprint, first.request_fingerprint);
    store_session(
        &harness.runtime,
        &harness.account_id,
        "refused-account-token",
    )
    .await;
    assert!(
        matches!(
            harness.runtime.dispatch_eligible_operations().await,
            dispatch::DispatchPass::Parked
        ),
        "Account reauthentication must discard the scan's earlier timer without changing durable backoff"
    );
    assert_eq!(
        harness
            .runtime
            .waiting_reasons
            .lock()
            .unwrap()
            .get(&harness.account_id),
        Some(&AccountWaitingReason::ReauthenticationRequired)
    );
    assert_eq!(
        harness
            .replica
            .state
            .snapshot(&harness.account_id)
            .unwrap()
            .operations[0],
        delayed
    );
    {
        let requests = harness.server.requests.lock().unwrap();
        assert!(!requests
            .iter()
            .any(|request| request.header("idempotency-key") == Some(first.operation_id.as_str())));
        assert!(
            requests
                .iter()
                .any(|request| request.header("idempotency-key")
                    == Some(second.operation_id.as_str()))
        );
    }
    assert!(harness.timer.requested().is_empty());
    harness.runtime.close().await;
}
