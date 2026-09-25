use super::*;

#[path = "held_cross_account.rs"]
mod held_cross_account;

#[path = "missing_source_cross_account.rs"]
mod missing_source_cross_account;

const SOURCE_SERVER: &str = "https://source.legacy.invalid";
const TARGET_SERVER: &str = "https://target.legacy.invalid";
const WORKFLOW_ID: &str = "semantic:cross-account:42";
const SAFE_MAX: u64 = 9_007_199_254_740_991;

fn byte_oracle() -> Value {
    serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../core/src/services/fixtures/legacy-cross-account-request-serialization.json"
    )))
    .unwrap()
}

fn cache_metadata(account_id: &str, generation: &str, server_url: &str, item_count: u64) -> Value {
    let items_prefix = format!("record:item-cache-stage:{account_id}:{generation}:items:");
    let vaults_prefix = format!("record:item-cache-stage:{account_id}:{generation}:vaults:");
    json!({
        "v":2,
        "itemsPrimed":true,
        "vaultsPrimed":true,
        "metadata":{
            "lastFullSyncAt":1_770_000_000_000_u64,
            "itemCount":item_count,
            "cacheVersion":1,
            "syncBaseline":{"serverUrl":server_url,"cursorId":format!("cursor:{account_id}")}
        },
        "activeGeneration":generation,
        "nativeView":{"v":1,"itemsKeyPrefix":items_prefix,"vaultsKeyPrefix":vaults_prefix}
    })
}

fn vault(account_id: &str, email: &str, server_url: &str, id: &str, name: &str) -> Value {
    json!({
        "id":id,
        "name":name,
        "type":"personal",
        "icon":null,
        "imageUrl":null,
        "accountId":account_id,
        "accountEmail":email,
        "serverUrl":server_url
    })
}

fn cross_account_source() -> Arc<Source> {
    let mut source = Source::two_accounts();
    let fixture = Arc::get_mut(&mut source).expect("cross-Account fixture has one owner");
    let inner = &mut fixture.inner;
    let mut store: Value = serde_json::from_str(&inner.store).unwrap();
    let mut accounts: Value =
        serde_json::from_str(store["bittery_accounts_list"].as_str().unwrap()).unwrap();
    for (index, (server_url, user_id, email, name)) in [
        (
            SOURCE_SERVER,
            "source:user",
            "source@example.test",
            "Source Account",
        ),
        (
            TARGET_SERVER,
            "target:user",
            "target@example.test",
            "Target Account",
        ),
    ]
    .into_iter()
    .enumerate()
    {
        accounts["accounts"][index]["serverUrl"] = json!(server_url);
        accounts["accounts"][index]["userId"] = json!(user_id);
        accounts["accounts"][index]["email"] = json!(email);
        accounts["accounts"][index]["name"] = json!(name);
    }
    store["bittery_accounts_list"] = json!(accounts.to_string());
    store[format!("bittery_account_{}_server_url", desktop::ACCOUNT)] = json!(SOURCE_SERVER);
    store[format!("bittery_account_{SECOND_ACCOUNT}_server_url")] = json!(TARGET_SERVER);

    let source_generation = "source-generation";
    let target_generation = "target-generation";
    store[format!("record:{}:meta:meta", desktop::ACCOUNT)] =
        json!(cache_metadata(desktop::ACCOUNT, source_generation, SOURCE_SERVER, 1).to_string());
    store[format!("record:{SECOND_ACCOUNT}:meta:meta")] =
        json!(cache_metadata(SECOND_ACCOUNT, target_generation, TARGET_SERVER, 0).to_string());
    let source_prefix = format!(
        "record:item-cache-stage:{}:{source_generation}:",
        desktop::ACCOUNT
    );
    let target_prefix = format!("record:item-cache-stage:{SECOND_ACCOUNT}:{target_generation}:");
    store[format!("{source_prefix}vaults:source:vault/雪")] = json!(vault(
        desktop::ACCOUNT,
        "source@example.test",
        SOURCE_SERVER,
        "source:vault/雪",
        "Source Vault"
    )
    .to_string());
    store[format!("{target_prefix}vaults:target:vault/目标")] = json!(vault(
        SECOND_ACCOUNT,
        "target@example.test",
        TARGET_SERVER,
        "target:vault/目标",
        "Target Vault"
    )
    .to_string());
    store[format!("{source_prefix}items:source:item/雪")] = json!(json!({
        "id":"source:item/雪",
        "vaultId":"source:vault/雪",
        "category":"secure-note",
        "favorite":true,
        "encryptedData":"source-ciphertext",
        "encryptionIv":"source-iv",
        "encryptionAlgorithm":"AES-GCM-AAD-V1",
        "version":41,
        "encryptionVersion":3,
        "encryptedByUserId":"source:user",
        "lastModifiedBy":"source:user",
        "createdAt":"2026-02-02T00:00:00Z",
        "updatedAt":"2026-02-02T00:01:00Z",
        "deletedAt":null,
        "attachments":[],
        "accountId":desktop::ACCOUNT,
        "accountEmail":"source@example.test",
        "serverUrl":SOURCE_SERVER
    })
    .to_string());

    let mut source_session: Value =
        serde_json::from_str(inner.credentials[2].as_ref().unwrap()).unwrap();
    let mut target_session = source_session.clone();
    source_session["email"] = json!("source@example.test");
    source_session["userId"] = json!("source:user");
    target_session["email"] = json!("target@example.test");
    target_session["userId"] = json!("target:user");
    inner.credentials[2] = Some(source_session.to_string());
    inner.credentials[3] = None;
    inner.credentials[4] = Some(
        json!([
            {"vaultId":"source:vault/雪","encryptedVaultKey":"wrapped-source-key","role":"owner","vaultIcon":null,"vaultImageUrl":null,"vaultName":"Source Vault","vaultType":"personal"}
        ])
        .to_string(),
    );
    inner.credentials[5] = None;
    let second_credentials = vec![
        inner.credentials[1].clone(),
        Some(target_session.to_string()),
        None,
        Some(
            json!([
                {"vaultId":"target:vault/目标","encryptedVaultKey":"wrapped-target-key","role":"owner","vaultIcon":null,"vaultImageUrl":null,"vaultName":"Target Vault","vaultType":"personal"}
            ])
            .to_string(),
        ),
        None,
    ];

    let mut command = byte_oracle()["command"].clone();
    command["accountId"] = json!(desktop::ACCOUNT);
    command["accountEmail"] = json!("source@example.test");
    command["targetAccountId"] = json!(SECOND_ACCOUNT);
    let mut sync = serde_json::Map::new();
    sync.insert(
        "bittery_sync_client_id".into(),
        json!("cross-account-client"),
    );
    sync.insert(
        "bittery_pending_mutation_queues_v3".into(),
        json!(json!({desktop::ACCOUNT:[command]}).to_string()),
    );
    for (account_id, server_url) in [
        (desktop::ACCOUNT, SOURCE_SERVER),
        (SECOND_ACCOUNT, TARGET_SERVER),
    ] {
        let source_id = format!(
            "account:{}:server:{}",
            encode_component(account_id),
            encode_component(server_url)
        );
        let prefix = format!("sync_source_{}:", encode_component(&source_id));
        sync.insert(
            format!("{prefix}syncBaselineV1"),
            json!(
                json!({"initialized":true,"cursor":{"id":format!("cursor:{account_id}")}})
                    .to_string()
            ),
        );
        sync.insert(
            format!("{prefix}lastSyncCursor"),
            json!(json!({"id":format!("cursor:{account_id}")}).to_string()),
        );
    }
    inner.store = store.to_string();
    inner.sync = Some(Value::Object(sync).to_string());
    fixture.second_credentials = Some(second_credentials);
    source
}

