use super::*;
use bittery_client_core::{OperationProjectionKind, OperationResolution};
use std::sync::atomic::AtomicUsize;

fn failed_create_cache_source() -> Arc<Source> {
    let mut source = queued_create::source_with_queued_create();
    let fixture = Arc::get_mut(&mut source).expect("failed Create fixture has one owner");

    let mut sync: Value = serde_json::from_str(fixture.inner.sync.as_ref().unwrap()).unwrap();
    let mut queues: Value =
        serde_json::from_str(sync["bittery_pending_mutation_queues_v3"].as_str().unwrap()).unwrap();
    queues[desktop::ACCOUNT][0]["status"] = json!("failed");
    sync["bittery_pending_mutation_queues_v3"] = json!(queues.to_string());
    fixture.inner.sync = Some(sync.to_string());

    let prefix = format!(
        "record:item-cache-stage:{}:source-generation:items:",
        desktop::ACCOUNT
    );
    let mut store: Value = serde_json::from_str(&fixture.inner.store).unwrap();
    let mut item: Value =
        serde_json::from_str(store[format!("{prefix}item:offline")].as_str().unwrap()).unwrap();
    item["id"] = json!("queued:item");
    item["category"] = json!("login");
    item["favorite"] = json!(false);
    item["encryptedData"] = json!("queued-ciphertext");
    item["encryptionIv"] = json!("queued-iv");
    item["encryptionAlgorithm"] = json!("AES-GCM-AAD-V1");
    item["version"] = json!(1);
    item["encryptionVersion"] = json!(1);
    item["encryptedByUserId"] = json!("original-user");
    item["lastModifiedBy"] = json!("original-user");
    item["createdAt"] = json!("2023-11-14T22:13:22.000Z");
    item["updatedAt"] = json!("2023-11-14T22:13:22.000Z");
    item["deletedAt"] = Value::Null;
    item.as_object_mut().unwrap().remove("attachments");
    item["optimisticFailure"] = json!({"operationId":"semantic:create","code":"vault_read_only"});
    store
        .as_object_mut()
        .unwrap()
        .remove(&format!("{prefix}item:offline"));
    store[format!("{prefix}queued:item")] = json!(item.to_string());
    fixture.inner.store = store.to_string();
    source
}

fn set_source_vault_role(source: &mut Arc<Source>, role: &str) {
    let fixture = Arc::get_mut(source).expect("failed Create fixture has one owner");
    let mut keys: Value =
        serde_json::from_str(fixture.inner.credentials[4].as_ref().unwrap()).unwrap();
    keys[0]["role"] = json!(role);
    fixture.inner.credentials[4] = Some(keys.to_string());
}

fn mutate_cached_item(source: &mut Arc<Source>, mutate: impl FnOnce(&mut Value)) {
    let fixture = Arc::get_mut(source).expect("failed Create fixture has one owner");
    let key = format!(
        "record:item-cache-stage:{}:source-generation:items:queued:item",
        desktop::ACCOUNT
    );
    let mut store: Value = serde_json::from_str(&fixture.inner.store).unwrap();
    let mut item: Value = serde_json::from_str(store[&key].as_str().unwrap()).unwrap();
    mutate(&mut item);
    store[key] = json!(item.to_string());
    fixture.inner.store = store.to_string();
}

fn mutate_queue(source: &mut Arc<Source>, mutate: impl FnOnce(&mut Vec<Value>)) {
    let fixture = Arc::get_mut(source).expect("failed Create fixture has one owner");
    let mut sync: Value = serde_json::from_str(fixture.inner.sync.as_ref().unwrap()).unwrap();
    let mut queues: Value =
        serde_json::from_str(sync["bittery_pending_mutation_queues_v3"].as_str().unwrap()).unwrap();
    mutate(queues[desktop::ACCOUNT].as_array_mut().unwrap());
    sync["bittery_pending_mutation_queues_v3"] = json!(queues.to_string());
    fixture.inner.sync = Some(sync.to_string());
}

fn no_overlay_held_source() -> Arc<Source> {
    let mut source = queued_create::source_with_queued_create();
    mutate_queue(&mut source, |queue| queue[0]["status"] = json!("failed"));
    source
}

