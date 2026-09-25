use super::*;

fn captured_command(source: &Source) -> Value {
    let sync: Value = serde_json::from_str(source.inner.sync.as_ref().unwrap()).unwrap();
    let queues: Value =
        serde_json::from_str(sync["bittery_pending_mutation_queues_v3"].as_str().unwrap()).unwrap();
    queues[desktop::ACCOUNT][0].clone()
}

fn captured_authority(source: &Source) -> Value {
    let store: Value = serde_json::from_str(&source.inner.store).unwrap();
    let key = format!(
        "record:item-cache-stage:{}:source-generation:items:source:item/雪",
        desktop::ACCOUNT
    );
    let mut item: Value = serde_json::from_str(store[&key].as_str().unwrap()).unwrap();
    for source_only in ["accountId", "accountEmail", "serverUrl"] {
        item.as_object_mut().unwrap().remove(source_only);
    }
    // Runtime's existing typed category spelling differs from the legacy wire.
    item["category"] = json!("secureNote");
    item
}

fn expected_command_evidence(mut command: Value) -> Value {
    // The existing workflow owns target ciphertext. Source evidence retains its typed reference.
    command["encryptedPayload"] = json!({
        "type":"target", "encryptionVersion":1, "encryptedByUserId":"target:user"
    });
    for decimal in ["timestamp", "retryCount"] {
        command[decimal] = json!(command[decimal].as_u64().unwrap().to_string());
    }
    command
}

fn has_store(snapshot: &Value, store: &str) -> bool {
    snapshot["rows"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["store"] == store)
}

