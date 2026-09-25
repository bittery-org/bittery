use super::*;

pub(super) fn source_with_queued_update() -> Arc<Source> {
    let mut source = Source::with_cache(true);
    let fixture = Arc::get_mut(&mut source).expect("new queued Update fixture has one owner");
    let mut store: Value = serde_json::from_str(&fixture.inner.store).unwrap();
    let item_key = store
        .as_object()
        .unwrap()
        .keys()
        .find(|key| key.ends_with(":items:item:offline"))
        .unwrap()
        .clone();
    let mut base: Value = serde_json::from_str(store[&item_key].as_str().unwrap()).unwrap();
    base["version"] = json!(6);
    base["encryptionVersion"] = json!(3);
    base["favorite"] = json!(true);
    base["attachments"] = json!([{
        "id":"attachment", "itemId":"item:offline", "vaultId":"vault:offline",
        "storageKey":"opaque", "encryptedName":"name", "encryptionIv":"iv",
        "encryptionAlgorithm":"AES-GCM-AAD-V1", "encryptedAttachmentKey":"wrapped-key",
        "attachmentKeyIv":"key-iv", "attachmentKeyAlgorithm":"AES-GCM-AAD-V1",
        "encryptedContentType":"type", "encryptedContentTypeIv":"type-iv", "envelopeVersion":1,
        "fileSize":10, "uploadedBy":"original-user", "createdAt":"2026-09-20T00:00:00Z"
    }]);
    store[&item_key] = json!(base.to_string());
    fixture.inner.store = store.to_string();

    let mut sync: Value = serde_json::from_str(fixture.inner.sync.as_ref().unwrap()).unwrap();
    sync["bittery_pending_mutation_queues_v3"] = json!(json!({
        desktop::ACCOUNT: [{
            "accountId": desktop::ACCOUNT,
            "accountEmail": "Person@example.test",
            "id": "source-command:update",
            "operationId": "semantic:update",
            "attemptId": "attempt:update",
            "type": "update",
            "entityId": "item:offline",
            "vaultId": "vault:offline",
            "encryptedPayload": {
                "encryptedData": "updated-ciphertext",
                "encryptionIv": "updated-iv",
                "encryptionAlgorithm": "AES-GCM-AAD-V1",
                "encryptionVersion": 7,
                "encryptedByUserId": "original-user"
            },
            "baseVersion": 6,
            "timestamp": 1_700_000_002_000_u64,
            "retryCount": 0,
            "status": "pending"
        }]
    })
    .to_string());
    fixture.inner.sync = Some(sync.to_string());
    source
}

#[tokio::test]
async fn queued_update_preserves_base_authority_and_attempt_identity_across_restart() {
    let directory = TestDirectory::new();
    let platform = Arc::new(RetainingPlatform::default());
    let source = source_with_queued_update();
    let runtime =
        runtime_with_platform_and_source(&directory, platform.clone(), source.clone()).await;
    runtime.open().await.unwrap();
    assert_locked(&runtime);
    runtime.close().await;

    let source_calls = source.calls.lock().unwrap().len();
    let restarted = Runtime::with_serialized_executors(
        Arc::new(SqliteReplica::open(directory.0.join("replica.sqlite")).unwrap()),
        platform,
        Arc::new(NoNetwork),
    );
    restarted.open().await.unwrap();
    assert_locked(&restarted);
    restarted.close().await;
    assert_eq!(source.calls.lock().unwrap().len(), source_calls);

    let replica = SqliteReplica::open(directory.0.join("replica.sqlite")).unwrap();
    let loaded = SerializedReplicaExecutor::invoke(
        &replica,
        json!({"type":"load","accountId":desktop::ACCOUNT}).to_string(),
    )
    .await
    .unwrap();
    let loaded: Value = serde_json::from_str(&loaded).unwrap();
    let rows = loaded["rows"].as_array().unwrap();
    let operation = rows
        .iter()
        .find(|row| row["store"] == "operations")
        .map(|row| serde_json::from_str::<Value>(row["payloadJson"].as_str().unwrap()).unwrap())
        .unwrap();
    assert_eq!(operation["operationId"], "attempt:update");
    assert_eq!(operation["kind"], "update_item");
    assert_eq!(operation["request"]["path"], "/api/v1/items/item%3Aoffline");
    assert_eq!(operation["request"]["headers"][0]["name"], "Content-Type");
    assert_eq!(
        operation["request"]["headers"][0]["value"],
        "application/merge-patch+json"
    );
    assert_eq!(operation["request"]["headers"][1]["name"], "If-Match");
    assert_eq!(operation["request"]["headers"][1]["value"], "\"6\"");
    assert_eq!(
        operation["legacyAdmission"]["sourceCommand"]["operationId"],
        "semantic:update"
    );
    assert_eq!(
        operation["legacyAdmission"]["sourceCommand"]["attemptId"],
        "attempt:update"
    );
    assert_eq!(
        operation["request"]["body"],
        json!(b"{\"encryptedData\":\"updated-ciphertext\",\"encryptionIv\":\"updated-iv\",\"encryptionAlgorithm\":\"AES-GCM-AAD-V1\"}".as_slice())
    );

    let authority = rows
        .iter()
        .find(|row| row["store"] == "authorityItems")
        .map(|row| serde_json::from_str::<Value>(row["payloadJson"].as_str().unwrap()).unwrap())
        .unwrap();
    assert_eq!(authority["id"], "item:offline");
    assert_eq!(authority["version"], 6);
    assert_eq!(authority["encryptionVersion"], 3);
    assert_eq!(authority["encryptedData"], "offline-ciphertext");

    let overlay = rows
        .iter()
        .find(|row| row["store"] == "optimisticItems")
        .map(|row| serde_json::from_str::<Value>(row["payloadJson"].as_str().unwrap()).unwrap())
        .unwrap();
    assert_eq!(overlay["itemId"], "item:offline");
    assert_eq!(overlay["operationId"], "attempt:update");
    assert_eq!(overlay["version"], 7);
    assert_eq!(overlay["encryptionVersion"], 7);
    assert_eq!(overlay["encryptedData"], "updated-ciphertext");
    assert_eq!(overlay["favorite"], true);
    assert_eq!(overlay["attachments"], authority["attachments"]);
    assert_eq!(overlay["deletedAt"], authority["deletedAt"]);
    assert_eq!(overlay["category"], authority["category"]);
    assert!(operation["legacyAdmission"]["overlaySha256"]
        .as_str()
        .is_some_and(|hash| hash.len() == 64));
    assert_eq!(overlay["createdAt"], "2026-09-20T00:00:00Z");
    assert_eq!(overlay["updatedAt"], "2023-11-14T22:13:22Z");
}