async fn assert_preparing_refusal(source: Arc<Source>, label: &str) {
    let directory = TestDirectory::new();
    let platform = Arc::new(RetainingPlatform::default());
    let runtime = runtime_with_platform_and_source(&directory, platform.clone(), source).await;
    let error = match runtime.open().await {
        Ok(()) => panic!("{label} unexpectedly admitted"),
        Err(error) => error,
    };
    assert!(
        matches!(
            error.code,
            RuntimeErrorCode::SourceFailure | RuntimeErrorCode::InvariantViolation
        ),
        "{label}: {error:?}"
    );
    assert!(platform.sets.lock().unwrap().is_empty(), "{label}");
    assert!(platform.values.lock().unwrap().is_empty(), "{label}");
    let snapshot = replica_snapshot(&directory).await;
    assert!(snapshot["head"].is_null(), "{label}");
    assert!(snapshot["rows"].as_array().unwrap().is_empty(), "{label}");
    runtime.close().await;
}

async fn replica_snapshot(directory: &TestDirectory) -> Value {
    let replica = SqliteReplica::open(directory.0.join("replica.sqlite")).unwrap();
    let loaded = replica
        .invoke(json!({"type":"load","accountId":desktop::ACCOUNT}).to_string())
        .await
        .unwrap();
    serde_json::from_str(&loaded).unwrap()
}

fn row(snapshot: &Value, store: &str) -> Value {
    let rows: Vec<_> = snapshot["rows"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["store"] == store)
        .collect();
    assert_eq!(rows.len(), 1, "{store}");
    serde_json::from_str(rows[0]["payloadJson"].as_str().unwrap()).unwrap()
}

fn rows(snapshot: &Value, store: &str) -> Vec<Value> {
    snapshot["rows"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["store"] == store)
        .map(|row| serde_json::from_str(row["payloadJson"].as_str().unwrap()).unwrap())
        .collect()
}

fn assert_locked(runtime: &Arc<Runtime>) {
    let sink = Arc::new(Sink::default());
    let observation = runtime
        .observe(
            ObservationRequest::RuntimeStatus { account_id: None },
            sink.clone(),
        )
        .unwrap();
    assert!(matches!(
        sink.0.lock().unwrap().last(),
        Some(RuntimeProjection::RuntimeStatus(status))
            if !status.closed
                && status.accounts.len() == 1
                && status.accounts[0].account_id.as_str() == desktop::ACCOUNT
                && status.accounts[0].access == AccountAccessState::Locked
    ));
    observation.close();
}

fn assert_failed_projection(runtime: &Arc<Runtime>) {
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
        panic!("expected Operations projection")
    };
    observation.close();
    assert_eq!(projection.operations.len(), 1);
    let operation = &projection.operations[0];
    assert_eq!(operation.operation_id, "semantic:create");
    assert_eq!(operation.kind, OperationProjectionKind::CreateItem);
    assert_eq!(operation.resolution, OperationResolution::LegacyFailed);
    assert_eq!(operation.next_attempt_at_ms, None);
    assert_eq!(operation.rejection_code, None);
}

