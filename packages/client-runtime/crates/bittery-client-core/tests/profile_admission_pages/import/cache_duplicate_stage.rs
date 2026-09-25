use super::*;

fn duplicate_stage_source() -> Arc<Source> {
    let mut source = Source::with_cache(true);
    let fixture = Arc::get_mut(&mut source).expect("new source has one owner");
    let mut store: Value = serde_json::from_str(&fixture.inner.store).unwrap();
    let active = format!(
        "record:item-cache-stage:{}:source-generation:",
        desktop::ACCOUNT
    );
    let state_key = format!("record:{}:meta:meta", desktop::ACCOUNT);
    let mut state: Value = serde_json::from_str(store[&state_key].as_str().unwrap()).unwrap();
    state["activeGeneration"] = json!("source-generation");
    state["nativeView"]["itemsKeyPrefix"] = json!(format!("{active}items:"));
    state["nativeView"]["vaultsKeyPrefix"] = json!(format!("{active}vaults:"));
    store[&state_key] = json!(state.to_string());
    let stage = format!("record:item-cache-stage:{}:pending:", desktop::ACCOUNT);
    for (kind, id) in [
        ("items", "item:offline"),
        ("vaults", "vault:offline"),
        ("item-baseline", "item:offline"),
        ("vault-baseline", "vault:offline"),
    ] {
        let active_kind = if kind.starts_with("item") {
            "items"
        } else {
            "vaults"
        };
        let value = store[format!("{active}{active_kind}:{id}")].clone();
        store[format!("{stage}{kind}:{id}")] = value;
    }
    fixture.inner.store = store.to_string();
    // The real producer cut has ItemCache metadata but no independent Sync checkpoint.
    let mut sync: Value = serde_json::from_str(fixture.inner.sync.as_ref().unwrap()).unwrap();
    sync.as_object_mut()
        .unwrap()
        .retain(|key, _| !key.ends_with(":syncBaselineV1") && !key.ends_with(":lastSyncCursor"));
    fixture.inner.sync = Some(sync.to_string());
    source
}

#[tokio::test]
async fn duplicate_only_unpublished_cache_reopens_locked_with_original_active_authority() {
    let directory = TestDirectory::new();
    let platform = Arc::new(RetainingPlatform::default());
    let source = duplicate_stage_source();
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
    assert_eq!(
        rows.iter()
            .filter(|row| row["store"] == "authorityItems")
            .count(),
        1
    );
    assert_eq!(
        rows.iter()
            .filter(|row| row["store"] == "authorityVaults")
            .count(),
        1
    );
    let payload = |name: &str| -> Value {
        serde_json::from_str(
            rows.iter().find(|row| row["store"] == name).unwrap()["payloadJson"]
                .as_str()
                .unwrap(),
        )
        .unwrap()
    };
    assert_eq!(
        payload("authorityItems")["encryptedData"],
        "offline-ciphertext"
    );
    assert_eq!(payload("authorityVaults")["id"], "vault:offline");
    assert_eq!(
        payload("bootstrapGenerations")["legacyAdmission"]["sourceActiveGeneration"],
        "source-generation"
    );
    assert_eq!(payload("replicaMetadata")["state"], "refreshRequired");
    assert_eq!(payload("replicaMetadata")["activeCursor"]["type"], "cold");
    assert!(rows.iter().all(|row| row["store"] != "bootstrapPages"));
}

async fn refused_without_publication(label: &str, change: impl FnOnce(&mut Value)) {
    let mut source = duplicate_stage_source();
    let fixture = Arc::get_mut(&mut source).unwrap();
    let mut store: Value = serde_json::from_str(&fixture.inner.store).unwrap();
    change(&mut store);
    fixture.inner.store = store.to_string();
    let original_source = fixture.inner.store.clone();
    let directory = TestDirectory::new();
    let platform = Arc::new(RetainingPlatform::default());
    let runtime =
        runtime_with_platform_and_source(&directory, platform.clone(), source.clone()).await;
    let error = runtime.open().await.expect_err(label);
    assert!(
        matches!(
            error.code,
            RuntimeErrorCode::SourceFailure | RuntimeErrorCode::InvariantViolation
        ),
        "{label}: {error:?}"
    );
    assert_eq!(
        source.inner.store, original_source,
        "{label}: source changed"
    );
    assert!(
        platform.sets.lock().unwrap().is_empty(),
        "{label}: catalog was staged"
    );
    assert!(
        platform.values.lock().unwrap().is_empty(),
        "{label}: protected storage was written"
    );
    let replica = SqliteReplica::open(directory.0.join("replica.sqlite")).unwrap();
    let loaded = SerializedReplicaExecutor::invoke(
        &replica,
        json!({"type":"load","accountId":desktop::ACCOUNT}).to_string(),
    )
    .await
    .unwrap();
    let loaded: Value = serde_json::from_str(&loaded).unwrap();
    assert!(
        loaded["head"].is_null(),
        "{label}: Replica head was published"
    );
    assert!(
        loaded["rows"].as_array().unwrap().is_empty(),
        "{label}: Replica rows were staged"
    );
    runtime.close().await;
}

#[tokio::test]
async fn unpublished_cache_evidence_outside_duplicate_rule_refuses_before_writes() {
    let account = desktop::ACCOUNT;
    let stage_item =
        format!("record:item-cache-stage:{account}:pending:item-baseline:item:offline");
    let active_item =
        format!("record:item-cache-stage:{account}:source-generation:items:item:offline");
    refused_without_publication("byte-different equivalent JSON", |store| {
        let raw = store[&stage_item].as_str().unwrap().to_owned();
        store[&stage_item] = json!(format!("{raw} "));
    })
    .await;
    refused_without_publication("missing active counterpart", |store| {
        store.as_object_mut().unwrap().remove(&active_item);
    })
    .await;
    refused_without_publication("absent explicit Account scope", |store| {
        let mut row: Value = serde_json::from_str(store[&active_item].as_str().unwrap()).unwrap();
        row.as_object_mut().unwrap().remove("accountId");
        store[&active_item] = json!(row.to_string());
        store[&stage_item] = json!(row.to_string());
    })
    .await;
    refused_without_publication("second nonactive generation", |store| {
        let raw = store[&stage_item].clone();
        store[format!("record:item-cache-stage:{account}:other:item-baseline:item:offline")] = raw;
    })
    .await;
    refused_without_publication("unknown Account interpretation", |store| {
        let raw = store[&stage_item].clone();
        store["record:item-cache-stage:unknown:pending:item-baseline:item:offline"] = raw;
    })
    .await;

    refused_without_publication("consumed active key has unknown stage owner", |store| {
        let stage_prefix = format!("record:item-cache-stage:{account}:pending:");
        store
            .as_object_mut()
            .unwrap()
            .retain(|key, _| !key.starts_with(&stage_prefix));
        let raw = store[&active_item].as_str().unwrap();
        let mut item: Value = serde_json::from_str(raw).unwrap();
        let ambiguous_id = "unknown:later:vaults:vault:offline";
        item["id"] = json!(ambiguous_id);
        store
            [format!("record:item-cache-stage:{account}:source-generation:items:{ambiguous_id}")] =
            json!(item.to_string());
    })
    .await;
}
