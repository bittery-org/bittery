//! Slice B: what happens to an accepted Operation once the network is allowed to fail.
//!
//! The fake Device and fake Server both live in `operation_fixtures`, so these tests and the
//! reconciliation slice argue with the same Server behavior rather than with two stubs.

use super::operation_fixtures::*;
use super::*;
use crate::{
    http_transport::{HttpHeader, HttpMethod},
    replica::{
        GuardedCommitPlan, ImmutableHttpRequest, OperationKind, OperationRecord,
        OperationSchedulingState, PlanMutation, RecomputedPlanResult, Sha256Fingerprint,
    },
    test_fixtures::TEST_VAULT_ID,
};

// ---------------------------------------------------------------- the required behavior

#[tokio::test]
async fn create_share_stays_durable_without_dispatch_until_its_server_contract_lands() {
    let harness = seeded(false).await;
    let before = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap();
    let operation = OperationRecord {
        operation_id: "share-operation-1".into(),
        kind: OperationKind::CreateShare,
        item_id: "item-existing".into(),
        vault_id: TEST_VAULT_ID.into(),
        request: ImmutableHttpRequest {
            method: HttpMethod::Post,
            path: "/api/v1/items/item-existing/share-links".into(),
            headers: vec![HttpHeader {
                name: "Content-Type".into(),
                value: "application/json".into(),
            }],
            body: br#"{"tokenHash":"locally-generated-hash"}"#.to_vec(),
        },
        request_fingerprint: Sha256Fingerprint([7; 32]),
        attachment_move_recovery: None,
        scheduling: OperationSchedulingState::default(),
    };
    let result = harness
        .runtime
        .replica()
        .execute_recomputing(GuardedCommitPlan::new(
            harness.account_id.clone(),
            before.incarnation,
            before.revision,
            before.lock_epoch,
            vec![PlanMutation::AcceptOperation(operation.clone())],
        ))
        .await
        .unwrap();
    let RecomputedPlanResult::Applied { snapshot } = result else {
        panic!("Share fixture commit must apply");
    };
    harness.runtime.replica().cache(snapshot);

    let dispatcher = tokio::spawn(Arc::clone(&harness.runtime).run_operation_dispatch());
    settle().await;
    assert!(harness.server.requests.lock().unwrap().is_empty());
    assert_eq!(harness.operation(), Some(operation));
    harness.runtime.close().await;
    dispatcher.await.unwrap();
}

#[tokio::test]
async fn an_operation_outlives_more_than_five_transient_failures_with_identical_bytes() {
    let harness = seeded(false).await;
    harness.server.script([
        Fault::NetworkFailure,
        Fault::Status(500),
        Fault::Status(502),
        Fault::NetworkFailure,
        Fault::Status(503),
        Fault::Status(429),
    ]);
    let (operation_id, item_id) = harness.accept_create().await;
    let accepted = harness.operation().unwrap();

    let dispatcher = tokio::spawn(Arc::clone(&harness.runtime).run_operation_dispatch());
    until("seven dispatch attempts", || harness.server.creates() >= 7).await;
    until("the seventh attempt is reconciled", || {
        harness
            .runtime
            .replica()
            .snapshot(&harness.account_id)
            .is_some_and(|snapshot| snapshot.operations.is_empty())
    })
    .await;
    settle().await;

    // Six failures never ended the Operation, and the seventh attempt reached the Server.
    assert_eq!(harness.server.creates(), 7);
    assert_eq!(harness.server.created_items(), vec![item_id.clone()]);

    let requests = harness.server.create_requests();
    assert_eq!(requests.len(), 7);
    for request in &requests {
        // Identity and bytes are the same on every attempt. Nothing about a retry is new.
        assert_eq!(
            request.header("idempotency-key"),
            Some(operation_id.as_str())
        );
        assert_eq!(request.method, "PUT");
        assert_eq!(
            request.url,
            format!("{SERVER_URL}/api/v1/vaults/{TEST_VAULT_ID}/items/{item_id}")
        );
        assert_eq!(request.body, accepted.request.body);
        assert_eq!(request.header("content-type"), Some("application/json"));
        assert_eq!(
            request.header("authorization"),
            Some(format!("Bearer {FIRST_TOKEN}").as_str())
        );
    }

    // Bounded exponential backoff, and a count that only ever describes what happened.
    assert_eq!(
        harness.timer.requested(),
        vec![1_000, 2_000, 4_000, 8_000, 16_000, 32_000]
    );
    // Only the seventh attempt's authoritative outcome ended it, and the compact receipt names
    // the same identity and the same fingerprint the six failures never moved.
    let receipts = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap()
        .receipts;
    assert_eq!(receipts.len(), 1);
    assert_eq!(receipts[0].operation_id, operation_id);
    assert_eq!(
        receipts[0].request_fingerprint,
        accepted.request_fingerprint
    );

    harness.runtime.close().await;
    dispatcher.await.unwrap();
}

