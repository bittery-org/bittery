//! Slice B: what happens to an accepted Operation once the network is allowed to fail.
//!
//! The fake Device and fake Server both live in `operation_fixtures`, so these tests and the
//! reconciliation slice argue with the same Server behavior rather than with two stubs.

use super::operation_fixtures::*;
use super::*;
use crate::{
    auth_http::AuthenticatedOutcome,
    http_transport::{HttpHeader, HttpMethod},
    replica::{GuardedCommitPlan, PlanMutation},
    test_fixtures::TEST_VAULT_ID,
};

#[derive(Clone, Copy)]
enum ExistingDispatchCase {
    Update,
    Favorite,
    Trash,
    Restore,
    Move,
    PermanentlyDelete,
}

impl ExistingDispatchCase {
    fn all() -> [Self; 6] {
        [
            Self::Update,
            Self::Favorite,
            Self::Trash,
            Self::Restore,
            Self::Move,
            Self::PermanentlyDelete,
        ]
    }

    fn needs_deleted_authority(self) -> bool {
        matches!(self, Self::Restore | Self::PermanentlyDelete)
    }

    fn request(self, account_id: AccountId) -> RuntimeRequest {
        match self {
            Self::Update => RuntimeRequest::UpdateItem {
                account_id,
                item_id: "item-existing".into(),
                draft: draft(),
            },
            Self::Favorite => RuntimeRequest::SetItemFavorite {
                account_id,
                item_id: "item-existing".into(),
                favorite: true,
            },
            Self::Trash => RuntimeRequest::TrashItem {
                account_id,
                item_id: "item-existing".into(),
            },
            Self::Restore => RuntimeRequest::RestoreItem {
                account_id,
                item_id: "item-existing".into(),
            },
            Self::Move => RuntimeRequest::MoveItem {
                account_id,
                item_id: "item-existing".into(),
                target_vault_id: "vault-2".into(),
            },
            Self::PermanentlyDelete => RuntimeRequest::PermanentlyDeleteItem {
                account_id,
                item_id: "item-existing".into(),
            },
        }
    }

    fn method(self) -> &'static str {
        match self {
            Self::Update | Self::Favorite => "PATCH",
            Self::Trash | Self::PermanentlyDelete => "DELETE",
            Self::Restore | Self::Move => "POST",
        }
    }

    fn path(self) -> &'static str {
        match self {
            Self::Update | Self::Trash => "/api/v1/items/item-existing",
            Self::Favorite => "/api/v1/items/item-existing/favorite",
            Self::Restore => "/api/v1/items/item-existing/restore",
            Self::Move => "/api/v1/items/item-existing/moves",
            Self::PermanentlyDelete => "/api/v1/items/item-existing/permanent",
        }
    }
}

async fn existing_item_kind_reaches_the_shared_dispatcher(case: ExistingDispatchCase) {
    let harness = seeded_with_existing_item(false, case.needs_deleted_authority()).await;
    harness.server.script([Fault::Status(503)]);
    let (operation_id, _) = harness
        .accept_existing(case.request(harness.account_id.clone()))
        .await;

    harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;

    assert_eq!(harness.operation().unwrap().scheduling.attempt_count, 1);
}

macro_rules! existing_dispatch_case {
    ($name:ident, $case:expr) => {
        #[tokio::test]
        async fn $name() {
            existing_item_kind_reaches_the_shared_dispatcher($case).await;
        }
    };
}

existing_dispatch_case!(
    update_item_reaches_the_shared_dispatcher,
    ExistingDispatchCase::Update
);
existing_dispatch_case!(
    favorite_reaches_the_shared_dispatcher,
    ExistingDispatchCase::Favorite
);
existing_dispatch_case!(
    trash_reaches_the_shared_dispatcher,
    ExistingDispatchCase::Trash
);
existing_dispatch_case!(
    restore_reaches_the_shared_dispatcher,
    ExistingDispatchCase::Restore
);
existing_dispatch_case!(
    move_reaches_the_shared_dispatcher,
    ExistingDispatchCase::Move
);
existing_dispatch_case!(
    permanent_delete_reaches_the_shared_dispatcher,
    ExistingDispatchCase::PermanentlyDelete
);

