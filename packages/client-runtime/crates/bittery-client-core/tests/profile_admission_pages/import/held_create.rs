use super::*;
use bittery_client_core::{OperationProjection, OperationProjectionKind, OperationResolution};
use std::sync::atomic::AtomicUsize;

fn held_create_source(status: &str) -> Arc<Source> {
    let mut source = queued_create::source_with_queued_create();
    mutate_queue(&mut source, |queue| {
        let command = &mut queue[0];
        command["status"] = json!(status);
        command["retryCount"] = json!(5);
        command["lastError"] = json!("legacy transport stopped after five attempts");
    });
    source
}

fn mutate_queue(source: &mut Arc<Source>, mutate: impl FnOnce(&mut Vec<Value>)) {
    let fixture = Arc::get_mut(source).expect("held Create fixture has one owner");
    let mut sync: Value = serde_json::from_str(fixture.inner.sync.as_ref().unwrap()).unwrap();
    let mut queues: Value =
        serde_json::from_str(sync["bittery_pending_mutation_queues_v3"].as_str().unwrap()).unwrap();
    mutate(queues[desktop::ACCOUNT].as_array_mut().unwrap());
    sync["bittery_pending_mutation_queues_v3"] = json!(queues.to_string());
    fixture.inner.sync = Some(sync.to_string());
}

async fn replica_rows(directory: &TestDirectory) -> Vec<Value> {
    let replica = SqliteReplica::open(directory.0.join("replica.sqlite")).unwrap();
    let loaded = SerializedReplicaExecutor::invoke(
        &replica,
        json!({"type":"load","accountId":desktop::ACCOUNT}).to_string(),
    )
    .await
    .unwrap();
    let loaded: Value = serde_json::from_str(&loaded).unwrap();
    loaded["rows"].as_array().unwrap().clone()
}

fn operation(rows: &[Value]) -> Value {
    let operations: Vec<_> = rows
        .iter()
        .filter(|row| row["store"] == "operations")
        .collect();
    assert_eq!(operations.len(), 1);
    serde_json::from_str(operations[0]["payloadJson"].as_str().unwrap()).unwrap()
}

fn held_projection(runtime: &Arc<Runtime>) -> OperationProjection {
    let sink = Arc::new(Sink::default());
    let observation = runtime
        .observe(
            ObservationRequest::Operations {
                account_id: desktop::ACCOUNT.into(),
            },
            sink.clone(),
        )
        .unwrap();
    let RuntimeProjection::Operations(projection) = sink.0.lock().unwrap().last().cloned().unwrap()
    else {
        panic!("expected Operations projection");
    };
    observation.close();
    assert_eq!(projection.operations.len(), 1);
    projection.operations[0].clone()
}

#[tokio::test]
async fn failed_create_is_a_nonexecuting_local_hold_without_an_item_overlay() {
    let directory = TestDirectory::new();
    let platform = Arc::new(RetainingPlatform::default());
    let source = held_create_source("failed");
    let runtime =
        runtime_with_platform_and_source(&directory, platform.clone(), source.clone()).await;

    runtime.open().await.unwrap();
    assert_locked(&runtime);
    assert_eq!(platform.catalog()["profileAdmission"]["phase"], "committed");
    let rows = replica_rows(&directory).await;
    let admitted = operation(&rows);
    assert_eq!(admitted["operationId"], "semantic:create");
    assert_eq!(admitted["kind"], "create_item");
    assert_eq!(
        admitted["target"],
        json!({"type":"item","itemId":"queued:item","vaultId":"vault:offline"})
    );
    assert_eq!(admitted["request"]["method"], "PUT");
    assert_eq!(
        admitted["request"]["headers"],
        json!([{"name":"Content-Type","value":"application/json"}])
    );
    assert_eq!(
        admitted["request"]["path"],
        "/api/v1/vaults/vault%3Aoffline/items/queued%3Aitem"
    );
    assert_eq!(
        admitted["request"]["body"],
        json!(b"{\"category\":\"login\",\"encryptedData\":\"queued-ciphertext\",\"encryptionIv\":\"queued-iv\",\"encryptionAlgorithm\":\"AES-GCM-AAD-V1\"}".as_slice())
    );
    assert_eq!(admitted["legacyAdmission"]["sourceQueueIndex"], "0");
    assert_eq!(
        admitted["legacyAdmission"]["sourceCommand"]["id"],
        "source-command:create"
    );
    assert_eq!(
        admitted["legacyAdmission"]["sourceCommand"]["attemptId"],
        "attempt:create"
    );
    assert_eq!(
        admitted["legacyAdmission"]["sourceCommand"]["status"],
        "failed"
    );
    assert_eq!(
        admitted["legacyAdmission"]["sourceCommand"]["retryCount"],
        "5"
    );
    assert_eq!(
        admitted["legacyAdmission"]["sourceCommand"]["lastError"],
        "legacy transport stopped after five attempts"
    );
    assert_eq!(admitted["legacyAdmission"]["disposition"], "legacyFailed");
    assert!(rows.iter().all(|row| row["store"] != "optimisticItems"));
    let projected = held_projection(&runtime);
    assert_eq!(projected.operation_id, "semantic:create");
    assert_eq!(projected.kind, OperationProjectionKind::CreateItem);
    assert_eq!(projected.resolution, OperationResolution::LegacyFailed);
    assert_eq!(projected.next_attempt_at_ms, None);
    assert_eq!(projected.rejection_code, None);
    runtime.close().await;

    let source_calls = source.calls.lock().unwrap().len();
    let reopened = Runtime::with_serialized_executors(
        Arc::new(SqliteReplica::open(directory.0.join("replica.sqlite")).unwrap()),
        platform,
        Arc::new(NoNetwork),
    );
    reopened.open().await.unwrap();
    assert_locked(&reopened);
    let projected = held_projection(&reopened);
    assert_eq!(projected.resolution, OperationResolution::LegacyFailed);
    assert_eq!(projected.next_attempt_at_ms, None);
    assert_eq!(projected.rejection_code, None);
    assert_eq!(source.calls.lock().unwrap().len(), source_calls);
    let reopened_rows = replica_rows(&directory).await;
    assert_eq!(operation(&reopened_rows), admitted);
    assert!(reopened_rows
        .iter()
        .all(|row| row["store"] != "optimisticItems"));
    reopened.close().await;
}