#[tokio::test]
async fn backoff_is_durable_and_is_honored_by_the_next_process() {
    let harness = seeded(true).await;
    harness.server.script([Fault::NetworkFailure]);
    let (operation_id, item_id) = harness.accept_create().await;

    let dispatcher = tokio::spawn(Arc::clone(&harness.runtime).run_operation_dispatch());
    until("one failed attempt and a persisted backoff", || {
        harness
            .operation()
            .is_some_and(|operation| operation.scheduling.attempt_count == 1)
    })
    .await;
    let parked = harness.operation().unwrap();
    assert_eq!(parked.scheduling.not_before_ms, START_MS + 1_000);
    harness.runtime.close().await;
    dispatcher.await.unwrap();

    // A new process reads the same durable rows. Backoff was never in memory.
    let clock = TestClock::new();
    clock.advance(400);
    let timer = TestTimer::holding(clock.clone());
    let restarted = Runtime::with_test_dispatch_environment(
        harness.replica.clone(),
        harness.platform.clone(),
        harness.server.clone(),
        auth_config(),
        clock.clone(),
        timer.clone(),
    );
    restarted
        .replica()
        .load(&harness.account_id)
        .await
        .unwrap()
        .unwrap();
    let restored = restarted
        .replica()
        .snapshot(&harness.account_id)
        .unwrap()
        .operations[0]
        .clone();
    assert_eq!(restored.scheduling.attempt_count, 1);
    assert_eq!(restored.scheduling.not_before_ms, START_MS + 1_000);
    assert_eq!(restored.operation_id, operation_id);

    let before = harness.server.creates();
    let dispatcher = tokio::spawn(Arc::clone(&restarted).run_operation_dispatch());
    until("the restart waits out the remaining backoff", || {
        !timer.requested().is_empty()
    })
    .await;
    settle().await;
    // It waited exactly the remainder, and sent nothing early.
    assert_eq!(timer.requested(), vec![600]);
    assert_eq!(harness.server.creates(), before);

    clock.advance(600);
    timer.hold.store(false, Ordering::SeqCst);
    timer.released.notify_waiters();
    until("the deferred attempt runs", || {
        harness.server.creates() == before + 1
    })
    .await;
    assert_eq!(harness.server.created_items(), vec![item_id]);
    restarted.close().await;
    dispatcher.await.unwrap();
}