async fn assert_initial_cross_admission(status: &str, held_disposition: Option<&str>) {
    let directory = TestDirectory::new();
    let platform = Arc::new(RetainingPlatform::default());
    let mut source = cross_account_source();
    mutate_command(&mut source, |command| {
        command["status"] = json!(status);
        command["retryCount"] = json!(0);
        if status != "pending" {
            command["lastError"] = json!("captured queue stopped without a child receipt");
        }
        if status == "conflicted" {
            // A source fact, not permission to synthesize an independent conflict-copy Create.
            command["conflictCopyId"] = json!("independent-copy:cross-account");
        }
    });
    let expected_source = captured_authority(&source);
    let expected_evidence = expected_command_evidence(captured_command(&source));
    let original_store = source.inner.store.clone();
    let original_sync = source.inner.sync.clone();
    let original_credentials = source.inner.credentials.clone();
    let original_target_credentials = source.second_credentials.clone();
    // This maintained public helper installs NoNetwork, which panics on any HTTP invocation.
    let runtime =
        runtime_with_platform_and_source(&directory, platform.clone(), source.clone()).await;

    runtime.open().await.unwrap();
    assert_two_locked(&runtime);
    assert_eq!(platform.catalog()["profileAdmission"]["phase"], "committed");
    let source_snapshot = snapshot(&directory, desktop::ACCOUNT).await;
    let target_snapshot = snapshot(&directory, SECOND_ACCOUNT).await;
    assert_eq!(row(&source_snapshot, "authorityItems"), expected_source);
    assert!(!has_store(&source_snapshot, "operations"));
    for absent in [
        "authorityItems",
        "operations",
        "optimisticItems",
        "crossAccountMoves",
    ] {
        assert!(!has_store(&target_snapshot, absent), "target {absent}");
    }
    assert_eq!(row(&source_snapshot, "authorityVaults")["role"], "owner");
    assert_eq!(row(&target_snapshot, "authorityVaults")["role"], "owner");

    let workflow = row(&source_snapshot, "crossAccountMoves");
    assert_eq!(workflow["operationId"], WORKFLOW_ID);
    assert_eq!(workflow["source"], expected_source);
    assert_eq!(workflow["attachments"], json!([]));
    assert_eq!(workflow["stage"], json!({"type":"targetCreate"}));
    assert_eq!(
        workflow["scheduling"],
        json!({"attemptCount":"0", "notBeforeMs":"0"})
    );
    assert_eq!(
        workflow["sourceIdentity"],
        json!({"serverUrl":SOURCE_SERVER, "userId":"source:user"})
    );
    assert_eq!(
        workflow["destinationIdentity"],
        json!({"serverUrl":TARGET_SERVER, "userId":"target:user"})
    );
    assert_eq!(workflow["destinationBinding"]["accountId"], SECOND_ACCOUNT);
    assert_eq!(
        workflow["destinationBinding"]["incarnation"],
        target_snapshot["head"]["incarnation"]
    );
    assert_eq!(workflow["destinationBinding"]["bindingRevision"], "0");
    assert_eq!(workflow["destinationBinding"]["status"], "active");
    let admission = &workflow["legacyAdmission"];
    assert_eq!(admission["version"], 1);
    assert_eq!(admission["sourceQueueIndex"], "0");
    assert_eq!(
        admission["disposition"],
        held_disposition.unwrap_or("normal")
    );
    assert_eq!(admission["sourceCommand"], expected_evidence);
    assert_eq!(
        admission["admissionId"],
        platform.catalog()["profileAdmission"]["admissionId"]
    );
    assert!(admission["admissionId"]
        .as_str()
        .is_some_and(|id| !id.is_empty()));
    assert!(admission.get("overlaySha256").is_none());
    assert_eq!(workflow["children"].as_array().unwrap().len(), 1);
    let child = &workflow["children"][0];
    let oracle = byte_oracle();
    let expected_child = &oracle["captures"][0];
    assert_eq!(child["type"], "itemOperation");
    assert_eq!(child["step"], json!({"type":"targetCreate"}));
    assert_eq!(child["endpoint"], "destination");
    assert_eq!(child["operationId"], expected_child["operationId"]);
    assert_ne!(child["operationId"], expected_evidence["attemptId"]);
    assert_eq!(child["request"]["method"], expected_child["method"]);
    assert_eq!(child["request"]["path"], expected_child["path"]);
    assert_eq!(
        child["request"]["headers"],
        json!([{"name":"Content-Type", "value":"application/json"}])
    );
    assert_eq!(
        child["request"]["body"],
        json!(expected_child["body"].as_str().unwrap().as_bytes())
    );
    assert_eq!(child.get("result"), Some(&Value::Null));
    if held_disposition.is_some() {
        assert!(!has_store(&source_snapshot, "optimisticItems"));
    } else {
        // The normal baseline remains active; widening stopped admission must not omit its effect.
        let overlay = row(&source_snapshot, "optimisticItems");
        assert_eq!(overlay["operationId"], WORKFLOW_ID);
        assert_eq!(overlay["itemId"], expected_source["id"]);
        assert_eq!(overlay["encryptedData"], expected_source["encryptedData"]);
        assert_eq!(workflow["disposition"], json!({"type":"ready"}));
    }
    assert_eq!(source.inner.store, original_store);
    assert_eq!(source.inner.sync, original_sync);
    assert_eq!(source.inner.credentials, original_credentials);
    assert_eq!(source.second_credentials, original_target_credentials);
    runtime.close().await;

    let source_calls = source.calls.lock().unwrap().len();
    let reopened = Runtime::with_serialized_executors(
        Arc::new(SqliteReplica::open(directory.0.join("replica.sqlite")).unwrap()),
        platform,
        Arc::new(NoNetwork),
    );
    reopened.open().await.unwrap();
    assert_two_locked(&reopened);
    let after_source = snapshot(&directory, desktop::ACCOUNT).await;
    let after_target = snapshot(&directory, SECOND_ACCOUNT).await;
    assert_eq!(after_source["rows"], source_snapshot["rows"]);
    assert_eq!(after_target["rows"], target_snapshot["rows"]);
    assert_eq!(source.calls.lock().unwrap().len(), source_calls);
    reopened.close().await;
}

#[tokio::test]
async fn failed_cross_account_count_zero_retains_original_work_without_an_overlay() {
    assert_initial_cross_admission("failed", Some("legacyFailed")).await;
}

#[tokio::test]
async fn conflicted_cross_account_count_zero_retains_original_work_without_an_overlay() {
    assert_initial_cross_admission("conflicted", Some("legacyConflicted")).await;
}

#[tokio::test]
async fn normal_cross_account_still_owns_its_source_overlay() {
    assert_initial_cross_admission("pending", None).await;
}

fn set_read_only(source: &mut Arc<Source>, endpoint: &str) {
    let fixture = Arc::get_mut(source).unwrap();
    let value = if endpoint == "source" {
        &mut fixture.inner.credentials[4]
    } else {
        &mut fixture.second_credentials.as_mut().unwrap()[3]
    };
    let mut keys: Value = serde_json::from_str(value.as_ref().unwrap()).unwrap();
    keys[0]["role"] = json!("read-only");
    *value = Some(keys.to_string());
}