#[tokio::test]
async fn conflicted_create_preserves_optional_history_but_has_no_executable_deadline() {
    let directory = TestDirectory::new();
    let platform = Arc::new(RetainingPlatform::default());
    let mut source = held_create_source("conflicted");
    mutate_queue(&mut source, |queue| {
        let command = &mut queue[0];
        command["retryCount"] = json!(2);
        command["lastError"] = json!("encrypted edit conflicted before acknowledgement");
        command["nextAttemptAt"] = json!(1_800_000_000_123_u64);
        command["conflictCopyId"] = json!("conflict-copy:item");
        command["projectionClaimId"] = json!("departed-renderer-claim");
        command["projectionClaimExpiresAt"] = json!(1_800_000_000_456_u64);
    });
    let runtime =
        runtime_with_platform_and_source(&directory, platform.clone(), source.clone()).await;

    runtime.open().await.unwrap();
    assert_locked(&runtime);
    let rows = replica_rows(&directory).await;
    let admitted = operation(&rows);
    let evidence = &admitted["legacyAdmission"];
    assert_eq!(evidence["disposition"], "legacyConflicted");
    assert_eq!(evidence["sourceCommand"]["status"], "conflicted");
    assert_eq!(evidence["sourceCommand"]["retryCount"], "2");
    assert_eq!(
        evidence["sourceCommand"]["lastError"],
        "encrypted edit conflicted before acknowledgement"
    );
    assert_eq!(evidence["sourceCommand"]["nextAttemptAt"], "1800000000123");
    assert_eq!(
        evidence["sourceCommand"]["conflictCopyId"],
        "conflict-copy:item"
    );
    assert_eq!(
        evidence["sourceCommand"]["projectionClaimId"],
        "departed-renderer-claim"
    );
    assert_eq!(
        evidence["sourceCommand"]["projectionClaimExpiresAt"],
        "1800000000456"
    );
    assert!(rows.iter().all(|row| row["store"] != "optimisticItems"));
    let projection = held_projection(&runtime);
    assert_eq!(projection.resolution, OperationResolution::LegacyConflicted);
    assert_eq!(projection.attempt_count.as_deref(), Some("2"));
    assert_eq!(projection.next_attempt_at_ms, None);
    assert_eq!(projection.rejection_code, None);
    runtime.close().await;

    let source_calls = source.calls.lock().unwrap().len();
    let reopened = Runtime::with_serialized_executors(
        Arc::new(SqliteReplica::open(directory.0.join("replica.sqlite")).unwrap()),
        platform,
        Arc::new(NoNetwork),
    );
    reopened.open().await.unwrap();
    assert_locked(&reopened);
    let projection = held_projection(&reopened);
    assert_eq!(projection.resolution, OperationResolution::LegacyConflicted);
    assert_eq!(projection.next_attempt_at_ms, None);
    assert_eq!(projection.rejection_code, None);
    assert_eq!(source.calls.lock().unwrap().len(), source_calls);
    assert_eq!(operation(&replica_rows(&directory).await), admitted);
    reopened.close().await;
}

