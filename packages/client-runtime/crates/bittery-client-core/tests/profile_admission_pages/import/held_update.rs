use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

pub(super) fn held_update_source(status: &str) -> Arc<Source> {
    let mut source = queued_update::source_with_queued_update();
    mutate_queue(&mut source, |queue| queue[0]["status"] = json!(status));
    source
}

pub(super) fn mutate_queue(source: &mut Arc<Source>, mutate: impl FnOnce(&mut Vec<Value>)) {
    let fixture = Arc::get_mut(source).expect("held Update fixture has one owner");
    let mut sync: Value = serde_json::from_str(fixture.inner.sync.as_ref().unwrap()).unwrap();
    let mut queues: Value =
        serde_json::from_str(sync["bittery_pending_mutation_queues_v3"].as_str().unwrap()).unwrap();
    mutate(queues[desktop::ACCOUNT].as_array_mut().unwrap());
    sync["bittery_pending_mutation_queues_v3"] = json!(queues.to_string());
    fixture.inner.sync = Some(sync.to_string());
}

pub(super) fn mutate_cached_item(source: &mut Arc<Source>, mutate: impl FnOnce(&mut Value)) {
    let fixture = Arc::get_mut(source).expect("held Update fixture has one owner");
    let mut store: Value = serde_json::from_str(&fixture.inner.store).unwrap();
    let key = store
        .as_object()
        .unwrap()
        .keys()
        .find(|key| key.ends_with(":items:item:offline"))
        .unwrap()
        .clone();
    let mut item: Value = serde_json::from_str(store[&key].as_str().unwrap()).unwrap();
    mutate(&mut item);
    store[key] = json!(item.to_string());
    fixture.inner.store = store.to_string();
}

pub(super) fn set_source_vault_role(source: &mut Arc<Source>, role: &str) {
    let fixture = Arc::get_mut(source).expect("held Update fixture has one owner");
    let mut keys: Value =
        serde_json::from_str(fixture.inner.credentials[4].as_ref().unwrap()).unwrap();
    keys[0]["role"] = json!(role);
    fixture.inner.credentials[4] = Some(keys.to_string());
}

