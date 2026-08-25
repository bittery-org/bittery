//! Slice C: turning "the Server answered something" into local completion.
//!
//! These tests assert effects on both sides. The fake Server counts Item rows and keeps one
//! final-only outcome per `(User, Operation ID)`; the Replica is asked what a reader would see.
//! Exactly-once is the conjunction of the two: one Item row on the Server, one visible Item and
//! one completed receipt locally, however many times the bytes were sent.

use super::operation_fixtures::*;
use super::*;
use crate::replica::{
    OperationOutcomeResult, OperationRejectionCode, ReplicaItemRecord, ReplicaSnapshot,
};

#[test]
fn attachment_state_conflict_remains_a_terminal_rejection_across_the_server_contract() {
    assert_eq!(
        super::outcome::rejection_code(
            crate::server_contract::OperationRejectionCode::AttachmentStateConflict,
        ),
        OperationRejectionCode::AttachmentStateConflict
    );
}

impl Harness {
    fn snapshot(&self) -> ReplicaSnapshot {
        self.runtime
            .replica()
            .snapshot(&self.account_id)
            .expect("the Account is installed")
    }

    fn overlay(&self) -> Option<ReplicaItemRecord> {
        self.snapshot().items.first().cloned()
    }

    fn authority_items(&self) -> Vec<crate::replica::AuthorityItemRecord> {
        self.snapshot().bootstrap.snapshot().visible_items
    }

    fn visible_items(&self) -> Vec<LoginItemProjection> {
        match self
            .runtime
            .projection(&ObservationRequest::Items {
                account_id: self.account_id.clone(),
            })
            .expect("an unlocked Account projects Items")
            .projection
        {
            RuntimeProjection::Items(items) => items.items,
            other => panic!("expected an Items projection, got {other:?}"),
        }
    }

    fn active_cursor(&self) -> crate::replica::SyncCursor {
        self.snapshot().bootstrap.active_cursor.clone()
    }
}

/// Everything one completed create owes locally, asserted in one place.
fn assert_reconciled(harness: &Harness, operation_id: &str, item_id: &str) {
    let snapshot = harness.snapshot();
    assert!(
        snapshot.operations.is_empty(),
        "an authoritative outcome ends the Operation"
    );
    assert!(
        snapshot.items.is_empty(),
        "reconciliation removes the optimistic overlay"
    );
    let authority = harness.authority_items();
    assert_eq!(authority.len(), 1, "exactly one authoritative Item");
    assert_eq!(authority[0].id, item_id);
    assert_eq!(authority[0].version, 1);
    let visible = harness.visible_items();
    assert_eq!(visible.len(), 1, "exactly one visible Item");
    assert_eq!(visible[0].item_id, item_id);
    assert_eq!(visible[0].status, ItemProjectionStatus::Authoritative);
    assert_eq!(
        harness.server.created_items(),
        vec![item_id.to_owned()],
        "one Server effect"
    );

    // One compact completed receipt: identity, fingerprint, terminal result, entity version, and
    // the revision that completed it — and none of the request ciphertext.
    assert_eq!(snapshot.receipts.len(), 1, "exactly one completed receipt");
    let receipt = &snapshot.receipts[0];
    assert_eq!(receipt.operation_id, operation_id);
    assert_eq!(receipt.item_id, item_id);
    assert_eq!(
        receipt.result,
        OperationOutcomeResult::Applied {
            entity_id: item_id.to_owned(),
            version: 1,
        }
    );
    assert_eq!(receipt.completed_at_revision, snapshot.revision);
    let serialized = serde_json::to_string(receipt).expect("a receipt serializes");
    assert!(
        !serialized.contains(&authority[0].encrypted_data),
        "the receipt keeps no request ciphertext"
    );
}

#[tokio::test]
async fn a_forced_duplicate_dispatch_leaves_one_server_effect_and_one_item() {
    let harness = seeded(false).await;
    let (operation_id, item_id) = harness.accept_create().await;
    // Both senders read the accepted work before either of them answers, exactly as two Runtimes
    // holding the same Operation would. Only the Server's outcome table decides what happened.
    let snapshot = harness.snapshot();
    let accepted = snapshot.operations[0].clone();

    harness
        .runtime
        .dispatch_captured_ignoring_lease(&snapshot, &accepted)
        .await;
    harness
        .runtime
        .dispatch_captured_ignoring_lease(&snapshot, &accepted)
        .await;

    assert_eq!(harness.server.creates(), 2, "both sends reached the Server");
    assert_reconciled(&harness, &operation_id, &item_id);
}