fn assert_failed_cache_snapshot(snapshot: &Value) {
    let operation = row(snapshot, "operations");
    assert_eq!(operation["operationId"], "semantic:create");
    assert_eq!(operation["legacyAdmission"]["disposition"], "legacyFailed");
    assert_eq!(
        operation["legacyAdmission"]["capturedFailureCode"],
        "vault_read_only"
    );
    assert_eq!(
        operation["legacyAdmission"]["sourceCommand"]["status"],
        "failed"
    );
    let overlay = row(snapshot, "optimisticItems");
    assert_eq!(
        overlay,
        json!({
            "accountId":desktop::ACCOUNT,
            "itemId":"queued:item",
            "vaultId":"vault:offline",
            "operationId":"semantic:create",
            "category":"login",
            "encryptedData":"queued-ciphertext",
            "encryptionIv":"queued-iv",
            "encryptionAlgorithm":"AES-GCM-AAD-V1",
            "encryptionVersion":1,
            "encryptedByUserId":"original-user",
            "favorite":false,
            "version":1,
            "createdAt":"2023-11-14T22:13:22Z",
            "updatedAt":"2023-11-14T22:13:22Z",
            "deletedAt":null,
            "attachments":[],
            "permanentlyDeleted":false
        })
    );
    assert!(snapshot["rows"]
        .as_array()
        .unwrap()
        .iter()
        .all(|row| row["store"] != "authorityItems"));
    let metadata = row(snapshot, "replicaMetadata");
    assert_eq!(metadata["state"], "refreshRequired");
    assert_eq!(metadata["activeCursor"], json!({"type":"cold"}));
    let generation = row(snapshot, "bootstrapGenerations");
    assert_eq!(generation["pinnedWatermark"], json!({"type":"cold"}));
    assert_eq!(
        generation["legacyAdmission"]["refreshReason"],
        "capturedFailedCreate"
    );
    assert_eq!(
        generation["legacyAdmission"]["metadata"]["lastFullSyncAt"],
        1_700_000_001_000_u64
    );
    assert_eq!(generation["legacyAdmission"]["metadata"]["itemCount"], 1);
    assert_eq!(
        generation["legacyAdmission"]["metadata"]["syncBaseline"]["cursor"],
        json!({"type":"capturedValue","id":"evt-cache"})
    );
    assert_eq!(
        generation["legacyAdmission"]["syncBaseline"],
        json!({"type":"capturedValue","id":"evt-cache"})
    );
    assert_eq!(
        generation["legacyAdmission"]["lastSyncCursor"],
        json!({"type":"capturedValue","id":"evt-cache"})
    );
}

#[tokio::test]
async fn captured_failed_create_is_held_locally_and_forces_refresh_required() {
    let directory = TestDirectory::new();
    let platform = Arc::new(RetainingPlatform::default());
    let source = failed_create_cache_source();
    let runtime =
        runtime_with_platform_and_source(&directory, platform.clone(), source.clone()).await;

    runtime.open().await.unwrap();
    assert_locked(&runtime);
    assert_eq!(platform.catalog()["profileAdmission"]["phase"], "committed");
    let snapshot = replica_snapshot(&directory).await;
    assert_failed_cache_snapshot(&snapshot);
    assert_failed_projection(&runtime);
    runtime.close().await;

    let source_calls = source.calls.lock().unwrap().len();
    let reopened = Runtime::with_serialized_executors(
        Arc::new(SqliteReplica::open(directory.0.join("replica.sqlite")).unwrap()),
        platform,
        Arc::new(NoNetwork),
    );
    reopened.open().await.unwrap();
    assert_locked(&reopened);
    assert_failed_projection(&reopened);
    assert_eq!(source.calls.lock().unwrap().len(), source_calls);
    let reopened_snapshot = replica_snapshot(&directory).await;
    assert_eq!(reopened_snapshot["rows"], snapshot["rows"]);
    assert_eq!(
        reopened_snapshot["head"]["lockEpoch"],
        (snapshot["head"]["lockEpoch"]
            .as_str()
            .unwrap()
            .parse::<u64>()
            .unwrap()
            + 1)
        .to_string()
    );
    reopened.close().await;
}

#[tokio::test]
async fn captured_failed_create_is_retained_from_a_read_only_vault_without_authorizing_work() {
    let directory = TestDirectory::new();
    let platform = Arc::new(RetainingPlatform::default());
    let mut source = failed_create_cache_source();
    set_source_vault_role(&mut source, "read-only");
    let runtime = runtime_with_platform_and_source(&directory, platform, source).await;

    runtime.open().await.unwrap();
    assert_locked(&runtime);
    let snapshot = replica_snapshot(&directory).await;
    assert_failed_cache_snapshot(&snapshot);
    assert_eq!(row(&snapshot, "authorityVaults")["role"], "readOnly");
    assert_failed_projection(&runtime);
    runtime.close().await;
}

