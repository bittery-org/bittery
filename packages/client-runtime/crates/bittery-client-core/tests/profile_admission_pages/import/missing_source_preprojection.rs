//! Frozen producer cuts: a staged claim or a committed applying row before projection.
use super::*;

fn staged_oracle() -> Value {
    serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../core/src/services/fixtures/legacy-cross-account-missing-source-staged-before-projection.json"
    )))
    .unwrap()
}

fn applying_oracle() -> Value {
    serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../core/src/services/fixtures/legacy-cross-account-missing-source-applying-before-projection.json"
    )))
    .unwrap()
}

#[tokio::test]
async fn actual_staged_claim_stays_parked_after_locked_sqlite_reopen_and_unlock() {
    assert_preprojection_capture(staged_oracle(), "staged", true).await;
}

#[tokio::test]
async fn actual_applying_storage_ack_cut_stays_parked_after_locked_sqlite_reopen_and_unlock() {
    assert_preprojection_capture(applying_oracle(), "applying", false).await;
}

async fn assert_preprojection_capture(oracle: Value, status: &str, has_claim: bool) {
    let (source, command, network) = protected_crash_source_from(&oracle);
    let original_sync = source.inner.sync.clone();
    let original_store = source.inner.store.clone();
    let operation_id = command["operationId"].as_str().unwrap();
    assert_eq!(command["status"], status);
    assert_eq!(command["retryCount"], 0);
    assert_eq!(command["id"], command["operationId"]);
    assert_eq!(command["attemptId"], command["operationId"]);
    assert!(command.get("lastError").is_none());
    assert!(command.get("nextAttemptAt").is_none());
    assert!(command.get("conflictCopyId").is_none());
    if has_claim {
        assert_eq!(command["projectionClaimId"], "popup-projection-claim");
        assert_eq!(command["projectionClaimExpiresAt"], 30_001);
    } else {
        assert!(command.get("projectionClaimId").is_none());
        assert!(command.get("projectionClaimExpiresAt").is_none());
    }

    let directory = TestDirectory::new();
    let platform = Arc::new(RetainingPlatform::default());
    let runtime = authenticated_runtime(&directory, platform.clone(), network.clone()).await;
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
        .expect("actual pre-projection producer cut must park its original Move");
    assert_two_locked(&runtime);
    assert_eq!(network.call_count(), 0);
    let source_before = snapshot(&directory, desktop::ACCOUNT).await;
    let target_before = snapshot(&directory, SECOND_ACCOUNT).await;
    let parked = row(&source_before, "crossAccountMoves");
    assert_eq!(parked["type"], "legacySourceUnavailable");
    assert_eq!(parked["operationId"], operation_id);
    assert_eq!(
        parked["scheduling"],
        json!({"attemptCount":"0","notBeforeMs":"0"})
    );
    assert_eq!(parked["legacyAdmission"]["disposition"], "normal");
    assert_eq!(parked["legacyAdmission"]["sourceQueueIndex"], "0");
    let mut evidence = command.clone();
    evidence["encryptedPayload"] = json!({
        "type":"target",
        "encryptionVersion":command["encryptedPayload"]["encryptionVersion"],
        "encryptedByUserId":command["encryptedPayload"]["encryptedByUserId"]
    });
    for decimal in ["timestamp", "retryCount", "projectionClaimExpiresAt"] {
        if let Some(value) = command.get(decimal) {
            evidence[decimal] = json!(value.as_u64().unwrap().to_string());
        }
    }
    assert_eq!(parked["legacyAdmission"]["sourceCommand"], evidence);
    assert_eq!(
        parked["targetCreate"]["operationId"],
        format!("{operation_id}:create-target")
    );
    assert!(parked["targetCreate"]["result"].is_null());
    assert_eq!(parked["targetCreate"]["request"]["method"], "PUT");
    assert_eq!(
        parked["targetCreate"]["request"]["path"],
        format!(
            "/api/v1/vaults/{}/items/{}",
            encode_component(command["targetVaultId"].as_str().unwrap()),
            encode_component(command["targetItemId"].as_str().unwrap()),
        )
    );
    assert_eq!(
        parked["targetCreate"]["request"]["headers"],
        json!([{"name":"Content-Type","value":"application/json"}])
    );
    let body: Vec<u8> =
        serde_json::from_value(parked["targetCreate"]["request"]["body"].clone()).unwrap();
    let expected = format!(
        "{{\"category\":{},\"encryptedData\":{},\"encryptionIv\":{},\"encryptionAlgorithm\":{}}}",
        serde_json::to_string(&command["category"]).unwrap(),
        serde_json::to_string(&command["encryptedPayload"]["encryptedData"]).unwrap(),
        serde_json::to_string(&command["encryptedPayload"]["encryptionIv"]).unwrap(),
        serde_json::to_string(&command["encryptedPayload"]["encryptionAlgorithm"]).unwrap(),
    );
    assert_eq!(body, expected.into_bytes());
    for snapshot in [&source_before, &target_before] {
        assert!(snapshot["rows"].as_array().unwrap().iter().all(|row| ![
            "authorityItems",
            "operations",
            "optimisticItems",
            "operationReceipts"
        ]
        .contains(&row["store"].as_str().unwrap())));
    }
    assert!(target_before["rows"]
        .as_array()
        .unwrap()
        .iter()
        .all(|row| row["store"] != "crossAccountMoves"));
    for forbidden in [
        "source",
        "target",
        "attachments",
        "children",
        "stage",
        "disposition",
    ] {
        assert!(parked.get(forbidden).is_none(), "no invented {forbidden}");
    }
    assert_parked_projection_count(&runtime, operation_id, 0);
    runtime.close().await;

    let source_calls = source.calls.lock().unwrap().len();
    let reopened = authenticated_runtime(&directory, platform, network.clone()).await;
    reopened.open().await.unwrap();
    assert_two_locked(&reopened);
    assert_eq!(network.call_count(), 0);
    assert_eq!(
        snapshot(&directory, desktop::ACCOUNT).await["rows"],
        source_before["rows"]
    );
    assert_eq!(
        snapshot(&directory, SECOND_ACCOUNT).await["rows"],
        target_before["rows"]
    );
    assert_parked_projection_count(&reopened, operation_id, 0);
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
    let sink = Arc::new(Sink::default());
    let observation = reopened
        .observe(
            ObservationRequest::Items {
                account_id: desktop::ACCOUNT.into(),
            },
            sink.clone(),
        )
        .unwrap();
    let RuntimeProjection::Items(items) = sink.0.lock().unwrap().last().cloned().unwrap() else {
        panic!("Items projection");
    };
    assert!(items.items.is_empty());
    observation.close();
    assert_unavailable_resume_and_dispatch(&reopened, &directory, &network, &command).await;
    assert_eq!(
        row(
            &snapshot(&directory, desktop::ACCOUNT).await,
            "crossAccountMoves"
        ),
        parked
    );
    assert_parked_projection_count(&reopened, operation_id, 0);
    assert_eq!(source.calls.lock().unwrap().len(), source_calls);
    assert_eq!(source.inner.store, original_store);
    assert_eq!(source.inner.sync, original_sync);
    reopened.close().await;
}

