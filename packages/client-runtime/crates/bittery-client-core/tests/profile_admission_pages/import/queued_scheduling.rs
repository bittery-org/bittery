use super::*;

const SAFE_MAX: u64 = 9_007_199_254_740_991;

fn scheduled_source(kind: &str, status: Option<&str>, index: u64) -> Arc<Source> {
    let mut source = match kind {
        "create" => queued_create::source_with_queued_create(),
        "update" => queued_update::source_with_queued_update(),
        "move" => queued_move::move_source(false, true),
        other => queued_metadata::metadata_source(other, None, false),
    };
    let inner = &mut Arc::get_mut(&mut source).unwrap().inner;
    let mut sync: Value = serde_json::from_str(inner.sync.as_ref().unwrap()).unwrap();
    let mut queues: Value =
        serde_json::from_str(sync["bittery_pending_mutation_queues_v3"].as_str().unwrap()).unwrap();
    let command = &mut queues[desktop::ACCOUNT][0];
    if let Some(status) = status {
        command["status"] = json!(status);
    } else {
        command.as_object_mut().unwrap().remove("status");
    }
    command["retryCount"] = json!(if status == Some("pending") {
        SAFE_MAX
    } else {
        index + 1
    });
    command["attemptId"] = json!("reminted:never-sent");
    if status != Some("retrying") {
        command["lastError"] = json!(if status.is_none() { "offline" } else { "" });
    }
    if matches!(status, Some("staged" | "applying" | "pending")) {
        command["projectionClaimId"] = json!("departed-projector");
        if status == Some("applying") {
            command["projectionClaimExpiresAt"] = json!(SAFE_MAX);
        }
        if status == Some("pending") {
            command["projectionClaimExpiresAt"] = json!(0);
            command["nextAttemptAt"] = json!(SAFE_MAX);
        }
    }
    sync["bittery_pending_mutation_queues_v3"] = json!(queues.to_string());
    inner.sync = Some(sync.to_string());
    source
}

#[tokio::test]
async fn normal_status_history_and_departed_claims_preserve_only_the_original_retry_deadline() {
    for kind in [
        "create",
        "update",
        "toggle_favorite",
        "delete",
        "restore",
        "permanent_delete",
        "move",
    ] {
        for (index, status) in [
            None,
            Some("staged"),
            Some("applying"),
            Some("pending"),
            Some("retrying"),
        ]
        .into_iter()
        .enumerate()
        {
            let directory = TestDirectory::new();
            let platform = Arc::new(RetainingPlatform::default());
            let source = scheduled_source(kind, status, index as u64);
            let runtime =
                runtime_with_platform_and_source(&directory, platform.clone(), source.clone())
                    .await;
            runtime.open().await.unwrap();
            assert_locked(&runtime);
            runtime.close().await;
            let calls = source.calls.lock().unwrap().len();
            let restarted = Runtime::with_serialized_executors(
                Arc::new(SqliteReplica::open(directory.0.join("replica.sqlite")).unwrap()),
                platform,
                Arc::new(NoNetwork),
            );
            restarted.open().await.unwrap();
            assert_locked(&restarted);
            restarted.close().await;
            assert_eq!(source.calls.lock().unwrap().len(), calls);
            let replica = SqliteReplica::open(directory.0.join("replica.sqlite")).unwrap();
            let loaded = SerializedReplicaExecutor::invoke(
                &replica,
                json!({"type":"load", "accountId":desktop::ACCOUNT}).to_string(),
            )
            .await
            .unwrap();
            let loaded: Value = serde_json::from_str(&loaded).unwrap();
            let operation: Value = serde_json::from_str(
                loaded["rows"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|row| row["store"] == "operations")
                    .unwrap()["payloadJson"]
                    .as_str()
                    .unwrap(),
            )
            .unwrap();
            let command = &operation["legacyAdmission"]["sourceCommand"];
            let count = if status == Some("pending") {
                SAFE_MAX
            } else {
                index as u64 + 1
            };
            let deadline = if status == Some("pending") {
                SAFE_MAX
            } else {
                0
            };
            assert_eq!(command["retryCount"], count.to_string());
            assert_eq!(operation["scheduling"]["attemptCount"], count.to_string());
            assert_eq!(operation["scheduling"]["notBeforeMs"], deadline.to_string());
            assert_eq!(command.get("status").and_then(Value::as_str), status);
            assert_eq!(
                command.get("lastError").and_then(Value::as_str),
                if status == Some("retrying") {
                    None
                } else {
                    Some(if status.is_none() { "offline" } else { "" })
                }
            );
            if matches!(status, Some("staged" | "applying" | "pending")) {
                assert_eq!(command["projectionClaimId"], "departed-projector");
                assert_eq!(
                    command.get("projectionClaimExpiresAt").cloned(),
                    match status {
                        Some("applying") => Some(json!(SAFE_MAX.to_string())),
                        Some("pending") => Some(json!("0")),
                        _ => None,
                    }
                );
            }
            if kind != "create" {
                assert_eq!(operation["operationId"], "reminted:never-sent");
            }
            assert!(loaded["rows"]
                .as_array()
                .unwrap()
                .iter()
                .any(|row| row["store"] == "optimisticItems"));
        }
    }
}