#[tokio::test]
async fn failed_cache_flags_and_canonical_fields_are_strict_before_preparing() {
    for fault in [
        "unknownFlagField",
        "nullFlag",
        "arrayFlag",
        "nullOperationId",
        "nullCode",
        "unknownCode",
        "orphanOperation",
        "duplicateOperationId",
        "pendingCommand",
        "conflictedCommand",
        "updateCommand",
        "ciphertext",
        "category",
        "favorite",
        "version",
        "encryptionVersion",
        "writer",
        "lastModifiedBy",
        "zeroMillisWithoutFraction",
        "wrongFractionPrecision",
        "timestampOffset",
        "timestampMismatch",
        "deleted",
        "nullAttachments",
        "nonemptyAttachments",
    ] {
        let mut source = failed_create_cache_source();
        match fault {
            "unknownFlagField" => mutate_cached_item(&mut source, |item| {
                item["optimisticFailure"]["extra"] = json!(true)
            }),
            "nullFlag" => {
                mutate_cached_item(&mut source, |item| item["optimisticFailure"] = Value::Null)
            }
            "arrayFlag" => {
                mutate_cached_item(&mut source, |item| item["optimisticFailure"] = json!([]))
            }
            "nullOperationId" => mutate_cached_item(&mut source, |item| {
                item["optimisticFailure"]["operationId"] = Value::Null
            }),
            "nullCode" => mutate_cached_item(&mut source, |item| {
                item["optimisticFailure"]["code"] = Value::Null
            }),
            "unknownCode" => mutate_cached_item(&mut source, |item| {
                item["optimisticFailure"]["code"] = json!("item_not_found")
            }),
            "orphanOperation" => mutate_cached_item(&mut source, |item| {
                item["optimisticFailure"]["operationId"] = json!("absent-operation")
            }),
            "duplicateOperationId" => {
                let fixture = Arc::get_mut(&mut source).unwrap();
                let key = format!(
                    "record:item-cache-stage:{}:source-generation:items:queued:item",
                    desktop::ACCOUNT
                );
                let mut store: Value = serde_json::from_str(&fixture.inner.store).unwrap();
                let raw = store[&key].as_str().unwrap();
                let duplicated = raw.replacen(
                    "\"operationId\":\"semantic:create\"",
                    "\"operationId\":\"semantic:create\",\"operationId\":\"semantic:create\"",
                    1,
                );
                assert_ne!(duplicated, raw);
                store[key] = json!(duplicated);
                fixture.inner.store = store.to_string();
            }
            "pendingCommand" => {
                mutate_queue(&mut source, |queue| queue[0]["status"] = json!("pending"))
            }
            "conflictedCommand" => mutate_queue(&mut source, |queue| {
                queue[0]["status"] = json!("conflicted")
            }),
            "updateCommand" => mutate_queue(&mut source, |queue| {
                queue[0]["type"] = json!("update");
                queue[0]["baseVersion"] = json!(1);
            }),
            "ciphertext" => mutate_cached_item(&mut source, |item| {
                item["encryptedData"] = json!("different-ciphertext")
            }),
            "category" => {
                mutate_cached_item(&mut source, |item| item["category"] = json!("secure-note"))
            }
            "favorite" => mutate_cached_item(&mut source, |item| item["favorite"] = json!(true)),
            "version" => mutate_cached_item(&mut source, |item| item["version"] = json!(2)),
            "encryptionVersion" => {
                mutate_cached_item(&mut source, |item| item["encryptionVersion"] = json!(2))
            }
            "writer" => mutate_cached_item(&mut source, |item| {
                item["encryptedByUserId"] = json!("different-user")
            }),
            "lastModifiedBy" => mutate_cached_item(&mut source, |item| {
                item["lastModifiedBy"] = json!("different-user")
            }),
            "zeroMillisWithoutFraction" => mutate_cached_item(&mut source, |item| {
                item["createdAt"] = json!("2023-11-14T22:13:22Z")
            }),
            "wrongFractionPrecision" => mutate_cached_item(&mut source, |item| {
                item["createdAt"] = json!("2023-11-14T22:13:22.00Z")
            }),
            "timestampOffset" => mutate_cached_item(&mut source, |item| {
                item["createdAt"] = json!("2023-11-14T22:13:22.000+00:00")
            }),
            "timestampMismatch" => mutate_cached_item(&mut source, |item| {
                item["updatedAt"] = json!("2023-11-14T22:13:22.001Z")
            }),
            "deleted" => mutate_cached_item(&mut source, |item| {
                item["deletedAt"] = json!("2023-11-14T22:13:23.000Z")
            }),
            "nullAttachments" => {
                mutate_cached_item(&mut source, |item| item["attachments"] = Value::Null)
            }
            "nonemptyAttachments" => mutate_cached_item(&mut source, |item| {
                item["attachments"] = json!([{
                    "id":"attachment:one",
                    "itemId":"queued:item",
                    "vaultId":"vault:offline",
                    "storageKey":"object:key",
                    "encryptedName":"encrypted-name",
                    "encryptionIv":"attachment-iv",
                    "encryptionAlgorithm":"AES-GCM-AAD-V1",
                    "encryptedAttachmentKey":"wrapped-key",
                    "attachmentKeyIv":"key-iv",
                    "attachmentKeyAlgorithm":"AES-GCM-AAD-V1",
                    "encryptedContentType":"encrypted-type",
                    "encryptedContentTypeIv":"type-iv",
                    "envelopeVersion":1,
                    "fileSize":10,
                    "uploadedBy":"original-user",
                    "createdAt":"2023-11-14T22:13:22.000Z"
                }])
            }),
            _ => unreachable!(),
        }
        assert_preparing_refusal(source, fault).await;
    }
}