#[tokio::test]
async fn every_existing_item_kind_retries_immutable_requests_without_an_attempt_limit() {
    let faults = [
        Fault::NetworkFailure,
        Fault::Status(500),
        Fault::Status(502),
        Fault::NetworkFailure,
        Fault::Status(503),
        Fault::Status(429),
        Fault::Status(408),
    ];
    for case in ExistingDispatchCase::all() {
        let harness = seeded_with_existing_item(false, case.needs_deleted_authority()).await;
        harness.server.script(faults);
        let (operation_id, _) = harness
            .accept_existing(case.request(harness.account_id.clone()))
            .await;
        let accepted = harness.operation().unwrap();
        let mut delays = Vec::new();

        for expected_attempt_count in 1..=7 {
            harness
                .runtime
                .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
                .await;
            let retriable = harness
                .operation()
                .expect("a transient answer stays accepted");
            assert_eq!(retriable.scheduling.attempt_count, expected_attempt_count);
            let delay = retriable
                .scheduling
                .not_before_ms
                .saturating_sub(harness.clock.now());
            delays.push(delay);
            harness.clock.advance(delay);
        }

        assert_eq!(
            delays,
            vec![1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000]
        );
        let after_retries = harness.operation().unwrap();
        assert_eq!(after_retries.request, accepted.request);
        assert_eq!(
            after_retries.request_fingerprint,
            accepted.request_fingerprint
        );
        let requests = harness.server.existing_item_mutation_requests();
        assert_eq!(requests.len(), 7);
        let mut expected_headers: Vec<(String, String)> = accepted
            .request
            .headers
            .iter()
            .map(|header| (header.name.clone(), header.value.clone()))
            .collect();
        expected_headers.extend([
            ("Idempotency-Key".into(), operation_id.clone()),
            ("Bittery-Client-Id".into(), "client-1".into()),
            ("Bittery-Client-Platform".into(), "web".into()),
            ("Bittery-Client-Version".into(), "1.0.0".into()),
            ("Authorization".into(), format!("Bearer {FIRST_TOKEN}")),
        ]);
        for request in requests {
            assert_eq!(request.method, case.method());
            assert_eq!(request.url, format!("{SERVER_URL}{}", case.path()));
            assert_eq!(request.body, accepted.request.body);
            assert_eq!(request.headers, expected_headers);
        }
    }
}

#[tokio::test]
async fn every_existing_item_kind_honors_durable_backoff_after_restart() {
    for case in ExistingDispatchCase::all() {
        let harness = seeded_with_existing_item(true, case.needs_deleted_authority()).await;
        harness.server.script([Fault::NetworkFailure]);
        let (operation_id, _) = harness
            .accept_existing(case.request(harness.account_id.clone()))
            .await;
        harness
            .runtime
            .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
            .await;
        assert_eq!(
            harness.operation().unwrap().scheduling.not_before_ms,
            START_MS + 1_000
        );
        harness.runtime.close().await;

        harness.clock.advance(400);
        let restarted = Runtime::with_test_dispatch_environment(
            harness.replica.clone(),
            harness.platform.clone(),
            harness.server.clone(),
            auth_config(),
            harness.clock.clone(),
            harness.timer.clone(),
        );
        restarted
            .replica()
            .load(&harness.account_id)
            .await
            .unwrap()
            .unwrap();
        match restarted.dispatch_eligible_operations().await {
            dispatch::DispatchPass::WaitFor { milliseconds } => assert_eq!(milliseconds, 600),
            _ => panic!("the restarted Runtime must honor the durable deadline"),
        }
        assert_eq!(harness.server.existing_item_mutation_requests().len(), 1);

        harness.clock.advance(600);
        harness.server.script([Fault::Status(503)]);
        assert!(matches!(
            restarted.dispatch_eligible_operations().await,
            dispatch::DispatchPass::Progressed
        ));
        assert_eq!(harness.server.existing_item_mutation_requests().len(), 2);
        assert_eq!(
            restarted
                .replica()
                .snapshot(&harness.account_id)
                .unwrap()
                .operations[0]
                .scheduling
                .attempt_count,
            2
        );
        restarted.close().await;
    }
}

#[tokio::test]
async fn forced_duplicate_dispatch_replays_each_existing_item_request_exactly() {
    for case in ExistingDispatchCase::all() {
        let harness = seeded_with_existing_item(false, case.needs_deleted_authority()).await;
        harness
            .server
            .script([Fault::NetworkFailure, Fault::Status(503)]);
        let (operation_id, _) = harness
            .accept_existing(case.request(harness.account_id.clone()))
            .await;
        let accepted = harness.operation().unwrap();
        let http = AuthHttpClient::new(
            &harness.runtime.http_transport,
            SERVER_URL,
            false,
            auth_config(),
        )
        .unwrap();

        let first = http
            .dispatch_operation(
                FIRST_TOKEN,
                &operation_id,
                &accepted.request,
                RequestCancellation::new(),
            )
            .await
            .unwrap();
        let duplicate = http
            .dispatch_operation(
                FIRST_TOKEN,
                &operation_id,
                &accepted.request,
                RequestCancellation::new(),
            )
            .await
            .unwrap();
        assert!(matches!(first, AuthenticatedOutcome::Transient));
        assert!(matches!(duplicate, AuthenticatedOutcome::Transient));

        let requests = harness.server.existing_item_mutation_requests();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].method, requests[1].method);
        assert_eq!(requests[0].url, requests[1].url);
        assert_eq!(requests[0].headers, requests[1].headers);
        assert_eq!(requests[0].body, requests[1].body);
        assert!(harness.operation().is_some());
    }
}

// ---------------------------------------------------------------- the required behavior

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
// reconcile leaves the Operation and overlay unchanged; Bootstrap alone owns page progress.

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