fn rows_in(snapshot: &Value, store: &str) -> Vec<Value> {
    snapshot["rows"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["store"] == store)
        .map(|row| serde_json::from_str(row["payloadJson"].as_str().unwrap()).unwrap())
        .collect()
}

#[tokio::test]
async fn held_cross_account_accepts_each_readable_endpoint_while_normal_requires_writable() {
    for endpoint in ["source", "destination"] {
        let mut normal = cross_account_source();
        set_read_only(&mut normal, endpoint);
        assert_prewrite_refusal(normal, endpoint).await;
        for status in ["failed", "conflicted"] {
            let directory = TestDirectory::new();
            let platform = Arc::new(RetainingPlatform::default());
            let mut source = cross_account_source();
            mutate_command(&mut source, |command| command["status"] = json!(status));
            set_read_only(&mut source, endpoint);
            let expected = captured_authority(&source);
            let runtime = runtime_with_platform_and_source(&directory, platform, source).await;
            runtime.open().await.unwrap();
            assert_two_locked(&runtime);
            let source_snapshot = snapshot(&directory, desktop::ACCOUNT).await;
            let destination = snapshot(&directory, SECOND_ACCOUNT).await;
            assert_eq!(row(&source_snapshot, "authorityItems"), expected);
            assert!(!has_store(&source_snapshot, "optimisticItems"));
            assert!(!has_store(&destination, "optimisticItems"));
            let participant = if endpoint == "source" {
                &source_snapshot
            } else {
                &destination
            };
            assert_eq!(row(participant, "authorityVaults")["role"], "readOnly");
            assert_eq!(
                row(&source_snapshot, "crossAccountMoves")["children"][0]["result"],
                Value::Null
            );
            runtime.close().await;
        }
    }
}

#[tokio::test]
async fn held_cross_account_retains_full_optional_history_without_live_claim_ownership() {
    for status in ["failed", "conflicted"] {
        let directory = TestDirectory::new();
        let platform = Arc::new(RetainingPlatform::default());
        let mut source = scheduled_cross_account_source(
            Some(status),
            9,
            Some("stopped after a lost response"),
            Some(SAFE_MAX),
            Some(("departed-held-projector", Some(SAFE_MAX))),
        );
        mutate_command(&mut source, |command| {
            command["conflictCopyId"] = json!("separate-copy:item")
        });
        let mut expected = expected_command_evidence(captured_command(&source));
        for field in ["nextAttemptAt", "projectionClaimExpiresAt"] {
            expected[field] = json!(SAFE_MAX.to_string());
        }
        let runtime =
            runtime_with_platform_and_source(&directory, platform.clone(), source.clone()).await;
        runtime.open().await.unwrap();
        let before = snapshot(&directory, desktop::ACCOUNT).await;
        let workflow = row(&before, "crossAccountMoves");
        assert_eq!(workflow["legacyAdmission"]["sourceCommand"], expected);
        assert_eq!(
            workflow["scheduling"],
            json!({"attemptCount":"9", "notBeforeMs":SAFE_MAX.to_string()})
        );
        assert!(workflow.get("projectionClaimId").is_none());
        assert!(workflow.get("projectionClaimExpiresAt").is_none());
        assert!(!has_store(&before, "optimisticItems"));
        assert!(!has_store(&before, "operations"));
        runtime.close().await;
        let calls = source.calls.lock().unwrap().len();
        let reopened = Runtime::with_serialized_executors(
            Arc::new(SqliteReplica::open(directory.0.join("replica.sqlite")).unwrap()),
            platform,
            Arc::new(NoNetwork),
        );
        reopened.open().await.unwrap();
        assert_two_locked(&reopened);
        assert_eq!(
            snapshot(&directory, desktop::ACCOUNT).await["rows"],
            before["rows"]
        );
        assert_eq!(source.calls.lock().unwrap().len(), calls);
        reopened.close().await;
    }
}

