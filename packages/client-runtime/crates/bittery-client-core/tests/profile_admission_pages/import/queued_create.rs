use super::*;

pub(super) fn source_with_queued_create() -> Arc<Source> {
    let mut source = Source::with_cache(true);
    let fixture = Arc::get_mut(&mut source).expect("new queued Create fixture has one owner");
    let mut sync: Value = serde_json::from_str(fixture.inner.sync.as_ref().unwrap()).unwrap();
    sync["bittery_pending_mutation_queues_v3"] = json!(json!({
        desktop::ACCOUNT: [{
            "accountId": desktop::ACCOUNT,
            "accountEmail": "Person@example.test",
            "id": "source-command:create",
            "operationId": "semantic:create",
            "attemptId": "attempt:create",
            "type": "create",
            "entityId": "queued:item",
            "vaultId": "vault:offline",
            "category": "login",
            "encryptedPayload": {
                "encryptedData": "queued-ciphertext",
                "encryptionIv": "queued-iv",
                "encryptionAlgorithm": "AES-GCM-AAD-V1",
                "encryptionVersion": 1,
                "encryptedByUserId": "original-user"
            },
            "baseVersion": 0,
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
async fn queued_create_is_admitted_offline_and_survives_runtime_restart() {
    let directory = TestDirectory::new();
    let platform = Arc::new(RetainingPlatform::default());
    let source = source_with_queued_create();
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
    assert_eq!(operation["operationId"], "semantic:create");
    assert_eq!(
        operation["request"]["path"],
        "/api/v1/vaults/vault%3Aoffline/items/queued%3Aitem"
    );
    assert_eq!(operation["legacyAdmission"]["sourceQueueIndex"], "0");
    assert_eq!(
        operation["legacyAdmission"]["sourceCommand"]["attemptId"],
        "attempt:create"
    );
    assert_eq!(
        operation["request"]["body"],
        json!(b"{\"category\":\"login\",\"encryptedData\":\"queued-ciphertext\",\"encryptionIv\":\"queued-iv\",\"encryptionAlgorithm\":\"AES-GCM-AAD-V1\"}".as_slice())
    );
    let overlay = rows
        .iter()
        .find(|row| row["store"] == "optimisticItems")
        .map(|row| serde_json::from_str::<Value>(row["payloadJson"].as_str().unwrap()).unwrap())
        .unwrap();
    assert_eq!(overlay["itemId"], "queued:item");
    assert_eq!(overlay["encryptedData"], "queued-ciphertext");
    assert_eq!(overlay["operationId"], "semantic:create");
}