#[tokio::test]
async fn a_lost_first_success_response_is_recovered_by_looking_the_outcome_up() {
    let harness = seeded(false).await;
    // The Server commits the Item and the client never sees the answer.
    harness.server.lose_next_response();
    let (operation_id, item_id) = harness.accept_create().await;

    let dispatcher = tokio::spawn(Arc::clone(&harness.runtime).run_operation_dispatch());
    until("the lost response is recovered", || {
        harness.snapshot().operations.is_empty()
    })
    .await;
    settle().await;

    assert_eq!(
        harness.server.creates(),
        1,
        "the effect was already committed, so the bytes are not sent again"
    );
    assert!(
        harness.server.outcome_lookups() >= 1,
        "recovery asks the Server what it already decided"
    );
    assert_reconciled(&harness, &operation_id, &item_id);

    harness.runtime.close().await;
    dispatcher.await.unwrap();
}

#[tokio::test]
async fn the_same_operation_id_with_other_request_bytes_fails_the_account() {
    let harness = seeded(false).await;
    let (operation_id, item_id) = harness.accept_create().await;

    // Someone else already used this Operation ID for different immutable bytes.
    harness.server.outcomes.lock().unwrap().insert(
        operation_id.clone(),
        StoredOutcome {
            fingerprint: [9u8; 32],
            result: StoredResult::Applied {
                item_id: "another-item".to_owned(),
                version: 1,
            },
        },
    );

    let dispatcher = tokio::spawn(Arc::clone(&harness.runtime).run_operation_dispatch());
    until("the Account fails", || harness.snapshot().failure.is_some()).await;
    settle().await;

    assert_eq!(
        harness.snapshot().failure,
        Some(RuntimeErrorCode::InvariantViolation),
        "identity reuse is a fatal invariant violation, not a retry"
    );
    assert!(
        harness.server.created_items().is_empty(),
        "no Item was ever created for these bytes"
    );
    assert!(
        harness.authority_items().is_empty(),
        "nothing authoritative was guessed"
    );
    assert!(
        harness.snapshot().receipts.is_empty(),
        "identity reuse records no outcome"
    );
    assert!(
        harness.snapshot().operations.len() == 1,
        "failing keeps the accepted Operation"
    );
    assert_eq!(
        harness.overlay().map(|item| item.item_id),
        Some(item_id),
        "the user's ciphertext is preserved"
    );

    harness.runtime.close().await;
    dispatcher.await.unwrap();
}

#[tokio::test]
async fn a_failed_authoritative_fetch_leaves_the_prior_state_and_cursor_unchanged() {
    // Time is held, so the Runtime stops in the state a failed reconciliation leaves behind.
    let harness = seeded(true).await;
    harness.server.script_item_faults([Fault::NetworkFailure]);
    let (operation_id, item_id) = harness.accept_create().await;
    let before = harness.snapshot();

    let dispatcher = tokio::spawn(Arc::clone(&harness.runtime).run_operation_dispatch());
    until("the Server applied the create", || {
        !harness.server.created_items().is_empty()
    })
    .await;
    until("the failed fetch reschedules the Operation", || {
        harness
            .snapshot()
            .operations
            .first()
            .is_some_and(|operation| operation.scheduling.attempt_count >= 1)
    })
    .await;
    settle().await;

    // An HTTP success without an applied reconciliation plan is not local completion.
    let stalled = harness.snapshot();
    assert_eq!(
        stalled.operations[0].request, before.operations[0].request,
        "the immutable bytes never moved"
    );
    assert_eq!(
        stalled.items, before.items,
        "the encrypted overlay is untouched"
    );
    assert!(
        harness.authority_items().is_empty(),
        "no authority was written"
    );
    assert_eq!(
        harness.active_cursor(),
        before.bootstrap.active_cursor,
        "a failed fetch leaves the Cursor unchanged"
    );
    assert_eq!(
        harness.snapshot().bootstrap.active_generation,
        before.bootstrap.active_generation,
        "the Bootstrap generation this Replica reads is unchanged"
    );

    // The same durable work reconciles as soon as the Item can be read.
    harness.clock.advance(1_000);
    harness.timer.hold.store(false, Ordering::SeqCst);
    harness.timer.released.notify_waiters();
    until("the retry reconciles", || {
        harness.snapshot().operations.is_empty()
    })
    .await;
    settle().await;
    assert_reconciled(&harness, &operation_id, &item_id);

    harness.runtime.close().await;
    dispatcher.await.unwrap();
}

