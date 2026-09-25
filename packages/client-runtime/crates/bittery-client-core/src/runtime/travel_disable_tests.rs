//! Foreground disable uses the existing real SRP verifier at the HTTP primitive seam.
use super::*;

struct TravelDisableHttp {
    auth: RoutingAuthHttp,
    disable_attempts: AtomicU64,
    disable_calls: AtomicU64,
    policy_reads_after_attempt: AtomicU64,
    enabled: AtomicBool,
}

#[async_trait]
impl SerializedHttpExecutor for TravelDisableHttp {
    async fn invoke(&self, request: Zeroizing<String>) -> Result<String, RuntimeError> {
        let value: Value = serde_json::from_str(&request).unwrap();
        let url = value["url"].as_str().unwrap();
        if url.ends_with("/travel-mode/disable") {
            self.disable_attempts.fetch_add(1, Ordering::SeqCst);
            assert_auth_headers(&value);
            assert_eq!(value["method"], "POST");
            let body = routing_request_body(&value);
            assert_eq!(body.as_object().unwrap().len(), 3);
            assert_eq!(body["attemptId"], "attempt-1");
            let state = self.auth.state.lock().unwrap();
            let verified = state.server.derive_session(
                &state.server_ephemeral.secret,
                body["clientPublicKey"].as_str().unwrap(),
                SRP_SALT,
                "",
                &state.verifier,
                body["clientProof"].as_str().unwrap(),
            );
            drop(state);
            if verified.is_err() {
                return Ok(routing_completed(401, json!({"error":"invalid proof"})));
            }
            self.disable_calls.fetch_add(1, Ordering::SeqCst);
            self.enabled.store(false, Ordering::SeqCst);
            return Ok(routing_completed(
                200,
                json!({
                    "enabled": false, "hiddenVaultIds": [], "enabledAt":null,
                    "updatedAt":"2029-01-02T00:00:00Z"
                }),
            ));
        }
        if url.ends_with("/travel-mode") {
            assert_auth_headers(&value);
            if self.disable_attempts.load(Ordering::SeqCst) > 0 {
                self.policy_reads_after_attempt
                    .fetch_add(1, Ordering::SeqCst);
            }
            let enabled = self.enabled.load(Ordering::SeqCst);
            return Ok(routing_completed(
                200,
                json!({
                    "enabled":enabled,"hiddenVaultIds":[],
                    "enabledAt":if enabled {Some("2029-01-01T00:00:00Z")}else{None},
                    "updatedAt":"2029-01-02T00:00:00Z"
                }),
            ));
        }
        self.auth.invoke(request).await
    }
    fn cancel(&self, dispatch_id: &str) {
        self.auth.cancel(dispatch_id);
    }
}

#[tokio::test]
async fn disable_uses_one_fresh_proof_without_replacing_session_or_quick_unlock() {
    check_disable_password(MASTER_PASSWORD, true).await;
}

#[tokio::test]
async fn wrong_disable_password_preserves_policy_session_and_quick_unlock_without_login() {
    check_disable_password("incorrect foreground password", false).await;
}

