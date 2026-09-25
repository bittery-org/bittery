//! A terminal HTTP400 can retain the deadline from either genuine retry predecessor.
use super::*;

#[tokio::test]
async fn actual_acquisition_retry_then_http400_preserves_reminted_attempt_and_source_deadline() {
    let oracle: Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"),
        "/../../../core/src/services/fixtures/legacy-cross-account-missing-source-failed-retained-deadline-acquisition.json"))).unwrap();
    let (source, command, network) = protected_crash_source_from(&oracle);
    assert_eq!(command["status"], "failed");
    assert_eq!(command["retryCount"], 4);
    assert_eq!(command["nextAttemptAt"], 15_001);
    assert_eq!(command["id"], command["operationId"]);
    assert_ne!(command["attemptId"], command["operationId"]);
    assert!(command["attemptId"]
        .as_str()
        .unwrap()
        .starts_with("original-semantic-move:attempt:"));
    assert_eq!(command["lastError"], "Target Item lookup was rejected");
    assert!(command.get("conflictCopyId").is_none());
    failed_tests::assert_failed_capture_with_deadline(source, command, network, "4", Some(15_001))
        .await;
}

#[tokio::test]
async fn actual_reconciliation_retry_then_http400_preserves_original_attempt_and_source_deadline() {
    let oracle: Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"),
        "/../../../core/src/services/fixtures/legacy-cross-account-missing-source-failed-retained-deadline-reconciliation-read.json"))).unwrap();
    let (source, command, network) = protected_crash_source_from(&oracle);
    assert_eq!(command["status"], "failed");
    assert_eq!(command["retryCount"], 1);
    assert_eq!(command["nextAttemptAt"], 1_001);
    assert_eq!(command["id"], command["operationId"]);
    assert_eq!(command["attemptId"], command["operationId"]);
    assert_eq!(command["lastError"], "Target Item lookup was rejected");
    assert!(command.get("conflictCopyId").is_none());
    failed_tests::assert_failed_capture_with_deadline(source, command, network, "1", Some(1_001))
        .await;
}