fn mutate_store(source: &mut Arc<Source>, mutate: impl FnOnce(&mut Value)) {
    let fixture = Arc::get_mut(source).expect("cross-Account fixture has one owner");
    let mut store: Value = serde_json::from_str(&fixture.inner.store).unwrap();
    mutate(&mut store);
    fixture.inner.store = store.to_string();
}

fn mutate_command(source: &mut Arc<Source>, mutate: impl FnOnce(&mut Value)) {
    let fixture = Arc::get_mut(source).expect("cross-Account fixture has one owner");
    let mut sync: Value = serde_json::from_str(fixture.inner.sync.as_ref().unwrap()).unwrap();
    let mut queues: Value =
        serde_json::from_str(sync["bittery_pending_mutation_queues_v3"].as_str().unwrap()).unwrap();
    mutate(&mut queues[desktop::ACCOUNT][0]);
    sync["bittery_pending_mutation_queues_v3"] = json!(queues.to_string());
    fixture.inner.sync = Some(sync.to_string());
}

fn scheduled_cross_account_source(
    status: Option<&str>,
    retry_count: u64,
    last_error: Option<&str>,
    next_attempt_at: Option<u64>,
    claim: Option<(&str, Option<u64>)>,
) -> Arc<Source> {
    let mut source = cross_account_source();
    mutate_command(&mut source, |command| {
        let command = command.as_object_mut().unwrap();
        command.insert("attemptId".into(), json!("attempt:reminted:history"));
        command.insert("retryCount".into(), json!(retry_count));
        for field in [
            "status",
            "lastError",
            "nextAttemptAt",
            "projectionClaimId",
            "projectionClaimExpiresAt",
        ] {
            command.remove(field);
        }
        if let Some(status) = status {
            command.insert("status".into(), json!(status));
        }
        if let Some(last_error) = last_error {
            command.insert("lastError".into(), json!(last_error));
        }
        if let Some(next_attempt_at) = next_attempt_at {
            command.insert("nextAttemptAt".into(), json!(next_attempt_at));
        }
        if let Some((claim_id, expires_at)) = claim {
            command.insert("projectionClaimId".into(), json!(claim_id));
            if let Some(expires_at) = expires_at {
                command.insert("projectionClaimExpiresAt".into(), json!(expires_at));
            }
        }
    });
    source
}

fn target_item() -> Value {
    json!({
        "id":"target:item/雪",
        "vaultId":"target:vault/目标",
        "category":"secure-note",
        "favorite":false,
        "encryptedData":"target-ciphertext-雪",
        "encryptionIv":"target-iv",
        "encryptionAlgorithm":"AES-GCM-AAD-V1",
        "version":1,
        "encryptionVersion":1,
        "encryptedByUserId":"target:user",
        "lastModifiedBy":"target:user",
        "createdAt":"2026-02-02T00:00:00Z",
        "updatedAt":"2026-02-02T00:01:00Z",
        "deletedAt":null,
        "attachments":[],
        "accountId":SECOND_ACCOUNT,
        "accountEmail":"target@example.test",
        "serverUrl":TARGET_SERVER
    })
}

fn add_target_item(source: &mut Arc<Source>, changed: bool) {
    mutate_store(source, |store| {
        let metadata_key = format!("record:{SECOND_ACCOUNT}:meta:meta");
        let mut metadata: Value =
            serde_json::from_str(store[&metadata_key].as_str().unwrap()).unwrap();
        metadata["metadata"]["itemCount"] = json!(1);
        store[&metadata_key] = json!(metadata.to_string());
        let mut item = target_item();
        if changed {
            item["encryptedData"] = json!("foreign-target-ciphertext");
        }
        store[format!(
            "record:item-cache-stage:{SECOND_ACCOUNT}:target-generation:items:target:item/雪"
        )] = json!(item.to_string());
    });
}