async fn check_disable_password(password: &str, accepted: bool) {
    let http = Arc::new(TravelDisableHttp {
        auth: RoutingAuthHttp::new(current_kdf_profile(), RoutingAuthBehavior::Success, None),
        disable_attempts: AtomicU64::new(0),
        disable_calls: AtomicU64::new(0),
        policy_reads_after_attempt: AtomicU64::new(0),
        enabled: AtomicBool::new(true),
    });
    let (runtime, _, platform) = routing_harness(http.clone()).await;
    let RuntimeResponse::SignedIn { account_id, .. } = runtime
        .request(
            sign_in_request(NORMALIZED_EMAIL),
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("initial Account installation failed");
    };
    let before = runtime.replica.snapshot(&account_id).unwrap();
    let original_metadata = runtime
        .platform_storage
        .load_account_metadata(&account_id, &before.incarnation)
        .await
        .unwrap()
        .unwrap();
    let original_session = runtime
        .platform_storage
        .load_current_session(&account_id, &before.incarnation)
        .await
        .unwrap()
        .unwrap();
    let original_quick = runtime
        .platform_storage
        .load_quick_unlock(&account_id, &before.incarnation)
        .await
        .unwrap()
        .unwrap();
    platform.clear_events();
    http.auth.clear_requests();
    let result = runtime
        .request(
            RuntimeRequest::DisableTravelMode {
                account_id: account_id.clone(),
                master_password: password.into(),
            },
            RequestCancellation::new(),
        )
        .await;
    if accepted {
        assert!(matches!(result.unwrap(), RuntimeResponse::TravelMode {
            account_id: result_account, result: crate::TravelModeCommandResult::Confirmed {policy, ..}
        } if result_account == account_id && !policy.enabled));
        assert_eq!(http.disable_calls.load(Ordering::SeqCst), 1);
        assert!(!http.enabled.load(Ordering::SeqCst));
    } else {
        assert!(matches!(result.unwrap(), RuntimeResponse::TravelMode {
            account_id: result_account,
            result: crate::TravelModeCommandResult::RetryRequired { policy }
        } if result_account == account_id && policy.enabled));
        assert_eq!(http.disable_calls.load(Ordering::SeqCst), 0);
        assert!(http.enabled.load(Ordering::SeqCst));
    }
    let requests = http.auth.requests();
    assert_eq!(http.disable_attempts.load(Ordering::SeqCst), 1);
    assert_eq!(
        http.policy_reads_after_attempt.load(Ordering::SeqCst),
        u64::from(!accepted)
    );
    assert_eq!(
        requests.len(),
        1,
        "disable may start SRP once but must never finish login or create a Session"
    );
    assert!(requests[0]["url"]
        .as_str()
        .unwrap()
        .ends_with("/auth/login-attempts"));
    let after = runtime.replica.snapshot(&account_id).unwrap();
    assert_eq!(after.operations, before.operations);
    assert!(
        platform.events().iter().all(|step| !matches!(
            step,
            PersistenceStep::CurrentSession | PersistenceStep::QuickUnlock
        )),
        "foreground password proof must not write login credentials"
    );
    if !accepted {
        let metadata = runtime
            .platform_storage
            .load_account_metadata(&account_id, &after.incarnation)
            .await
            .unwrap()
            .unwrap();
        let policy = metadata.verified_travel_mode.unwrap();
        let original_policy = original_metadata.verified_travel_mode.unwrap();
        assert_eq!(policy.enabled, original_policy.enabled);
        assert_eq!(policy.hidden_vault_ids, original_policy.hidden_vault_ids);
        assert_eq!(
            policy.server_enabled_at_ms,
            original_policy.server_enabled_at_ms
        );
        assert_eq!(
            policy.server_updated_at_ms,
            original_policy.server_updated_at_ms
        );
        // The successful current-policy GET may update its local verification timestamp.
    }
    let session = runtime
        .platform_storage
        .load_current_session(&account_id, &after.incarnation)
        .await
        .unwrap()
        .unwrap();
    assert!(
        session == original_session,
        "disable must preserve the retained Session"
    );
    let quick = runtime
        .platform_storage
        .load_quick_unlock(&account_id, &after.incarnation)
        .await
        .unwrap()
        .unwrap();
    assert!(quick.secret_key.as_ref() == original_quick.secret_key.as_ref());
    assert_eq!(quick.account_id, original_quick.account_id);
    assert_eq!(quick.incarnation, original_quick.incarnation);
    assert_eq!(quick.created_at_ms, original_quick.created_at_ms);
    assert_eq!(quick.biometric_enabled, original_quick.biometric_enabled);
    assert_eq!(
        quick.last_master_password_entry_ms,
        original_quick.last_master_password_entry_ms
    );
    assert_eq!(
        quick.encrypted_master_unlock_key.ciphertext,
        original_quick.encrypted_master_unlock_key.ciphertext
    );
    assert_eq!(
        quick.encrypted_master_unlock_key.iv,
        original_quick.encrypted_master_unlock_key.iv
    );
    assert_eq!(
        quick.encrypted_master_unlock_key.algorithm,
        original_quick.encrypted_master_unlock_key.algorithm
    );
    runtime.close().await;
}
