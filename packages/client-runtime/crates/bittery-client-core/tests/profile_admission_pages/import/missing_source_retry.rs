//! A separate real producer retry acknowledgement cut retains original semantic ownership.
use super::*;

#[tokio::test]
async fn actual_retry_acknowledgement_crash_preserves_history_without_resuming_remote_work() {
    let oracle:Value=serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"),
        "/../../../core/src/services/fixtures/legacy-cross-account-missing-source-retry-acknowledgement.json"))).unwrap();
    let (source, command, network) = protected_crash_source_from(&oracle);
    assert_eq!(command["status"], "retrying");
    assert_eq!(command["retryCount"], 1);
    assert_eq!(command["nextAttemptAt"], 1001);
    assert_eq!(
        command["lastError"],
        "network unavailable while acquiring source client"
    );
    assert_eq!(command["id"], command["operationId"]);
    assert_ne!(command["attemptId"], command["operationId"]);
    assert!(!command["attemptId"].as_str().unwrap().is_empty());
    let frozen_store = source.inner.store.clone();
    let frozen_sync = source.inner.sync.clone();
    let operation_id = command["operationId"].as_str().unwrap();
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
        .expect("real retry acknowledgement crash must reach parked admission");
    assert_two_locked(&runtime);
    assert_eq!(network.call_count(), 0);
    let source_before = snapshot(&directory, desktop::ACCOUNT).await;
    let target_before = snapshot(&directory, SECOND_ACCOUNT).await;
    let parked = row(&source_before, "crossAccountMoves");
    assert_eq!(parked["type"], "legacySourceUnavailable");
    assert_eq!(parked["version"], 1);
    assert_eq!(parked["operationId"], operation_id);
    assert_eq!(
        parked["scheduling"],
        json!({"attemptCount":"1","notBeforeMs":"1001"})
    );
    let mut evidence = command.clone();
    evidence["encryptedPayload"] = json!({"type":"target","encryptionVersion":command["encryptedPayload"]["encryptionVersion"],"encryptedByUserId":command["encryptedPayload"]["encryptedByUserId"]});
    for decimal in ["timestamp", "retryCount", "nextAttemptAt"] {
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
        parked["destinationBinding"],
        json!({"accountId":SECOND_ACCOUNT,"incarnation":target_before["head"]["incarnation"],"bindingRevision":"0","status":"active"})
    );
    let create = &parked["targetCreate"];
    assert_eq!(
        create["operationId"],
        format!("{operation_id}:create-target")
    );
    assert_ne!(
        create["operationId"],
        format!("{}:create-target", command["attemptId"].as_str().unwrap())
    );
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
    let bytes: Vec<u8> = serde_json::from_value(create["request"]["body"].clone()).unwrap();
    let expected = format!(
        "{{\"category\":{},\"encryptedData\":{},\"encryptionIv\":{},\"encryptionAlgorithm\":{}}}",
        serde_json::to_string(&command["category"]).unwrap(),
        serde_json::to_string(&command["encryptedPayload"]["encryptedData"]).unwrap(),
        serde_json::to_string(&command["encryptedPayload"]["encryptionIv"]).unwrap(),
        serde_json::to_string(&command["encryptedPayload"]["encryptionAlgorithm"]).unwrap()
    );
    assert_eq!(bytes, expected.into_bytes());
    assert!(create["result"].is_null());
    for snapshot in [&source_before, &target_before] {
        assert!(snapshot["rows"].as_array().unwrap().iter().all(|row| ![
            "authorityItems",
            "operations",
            "optimisticItems",
            "operationReceipts"
        ]
        .contains(&row["store"].as_str().unwrap())));
    }
    assert!(!target_before["rows"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["store"] == "crossAccountMoves"));
    for absent in [
        "source",
        "target",
        "attachments",
        "children",
        "stage",
        "disposition",
    ] {
        assert!(parked.get(absent).is_none());
    }
    assert_parked_projection_count(&runtime, operation_id, 1);
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
    assert_parked_projection_count(&reopened, operation_id, 1);
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
            ObservationRequest::RuntimeStatus { account_id: None },
            sink.clone(),
        )
        .unwrap();
    let RuntimeProjection::RuntimeStatus(status) = sink.0.lock().unwrap().last().cloned().unwrap()
    else {
        panic!("Runtime status")
    };
    assert_eq!(status.accounts.len(), 2);
    assert!(status
        .accounts
        .iter()
        .all(|account| account.access == AccountAccessState::Unlocked));
    observation.close();
    assert!(network.call_count() >= 6);
    assert_unavailable_resume_and_dispatch(&reopened, &directory, &network, &command).await;
    let after = snapshot(&directory, desktop::ACCOUNT).await;
    assert_eq!(row(&after, "crossAccountMoves"), parked);
    assert!(after["rows"].as_array().unwrap().iter().all(|row| ![
        "authorityItems",
        "operations",
        "optimisticItems",
        "operationReceipts"
    ]
    .contains(&row["store"].as_str().unwrap())));
    assert_parked_projection_count(&reopened, operation_id, 1);
    assert_eq!(source.calls.lock().unwrap().len(), source_calls);
    assert_eq!(source.inner.store, frozen_store);
    assert_eq!(source.inner.sync, frozen_sync);
    reopened.close().await;
}