pub(super) async fn replica_rows(directory: &TestDirectory) -> Vec<Value> {
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

fn rows_in(rows: &[Value], store: &str) -> Vec<Value> {
    rows.iter()
        .filter(|row| row["store"] == store)
        .map(|row| serde_json::from_str(row["payloadJson"].as_str().unwrap()).unwrap())
        .collect()
}

fn operation(rows: &[Value], operation_id: &str) -> Value {
    let operations: Vec<_> = rows_in(rows, "operations")
        .into_iter()
        .filter(|operation| operation["operationId"] == operation_id)
        .collect();
    assert_eq!(operations.len(), 1, "{operation_id}");
    operations.into_iter().next().unwrap()
}

pub(super) fn expected_confirmed_item() -> Value {
    json!({
        "id":"item:offline",
        "vaultId":"vault:offline",
        "category":"login",
        "encryptedData":"offline-ciphertext",
        "encryptionIv":"offline-iv",
        "encryptionAlgorithm":"AES-GCM-AAD-V1",
        "encryptionVersion":3,
        "encryptedByUserId":"original-user",
        "lastModifiedBy":"original-user",
        "favorite":true,
        "version":6,
        "createdAt":"2026-09-20T00:00:00Z",
        "updatedAt":"2026-09-20T00:01:00Z",
        "deletedAt":null,
        "attachments":[{
            "id":"attachment", "itemId":"item:offline", "vaultId":"vault:offline",
            "storageKey":"opaque", "encryptedName":"name", "encryptionIv":"iv",
            "encryptionAlgorithm":"AES-GCM-AAD-V1", "encryptedAttachmentKey":"wrapped-key",
            "attachmentKeyIv":"key-iv", "attachmentKeyAlgorithm":"AES-GCM-AAD-V1",
            "encryptedContentType":"type", "encryptedContentTypeIv":"type-iv", "envelopeVersion":1,
            "fileSize":10, "uploadedBy":"original-user", "createdAt":"2026-09-20T00:00:00Z"
        }]
    })
}

fn set_newer_confirmed_cache(source: &mut Arc<Source>) {
    mutate_cached_item(source, |item| {
        item["encryptedData"] = json!("current-authority-ciphertext");
        item["encryptionIv"] = json!("current-authority-iv");
        item["encryptionVersion"] = json!(4);
        item["encryptedByUserId"] = json!("current-authority-user");
        item["lastModifiedBy"] = json!("current-authority-user");
        item["favorite"] = json!(false);
        item["version"] = json!(9);
        item["updatedAt"] = json!("2026-09-20T00:09:00Z");
    });
}

fn expected_newer_confirmed_item() -> Value {
    let mut item = expected_confirmed_item();
    item["encryptedData"] = json!("current-authority-ciphertext");
    item["encryptionIv"] = json!("current-authority-iv");
    item["encryptionVersion"] = json!(4);
    item["encryptedByUserId"] = json!("current-authority-user");
    item["lastModifiedBy"] = json!("current-authority-user");
    item["favorite"] = json!(false);
    item["version"] = json!(9);
    item["updatedAt"] = json!("2026-09-20T00:09:00Z");
    item
}

fn newer_held_update_source(status: &str, read_only: bool) -> Arc<Source> {
    let mut source = held_update_source(status);
    set_newer_confirmed_cache(&mut source);
    mutate_queue(&mut source, |queue| {
        let command = &mut queue[0];
        command["retryCount"] = json!(4);
        command["lastError"] = json!("newer authority stopped original Update");
        command["nextAttemptAt"] = json!(1_800_000_000_123_u64);
        command["conflictCopyId"] = json!("independent-copy:item");
        command["projectionClaimId"] = json!("retired-newer-cache-projector");
        command["projectionClaimExpiresAt"] = json!(1_800_000_000_456_u64);
    });
    if read_only {
        set_source_vault_role(&mut source, "read-only");
    }
    source
}

fn expected_newer_source_command(status: &str) -> Value {
    json!({
        "accountId":desktop::ACCOUNT,
        "accountEmail":"Person@example.test",
        "id":"source-command:update",
        "operationId":"semantic:update",
        "attemptId":"attempt:update",
        "type":"update",
        "entityId":"item:offline",
        "vaultId":"vault:offline",
        "encryptedPayload":{
            "encryptionVersion":7,
            "encryptedByUserId":"original-user"
        },
        "baseVersion":6,
        "timestamp":"1700000002000",
        "retryCount":"4",
        "status":status,
        "lastError":"newer authority stopped original Update",
        "nextAttemptAt":"1800000000123",
        "conflictCopyId":"independent-copy:item",
        "projectionClaimId":"retired-newer-cache-projector",
        "projectionClaimExpiresAt":"1800000000456"
    })
}

#[tokio::test]
async fn failed_update_with_exact_confirmed_base_is_admitted_as_nonexecuting_hold() {
    let directory = TestDirectory::new();
    let platform = Arc::new(RetainingPlatform::default());
    let source = held_update_source("failed");
    let runtime =
        runtime_with_platform_and_source(&directory, platform.clone(), source.clone()).await;

    runtime.open().await.unwrap();
    assert_locked(&runtime);
    assert_eq!(platform.catalog()["profileAdmission"]["phase"], "committed");
    let rows = replica_rows(&directory).await;
    let operation = operation(&rows, "attempt:update");
    assert_eq!(operation["operationId"], "attempt:update");
    assert_eq!(operation["kind"], "update_item");
    assert_eq!(
        operation["target"],
        json!({"type":"item","itemId":"item:offline","vaultId":"vault:offline"})
    );
    assert_eq!(operation["request"]["method"], "PATCH");
    assert_eq!(operation["request"]["path"], "/api/v1/items/item%3Aoffline");
    assert_eq!(
        operation["request"]["headers"],
        json!([
            {"name":"Content-Type","value":"application/merge-patch+json"},
            {"name":"If-Match","value":"\"6\""}
        ])
    );
    assert_eq!(
        operation["request"]["body"],
        json!(b"{\"encryptedData\":\"updated-ciphertext\",\"encryptionIv\":\"updated-iv\",\"encryptionAlgorithm\":\"AES-GCM-AAD-V1\"}".as_slice())
    );
    let evidence = &operation["legacyAdmission"];
    assert_eq!(evidence["sourceQueueIndex"], "0");
    assert_eq!(evidence["disposition"], "legacyFailed");
    assert_eq!(evidence["sourceCommand"]["id"], "source-command:update");
    assert_eq!(evidence["sourceCommand"]["operationId"], "semantic:update");
    assert_eq!(evidence["sourceCommand"]["attemptId"], "attempt:update");
    assert_eq!(evidence["sourceCommand"]["status"], "failed");
    assert!(evidence.get("overlaySha256").is_none());
    assert!(evidence.get("capturedFailureCode").is_none());

    assert!(rows_in(&rows, "optimisticItems").is_empty());
    let authority = rows_in(&rows, "authorityItems");
    assert_eq!(authority, vec![expected_confirmed_item()]);
    runtime.close().await;

    let source_calls = source.calls.lock().unwrap().len();
    let reopened = Runtime::with_serialized_executors(
        Arc::new(SqliteReplica::open(directory.0.join("replica.sqlite")).unwrap()),
        platform,
        Arc::new(NoNetwork),
    );
    reopened.open().await.unwrap();
    assert_locked(&reopened);
    assert_eq!(source.calls.lock().unwrap().len(), source_calls);
    assert_eq!(replica_rows(&directory).await, rows);
    reopened.close().await;
}

#[tokio::test]
async fn both_update_holds_keep_original_request_over_newer_read_only_authority_and_reopen_source_free(
) {
    for status in ["failed", "conflicted"] {
        let directory = TestDirectory::new();
        let platform = Arc::new(RetainingPlatform::default());
        let source = newer_held_update_source(status, true);
        let runtime =
            runtime_with_platform_and_source(&directory, platform.clone(), source.clone()).await;

        runtime.open().await.unwrap();
        assert_locked(&runtime);
        assert_eq!(platform.catalog()["profileAdmission"]["phase"], "committed");
        let rows = replica_rows(&directory).await;
        let operation = operation(&rows, "attempt:update");
        assert_eq!(operation["operationId"], "attempt:update");
        assert_eq!(operation["kind"], "update_item");
        assert_eq!(operation["acceptedItemCategory"], "login");
        assert_eq!(
            operation["target"],
            json!({"type":"item","itemId":"item:offline","vaultId":"vault:offline"})
        );
        assert_eq!(operation["request"]["method"], "PATCH");
        assert_eq!(operation["request"]["path"], "/api/v1/items/item%3Aoffline");
        assert_eq!(
            operation["request"]["headers"],
            json!([
                {"name":"Content-Type","value":"application/merge-patch+json"},
                {"name":"If-Match","value":"\"6\""}
            ])
        );
        assert_eq!(
            operation["request"]["body"],
            json!(b"{\"encryptedData\":\"updated-ciphertext\",\"encryptionIv\":\"updated-iv\",\"encryptionAlgorithm\":\"AES-GCM-AAD-V1\"}".as_slice())
        );
        assert_eq!(
            operation["requestFingerprint"],
            "05051adcb2ce49e0bc5b0666fb2c54bf9479387deaf6c18937e66999a5ecca07"
        );
        let evidence = &operation["legacyAdmission"];
        assert_eq!(evidence["sourceQueueIndex"], "0");
        assert_eq!(
            evidence["disposition"],
            if status == "failed" {
                "legacyFailed"
            } else {
                "legacyConflicted"
            }
        );
        assert_eq!(
            evidence["sourceCommand"],
            expected_newer_source_command(status)
        );
        assert!(evidence.get("overlaySha256").is_none());
        assert!(evidence.get("capturedFailureCode").is_none());
        assert_eq!(operation["scheduling"]["attemptCount"], "4");
        assert_eq!(operation["scheduling"]["notBeforeMs"], "1800000000123");
        assert!(rows_in(&rows, "optimisticItems").is_empty());
        assert_eq!(
            rows_in(&rows, "authorityItems"),
            vec![expected_newer_confirmed_item()]
        );
        let vaults = rows_in(&rows, "authorityVaults");
        assert_eq!(vaults.len(), 1);
        assert_eq!(vaults[0]["role"], "readOnly");
        runtime.close().await;

        let source_calls = source.calls.lock().unwrap().len();
        let reopened = Runtime::with_serialized_executors(
            Arc::new(SqliteReplica::open(directory.0.join("replica.sqlite")).unwrap()),
            platform,
            Arc::new(NoNetwork),
        );
        reopened.open().await.unwrap();
        assert_locked(&reopened);
        assert_eq!(source.calls.lock().unwrap().len(), source_calls);
        assert_eq!(replica_rows(&directory).await, rows);
        reopened.close().await;
    }
}

#[tokio::test]
async fn newer_cache_hold_retains_independent_conflict_copy_work_without_claiming_its_overlay() {
    let directory = TestDirectory::new();
    let platform = Arc::new(RetainingPlatform::default());
    let mut source = newer_held_update_source("conflicted", false);
    mutate_queue(&mut source, |queue| {
        let independent = independent_create_from(&queue[0]);
        queue.push(independent);
    });
    let runtime = runtime_with_platform_and_source(&directory, platform, source).await;

    runtime.open().await.unwrap();
    assert_locked(&runtime);
    let rows = replica_rows(&directory).await;
    let held = operation(&rows, "attempt:update");
    assert_eq!(held["legacyAdmission"]["sourceQueueIndex"], "0");
    assert_eq!(
        held["legacyAdmission"]["sourceCommand"]["conflictCopyId"],
        "independent-copy:item"
    );
    assert!(held["legacyAdmission"].get("overlaySha256").is_none());
    let independent = operation(&rows, "semantic:independent-copy");
    assert_eq!(independent["legacyAdmission"]["sourceQueueIndex"], "1");
    assert_eq!(independent["legacyAdmission"]["disposition"], "normal");
    let overlays = rows_in(&rows, "optimisticItems");
    assert_eq!(overlays.len(), 1);
    assert_eq!(overlays[0]["operationId"], "semantic:independent-copy");
    assert_eq!(overlays[0]["itemId"], "independent-copy:item");
    assert_eq!(
        rows_in(&rows, "authorityItems"),
        vec![expected_newer_confirmed_item()]
    );
    runtime.close().await;
}

#[tokio::test]
async fn conflicted_update_preserves_complete_source_history_without_owning_an_overlay() {
    let directory = TestDirectory::new();
    let platform = Arc::new(RetainingPlatform::default());
    let mut source = held_update_source("conflicted");
    mutate_queue(&mut source, |queue| {
        let command = &mut queue[0];
        command["retryCount"] = json!(4);
        command["lastError"] = json!("source conflict retained");
        command["nextAttemptAt"] = json!(1_800_000_000_123_u64);
        command["conflictCopyId"] = json!("conflict-copy:item");
        command["projectionClaimId"] = json!("retired-popup-claim");
        command["projectionClaimExpiresAt"] = json!(1_800_000_000_456_u64);
    });
    let runtime = runtime_with_platform_and_source(&directory, platform, source).await;

    runtime.open().await.unwrap();
    assert_locked(&runtime);
    let rows = replica_rows(&directory).await;
    let operation = operation(&rows, "attempt:update");
    assert_eq!(
        operation["legacyAdmission"]["sourceCommand"],
        json!({
            "accountId":desktop::ACCOUNT,
            "accountEmail":"Person@example.test",
            "id":"source-command:update",
            "operationId":"semantic:update",
            "attemptId":"attempt:update",
            "type":"update",
            "entityId":"item:offline",
            "vaultId":"vault:offline",
            "encryptedPayload":{
                "encryptionVersion":7,
                "encryptedByUserId":"original-user"
            },
            "baseVersion":6,
            "timestamp":"1700000002000",
            "retryCount":"4",
            "status":"conflicted",
            "lastError":"source conflict retained",
            "nextAttemptAt":"1800000000123",
            "conflictCopyId":"conflict-copy:item",
            "projectionClaimId":"retired-popup-claim",
            "projectionClaimExpiresAt":"1800000000456"
        })
    );
    let evidence = &operation["legacyAdmission"];
    assert_eq!(evidence["sourceQueueIndex"], "0");
    assert_eq!(evidence["disposition"], "legacyConflicted");
    assert!(evidence.get("overlaySha256").is_none());
    assert!(evidence.get("capturedFailureCode").is_none());
    assert_eq!(operation["scheduling"]["attemptCount"], "4");
    assert_eq!(operation["scheduling"]["notBeforeMs"], "1800000000123");
    assert!(rows_in(&rows, "optimisticItems").is_empty());
    assert_eq!(
        rows_in(&rows, "authorityItems"),
        vec![expected_confirmed_item()]
    );
    runtime.close().await;
}

#[tokio::test]
async fn held_update_can_retain_a_visible_read_only_base_without_authorizing_a_write() {
    let directory = TestDirectory::new();
    let platform = Arc::new(RetainingPlatform::default());
    let mut source = held_update_source("failed");
    set_source_vault_role(&mut source, "read-only");
    let runtime = runtime_with_platform_and_source(&directory, platform, source).await;

    runtime.open().await.unwrap();
    assert_locked(&runtime);
    let rows = replica_rows(&directory).await;
    let operation = operation(&rows, "attempt:update");
    assert_eq!(operation["legacyAdmission"]["disposition"], "legacyFailed");
    assert!(operation["legacyAdmission"].get("overlaySha256").is_none());
    assert_eq!(
        rows_in(&rows, "authorityItems"),
        vec![expected_confirmed_item()]
    );
    let vaults = rows_in(&rows, "authorityVaults");
    assert_eq!(vaults.len(), 1);
    assert_eq!(vaults[0]["role"], "readOnly");
    assert!(rows_in(&rows, "optimisticItems").is_empty());
    runtime.close().await;
}

fn active_update_from(template: &Value) -> Value {
    let mut active = template.clone();
    active["id"] = json!("source-command:active-update");
    active["operationId"] = json!("semantic:active-update");
    active["attemptId"] = json!("attempt:active-update");
    active["encryptedPayload"]["encryptedData"] = json!("active-ciphertext");
    active["encryptedPayload"]["encryptionIv"] = json!("active-iv");
    active["timestamp"] = json!(1_700_000_003_000_u64);
    active["retryCount"] = json!(0);
    active["status"] = json!("pending");
    for field in [
        "lastError",
        "nextAttemptAt",
        "conflictCopyId",
        "projectionClaimId",
        "projectionClaimExpiresAt",
    ] {
        active.as_object_mut().unwrap().remove(field);
    }
    active
}

fn independent_create_from(template: &Value) -> Value {
    let mut create = active_update_from(template);
    create["id"] = json!("source-command:independent-copy");
    create["operationId"] = json!("semantic:independent-copy");
    create["attemptId"] = json!("attempt:independent-copy");
    create["type"] = json!("create");
    create["entityId"] = json!("independent-copy:item");
    create["category"] = json!("login");
    create["baseVersion"] = json!(0);
    create["encryptedPayload"]["encryptedData"] = json!("independent-ciphertext");
    create["encryptedPayload"]["encryptionIv"] = json!("independent-iv");
    create["encryptedPayload"]["encryptionVersion"] = json!(1);
    create
}

#[tokio::test]
async fn active_same_item_update_owns_the_overlay_in_both_orders_and_independent_work_survives() {
    for active_first in [false, true] {
        let directory = TestDirectory::new();
        let platform = Arc::new(RetainingPlatform::default());
        let mut source = held_update_source("failed");
        mutate_queue(&mut source, |queue| {
            let held = queue[0].clone();
            let active = active_update_from(&held);
            let independent = independent_create_from(&held);
            *queue = if active_first {
                vec![active, held, independent]
            } else {
                vec![held, active, independent]
            };
        });
        let runtime = runtime_with_platform_and_source(&directory, platform, source).await;

        runtime.open().await.unwrap();
        assert_locked(&runtime);
        let rows = replica_rows(&directory).await;
        let held = operation(&rows, "attempt:update");
        let active = operation(&rows, "attempt:active-update");
        let independent = rows_in(&rows, "operations")
            .into_iter()
            .find(|operation| {
                operation["legacyAdmission"]["sourceCommand"]["operationId"]
                    == "semantic:independent-copy"
            })
            .unwrap();
        assert_eq!(held["legacyAdmission"]["disposition"], "legacyFailed");
        assert!(held["legacyAdmission"].get("overlaySha256").is_none());
        assert_eq!(
            held["legacyAdmission"]["sourceQueueIndex"],
            if active_first { "1" } else { "0" }
        );
        assert_eq!(active["legacyAdmission"]["disposition"], "normal");
        assert!(active["legacyAdmission"]["overlaySha256"]
            .as_str()
            .is_some_and(|hash| hash.len() == 64));
        assert_eq!(
            active["legacyAdmission"]["sourceQueueIndex"],
            if active_first { "0" } else { "1" }
        );
        assert_eq!(independent["legacyAdmission"]["sourceQueueIndex"], "2");
        let overlays = rows_in(&rows, "optimisticItems");
        assert_eq!(overlays.len(), 2);
        assert!(overlays.iter().any(|overlay| {
            overlay["itemId"] == "item:offline"
                && overlay["operationId"] == "attempt:active-update"
                && overlay["encryptedData"] == "active-ciphertext"
        }));
        assert!(overlays.iter().any(|overlay| {
            overlay["itemId"] == "independent-copy:item"
                && overlay["encryptedData"] == "independent-ciphertext"
        }));
        assert_eq!(
            rows_in(&rows, "authorityItems"),
            vec![expected_confirmed_item()]
        );
        runtime.close().await;
    }
}

struct AmbiguousHeldUpdateInstall {
    inner: SqliteReplica,
    lose_once: AtomicBool,
    fail_next_load: AtomicBool,
    installs: AtomicUsize,
}

#[async_trait]
impl SerializedReplicaExecutor for AmbiguousHeldUpdateInstall {
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
async fn ambiguous_held_update_install_reopens_the_exact_confirmed_no_overlay_snapshot() {
    let directory = TestDirectory::new();
    let platform = Arc::new(RetainingPlatform::default());
    let first_replica = Arc::new(AmbiguousHeldUpdateInstall {
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
            executor: held_update_source("failed"),
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
    let installed_operation = operation(&installed_rows, "attempt:update");
    assert!(installed_operation["legacyAdmission"]
        .get("overlaySha256")
        .is_none());
    assert!(rows_in(&installed_rows, "optimisticItems").is_empty());
    assert_eq!(
        rows_in(&installed_rows, "authorityItems"),
        vec![expected_confirmed_item()]
    );
    runtime.close().await;
    drop(runtime);
    drop(first_replica);

    let reopened_replica = Arc::new(AmbiguousHeldUpdateInstall {
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
            executor: held_update_source("failed"),
        })
        .await
        .unwrap();
    reopened.open().await.unwrap();
    assert_locked(&reopened);
    assert_eq!(platform.catalog()["profileAdmission"]["phase"], "committed");
    assert_eq!(reopened_replica.installs.load(Ordering::SeqCst), 0);
    assert_eq!(replica_rows(&directory).await, installed_rows);
    reopened.close().await;
}
