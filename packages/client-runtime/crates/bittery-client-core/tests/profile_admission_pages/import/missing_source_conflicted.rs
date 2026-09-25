//! Genuine independent copy ciphertext stays separate from unavailable original evidence.
use super::*;

#[path = "missing_source_conflicted_dispatch.rs"]
mod dispatch_tests;
use dispatch_tests::{assert_only_independent_copy_dispatches, CopyDispatchNetwork};

fn conflicted_oracle() -> Value {
    serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"),
        "/../../../core/src/services/fixtures/legacy-cross-account-missing-source-conflicted-independent-copy.json"))).unwrap()
}

fn immutable_create_body(command: &Value) -> Vec<u8> {
    format!(
        "{{\"category\":{},\"encryptedData\":{},\"encryptionIv\":{},\"encryptionAlgorithm\":{}}}",
        serde_json::to_string(&command["category"]).unwrap(),
        serde_json::to_string(&command["encryptedPayload"]["encryptedData"]).unwrap(),
        serde_json::to_string(&command["encryptedPayload"]["encryptionIv"]).unwrap(),
        serde_json::to_string(&command["encryptedPayload"]["encryptionAlgorithm"]).unwrap()
    )
    .into_bytes()
}

fn expected_lineage(command: &Value, cross_account: bool) -> Value {
    let mut expected = command.clone();
    expected["encryptedPayload"] = json!({"encryptionVersion":command["encryptedPayload"]["encryptionVersion"],"encryptedByUserId":command["encryptedPayload"]["encryptedByUserId"]});
    if cross_account {
        expected["encryptedPayload"]["type"] = json!("target");
    }
    for decimal in [
        "timestamp",
        "retryCount",
        "nextAttemptAt",
        "projectionClaimExpiresAt",
    ] {
        if let Some(value) = command.get(decimal) {
            expected[decimal] = json!(value.as_u64().unwrap().to_string());
        }
    }
    expected
}

fn assert_conflicted_projection(runtime: &Arc<Runtime>, original: &Value, copy: &Value) {
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
        panic!("Operations")
    };
    let value = serde_json::to_value(projection).unwrap();
    let operations = value["operations"].as_array().unwrap();
    assert_eq!(operations.len(), 2);
    let held = operations
        .iter()
        .find(|op| op["operationId"] == original["operationId"])
        .unwrap();
    assert_eq!(held["resolution"], "legacyConflicted");
    assert_eq!(
        held["attemptCount"],
        original["retryCount"].as_u64().unwrap().to_string()
    );
    assert!(held["nextAttemptAtMs"].is_null());
    assert_eq!(
        held["crossAccountMove"]["phase"],
        json!({"type":"targetCreate"})
    );
    assert_eq!(held["crossAccountMove"]["sourceVisible"], false);
    assert_eq!(
        held["crossAccountMove"]["disposition"],
        json!({"type":"legacyHeld"})
    );
    let ordinary = operations
        .iter()
        .find(|op| op["operationId"] == copy["operationId"])
        .unwrap();
    assert_eq!(ordinary["resolution"], "pending");
    assert_eq!(
        ordinary["attemptCount"],
        copy["retryCount"].as_u64().unwrap().to_string()
    );
    assert_eq!(
        ordinary["nextAttemptAtMs"],
        copy["nextAttemptAt"].as_u64().unwrap().to_string()
    );
    assert!(ordinary["crossAccountMove"].is_null());
    observation.close();
}

fn assert_exact_copy_readable(runtime: &Arc<Runtime>, copy: &Value) {
    // Same known producer Vault key, never post-capture re-encryption or reconstructed source.
    let encrypted = bittery_crypto_core::EncryptedData {
        ciphertext: copy["encryptedPayload"]["encryptedData"]
            .as_str()
            .unwrap()
            .into(),
        iv: copy["encryptedPayload"]["encryptionIv"]
            .as_str()
            .unwrap()
            .into(),
        algorithm: copy["encryptedPayload"]["encryptionAlgorithm"]
            .as_str()
            .unwrap()
            .into(),
    };
    let plain = bittery_crypto_core::decrypt_with_aad(
        &encrypted,
        &[0x47; 32],
        &bittery_crypto_core::AadContext {
            vault_id: copy["vaultId"].as_str().unwrap().into(),
            entity_id: copy["entityId"].as_str().unwrap().into(),
            entity_type: "item".into(),
            version: copy["encryptedPayload"]["encryptionVersion"]
                .as_u64()
                .unwrap(),
            user_id: copy["encryptedPayload"]["encryptedByUserId"]
                .as_str()
                .unwrap()
                .into(),
        },
    )
    .expect("actual producer copy must decrypt with real Rust crypto and its original AAD");
    let plain: Value = serde_json::from_str(&plain).unwrap();
    assert!(!plain["title"].as_str().unwrap().is_empty());
    let sink = Arc::new(Sink::default());
    let observation = runtime
        .observe(
            ObservationRequest::Items {
                account_id: desktop::ACCOUNT.into(),
            },
            sink.clone(),
        )
        .unwrap();
    let RuntimeProjection::Items(projection) = sink.0.lock().unwrap().last().cloned().unwrap()
    else {
        panic!("Items")
    };
    assert_eq!(projection.items.len(), 1);
    let item = &projection.items[0];
    assert_eq!(item.item_id, copy["entityId"].as_str().unwrap());
    assert_ne!(item.item_id, "source:item/雪");
    let visible = serde_json::to_value(&item.data).unwrap();
    assert_eq!(visible["category"], copy["category"]);
    for (key, value) in plain.as_object().unwrap() {
        assert_eq!(&visible["data"][key], value, "{key}");
    }
    observation.close();
}

