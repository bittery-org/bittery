//! Queue reconciliation-read failures retain the original attempt even as the retry count grows.
use super::*;

#[tokio::test]
async fn actual_failed_after_five_reconciliation_reads_preserves_original_attempt() {
    let oracle: Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"),
        "/../../../core/src/services/fixtures/legacy-cross-account-missing-source-failed-reconciliation-read.json"))).unwrap();
    let (source, command, network) = protected_crash_source_from(&oracle);
    assert_eq!(command["status"], "failed");
    assert_eq!(command["retryCount"], 5);
    assert_eq!(command["id"], command["operationId"]);
    assert_eq!(command["attemptId"], command["operationId"]);
    assert_eq!(command["lastError"], "The server could not be reached.");
    assert!(command.get("nextAttemptAt").is_none());
    assert!(command.get("conflictCopyId").is_none());
    failed_tests::assert_failed_capture(source, command, network, "5").await;
}

#[tokio::test]
async fn actual_conflict_after_one_reconciliation_read_preserves_original_attempt_and_copy() {
    let oracle: Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"),
        "/../../../core/src/services/fixtures/legacy-cross-account-missing-source-conflicted-reconciliation-read-independent-copy.json"))).unwrap();
    conflicted_tests::assert_conflicted_capture(
        oracle,
        1,
        conflicted_tests::ExpectedAttemptRelation::Original,
        2_001,
    )
    .await;
}
