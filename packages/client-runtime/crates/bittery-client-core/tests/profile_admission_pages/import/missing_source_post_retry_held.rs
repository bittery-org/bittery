//! Actual acquisition retries retain their reminted attempt when the original Move later stops.
use super::*;

#[tokio::test]
async fn actual_failed_after_one_acquisition_retry_preserves_source_free_hold() {
    let oracle: Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"),
        "/../../../core/src/services/fixtures/legacy-cross-account-missing-source-failed-retry-semantic-rejection.json"))).unwrap();
    let (source, command, network) = protected_crash_source_from(&oracle);
    assert_eq!(command["status"], "failed");
    assert_eq!(command["retryCount"], 1);
    assert_eq!(command["id"], command["operationId"]);
    assert_ne!(command["attemptId"], command["operationId"]);
    assert!(!command["attemptId"].as_str().unwrap().is_empty());
    assert_eq!(
        command["lastError"],
        "Create Item Operation was rejected: vault_read_only"
    );
    assert!(command.get("nextAttemptAt").is_none());
    assert!(command.get("conflictCopyId").is_none());
    failed_tests::assert_failed_capture(source, command, network, "1").await;
}

#[tokio::test]
async fn actual_conflict_after_four_acquisition_retries_preserves_independent_copy() {
    let oracle: Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"),
        "/../../../core/src/services/fixtures/legacy-cross-account-missing-source-conflicted-retry-independent-copy.json"))).unwrap();
    // The original hold has four attempts and no deadline; the independently retrying copy has
    // one attempt and its own actual deadline, after the original acquisition retry clock advances.
    conflicted_tests::assert_conflicted_capture(
        oracle,
        4,
        conflicted_tests::ExpectedAttemptRelation::Reminted,
        16_001,
    )
    .await;
}