async fn assert_prewrite_refusal(source: Arc<Source>, label: &str) {
    let directory = TestDirectory::new();
    let platform = Arc::new(RetainingPlatform::default());
    platform.values.lock().unwrap().insert(
        (
            "deviceSecret".into(),
            "unrelated-cross-account-evidence".into(),
        ),
        "unchanged protected value".into(),
    );
    let protected_before = platform.values.lock().unwrap().clone();
    let source_store_before = source.inner.store.clone();
    let source_sync_before = source.inner.sync.clone();
    let source_credentials_before = source.inner.credentials.clone();
    let target_credentials_before = source.second_credentials.clone();
    let source_replica_before = snapshot(&directory, desktop::ACCOUNT).await;
    let target_replica_before = snapshot(&directory, SECOND_ACCOUNT).await;
    let runtime =
        runtime_with_platform_and_source(&directory, platform.clone(), source.clone()).await;
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
    assert_eq!(
        *platform.values.lock().unwrap(),
        protected_before,
        "{label}"
    );
    assert_eq!(source.inner.store, source_store_before, "{label}");
    assert_eq!(source.inner.sync, source_sync_before, "{label}");
    assert_eq!(
        source.inner.credentials, source_credentials_before,
        "{label}"
    );
    assert_eq!(
        source.second_credentials, target_credentials_before,
        "{label} target credentials"
    );
    assert_eq!(
        snapshot(&directory, desktop::ACCOUNT).await,
        source_replica_before,
        "{label} source Replica"
    );
    assert_eq!(
        snapshot(&directory, SECOND_ACCOUNT).await,
        target_replica_before,
        "{label} target Replica"
    );
    runtime.close().await;
}

