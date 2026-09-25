use super::*;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Default)]
struct CountedBiometry {
    prompts: AtomicUsize,
}

struct FixedTravelPolicyHttp;

#[async_trait]
impl crate::http_transport::SerializedHttpExecutor for FixedTravelPolicyHttp {
    async fn invoke(&self, request: Zeroizing<String>) -> Result<String, RuntimeError> {
        #[derive(serde::Deserialize)]
        struct Target<'a> {
            method: &'a str,
            url: &'a str,
        }
        let target: Target<'_> = serde_json::from_str(&request).unwrap();
        if target.method == "GET" && target.url.ends_with("/travel-mode") {
            return Ok(routing_completed(
                200,
                serde_json::to_value(verified_with_derived_muk().travel_mode).unwrap(),
            ));
        }
        Ok(serde_json::json!({ "type": "networkFailure" }).to_string())
    }

    fn cancel(&self, _dispatch_id: &str) {}
}

#[async_trait]
impl crate::BiometricPort for CountedBiometry {
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

async fn enable_and_lock(runtime: &Runtime) {
    let account_id = AccountId::from("account-1");
    runtime
        .request(
            RuntimeRequest::SetBiometricEnabled {
                account_id: account_id.clone(),
                enabled: true,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    runtime
        .request(
            RuntimeRequest::Lock { account_id },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn legacy_biometric_status_and_explicit_single_use_the_current_core_ceremony() {
    let owner = sqlite_owner("single-session", ClientPlatform::Desktop).await;
    let port = Arc::new(CountedBiometry::default());
    owner.runtime.install_biometric_port(port.clone());
    let source = owner
        .runtime
        .native_authority()
        .attach_source_scoped("allowed-extension".into(), "single-port".into())
        .unwrap();
    let status: serde_json::Value = serde_json::from_str(
        &source
            .encode_legacy_biometric_status(Some("status-1"))
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(status["type"], "BIOMETRIC_STATUS");
    assert_eq!(status["requestId"], "status-1");
    assert_eq!(status["available"], true);
    assert_eq!(
        status["enabled"], false,
        "headless source has no UI Active Account"
    );
    assert_eq!(status["appRunning"], true);
    assert!(source
        .encode_legacy_biometric_single(None, "allowed-extension", "challenge", None)
        .await
        .is_err());
    assert!(source
        .encode_legacy_biometric_single(Some("account-1"), "other-extension", "challenge", None,)
        .await
        .is_err());
    assert_eq!(port.prompts.load(Ordering::SeqCst), 0);

    enable_and_lock(&owner.runtime).await;
    let encoded = source
        .encode_legacy_biometric_single(
            Some("account-1"),
            "allowed-extension",
            "challenge",
            Some("single-1"),
        )
        .await
        .unwrap();
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Wire<'a> {
        protocol_version: u32,
        request_id: &'a str,
        #[serde(rename = "type")]
        kind: &'a str,
        account_id: &'a str,
        #[serde(rename = "encrypted_session")]
        encrypted_session: &'a str,
        #[serde(rename = "device_key")]
        device_key: &'a str,
        signature: &'a str,
        #[serde(rename = "auth_token")]
        auth_token: &'a str,
        #[serde(rename = "vault_keys")]
        vault_keys: &'a str,
    }
    let wire: Wire<'_> = serde_json::from_str(&encoded).unwrap();
    assert_eq!(wire.protocol_version, 1);
    assert_eq!(wire.request_id, "single-1");
    assert_eq!(wire.kind, "BIOMETRIC_UNLOCK_SUCCESS");
    assert_eq!(wire.account_id, "account-1");
    assert_eq!(wire.auth_token, "single-session");
    assert!(wire.vault_keys.starts_with('['));
    let wrapped = Zeroizing::new(BASE64.decode(wire.encrypted_session).unwrap());
    let quick = owner
        .runtime
        .platform_storage
        .load_quick_unlock(
            &AccountId::from("account-1"),
            &Incarnation::from("generation-1"),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        wrapped.as_slice(),
        serde_json::to_vec(&quick.encrypted_master_unlock_key).unwrap()
    );
    assert_eq!(BASE64.decode(wire.device_key).unwrap().len(), 32);
    let signature_input = Zeroizing::new(format!("challenge:{}", wire.encrypted_session));
    assert_eq!(wire.signature, BASE64.encode(signature_input.as_bytes()));
    assert_eq!(port.prompts.load(Ordering::SeqCst), 1);

    source.close();
    assert!(source.encode_legacy_biometric_status(None).await.is_err());
    owner.runtime.close().await;
}

#[tokio::test]
async fn legacy_biometric_single_and_all_refuse_missing_session_without_prompt() {
    let owner = sqlite_owner("retained-session", ClientPlatform::Desktop).await;
    let port = Arc::new(CountedBiometry::default());
    owner.runtime.install_biometric_port(port.clone());
    enable_and_lock(&owner.runtime).await;
    let source = owner
        .runtime
        .native_authority()
        .attach_source_scoped("allowed-extension".into(), "missing-session-port".into())
        .unwrap();
    let account = AccountId::from("account-1");
    let incarnation = Incarnation::from("generation-1");
    let session = owner
        .runtime
        .platform_storage
        .load_current_session(&account, &incarnation)
        .await
        .unwrap()
        .unwrap();
    owner
        .runtime
        .platform_storage
        .remove_current_session(&account, &incarnation)
        .await
        .unwrap();
    let single: serde_json::Value = serde_json::from_str(
        &source
            .encode_legacy_biometric_single(
                Some("account-1"),
                "allowed-extension",
                "challenge",
                None,
            )
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(single["type"], "BIOMETRIC_UNLOCK_FAILED");
    let all: serde_json::Value = serde_json::from_str(
        &source
            .encode_legacy_biometric_all("allowed-extension", "challenge", None)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(all["type"], "BIOMETRIC_UNLOCK_ALL_FAILED");
    assert_eq!(port.prompts.load(Ordering::SeqCst), 0);

    owner
        .runtime
        .platform_storage
        .store_current_session(&session)
        .await
        .unwrap();
    owner
        .runtime
        .request(
            RuntimeRequest::SetMasterPasswordReentryPeriod { period_ms: 0 },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let reentry: serde_json::Value = serde_json::from_str(
        &source
            .encode_legacy_biometric_single(
                Some("account-1"),
                "allowed-extension",
                "challenge",
                None,
            )
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(reentry["type"], "BIOMETRIC_UNLOCK_FAILED");
    assert_eq!(port.prompts.load(Ordering::SeqCst), 0);

    owner
        .runtime
        .request(
            RuntimeRequest::SetMasterPasswordReentryPeriod { period_ms: -1 },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let mut expired = session;
    expired.expires_at_ms = NOW_MS;
    expired.server_expires_at_ms = Some(NOW_MS);
    owner
        .runtime
        .platform_storage
        .store_current_session(&expired)
        .await
        .unwrap();
    let expired_single: serde_json::Value = serde_json::from_str(
        &source
            .encode_legacy_biometric_single(
                Some("account-1"),
                "allowed-extension",
                "challenge",
                None,
            )
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(expired_single["type"], "BIOMETRIC_UNLOCK_FAILED");
    let expired_all: serde_json::Value = serde_json::from_str(
        &source
            .encode_legacy_biometric_all("allowed-extension", "challenge", None)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(expired_all["type"], "BIOMETRIC_UNLOCK_ALL_FAILED");
    assert_eq!(port.prompts.load(Ordering::SeqCst), 0);
    source.close();
    owner.runtime.close().await;
}

#[tokio::test]
async fn legacy_biometric_all_omits_disabled_accounts_before_prompt() {
    let owner = sqlite_owner("disabled-session", ClientPlatform::Desktop).await;
    let port = Arc::new(CountedBiometry::default());
    owner.runtime.install_biometric_port(port.clone());
    let source = owner
        .runtime
        .native_authority()
        .attach_source_scoped("allowed-extension".into(), "disabled-port".into())
        .unwrap();
    let all: serde_json::Value = serde_json::from_str(
        &source
            .encode_legacy_biometric_all("allowed-extension", "challenge", None)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(all["type"], "BIOMETRIC_UNLOCK_ALL_FAILED");
    assert_eq!(port.prompts.load(Ordering::SeqCst), 0);
    source.close();
    owner.runtime.close().await;
}

#[tokio::test]
async fn legacy_biometric_all_preserves_a_success_and_a_failed_enabled_account() {
    let owner = sqlite_owner_with_http(
        "first-session",
        ClientPlatform::Desktop,
        Arc::new(FixedTravelPolicyHttp),
    )
    .await;
    let mut second = verified_with_derived_muk();
    second.user.id = "user-2".into();
    owner
        .runtime
        .install_verified_authentication_with(
            second,
            evidence(),
            &FixedClock(NOW_MS),
            &FixedEntropy::new(&["account-2", "generation-2"]),
        )
        .await
        .unwrap();
    owner
        .runtime
        .request(
            RuntimeRequest::RefreshTravelMode {
                account_id: AccountId::from("account-2"),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let port = Arc::new(CountedBiometry::default());
    owner.runtime.install_biometric_port(port.clone());
    for account_id in ["account-1", "account-2"] {
        owner
            .runtime
            .request(
                RuntimeRequest::SetBiometricEnabled {
                    account_id: AccountId::from(account_id),
                    enabled: true,
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap();
        owner
            .runtime
            .request(
                RuntimeRequest::Lock {
                    account_id: AccountId::from(account_id),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap();
    }
    owner
        .runtime
        .platform_storage
        .remove_current_session(
            &AccountId::from("account-2"),
            &Incarnation::from("generation-2"),
        )
        .await
        .unwrap();
    let source = owner
        .runtime
        .native_authority()
        .attach_source_scoped("allowed-extension".into(), "partial-port".into())
        .unwrap();
    let encoded = source
        .encode_legacy_biometric_all("allowed-extension", "partial-challenge", Some("partial-1"))
        .await
        .unwrap();
    let response: serde_json::Value = serde_json::from_str(&encoded).unwrap();
    assert_eq!(response["type"], "BIOMETRIC_UNLOCK_ALL_SUCCESS");
    assert_eq!(response["requestId"], "partial-1");
    assert_eq!(response["unlocked"], serde_json::json!(["account-1"]));
    assert_eq!(response["failed"], serde_json::json!(["account-2"]));
    assert_eq!(response["accounts"].as_array().unwrap().len(), 1);
    assert_eq!(response["accounts"][0]["accountId"], "account-1");
    assert_eq!(port.prompts.load(Ordering::SeqCst), 1);
    source.close();
    owner.runtime.close().await;
}

async fn hold_biometric_after_ceremony(
    runtime: &Arc<Runtime>,
    source: Arc<NativeSourceAttachment>,
    all: bool,
) -> (
    tokio::task::JoinHandle<Result<Zeroizing<String>, RuntimeError>>,
    std::sync::mpsc::SyncSender<()>,
) {
    let (entered_tx, entered_rx) = std::sync::mpsc::sync_channel(1);
    let (release_tx, release_rx) = std::sync::mpsc::sync_channel(1);
    let release_rx = Arc::new(Mutex::new(release_rx));
    runtime
        .foreground_attachments
        .set_before_finalization_admission_hook(Some(Arc::new(move || {
            entered_tx.send(()).unwrap();
            release_rx.lock().unwrap().recv().unwrap();
        })));
    let pending = tokio::task::spawn_blocking(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap()
            .block_on(async move {
                if all {
                    source
                        .encode_legacy_biometric_all(
                            "allowed-extension",
                            "held-challenge",
                            Some("held-request"),
                        )
                        .await
                } else {
                    source
                        .encode_legacy_biometric_single(
                            Some("account-1"),
                            "allowed-extension",
                            "held-challenge",
                            Some("held-request"),
                        )
                        .await
                }
            })
    });
    let reached = tokio::task::spawn_blocking(move || {
        entered_rx
            .recv_timeout(std::time::Duration::from_secs(30))
            .is_ok()
    })
    .await
    .unwrap();
    if !reached {
        if pending.is_finished() {
            let result = pending.await.unwrap();
            panic!(
                "successful ceremony stopped before final admission: {:?}",
                result.err().map(|error| error.code)
            );
        }
        panic!("successful ceremony did not reach final admission in time");
    }
    (pending, release_tx)
}

#[tokio::test]
async fn held_legacy_biometric_all_keeps_only_the_account_with_current_local_deadlines() {
    let clock = Arc::new(NativeClock(std::sync::atomic::AtomicU64::new(NOW_MS)));
    let owner = sqlite_owner_with_clock(
        "partial-deadline-session",
        ClientPlatform::Desktop,
        Arc::new(FixedTravelPolicyHttp),
        clock.clone(),
    )
    .await;
    let mut second = verified_with_derived_muk();
    second.user.id = "user-2".into();
    owner
        .runtime
        .install_verified_authentication_with(
            second,
            evidence(),
            &FixedClock(NOW_MS),
            &FixedEntropy::new(&["account-2", "generation-2"]),
        )
        .await
        .unwrap();
    owner
        .runtime
        .request(
            RuntimeRequest::RefreshTravelMode {
                account_id: AccountId::from("account-2"),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let port = Arc::new(CountedBiometry::default());
    owner.runtime.install_biometric_port(port.clone());
    for account_id in ["account-1", "account-2"] {
        owner
            .runtime
            .request(
                RuntimeRequest::SetBiometricEnabled {
                    account_id: AccountId::from(account_id),
                    enabled: true,
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap();
        owner
            .runtime
            .request(
                RuntimeRequest::Lock {
                    account_id: AccountId::from(account_id),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap();
    }
    let account = AccountId::from("account-1");
    let incarnation = Incarnation::from("generation-1");
    let mut session = owner
        .runtime
        .platform_storage
        .load_current_session(&account, &incarnation)
        .await
        .unwrap()
        .unwrap();
    session.expires_at_ms = NOW_MS + 1;
    session.server_expires_at_ms = Some(NOW_MS + 60_000);
    owner
        .runtime
        .platform_storage
        .store_current_session(&session)
        .await
        .unwrap();
    let source = Arc::new(
        owner
            .runtime
            .native_authority()
            .attach_source_scoped("allowed-extension".into(), "partial-deadline-port".into())
            .unwrap(),
    );
    let (pending, release) = hold_biometric_after_ceremony(&owner.runtime, source, true).await;
    assert_eq!(port.prompts.load(Ordering::SeqCst), 1);
    clock.0.store(NOW_MS + 1, Ordering::SeqCst);
    release.send(()).unwrap();
    let encoded = pending.await.unwrap().expect("one Account remains current");
    let response: serde_json::Value = serde_json::from_str(&encoded).unwrap();
    assert_eq!(response["protocolVersion"], 1);
    assert_eq!(response["requestId"], "held-request");
    assert_eq!(response["type"], "BIOMETRIC_UNLOCK_ALL_SUCCESS");
    assert_eq!(response["unlocked"], serde_json::json!(["account-2"]));
    assert_eq!(response["failed"], serde_json::json!(["account-1"]));
    assert_eq!(response["accounts"].as_array().unwrap().len(), 1);
    assert_eq!(response["accounts"][0]["accountId"], "account-2");
    assert_eq!(response["signature"], BASE64.encode(b"held-challenge:1"));
    assert!(!encoded.contains(session.token.as_ref()));
    owner.runtime.close().await;
}

#[tokio::test]
async fn held_legacy_biometric_final_encoding_refuses_elapsed_local_deadlines() {
    for all in [false, true] {
        for reentry in [true, false] {
            let clock = Arc::new(NativeClock(std::sync::atomic::AtomicU64::new(NOW_MS)));
            let owner = sqlite_owner_with_clock(
                "deadline-session",
                ClientPlatform::Desktop,
                Arc::new(OfflineNativeHttp),
                clock.clone(),
            )
            .await;
            let port = Arc::new(CountedBiometry::default());
            owner.runtime.install_biometric_port(port.clone());
            if reentry {
                owner
                    .runtime
                    .request(
                        RuntimeRequest::SetMasterPasswordReentryPeriod { period_ms: 1 },
                        RequestCancellation::new(),
                    )
                    .await
                    .unwrap();
            }
            enable_and_lock(&owner.runtime).await;
            let account = AccountId::from("account-1");
            let incarnation = Incarnation::from("generation-1");
            let quick = owner
                .runtime
                .platform_storage
                .load_quick_unlock(&account, &incarnation)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                quick
                    .last_master_password_entry_ms
                    .unwrap_or(quick.created_at_ms),
                NOW_MS
            );
            let mut session = owner
                .runtime
                .platform_storage
                .load_current_session(&account, &incarnation)
                .await
                .unwrap()
                .unwrap();
            if !reentry {
                session.expires_at_ms = NOW_MS + 1;
                session.server_expires_at_ms = Some(NOW_MS + 60_000);
                owner
                    .runtime
                    .platform_storage
                    .store_current_session(&session)
                    .await
                    .unwrap();
            }
            assert!(session.expires_at_ms > NOW_MS);
            assert!(session
                .server_expires_at_ms
                .is_none_or(|expiry| expiry > NOW_MS));
            let source = Arc::new(
                owner
                    .runtime
                    .native_authority()
                    .attach_source_scoped("allowed-extension".into(), "deadline-port".into())
                    .unwrap(),
            );
            let (pending, release) =
                hold_biometric_after_ceremony(&owner.runtime, source, all).await;
            assert_eq!(port.prompts.load(Ordering::SeqCst), 1);
            clock.0.store(NOW_MS + 1, Ordering::SeqCst);
            release.send(()).unwrap();
            let encoded = pending
                .await
                .unwrap()
                .expect("deadline has a refusal envelope");
            let response: serde_json::Value = serde_json::from_str(&encoded).unwrap();
            assert_eq!(response["protocolVersion"], 1);
            assert_eq!(response["requestId"], "held-request");
            assert_eq!(
                response["type"],
                if all {
                    "BIOMETRIC_UNLOCK_ALL_FAILED"
                } else {
                    "BIOMETRIC_UNLOCK_FAILED"
                }
            );
            assert!(response["error"].is_string());
            assert_eq!(response.as_object().unwrap().len(), 4);
            assert!(!encoded.contains(session.token.as_ref()));
            owner.runtime.close().await;
        }
    }
}

#[tokio::test]
async fn held_legacy_biometric_completion_refuses_reentry_retirement_after_prompt() {
    let owner = sqlite_owner("held-session", ClientPlatform::Desktop).await;
    let port = Arc::new(CountedBiometry::default());
    owner.runtime.install_biometric_port(port.clone());
    enable_and_lock(&owner.runtime).await;
    let source = Arc::new(
        owner
            .runtime
            .native_authority()
            .attach_source_scoped("allowed-extension".into(), "held-biometric-port".into())
            .unwrap(),
    );
    let (pending, release_tx) = hold_biometric_after_ceremony(&owner.runtime, source, false).await;
    assert_eq!(port.prompts.load(Ordering::SeqCst), 1);
    // This Core67 writer retires the captured biometric generation before persisting its
    // new re-entry setting. The held native response must never serialize old material.
    owner
        .runtime
        .request(
            RuntimeRequest::SetMasterPasswordReentryPeriod { period_ms: 0 },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    release_tx.send(()).unwrap();
    assert!(pending.await.unwrap().is_err());
    owner.runtime.close().await;
}

#[tokio::test]
async fn held_legacy_biometric_completion_refuses_lock_and_source_loss() {
    let owner = sqlite_owner("held-lock-session", ClientPlatform::Desktop).await;
    let port = Arc::new(CountedBiometry::default());
    owner.runtime.install_biometric_port(port.clone());
    enable_and_lock(&owner.runtime).await;
    let source = Arc::new(
        owner
            .runtime
            .native_authority()
            .attach_source_scoped("allowed-extension".into(), "held-lock-port".into())
            .unwrap(),
    );
    let (pending, release) = hold_biometric_after_ceremony(&owner.runtime, source, false).await;
    assert_eq!(port.prompts.load(Ordering::SeqCst), 1);
    let runtime = owner.runtime.clone();
    let locking = tokio::spawn(async move {
        runtime
            .request(
                RuntimeRequest::Lock {
                    account_id: AccountId::from("account-1"),
                },
                RequestCancellation::new(),
            )
            .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while !owner
            .runtime
            .account_access_retirement_is_pending(&AccountId::from("account-1"))
        {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("Lock must retire the held biometric scope");
    release.send(()).unwrap();
    assert!(pending.await.unwrap().is_err());
    locking.await.unwrap().unwrap();

    let source = Arc::new(
        owner
            .runtime
            .native_authority()
            .attach_source_scoped("allowed-extension".into(), "held-source-port".into())
            .unwrap(),
    );
    let (pending, release) =
        hold_biometric_after_ceremony(&owner.runtime, source.clone(), false).await;
    assert_eq!(port.prompts.load(Ordering::SeqCst), 2);
    source.close();
    release.send(()).unwrap();
    assert!(pending.await.unwrap().is_err());
    owner.runtime.close().await;
}