#[tokio::test]
async fn actual_preprojection_artifacts_refuse_claim_mixing_without_committing_a_profile() {
    for (mut oracle, invalid) in [
        (staged_oracle(), "staged-without-expiry"),
        (applying_oracle(), "applying-with-claim"),
    ] {
        let raw: Value = serde_json::from_str(
            oracle["sync"]["bittery_pending_mutation_queues_v3"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        let mut queues = raw;
        let command = &mut queues[desktop::ACCOUNT][0];
        match invalid {
            "staged-without-expiry" => {
                command
                    .as_object_mut()
                    .unwrap()
                    .remove("projectionClaimExpiresAt");
            }
            "applying-with-claim" => command["projectionClaimId"] = json!("unproved-claim"),
            _ => unreachable!(),
        }
        oracle["sync"]["bittery_pending_mutation_queues_v3"] = json!(queues.to_string());
        let (source, _, network) = protected_crash_source_from(&oracle);
        let original_store = source.inner.store.clone();
        let original_sync = source.inner.sync.clone();
        let directory = TestDirectory::new();
        let platform = Arc::new(RetainingPlatform::default());
        let runtime = authenticated_runtime(&directory, platform.clone(), network.clone()).await;
        runtime
            .set_profile_admission_source(ProfileAdmissionSource::Legacy {
                format: LegacyProfileFormat::DesktopLegacyV1,
                executor: source.clone(),
            })
            .await
            .unwrap();
        assert!(runtime.open().await.is_err(), "{invalid}");
        let stored_catalog = platform
            .values
            .lock()
            .unwrap()
            .get(&("devicePlain".into(), CATALOG.into()))
            .cloned();
        if let Some(raw) = stored_catalog {
            let catalog: Value = serde_json::from_str(&raw).unwrap();
            assert_ne!(catalog["profileAdmission"]["phase"], "committed");
        }
        assert_eq!(network.call_count(), 0);
        assert_eq!(source.inner.store, original_store);
        assert_eq!(source.inner.sync, original_sync);
        runtime.close().await;
    }
}