#[tokio::test]
async fn queued_update_without_attempt_id_uses_source_id_not_semantic_id() {
    let directory = TestDirectory::new();
    let platform = Arc::new(RetainingPlatform::default());
    let mut source = source_with_queued_update();
    let inner = &mut Arc::get_mut(&mut source).unwrap().inner;
    let mut sync: Value = serde_json::from_str(inner.sync.as_ref().unwrap()).unwrap();
    let mut queue: Value =
        serde_json::from_str(sync["bittery_pending_mutation_queues_v3"].as_str().unwrap()).unwrap();
    queue[desktop::ACCOUNT][0]
        .as_object_mut()
        .unwrap()
        .remove("attemptId");
    queue[desktop::ACCOUNT][0]
        .as_object_mut()
        .unwrap()
        .remove("status");
    sync["bittery_pending_mutation_queues_v3"] = json!(queue.to_string());
    inner.sync = Some(sync.to_string());
    let runtime = runtime_with_platform_and_source(&directory, platform, source).await;
    runtime.open().await.unwrap();
    assert_locked(&runtime);
    runtime.close().await;
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
    assert_eq!(operation["operationId"], "source-command:update");
    assert_eq!(
        operation["legacyAdmission"]["sourceCommand"]["operationId"],
        "semantic:update"
    );
}

#[tokio::test]
async fn queued_update_unrepresented_or_mismatched_source_refuses_before_preparing() {
    for fault in [
        "baseVersion",
        "payloadVersion",
        "missingItem",
        "wrongVault",
        "deletedBase",
        "conflictCopy",
        "target",
        "duplicateWire",
        "duplicateSemantic",
        "duplicateSource",
        "duplicateItem",
    ] {
        let directory = TestDirectory::new();
        let platform = Arc::new(RetainingPlatform::default());
        let mut source = source_with_queued_update();
        let inner = &mut Arc::get_mut(&mut source).unwrap().inner;
        let mut sync: Value = serde_json::from_str(inner.sync.as_ref().unwrap()).unwrap();
        let mut queue: Value =
            serde_json::from_str(sync["bittery_pending_mutation_queues_v3"].as_str().unwrap())
                .unwrap();
        let command = &mut queue[desktop::ACCOUNT][0];
        match fault {
            "baseVersion" => {
                command["baseVersion"] = json!(5);
                command["encryptedPayload"]["encryptionVersion"] = json!(6);
            }
            "payloadVersion" => command["encryptedPayload"]["encryptionVersion"] = json!(4),
            "missingItem" => command["entityId"] = json!("unknown"),
            "wrongVault" => command["vaultId"] = json!("other-vault"),
            "failed" => command["status"] = json!("failed"),
            "conflicted" => command["status"] = json!("conflicted"),
            "conflictCopy" => command["conflictCopyId"] = json!("copy"),
            "target" => command["targetVaultId"] = json!("target"),
            "deletedBase" => {
                let mut store: Value = serde_json::from_str(&inner.store).unwrap();
                let key = store
                    .as_object()
                    .unwrap()
                    .keys()
                    .find(|key| key.ends_with(":items:item:offline"))
                    .unwrap()
                    .clone();
                let mut item: Value = serde_json::from_str(store[&key].as_str().unwrap()).unwrap();
                item["deletedAt"] = json!("2026-09-20T01:00:00Z");
                store[&key] = json!(item.to_string());
                inner.store = store.to_string();
            }
            _ => {
                let mut second = command.clone();
                second["id"] = json!("second-source");
                second["operationId"] = json!("second-semantic");
                second["attemptId"] = json!("second-attempt");
                second["entityId"] = json!("second-item");
                if fault != "duplicateItem" {
                    second["type"] = json!("create");
                    second["category"] = json!("login");
                    second["baseVersion"] = json!(0);
                    second["encryptedPayload"]["encryptionVersion"] = json!(1);
                }
                match fault {
                    "duplicateWire" => second["operationId"] = command["attemptId"].clone(),
                    "duplicateSemantic" => second["operationId"] = command["operationId"].clone(),
                    "duplicateSource" => second["id"] = command["id"].clone(),
                    "duplicateItem" => second["entityId"] = command["entityId"].clone(),
                    _ => unreachable!(),
                }
                queue[desktop::ACCOUNT].as_array_mut().unwrap().push(second);
            }
        }
        sync["bittery_pending_mutation_queues_v3"] = json!(queue.to_string());
        inner.sync = Some(sync.to_string());
        let runtime = runtime_with_platform_and_source(&directory, platform.clone(), source).await;
        assert!(runtime.open().await.is_err(), "{fault}");
        assert!(platform.sets.lock().unwrap().is_empty(), "{fault}");
        assert!(platform.values.lock().unwrap().is_empty(), "{fault}");
        runtime.close().await;
    }
}
