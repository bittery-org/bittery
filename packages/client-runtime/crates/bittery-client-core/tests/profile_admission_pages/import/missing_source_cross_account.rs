//! A real producer acknowledgement cut retains normal work without inventing source evidence.
use super::*;

#[path = "missing_source_target.rs"]
mod target_tests;

#[path = "missing_source_unlock.rs"]
mod unlock_tests;

fn acknowledgement_crash_oracle() -> Value {
    serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../core/src/services/fixtures/legacy-cross-account-missing-source-acknowledgement.json"))).unwrap()
}

fn acknowledgement_crash_source() -> (Arc<Source>, Value) {
    let (source, command) = acknowledgement_crash_source_from(&acknowledgement_crash_oracle());
    assert_eq!(command["status"], "pending");
    assert_eq!(command["retryCount"], 0);
    assert_eq!(command["operationId"], command["id"]);
    assert_eq!(command["attemptId"], command["id"]);
    assert!(command.get("lastError").is_none());
    assert!(command.get("nextAttemptAt").is_none());
    (source, command)
}

fn acknowledgement_crash_source_from(oracle: &Value) -> (Arc<Source>, Value) {
    let (source, mut commands) = acknowledgement_crash_source_commands(oracle);
    assert_eq!(commands.len(), 1);
    (source, commands.remove(0))
}