#[tokio::test]
async fn producer_timestamp_and_empty_attachment_spellings_map_to_canonical_overlays() {
    for (millis, source_timestamp, expected_timestamp, attachments) in [
        (
            0_u64,
            "2023-11-14T22:13:22.000Z",
            "2023-11-14T22:13:22Z",
            Some(json!([])),
        ),
        (
            7,
            "2023-11-14T22:13:22.007Z",
            "2023-11-14T22:13:22.007Z",
            None,
        ),
    ] {
        let directory = TestDirectory::new();
        let platform = Arc::new(RetainingPlatform::default());
        let mut source = failed_create_cache_source();
        mutate_queue(&mut source, |queue| {
            queue[0]["timestamp"] = json!(1_700_000_002_000_u64 + millis)
        });
        mutate_cached_item(&mut source, |item| {
            item["createdAt"] = json!(source_timestamp);
            item["updatedAt"] = json!(source_timestamp);
            if let Some(attachments) = attachments {
                item["attachments"] = attachments;
            }
        });
        let runtime = runtime_with_platform_and_source(&directory, platform, source).await;

        runtime.open().await.unwrap();
        let snapshot = replica_snapshot(&directory).await;
        let overlay = row(&snapshot, "optimisticItems");
        assert_eq!(overlay["createdAt"], expected_timestamp);
        assert_eq!(overlay["updatedAt"], expected_timestamp);
        runtime.close().await;
    }
}

#[tokio::test]
async fn held_read_only_evidence_is_allowed_but_writable_or_retained_scope_is_still_required() {
    let directory = TestDirectory::new();
    let platform = Arc::new(RetainingPlatform::default());
    let mut held = no_overlay_held_source();
    set_source_vault_role(&mut held, "read-only");
    let runtime = runtime_with_platform_and_source(&directory, platform, held).await;
    runtime.open().await.unwrap();
    let snapshot = replica_snapshot(&directory).await;
    assert_eq!(row(&snapshot, "authorityVaults")["role"], "readOnly");
    assert!(snapshot["rows"]
        .as_array()
        .unwrap()
        .iter()
        .all(|row| row["store"] != "optimisticItems"));
    runtime.close().await;

    let mut normal = queued_create::source_with_queued_create();
    set_source_vault_role(&mut normal, "read-only");
    assert_preparing_refusal(normal, "normalCreateReadOnly").await;

    let mut missing_key = failed_create_cache_source();
    Arc::get_mut(&mut missing_key).unwrap().inner.credentials[4] = None;
    assert_preparing_refusal(missing_key, "failedCreateMissingKey").await;

    let mut missing_vault = failed_create_cache_source();
    let fixture = Arc::get_mut(&mut missing_vault).unwrap();
    let mut store: Value = serde_json::from_str(&fixture.inner.store).unwrap();
    store.as_object_mut().unwrap().remove(&format!(
        "record:item-cache-stage:{}:source-generation:vaults:vault:offline",
        desktop::ACCOUNT
    ));
    fixture.inner.store = store.to_string();
    assert_preparing_refusal(missing_vault, "failedCreateMissingVault").await;
}