#[tokio::test]
async fn a_lost_lease_duplicates_no_effect_and_loses_no_operation() {
    let harness = seeded(false).await;
    let (operation_id, item_id) = harness.accept_create().await;
    let accepted = harness.operation().unwrap();

    // The lease is an optimization with an expiry, so a stalled or dead holder cannot pin work.
    let held = harness
        .runtime
        .dispatch_leases
        .acquire(&operation_id, harness.clock.now())
        .expect("a free Operation leases");
    assert!(
        harness
            .runtime
            .dispatch_leases
            .acquire(&operation_id, harness.clock.now())
            .is_none(),
        "a live lease suppresses a second local send"
    );
    harness.clock.advance(dispatch::DISPATCH_LEASE_MS + 1);
    let stolen = harness
        .runtime
        .dispatch_leases
        .acquire(&operation_id, harness.clock.now())
        .expect("an expired lease is not a lock");
    // Losing the holder's guard, exactly as a dead process would, frees nothing and breaks nothing.
    std::mem::forget(held);
    drop(stolen);

    // Two stale local senders now believe they own the same Operation. The Account execution
    // fence serializes them, then current durable truth prevents the second HTTP send after the
    // first reconciles. The lease remains only an optimization; the Account writer is the local
    // ownership contract.
    let snapshot = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap();
    harness
        .runtime
        .dispatch_captured_ignoring_lease(&snapshot, &accepted)
        .await;
    harness
        .runtime
        .dispatch_captured_ignoring_lease(&snapshot, &accepted)
        .await;

    assert_eq!(harness.server.creates(), 1);
    assert_eq!(harness.server.created_items(), vec![item_id]);
    let requests = harness.server.create_requests();
    assert_eq!(requests[0].body, accepted.request.body);
    assert_eq!(
        requests[0].header("idempotency-key"),
        Some(operation_id.as_str())
    );

    // The one accepted immutable request lands on one completion, never a local discard.
    let after = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap();
    assert!(after.operations.is_empty());
    assert_eq!(after.receipts.len(), 1);
    assert_eq!(after.receipts[0].operation_id, operation_id);
}

#[tokio::test]
async fn a_renewable_session_error_refreshes_and_keeps_the_same_bytes() {
    let harness = seeded(false).await;
    *harness.server.refresh.lock().unwrap() = RefreshBehavior::Renews(SECOND_TOKEN);
    harness.server.accepted_tokens.lock().unwrap().clear();
    let (operation_id, item_id) = harness.accept_create().await;

    let dispatcher = tokio::spawn(Arc::clone(&harness.runtime).run_operation_dispatch());
    until("the Item is created after a Session renewal", || {
        !harness.server.created_items().is_empty()
    })
    .await;
    settle().await;

    assert_eq!(harness.server.refresh_calls.load(Ordering::SeqCst), 1);
    assert_eq!(harness.server.created_items(), vec![item_id]);
    let requests = harness.server.create_requests();
    // The credential changed between attempts; nothing else did.
    assert_eq!(
        requests[0].header("authorization"),
        Some(format!("Bearer {FIRST_TOKEN}").as_str())
    );
    assert_eq!(
        requests[1].header("authorization"),
        Some(format!("Bearer {SECOND_TOKEN}").as_str())
    );
    assert_eq!(requests[0].body, requests[1].body);
    assert_eq!(
        requests[0].header("idempotency-key"),
        Some(operation_id.as_str())
    );
    assert_eq!(
        requests[1].header("idempotency-key"),
        Some(operation_id.as_str())
    );

    harness.runtime.close().await;
    dispatcher.await.unwrap();
}

#[tokio::test]
async fn retry_lookup_refresh_replaces_the_session_used_by_the_following_send() {
    let harness = seeded(false).await;
    harness.server.script([Fault::NetworkFailure]);
    let (operation_id, item_id) = harness.accept_create().await;

    harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;
    assert_eq!(harness.operation().unwrap().scheduling.attempt_count, 1);
    harness.clock.advance(1_000);
    harness.server.accepted_tokens.lock().unwrap().clear();
    *harness.server.refresh.lock().unwrap() = RefreshBehavior::Renews(SECOND_TOKEN);

    harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;

    assert_eq!(
        harness.server.refresh_calls.load(Ordering::SeqCst),
        1,
        "lookup renewal must replace the Session used by the send"
    );
    assert_eq!(harness.server.created_items(), vec![item_id]);
    let requests = harness.server.create_requests();
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[0].header("authorization"),
        Some("Bearer session-token-1")
    );
    assert_eq!(
        requests[1].header("authorization"),
        Some("Bearer session-token-2")
    );
}

