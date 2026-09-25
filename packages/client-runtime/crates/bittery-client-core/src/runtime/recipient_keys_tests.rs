use super::*;
use bittery_crypto_core::rsa::rsa_public_key_fingerprint;

async fn scope(runtime: &Runtime) -> String {
    match biometric_request(
        runtime,
        RuntimeRequest::RecipientKeyScope {
            account_id: "account-1".into(),
        },
    )
    .await
    {
        RuntimeResponse::RecipientKeyScope { scope } => scope,
        _ => panic!("Expected recipient scope"),
    }
}

#[tokio::test]
async fn recipient_keys_runtime_persists_only_explicit_verification_and_fences_old_scopes() {
    let (runtime, platform, _) = device_setup_harness().await;
    let (real, attacker) = crate::recipient_keys::tests::identities();
    let scope = scope(&runtime).await;
    let candidate = |public_key: &str| RuntimeRequest::VerifiedRecipientKey {
        account_id: "account-1".into(),
        recipient_user_id: "recipient".into(),
        public_key: public_key.into(),
        scope: scope.clone(),
    };
    let verify = |public_key: &str, fingerprint: &str| RuntimeRequest::VerifyRecipientKey {
        account_id: "account-1".into(),
        recipient_user_id: "recipient".into(),
        public_key: public_key.into(),
        expected_fingerprint: fingerprint.into(),
        scope: scope.clone(),
    };
    let fingerprint = rsa_public_key_fingerprint(&real.public_key).unwrap();
    assert_eq!(
        runtime
            .request(candidate(&attacker.public_key), RequestCancellation::new())
            .await
            .unwrap_err()
            .code,
        RuntimeErrorCode::RecipientKeyUnverified
    );
    assert_eq!(
        runtime
            .request(
                verify(&attacker.public_key, &fingerprint),
                RequestCancellation::new()
            )
            .await
            .unwrap_err()
            .code,
        RuntimeErrorCode::RecipientFingerprintMismatch
    );
    assert!(!platform.has_document("account-1", "incarnation-1", "verified-recipient-keys"));
    platform.fail_at(PersistenceStep::RecipientKeys);
    assert!(runtime
        .request(
            verify(&real.public_key, &fingerprint),
            RequestCancellation::new()
        )
        .await
        .is_err());
    assert_eq!(
        runtime
            .request(candidate(&real.public_key), RequestCancellation::new())
            .await
            .unwrap_err()
            .code,
        RuntimeErrorCode::RecipientKeyUnverified
    );
    biometric_request(&runtime, verify(&real.public_key, &fingerprint)).await;
    assert!(platform.has_document("account-1", "incarnation-1", "verified-recipient-keys"));
    assert!(
        matches!(biometric_request(&runtime, candidate(&real.public_key)).await, RuntimeResponse::VerifiedRecipientKey { public_key } if public_key == real.public_key)
    );
    assert_eq!(
        runtime
            .request(candidate(&attacker.public_key), RequestCancellation::new())
            .await
            .unwrap_err()
            .code,
        RuntimeErrorCode::RecipientKeyChanged
    );
    platform.fail_next_read(RuntimeError::new(
        RuntimeErrorCode::StorageUnavailable,
        "read fault",
    ));
    assert_eq!(
        runtime
            .request(candidate(&real.public_key), RequestCancellation::new())
            .await
            .unwrap_err()
            .code,
        RuntimeErrorCode::StorageUnavailable
    );
    let cancelled = RequestCancellation::new();
    cancelled.cancel();
    assert_eq!(
        runtime
            .request(candidate(&real.public_key), cancelled)
            .await
            .unwrap_err()
            .code,
        RuntimeErrorCode::Cancelled
    );
    biometric_request(
        &runtime,
        RuntimeRequest::Lock {
            account_id: "account-1".into(),
        },
    )
    .await;
    assert!(platform.has_document("account-1", "incarnation-1", "verified-recipient-keys"));
    runtime.unlock_account(&"account-1".into()).await.unwrap();
    assert_eq!(
        runtime
            .request(candidate(&real.public_key), RequestCancellation::new())
            .await
            .unwrap_err()
            .code,
        RuntimeErrorCode::Cancelled
    );
    runtime.close().await;
}

#[tokio::test]
async fn recipient_keys_own_fingerprint_uses_private_identity_and_corrupt_storage_never_grants_trust(
) {
    let (runtime, platform, _) = device_setup_harness().await;
    let (real, _) = crate::recipient_keys::tests::identities();
    let account = AccountId::from("account-1");
    let snapshot = runtime.require_snapshot(&account).unwrap();
    let muk = runtime
        .copy_live_master_unlock_key(&account, &snapshot.incarnation)
        .unwrap();
    let private = bittery_crypto_core::encrypt(&real.private_key, &*muk).unwrap();
    runtime.live_master_unlock_keys.lock().unwrap().insert(
        (account.clone(), snapshot.incarnation.clone()),
        LiveMasterUnlockKey::with_private_key(muk, Some(serde_json::to_string(&private).unwrap())),
    );
    assert!(
        matches!(biometric_request(&runtime, RuntimeRequest::OwnKeyFingerprint { account_id: account.clone() }).await,
        RuntimeResponse::OwnKeyFingerprint { fingerprint, .. } if fingerprint == rsa_public_key_fingerprint(&real.public_key).unwrap())
    );
    let scope = scope(&runtime).await;
    let key = generation_storage_key("account-1", "incarnation-1", "verified-recipient-keys");
    platform
        .values
        .lock()
        .unwrap()
        .insert(("devicePlain".into(), key), "{}".into());
    assert_eq!(
        runtime
            .request(
                RuntimeRequest::VerifiedRecipientKey {
                    account_id: account,
                    recipient_user_id: "recipient".into(),
                    public_key: real.public_key.clone(),
                    scope
                },
                RequestCancellation::new()
            )
            .await
            .unwrap_err()
            .code,
        RuntimeErrorCode::StorageUnavailable
    );
    runtime.close().await;
}
