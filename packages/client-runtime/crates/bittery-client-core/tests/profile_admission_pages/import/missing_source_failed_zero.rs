//! A real first-attempt semantic rejection is held independently of later source deletion.
use super::*;

#[tokio::test]
async fn actual_failed_zero_semantic_rejection_preserves_source_free_hold() {
    let oracle: Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"),
        "/../../../core/src/services/fixtures/legacy-cross-account-missing-source-failed-semantic-rejection.json"))).unwrap();
    let (source, command, network) = protected_crash_source_from(&oracle);
    assert_eq!(command["status"], "failed");
    assert_eq!(command["retryCount"], 0);
    assert_eq!(command["id"], command["operationId"]);
    assert_eq!(command["attemptId"], command["operationId"]);
    assert_eq!(
        command["lastError"],
        "Create Item Operation was rejected: vault_read_only"
    );
    assert!(command.get("nextAttemptAt").is_none());
    assert!(command.get("conflictCopyId").is_none());
    failed_tests::assert_failed_capture(source, command, network, "0").await;
}
