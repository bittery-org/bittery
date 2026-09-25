//! Public request paths use the existing authentication fixture; no private install helper.
use super::*;
use crate::{LegacyProfileFormat, ProfileAdmissionSource, SerializedProfileAdmissionExecutor};

struct NoLegacyCalls;
#[async_trait]
impl SerializedProfileAdmissionExecutor for NoLegacyCalls {
    async fn invoke(
        &self,
        _: Zeroizing<String>,
    ) -> Result<(Zeroizing<String>, Option<Zeroizing<Vec<u8>>>), RuntimeError> {
        panic!("completed catalog must not revisit its source")
    }
}

fn completed_record() -> Value {
    json!({"kind":"import", "version":1, "admissionId":"retained-admission", "revision":"8",
        "phase":"complete", "source":{"format":"desktopLegacyV1", "profileIdentity":"profile-1",
        "recordedCaptureId":"capture-1"}, "manifestDigest":"ab".repeat(32), "completionId":"complete-1"})
}

fn catalog_json(platform: &InstallationPlatform) -> Value {
    let values = platform.values.lock().unwrap();
    serde_json::from_str(
        values
            .get(&(
                "devicePlain".into(),
                "bittery:runtime:platform-storage:device-catalog".into(),
            ))
            .unwrap(),
    )
    .unwrap()
}

async fn legacy_runtime(
    replica: Arc<InstallationReplica>,
    platform: Arc<InstallationPlatform>,
    http: Arc<dyn SerializedHttpExecutor>,
) -> Arc<Runtime> {
    let runtime = Runtime::with_configured_serialized_executors(
        replica,
        platform,
        http,
        AuthClientConfig::new(
            "client-routing".into(),
            ClientPlatform::Desktop,
            "0.5.2-test".into(),
        )
        .unwrap(),
    );
    runtime
        .set_profile_admission_source(ProfileAdmissionSource::Legacy {
            format: LegacyProfileFormat::DesktopLegacyV1,
            executor: Arc::new(NoLegacyCalls),
        })
        .await
        .unwrap();
    runtime.open().await.unwrap();
    runtime
}

#[tokio::test]
async fn completed_admission_survives_public_sign_in_replacement_remove_last_account_and_reopen() {
    let http = Arc::new(RoutingAuthHttp::new(
        current_kdf_profile(),
        RoutingAuthBehavior::Success,
        None,
    ));
    let (initial, replica, platform) = routing_harness(http.clone()).await;
    initial.close().await;
    platform.put_document(
        "devicePlain",
        "bittery:runtime:platform-storage:device-catalog".into(),
        &json!({"version":1,"accounts":[],"profileAdmission":completed_record()}),
    );
    let runtime = legacy_runtime(replica.clone(), platform.clone(), http.clone()).await;
    let mut installed_account = None;
    for _ in 0..2 {
        let response = runtime
            .request(
                sign_in_request(NORMALIZED_EMAIL),
                RequestCancellation::new(),
            )
            .await
            .unwrap();
        let RuntimeResponse::SignedIn { account_id, .. } = response else {
            panic!("sign-in did not complete");
        };
        if let Some(previous) = &installed_account {
            assert_eq!(previous, &account_id);
        }
        installed_account = Some(account_id);
        assert_eq!(
            catalog_json(&platform)["profileAdmission"],
            completed_record()
        );
    }
    runtime.close().await;
    let reopened = legacy_runtime(replica.clone(), platform.clone(), http.clone()).await;
    let account_id = installed_account.unwrap();
    assert_eq!(runtime_status(&reopened).accounts.len(), 1);
    platform
        .allow_teardown_prefixes
        .store(true, Ordering::SeqCst);
    let response = reopened
        .request(
            RuntimeRequest::RemoveAccount { account_id },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    // This auth fixture lacks host/artifact cleanup adapters. Catalog detachment still must
    // complete and retain the marker while their independent cleanup remains retryable.
    let RuntimeResponse::Teardown { failures, .. } = response else {
        panic!("removal did not run");
    };
    assert!(!failures.contains(&crate::TeardownPhase::PlatformStorage));
    assert_eq!(
        catalog_json(&platform),
        json!({"version":1,"accounts":[],"profileAdmission":completed_record()})
    );
    reopened.close().await;
    let final_runtime = legacy_runtime(replica, platform.clone(), http).await;
    assert!(runtime_status(&final_runtime).accounts.is_empty());
    assert_eq!(
        catalog_json(&platform)["profileAdmission"],
        completed_record()
    );
    final_runtime.close().await;
}