fn add_active_same_item_create(source: &mut Arc<Source>, active_first: bool) {
    mutate_queue(source, |queue| {
        let mut active = queue[0].clone();
        active["id"] = json!("source-command:active");
        active["operationId"] = json!("semantic:active");
        active["attemptId"] = json!("attempt:active");
        active["encryptedPayload"]["encryptedData"] = json!("active-ciphertext");
        active["encryptedPayload"]["encryptionIv"] = json!("active-iv");
        active["timestamp"] = json!(1_700_000_003_000_u64);
        active["status"] = json!("pending");
        if active_first {
            queue.insert(0, active);
        } else {
            queue.push(active);
        }
    });
}

#[tokio::test]
async fn active_same_item_create_owns_the_visible_overlay_in_both_source_orders() {
    for active_first in [false, true] {
        let directory = TestDirectory::new();
        let platform = Arc::new(RetainingPlatform::default());
        let mut source = failed_create_cache_source();
        add_active_same_item_create(&mut source, active_first);
        let runtime = runtime_with_platform_and_source(&directory, platform, source).await;

        runtime.open().await.unwrap();
        assert_locked(&runtime);
        let snapshot = replica_snapshot(&directory).await;
        let operations = rows(&snapshot, "operations");
        assert_eq!(operations.len(), 2);
        let held = operations
            .iter()
            .find(|operation| operation["operationId"] == "semantic:create")
            .unwrap();
        let active = operations
            .iter()
            .find(|operation| operation["operationId"] == "semantic:active")
            .unwrap();
        assert_eq!(
            held["legacyAdmission"]["capturedFailureCode"],
            "vault_read_only"
        );
        assert_eq!(
            held["legacyAdmission"]["sourceQueueIndex"],
            if active_first { "1" } else { "0" }
        );
        assert!(active["legacyAdmission"]
            .get("capturedFailureCode")
            .is_none());
        assert_eq!(
            active["legacyAdmission"]["sourceQueueIndex"],
            if active_first { "0" } else { "1" }
        );
        let overlays = rows(&snapshot, "optimisticItems");
        assert_eq!(overlays.len(), 1);
        assert_eq!(overlays[0]["operationId"], "semantic:active");
        assert_eq!(overlays[0]["itemId"], "queued:item");
        assert_eq!(overlays[0]["encryptedData"], "active-ciphertext");
        assert!(snapshot["rows"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["store"] != "authorityItems"));
        assert_eq!(
            row(&snapshot, "replicaMetadata")["state"],
            "refreshRequired"
        );
        runtime.close().await;
    }
}

struct AmbiguousFailedCacheInstall {
    inner: SqliteReplica,
    lose_once: AtomicBool,
    fail_next_load: AtomicBool,
    installs: AtomicUsize,
}

#[async_trait]
impl SerializedReplicaExecutor for AmbiguousFailedCacheInstall {
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
async fn ambiguous_failed_cache_install_reopens_exact_overlay_without_reinstalling() {
    let directory = TestDirectory::new();
    let platform = Arc::new(RetainingPlatform::default());
    let first_replica = Arc::new(AmbiguousFailedCacheInstall {
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
            executor: failed_create_cache_source(),
        })
        .await
        .unwrap();

    assert_eq!(
        runtime.open().await.unwrap_err().code,
        RuntimeErrorCode::StorageUnavailable
    );
    assert_eq!(first_replica.installs.load(Ordering::SeqCst), 1);
    assert_eq!(platform.catalog()["profileAdmission"]["phase"], "preparing");
    let installed = replica_snapshot(&directory).await;
    assert_failed_cache_snapshot(&installed);
    runtime.close().await;
    drop(runtime);
    drop(first_replica);

    let reopened_replica = Arc::new(AmbiguousFailedCacheInstall {
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
            executor: failed_create_cache_source(),
        })
        .await
        .unwrap();
    reopened.open().await.unwrap();
    assert_locked(&reopened);
    assert_eq!(platform.catalog()["profileAdmission"]["phase"], "committed");
    assert_eq!(reopened_replica.installs.load(Ordering::SeqCst), 0);
    let after = replica_snapshot(&directory).await;
    assert_eq!(after["rows"], installed["rows"]);
    assert_failed_projection(&reopened);
    reopened.close().await;
}