#[tokio::test]
async fn a_retained_rejection_stops_retry_and_keeps_the_users_ciphertext() {
    let harness = seeded(false).await;
    harness.server.reject_next("vault_read_only");
    let (_, item_id) = harness.accept_create().await;
    let accepted_overlay = harness.overlay().expect("accept wrote an overlay");

    let dispatcher = tokio::spawn(Arc::clone(&harness.runtime).run_operation_dispatch());
    until("the rejection is retained locally", || {
        harness.snapshot().operations.is_empty()
    })
    .await;
    let sent = harness.server.creates();
    settle().await;

    assert_eq!(
        harness.server.creates(),
        sent,
        "a retained rejection stops retry"
    );
    assert!(
        harness.server.created_items().is_empty(),
        "a rejection created no Item"
    );
    let failed = harness
        .overlay()
        .expect("a rejection never destroys the user's ciphertext");
    assert_eq!(failed, accepted_overlay);
    let receipts = harness.snapshot().receipts;
    assert_eq!(receipts.len(), 1, "the rejection is retained once");
    assert_eq!(
        receipts[0].result,
        OperationOutcomeResult::Rejected {
            code: OperationRejectionCode::VaultReadOnly,
        }
    );
    let visible = harness.visible_items();
    assert_eq!(visible.len(), 1);
    assert_eq!(visible[0].item_id, item_id);
    assert_eq!(visible[0].status, ItemProjectionStatus::Failed);

    harness.runtime.close().await;
    dispatcher.await.unwrap();
}

#[tokio::test]
async fn an_operation_sync_event_reconciles_and_advances_the_matching_cursor() {
    let harness = seeded(false).await;
    harness.server.lose_next_response();
    let (operation_id, item_id) = harness.accept_create().await;

    // One dispatch attempt reaches the Server, and its answer is lost.
    harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;
    assert!(harness.snapshot().operations.len() == 1);

    // The Sync feed then reports the Operation as resolved, with an exact Cursor.
    harness
        .server
        .script_operation_event(&operation_id, "sync-7");
    harness
        .runtime
        .bootstrap_account(&harness.account_id, RequestCancellation::new())
        .await
        .unwrap();

    assert_reconciled(&harness, &operation_id, &item_id);
    assert_eq!(
        harness.active_cursor(),
        crate::replica::SyncCursor::CapturedValue {
            id: "sync-7".to_owned()
        },
        "a matching exact Cursor advances with the reconciliation"
    );
}

#[tokio::test]
async fn reconciliation_is_one_transaction_and_a_failed_commit_changes_nothing() {
    // Time is held, so the Runtime stops in the state a rejected commit leaves behind.
    let harness = seeded(true).await;
    let (operation_id, item_id) = harness.accept_create().await;
    let before = harness.snapshot();
    harness.replica.fail_next_commits(1);

    let dispatcher = tokio::spawn(Arc::clone(&harness.runtime).run_operation_dispatch());
    until("the reconciliation commit was attempted and failed", || {
        harness.replica.failed_commits() == 1
    })
    .await;
    until(
        "the failed reconciliation reschedules the Operation",
        || {
            harness
                .snapshot()
                .operations
                .first()
                .is_some_and(|operation| operation.scheduling.attempt_count >= 1)
        },
    )
    .await;
    settle().await;

    let stalled = harness.snapshot();
    assert_eq!(
        stalled.operations[0].request, before.operations[0].request,
        "the immutable bytes never moved"
    );
    assert_eq!(
        stalled.operations[0].request_fingerprint,
        before.operations[0].request_fingerprint
    );
    assert_eq!(stalled.items, before.items);
    assert!(
        stalled.receipts.is_empty(),
        "a failed commit inserts no receipt"
    );
    assert!(harness.authority_items().is_empty());
    assert_eq!(harness.active_cursor(), before.bootstrap.active_cursor);
    assert_eq!(
        harness.snapshot().bootstrap.active_generation,
        before.bootstrap.active_generation,
        "the Bootstrap generation this Replica reads is unchanged"
    );

    // The retry commits the identical plan, and one Server effect stays one Item.
    harness.clock.advance(1_000);
    harness.timer.hold.store(false, Ordering::SeqCst);
    harness.timer.released.notify_waiters();
    until("the retry reconciles", || {
        harness.snapshot().operations.is_empty()
    })
    .await;
    settle().await;
    assert_reconciled(&harness, &operation_id, &item_id);

    harness.runtime.close().await;
    dispatcher.await.unwrap();
}
