use super::*;

struct CredentialRetirementPlatform {
    inner: Arc<RetainingPlatform>,
}

#[async_trait]
impl SerializedPlatformStorageExecutor for CredentialRetirementPlatform {
    async fn invoke(&self, request: Zeroizing<String>) -> Result<Zeroizing<String>, RuntimeError> {
        if let PlatformStorageRequest::Delete { area, key } =
            &serde_json::from_str::<PlatformStorageRequest>(&request).unwrap()
        {
            assert!([
                ":quick-unlock",
                ":current-session",
                ":legacy-session-evidence"
            ]
            .iter()
            .any(|suffix| key.ends_with(suffix)));
            self.inner
                .values
                .lock()
                .unwrap()
                .remove(&(area_name(*area), key.clone()));
            return Ok(Zeroizing::new(
                serde_json::to_string(&PlatformStorageResponse::Done).unwrap(),
            ));
        }
        self.inner.invoke(request).await
    }
}

#[tokio::test]
async fn sign_out_retires_partial_credential_evidence_without_removing_the_account() {
    let directory = TestDirectory::new();
    let platform = Arc::new(RetainingPlatform::default());
    let ports = Arc::new(CredentialRetirementPlatform {
        inner: platform.clone(),
    });
    let mut source = Source::new();
    Arc::get_mut(&mut source).unwrap().inner.credentials[3] = Some("partial-source-token".into());
    let runtime = runtime_with_platform_and_source(&directory, ports.clone(), source.clone()).await;
    runtime.open().await.unwrap();
    let before = platform.catalog();
    runtime
        .request(
            bittery_client_core::RuntimeRequest::SignOut {
                account_id: desktop::ACCOUNT.into(),
            },
            bittery_client_core::RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert_eq!(platform.catalog(), before);
    assert_eq!(
        platform.document(":metadata")["accountId"],
        desktop::ACCOUNT
    );
    assert!(platform.values.lock().unwrap().keys().all(|(_, key)| {
        !key.ends_with(":legacy-session-evidence")
            && !key.ends_with(":quick-unlock")
            && !key.ends_with(":current-session")
    }));
    runtime.close().await;
    let reopened = runtime_with_platform_and_source(&directory, ports, source).await;
    reopened.open().await.unwrap();
    let sink = Arc::new(Sink::default());
    let observation = reopened
        .observe(
            ObservationRequest::RuntimeStatus { account_id: None },
            sink.clone(),
        )
        .unwrap();
    {
        let projections = sink.0.lock().unwrap();
        let Some(RuntimeProjection::RuntimeStatus(status)) = projections.last() else {
            panic!("Runtime status");
        };
        assert_eq!(status.accounts.len(), 1);
        assert_eq!(status.accounts[0].account_id.as_str(), desktop::ACCOUNT);
        assert_eq!(status.accounts[0].access, AccountAccessState::SignedOut);
    }
    observation.close();
    reopened.close().await;
}

#[tokio::test]
async fn incomplete_session_preserves_private_evidence_without_creating_current_session_authority()
{
    for mask in [1, 2, 3, 4, 5, 6, 0] {
        let directory = TestDirectory::new();
        let platform = Arc::new(RetainingPlatform::default());
        let mut source = Source::new();
        let credentials = &mut Arc::get_mut(&mut source).unwrap().inner.credentials;
        credentials[3] = (mask & 1 != 0).then(|| "partial-source-token".into());
        credentials[4] = (mask & 2 != 0).then(|| "[]".into());
        credentials[5] = (mask & 4 != 0).then(|| "partial-source-encrypted-private-key".into());
        let runtime = runtime_with_platform_and_source(&directory, platform.clone(), source).await;
        runtime.open().await.unwrap();
        assert_locked(&runtime);
        let catalog = platform.catalog();
        let account = &catalog["profileAdmission"]["progress"]["accounts"][0];
        assert_eq!(
            account["session"]["type"],
            if mask == 0 {
                "absentAtCapture"
            } else {
                "incompleteRetained"
            }
        );
        assert!(account["expected"]["currentSessionSha256"].is_null());
        assert!(account["expected"]["legacySessionEvidenceSha256"].is_string());
        let (location, encoded) = {
            let values = platform.values.lock().unwrap();
            assert!(values
                .keys()
                .all(|(_, key)| !key.ends_with(":current-session")));
            values
                .iter()
                .find(|((_, key), _)| key.ends_with(":legacy-session-evidence"))
                .map(|(location, value)| (location.clone(), value.clone()))
                .unwrap()
        };
        assert_eq!(location.0, "deviceSecret");
        let evidence: Value = serde_json::from_str(&encoded).unwrap();
        assert_eq!(evidence["accountId"], desktop::ACCOUNT);
        assert_eq!(
            evidence["incarnation"],
            catalog["accounts"][0]["activeIncarnation"]
        );
        assert_eq!(
            evidence["manifestDigest"],
            catalog["profileAdmission"]["manifestDigest"]
        );
        assert_eq!(evidence["createdAtMs"], 1_700_000_000_000_u64);
        assert_eq!(evidence["expiresAt"], 1_209_600_000_u64);
        assert!(evidence["serverExpiresAt"].is_null());
        assert!(evidence["sessionId"].is_null());
        assert!(evidence["sourceSessionInstance"].is_null());
        assert_eq!(
            evidence["token"],
            if mask & 1 != 0 {
                json!("partial-source-token")
            } else {
                Value::Null
            }
        );
        assert_eq!(
            evidence["vaultKeys"],
            if mask & 2 != 0 {
                json!([])
            } else {
                Value::Null
            }
        );
        assert_eq!(
            evidence["encryptedPrivateKey"],
            if mask & 4 != 0 {
                json!("partial-source-encrypted-private-key")
            } else {
                Value::Null
            }
        );
        assert_eq!(
            platform.document(":quick-unlock")["encryptedMasterUnlockKey"]["ciphertext"],
            "original-ciphertext"
        );
        runtime.close().await;
        let reopened = Runtime::with_serialized_executors(
            Arc::new(SqliteReplica::open(directory.0.join("replica.sqlite")).unwrap()),
            platform.clone(),
            Arc::new(NoNetwork),
        );
        reopened.open().await.unwrap();
        assert_locked(&reopened);
        assert_eq!(
            platform.values.lock().unwrap().get(&location),
            Some(&encoded)
        );
        reopened.close().await;
    }
}
