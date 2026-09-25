//! Exhausted acquisition retries and independent deletion preserve a held command without source evidence.
use super::*;

#[path = "missing_source_failed_readonly_lifecycle.rs"]
mod readonly_lifecycle_tests;

#[path = "missing_source_failed_sync.rs"]
mod sync_tests;

#[tokio::test]
async fn actual_failed_independent_source_deletion_preserves_hold_without_resuming_remote_work() {
    let oracle = failed_independent_deletion_oracle();
    let (source, command, network) = protected_crash_source_from(&oracle);
    assert_eq!(command["status"], "failed");
    assert_eq!(command["retryCount"], 5);
    assert!(command.get("nextAttemptAt").is_none());
    assert_eq!(
        command["lastError"],
        "network unavailable while acquiring source client"
    );
    assert_eq!(command["id"], command["operationId"]);
    assert_ne!(command["attemptId"], command["operationId"]);
    assert!(!command["attemptId"].as_str().unwrap().is_empty());
    assert_failed_capture(source, command, network, "5").await;
}

pub(super) async fn assert_failed_capture(
    source: Arc<Source>,
    command: Value,
    network: Arc<AccountNetworks>,
    attempt_count: &str,
) {
    assert_failed_capture_with_deadline(source, command, network, attempt_count, None).await;
}

pub(super) async fn assert_failed_capture_with_deadline(
    source: Arc<Source>,
    command: Value,
    network: Arc<AccountNetworks>,
    attempt_count: &str,
    source_deadline_ms: Option<u64>,
) {
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
        .expect("real Failed capture with independent deletion must reach held admission");
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
        json!({"attemptCount":attempt_count,"notBeforeMs":source_deadline_ms.unwrap_or(0).to_string()})
    );
    let mut evidence = command.clone();
    evidence["encryptedPayload"] = json!({"type":"target","encryptionVersion":command["encryptedPayload"]["encryptionVersion"],"encryptedByUserId":command["encryptedPayload"]["encryptedByUserId"]});
    for decimal in ["timestamp", "retryCount", "nextAttemptAt"] {
        if let Some(value) = command.get(decimal) {
            evidence[decimal] = json!(value.as_u64().unwrap().to_string());
        }
    }
    assert_eq!(parked["legacyAdmission"]["sourceCommand"], evidence);
    assert_eq!(parked["legacyAdmission"]["disposition"], "legacyFailed");
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
    // Each caller asserts its actual original/reminted attempt relation. The fixed child
    // always derives from semantic identity, independently of retry count and attempt.
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
    assert_failed_projection_at_count(&runtime, operation_id, attempt_count);
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
    assert_failed_projection_at_count(&reopened, operation_id, attempt_count);
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
    assert_failed_projection_at_count(&reopened, operation_id, attempt_count);
    assert_eq!(source.calls.lock().unwrap().len(), source_calls);
    assert_eq!(source.inner.store, frozen_store);
    assert_eq!(source.inner.sync, frozen_sync);
    reopened.close().await;
}

fn failed_independent_deletion_oracle() -> Value {
    serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"),
        "/../../../core/src/services/fixtures/legacy-cross-account-missing-source-failed-independent-deletion.json"))).unwrap()
}

fn assert_failed_projection(runtime: &Arc<Runtime>, operation_id: &str) {
    assert_failed_projection_at_count(runtime, operation_id, "5");
}

pub(super) fn assert_failed_projection_at_count(
    runtime: &Arc<Runtime>,
    operation_id: &str,
    attempt_count: &str,
) {
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
    let held: Vec<_> = value["operations"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|operation| operation["operationId"] == operation_id)
        .collect();
    assert_eq!(held.len(), 1);
    assert_eq!(held[0]["resolution"], "legacyFailed");
    assert_eq!(held[0]["attemptCount"], attempt_count);
    assert!(held[0]["nextAttemptAtMs"].is_null());
    assert_eq!(
        held[0]["crossAccountMove"]["phase"],
        json!({"type":"targetCreate"})
    );
    assert_eq!(held[0]["crossAccountMove"]["sourceVisible"], false);
    assert_eq!(
        held[0]["crossAccountMove"]["disposition"],
        json!({"type":"legacyHeld"})
    );
    observation.close();
}