#[tokio::test]
async fn held_cross_account_leaves_same_item_overlay_to_active_work_in_either_order() {
    for status in ["failed", "conflicted"] {
        for active_first in [false, true] {
            let directory = TestDirectory::new();
            let platform = Arc::new(RetainingPlatform::default());
            let mut source = cross_account_source();
            mutate_command(&mut source, |command| {
                command["status"] = json!(status);
                command["conflictCopyId"] = json!("independent-copy:item");
            });
            let expected = captured_authority(&source);
            let fixture = Arc::get_mut(&mut source).unwrap();
            let mut sync: Value =
                serde_json::from_str(fixture.inner.sync.as_ref().unwrap()).unwrap();
            let mut queues: Value =
                serde_json::from_str(sync["bittery_pending_mutation_queues_v3"].as_str().unwrap())
                    .unwrap();
            let held = queues[desktop::ACCOUNT][0].clone();
            let active = json!({
                "accountId":desktop::ACCOUNT, "accountEmail":"source@example.test",
                "id":"source-command:active-favorite", "operationId":"semantic:active-favorite",
                "attemptId":"attempt:active-favorite", "type":"toggle_favorite",
                "entityId":"source:item/雪", "vaultId":"source:vault/雪", "favorite":false,
                "baseVersion":41, "timestamp":1_770_000_000_002_u64, "retryCount":0, "status":"pending"
            });
            let mut copy = ordinary_create(
                "conflict-copy:semantic:cross-account:42",
                "independent-copy:item",
                "source:vault/雪",
            );
            copy["encryptedPayload"]["encryptedByUserId"] = json!("source:user");
            queues[desktop::ACCOUNT] = if active_first {
                json!([active, held, copy])
            } else {
                json!([held, active, copy])
            };
            sync["bittery_pending_mutation_queues_v3"] = json!(queues.to_string());
            fixture.inner.sync = Some(sync.to_string());
            let runtime = runtime_with_platform_and_source(&directory, platform, source).await;
            runtime.open().await.unwrap();
            assert_two_locked(&runtime);
            let source_snapshot = snapshot(&directory, desktop::ACCOUNT).await;
            assert_eq!(row(&source_snapshot, "authorityItems"), expected);
            let workflow = row(&source_snapshot, "crossAccountMoves");
            assert_eq!(
                workflow["legacyAdmission"]["sourceQueueIndex"],
                if active_first { "1" } else { "0" }
            );
            assert_eq!(
                workflow["legacyAdmission"]["sourceCommand"]["conflictCopyId"],
                "independent-copy:item"
            );
            let operations = rows_in(&source_snapshot, "operations");
            assert_eq!(operations.len(), 2);
            let active = operations
                .iter()
                .find(|operation| operation["operationId"] == "attempt:active-favorite")
                .unwrap();
            assert_eq!(
                active["legacyAdmission"]["sourceQueueIndex"],
                if active_first { "0" } else { "1" }
            );
            assert_eq!(active["request"]["body"], json!(b"{\"favorite\":false}"));
            let copy = operations
                .iter()
                .find(|operation| {
                    operation["operationId"] == "conflict-copy:semantic:cross-account:42"
                })
                .unwrap();
            assert_eq!(copy["legacyAdmission"]["sourceQueueIndex"], "2");
            let overlays = rows_in(&source_snapshot, "optimisticItems");
            assert_eq!(overlays.len(), 2);
            assert!(overlays
                .iter()
                .any(|overlay| overlay["itemId"] == "source:item/雪"
                    && overlay["operationId"] == "attempt:active-favorite"
                    && overlay["favorite"] == false
                    && overlay["encryptedData"] == expected["encryptedData"]));
            assert!(overlays
                .iter()
                .any(|overlay| overlay["itemId"] == "independent-copy:item"
                    && overlay["operationId"] == "conflict-copy:semantic:cross-account:42"));
            assert!(!has_store(
                &snapshot(&directory, SECOND_ACCOUNT).await,
                "operations"
            ));
            runtime.close().await;
        }
    }
}

#[tokio::test]
async fn held_cross_account_reserves_every_original_future_child_identity() {
    for status in ["failed", "conflicted"] {
        for (suffix, endpoint) in [
            ("create-target", "destination"),
            ("trash-source", "source"),
            ("delete-source", "source"),
        ] {
            let mut source = cross_account_source();
            mutate_command(&mut source, |command| command["status"] = json!(status));
            add_ordinary_child_id_owner(&mut source, suffix, endpoint);
            assert_prewrite_refusal(source, &format!("{status}:{suffix}:{endpoint}")).await;
        }
    }
}