#[tokio::test]
async fn actual_conflicted_source_free_capture_preserves_both_owners_and_real_copy_ciphertext() {
    assert_conflicted_capture(
        conflicted_oracle(),
        0,
        ExpectedAttemptRelation::Original,
        1_001,
    )
    .await;
}

pub(super) enum ExpectedAttemptRelation {
    Original,
    Reminted,
}

pub(super) async fn assert_conflicted_capture(
    oracle: Value,
    original_attempt_count: u64,
    attempt_relation: ExpectedAttemptRelation,
    copy_deadline: u64,
) {
    let (source, commands, network) = protected_crash_source_commands(&oracle);
    assert_eq!(commands.len(), 2);
    let original_index = commands
        .iter()
        .position(|command| command["type"] == "cross_account_move")
        .unwrap();
    let copy_index = commands
        .iter()
        .position(|command| command["type"] == "create")
        .unwrap();
    let original = &commands[original_index];
    let copy = &commands[copy_index];
    assert_eq!(original["status"], "conflicted");
    assert_eq!(original["retryCount"], original_attempt_count);
    assert_eq!(original["id"], original["operationId"]);
    match attempt_relation {
        ExpectedAttemptRelation::Original => {
            assert_eq!(original["attemptId"], original["operationId"])
        }
        ExpectedAttemptRelation::Reminted => {
            assert_ne!(original["attemptId"], original["operationId"]);
            assert!(!original["attemptId"].as_str().unwrap().is_empty());
        }
    }
    assert_eq!(original["lastError"], "The Item changed on another device");
    assert!(original.get("nextAttemptAt").is_none());
    assert!(!original["conflictCopyId"].as_str().unwrap().is_empty());
    assert_eq!(copy["status"], "retrying");
    assert_eq!(copy["retryCount"], 1);
    assert_eq!(copy["id"], copy["operationId"]);
    assert_eq!(copy["attemptId"], copy["operationId"]);
    assert_eq!(
        copy["operationId"],
        format!(
            "conflict-copy:{}",
            original["operationId"].as_str().unwrap()
        )
    );
    assert_eq!(copy["entityId"], original["conflictCopyId"]);
    assert_eq!(copy["lastError"], "The server could not be reached.");
    assert_eq!(copy["nextAttemptAt"], copy_deadline);
    let dispatch_network = Arc::new(CopyDispatchNetwork::new(network.clone(), copy));
    let frozen_store = source.inner.store.clone();
    let frozen_sync = source.inner.sync.clone();
    let directory = TestDirectory::new();
    let platform = Arc::new(RetainingPlatform::default());
    let runtime =
        authenticated_runtime(&directory, platform.clone(), dispatch_network.clone()).await;
    runtime
        .set_profile_admission_source(ProfileAdmissionSource::Legacy {
            format: LegacyProfileFormat::DesktopLegacyV1,
            executor: source.clone(),
        })
        .await
        .unwrap();
    runtime
        .open()
        .await
        .expect("genuine Conflicted two-owner capture must reach supported held admission");
    assert_two_locked(&runtime);
    assert_eq!(network.call_count(), 0);
    let before = snapshot(&directory, desktop::ACCOUNT).await;
    let target = snapshot(&directory, SECOND_ACCOUNT).await;
    let held = row(&before, "crossAccountMoves");
    let operation = row(&before, "operations");
    let overlay = row(&before, "optimisticItems");
    assert_eq!(held["type"], "legacySourceUnavailable");
    assert_eq!(held["version"], 1);
    assert_eq!(held["operationId"], original["operationId"]);
    assert_eq!(
        held["legacyAdmission"]["sourceQueueIndex"],
        original_index.to_string()
    );
    assert_eq!(
        held["legacyAdmission"]["sourceCommand"],
        expected_lineage(original, true)
    );
    assert_eq!(held["legacyAdmission"]["disposition"], "legacyConflicted");
    assert_eq!(
        held["scheduling"],
        json!({"attemptCount":original_attempt_count.to_string(),"notBeforeMs":"0"})
    );
    assert_eq!(
        held["targetCreate"]["operationId"],
        format!(
            "{}:create-target",
            original["operationId"].as_str().unwrap()
        )
    );
    assert_eq!(
        held["targetCreate"]["request"]["body"],
        json!(immutable_create_body(original))
    );
    assert_eq!(held["targetCreate"]["request"]["method"], "PUT");
    assert_eq!(
        held["targetCreate"]["request"]["path"],
        format!(
            "/api/v1/vaults/{}/items/{}",
            encode_component(original["targetVaultId"].as_str().unwrap()),
            encode_component(original["targetItemId"].as_str().unwrap())
        )
    );
    assert_eq!(
        held["targetCreate"]["request"]["headers"],
        json!([{"name":"Content-Type","value":"application/json"}])
    );
    assert_eq!(
        held["destinationBinding"],
        json!({"accountId":SECOND_ACCOUNT,"incarnation":target["head"]["incarnation"],"bindingRevision":"0","status":"active"})
    );
    assert!(held["targetCreate"]["result"].is_null());
    for absent in [
        "source",
        "target",
        "children",
        "attachments",
        "stage",
        "disposition",
    ] {
        assert!(held.get(absent).is_none());
    }
    assert_eq!(operation["operationId"], copy["operationId"]);
    assert_eq!(
        operation["legacyAdmission"]["sourceQueueIndex"],
        copy_index.to_string()
    );
    assert_eq!(
        operation["legacyAdmission"]["sourceCommand"],
        expected_lineage(copy, false)
    );
    assert_eq!(operation["legacyAdmission"]["disposition"], "normal");
    assert_eq!(
        operation["scheduling"],
        json!({"attemptCount":copy["retryCount"].as_u64().unwrap().to_string(),"notBeforeMs":copy["nextAttemptAt"].as_u64().unwrap().to_string()})
    );
    assert_eq!(operation["request"]["method"], "PUT");
    assert_eq!(
        operation["request"]["path"],
        format!(
            "/api/v1/vaults/{}/items/{}",
            encode_component(copy["vaultId"].as_str().unwrap()),
            encode_component(copy["entityId"].as_str().unwrap())
        )
    );
    assert_eq!(
        operation["request"]["headers"],
        json!([{"name":"Content-Type","value":"application/json"}])
    );
    assert_eq!(
        operation["request"]["body"],
        json!(immutable_create_body(copy))
    );
    assert_eq!(overlay["operationId"], copy["operationId"]);
    assert_eq!(overlay["itemId"], copy["entityId"]);
    for field in [
        "encryptedData",
        "encryptionIv",
        "encryptionAlgorithm",
        "encryptionVersion",
        "encryptedByUserId",
    ] {
        assert_eq!(overlay[field], copy["encryptedPayload"][field]);
    }
    for snapshot in [&before, &target] {
        assert!(snapshot["rows"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["store"] != "authorityItems" && row["store"] != "operationReceipts"));
    }
    assert!(target["rows"].as_array().unwrap().iter().all(|row| ![
        "operations",
        "crossAccountMoves",
        "optimisticItems"
    ]
    .contains(&row["store"].as_str().unwrap())));
    assert_conflicted_projection(&runtime, original, copy);
    runtime.close().await;
    let source_calls = source.calls.lock().unwrap().len();
    let reopened = authenticated_runtime(&directory, platform, dispatch_network.clone()).await;
    reopened.open().await.unwrap();
    assert_two_locked(&reopened);
    assert_eq!(network.call_count(), 0);
    assert_eq!(
        snapshot(&directory, desktop::ACCOUNT).await["rows"],
        before["rows"]
    );
    assert_eq!(
        snapshot(&directory, SECOND_ACCOUNT).await["rows"],
        target["rows"]
    );
    for account in [desktop::ACCOUNT, SECOND_ACCOUNT] {
        reopened
            .request(
                RuntimeRequest::QuickUnlock {
                    account_id: account.into(),
                    master_password: PASSWORD.into(),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap();
    }
    assert_exact_copy_readable(&reopened, copy);
    assert_conflicted_projection(&reopened, original, copy);
    assert_unavailable_resume(&reopened, &directory, &network, original).await;
    let after = snapshot(&directory, desktop::ACCOUNT).await;
    assert_eq!(row(&after, "crossAccountMoves"), held);
    assert_eq!(row(&after, "operations"), operation);
    assert_eq!(row(&after, "optimisticItems"), overlay);
    assert_eq!(source.calls.lock().unwrap().len(), source_calls);
    assert_eq!(source.inner.store, frozen_store);
    assert_eq!(source.inner.sync, frozen_sync);
    assert_only_independent_copy_dispatches(
        &reopened,
        &directory,
        &dispatch_network,
        original,
        copy,
    )
    .await;
    reopened.close().await;
}