fn acknowledgement_crash_source_commands(oracle: &Value) -> (Arc<Source>, Vec<Value>) {
    // Credential/service fixtures supply only the host envelope. Replace every cache record and
    // the entire queue/Sync page with actual producer output; no original source is repaired here.
    let mut source = cross_account_source();
    let fixture = Arc::get_mut(&mut source).unwrap();
    let mut store: Value = serde_json::from_str(&fixture.inner.store).unwrap();
    store
        .as_object_mut()
        .unwrap()
        .retain(|key, _| !key.starts_with("record:"));
    let mut accounts: Value =
        serde_json::from_str(store["bittery_accounts_list"].as_str().unwrap()).unwrap();
    accounts["accounts"] = oracle["accounts"].clone();
    store["bittery_accounts_list"] = json!(accounts.to_string());
    for row in oracle["records"].as_array().unwrap() {
        let key = format!(
            "record:{}:{}",
            row["collection"].as_str().unwrap(),
            row["id"].as_str().unwrap()
        );
        assert!(store
            .as_object_mut()
            .unwrap()
            .insert(key, row["value"].clone())
            .is_none());
        assert_ne!(
            row["id"], "source:item/雪",
            "the frozen capture contains no original source row"
        );
    }
    for account in oracle["accounts"].as_array().unwrap() {
        let session_slot = if account["accountId"] == desktop::ACCOUNT {
            &mut fixture.inner.credentials[2]
        } else {
            assert_eq!(account["accountId"], SECOND_ACCOUNT);
            &mut fixture.second_credentials.as_mut().unwrap()[1]
        };
        let mut session: Value = serde_json::from_str(session_slot.as_ref().unwrap()).unwrap();
        session["email"] = account["email"].clone();
        session["userId"] = account["userId"].clone();
        *session_slot = Some(session.to_string());
        let keys_slot = if account["accountId"] == desktop::ACCOUNT {
            &mut fixture.inner.credentials[4]
        } else {
            &mut fixture.second_credentials.as_mut().unwrap()[3]
        };
        let mut keys: Value = serde_json::from_str(keys_slot.as_ref().unwrap()).unwrap();
        for key in keys.as_array_mut().unwrap() {
            let cached = oracle["records"]
                .as_array()
                .unwrap()
                .iter()
                .find_map(|row| {
                    let value: Value =
                        serde_json::from_str(row["value"].as_str().unwrap()).unwrap();
                    (value["id"] == key["vaultId"] && value["accountId"] == account["accountId"])
                        .then_some(value)
                })
                .unwrap();
            key["vaultName"] = cached["name"].clone();
            key["vaultType"] = cached["type"].clone();
            key["vaultIcon"] = cached["icon"].clone();
            key["vaultImageUrl"] = cached["imageUrl"].clone();
        }
        *keys_slot = Some(keys.to_string());
    }
    fixture.inner.store = store.to_string();
    fixture.inner.sync = Some(oracle["sync"].to_string());
    let queues: Value = serde_json::from_str(
        oracle["sync"]["bittery_pending_mutation_queues_v3"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    let commands = queues[desktop::ACCOUNT].as_array().unwrap().clone();
    (source, commands)
}

fn assert_parked_projection(runtime: &Arc<Runtime>, operation_id: &str) {
    assert_parked_projection_count(runtime, operation_id, 0);
}

fn assert_parked_projection_count(runtime: &Arc<Runtime>, operation_id: &str, attempts: u64) {
    let sink = Arc::new(Sink::default());
    let handle = runtime
        .observe(
            ObservationRequest::Operations {
                account_id: desktop::ACCOUNT.into(),
            },
            sink.clone(),
        )
        .unwrap();
    let RuntimeProjection::Operations(projection) = sink.0.lock().unwrap().last().cloned().unwrap()
    else {
        panic!("expected Operations");
    };
    handle.close();
    let value = serde_json::to_value(projection).unwrap();
    assert_eq!(value["operations"].as_array().unwrap().len(), 1);
    let operation = &value["operations"][0];
    assert_eq!(operation["operationId"], operation_id);
    assert_eq!(operation["resolution"], "pending");
    assert_eq!(operation["attemptCount"], attempts.to_string());
    assert!(operation["nextAttemptAtMs"].is_null());
    assert_eq!(
        operation["crossAccountMove"]["phase"],
        json!({"type":"targetCreate"})
    );
    assert_eq!(operation["crossAccountMove"]["sourceVisible"], false);
    assert_eq!(
        operation["crossAccountMove"]["disposition"],
        json!({"type":"blocked","reason":"missingSourceEvidence"})
    );
}

#[tokio::test]
async fn actual_pending_acknowledgement_crash_admits_one_parked_owner_and_reopens_without_source() {
    let (source, command) = acknowledgement_crash_source();
    let operation_id = command["operationId"].as_str().unwrap();
    let frozen_store = source.inner.store.clone();
    let frozen_sync = source.inner.sync.clone();
    let directory = TestDirectory::new();
    let platform = Arc::new(RetainingPlatform::default());
    let runtime =
        runtime_with_platform_and_source(&directory, platform.clone(), source.clone()).await;
    runtime.open().await.unwrap();
    assert_two_locked(&runtime);
    assert_eq!(platform.catalog()["profileAdmission"]["phase"], "committed");
    let source_snapshot = snapshot(&directory, desktop::ACCOUNT).await;
    let target_snapshot = snapshot(&directory, SECOND_ACCOUNT).await;
    for snapshot in [&source_snapshot, &target_snapshot] {
        for forbidden in [
            "authorityItems",
            "operations",
            "optimisticItems",
            "operationReceipts",
        ] {
            assert!(
                !snapshot["rows"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|row| row["store"] == forbidden),
                "{forbidden}"
            );
        }
    }
    assert!(!target_snapshot["rows"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["store"] == "crossAccountMoves"));
    let parked = row(&source_snapshot, "crossAccountMoves");
    assert_eq!(parked["type"], "legacySourceUnavailable");
    assert_eq!(parked["version"], 1);
    assert_eq!(parked["operationId"], operation_id);
    for forbidden in [
        "source",
        "target",
        "children",
        "attachments",
        "stage",
        "disposition",
    ] {
        assert!(parked.get(forbidden).is_none(), "no fabricated {forbidden}");
    }
    let mut evidence = command.clone();
    evidence["encryptedPayload"] = json!({"type":"target","encryptionVersion":command["encryptedPayload"]["encryptionVersion"],"encryptedByUserId":command["encryptedPayload"]["encryptedByUserId"]});
    for decimal in ["timestamp", "retryCount"] {
        evidence[decimal] = json!(command[decimal].as_u64().unwrap().to_string());
    }
    assert_eq!(parked["legacyAdmission"]["sourceCommand"], evidence);
    assert_eq!(parked["legacyAdmission"]["disposition"], "normal");
    assert_eq!(parked["legacyAdmission"]["sourceQueueIndex"], "0");
    assert_eq!(
        parked["legacyAdmission"]["admissionId"],
        platform.catalog()["profileAdmission"]["admissionId"]
    );
    assert_eq!(
        parked["scheduling"],
        json!({"attemptCount":"0","notBeforeMs":"0"})
    );
    assert_eq!(
        parked["sourceIdentity"],
        json!({"serverUrl":SOURCE_SERVER,"userId":"source:user"})
    );
    assert_eq!(
        parked["destinationIdentity"],
        json!({"serverUrl":TARGET_SERVER,"userId":"target:user"})
    );
    assert_eq!(
        parked["destinationBinding"],
        json!({"accountId":SECOND_ACCOUNT,"incarnation":target_snapshot["head"]["incarnation"],"bindingRevision":"0","status":"active"})
    );
    let create = &parked["targetCreate"];
    assert_eq!(
        create["operationId"],
        format!("{operation_id}:create-target")
    );
    assert_eq!(create["step"], json!({"type":"targetCreate"}));
    assert_eq!(create["endpoint"], "destination");
    assert!(create["result"].is_null());
    assert_eq!(create["request"]["method"], "PUT");
    assert_eq!(
        create["request"]["path"],
        format!(
            "/api/v1/vaults/{}/items/{}",
            encode_component(command["targetVaultId"].as_str().unwrap()),
            encode_component(command["targetItemId"].as_str().unwrap())
        )
    );
    assert_eq!(
        create["request"]["headers"],
        json!([{"name":"Content-Type","value":"application/json"}])
    );
    let payload = &command["encryptedPayload"];
    let body = format!(
        r#"{{"category":{},"encryptedData":{},"encryptionIv":{},"encryptionAlgorithm":{}}}"#,
        command["category"],
        payload["encryptedData"],
        payload["encryptionIv"],
        payload["encryptionAlgorithm"]
    );
    assert_eq!(create["request"]["body"], json!(body.as_bytes()));
    assert_parked_projection(&runtime, operation_id);
    assert_eq!(source.inner.store, frozen_store);
    assert_eq!(source.inner.sync, frozen_sync);
    runtime.close().await;
    let calls = source.calls.lock().unwrap().len();
    // Existing configured helper installs NoNetwork and has no legacy source executor.
    let reopened = runtime_with_platform(&directory, platform).await;
    reopened.open().await.unwrap();
    assert_two_locked(&reopened);
    assert_eq!(
        snapshot(&directory, desktop::ACCOUNT).await["rows"],
        source_snapshot["rows"]
    );
    assert_eq!(
        snapshot(&directory, SECOND_ACCOUNT).await["rows"],
        target_snapshot["rows"]
    );
    assert_eq!(source.calls.lock().unwrap().len(), calls);
    assert_parked_projection(&reopened, operation_id);
    reopened.close().await;
}