fn normal_create_from(template: &Value, id: &str, operation_id: &str, item_id: &str) -> Value {
    let mut command = template.clone();
    command["id"] = json!(id);
    command["operationId"] = json!(operation_id);
    command["attemptId"] = json!(format!("attempt:{operation_id}"));
    command["entityId"] = json!(item_id);
    command["status"] = json!("pending");
    command["retryCount"] = json!(0);
    let fields = command.as_object_mut().unwrap();
    for field in [
        "lastError",
        "nextAttemptAt",
        "conflictCopyId",
        "projectionClaimId",
        "projectionClaimExpiresAt",
    ] {
        fields.remove(field);
    }
    command
}

fn row_payloads(rows: &[Value], store: &str) -> Vec<Value> {
    rows.iter()
        .filter(|row| row["store"] == store)
        .map(|row| serde_json::from_str(row["payloadJson"].as_str().unwrap()).unwrap())
        .collect()
}

#[tokio::test]
async fn held_create_does_not_own_its_item_or_suppress_independent_conflict_copy_work() {
    let directory = TestDirectory::new();
    let platform = Arc::new(RetainingPlatform::default());
    let mut source = held_create_source("conflicted");
    mutate_queue(&mut source, |queue| {
        queue[0]["conflictCopyId"] = json!("conflict-copy:item");
        let same_item = normal_create_from(
            &queue[0],
            "source-command:same-item",
            "semantic:same-item",
            "queued:item",
        );
        let conflict_copy = normal_create_from(
            &queue[0],
            "source-command:conflict-copy",
            "conflict-copy:semantic:create",
            "conflict-copy:item",
        );
        queue.extend([same_item, conflict_copy]);
    });
    let runtime = runtime_with_platform_and_source(&directory, platform, source).await;

    runtime.open().await.unwrap();
    assert_locked(&runtime);
    let rows = replica_rows(&directory).await;
    let operations = row_payloads(&rows, "operations");
    let overlays = row_payloads(&rows, "optimisticItems");
    assert_eq!(operations.len(), 3);
    assert_eq!(overlays.len(), 2);
    for (operation_id, source_queue_index) in [
        ("semantic:create", "0"),
        ("semantic:same-item", "1"),
        ("conflict-copy:semantic:create", "2"),
    ] {
        let operation = operations
            .iter()
            .find(|operation| operation["operationId"] == operation_id)
            .unwrap();
        assert_eq!(
            operation["legacyAdmission"]["sourceQueueIndex"],
            source_queue_index
        );
    }
    assert!(overlays.iter().any(|overlay| {
        overlay["itemId"] == "queued:item" && overlay["operationId"] == "semantic:same-item"
    }));
    assert!(overlays.iter().any(|overlay| {
        overlay["itemId"] == "conflict-copy:item"
            && overlay["operationId"] == "conflict-copy:semantic:create"
    }));
    assert!(overlays
        .iter()
        .all(|overlay| overlay["operationId"] != "semantic:create"));
    let sink = Arc::new(Sink::default());
    let observation = runtime
        .observe(
            ObservationRequest::Operations {
                account_id: desktop::ACCOUNT.into(),
            },
            sink.clone(),
        )
        .unwrap();
    let RuntimeProjection::Operations(projection) = sink.0.lock().unwrap().last().cloned().unwrap()
    else {
        panic!("expected Operations projection");
    };
    observation.close();
    assert_eq!(projection.operations.len(), 3);
    assert!(projection.operations.iter().any(|operation| {
        operation.operation_id == "semantic:create"
            && operation.resolution == OperationResolution::LegacyConflicted
            && operation.next_attempt_at_ms.is_none()
    }));
    assert_eq!(
        projection
            .operations
            .iter()
            .filter(|operation| operation.resolution == OperationResolution::Pending)
            .count(),
        2
    );
    runtime.close().await;
}

#[tokio::test]
async fn held_create_identity_collisions_are_refused_before_destination_writes() {
    let directory = TestDirectory::new();
    let platform = Arc::new(RetainingPlatform::default());
    let mut source = held_create_source("failed");
    mutate_queue(&mut source, |queue| {
        let collision = normal_create_from(
            &queue[0],
            "semantic:create",
            "semantic:other-create",
            "other:item",
        );
        queue.push(collision);
    });
    let runtime = runtime_with_platform_and_source(&directory, platform.clone(), source).await;

    let error = runtime.open().await.unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::SourceFailure);
    assert!(platform.sets.lock().unwrap().is_empty());
    assert!(replica_rows(&directory).await.is_empty());
    runtime.close().await;
}

fn add_captured_item(source: &mut Arc<Source>, failed: bool) {
    let fixture = Arc::get_mut(source).expect("captured Item fixture has one owner");
    let mut store: Value = serde_json::from_str(&fixture.inner.store).unwrap();
    let prefix = format!(
        "record:item-cache-stage:{}:source-generation:items:",
        desktop::ACCOUNT
    );
    let mut item: Value =
        serde_json::from_str(store[format!("{prefix}item:offline")].as_str().unwrap()).unwrap();
    item["id"] = json!("queued:item");
    item["encryptedData"] = json!("queued-ciphertext");
    item["encryptionIv"] = json!("queued-iv");
    if failed {
        item["optimisticFailure"] =
            json!({"operationId":"semantic:create","code":"vault_read_only"});
    }
    store[format!("{prefix}queued:item")] = json!(item.to_string());
    fixture.inner.store = store.to_string();
}