#[tokio::test]
async fn an_unrenewable_session_parks_the_operation_and_resumes_when_a_session_arrives() {
    let harness = seeded(false).await;
    harness.server.accepted_tokens.lock().unwrap().clear();
    let (_, item_id) = harness.accept_create().await;

    let dispatcher = tokio::spawn(Arc::clone(&harness.runtime).run_operation_dispatch());
    until("the Account reports it needs reauthentication", || {
        harness.waiting_reason() == Some(AccountWaitingReason::ReauthenticationRequired)
    })
    .await;

    // Parked is parked: no timer, no further sends, no busy loop.
    let creates = harness.server.creates();
    let refreshes = harness.server.refresh_calls.load(Ordering::SeqCst);
    settle().await;
    assert_eq!(harness.server.creates(), creates);
    assert_eq!(
        harness.server.refresh_calls.load(Ordering::SeqCst),
        refreshes
    );
    assert!(harness.timer.requested().is_empty());
    assert!(harness.operation().is_some(), "parking never discards work");

    // A Session arrives, and the same durable bytes go out again.
    harness
        .server
        .accepted_tokens
        .lock()
        .unwrap()
        .push(SECOND_TOKEN.to_owned());
    store_session(&harness.runtime, &harness.account_id, SECOND_TOKEN).await;
    harness.runtime.note_session_available(&harness.account_id);

    until("the parked Operation resumes", || {
        !harness.server.created_items().is_empty()
    })
    .await;
    assert_eq!(harness.server.created_items(), vec![item_id]);
    assert_eq!(harness.waiting_reason(), None);

    harness.runtime.close().await;
    dispatcher.await.unwrap();
}

// What an HTTP success alone is worth now lives in `outcome_tests`: a `200` the Runtime cannot
// reconcile leaves the Operation, its overlay, and the Cursor exactly where they were.

#[tokio::test]
async fn dispatch_attaches_only_what_the_durable_bytes_deliberately_omit() {
    let harness = seeded(false).await;
    let (operation_id, _) = harness.accept_create().await;
    let accepted = harness.operation().unwrap();
    assert_eq!(
        accepted.request.headers,
        vec![HttpHeader {
            name: "Content-Type".to_owned(),
            value: "application/json".to_owned(),
        }]
    );
    assert_eq!(accepted.request.method, HttpMethod::Put);

    let dispatcher = tokio::spawn(Arc::clone(&harness.runtime).run_operation_dispatch());
    until("one attempt", || harness.server.creates() == 1).await;
    let sent = harness.server.create_requests()[0].clone();

    let names: Vec<String> = sent
        .headers
        .iter()
        .map(|(name, _)| name.to_ascii_lowercase())
        .collect();
    assert_eq!(
        names,
        vec![
            "content-type",
            "idempotency-key",
            "bittery-client-id",
            "bittery-client-platform",
            "bittery-client-version",
            "authorization",
        ]
    );
    // The Operation ID is the wire idempotency key, exactly as the Server route requires.
    assert_eq!(sent.header("idempotency-key"), Some(operation_id.as_str()));
    assert_eq!(
        sent.header("authorization"),
        Some(format!("Bearer {FIRST_TOKEN}").as_str())
    );

    harness.runtime.close().await;
    dispatcher.await.unwrap();
}

#[tokio::test]
async fn rescheduling_can_never_move_an_accepted_operations_bytes() {
    let harness = seeded(false).await;
    let (operation_id, _) = harness.accept_create().await;
    let snapshot = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap();
    let mut tampered = snapshot.operations[0].clone();
    tampered.request.body.push(b' ');

    let error = harness
        .runtime
        .execute_plan(GuardedCommitPlan::new(
            harness.account_id.clone(),
            snapshot.incarnation.clone(),
            snapshot.revision,
            snapshot.lock_epoch,
            vec![PlanMutation::RescheduleOperation(tampered)],
        ))
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
    assert_eq!(
        harness.operation().unwrap().request,
        snapshot.operations[0].request
    );

    let unknown = crate::test_fixtures::test_operation("operation-unknown", "item-unknown");
    let error = harness
        .runtime
        .execute_plan(GuardedCommitPlan::new(
            harness.account_id.clone(),
            snapshot.incarnation,
            snapshot.revision,
            snapshot.lock_epoch,
            vec![PlanMutation::RescheduleOperation(unknown)],
        ))
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
    assert!(harness
        .operation()
        .is_some_and(|operation| operation.operation_id == operation_id));
}
