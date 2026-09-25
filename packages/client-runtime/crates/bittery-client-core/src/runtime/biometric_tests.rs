use super::*;

#[tokio::test]
async fn biometric_capability_is_unavailable_until_a_host_installs_it() {
    let (runtime, _, _) = routing_harness(Arc::new(UnusedHttp)).await;
    let response = runtime
        .request(
            RuntimeRequest::BiometricAvailability {
                account_ids: Vec::new(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let RuntimeResponse::BiometricAvailability {
        hardware, accounts, ..
    } = response
    else {
        panic!("Expected biometric availability");
    };
    assert!(!hardware.has_hardware);
    assert!(!hardware.is_enrolled);
    assert!(accounts.is_empty());
}

struct TestBiometry {
    prompts: AtomicU64,
}
#[async_trait]
impl crate::BiometricPort for TestBiometry {
    async fn hardware(&self) -> Result<crate::BiometricHardware, RuntimeError> {
        Ok(crate::BiometricHardware {
            has_hardware: true,
            is_enrolled: true,
            kind: Some(crate::BiometricKind::Fingerprint),
        })
    }
    async fn authenticate(&self, _: &str, _: RequestCancellation) -> crate::BiometricPromptResult {
        self.prompts.fetch_add(1, Ordering::SeqCst);
        crate::BiometricPromptResult::Authenticated
    }
}
#[derive(Default)]
struct OfflineTravel {
    strict: AtomicBool,
    allow_account_refresh: AtomicBool,
    responses: Mutex<VecDeque<String>>,
}
#[async_trait]
impl SerializedHttpExecutor for OfflineTravel {
    fn cancel(&self, _: &str) {}
    async fn invoke(&self, request: zeroize::Zeroizing<String>) -> Result<String, RuntimeError> {
        let request: Value = serde_json::from_str(&request).unwrap();
        if self.strict.load(Ordering::SeqCst) {
            assert_eq!(
                request["method"], "GET",
                "biometrics must not create or refresh a Session"
            );
            let url = request["url"].as_str().unwrap();
            assert!(
                url.ends_with("/travel-mode")
                    || (self.allow_account_refresh.load(Ordering::SeqCst)
                        && url.ends_with("/auth/me"))
            );
        }
        Ok(self
            .responses
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| json!({ "type": "networkFailure" }).to_string()))
    }
}
async fn biometric_harness() -> (Arc<Runtime>, Arc<InstallationPlatform>, Arc<TestBiometry>) {
    biometric_harness_with_http(Arc::new(OfflineTravel::default())).await
}
// Device setup discloses credentials and requires verified admission. Keep the ordinary
// biometric fixture offline: local unlock itself does not require a new Server Session.
async fn device_setup_harness() -> (Arc<Runtime>, Arc<InstallationPlatform>, Arc<TestBiometry>) {
    let http = Arc::new(OfflineTravel::default());
    let setup = biometric_harness_with_http(http.clone()).await;
    http.responses.lock().unwrap().push_back(routing_completed(
        200,
        json!({
            "enabled": false, "hiddenVaultIds": [], "enabledAt": null,
            "updatedAt": "2023-11-14T22:13:20Z"
        }),
    ));
    let verified = setup
        .0
        .request(
            RuntimeRequest::RefreshTravelMode {
                account_id: "account-1".into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert!(matches!(verified, RuntimeResponse::TravelMode {
        result: crate::TravelModeCommandResult::Confirmed { policy, .. }, ..
    } if !policy.enabled));
    assert!(http.responses.lock().unwrap().is_empty());
    setup
}
async fn biometric_harness_with_http(
    http: Arc<OfflineTravel>,
) -> (Arc<Runtime>, Arc<InstallationPlatform>, Arc<TestBiometry>) {
    biometric_harness_with_clock(http, Arc::new(FixedClock(NOW_MS))).await
}
async fn biometric_harness_with_clock(
    http: Arc<OfflineTravel>,
    clock: Arc<dyn Clock>,
) -> (Arc<Runtime>, Arc<InstallationPlatform>, Arc<TestBiometry>) {
    biometric_harness_with_platform(http, clock, ClientPlatform::Desktop).await
}
async fn biometric_harness_with_platform(
    http: Arc<OfflineTravel>,
    clock: Arc<dyn Clock>,
    platform_kind: ClientPlatform,
) -> (Arc<Runtime>, Arc<InstallationPlatform>, Arc<TestBiometry>) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let replica = Arc::new(InstallationReplica::new(events.clone()));
    let platform = Arc::new(InstallationPlatform {
        events,
        ..InstallationPlatform::default()
    });
    let runtime = Runtime::with_test_dispatch_environment(
        replica,
        platform.clone(),
        http.clone(),
        AuthClientConfig::new("biometry-test".into(), platform_kind, "test".into()).unwrap(),
        clock,
        Arc::new(SystemDeviceTimer),
    );
    runtime.open().await.unwrap();
    install(
        &runtime,
        "user-1",
        &FixedEntropy::new(&["account-1", "incarnation-1"]),
    )
    .await
    .unwrap();
    http.strict.store(true, Ordering::SeqCst);
    let port = Arc::new(TestBiometry {
        prompts: AtomicU64::new(0),
    });
    runtime.install_biometric_port(port.clone());
    (runtime, platform, port)
}
async fn biometric_request(runtime: &Runtime, request: RuntimeRequest) -> RuntimeResponse {
    runtime
        .request(request, RequestCancellation::new())
        .await
        .unwrap()
}
#[tokio::test]
async fn biometric_unlock_reuses_retained_session_and_does_not_record_password_entry() {
    let (runtime, platform, port) = biometric_harness().await;
    biometric_request(
        &runtime,
        RuntimeRequest::SetBiometricEnabled {
            account_id: "account-1".into(),
            enabled: true,
        },
    )
    .await;
    biometric_request(
        &runtime,
        RuntimeRequest::Lock {
            account_id: "account-1".into(),
        },
    )
    .await;
    let before = platform.values.lock().unwrap().clone();
    let response = biometric_request(
        &runtime,
        RuntimeRequest::BiometricUnlock {
            account_id: "account-1".into(),
            prompt_message: "Unlock Bittery".into(),
        },
    )
    .await;
    let RuntimeResponse::BiometricUnlock { accounts } = response else {
        panic!("Expected biometric result")
    };
    assert_eq!(accounts[0].failure, None);
    assert_eq!(port.prompts.load(Ordering::SeqCst), 1);
    assert_eq!(
        runtime_status(&runtime).accounts[0].access,
        AccountAccessState::Unlocked
    );
    assert_eq!(
        *platform.values.lock().unwrap(),
        before,
        "Local release must not rewrite retained credentials or password-entry evidence"
    );
}
#[tokio::test]
async fn biometric_reentry_zero_requires_password_without_prompt() {
    let (runtime, _, port) = biometric_harness().await;
    biometric_request(
        &runtime,
        RuntimeRequest::SetBiometricEnabled {
            account_id: "account-1".into(),
            enabled: true,
        },
    )
    .await;
    biometric_request(
        &runtime,
        RuntimeRequest::SetMasterPasswordReentryPeriod { period_ms: 0 },
    )
    .await;
    biometric_request(
        &runtime,
        RuntimeRequest::Lock {
            account_id: "account-1".into(),
        },
    )
    .await;
    let response = biometric_request(
        &runtime,
        RuntimeRequest::BiometricUnlock {
            account_id: "account-1".into(),
            prompt_message: "Unlock".into(),
        },
    )
    .await;
    let RuntimeResponse::BiometricUnlock { accounts } = response else {
        panic!("Expected biometric result")
    };
    assert_eq!(
        accounts[0].failure,
        Some(crate::BiometricFailure::PasswordRequired)
    );
    assert_eq!(port.prompts.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn biometric_expired_session_requires_password_without_prompt_or_http() {
    let (runtime, _, port) = biometric_harness().await;
    biometric_request(
        &runtime,
        RuntimeRequest::SetBiometricEnabled {
            account_id: "account-1".into(),
            enabled: true,
        },
    )
    .await;
    let mut session = runtime
        .platform_storage
        .load_current_session(&"account-1".into(), &"incarnation-1".into())
        .await
        .unwrap()
        .unwrap();
    session.expires_at_ms = NOW_MS;
    runtime
        .platform_storage
        .store_current_session(&session)
        .await
        .unwrap();
    biometric_request(
        &runtime,
        RuntimeRequest::Lock {
            account_id: "account-1".into(),
        },
    )
    .await;
    let RuntimeResponse::BiometricUnlock { accounts } = biometric_request(
        &runtime,
        RuntimeRequest::BiometricUnlock {
            account_id: "account-1".into(),
            prompt_message: "Unlock".into(),
        },
    )
    .await
    else {
        panic!("Expected biometric result")
    };
    assert_eq!(
        accounts[0].failure,
        Some(crate::BiometricFailure::PasswordRequired)
    );
    assert_eq!(port.prompts.load(Ordering::SeqCst), 0);
    assert_eq!(
        runtime_status(&runtime).accounts[0].access,
        AccountAccessState::Locked
    );
}

#[tokio::test]
async fn biometric_grace_is_retired_by_lock_and_explicit_multiple_unlock_always_prompts() {
    let (runtime, _, port) = biometric_harness().await;
    biometric_request(
        &runtime,
        RuntimeRequest::SetBiometricEnabled {
            account_id: "account-1".into(),
            enabled: true,
        },
    )
    .await;
    for _ in 0..2 {
        let RuntimeResponse::BiometricUnlock { accounts } = biometric_request(
            &runtime,
            RuntimeRequest::BiometricUnlock {
                account_id: "account-1".into(),
                prompt_message: "Unlock".into(),
            },
        )
        .await
        else {
            panic!("Expected result")
        };
        assert_eq!(accounts[0].failure, None);
    }
    assert_eq!(port.prompts.load(Ordering::SeqCst), 1);
    let RuntimeResponse::BiometricUnlock { accounts } = biometric_request(
        &runtime,
        RuntimeRequest::BiometricUnlockAccounts {
            account_ids: vec!["account-1".into(), "missing".into(), "account-1".into()],
            prompt_message: "Unlock accounts".into(),
        },
    )
    .await
    else {
        panic!("Expected result")
    };
    assert_eq!(accounts.len(), 2);
    assert_eq!(accounts[0].failure, None);
    assert_eq!(
        accounts[1].failure,
        Some(crate::BiometricFailure::AccountChanged)
    );
    assert_eq!(port.prompts.load(Ordering::SeqCst), 2);
    biometric_request(
        &runtime,
        RuntimeRequest::Lock {
            account_id: "account-1".into(),
        },
    )
    .await;
    biometric_request(
        &runtime,
        RuntimeRequest::BiometricUnlock {
            account_id: "account-1".into(),
            prompt_message: "Unlock".into(),
        },
    )
    .await;
    assert_eq!(port.prompts.load(Ordering::SeqCst), 3);
}

struct PendingBiometry {
    reached: tokio::sync::Notify,
    release: tokio::sync::Notify,
    cancellation: Mutex<Option<RequestCancellation>>,
}
#[async_trait]
impl crate::BiometricPort for PendingBiometry {
    async fn hardware(&self) -> Result<crate::BiometricHardware, RuntimeError> {
        Ok(crate::BiometricHardware {
            has_hardware: true,
            is_enrolled: true,
            kind: None,
        })
    }
    async fn authenticate(
        &self,
        _: &str,
        cancellation: RequestCancellation,
    ) -> crate::BiometricPromptResult {
        *self.cancellation.lock().unwrap() = Some(cancellation);
        self.reached.notify_one();
        self.release.notified().await;
        crate::BiometricPromptResult::Authenticated
    }
}
#[tokio::test]
async fn lock_cancels_pending_os_prompt_and_stale_success_cannot_install_keys() {
    let (runtime, _, _) = biometric_harness().await;
    let port = Arc::new(PendingBiometry {
        reached: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
        cancellation: Mutex::new(None),
    });
    runtime.install_biometric_port(port.clone());
    biometric_request(
        &runtime,
        RuntimeRequest::SetBiometricEnabled {
            account_id: "account-1".into(),
            enabled: true,
        },
    )
    .await;
    biometric_request(
        &runtime,
        RuntimeRequest::Lock {
            account_id: "account-1".into(),
        },
    )
    .await;
    let unlocking = tokio::spawn({
        let runtime = runtime.clone();
        async move {
            biometric_request(
                &runtime,
                RuntimeRequest::BiometricUnlock {
                    account_id: "account-1".into(),
                    prompt_message: "Unlock".into(),
                },
            )
            .await
        }
    });
    port.reached.notified().await;
    biometric_request(
        &runtime,
        RuntimeRequest::Lock {
            account_id: "account-1".into(),
        },
    )
    .await;
    assert!(port
        .cancellation
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .is_cancelled());
    port.release.notify_one();
    let RuntimeResponse::BiometricUnlock { accounts } = unlocking.await.unwrap() else {
        panic!("Expected result")
    };
    assert_eq!(
        accounts[0].failure,
        Some(crate::BiometricFailure::AccountChanged)
    );
    assert_eq!(
        runtime_status(&runtime).accounts[0].access,
        AccountAccessState::Locked
    );
}

#[tokio::test]
async fn disabling_during_os_prompt_cannot_be_undone_by_its_late_success() {
    let (runtime, _, _) = biometric_harness().await;
    let port = Arc::new(PendingBiometry {
        reached: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
        cancellation: Mutex::new(None),
    });
    runtime.install_biometric_port(port.clone());
    biometric_request(
        &runtime,
        RuntimeRequest::SetBiometricEnabled {
            account_id: "account-1".into(),
            enabled: true,
        },
    )
    .await;
    biometric_request(
        &runtime,
        RuntimeRequest::Lock {
            account_id: "account-1".into(),
        },
    )
    .await;
    let unlocking = tokio::spawn({
        let runtime = runtime.clone();
        async move {
            biometric_request(
                &runtime,
                RuntimeRequest::BiometricUnlock {
                    account_id: "account-1".into(),
                    prompt_message: "Unlock".into(),
                },
            )
            .await
        }
    });
    port.reached.notified().await;
    biometric_request(
        &runtime,
        RuntimeRequest::SetBiometricEnabled {
            account_id: "account-1".into(),
            enabled: false,
        },
    )
    .await;
    port.release.notify_one();
    let RuntimeResponse::BiometricUnlock { accounts } = unlocking.await.unwrap() else {
        panic!("Expected result")
    };
    assert_eq!(
        accounts[0].failure,
        Some(crate::BiometricFailure::AccountChanged)
    );
    assert_eq!(
        runtime_status(&runtime).accounts[0].access,
        AccountAccessState::Locked
    );
    let RuntimeResponse::BiometricAvailability { accounts, .. } = biometric_request(
        &runtime,
        RuntimeRequest::BiometricAvailability {
            account_ids: vec!["account-1".into()],
        },
    )
    .await
    else {
        panic!("Expected availability")
    };
    assert!(!accounts[0].enabled);
}

#[tokio::test]
async fn close_drains_an_admitted_local_security_write() {
    let (runtime, platform, _) = biometric_harness().await;
    let pause = Pause::new(PersistenceStep::LocalSecurity);
    platform.pause_at(pause.clone());
    let setting = tokio::spawn({
        let runtime = runtime.clone();
        async move {
            runtime
                .request(
                    RuntimeRequest::SetMasterPasswordReentryPeriod { period_ms: -1 },
                    RequestCancellation::new(),
                )
                .await
        }
    });
    pause.wait_until_reached().await;
    let mut closing = tokio::spawn({
        let runtime = runtime.clone();
        async move { runtime.close().await }
    });
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(50), &mut closing)
            .await
            .is_err(),
        "close must drain the admitted storage mutation"
    );
    pause.release();
    setting.await.unwrap().unwrap();
    closing.await.unwrap();
    let error = runtime
        .request(
            RuntimeRequest::SetMasterPasswordReentryPeriod { period_ms: 0 },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::RuntimeClosed);
}

#[tokio::test]
async fn newly_hidden_authority_refuses_release_and_remains_hidden_on_offline_retry() {
    let http = Arc::new(OfflineTravel::default());
    let (runtime, _, _) = biometric_harness_with_http(http.clone()).await;
    biometric_request(
        &runtime,
        RuntimeRequest::SetBiometricEnabled {
            account_id: "account-1".into(),
            enabled: true,
        },
    )
    .await;
    biometric_request(
        &runtime,
        RuntimeRequest::Lock {
            account_id: "account-1".into(),
        },
    )
    .await;
    http.responses.lock().unwrap().push_back(routing_completed(200, json!({ "enabled": true, "enabledAt": "2023-11-14T22:13:20Z", "hiddenVaultIds": ["visible"], "updatedAt": "2023-11-14T22:13:20Z" })));
    for _ in 0..2 {
        let RuntimeResponse::BiometricUnlock { accounts } = biometric_request(
            &runtime,
            RuntimeRequest::BiometricUnlock {
                account_id: "account-1".into(),
                prompt_message: "Unlock".into(),
            },
        )
        .await
        else {
            panic!("Expected result")
        };
        assert_eq!(
            accounts[0].failure,
            Some(crate::BiometricFailure::TravelUnverified)
        );
        assert_eq!(
            runtime_status(&runtime).accounts[0].access,
            AccountAccessState::Locked
        );
        assert!(!runtime.has_live_master_unlock_key(&"account-1".into(), &"incarnation-1".into()));
    }
}

#[tokio::test]
async fn local_release_wakes_parked_work_without_creating_or_refreshing_a_session() {
    let (runtime, _, _) = biometric_harness().await;
    biometric_request(
        &runtime,
        RuntimeRequest::SetBiometricEnabled {
            account_id: "account-1".into(),
            enabled: true,
        },
    )
    .await;
    biometric_request(
        &runtime,
        RuntimeRequest::Lock {
            account_id: "account-1".into(),
        },
    )
    .await;
    runtime.mark_reauthentication_required(&"account-1".into());
    biometric_request(
        &runtime,
        RuntimeRequest::BiometricUnlock {
            account_id: "account-1".into(),
            prompt_message: "Unlock".into(),
        },
    )
    .await;
    assert_eq!(runtime_status(&runtime).accounts[0].waiting_reason, None);
    assert_eq!(
        *runtime
            .copy_live_master_unlock_key(&"account-1".into(), &"incarnation-1".into())
            .unwrap(),
        [0xA5; 32]
    );
}

struct BiometricClock(AtomicU64);
impl Clock for BiometricClock {
    fn now_ms(&self) -> Result<u64, RuntimeError> {
        Ok(self.0.load(Ordering::SeqCst))
    }
}
#[tokio::test]
async fn password_reentry_deadline_is_rechecked_after_os_success() {
    let clock = Arc::new(BiometricClock(AtomicU64::new(NOW_MS)));
    let (runtime, _, _) =
        biometric_harness_with_clock(Arc::new(OfflineTravel::default()), clock.clone()).await;
    let port = Arc::new(PendingBiometry {
        reached: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
        cancellation: Mutex::new(None),
    });
    runtime.install_biometric_port(port.clone());
    biometric_request(
        &runtime,
        RuntimeRequest::SetBiometricEnabled {
            account_id: "account-1".into(),
            enabled: true,
        },
    )
    .await;
    biometric_request(
        &runtime,
        RuntimeRequest::SetMasterPasswordReentryPeriod { period_ms: 1 },
    )
    .await;
    biometric_request(
        &runtime,
        RuntimeRequest::Lock {
            account_id: "account-1".into(),
        },
    )
    .await;
    let unlocking = tokio::spawn({
        let runtime = runtime.clone();
        async move {
            biometric_request(
                &runtime,
                RuntimeRequest::BiometricUnlock {
                    account_id: "account-1".into(),
                    prompt_message: "Unlock".into(),
                },
            )
            .await
        }
    });
    port.reached.notified().await;
    clock.0.store(NOW_MS + 1, Ordering::SeqCst);
    port.release.notify_one();
    let RuntimeResponse::BiometricUnlock { accounts } = unlocking.await.unwrap() else {
        panic!("Expected result")
    };
    assert_eq!(
        accounts[0].failure,
        Some(crate::BiometricFailure::PasswordRequired)
    );
    assert_eq!(
        runtime_status(&runtime).accounts[0].access,
        AccountAccessState::Locked
    );
    assert!(!runtime.has_live_master_unlock_key(&"account-1".into(), &"incarnation-1".into()));
}

#[test]
fn local_security_wire_preserves_signed_extremes_and_rejects_noncanonical_numbers() {
    for period_ms in [i64::MIN, -1, 0, i64::MAX] {
        let request = RuntimeRequest::SetMasterPasswordReentryPeriod { period_ms };
        let json = serde_json::to_value(&request).unwrap();
        assert_eq!(json["periodMs"], period_ms.to_string());
        assert!(
            matches!(serde_json::from_value::<RuntimeRequest>(json).unwrap(), RuntimeRequest::SetMasterPasswordReentryPeriod { period_ms: parsed } if parsed == period_ms)
        );
    }
    for invalid in [
        json!(0),
        json!("-0"),
        json!("+1"),
        json!("01"),
        json!("9223372036854775808"),
        json!("-9223372036854775809"),
    ] {
        assert!(serde_json::from_value::<RuntimeRequest>(
            json!({"type": "setMasterPasswordReentryPeriod", "periodMs": invalid})
        )
        .is_err());
    }
}

#[tokio::test]
async fn one_password_unlocks_only_explicit_targets_and_preserves_partial_results() {
    let http = Arc::new(RoutingAuthHttp::new(
        current_kdf_profile(),
        RoutingAuthBehavior::Success,
        None,
    ));
    let (runtime, _, platform) = routing_harness(http).await;
    install_quick_unlock_account(&runtime, &platform).await;
    let RuntimeResponse::AccountsUnlocked { accounts } = biometric_request(
        &runtime,
        RuntimeRequest::QuickUnlockAccounts {
            account_ids: vec!["missing".into(), "account-1".into(), "account-1".into()],
            master_password: MASTER_PASSWORD.into(),
        },
    )
    .await
    else {
        panic!("Expected Account results")
    };
    assert_eq!(accounts.len(), 2);
    assert_eq!(accounts[0].account_id, AccountId::from("missing"));
    assert_eq!(accounts[0].failure, Some(RuntimeErrorCode::AccountMissing));
    assert_eq!(accounts[1].account_id, AccountId::from("account-1"));
    assert_eq!(accounts[1].failure, None);
    assert_eq!(
        runtime_status(&runtime).accounts[0].access,
        AccountAccessState::Unlocked
    );
}

#[tokio::test]
async fn device_setup_is_scoped_transient_redacted_and_late_delivery_is_fenced_by_lock() {
    let (runtime, platform, _) = device_setup_harness().await;
    let response = biometric_request(
        &runtime,
        RuntimeRequest::DeviceSetup {
            account_id: "account-1".into(),
        },
    )
    .await;
    let RuntimeResponse::DeviceSetup { disclosure } = &response else {
        panic!("Expected setup disclosure")
    };
    assert_eq!(disclosure.account_id, AccountId::from("account-1"));
    assert_eq!(disclosure.email, "user-1@example.com");
    assert_eq!(disclosure.server_url, "https://vault.example.com");
    assert_eq!(disclosure.secret_key.as_ref(), SECRET_KEY);
    assert!(!format!("{response:?}").contains(SECRET_KEY));
    let encoded = runtime
        .encode_outcome(crate::RuntimeOutcome::Succeeded(response.clone()))
        .unwrap();
    assert!(encoded.contains(SECRET_KEY));
    drop(encoded);
    biometric_request(
        &runtime,
        RuntimeRequest::Lock {
            account_id: "account-1".into(),
        },
    )
    .await;
    assert_eq!(
        runtime
            .encode_outcome(crate::RuntimeOutcome::Succeeded(response))
            .unwrap_err()
            .code,
        RuntimeErrorCode::AuthenticationRequired
    );
    platform.clear_events();
    let error = runtime
        .request(
            RuntimeRequest::DeviceSetup {
                account_id: "account-1".into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::AuthenticationRequired);
    assert_eq!(
        platform.invocation_count(),
        0,
        "Locked disclosure must not load retained credentials"
    );
}

#[tokio::test]
async fn inactivity_uses_core_receipt_time_and_exact_deadline_without_unlocking() {
    let clock = Arc::new(BiometricClock(AtomicU64::new(NOW_MS)));
    let (runtime, _, _) =
        biometric_harness_with_clock(Arc::new(OfflineTravel::default()), clock.clone()).await;
    let settings = biometric_request(
        &runtime,
        RuntimeRequest::LocalSecuritySettings {
            account_id: "account-1".into(),
        },
    )
    .await;
    assert!(matches!(
        settings,
        RuntimeResponse::LocalSecuritySettings {
            inactivity_timeout_ms: 600_000,
            ..
        }
    ));
    biometric_request(
        &runtime,
        RuntimeRequest::SetInactivityTimeout {
            account_id: "account-1".into(),
            timeout_ms: 60_000,
        },
    )
    .await;
    biometric_request(
        &runtime,
        RuntimeRequest::RecordActivity {
            account_id: "account-1".into(),
            kind: crate::ActivityKind::Interaction,
        },
    )
    .await;
    clock.0.store(NOW_MS + 59_999, Ordering::SeqCst);
    assert_eq!(runtime.evaluate_inactivity().await.unwrap(), Some(1));
    assert_eq!(
        runtime_status(&runtime).accounts[0].access,
        AccountAccessState::Unlocked
    );
    clock.0.store(NOW_MS + 60_000, Ordering::SeqCst);
    runtime.evaluate_inactivity().await.unwrap();
    assert_eq!(
        runtime_status(&runtime).accounts[0].access,
        AccountAccessState::Locked
    );
    biometric_request(
        &runtime,
        RuntimeRequest::RecordActivity {
            account_id: "account-1".into(),
            kind: crate::ActivityKind::Focus,
        },
    )
    .await;
    assert_eq!(
        runtime_status(&runtime).accounts[0].access,
        AccountAccessState::Locked
    );
}

#[tokio::test]
async fn device_setup_conversion_uses_the_existing_plaintext_delivery_drain() {
    let (runtime, _, _) = device_setup_harness().await;
    let response = biometric_request(
        &runtime,
        RuntimeRequest::DeviceSetup {
            account_id: "account-1".into(),
        },
    )
    .await;
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let delivering = runtime.clone();
    let delivery = std::thread::spawn(move || {
        delivering.deliver_response(response, |_| {
            entered_tx.send(()).unwrap();
            release_rx.recv().unwrap();
        })
    });
    entered_rx
        .recv_timeout(std::time::Duration::from_secs(2))
        .unwrap();
    let locking = runtime.clone();
    let lock = std::thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(locking.mark_account_locked(&"account-1".into()))
    });
    while runtime_status(&runtime).accounts[0].access != AccountAccessState::Locked {
        tokio::task::yield_now().await;
    }
    assert!(
        !lock.is_finished(),
        "Lock must drain already-linearized secret conversion"
    );
    release_tx.send(()).unwrap();
    delivery.join().unwrap().unwrap();
    lock.join().unwrap().unwrap();
}

#[tokio::test]
async fn password_unlock_all_rechecks_its_captured_scope_after_waiting_for_execution() {
    let (runtime, platform, _) = biometric_harness().await;
    let lock = runtime.account_execution_lock(&"account-1".into()).unwrap();
    let guard = lock.lock().await;
    let mut request = Box::pin(runtime.request(
        RuntimeRequest::QuickUnlockAccounts {
            account_ids: vec!["account-1".into()],
            master_password: MASTER_PASSWORD.into(),
        },
        RequestCancellation::new(),
    ));
    std::future::poll_fn(|cx| {
        assert!(std::future::Future::poll(request.as_mut(), cx).is_pending());
        std::task::Poll::Ready(())
    })
    .await;
    let mut replacement = runtime.replica.snapshot(&"account-1".into()).unwrap();
    replacement.lock_epoch += 1;
    runtime.replica.cache(replacement);
    platform.clear_events();
    drop(guard);
    let RuntimeResponse::AccountsUnlocked { accounts } = request.await.unwrap() else {
        panic!("Expected partial results")
    };
    assert_eq!(
        accounts[0].failure,
        Some(RuntimeErrorCode::AuthenticationRequired)
    );
    assert_eq!(
        platform.invocation_count(),
        0,
        "A retired explicit target cannot read new generation credentials"
    );
}

#[tokio::test]
async fn inactivity_starts_at_successful_unlock_without_waiting_for_a_renderer_input() {
    let clock = Arc::new(BiometricClock(AtomicU64::new(NOW_MS)));
    let (runtime, _, _) =
        biometric_harness_with_clock(Arc::new(OfflineTravel::default()), clock.clone()).await;
    clock.0.store(NOW_MS + 600_000, Ordering::SeqCst);
    runtime.evaluate_inactivity().await.unwrap();
    assert_eq!(
        runtime_status(&runtime).accounts[0].access,
        AccountAccessState::Locked
    );
}

#[tokio::test]
async fn inactivity_uses_selected_account_never_and_preserves_preferences_across_replacement() {
    let clock = Arc::new(BiometricClock(AtomicU64::new(NOW_MS)));
    let http = Arc::new(OfflineTravel::default());
    let (runtime, _, _) = biometric_harness_with_clock(http.clone(), clock.clone()).await;
    http.strict.store(false, Ordering::SeqCst);
    install(
        &runtime,
        "user-2",
        &FixedEntropy::new(&["account-2", "incarnation-2"]),
    )
    .await
    .unwrap();
    biometric_request(
        &runtime,
        RuntimeRequest::SetInactivityTimeout {
            account_id: "account-1".into(),
            timeout_ms: 1,
        },
    )
    .await;
    biometric_request(
        &runtime,
        RuntimeRequest::SetInactivityTimeout {
            account_id: "account-2".into(),
            timeout_ms: -1,
        },
    )
    .await;
    biometric_request(
        &runtime,
        RuntimeRequest::RecordActivity {
            account_id: "account-2".into(),
            kind: crate::ActivityKind::Blur,
        },
    )
    .await;
    clock.0.store(NOW_MS + 86_400_000, Ordering::SeqCst);
    assert_eq!(runtime.evaluate_inactivity().await.unwrap(), None);
    assert!(runtime_status(&runtime)
        .accounts
        .iter()
        .all(|account| account.access == AccountAccessState::Unlocked));
    install(&runtime, "user-1", &FixedEntropy::new(&["replacement"]))
        .await
        .unwrap();
    assert!(matches!(
        biometric_request(
            &runtime,
            RuntimeRequest::LocalSecuritySettings {
                account_id: "account-1".into()
            }
        )
        .await,
        RuntimeResponse::LocalSecuritySettings {
            inactivity_timeout_ms: 1,
            ..
        }
    ));
    biometric_request(
        &runtime,
        RuntimeRequest::RecordActivity {
            account_id: "account-1".into(),
            kind: crate::ActivityKind::Focus,
        },
    )
    .await;
    clock.0.fetch_add(1, Ordering::SeqCst);
    runtime.evaluate_inactivity().await.unwrap();
    assert!(runtime_status(&runtime)
        .accounts
        .iter()
        .all(|account| account.access == AccountAccessState::Locked));
}

#[tokio::test]
async fn inactivity_driver_survives_observer_detach_and_stops_with_runtime_owner() {
    let clock = Arc::new(BiometricClock(AtomicU64::new(NOW_MS)));
    let http = Arc::new(OfflineTravel::default());
    http.allow_account_refresh.store(true, Ordering::SeqCst);
    let (runtime, _, _) = biometric_harness_with_clock(http, clock.clone()).await;
    biometric_request(
        &runtime,
        RuntimeRequest::RecordActivity {
            account_id: "account-1".into(),
            kind: crate::ActivityKind::Interaction,
        },
    )
    .await;
    let observer = runtime
        .observe(
            ObservationRequest::RuntimeStatus { account_id: None },
            Arc::new(Sink::default()),
        )
        .unwrap();
    let driver = tokio::spawn(runtime.clone().run_operation_dispatch());
    tokio::task::yield_now().await;
    observer.close();
    clock.0.store(NOW_MS + 600_000, Ordering::SeqCst);
    runtime.wake_dispatch();
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while runtime_status(&runtime).accounts[0].access != AccountAccessState::Locked {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    runtime.close().await;
    tokio::time::timeout(std::time::Duration::from_secs(2), driver)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn inactivity_uses_default_when_selected_account_is_removed_without_new_host_input() {
    let clock = Arc::new(BiometricClock(AtomicU64::new(NOW_MS)));
    let http = Arc::new(OfflineTravel::default());
    let (runtime, _, _) = biometric_harness_with_clock(http.clone(), clock.clone()).await;
    http.strict.store(false, Ordering::SeqCst);
    install(
        &runtime,
        "user-2",
        &FixedEntropy::new(&["account-2", "incarnation-2"]),
    )
    .await
    .unwrap();
    biometric_request(
        &runtime,
        RuntimeRequest::SetInactivityTimeout {
            account_id: "account-1".into(),
            timeout_ms: -1,
        },
    )
    .await;
    biometric_request(
        &runtime,
        RuntimeRequest::RecordActivity {
            account_id: "account-1".into(),
            kind: crate::ActivityKind::Interaction,
        },
    )
    .await;
    biometric_request(
        &runtime,
        RuntimeRequest::RemoveAccount {
            account_id: "account-1".into(),
        },
    )
    .await;
    clock.0.store(NOW_MS + 600_000, Ordering::SeqCst);
    runtime.evaluate_inactivity().await.unwrap();
    assert_eq!(
        runtime_status(&runtime).accounts[0].account_id,
        AccountId::from("account-2")
    );
    assert_eq!(
        runtime_status(&runtime).accounts[0].access,
        AccountAccessState::Locked
    );
}

#[tokio::test]
async fn desktop_inactivity_does_not_silently_activate_on_existing_web_owner() {
    let clock = Arc::new(BiometricClock(AtomicU64::new(NOW_MS)));
    let (runtime, _, _) = biometric_harness_with_platform(
        Arc::new(OfflineTravel::default()),
        clock.clone(),
        ClientPlatform::Web,
    )
    .await;
    clock.0.store(NOW_MS + 600_000, Ordering::SeqCst);
    runtime.evaluate_inactivity().await.unwrap();
    assert_eq!(
        runtime_status(&runtime).accounts[0].access,
        AccountAccessState::Unlocked
    );
}

#[tokio::test]
async fn background_session_refresh_does_not_count_as_user_activity() {
    let clock = Arc::new(BiometricClock(AtomicU64::new(NOW_MS)));
    let (runtime, _, _) =
        biometric_harness_with_clock(Arc::new(OfflineTravel::default()), clock.clone()).await;
    clock.0.store(NOW_MS + 599_999, Ordering::SeqCst);
    runtime.note_session_available(&"account-1".into());
    clock.0.store(NOW_MS + 600_000, Ordering::SeqCst);
    runtime.evaluate_inactivity().await.unwrap();
    assert_eq!(
        runtime_status(&runtime).accounts[0].access,
        AccountAccessState::Locked
    );
}

#[tokio::test]
async fn inactivity_receipt_timestamp_precedes_waiting_for_account_execution() {
    let clock = Arc::new(BiometricClock(AtomicU64::new(NOW_MS)));
    let (runtime, _, _) =
        biometric_harness_with_clock(Arc::new(OfflineTravel::default()), clock.clone()).await;
    let lock = runtime.account_execution_lock(&"account-1".into()).unwrap();
    let guard = lock.lock().await;
    let mut activity = Box::pin(runtime.request(
        RuntimeRequest::RecordActivity {
            account_id: "account-1".into(),
            kind: crate::ActivityKind::Interaction,
        },
        RequestCancellation::new(),
    ));
    std::future::poll_fn(|cx| {
        assert!(std::future::Future::poll(activity.as_mut(), cx).is_pending());
        std::task::Poll::Ready(())
    })
    .await;
    clock.0.store(NOW_MS + 600_000, Ordering::SeqCst);
    drop(guard);
    activity.await.unwrap();
    runtime.evaluate_inactivity().await.unwrap();
    assert_eq!(
        runtime_status(&runtime).accounts[0].access,
        AccountAccessState::Locked
    );
}

#[tokio::test]
async fn device_setup_refuses_pending_lock_before_epoch_or_key_retirement() {
    let (runtime, platform, _) = device_setup_harness().await;
    let disclosure = biometric_request(
        &runtime,
        RuntimeRequest::DeviceSetup {
            account_id: "account-1".into(),
        },
    )
    .await;
    let lifecycle = runtime.account_lifecycle_lock(&"account-1".into()).unwrap();
    let held = lifecycle.lock().await;
    let account_id = AccountId::from("account-1");
    let mut locking = Box::pin(runtime.mark_account_locked(&account_id));
    std::future::poll_fn(|cx| {
        assert!(std::future::Future::poll(locking.as_mut(), cx).is_pending());
        std::task::Poll::Ready(())
    })
    .await;
    assert!(runtime.account_access_retirement_is_pending(&"account-1".into()));
    let encoded = runtime.encode_outcome(crate::RuntimeOutcome::Succeeded(disclosure));
    assert!(
        matches!(
            encoded,
            Err(RuntimeError {
                code: RuntimeErrorCode::AuthenticationRequired,
                ..
            })
        ),
        "Pending Lock must fence retained disclosure encoding"
    );
    platform.clear_events();
    let result = runtime
        .request(
            RuntimeRequest::DeviceSetup {
                account_id: "account-1".into(),
            },
            RequestCancellation::new(),
        )
        .await;
    assert!(matches!(
        result,
        Err(RuntimeError {
            code: RuntimeErrorCode::AuthenticationRequired,
            ..
        })
    ));
    assert_eq!(platform.invocation_count(), 0);
    drop(locking);
    drop(held);
}

#[tokio::test]
async fn biometric_enrollment_cannot_modify_replacement_after_waiting_for_execution() {
    let (runtime, platform, _) = biometric_harness().await;
    let account_id = AccountId::from("account-1");
    let original = runtime.replica.snapshot(&account_id).unwrap();
    let mut metadata = runtime
        .platform_storage
        .load_account_metadata(&account_id, &original.incarnation)
        .await
        .unwrap()
        .unwrap();
    let mut quick = runtime
        .platform_storage
        .load_quick_unlock(&account_id, &original.incarnation)
        .await
        .unwrap()
        .unwrap();
    let lock = runtime.account_execution_lock(&account_id).unwrap();
    let held = lock.lock().await;
    let mut request = Box::pin(runtime.request(
        RuntimeRequest::SetBiometricEnabled {
            account_id: account_id.clone(),
            enabled: true,
        },
        RequestCancellation::new(),
    ));
    std::future::poll_fn(|cx| {
        assert!(std::future::Future::poll(request.as_mut(), cx).is_pending());
        std::task::Poll::Ready(())
    })
    .await;
    let mut replacement = original;
    replacement.incarnation = "replacement".into();
    metadata.incarnation = replacement.incarnation.clone();
    quick.incarnation = replacement.incarnation.clone();
    runtime
        .platform_storage
        .store_account_metadata(&metadata)
        .await
        .unwrap();
    runtime
        .platform_storage
        .store_quick_unlock(&quick)
        .await
        .unwrap();
    runtime.replica.cache(replacement.clone());
    platform.clear_events();
    drop(held);
    assert!(matches!(
        request.await,
        Err(RuntimeError {
            code: RuntimeErrorCode::AuthenticationRequired,
            ..
        })
    ));
    assert_eq!(platform.invocation_count(), 0);
    assert!(
        !runtime
            .platform_storage
            .load_account_metadata(&account_id, &replacement.incarnation)
            .await
            .unwrap()
            .unwrap()
            .biometric_enabled
    );
}

#[tokio::test]
async fn retired_biometric_preflight_cannot_start_an_os_prompt_after_lock() {
    let (runtime, platform, port) = biometric_harness().await;
    biometric_request(
        &runtime,
        RuntimeRequest::SetBiometricEnabled {
            account_id: "account-1".into(),
            enabled: true,
        },
    )
    .await;
    let pause = Pause::new(PersistenceStep::DeviceKey);
    *platform.device_key_read_pause.lock().unwrap() = Some(pause.clone());
    let unlocking = runtime.clone();
    let request = tokio::spawn(async move {
        biometric_request(
            &unlocking,
            RuntimeRequest::BiometricUnlock {
                account_id: "account-1".into(),
                prompt_message: "Unlock".into(),
            },
        )
        .await
    });
    pause.wait_until_reached().await;
    runtime
        .mark_account_locked(&"account-1".into())
        .await
        .unwrap();
    pause.release();
    let RuntimeResponse::BiometricUnlock { accounts } = request.await.unwrap() else {
        panic!("Expected local unlock result")
    };
    assert_eq!(
        accounts[0].failure,
        Some(crate::BiometricFailure::AccountChanged)
    );
    assert_eq!(
        port.prompts.load(Ordering::SeqCst),
        0,
        "Retired preflight cannot create a new OS prompt"
    );
}

#[tokio::test]
async fn replacement_installation_retires_an_existing_os_prompt() {
    let http = Arc::new(OfflineTravel::default());
    let (runtime, _, _) = biometric_harness_with_http(http.clone()).await;
    http.strict.store(false, Ordering::SeqCst);
    let port = Arc::new(PendingBiometry {
        reached: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
        cancellation: Mutex::new(None),
    });
    runtime.install_biometric_port(port.clone());
    biometric_request(
        &runtime,
        RuntimeRequest::SetBiometricEnabled {
            account_id: "account-1".into(),
            enabled: true,
        },
    )
    .await;
    let unlocking = runtime.clone();
    let request = tokio::spawn(async move {
        biometric_request(
            &unlocking,
            RuntimeRequest::BiometricUnlock {
                account_id: "account-1".into(),
                prompt_message: "Unlock".into(),
            },
        )
        .await
    });
    port.reached.notified().await;
    install(&runtime, "user-1", &FixedEntropy::new(&["replacement"]))
        .await
        .unwrap();
    let cancelled = port
        .cancellation
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .is_cancelled();
    port.release.notify_one();
    let _ = request.await.unwrap();
    assert!(
        cancelled,
        "Replacing an Account generation must cancel its existing OS prompt"
    );
}
#[path = "recipient_keys_tests.rs"]
mod recipient_keys;