#[tokio::test]
async fn held_create_refuses_authoritative_item_or_malformed_failed_cache() {
    for failed in [false, true] {
        let directory = TestDirectory::new();
        let platform = Arc::new(RetainingPlatform::default());
        let mut source = held_create_source("failed");
        add_captured_item(&mut source, failed);
        let runtime = runtime_with_platform_and_source(&directory, platform.clone(), source).await;

        let error = runtime.open().await.unwrap_err();
        assert_eq!(
            error.code,
            if failed {
                RuntimeErrorCode::InvariantViolation
            } else {
                RuntimeErrorCode::SourceFailure
            },
            "failed={failed}"
        );
        assert!(platform.sets.lock().unwrap().is_empty(), "failed={failed}");
        assert!(replica_rows(&directory).await.is_empty(), "failed={failed}");
        runtime.close().await;
    }
}

struct AmbiguousReplicaInstall {
    inner: SqliteReplica,
    lose_once: AtomicBool,
    fail_next_load: AtomicBool,
    installs: AtomicUsize,
}

#[async_trait]
impl SerializedReplicaExecutor for AmbiguousReplicaInstall {
    async fn invoke(&self, request: String) -> Result<String, RuntimeError> {
        let value: Value = serde_json::from_str(&request).unwrap();
        if value["type"] == "load" && self.fail_next_load.swap(false, Ordering::SeqCst) {
            return Err(unavailable());
        }
        let reply = self.inner.invoke(request).await?;
        if value["type"] == "install" {
            self.installs.fetch_add(1, Ordering::SeqCst);
            if self.lose_once.swap(false, Ordering::SeqCst) {
                self.fail_next_load.store(true, Ordering::SeqCst);
                return Err(unavailable());
            }
        }
        Ok(reply)
    }
}

#[tokio::test]
async fn ambiguous_held_create_replica_install_reopens_the_exact_no_overlay_snapshot() {
    let directory = TestDirectory::new();
    let platform = Arc::new(RetainingPlatform::default());
    let first_replica = Arc::new(AmbiguousReplicaInstall {
        inner: SqliteReplica::open(directory.0.join("replica.sqlite")).unwrap(),
        lose_once: AtomicBool::new(true),
        fail_next_load: AtomicBool::new(false),
        installs: AtomicUsize::new(0),
    });
    let runtime =
        runtime_with_platform_and_replica(&directory, platform.clone(), first_replica.clone())
            .await;
    runtime
        .set_profile_admission_source(ProfileAdmissionSource::Legacy {
            format: LegacyProfileFormat::DesktopLegacyV1,
            executor: held_create_source("failed"),
        })
        .await
        .unwrap();

    assert_eq!(
        runtime.open().await.unwrap_err().code,
        RuntimeErrorCode::StorageUnavailable
    );
    assert_eq!(first_replica.installs.load(Ordering::SeqCst), 1);
    assert_eq!(platform.catalog()["profileAdmission"]["phase"], "preparing");
    let installed_rows = replica_rows(&directory).await;
    let installed_operation = operation(&installed_rows);
    assert!(installed_rows
        .iter()
        .all(|row| row["store"] != "optimisticItems"));
    runtime.close().await;
    drop(runtime);
    drop(first_replica);

    let reopened_replica = Arc::new(AmbiguousReplicaInstall {
        inner: SqliteReplica::open(directory.0.join("replica.sqlite")).unwrap(),
        lose_once: AtomicBool::new(false),
        fail_next_load: AtomicBool::new(false),
        installs: AtomicUsize::new(0),
    });
    let reopened =
        runtime_with_platform_and_replica(&directory, platform.clone(), reopened_replica.clone())
            .await;
    reopened
        .set_profile_admission_source(ProfileAdmissionSource::Legacy {
            format: LegacyProfileFormat::DesktopLegacyV1,
            executor: held_create_source("failed"),
        })
        .await
        .unwrap();
    reopened.open().await.unwrap();
    assert_locked(&reopened);
    assert_eq!(platform.catalog()["profileAdmission"]["phase"], "committed");
    assert_eq!(reopened_replica.installs.load(Ordering::SeqCst), 0);
    let reopened_rows = replica_rows(&directory).await;
    assert_eq!(operation(&reopened_rows), installed_operation);
    assert!(reopened_rows
        .iter()
        .all(|row| row["store"] != "optimisticItems"));
    reopened.close().await;
}
