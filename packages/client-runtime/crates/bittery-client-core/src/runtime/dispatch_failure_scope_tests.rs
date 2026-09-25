use super::*;
use crate::runtime::operation_fixtures::seeded;

#[tokio::test]
async fn returned_import_local_failure_cannot_fail_a_newer_replica() {
    let harness = seeded(false).await;
    harness.accept_create().await;
    let captured = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap();
    let operation = captured.operations[0].clone();
    // A newer accepted action commits after the executor releases its captured execution guard.
    harness.accept_create().await;
    let newer = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap();
    assert!(newer.revision > captured.revision);
    assert!(matches!(
        harness
            .runtime
            .fail_import_dispatch(&captured, &operation)
            .await,
        AttemptOutcome::Parked
    ));
    assert_eq!(
        harness
            .runtime
            .replica()
            .snapshot(&harness.account_id)
            .unwrap(),
        newer
    );
}

#[tokio::test]
async fn returned_import_local_failure_retries_if_failure_cannot_be_persisted() {
    let harness = seeded(false).await;
    harness.accept_create().await;
    let captured = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap();
    let operation = captured.operations[0].clone();
    harness.replica.fail_next_commits(1);
    assert!(matches!(
        harness
            .runtime
            .fail_import_dispatch(&captured, &operation)
            .await,
        AttemptOutcome::Progressed
    ));
    let after = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap();
    assert!(after.failure.is_none());
    assert_eq!(after.operations[0].request, operation.request);
    assert_eq!(
        after.operations[0].scheduling.attempt_count,
        operation.scheduling.attempt_count + 1
    );
    assert!(after.receipts.is_empty());
    assert_eq!(harness.replica.failed_commits(), 1);
}

#[test]
fn expired_dispatch_lease_drop_cannot_release_its_successor() {
    let leases = Arc::new(DispatchLeases::default());
    let old = leases.acquire("operation", 0).unwrap();
    let successor = leases.acquire("operation", DISPATCH_LEASE_MS).unwrap();
    drop(old);
    assert!(
        leases.acquire("operation", DISPATCH_LEASE_MS).is_none(),
        "old lease removed the successor's registered owner"
    );
    drop(successor);
    assert!(leases.acquire("operation", DISPATCH_LEASE_MS).is_some());
}

#[test]
fn expired_dispatch_lease_defer_cannot_change_its_successor() {
    let leases = Arc::new(DispatchLeases::default());
    let old = leases.acquire("operation", 0).unwrap();
    let successor = leases.acquire("operation", DISPATCH_LEASE_MS).unwrap();
    let deadline = leases.deadline("operation").unwrap();
    assert!(!old.defer_until(u64::MAX));
    assert_eq!(leases.deadline("operation"), Some(deadline));
    assert!(leases.acquire("operation", DISPATCH_LEASE_MS).is_none());
    drop(successor);
    assert!(leases.acquire("operation", DISPATCH_LEASE_MS).is_some());
}

#[test]
fn saturated_dispatch_deadlines_still_keep_distinct_registrations() {
    let leases = Arc::new(DispatchLeases::default());
    let old = leases.acquire("operation", u64::MAX - 1).unwrap();
    let successor = leases.acquire("operation", u64::MAX).unwrap();
    assert!(!old.defer_until(1));
    assert_eq!(leases.deadline("operation"), Some(u64::MAX));
    drop(successor);
    assert_eq!(leases.deadline("operation"), None);
}