async fn snapshot(directory: &TestDirectory, account_id: &str) -> Value {
    let replica = SqliteReplica::open(directory.0.join("replica.sqlite")).unwrap();
    let loaded = replica
        .invoke(json!({"type":"load","accountId":account_id}).to_string())
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

fn assert_two_locked(runtime: &Arc<Runtime>) {
    let sink = Arc::new(Sink::default());
    let observation = runtime
        .observe(
            ObservationRequest::RuntimeStatus { account_id: None },
            sink.clone(),
        )
        .unwrap();
    let RuntimeProjection::RuntimeStatus(status) = sink.0.lock().unwrap().last().cloned().unwrap()
    else {
        panic!("expected Runtime status")
    };
    observation.close();
    assert!(!status.closed);
    assert_eq!(status.accounts.len(), 2);
    assert!(status
        .accounts
        .iter()
        .all(|account| account.access == AccountAccessState::Locked));
}

#[tokio::test]
async fn absent_target_cross_account_move_is_admitted_without_changing_destination_authority() {
    let directory = TestDirectory::new();
    let platform = Arc::new(RetainingPlatform::default());
    let source = cross_account_source();
    let runtime =
        runtime_with_platform_and_source(&directory, platform.clone(), source.clone()).await;

    runtime.open().await.unwrap();
    assert_two_locked(&runtime);
    assert_eq!(platform.catalog()["profileAdmission"]["phase"], "committed");
    let source_snapshot = snapshot(&directory, desktop::ACCOUNT).await;
    let target_snapshot = snapshot(&directory, SECOND_ACCOUNT).await;
    assert_eq!(source_snapshot["head"]["userId"], "source:user");
    assert_eq!(target_snapshot["head"]["userId"], "target:user");
    let workflow = row(&source_snapshot, "crossAccountMoves");
    let overlay = row(&source_snapshot, "optimisticItems");
    assert_eq!(workflow["operationId"], WORKFLOW_ID);
    assert_eq!(
        workflow["sourceIdentity"],
        json!({"serverUrl":SOURCE_SERVER,"userId":"source:user"})
    );
    assert_eq!(
        workflow["destinationIdentity"],
        json!({"serverUrl":TARGET_SERVER,"userId":"target:user"})
    );
    assert_eq!(workflow["destinationBinding"]["accountId"], SECOND_ACCOUNT);
    assert_eq!(
        workflow["destinationBinding"]["incarnation"],
        target_snapshot["head"]["incarnation"]
    );
    assert_eq!(workflow["destinationBinding"]["bindingRevision"], "0");
    assert_eq!(workflow["destinationBinding"]["status"], "active");
    assert_eq!(workflow["stage"], json!({"type":"targetCreate"}));
    assert_eq!(workflow["disposition"], json!({"type":"ready"}));
    assert_eq!(workflow["source"]["id"], "source:item/雪");
    assert_eq!(workflow["source"]["version"], 41);
    assert_eq!(workflow["source"]["encryptionVersion"], 3);
    assert_eq!(workflow["source"]["favorite"], true);
    assert_eq!(workflow["target"]["id"], "target:item/雪");
    assert_eq!(workflow["target"]["version"], 1);
    assert_eq!(workflow["target"]["encryptedByUserId"], "target:user");
    assert_eq!(workflow["target"]["favorite"], false);
    assert_eq!(workflow["attachments"], json!([]));
    assert_eq!(workflow["children"].as_array().unwrap().len(), 1);
    let child = &workflow["children"][0];
    let oracle = byte_oracle();
    let expected = &oracle["captures"][0];
    assert_eq!(child["type"], "itemOperation");
    assert_eq!(child["step"], json!({"type":"targetCreate"}));
    assert_eq!(child["endpoint"], "destination");
    assert_eq!(child["operationId"], expected["operationId"]);
    assert_eq!(child["request"]["method"], expected["method"]);
    assert_eq!(child["request"]["path"], expected["path"]);
    assert_eq!(
        child["request"]["headers"],
        json!([{"name":"Content-Type","value":"application/json"}])
    );
    assert_eq!(
        child["request"]["body"],
        json!(expected["body"].as_str().unwrap().as_bytes())
    );
    assert!(child["result"].is_null());
    let source_record = workflow["source"].as_object().unwrap();
    let mut expected_overlay = source_record.clone();
    expected_overlay.insert("accountId".into(), json!(desktop::ACCOUNT));
    let source_item_id = expected_overlay.remove("id").unwrap();
    expected_overlay.insert("itemId".into(), source_item_id);
    expected_overlay.insert("operationId".into(), json!(WORKFLOW_ID));
    expected_overlay.insert("permanentlyDeleted".into(), json!(false));
    expected_overlay.remove("lastModifiedBy");
    assert_eq!(overlay, Value::Object(expected_overlay));

    let admission = &workflow["legacyAdmission"];
    assert_eq!(admission["version"], 1);
    assert!(admission["admissionId"]
        .as_str()
        .is_some_and(|id| !id.is_empty()));
    assert_eq!(admission["sourceQueueIndex"], "0");
    assert_eq!(admission["disposition"], "normal");
    let source_command = &admission["sourceCommand"];
    assert_eq!(source_command["accountId"], desktop::ACCOUNT);
    assert_eq!(source_command["accountEmail"], "source@example.test");
    assert_eq!(source_command["id"], "source-command:cross-account");
    assert_eq!(source_command["operationId"], WORKFLOW_ID);
    assert_eq!(source_command["attemptId"], "attempt:cross-account:99");
    assert_eq!(source_command["type"], "cross_account_move");
    assert_eq!(source_command["entityId"], "source:item/雪");
    assert_eq!(source_command["vaultId"], "source:vault/雪");
    assert_eq!(source_command["targetAccountId"], SECOND_ACCOUNT);
    assert_eq!(source_command["targetItemId"], "target:item/雪");
    assert_eq!(source_command["targetVaultId"], "target:vault/目标");
    assert_eq!(source_command["category"], "secure-note");
    assert_eq!(
        source_command["encryptedPayload"],
        json!({"type":"target","encryptionVersion":1,"encryptedByUserId":"target:user"})
    );
    assert_eq!(source_command["baseVersion"], 41);
    assert_eq!(source_command["timestamp"], "1770000000000");
    assert_eq!(source_command["retryCount"], "0");
    assert_eq!(source_command["status"], "pending");
    for absent in [
        "favorite",
        "lastError",
        "nextAttemptAt",
        "conflictCopyId",
        "projectionClaimId",
        "projectionClaimExpiresAt",
    ] {
        assert!(source_command.get(absent).is_none(), "unexpected {absent}");
    }
    assert!(source_snapshot["rows"]
        .as_array()
        .unwrap()
        .iter()
        .all(|row| row["store"] != "operations"));
    assert!(target_snapshot["rows"]
        .as_array()
        .unwrap()
        .iter()
        .all(|row| !matches!(
            row["store"].as_str(),
            Some("operations" | "optimisticItems" | "crossAccountMoves")
        )));
    assert!(target_snapshot["rows"]
        .as_array()
        .unwrap()
        .iter()
        .all(|row| row["store"] != "authorityItems"));
    assert_eq!(
        row(&target_snapshot, "authorityVaults"),
        json!({
            "id":"target:vault/目标",
            "name":"Target Vault",
            "vaultType":"personal",
            "icon":null,
            "imageUrl":null,
            "encryptedVaultKey":"wrapped-target-key",
            "role":"owner"
        })
    );
    runtime.close().await;

    let source_calls = source.calls.lock().unwrap().len();
    let reopened = Runtime::with_serialized_executors(
        Arc::new(SqliteReplica::open(directory.0.join("replica.sqlite")).unwrap()),
        platform,
        Arc::new(NoNetwork),
    );
    reopened.open().await.unwrap();
    assert_two_locked(&reopened);
    let reopened_source = snapshot(&directory, desktop::ACCOUNT).await;
    let reopened_target = snapshot(&directory, SECOND_ACCOUNT).await;
    for (before, after) in [
        (&source_snapshot, &reopened_source),
        (&target_snapshot, &reopened_target),
    ] {
        assert_eq!(after["rows"], before["rows"]);
        for field in [
            "accountId",
            "userId",
            "incarnation",
            "replicaRevision",
            "failure",
        ] {
            assert_eq!(after["head"][field], before["head"][field], "{field}");
        }
        let before_epoch = before["head"]["lockEpoch"]
            .as_str()
            .unwrap()
            .parse::<u64>()
            .unwrap();
        assert_eq!(after["head"]["lockEpoch"], (before_epoch + 1).to_string());
    }
    assert_eq!(source.calls.lock().unwrap().len(), source_calls);
    reopened.close().await;
}

#[tokio::test]
async fn retrying_cross_account_history_sets_the_workflow_schedule_without_reminting_children() {
    let directory = TestDirectory::new();
    let platform = Arc::new(RetainingPlatform::default());
    let deadline = 1_800_000_000_456_u64;
    let source = scheduled_cross_account_source(
        Some("retrying"),
        3,
        Some("source choreography lost its last acknowledgement"),
        Some(deadline),
        Some(("departed-cross-account-projector", Some(deadline + 1))),
    );
    let runtime =
        runtime_with_platform_and_source(&directory, platform.clone(), source.clone()).await;

    runtime.open().await.unwrap();
    assert_two_locked(&runtime);
    let source_snapshot = snapshot(&directory, desktop::ACCOUNT).await;
    let target_snapshot = snapshot(&directory, SECOND_ACCOUNT).await;
    let workflow = row(&source_snapshot, "crossAccountMoves");
    assert_eq!(
        workflow["scheduling"],
        json!({"attemptCount":"3","notBeforeMs":deadline.to_string()})
    );
    assert_eq!(workflow["stage"], json!({"type":"targetCreate"}));
    assert_eq!(workflow["disposition"], json!({"type":"ready"}));
    assert_eq!(workflow["children"].as_array().unwrap().len(), 1);
    let child = &workflow["children"][0];
    let oracle = byte_oracle();
    let expected = &oracle["captures"][0];
    assert_eq!(child["operationId"], expected["operationId"]);
    assert_eq!(child["request"]["method"], expected["method"]);
    assert_eq!(child["request"]["path"], expected["path"]);
    assert_eq!(
        child["request"]["headers"],
        json!([{"name":"Content-Type","value":"application/json"}])
    );
    assert_eq!(
        child["request"]["body"],
        json!(expected["body"].as_str().unwrap().as_bytes())
    );
    assert!(child["result"].is_null());
    assert_eq!(
        workflow["legacyAdmission"]["sourceCommand"],
        json!({
            "accountId":desktop::ACCOUNT,
            "accountEmail":"source@example.test",
            "id":"source-command:cross-account",
            "operationId":WORKFLOW_ID,
            "attemptId":"attempt:reminted:history",
            "type":"cross_account_move",
            "entityId":"source:item/雪",
            "vaultId":"source:vault/雪",
            "targetVaultId":"target:vault/目标",
            "targetAccountId":SECOND_ACCOUNT,
            "targetItemId":"target:item/雪",
            "category":"secure-note",
            "encryptedPayload":{
                "type":"target","encryptionVersion":1,"encryptedByUserId":"target:user"
            },
            "baseVersion":41,
            "timestamp":"1770000000000",
            "retryCount":"3",
            "status":"retrying",
            "lastError":"source choreography lost its last acknowledgement",
            "nextAttemptAt":deadline.to_string(),
            "projectionClaimId":"departed-cross-account-projector",
            "projectionClaimExpiresAt":(deadline + 1).to_string()
        })
    );
    assert!(workflow.get("projectionClaimId").is_none());
    assert!(workflow.get("projectionClaimExpiresAt").is_none());
    assert_eq!(
        workflow
            .to_string()
            .matches("departed-cross-account-projector")
            .count(),
        1,
        "the departed projection claim remains evidence only"
    );
    assert!(target_snapshot["rows"]
        .as_array()
        .unwrap()
        .iter()
        .all(|row| row["store"] != "crossAccountMoves"));
    runtime.close().await;

    let source_calls = source.calls.lock().unwrap().len();
    let reopened = Runtime::with_serialized_executors(
        Arc::new(SqliteReplica::open(directory.0.join("replica.sqlite")).unwrap()),
        platform,
        Arc::new(NoNetwork),
    );
    reopened.open().await.unwrap();
    assert_two_locked(&reopened);
    let reopened_source = snapshot(&directory, desktop::ACCOUNT).await;
    let reopened_target = snapshot(&directory, SECOND_ACCOUNT).await;
    assert_eq!(reopened_source["rows"], source_snapshot["rows"]);
    assert_eq!(reopened_target["rows"], target_snapshot["rows"]);
    assert_eq!(
        row(&reopened_source, "crossAccountMoves")["scheduling"],
        json!({"attemptCount":"3","notBeforeMs":deadline.to_string()})
    );
    assert_eq!(source.calls.lock().unwrap().len(), source_calls);
    reopened.close().await;
}

#[tokio::test]
async fn every_normal_cross_account_status_preserves_history_and_retires_claim_ownership() {
    for (label, status, retry_count, last_error, deadline, claim) in [
        ("absent", None, 0, None, None, None),
        (
            "staged",
            Some("staged"),
            1,
            Some("staged source history"),
            None,
            Some(("departed-staged-projector", None)),
        ),
        (
            "applying",
            Some("applying"),
            2,
            Some(""),
            None,
            Some(("departed-applying-projector", Some(SAFE_MAX))),
        ),
        (
            "pending",
            Some("pending"),
            4,
            None,
            Some(0),
            Some(("departed-expired-projector", Some(0))),
        ),
        ("retrying", Some("retrying"), 5, None, None, None),
    ] {
        let directory = TestDirectory::new();
        let platform = Arc::new(RetainingPlatform::default());
        let source =
            scheduled_cross_account_source(status, retry_count, last_error, deadline, claim);
        let runtime = runtime_with_platform_and_source(&directory, platform, source).await;

        runtime.open().await.unwrap();
        assert_two_locked(&runtime);
        let source_snapshot = snapshot(&directory, desktop::ACCOUNT).await;
        let workflow = row(&source_snapshot, "crossAccountMoves");
        let command = &workflow["legacyAdmission"]["sourceCommand"];
        assert_eq!(
            command.get("status").and_then(Value::as_str),
            status,
            "{label}"
        );
        assert_eq!(command["retryCount"], retry_count.to_string(), "{label}");
        assert_eq!(
            command.get("lastError").and_then(Value::as_str),
            last_error,
            "{label}"
        );
        assert_eq!(
            command.get("nextAttemptAt").cloned(),
            deadline.map(|value| json!(value.to_string())),
            "{label}"
        );
        assert_eq!(
            workflow["scheduling"],
            json!({
                "attemptCount":retry_count.to_string(),
                "notBeforeMs":deadline.unwrap_or(0).to_string()
            }),
            "{label}"
        );
        assert_eq!(command["attemptId"], "attempt:reminted:history", "{label}");
        assert_eq!(
            workflow["children"][0]["operationId"],
            format!("{WORKFLOW_ID}:create-target"),
            "{label}"
        );
        assert!(workflow["children"][0]["result"].is_null(), "{label}");
        assert!(workflow.get("projectionClaimId").is_none(), "{label}");
        assert!(
            workflow.get("projectionClaimExpiresAt").is_none(),
            "{label}"
        );
        match claim {
            Some((claim_id, expires_at)) => {
                assert_eq!(command["projectionClaimId"], claim_id, "{label}");
                assert_eq!(
                    command.get("projectionClaimExpiresAt").cloned(),
                    expires_at.map(|value| json!(value.to_string())),
                    "{label}"
                );
                assert_eq!(workflow.to_string().matches(claim_id).count(), 1, "{label}");
            }
            None => {
                assert!(command.get("projectionClaimId").is_none(), "{label}");
                assert!(command.get("projectionClaimExpiresAt").is_none(), "{label}");
            }
        }
        runtime.close().await;
    }
}

#[tokio::test]
async fn malformed_cross_account_schedule_and_claim_history_refuses_before_preparing() {
    for fault in [
        "retryCount",
        "nextAttemptAt",
        "claimExpiresAt",
        "emptyClaimId",
        "conflictCopy",
    ] {
        let mut source = scheduled_cross_account_source(
            Some("retrying"),
            3,
            Some("retained error"),
            Some(100),
            Some(("departed-projector", Some(200))),
        );
        mutate_command(&mut source, |command| match fault {
            "retryCount" => command["retryCount"] = json!(SAFE_MAX + 1),
            "nextAttemptAt" => command["nextAttemptAt"] = json!(SAFE_MAX + 1),
            "claimExpiresAt" => command["projectionClaimExpiresAt"] = json!(SAFE_MAX + 1),
            "emptyClaimId" => command["projectionClaimId"] = json!(""),
            "conflictCopy" => command["conflictCopyId"] = json!("unsupported-copy"),
            _ => unreachable!(),
        });
        assert_prewrite_refusal(source, fault).await;
    }
}

#[tokio::test]
async fn exact_cached_target_is_retained_without_fabricating_destination_work() {
    let directory = TestDirectory::new();
    let platform = Arc::new(RetainingPlatform::default());
    let mut source = cross_account_source();
    add_target_item(&mut source, false);
    let runtime = runtime_with_platform_and_source(&directory, platform, source).await;

    runtime.open().await.unwrap();
    assert_two_locked(&runtime);
    let source_snapshot = snapshot(&directory, desktop::ACCOUNT).await;
    let target_snapshot = snapshot(&directory, SECOND_ACCOUNT).await;
    let workflow = row(&source_snapshot, "crossAccountMoves");
    assert_eq!(workflow["stage"], json!({"type":"targetCreate"}));
    assert!(workflow["children"][0]["result"].is_null());
    assert_eq!(
        row(&target_snapshot, "authorityItems")["id"],
        "target:item/雪"
    );
    assert!(target_snapshot["rows"]
        .as_array()
        .unwrap()
        .iter()
        .all(|row| !matches!(
            row["store"].as_str(),
            Some("operations" | "optimisticItems" | "crossAccountMoves")
        )));
    runtime.close().await;
}

#[tokio::test]
async fn malformed_or_unsupported_cross_account_baselines_refuse_before_preparing() {
    for fault in [
        "unknownTargetAccount",
        "sameAccount",
        "baseVersion",
        "payloadVersion",
        "payloadWriter",
        "sameItem",
        "category",
        "trashedSource",
        "missingSource",
        "sourceAttachments",
        "missingSourceVault",
        "missingTargetVault",
        "readOnlySource",
        "readOnlyTarget",
        "conflictingTarget",
    ] {
        let mut source = cross_account_source();
        match fault {
            "unknownTargetAccount" => mutate_command(&mut source, |command| {
                command["targetAccountId"] = json!("absent-account")
            }),
            "sameAccount" => mutate_command(&mut source, |command| {
                command["targetAccountId"] = json!(desktop::ACCOUNT)
            }),
            "baseVersion" => {
                mutate_command(&mut source, |command| command["baseVersion"] = json!(40))
            }
            "payloadVersion" => mutate_command(&mut source, |command| {
                command["encryptedPayload"]["encryptionVersion"] = json!(2)
            }),
            "payloadWriter" => mutate_command(&mut source, |command| {
                command["encryptedPayload"]["encryptedByUserId"] = json!("foreign-user")
            }),
            "sameItem" => mutate_command(&mut source, |command| {
                command["targetItemId"] = json!("source:item/雪")
            }),
            "category" => mutate_store(&mut source, |store| {
                let key = format!(
                    "record:item-cache-stage:{}:source-generation:items:source:item/雪",
                    desktop::ACCOUNT
                );
                let mut item: Value = serde_json::from_str(store[&key].as_str().unwrap()).unwrap();
                item["category"] = json!("login");
                store[key] = json!(item.to_string());
            }),
            "trashedSource" => mutate_store(&mut source, |store| {
                let key = format!(
                    "record:item-cache-stage:{}:source-generation:items:source:item/雪",
                    desktop::ACCOUNT
                );
                let mut item: Value = serde_json::from_str(store[&key].as_str().unwrap()).unwrap();
                item["deletedAt"] = json!("2026-02-02T00:02:00Z");
                store[key] = json!(item.to_string());
            }),
            "missingSource" => mutate_store(&mut source, |store| {
                store.as_object_mut().unwrap().remove(&format!(
                    "record:item-cache-stage:{}:source-generation:items:source:item/雪",
                    desktop::ACCOUNT
                ));
                let metadata_key = format!("record:{}:meta:meta", desktop::ACCOUNT);
                let mut metadata: Value =
                    serde_json::from_str(store[&metadata_key].as_str().unwrap()).unwrap();
                metadata["metadata"]["itemCount"] = json!(0);
                store[metadata_key] = json!(metadata.to_string());
            }),
            "sourceAttachments" => mutate_store(&mut source, |store| {
                let key = format!(
                    "record:item-cache-stage:{}:source-generation:items:source:item/雪",
                    desktop::ACCOUNT
                );
                let mut item: Value = serde_json::from_str(store[&key].as_str().unwrap()).unwrap();
                item["attachments"] = json!([{
                    "id":"attachment","itemId":"source:item/雪","vaultId":"source:vault/雪",
                    "storageKey":"opaque","encryptedName":"name","encryptionIv":"iv",
                    "encryptionAlgorithm":"AES-GCM-AAD-V1","encryptedAttachmentKey":"wrapped",
                    "attachmentKeyIv":"key-iv","attachmentKeyAlgorithm":"AES-GCM-AAD-V1",
                    "encryptedContentType":"type","encryptedContentTypeIv":"type-iv",
                    "envelopeVersion":1,"fileSize":10,"uploadedBy":"target:user",
                    "createdAt":"2026-02-02T00:00:00Z"
                }]);
                store[key] = json!(item.to_string());
            }),
            "missingSourceVault" | "missingTargetVault" => mutate_store(&mut source, |store| {
                let suffix = if fault == "missingSourceVault" {
                    "source-generation:vaults:source:vault/雪"
                } else {
                    "target-generation:vaults:target:vault/目标"
                };
                let account = if fault == "missingSourceVault" {
                    desktop::ACCOUNT
                } else {
                    SECOND_ACCOUNT
                };
                store
                    .as_object_mut()
                    .unwrap()
                    .remove(&format!("record:item-cache-stage:{account}:{suffix}"));
            }),
            "readOnlySource" | "readOnlyTarget" => {
                let fixture = Arc::get_mut(&mut source).unwrap();
                let value = if fault == "readOnlySource" {
                    &mut fixture.inner.credentials[4]
                } else {
                    &mut fixture.second_credentials.as_mut().unwrap()[3]
                };
                let mut keys: Value = serde_json::from_str(value.as_ref().unwrap()).unwrap();
                keys[0]["role"] = json!("read-only");
                *value = Some(keys.to_string());
            }
            "conflictingTarget" => add_target_item(&mut source, true),
            _ => unreachable!(),
        }
        assert_prewrite_refusal(source, fault).await;
    }
}

fn ordinary_create(operation_id: &str, item_id: &str, vault_id: &str) -> Value {
    json!({
        "accountId":desktop::ACCOUNT,
        "accountEmail":"source@example.test",
        "id":format!("source:{operation_id}"),
        "operationId":operation_id,
        "attemptId":format!("attempt:{operation_id}"),
        "type":"create",
        "entityId":item_id,
        "vaultId":vault_id,
        "category":"secure-note",
        "encryptedPayload":{
            "encryptedData":"collision-ciphertext","encryptionIv":"collision-iv",
            "encryptionAlgorithm":"AES-GCM-AAD-V1","encryptionVersion":1,
            "encryptedByUserId":"target:user"
        },
        "baseVersion":0,"timestamp":1_770_000_000_001_u64,"retryCount":0,"status":"pending"
    })
}

fn add_ordinary_child_id_owner(source: &mut Arc<Source>, child_suffix: &str, endpoint: &str) {
    let fixture = Arc::get_mut(source).unwrap();
    let mut sync: Value = serde_json::from_str(fixture.inner.sync.as_ref().unwrap()).unwrap();
    let mut queues: Value =
        serde_json::from_str(sync["bittery_pending_mutation_queues_v3"].as_str().unwrap()).unwrap();
    let operation_id = format!("{WORKFLOW_ID}:{child_suffix}");
    let (account_id, account_email, item_id, vault_id) = if endpoint == "source" {
        (
            desktop::ACCOUNT,
            "source@example.test",
            format!("collision:{child_suffix}:source"),
            "source:vault/雪",
        )
    } else {
        (
            SECOND_ACCOUNT,
            "target@example.test",
            format!("collision:{child_suffix}:destination"),
            "target:vault/目标",
        )
    };
    let mut command = ordinary_create(&operation_id, &item_id, vault_id);
    command["accountId"] = json!(account_id);
    command["accountEmail"] = json!(account_email);
    command["encryptedPayload"]["encryptedByUserId"] = json!(if endpoint == "source" {
        "source:user"
    } else {
        "target:user"
    });
    if !queues[account_id].is_array() {
        queues[account_id] = json!([]);
    }
    queues[account_id]
        .as_array_mut()
        .expect("fixture Account queue")
        .push(command);
    sync["bittery_pending_mutation_queues_v3"] = json!(queues.to_string());
    fixture.inner.sync = Some(sync.to_string());
}

#[tokio::test]
async fn every_future_child_identity_collision_refuses_before_preparing() {
    for (child_suffix, endpoint) in [
        ("create-target", "destination"),
        ("trash-source", "source"),
        ("delete-source", "source"),
        ("create-target", "source"),
    ] {
        let mut source = cross_account_source();
        add_ordinary_child_id_owner(&mut source, child_suffix, endpoint);
        assert_prewrite_refusal(source, &format!("{child_suffix}:{endpoint}")).await;
    }
}

#[tokio::test]
async fn source_child_ids_remain_available_to_unrelated_destination_operations() {
    let directory = TestDirectory::new();
    let platform = Arc::new(RetainingPlatform::default());
    let mut source = cross_account_source();
    for suffix in ["trash-source", "delete-source"] {
        add_ordinary_child_id_owner(&mut source, suffix, "destination");
    }
    let runtime = runtime_with_platform_and_source(&directory, platform, source).await;

    runtime.open().await.unwrap();
    assert_two_locked(&runtime);
    let destination = snapshot(&directory, SECOND_ACCOUNT).await;
    let mut operation_ids: Vec<_> = destination["rows"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["store"] == "operations")
        .map(|row| {
            serde_json::from_str::<Value>(row["payloadJson"].as_str().unwrap()).unwrap()
                ["operationId"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect();
    operation_ids.sort();
    assert_eq!(
        operation_ids,
        [
            format!("{WORKFLOW_ID}:delete-source"),
            format!("{WORKFLOW_ID}:trash-source"),
        ]
    );
    runtime.close().await;
}

struct AmbiguousCrossAccountInstall {
    inner: SqliteReplica,
    lose_source_once: AtomicBool,
    fail_next_load: AtomicBool,
    installs: Mutex<Vec<String>>,
}

#[async_trait]
impl SerializedReplicaExecutor for AmbiguousCrossAccountInstall {
    async fn invoke(&self, request: String) -> Result<String, RuntimeError> {
        let value: Value = serde_json::from_str(&request).unwrap();
        if value["type"] == "load" && self.fail_next_load.swap(false, Ordering::SeqCst) {
            return Err(unavailable());
        }
        let reply = self.inner.invoke(request).await?;
        if value["type"] == "install" {
            let account_id = value["prepared"]["nextHead"]["accountId"]
                .as_str()
                .unwrap()
                .to_owned();
            self.installs.lock().unwrap().push(account_id.clone());
            if account_id == desktop::ACCOUNT && self.lose_source_once.swap(false, Ordering::SeqCst)
            {
                self.fail_next_load.store(true, Ordering::SeqCst);
                return Err(unavailable());
            }
        }
        Ok(reply)
    }
}

#[tokio::test]
async fn ambiguous_source_install_reopens_exact_workflow_before_installing_destination() {
    let directory = TestDirectory::new();
    let platform = Arc::new(RetainingPlatform::default());
    let first_replica = Arc::new(AmbiguousCrossAccountInstall {
        inner: SqliteReplica::open(directory.0.join("replica.sqlite")).unwrap(),
        lose_source_once: AtomicBool::new(true),
        fail_next_load: AtomicBool::new(false),
        installs: Mutex::new(Vec::new()),
    });
    let runtime =
        runtime_with_platform_and_replica(&directory, platform.clone(), first_replica.clone())
            .await;
    runtime
        .set_profile_admission_source(ProfileAdmissionSource::Legacy {
            format: LegacyProfileFormat::DesktopLegacyV1,
            executor: cross_account_source(),
        })
        .await
        .unwrap();

    assert_eq!(
        runtime.open().await.unwrap_err().code,
        RuntimeErrorCode::StorageUnavailable
    );
    assert_eq!(
        first_replica.installs.lock().unwrap().as_slice(),
        [desktop::ACCOUNT]
    );
    assert_eq!(platform.catalog()["profileAdmission"]["phase"], "preparing");
    let installed_source = snapshot(&directory, desktop::ACCOUNT).await;
    assert_eq!(
        row(&installed_source, "crossAccountMoves")["operationId"],
        WORKFLOW_ID
    );
    assert_eq!(
        row(&installed_source, "optimisticItems")["operationId"],
        WORKFLOW_ID
    );
    let absent_target = snapshot(&directory, SECOND_ACCOUNT).await;
    assert!(absent_target["head"].is_null());
    assert!(absent_target["rows"].as_array().unwrap().is_empty());
    runtime.close().await;
    drop(runtime);
    drop(first_replica);

    let reopened_replica = Arc::new(AmbiguousCrossAccountInstall {
        inner: SqliteReplica::open(directory.0.join("replica.sqlite")).unwrap(),
        lose_source_once: AtomicBool::new(false),
        fail_next_load: AtomicBool::new(false),
        installs: Mutex::new(Vec::new()),
    });
    let reopened =
        runtime_with_platform_and_replica(&directory, platform.clone(), reopened_replica.clone())
            .await;
    reopened
        .set_profile_admission_source(ProfileAdmissionSource::Legacy {
            format: LegacyProfileFormat::DesktopLegacyV1,
            executor: cross_account_source(),
        })
        .await
        .unwrap();
    reopened.open().await.unwrap();
    assert_two_locked(&reopened);
    assert_eq!(platform.catalog()["profileAdmission"]["phase"], "committed");
    assert_eq!(
        reopened_replica.installs.lock().unwrap().as_slice(),
        [SECOND_ACCOUNT]
    );
    let reopened_source = snapshot(&directory, desktop::ACCOUNT).await;
    assert_eq!(reopened_source["rows"], installed_source["rows"]);
    assert_eq!(
        row(
            &snapshot(&directory, SECOND_ACCOUNT).await,
            "authorityVaults"
        )["id"],
        "target:vault/目标"
    );
    reopened.close().await;
}
