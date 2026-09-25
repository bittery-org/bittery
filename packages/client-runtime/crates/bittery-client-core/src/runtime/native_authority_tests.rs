use super::*;
use crate::SecretString;

#[path = "native_authority_legacy_biometric_tests.rs"]
mod legacy_biometric;
#[path = "native_authority_travel_tests.rs"]
mod travel;

struct SqliteOwner {
    runtime: Arc<Runtime>,
    platform: Arc<InstallationPlatform>,
    path: std::path::PathBuf,
}

impl Drop for SqliteOwner {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

struct OfflineNativeHttp;
#[async_trait]
impl crate::http_transport::SerializedHttpExecutor for OfflineNativeHttp {
    async fn invoke(&self, _request: zeroize::Zeroizing<String>) -> Result<String, RuntimeError> {
        Ok(serde_json::json!({ "type": "networkFailure" }).to_string())
    }
    fn cancel(&self, _dispatch_id: &str) {}
}

/// Establishes verified setup authority, then returns every request to the scenario's transport.
struct InitialNativePolicyHttp {
    policy: Mutex<Option<TravelModeResponse>>,
    scenario: Arc<dyn crate::http_transport::SerializedHttpExecutor>,
}

#[async_trait]
impl crate::http_transport::SerializedHttpExecutor for InitialNativePolicyHttp {
    async fn invoke(&self, request: Zeroizing<String>) -> Result<String, RuntimeError> {
        #[derive(serde::Deserialize)]
        struct Target<'a> {
            method: &'a str,
            url: &'a str,
        }
        let target: Target<'_> = serde_json::from_str(&request).unwrap();
        if target.method == "GET" && target.url.ends_with("/travel-mode") {
            let policy = self.policy.lock().unwrap().clone();
            if let Some(policy) = policy {
                return Ok(routing_completed(
                    200,
                    serde_json::to_value(policy).unwrap(),
                ));
            }
        }
        self.scenario.invoke(request).await
    }

    fn cancel(&self, dispatch_id: &str) {
        self.scenario.cancel(dispatch_id);
    }
}

struct AvailableBiometry;
#[async_trait]
impl crate::BiometricPort for AvailableBiometry {
    async fn hardware(&self) -> Result<crate::BiometricHardware, RuntimeError> {
        Ok(crate::BiometricHardware {
            has_hardware: true,
            is_enrolled: true,
            kind: Some(crate::BiometricKind::TouchId),
        })
    }
    async fn authenticate(
        &self,
        _message: &str,
        _cancellation: RequestCancellation,
    ) -> crate::BiometricPromptResult {
        crate::BiometricPromptResult::Authenticated
    }
}

async fn sqlite_owner(token: &str, client_platform: ClientPlatform) -> SqliteOwner {
    sqlite_owner_with_http(token, client_platform, Arc::new(OfflineNativeHttp)).await
}

#[tokio::test]
async fn legacy_auth_token_discloses_only_the_exact_current_usable_session() {
    let owner = sqlite_owner("token-fixture", ClientPlatform::Desktop).await;
    let account = AccountId::from("account-1");
    let incarnation = Incarnation::from("generation-1");
    let source = owner
        .runtime
        .native_authority()
        .attach_source_scoped("allowed-extension".into(), "token-port".into())
        .unwrap();
    let frame: serde_json::Value = serde_json::from_str(
        &source
            .encode_legacy_auth_token("account-1", Some("token-request"))
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(frame["protocolVersion"], 1);
    assert_eq!(frame["requestId"], "token-request");
    assert_eq!(frame["type"], "DESKTOP_AUTH_TOKEN");
    assert_eq!(frame["accountId"], "account-1");
    assert_eq!(frame["authToken"], "token-fixture");
    assert!(frame["email"]
        .as_str()
        .is_some_and(|email| !email.is_empty()));
    assert!(frame["expiresAt"].as_i64().is_some());
    assert_eq!(frame["userId"], "user-1");
    assert!(source
        .encode_legacy_auth_token("other-account", None)
        .await
        .is_err());
    owner
        .runtime
        .platform_storage
        .remove_current_session(&account, &incarnation)
        .await
        .unwrap();
    assert!(source
        .encode_legacy_auth_token("account-1", None)
        .await
        .is_err());
    source.close();
    owner.runtime.close().await;
}

async fn hold_legacy_auth_token_before_final_encoding(
    runtime: &Arc<Runtime>,
    source: Arc<NativeSourceAttachment>,
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
            .block_on(source.encode_legacy_auth_token("account-1", Some("held-token")))
    });
    tokio::task::spawn_blocking(move || {
        entered_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("token request must reach final encoding")
    })
    .await
    .unwrap();
    (pending, release_tx)
}

#[tokio::test]
async fn held_legacy_auth_token_refuses_session_replacement_and_clock_expiry() {
    let replaced = sqlite_owner("original-token", ClientPlatform::Desktop).await;
    let account = AccountId::from("account-1");
    let incarnation = Incarnation::from("generation-1");
    let source = Arc::new(
        replaced
            .runtime
            .native_authority()
            .attach_source_scoped("allowed-extension".into(), "token-replacement-port".into())
            .unwrap(),
    );
    let (pending, release) =
        hold_legacy_auth_token_before_final_encoding(&replaced.runtime, source).await;
    let mut replacement = replaced
        .runtime
        .platform_storage
        .load_current_session(&account, &incarnation)
        .await
        .unwrap()
        .unwrap();
    replacement.token = SecretString::from("replacement-token");
    replaced
        .runtime
        .platform_storage
        .store_current_session(&replacement)
        .await
        .unwrap();
    release.send(()).unwrap();
    assert!(pending.await.unwrap().is_err());
    replaced.runtime.close().await;

    let clock = Arc::new(NativeClock(std::sync::atomic::AtomicU64::new(NOW_MS)));
    let expired = sqlite_owner_with_clock(
        "expiring-token",
        ClientPlatform::Desktop,
        Arc::new(OfflineNativeHttp),
        clock.clone(),
    )
    .await;
    let source = Arc::new(
        expired
            .runtime
            .native_authority()
            .attach_source_scoped("allowed-extension".into(), "token-clock-port".into())
            .unwrap(),
    );
    let (pending, release) =
        hold_legacy_auth_token_before_final_encoding(&expired.runtime, source).await;
    let session = expired
        .runtime
        .platform_storage
        .load_current_session(&account, &incarnation)
        .await
        .unwrap()
        .unwrap();
    clock.0.store(
        session
            .server_expires_at_ms
            .unwrap_or(session.expires_at_ms),
        std::sync::atomic::Ordering::SeqCst,
    );
    release.send(()).unwrap();
    assert!(pending.await.unwrap().is_err());
    let late_source = expired
        .runtime
        .native_authority()
        .attach_source_scoped("allowed-extension".into(), "expired-token-port".into())
        .unwrap();
    assert!(late_source
        .encode_legacy_auth_token("account-1", None)
        .await
        .is_err());
    late_source.close();
    expired.runtime.close().await;
}

#[tokio::test]
async fn held_legacy_auth_token_refuses_lock_peer_loss_and_runtime_close() {
    let locked = sqlite_owner("lock-token", ClientPlatform::Desktop).await;
    let source = Arc::new(
        locked
            .runtime
            .native_authority()
            .attach_source_scoped("allowed-extension".into(), "token-lock-port".into())
            .unwrap(),
    );
    let (pending, release) =
        hold_legacy_auth_token_before_final_encoding(&locked.runtime, source).await;
    locked
        .runtime
        .request(
            RuntimeRequest::Lock {
                account_id: AccountId::from("account-1"),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    release.send(()).unwrap();
    assert!(pending.await.unwrap().is_err());
    locked.runtime.close().await;

    let peer = sqlite_owner("peer-token", ClientPlatform::Desktop).await;
    let source = Arc::new(
        peer.runtime
            .native_authority()
            .attach_source_scoped("allowed-extension".into(), "token-peer-port".into())
            .unwrap(),
    );
    let (pending, release) =
        hold_legacy_auth_token_before_final_encoding(&peer.runtime, source.clone()).await;
    source.close();
    release.send(()).unwrap();
    assert!(pending.await.unwrap().is_err());
    peer.runtime.close().await;

    let closed = sqlite_owner("closed-token", ClientPlatform::Desktop).await;
    let source = Arc::new(
        closed
            .runtime
            .native_authority()
            .attach_source_scoped("allowed-extension".into(), "token-closed-port".into())
            .unwrap(),
    );
    let (pending, release) =
        hold_legacy_auth_token_before_final_encoding(&closed.runtime, source).await;
    closed.runtime.close().await;
    release.send(()).unwrap();
    assert!(pending.await.unwrap().is_err());
}

#[tokio::test]
async fn held_legacy_auth_token_refuses_removed_or_replaced_account() {
    let removed = sqlite_owner("removed-token", ClientPlatform::Desktop).await;
    let source = Arc::new(
        removed
            .runtime
            .native_authority()
            .attach_source_scoped("allowed-extension".into(), "token-remove-port".into())
            .unwrap(),
    );
    let (pending, release) =
        hold_legacy_auth_token_before_final_encoding(&removed.runtime, source).await;
    let runtime = removed.runtime.clone();
    let removal = tokio::spawn(async move {
        runtime
            .request(
                RuntimeRequest::RemoveAccount {
                    account_id: AccountId::from("account-1"),
                },
                RequestCancellation::new(),
            )
            .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while removed
            .runtime
            .replica
            .snapshot(&AccountId::from("account-1"))
            .is_some()
        {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("RemoveAccount must retire the original token scope");
    release.send(()).unwrap();
    assert!(pending.await.unwrap().is_err());
    removal.await.unwrap().unwrap();
    removed.runtime.close().await;

    let replaced = sqlite_owner("replaced-account-token", ClientPlatform::Desktop).await;
    let source = Arc::new(
        replaced
            .runtime
            .native_authority()
            .attach_source_scoped(
                "allowed-extension".into(),
                "token-account-replace-port".into(),
            )
            .unwrap(),
    );
    let (pending, release) =
        hold_legacy_auth_token_before_final_encoding(&replaced.runtime, source).await;
    replaced
        .runtime
        .install_or_replace_account(
            AccountId::from("account-1"),
            "user-1".into(),
            Incarnation::from("successor-generation"),
        )
        .await
        .unwrap();
    release.send(()).unwrap();
    assert!(pending.await.unwrap().is_err());
    replaced.runtime.close().await;
}

#[tokio::test]
async fn borrowed_destination_cannot_attach_a_legacy_token_source() {
    let desktop = sqlite_owner("desktop-owner", ClientPlatform::Desktop).await;
    let extension = sqlite_owner("independent-destination", ClientPlatform::Extension).await;
    let source_control = desktop.runtime.native_authority();
    let destination_control = extension.runtime.native_authority();
    let crate::NativeAuthorityResponse::Source { snapshot } = native_control(
        &source_control,
        crate::NativeAuthorityRequest::AttachSource {
            extension_id: "allowed-extension".into(),
            transport_id: "borrowed-owner-source".into(),
        },
    )
    .await
    else {
        panic!("Desktop source attachment changed");
    };
    let crate::NativeAuthorityResponse::Attached { channel_id } = native_control(
        &destination_control,
        crate::NativeAuthorityRequest::AttachDesktop {
            source: snapshot,
            transport_id: "borrowed-destination".into(),
        },
    )
    .await
    else {
        panic!("Extension attachment changed");
    };
    let crate::NativeAuthorityResponse::Prepared { challenge } = native_control(
        &destination_control,
        crate::NativeAuthorityRequest::PrepareImportForSource {
            channel_id,
            source_account: AccountId::from("account-1"),
            insecure_transport_confirmed: false,
        },
    )
    .await
    else {
        panic!("Session import preparation changed");
    };
    let crate::NativeAuthorityResponse::Exported { reply } = native_control(
        &source_control,
        crate::NativeAuthorityRequest::Export { challenge },
    )
    .await
    else {
        panic!("Session export changed");
    };
    assert!(matches!(
        native_control(
            &destination_control,
            crate::NativeAuthorityRequest::CompleteImport { reply }
        )
        .await,
        crate::NativeAuthorityResponse::Applied
    ));
    // A borrowed destination is not a trusted native source, even though it has an effective
    // Session. This cannot establish successful borrowed-token disclosure through protocol 1.
    assert!(extension
        .runtime
        .native_authority()
        .attach_source_scoped("allowed-extension".into(), "forbidden-token-reader".into())
        .is_err());
    extension.runtime.close().await;
    desktop.runtime.close().await;
}

async fn sqlite_owner_with_http(
    token: &str,
    client_platform: ClientPlatform,
    http: Arc<dyn crate::http_transport::SerializedHttpExecutor>,
) -> SqliteOwner {
    sqlite_owner_with_clock(token, client_platform, http, Arc::new(FixedClock(NOW_MS))).await
}
async fn sqlite_owner_with_clock(
    token: &str,
    client_platform: ClientPlatform,
    http: Arc<dyn crate::http_transport::SerializedHttpExecutor>,
    clock: Arc<dyn Clock>,
) -> SqliteOwner {
    let mut authentication = verified_with_derived_muk();
    authentication.token = Zeroizing::new(token.to_owned());
    let initial_http = Arc::new(InitialNativePolicyHttp {
        policy: Mutex::new(Some(authentication.travel_mode.clone())),
        scenario: http,
    });
    let owner = empty_sqlite_owner(client_platform, initial_http.clone(), clock).await;
    let runtime = &owner.runtime;
    runtime
        .install_verified_authentication_with(
            authentication,
            evidence(),
            &FixedClock(NOW_MS),
            &FixedEntropy::new(&["account-1", "generation-1"]),
        )
        .await
        .unwrap();
    // Installation attempts Bootstrap. This scenario intentionally has no membership HTTP,
    // so its post-watermark verification duty remains pending until a real policy read wins.
    // Resolve only that setup duty through the public command before testing offline behavior.
    let response = runtime
        .request(
            RuntimeRequest::RefreshTravelMode {
                account_id: AccountId::from("account-1"),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert!(matches!(
        response,
        RuntimeResponse::TravelMode {
            result: crate::TravelModeCommandResult::Confirmed { .. },
            ..
        }
    ));
    assert!(!runtime.travel_policy_verification_pending(
        &runtime
            .require_snapshot(&AccountId::from("account-1"))
            .unwrap(),
    ));
    initial_http.policy.lock().unwrap().take();
    owner
}

async fn empty_sqlite_owner(
    client_platform: ClientPlatform,
    http: Arc<dyn crate::http_transport::SerializedHttpExecutor>,
    clock: Arc<dyn Clock>,
) -> SqliteOwner {
    let path = std::env::temp_dir().join(format!(
        "bittery-native-authority-{}.sqlite",
        bittery_crypto_core::generate_uuid()
    ));
    let replica = Arc::new(crate::SqliteReplica::open(&path).unwrap());
    let platform = Arc::new(InstallationPlatform::default());
    let runtime = Runtime::with_persistence(
        replica,
        Arc::new(PlatformStorage::for_platform(
            platform.clone(),
            client_platform,
        )),
        Arc::new(HttpTransport::new(http)),
        Some(AuthClientConfig::new("native-test".into(), client_platform, "test".into()).unwrap()),
        None,
        false,
        clock,
        Arc::new(SystemDeviceTimer),
        None,
    );
    runtime.open().await.unwrap();
    SqliteOwner {
        runtime,
        platform,
        path,
    }
}

async fn native_control(
    control: &crate::NativeAuthorityFacade,
    request: crate::NativeAuthorityRequest,
) -> crate::NativeAuthorityResponse {
    let encoded = Zeroizing::new(serde_json::to_string(&request).unwrap());
    let response = control.invoke(encoded).await.unwrap();
    serde_json::from_str(&response).unwrap()
}

#[tokio::test]
async fn existing_account_transfer_preserves_independent_session_and_pending_sqlite_work() {
    let source = sqlite_owner("desktop-S2", ClientPlatform::Desktop).await;
    let destination = sqlite_owner("standalone-S1", ClientPlatform::Extension).await;
    let account = AccountId::from("account-1");
    let incarnation = Incarnation::from("generation-1");
    let independent = destination
        .runtime
        .platform_storage
        .load_current_session(&account, &incarnation)
        .await
        .unwrap()
        .unwrap();
    let original_bytes = serde_json::to_string(&independent).unwrap();
    destination
        .runtime
        .install_biometric_port(Arc::new(AvailableBiometry));
    destination
        .runtime
        .request(
            RuntimeRequest::SetBiometricEnabled {
                account_id: account.clone(),
                enabled: true,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let snapshot = destination.runtime.require_snapshot(&account).unwrap();
    let pending = crate::test_fixtures::test_operation("accepted-before-transfer", "pending-item");
    let result = destination
        .runtime
        .replica
        .execute_recomputing(GuardedCommitPlan::new(
            account.clone(),
            incarnation.clone(),
            snapshot.revision,
            snapshot.lock_epoch,
            vec![PlanMutation::AcceptOperation(pending.clone())],
        ))
        .await
        .unwrap();
    assert!(matches!(result, RecomputedPlanResult::Applied { .. }));
    let source_control = source.runtime.native_authority();
    let destination_control = destination.runtime.native_authority();
    let crate::NativeAuthorityResponse::Source {
        snapshot: authority,
    } = native_control(
        &source_control,
        crate::NativeAuthorityRequest::AttachSource {
            extension_id: "allowed-extension".into(),
            transport_id: "source-port".into(),
        },
    )
    .await
    else {
        panic!("unexpected native source response")
    };
    let crate::NativeAuthorityResponse::Attached {
        channel_id: channel,
    } = native_control(
        &destination_control,
        crate::NativeAuthorityRequest::AttachDesktop {
            source: authority,
            transport_id: "destination-port".into(),
        },
    )
    .await
    else {
        panic!("unexpected native attachment response")
    };
    let crate::NativeAuthorityResponse::Prepared { challenge } = native_control(
        &destination_control,
        crate::NativeAuthorityRequest::PrepareImportForSource {
            channel_id: channel.clone(),
            source_account: account.clone(),
            insecure_transport_confirmed: false,
        },
    )
    .await
    else {
        panic!("unexpected native preparation response")
    };
    let crate::NativeAuthorityResponse::Exported { reply } = native_control(
        &source_control,
        crate::NativeAuthorityRequest::Export { challenge },
    )
    .await
    else {
        panic!("unexpected native export response")
    };
    let replay = reply.clone();
    assert!(matches!(
        native_control(
            &destination_control,
            crate::NativeAuthorityRequest::CompleteImport { reply }
        )
        .await,
        crate::NativeAuthorityResponse::Applied
    ));
    assert!(destination_control.complete_import(replay).await.is_err());
    let effective = destination
        .runtime
        .effective_session(&account, &incarnation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(effective.token.as_ref(), "desktop-S2");
    assert!(
        destination
            .runtime
            .effective_session(&account, &Incarnation::from("retired-generation"))
            .await
            .is_err(),
        "stale work cannot borrow replacement generation credentials"
    );
    assert!(matches!(
        effective.provenance,
        crate::platform_storage::SessionProvenance::Borrowed { .. }
    ));
    let renewed = destination
        .runtime
        .store_renewed_effective_session(
            &effective,
            crate::server_contract::RefreshSessionResponse {
                token: "desktop-S2-renewed".into(),
                session_id: "S2-renewed".into(),
                expires_at: "2030-01-02T00:00:00Z".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(renewed.token.as_ref(), "desktop-S2-renewed");
    assert_eq!(
        destination
            .runtime
            .effective_session(&account, &incarnation)
            .await
            .unwrap()
            .unwrap()
            .token
            .as_ref(),
        "desktop-S2-renewed"
    );
    let mut invalid_replacement = renewed.clone();
    invalid_replacement.provenance = crate::platform_storage::SessionProvenance::Independent;
    assert!(destination
        .runtime
        .replace_borrowed_session(&renewed, invalid_replacement)
        .is_err());
    let mut invalid_replacement = renewed.clone();
    invalid_replacement.account_id = AccountId::from("another-account");
    assert!(destination
        .runtime
        .replace_borrowed_session(&renewed, invalid_replacement)
        .is_err());
    let mut invalid_replacement = renewed.clone();
    invalid_replacement.incarnation = Incarnation::from("replacement-generation");
    assert!(destination
        .runtime
        .replace_borrowed_session(&renewed, invalid_replacement)
        .is_err());
    assert!(!renewed.vault_keys.is_empty());
    let mut pruned = renewed.clone();
    pruned.vault_keys.clear();
    destination
        .runtime
        .replace_borrowed_session(&renewed, pruned)
        .unwrap();
    let stale_refresh = destination
        .runtime
        .store_renewed_effective_session(
            &renewed,
            crate::server_contract::RefreshSessionResponse {
                token: "late-desktop-S2-refresh".into(),
                session_id: "late-S2".into(),
                expires_at: "2030-01-03T00:00:00Z".into(),
            },
        )
        .await;
    assert_eq!(
        stale_refresh.err().unwrap().code,
        RuntimeErrorCode::Cancelled
    );
    assert!(
        destination
            .runtime
            .effective_session(&account, &incarnation)
            .await
            .unwrap()
            .unwrap()
            .vault_keys
            .is_empty(),
        "a stale network clone cannot restore pruned borrowed Vault keys"
    );
    let stored = destination
        .runtime
        .platform_storage
        .load_current_session(&account, &incarnation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(serde_json::to_string(&stored).unwrap(), original_bytes);
    assert_eq!(
        destination
            .runtime
            .require_snapshot(&account)
            .unwrap()
            .operations,
        vec![pending.clone()]
    );
    destination_control.retire_channel(&channel).await.unwrap();
    assert_eq!(
        destination
            .runtime
            .account_access
            .lock()
            .unwrap()
            .get(&account),
        Some(&AccountAccessState::Locked)
    );
    assert!(destination
        .runtime
        .effective_session(&account, &incarnation)
        .await
        .unwrap()
        .is_none());
    let unlock = destination
        .runtime
        .request(
            RuntimeRequest::BiometricUnlock {
                account_id: account.clone(),
                prompt_message: "Unlock test account".into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let RuntimeResponse::BiometricUnlock { accounts } = unlock else {
        panic!("unexpected unlock response")
    };
    assert_eq!(accounts.len(), 1);
    assert_eq!(accounts[0].failure, None);
    let standalone = destination
        .runtime
        .effective_session(&account, &incarnation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(standalone.token.as_ref(), "standalone-S1");
    assert_eq!(serde_json::to_string(&standalone).unwrap(), original_bytes);
    assert_eq!(
        destination
            .runtime
            .require_snapshot(&account)
            .unwrap()
            .operations,
        vec![pending]
    );
    let reopened = crate::SqliteReplica::open(&destination.path).unwrap();
    let durable = crate::replica::Replica::new(Arc::new(reopened))
        .load(&account)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(durable.operations.len(), 1);
    source.runtime.close().await;
    destination.runtime.close().await;
    assert!(!destination.platform.values.lock().unwrap().is_empty());
}

#[tokio::test]
async fn retained_native_reply_loses_final_encoding_to_source_lock() {
    let source = sqlite_owner("desktop-S2", ClientPlatform::Desktop).await;
    let destination = sqlite_owner("standalone-S1", ClientPlatform::Extension).await;
    let source_control = source.runtime.native_authority();
    let destination_control = destination.runtime.native_authority();
    let source_channel = source_control
        .attach_source("allowed-extension".into(), "source-port".into())
        .unwrap();
    let channel = destination_control
        .attach_desktop(source_channel, "destination-port".into())
        .await
        .unwrap();
    let account = AccountId::from("account-1");
    let challenge = destination_control
        .prepare_import(&channel, &account, &account)
        .await
        .unwrap();
    let reply = source_control.export(challenge).await.unwrap();
    source
        .runtime
        .request(
            RuntimeRequest::Lock {
                account_id: account,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert!(
        source_control.encode_reply(reply).is_err(),
        "retained export must lose final delivery to source Lock"
    );
}

#[tokio::test]
async fn native_import_refuses_unverified_offline_travel_without_publishing_keys() {
    let source = sqlite_owner("desktop-S2", ClientPlatform::Desktop).await;
    let destination = sqlite_owner("standalone-S1", ClientPlatform::Extension).await;
    let account = AccountId::from("account-1");
    let incarnation = Incarnation::from("generation-1");
    let mut metadata = destination
        .runtime
        .platform_storage
        .load_account_metadata(&account, &incarnation)
        .await
        .unwrap()
        .unwrap();
    metadata.verified_travel_mode = None;
    destination
        .runtime
        .platform_storage
        .store_account_metadata(&metadata)
        .await
        .unwrap();
    let source_control = source.runtime.native_authority();
    let destination_control = destination.runtime.native_authority();
    let authority = source_control
        .attach_source("allowed-extension".into(), "source-port".into())
        .unwrap();
    let channel = destination_control
        .attach_desktop(authority, "destination-port".into())
        .await
        .unwrap();
    let challenge = destination_control
        .prepare_import(&channel, &account, &account)
        .await
        .unwrap();
    let reply = source_control.export(challenge).await.unwrap();
    assert!(
        destination_control.complete_import(reply).await.is_err(),
        "offline import cannot invent verified Travel authority"
    );
    assert!(destination
        .runtime
        .copy_live_master_unlock_key(&account, &incarnation)
        .is_none());
    assert_eq!(
        destination
            .runtime
            .account_access
            .lock()
            .unwrap()
            .get(&account),
        Some(&AccountAccessState::Locked)
    );
}

#[derive(Default)]
struct HeldTravel {
    hold: std::sync::atomic::AtomicBool,
    entered: tokio::sync::Notify,
    release: tokio::sync::Notify,
}
#[async_trait]
impl crate::http_transport::SerializedHttpExecutor for HeldTravel {
    async fn invoke(&self, request: zeroize::Zeroizing<String>) -> Result<String, RuntimeError> {
        let request: serde_json::Value = serde_json::from_str(&request).unwrap();
        if request["url"]
            .as_str()
            .is_some_and(|url| url.ends_with("/travel-mode"))
            && self.hold.load(std::sync::atomic::Ordering::SeqCst)
        {
            self.entered.notify_one();
            self.release.notified().await;
            Ok(routing_completed(
                200,
                serde_json::json!({ "enabled": false, "enabledAt": null, "hiddenVaultIds": [], "updatedAt": "2023-11-14T22:13:20Z" }),
            ))
        } else {
            Ok(serde_json::json!({ "type": "networkFailure" }).to_string())
        }
    }
    fn cancel(&self, _: &str) {
        self.release.notify_one();
    }
}

#[tokio::test]
async fn fresh_native_travel_preserves_preferences_changed_while_http_waits() {
    let source = sqlite_owner("desktop-S2", ClientPlatform::Desktop).await;
    let http = Arc::new(HeldTravel::default());
    let destination =
        sqlite_owner_with_http("standalone-S1", ClientPlatform::Extension, http.clone()).await;
    let account = AccountId::from("account-1");
    let incarnation = Incarnation::from("generation-1");
    destination
        .runtime
        .install_biometric_port(Arc::new(AvailableBiometry));
    destination
        .runtime
        .request(
            RuntimeRequest::SetBiometricEnabled {
                account_id: account.clone(),
                enabled: true,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let source_control = source.runtime.native_authority();
    let destination_control = destination.runtime.native_authority();
    let authority = source_control
        .attach_source("allowed-extension".into(), "source-port".into())
        .unwrap();
    let channel = destination_control
        .attach_desktop(authority, "destination-port".into())
        .await
        .unwrap();
    let challenge = destination_control
        .prepare_import(&channel, &account, &account)
        .await
        .unwrap();
    let reply = source_control.export(challenge).await.unwrap();
    http.hold.store(true, std::sync::atomic::Ordering::SeqCst);
    let import = destination_control.complete_import(reply);
    tokio::pin!(import);
    tokio::select! { _ = http.entered.notified() => {}, result = &mut import => panic!("import completed before held Travel: {}", result.is_ok()) }
    destination
        .runtime
        .request(
            RuntimeRequest::SetBiometricEnabled {
                account_id: account.clone(),
                enabled: false,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    http.release.notify_one();
    import.await.unwrap();
    let metadata = destination
        .runtime
        .platform_storage
        .load_account_metadata(&account, &incarnation)
        .await
        .unwrap()
        .unwrap();
    assert!(
        !metadata.biometric_enabled,
        "Travel must update only the latest metadata policy"
    );
}

#[tokio::test]
async fn native_channel_and_destination_generation_retire_delayed_replies() {
    let source = sqlite_owner("desktop-S2", ClientPlatform::Desktop).await;
    let destination = sqlite_owner("standalone-S1", ClientPlatform::Extension).await;
    let account = AccountId::from("account-1");
    let source_control = source.runtime.native_authority();
    let destination_control = destination.runtime.native_authority();
    let authority = source_control
        .attach_source("allowed-extension".into(), "source-port".into())
        .unwrap();
    let source_channel = authority.channel_id.clone();
    let channel = destination_control
        .attach_desktop(authority, "destination-port".into())
        .await
        .unwrap();
    let before = destination.runtime.require_snapshot(&account).unwrap();
    assert!(destination_control
        .prepare_import("unknown-channel", &account, &account)
        .await
        .is_err());
    assert_eq!(
        destination
            .runtime
            .require_snapshot(&account)
            .unwrap()
            .lock_epoch,
        before.lock_epoch
    );
    assert_eq!(
        destination
            .runtime
            .account_access
            .lock()
            .unwrap()
            .get(&account),
        Some(&AccountAccessState::Unlocked)
    );
    let challenge = destination_control
        .prepare_import(&channel, &account, &account)
        .await
        .unwrap();
    let reply = source_control.export(challenge).await.unwrap();
    source_control
        .retire_channel(&source_channel)
        .await
        .unwrap();
    assert!(source_control.encode_reply(reply.clone()).is_err());
    destination
        .runtime
        .request(
            RuntimeRequest::Lock {
                account_id: account.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert!(destination_control.complete_import(reply).await.is_err());
    assert!(destination
        .runtime
        .copy_live_master_unlock_key(&account, &before.incarnation)
        .is_none());
}

#[tokio::test]
async fn native_source_state_lock_retires_independent_destination_and_old_events_cannot_return() {
    let source = sqlite_owner("desktop-S2", ClientPlatform::Desktop).await;
    let destination = sqlite_owner("standalone-S1", ClientPlatform::Extension).await;
    let account = AccountId::from("account-1");
    let source_control = source.runtime.native_authority();
    let destination_control = destination.runtime.native_authority();
    source
        .runtime
        .request(
            RuntimeRequest::Lock {
                account_id: account.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let old = source_control
        .attach_source("allowed-extension".into(), "source-port".into())
        .unwrap();
    let old_channel = destination_control
        .attach_desktop(old.clone(), "destination-port".into())
        .await
        .unwrap();
    assert_eq!(
        destination
            .runtime
            .account_access
            .lock()
            .unwrap()
            .get(&account),
        Some(&AccountAccessState::Locked)
    );
    assert!(destination
        .runtime
        .require_native_local_unlock_allowed(&account)
        .is_err());
    assert!(
        destination
            .runtime
            .effective_session(&account, &Incarnation::from("generation-1"))
            .await
            .unwrap()
            .is_none(),
        "reachable Desktop lock must suspend independent network authority"
    );
    let replacement = source_control
        .attach_source("allowed-extension".into(), "replacement-source-port".into())
        .unwrap();
    let new_channel = destination_control
        .attach_desktop(replacement, "replacement-destination-port".into())
        .await
        .unwrap();
    assert!(destination_control
        .apply_authority(&old_channel, old.clone())
        .await
        .is_err());
    assert!(destination_control
        .apply_authority(&new_channel, old)
        .await
        .is_err());
    destination_control
        .retire_channel(&old_channel)
        .await
        .unwrap();
    assert!(destination
        .runtime
        .require_native_local_unlock_allowed(&account)
        .is_err());
    destination_control
        .retire_channel(&new_channel)
        .await
        .unwrap();
    assert!(destination
        .runtime
        .require_native_local_unlock_allowed(&account)
        .is_ok());
}

struct NativeClock(std::sync::atomic::AtomicU64);
impl Clock for NativeClock {
    fn now_ms(&self) -> Result<u64, RuntimeError> {
        Ok(self.0.load(std::sync::atomic::Ordering::SeqCst))
    }
}
#[tokio::test]
async fn native_session_expiry_during_travel_cannot_publish_keys() {
    let source = sqlite_owner("desktop-S2", ClientPlatform::Desktop).await;
    let http = Arc::new(HeldTravel::default());
    let clock = Arc::new(NativeClock(std::sync::atomic::AtomicU64::new(NOW_MS)));
    let destination = sqlite_owner_with_clock(
        "standalone-S1",
        ClientPlatform::Extension,
        http.clone(),
        clock.clone(),
    )
    .await;
    let account = AccountId::from("account-1");
    let source_control = source.runtime.native_authority();
    let destination_control = destination.runtime.native_authority();
    let authority = source_control
        .attach_source("allowed-extension".into(), "source-port".into())
        .unwrap();
    let channel = destination_control
        .attach_desktop(authority, "destination-port".into())
        .await
        .unwrap();
    let challenge = destination_control
        .prepare_import(&channel, &account, &account)
        .await
        .unwrap();
    let reply = source_control.export(challenge).await.unwrap();
    http.hold.store(true, std::sync::atomic::Ordering::SeqCst);
    let import = destination_control.complete_import(reply);
    tokio::pin!(import);
    tokio::select! { _ = http.entered.notified() => {}, result = &mut import => panic!("import completed before held Travel: {}", result.is_ok()) }
    clock
        .0
        .store(u64::MAX - 1, std::sync::atomic::Ordering::SeqCst);
    http.release.notify_one();
    assert!(
        import.await.is_err(),
        "expired borrowed Session cannot publish live access"
    );
    assert!(destination
        .runtime
        .copy_live_master_unlock_key(&account, &Incarnation::from("generation-1"))
        .is_none());
}

#[tokio::test]
async fn pending_native_import_suspends_only_its_destination_and_rejects_cross_account_identity() {
    let source = sqlite_owner("desktop-S2", ClientPlatform::Desktop).await;
    let destination = sqlite_owner("standalone-S1", ClientPlatform::Extension).await;
    install(
        &destination.runtime,
        "another-user",
        &FixedEntropy::new(&["another-account", "another-generation"]),
    )
    .await
    .unwrap();
    let account = AccountId::from("account-1");
    let other = AccountId::from("another-account");
    let source_control = source.runtime.native_authority();
    let destination_control = destination.runtime.native_authority();
    let authority = source_control
        .attach_source("allowed-extension".into(), "source-port".into())
        .unwrap();
    let channel = destination_control
        .attach_desktop(authority, "destination-port".into())
        .await
        .unwrap();
    assert!(destination_control
        .prepare_import(&channel, &account, &other)
        .await
        .is_err());
    let challenge = destination_control
        .prepare_import(&channel, &account, &account)
        .await
        .unwrap();
    assert!(
        destination
            .runtime
            .effective_session(&account, &Incarnation::from("generation-1"))
            .await
            .unwrap()
            .is_none(),
        "pending import cannot silently resume independent S1"
    );
    assert!(destination
        .runtime
        .copy_live_master_unlock_key(&other, &Incarnation::from("another-generation"))
        .is_some());
    let reply = source_control.export(challenge).await.unwrap();
    destination_control.complete_import(reply).await.unwrap();
    destination_control.retire_channel(&channel).await.unwrap();
    assert!(destination
        .runtime
        .copy_live_master_unlock_key(&other, &Incarnation::from("another-generation"))
        .is_some());
}

#[tokio::test]
async fn concurrent_desktop_reattachment_leaves_one_current_channel() {
    let source = sqlite_owner("desktop-S2", ClientPlatform::Desktop).await;
    let destination = sqlite_owner("standalone-S1", ClientPlatform::Extension).await;
    let account = AccountId::from("account-1");
    let source_control = source.runtime.native_authority();
    let destination_control = destination.runtime.native_authority();
    let initial = source_control
        .attach_source("allowed-extension".into(), "source-1".into())
        .unwrap();
    let initial_channel = destination_control
        .attach_desktop(initial, "destination-1".into())
        .await
        .unwrap();
    let challenge = destination_control
        .prepare_import(&initial_channel, &account, &account)
        .await
        .unwrap();
    destination_control
        .complete_import(source_control.export(challenge).await.unwrap())
        .await
        .unwrap();
    let second = source_control
        .attach_source("allowed-extension".into(), "source-2".into())
        .unwrap();
    let third = source_control
        .attach_source("allowed-extension".into(), "source-3".into())
        .unwrap();
    let execution = destination
        .runtime
        .account_execution_lock(&account)
        .unwrap();
    let held = execution.lock().await;
    let first_attach = destination_control.attach_desktop(second, "destination-2".into());
    let second_attach = destination_control.attach_desktop(third.clone(), "destination-3".into());
    tokio::pin!(first_attach, second_attach);
    std::future::poll_fn(|cx| {
        assert!(std::future::Future::poll(first_attach.as_mut(), cx).is_pending());
        assert!(std::future::Future::poll(second_attach.as_mut(), cx).is_pending());
        std::task::Poll::Ready(())
    })
    .await;
    drop(held);
    let retired_channel = first_attach.await.unwrap();
    let current_channel = second_attach.await.unwrap();
    assert!(
        destination_control
            .prepare_import(&retired_channel, &account, &account)
            .await
            .is_err(),
        "concurrent attachment must retire the earlier channel"
    );
    destination_control
        .apply_authority(&current_channel, third)
        .await
        .unwrap();
}

#[tokio::test]
async fn offline_native_import_cannot_ignore_source_verified_travel_authority() {
    let source = sqlite_owner("desktop-S2", ClientPlatform::Desktop).await;
    let destination = sqlite_owner("standalone-S1", ClientPlatform::Extension).await;
    let account = AccountId::from("account-1");
    let incarnation = Incarnation::from("generation-1");
    let mut metadata = destination
        .runtime
        .platform_storage
        .load_account_metadata(&account, &incarnation)
        .await
        .unwrap()
        .unwrap();
    metadata.verified_travel_mode.as_mut().unwrap().enabled = false;
    metadata
        .verified_travel_mode
        .as_mut()
        .unwrap()
        .server_enabled_at_ms = None;
    metadata
        .verified_travel_mode
        .as_mut()
        .unwrap()
        .hidden_vault_ids
        .clear();
    destination
        .runtime
        .platform_storage
        .store_account_metadata(&metadata)
        .await
        .unwrap();
    let source_control = source.runtime.native_authority();
    let destination_control = destination.runtime.native_authority();
    let authority = source_control
        .attach_source("allowed-extension".into(), "source-port".into())
        .unwrap();
    let channel = destination_control
        .attach_desktop(authority, "destination-port".into())
        .await
        .unwrap();
    let challenge = destination_control
        .prepare_import(&channel, &account, &account)
        .await
        .unwrap();
    let reply = source_control.export(challenge).await.unwrap();
    assert!(
        destination_control.complete_import(reply).await.is_err(),
        "offline destination policy cannot bypass source verified Travel authority"
    );
    assert!(destination
        .runtime
        .copy_live_master_unlock_key(&account, &incarnation)
        .is_none());
}

#[tokio::test]
async fn destination_teardown_releases_borrowed_session_without_touching_source_credentials() {
    let source = sqlite_owner("desktop-S2", ClientPlatform::Desktop).await;
    let destination = sqlite_owner("standalone-S1", ClientPlatform::Extension).await;
    let account = AccountId::from("account-1");
    let incarnation = Incarnation::from("generation-1");
    let source_session = source
        .runtime
        .platform_storage
        .load_current_session(&account, &incarnation)
        .await
        .unwrap()
        .unwrap();
    let source_bytes = serde_json::to_string(&source_session).unwrap();
    let source_control = source.runtime.native_authority();
    let destination_control = destination.runtime.native_authority();
    let authority = source_control
        .attach_source("allowed-extension".into(), "source-port".into())
        .unwrap();
    let channel = destination_control
        .attach_desktop(authority, "destination-port".into())
        .await
        .unwrap();
    let challenge = destination_control
        .prepare_import(&channel, &account, &account)
        .await
        .unwrap();
    destination_control
        .complete_import(source_control.export(challenge).await.unwrap())
        .await
        .unwrap();
    assert!(destination
        .runtime
        .native_authority
        .has_borrowed_session(&account));
    let lifecycle = destination
        .runtime
        .account_lifecycle_lock(&account)
        .unwrap();
    let held = lifecycle.lock().await;
    let remove = destination.runtime.request(
        RuntimeRequest::RemoveAccount {
            account_id: account.clone(),
        },
        RequestCancellation::new(),
    );
    tokio::pin!(remove);
    std::future::poll_fn(|cx| {
        assert!(std::future::Future::poll(remove.as_mut(), cx).is_pending());
        std::task::Poll::Ready(())
    })
    .await;
    assert!(
        !destination
            .runtime
            .native_authority
            .has_borrowed_session(&account),
        "teardown intent must release borrowed credentials before waiting for lifecycle drain"
    );
    drop(held);
    let response = remove.await.unwrap();
    assert!(matches!(response, RuntimeResponse::Teardown { .. }));
    assert!(destination.runtime.replica.snapshot(&account).is_none());
    let current_source = source
        .runtime
        .platform_storage
        .load_current_session(&account, &incarnation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::to_string(&current_source).unwrap(),
        source_bytes
    );
    assert!(source
        .runtime
        .copy_live_master_unlock_key(&account, &incarnation)
        .is_some());
}

#[tokio::test]
async fn native_retirement_intent_discards_borrowed_material_even_if_caller_drops_wait() {
    for source_lock in [false, true] {
        let source = sqlite_owner("desktop-S2", ClientPlatform::Desktop).await;
        let destination = sqlite_owner("standalone-S1", ClientPlatform::Extension).await;
        let account = AccountId::from("account-1");
        let incarnation = Incarnation::from("generation-1");
        let source_control = source.runtime.native_authority();
        let destination_control = destination.runtime.native_authority();
        let authority = source_control
            .attach_source("allowed-extension".into(), "source-port".into())
            .unwrap();
        let source_channel = authority.channel_id.clone();
        let channel = destination_control
            .attach_desktop(authority, "destination-port".into())
            .await
            .unwrap();
        let challenge = destination_control
            .prepare_import(&channel, &account, &account)
            .await
            .unwrap();
        destination_control
            .complete_import(source_control.export(challenge).await.unwrap())
            .await
            .unwrap();
        source
            .runtime
            .request(
                RuntimeRequest::Lock {
                    account_id: account.clone(),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap();
        let locked_source = source_control.source_snapshot(&source_channel).unwrap();
        let execution = destination
            .runtime
            .account_execution_lock(&account)
            .unwrap();
        let held = execution.lock().await;
        let mut retiring: std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<(), RuntimeError>>>,
        > = if source_lock {
            Box::pin(destination_control.apply_authority(&channel, locked_source))
        } else {
            Box::pin(destination_control.retire_channel(&channel))
        };
        std::future::poll_fn(|cx| {
            assert!(std::future::Future::poll(retiring.as_mut(), cx).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
        assert!(
            !destination
                .runtime
                .native_authority
                .has_borrowed_session(&account),
            "retirement intent must discard borrowed S2 before waiting for execution"
        );
        drop(retiring);
        assert!(!destination
            .runtime
            .native_authority
            .has_borrowed_session(&account));
        assert!(
            destination
                .runtime
                .copy_live_master_unlock_key(&account, &incarnation)
                .is_none(),
            "dropped native retirement cannot keep live keys or plaintext authority"
        );
        let snapshot = destination.runtime.require_snapshot(&account).unwrap();
        assert!(
            destination
                .runtime
                .publish_account_unlock(&snapshot, Zeroizing::new([0; 32]), None)
                .is_err(),
            "pending native retirement must reject a previously prepared key publication"
        );
        let driver = tokio::spawn(destination.runtime.clone().run_operation_dispatch());
        drop(held);
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while destination
                .runtime
                .lock_epoch_pending
                .lock()
                .unwrap()
                .contains_key(&account)
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("surviving Core driver must complete abandoned retirement");
        assert_eq!(
            destination
                .runtime
                .account_access
                .lock()
                .unwrap()
                .get(&account),
            Some(&AccountAccessState::Locked)
        );
        source.runtime.close().await;
        destination.runtime.close().await;
        driver.await.unwrap();
    }
}

#[tokio::test]
async fn later_native_retirement_progresses_while_another_account_is_still_draining() {
    let initial_policy = Arc::new(InitialNativePolicyHttp {
        policy: Mutex::new(Some(verified("another-user").travel_mode)),
        scenario: Arc::new(OfflineNativeHttp),
    });
    let source = sqlite_owner_with_http(
        "desktop-S2",
        ClientPlatform::Desktop,
        initial_policy.clone(),
    )
    .await;
    let destination = sqlite_owner_with_http(
        "standalone-S1",
        ClientPlatform::Extension,
        initial_policy.clone(),
    )
    .await;
    for runtime in [&source.runtime, &destination.runtime] {
        install(
            runtime,
            "another-user",
            &FixedEntropy::new(&["another-account", "another-generation"]),
        )
        .await
        .unwrap();
        let response = runtime
            .request(
                RuntimeRequest::RefreshTravelMode {
                    account_id: AccountId::from("another-account"),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap();
        assert!(matches!(response, RuntimeResponse::TravelMode {
            account_id, result: crate::TravelModeCommandResult::Confirmed { .. },
        } if account_id == AccountId::from("another-account")));
        let verified = runtime
            .replica
            .load_uncached(&AccountId::from("another-account"))
            .await
            .unwrap()
            .unwrap();
        assert!(!verified.bootstrap.policy_verification_pending);
    }
    // The original retirement scenario is offline only after each installed Account has
    // completed its initial policy verification through the public command.
    initial_policy.policy.lock().unwrap().take();
    let first = AccountId::from("account-1");
    let second = AccountId::from("another-account");
    let source_control = source.runtime.native_authority();
    let destination_control = destination.runtime.native_authority();
    let authority = source_control
        .attach_source("allowed-extension".into(), "source-port".into())
        .unwrap();
    let source_channel = authority.channel_id.clone();
    let channel = destination_control
        .attach_desktop(authority, "destination-port".into())
        .await
        .unwrap();
    for account in [&first, &second] {
        let challenge = destination_control
            .prepare_import(&channel, account, account)
            .await
            .unwrap();
        destination_control
            .complete_import(source_control.export(challenge).await.unwrap())
            .await
            .unwrap();
    }
    let first_execution = destination.runtime.account_execution_lock(&first).unwrap();
    let second_execution = destination.runtime.account_execution_lock(&second).unwrap();
    let held_first = first_execution.lock().await;
    let held_second = second_execution.lock().await;
    source
        .runtime
        .request(
            RuntimeRequest::Lock {
                account_id: first.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let mut retiring_first = Box::pin(destination_control.apply_authority(
        &channel,
        source_control.source_snapshot(&source_channel).unwrap(),
    ));
    std::future::poll_fn(|cx| {
        assert!(std::future::Future::poll(retiring_first.as_mut(), cx).is_pending());
        std::task::Poll::Ready(())
    })
    .await;
    drop(retiring_first);
    let driver = tokio::spawn(destination.runtime.clone().run_operation_dispatch());
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while !destination
            .runtime
            .native_authority
            .retirement_is_running(&first)
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    source
        .runtime
        .request(
            RuntimeRequest::Lock {
                account_id: second.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let mut retiring_second = Box::pin(destination_control.apply_authority(
        &channel,
        source_control.source_snapshot(&source_channel).unwrap(),
    ));
    std::future::poll_fn(|cx| {
        assert!(std::future::Future::poll(retiring_second.as_mut(), cx).is_pending());
        std::task::Poll::Ready(())
    })
    .await;
    drop(retiring_second);
    drop(held_second);
    let second_finished = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while destination
            .runtime
            .lock_epoch_pending
            .lock()
            .unwrap()
            .contains_key(&second)
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .is_ok();
    drop(held_first);
    source.runtime.close().await;
    destination.runtime.close().await;
    driver.await.unwrap();
    assert!(
        second_finished,
        "a later Account must finish retirement while the first Account still holds its fence"
    );
}

#[tokio::test]
async fn delayed_native_authority_snapshot_cannot_replace_newer_channel_state() {
    let source = sqlite_owner("desktop-S2", ClientPlatform::Desktop).await;
    let destination = sqlite_owner("standalone-S1", ClientPlatform::Extension).await;
    let account = AccountId::from("account-1");
    let source_control = source.runtime.native_authority();
    let destination_control = destination.runtime.native_authority();
    let old = source_control
        .attach_source("allowed-extension".into(), "source-port".into())
        .unwrap();
    let channel = destination_control
        .attach_desktop(old.clone(), "destination-port".into())
        .await
        .unwrap();
    let newer = source_control.source_snapshot(&old.channel_id).unwrap();
    destination_control
        .apply_authority(&channel, newer)
        .await
        .unwrap();
    let challenge = destination_control
        .prepare_import(&channel, &account, &account)
        .await
        .unwrap();
    destination_control
        .complete_import(source_control.export(challenge).await.unwrap())
        .await
        .unwrap();
    assert!(
        destination_control
            .apply_authority(&channel, old)
            .await
            .is_err(),
        "delayed same-channel authority must be rejected before changing current grants"
    );
    assert!(destination
        .runtime
        .native_authority
        .has_borrowed_session(&account));
    source.runtime.close().await;
    destination.runtime.close().await;
}

#[tokio::test]
async fn explicit_native_biometric_gesture_reuses_local_session_without_password_sign_in() {
    let source = sqlite_owner("desktop-S2", ClientPlatform::Desktop).await;
    let destination = sqlite_owner("standalone-S1", ClientPlatform::Extension).await;
    let account = AccountId::from("account-1");
    let incarnation = Incarnation::from("generation-1");
    source
        .runtime
        .install_biometric_port(Arc::new(AvailableBiometry));
    let stored = source
        .runtime
        .platform_storage
        .load_current_session(&account, &incarnation)
        .await
        .unwrap()
        .unwrap();
    let before = serde_json::to_string(&stored).unwrap();
    source
        .runtime
        .request(
            RuntimeRequest::Lock {
                account_id: account.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let source_control = source.runtime.native_authority();
    let destination_control = destination.runtime.native_authority();
    let authority = source_control
        .attach_source("allowed-extension".into(), "source-port".into())
        .unwrap();
    let source_channel = authority.channel_id.clone();
    let channel = destination_control
        .attach_desktop(authority, "destination-port".into())
        .await
        .unwrap();
    let challenge = destination_control
        .prepare_import(&channel, &account, &account)
        .await
        .unwrap();
    assert!(
        source_control.export(challenge.clone()).await.is_err(),
        "ordinary native export cannot unlock Desktop"
    );
    assert!(matches!(
        native_control(
            &source_control,
            crate::NativeAuthorityRequest::ExportWithBiometric {
                challenge: challenge.clone(),
                prompt_message: "Unlock Bittery".into(),
            }
        )
        .await,
        crate::NativeAuthorityResponse::BiometricRefused {
            failure: crate::BiometricFailure::NotEnabled
        }
    ));
    assert!(source
        .runtime
        .copy_live_master_unlock_key(&account, &incarnation)
        .is_none());
    source
        .runtime
        .request(
            RuntimeRequest::SetBiometricEnabled {
                account_id: account.clone(),
                enabled: true,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let crate::NativeAuthorityResponse::Exported { reply } = native_control(
        &source_control,
        crate::NativeAuthorityRequest::ExportWithBiometric {
            challenge,
            prompt_message: "Unlock Bittery".into(),
        },
    )
    .await
    else {
        panic!("explicit local biometric gesture must release the requested Account")
    };
    destination_control
        .apply_authority(
            &channel,
            source_control.source_snapshot(&source_channel).unwrap(),
        )
        .await
        .unwrap();
    destination_control.complete_import(reply).await.unwrap();
    assert_eq!(
        destination
            .runtime
            .effective_session(&account, &incarnation)
            .await
            .unwrap()
            .unwrap()
            .token
            .as_ref(),
        "desktop-S2"
    );
    let stored = source
        .runtime
        .platform_storage
        .load_current_session(&account, &incarnation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::to_string(&stored).unwrap(),
        before,
        "native biometric export retains the same independent Session"
    );
    source.runtime.close().await;
    destination.runtime.close().await;
}

struct HeldNativeBiometry {
    entered: tokio::sync::Semaphore,
    active: AtomicBool,
}
struct NativePromptActive<'a>(&'a AtomicBool);
impl Drop for NativePromptActive<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
#[async_trait]
impl crate::BiometricPort for HeldNativeBiometry {
    async fn hardware(&self) -> Result<crate::BiometricHardware, RuntimeError> {
        AvailableBiometry.hardware().await
    }
    async fn authenticate(
        &self,
        _message: &str,
        cancellation: RequestCancellation,
    ) -> crate::BiometricPromptResult {
        self.active.store(true, Ordering::SeqCst);
        let _active = NativePromptActive(&self.active);
        self.entered.add_permits(1);
        cancellation.cancelled().await;
        crate::BiometricPromptResult::Cancelled
    }
}

#[tokio::test]
async fn native_source_channel_account_and_owner_loss_cancel_the_shared_biometric_ceremony() {
    for retirement in ["channel", "account", "owner", "caller"] {
        let source = sqlite_owner("desktop-S2", ClientPlatform::Desktop).await;
        let destination = sqlite_owner("standalone-S1", ClientPlatform::Extension).await;
        let account = AccountId::from("account-1");
        let port = Arc::new(HeldNativeBiometry {
            entered: tokio::sync::Semaphore::new(0),
            active: AtomicBool::new(false),
        });
        source.runtime.install_biometric_port(port.clone());
        source
            .runtime
            .request(
                RuntimeRequest::SetBiometricEnabled {
                    account_id: account.clone(),
                    enabled: true,
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap();
        source
            .runtime
            .request(
                RuntimeRequest::Lock {
                    account_id: account.clone(),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap();
        let source_control = source.runtime.native_authority();
        let destination_control = destination.runtime.native_authority();
        let authority = source_control
            .attach_source("allowed-extension".into(), "source-port".into())
            .unwrap();
        let source_channel = authority.channel_id.clone();
        let channel = destination_control
            .attach_desktop(authority, "destination-port".into())
            .await
            .unwrap();
        let challenge = destination_control
            .prepare_import(&channel, &account, &account)
            .await
            .unwrap();
        let task = tokio::spawn(async move {
            source_control
                .export_with_biometric(challenge, "Unlock Bittery".into())
                .await
        });
        let permit =
            tokio::time::timeout(std::time::Duration::from_secs(10), port.entered.acquire())
                .await
                .unwrap()
                .unwrap();
        permit.forget();
        match retirement {
            "channel" => source
                .runtime
                .native_authority()
                .retire_channel(&source_channel)
                .await
                .unwrap(),
            "account" => {
                source
                    .runtime
                    .request(
                        RuntimeRequest::Lock {
                            account_id: account.clone(),
                        },
                        RequestCancellation::new(),
                    )
                    .await
                    .unwrap();
            }
            "owner" => source.runtime.close().await,
            "caller" => task.abort(),
            _ => unreachable!(),
        }
        let result = tokio::time::timeout(std::time::Duration::from_secs(5), task)
            .await
            .unwrap();
        if retirement == "caller" {
            assert!(result.unwrap_err().is_cancelled());
        } else {
            assert!(
                result.unwrap().is_err(),
                "retired source ceremony cannot export material"
            );
        }
        assert!(!port.active.load(Ordering::SeqCst));
        assert!(source
            .runtime
            .copy_live_master_unlock_key(&account, &Incarnation::from("generation-1"))
            .is_none());
        assert!(!destination
            .runtime
            .native_authority
            .has_borrowed_session(&account));
        source.runtime.close().await;
        destination.runtime.close().await;
    }
}

#[tokio::test]
async fn native_source_key_authority_change_retires_old_replies_and_grants_without_desktop_lock() {
    let source = sqlite_owner("desktop-S2", ClientPlatform::Desktop).await;
    let destination = sqlite_owner("standalone-S1", ClientPlatform::Extension).await;
    let pending_destination = sqlite_owner("another-S1", ClientPlatform::Extension).await;
    let account = AccountId::from("account-1");
    let source_control = source.runtime.native_authority();
    let destination_control = destination.runtime.native_authority();
    let pending_control = pending_destination.runtime.native_authority();
    let authority = source_control
        .attach_source("allowed-extension".into(), "source-port".into())
        .unwrap();
    let source_channel = authority.channel_id.clone();
    let channel = destination_control
        .attach_desktop(authority.clone(), "destination-port".into())
        .await
        .unwrap();
    let pending_channel = pending_control
        .attach_desktop(authority, "pending-port".into())
        .await
        .unwrap();
    let challenge = destination_control
        .prepare_import(&channel, &account, &account)
        .await
        .unwrap();
    destination_control
        .complete_import(source_control.export(challenge).await.unwrap())
        .await
        .unwrap();
    let pending = pending_control
        .prepare_import(&pending_channel, &account, &account)
        .await
        .unwrap();
    let retained_reply = source_control.export(pending).await.unwrap();
    let snapshot = source.runtime.require_snapshot(&account).unwrap();
    source
        .runtime
        .advance_native_retirement_authority(&snapshot, &[])
        .unwrap();
    assert!(
        source_control.encode_reply(retained_reply.clone()).is_err(),
        "old key authority must fail final encoding even without a Desktop Lock"
    );
    assert!(source.runtime.generation_is_preparation_eligible(&snapshot));
    assert_eq!(
        source
            .runtime
            .require_snapshot(&account)
            .unwrap()
            .lock_epoch,
        snapshot.lock_epoch
    );
    let changed = source_control.source_snapshot(&source_channel).unwrap();
    destination_control
        .apply_authority(&channel, changed.clone())
        .await
        .unwrap();
    pending_control
        .apply_authority(&pending_channel, changed)
        .await
        .unwrap();
    assert!(!destination
        .runtime
        .native_authority
        .has_borrowed_session(&account));
    assert!(pending_control
        .complete_import(retained_reply)
        .await
        .is_err());
    assert!(
        destination
            .runtime
            .effective_session(&account, &Incarnation::from("generation-1"))
            .await
            .unwrap()
            .is_none(),
        "source key retirement cannot fall back to dormant S1"
    );
    source
        .runtime
        .advance_native_retirement_authority(&snapshot, &[])
        .unwrap();
    destination_control
        .apply_authority(
            &channel,
            source_control.source_snapshot(&source_channel).unwrap(),
        )
        .await
        .unwrap();
    let challenge = destination_control
        .prepare_import(&channel, &account, &account)
        .await
        .unwrap();
    destination_control
        .complete_import(source_control.export(challenge).await.unwrap())
        .await
        .unwrap();
    destination_control
        .apply_authority(
            &channel,
            source_control.source_snapshot(&source_channel).unwrap(),
        )
        .await
        .unwrap();
    assert!(
        destination
            .runtime
            .native_authority
            .has_borrowed_session(&account),
        "ordinary newer snapshots do not replace still-valid key authority"
    );
    source.runtime.close().await;
    destination.runtime.close().await;
    pending_destination.runtime.close().await;
}

#[tokio::test]
async fn native_export_and_retained_encoding_refuse_the_durable_vault_cleanup_journal() {
    let source = sqlite_owner("desktop-S2", ClientPlatform::Desktop).await;
    let destination = sqlite_owner("standalone-S1", ClientPlatform::Extension).await;
    let account = AccountId::from("account-1");
    let source_control = source.runtime.native_authority();
    let destination_control = destination.runtime.native_authority();
    let authority = source_control
        .attach_source("allowed-extension".into(), "source-port".into())
        .unwrap();
    let source_channel = authority.channel_id.clone();
    let channel = destination_control
        .attach_desktop(authority, "destination-port".into())
        .await
        .unwrap();
    let challenge = destination_control
        .prepare_import(&channel, &account, &account)
        .await
        .unwrap();
    let retained = source_control.export(challenge.clone()).await.unwrap();
    let snapshot = source.runtime.require_snapshot(&account).unwrap();
    let result = source
        .runtime
        .replica
        .execute_exact(GuardedCommitPlan::new(
            account.clone(),
            snapshot.incarnation.clone(),
            snapshot.revision,
            snapshot.lock_epoch,
            vec![PlanMutation::RetireVaults {
                vault_ids: vec!["visible".into()],
            }],
        ))
        .await
        .unwrap();
    assert!(matches!(result, crate::replica::PlanResult::Applied { .. }));
    assert_eq!(
        source
            .runtime
            .require_snapshot(&account)
            .unwrap()
            .bootstrap
            .pending_vault_retirements,
        vec!["visible"]
    );
    let unavailable = source_control.source_snapshot(&source_channel).unwrap();
    let source_account = unavailable
        .accounts
        .iter()
        .find(|entry| entry.scope.account_id == account)
        .unwrap();
    assert!(
        source_account.unlocked,
        "Vault cleanup does not claim Desktop is locked"
    );
    assert!(!source_account.key_authorization_available);
    assert!(
        source_control.encode_reply(retained).is_err(),
        "durable cleanup must fence retained encoding before the native generation hook runs"
    );
    assert!(
        source_control.export(challenge).await.is_err(),
        "pending cleanup has no exportable key authority"
    );
    source.runtime.close().await;
    destination.runtime.close().await;
}

#[tokio::test]
async fn source_based_import_reserves_a_new_account_without_persisting_borrowed_credentials() {
    let source = sqlite_owner("desktop-S2", ClientPlatform::Desktop).await;
    let destination = empty_sqlite_owner(
        ClientPlatform::Extension,
        Arc::new(OfflineNativeHttp),
        Arc::new(FixedClock(NOW_MS)),
    )
    .await;
    assert!(destination
        .runtime
        .platform_storage
        .load_device_key()
        .await
        .unwrap()
        .is_none());
    let source_control = source.runtime.native_authority();
    let destination_control = destination.runtime.native_authority();
    let authority = source_control
        .attach_source("allowed-extension".into(), "source-port".into())
        .unwrap();
    let channel = destination_control
        .attach_desktop(authority, "destination-port".into())
        .await
        .unwrap();
    let challenge = destination_control
        .prepare_import_for_source(&channel, &AccountId::from("account-1"), false)
        .await
        .unwrap();
    assert!(
        destination_control
            .prepare_import_for_source(&channel, &AccountId::from("account-1"), false)
            .await
            .is_err(),
        "duplicate pending identity must not reserve another Account"
    );
    assert!(
        destination.runtime.replica.snapshots().is_empty(),
        "a preparation reserves identity without installing an Account"
    );
    let account = challenge.destination.account_id.clone();
    let incarnation = challenge.destination.incarnation.clone();
    assert_ne!(account, AccountId::from("account-1"));
    destination_control
        .complete_import(source_control.export(challenge).await.unwrap())
        .await
        .unwrap();
    assert_eq!(
        destination
            .runtime
            .account_access
            .lock()
            .unwrap()
            .get(&account),
        Some(&AccountAccessState::Unlocked)
    );
    assert!(destination
        .runtime
        .effective_session(&account, &incarnation)
        .await
        .unwrap()
        .is_some());
    assert!(destination
        .runtime
        .platform_storage
        .load_current_session(&account, &incarnation)
        .await
        .unwrap()
        .is_none());
    assert!(destination
        .runtime
        .platform_storage
        .load_quick_unlock(&account, &incarnation)
        .await
        .unwrap()
        .is_none());
    let local_device_key = destination
        .runtime
        .platform_storage
        .load_device_key()
        .await
        .unwrap()
        .expect("native-only installation creates the local protected-artifact Device key");
    let source_device_key = source
        .runtime
        .platform_storage
        .load_device_key()
        .await
        .unwrap()
        .unwrap();
    assert!(
        local_device_key != source_device_key,
        "the local Device key must not persist the borrowed source Device key"
    );
    destination.runtime.close().await;
    let reopened = reopen_sqlite_owner(&destination).await;
    assert!(
        reopened
            .platform_storage
            .load_device_key()
            .await
            .unwrap()
            .as_ref()
            == Some(&local_device_key),
        "the local artifact Device key survives restart without restoring borrowed access"
    );
    assert_eq!(
        reopened.require_snapshot(&account).unwrap().incarnation,
        incarnation
    );
    assert_eq!(
        reopened.account_access.lock().unwrap().get(&account),
        Some(&AccountAccessState::Locked)
    );
    assert!(reopened
        .effective_session(&account, &incarnation)
        .await
        .unwrap()
        .is_none());
    assert!(reopened
        .copy_live_master_unlock_key(&account, &incarnation)
        .is_none());
    assert_eq!(
        runtime_status(&reopened).accounts[0].unlock_capabilities,
        AccountUnlockCapabilities {
            password: false,
            desktop: true,
            sign_in: true
        }
    );
    let reopened_control = reopened.native_authority();
    let source_authority = source_control
        .source_snapshot(
            &source_control
                .attach_source("allowed-extension".into(), "new-source-port".into())
                .unwrap()
                .channel_id,
        )
        .unwrap();
    let reopened_channel = reopened_control
        .attach_desktop(source_authority, "new-destination-port".into())
        .await
        .unwrap();
    let retry = reopened_control
        .prepare_import_for_source(&reopened_channel, &AccountId::from("account-1"), false)
        .await
        .unwrap();
    assert_eq!(retry.destination.account_id, account);
    assert!(
        !retry.new_destination,
        "Core resolves a retained imported identity before considering a new Account"
    );
    reopened_control
        .complete_import(source_control.export(retry).await.unwrap())
        .await
        .unwrap();
    assert!(reopened
        .effective_session(&account, &incarnation)
        .await
        .unwrap()
        .is_some());
    reopened.close().await;
    source.runtime.close().await;
}

async fn reopen_sqlite_owner(owner: &SqliteOwner) -> Arc<Runtime> {
    let reopened = Runtime::with_persistence(
        Arc::new(crate::SqliteReplica::open(&owner.path).unwrap()),
        Arc::new(PlatformStorage::for_platform(
            owner.platform.clone(),
            ClientPlatform::Extension,
        )),
        Arc::new(HttpTransport::new(Arc::new(OfflineNativeHttp))),
        Some(
            AuthClientConfig::new(
                "native-test".into(),
                ClientPlatform::Extension,
                "test".into(),
            )
            .unwrap(),
        ),
        None,
        false,
        Arc::new(FixedClock(NOW_MS)),
        Arc::new(SystemDeviceTimer),
        None,
    );
    reopened.open().await.unwrap();
    reopened
}

#[tokio::test]
async fn native_install_journal_failure_rolls_back_or_reconciles_locked_without_credentials() {
    let source = sqlite_owner("desktop-S2", ClientPlatform::Desktop).await;
    let source_control = source.runtime.native_authority();
    for failure in [PersistenceStep::Metadata, PersistenceStep::PromotedCatalog] {
        let destination = empty_sqlite_owner(
            ClientPlatform::Extension,
            Arc::new(OfflineNativeHttp),
            Arc::new(FixedClock(NOW_MS)),
        )
        .await;
        let control = destination.runtime.native_authority();
        let channel = control
            .attach_desktop(
                source_control
                    .attach_source("allowed-extension".into(), "source-port".into())
                    .unwrap(),
                "destination-port".into(),
            )
            .await
            .unwrap();
        let challenge = control
            .prepare_import_for_source(&channel, &AccountId::from("account-1"), false)
            .await
            .unwrap();
        let account = challenge.destination.account_id.clone();
        let incarnation = challenge.destination.incarnation.clone();
        destination.platform.fail_at(failure);
        assert!(control
            .complete_import(source_control.export(challenge).await.unwrap())
            .await
            .is_err());
        assert!(destination
            .runtime
            .copy_live_master_unlock_key(&account, &incarnation)
            .is_none());
        assert!(destination
            .runtime
            .platform_storage
            .load_current_session(&account, &incarnation)
            .await
            .unwrap()
            .is_none());
        assert!(destination
            .runtime
            .platform_storage
            .load_quick_unlock(&account, &incarnation)
            .await
            .unwrap()
            .is_none());
        destination.runtime.close().await;
        let reopened = reopen_sqlite_owner(&destination).await;
        if failure == PersistenceStep::Metadata {
            assert!(reopened.replica.snapshots().is_empty());
            assert!(!destination.platform.has_document(
                account.as_str(),
                incarnation.as_str(),
                "metadata"
            ));
        } else {
            assert_eq!(
                reopened.require_snapshot(&account).unwrap().incarnation,
                incarnation
            );
            assert_eq!(
                reopened.account_access.lock().unwrap().get(&account),
                Some(&AccountAccessState::Locked)
            );
            assert!(destination
                .platform
                .catalog()
                .unwrap()
                .accounts
                .iter()
                .all(|entry| entry.pending_install.is_none()));
        }
        reopened.close().await;
    }
    source.runtime.close().await;
}

#[tokio::test]
async fn native_source_loss_during_new_account_commit_leaves_only_a_locked_installation() {
    let source = sqlite_owner("desktop-S2", ClientPlatform::Desktop).await;
    let destination = empty_sqlite_owner(
        ClientPlatform::Extension,
        Arc::new(OfflineNativeHttp),
        Arc::new(FixedClock(NOW_MS)),
    )
    .await;
    let source_control = source.runtime.native_authority();
    let control = destination.runtime.native_authority();
    let channel = control
        .attach_desktop(
            source_control
                .attach_source("allowed-extension".into(), "source-port".into())
                .unwrap(),
            "destination-port".into(),
        )
        .await
        .unwrap();
    let challenge = control
        .prepare_import_for_source(&channel, &AccountId::from("account-1"), false)
        .await
        .unwrap();
    let account = challenge.destination.account_id.clone();
    let incarnation = challenge.destination.incarnation.clone();
    let pause = Pause::new(PersistenceStep::PromotedCatalog);
    destination.platform.pause_at(pause.clone());
    let reply = source_control.export(challenge).await.unwrap();
    let complete = control.complete_import(reply);
    tokio::pin!(complete);
    tokio::select! {
        result = &mut complete => panic!("import completed before held catalog: {result:?}"),
        () = pause.wait_until_reached() => {}
    }
    control.retire_channel(&channel).await.unwrap();
    pause.release();
    assert!(complete.await.is_err());
    assert_eq!(
        destination
            .runtime
            .account_access
            .lock()
            .unwrap()
            .get(&account),
        Some(&AccountAccessState::Locked)
    );
    assert!(destination
        .runtime
        .copy_live_master_unlock_key(&account, &incarnation)
        .is_none());
    assert!(destination
        .runtime
        .platform_storage
        .load_current_session(&account, &incarnation)
        .await
        .unwrap()
        .is_none());
    destination.runtime.close().await;
    let reopened = reopen_sqlite_owner(&destination).await;
    assert_eq!(
        reopened.account_access.lock().unwrap().get(&account),
        Some(&AccountAccessState::Locked)
    );
    reopened.close().await;
    source.runtime.close().await;
}

#[tokio::test]
async fn new_native_account_cannot_borrow_desktop_insecure_transport_consent() {
    let source = sqlite_owner("desktop-S2", ClientPlatform::Desktop).await;
    let account = AccountId::from("account-1");
    let incarnation = crate::Incarnation::from("generation-1");
    let mut metadata = source
        .runtime
        .platform_storage
        .load_account_metadata(&account, &incarnation)
        .await
        .unwrap()
        .unwrap();
    metadata.normalized_server_url = "http://insecure-server.test:1234".into();
    metadata.insecure_transport_confirmed = true;
    source
        .runtime
        .platform_storage
        .store_account_metadata(&metadata)
        .await
        .unwrap();
    source
        .runtime
        .account_display_identities
        .lock()
        .unwrap()
        .insert(account.clone(), account_presentation(&metadata));
    let destination = empty_sqlite_owner(
        ClientPlatform::Extension,
        Arc::new(OfflineNativeHttp),
        Arc::new(FixedClock(NOW_MS)),
    )
    .await;
    let control = destination.runtime.native_authority();
    let channel = control
        .attach_desktop(
            source
                .runtime
                .native_authority()
                .attach_source("allowed-extension".into(), "source-port".into())
                .unwrap(),
            "destination-port".into(),
        )
        .await
        .unwrap();
    assert!(
        control
            .prepare_import_for_source(&channel, &account, false)
            .await
            .is_err(),
        "Desktop consent cannot authorize a new destination's HTTP connection"
    );
    assert!(destination.runtime.replica.snapshots().is_empty());
    assert!(destination.platform.events().is_empty());
    let challenge = control
        .prepare_import_for_source(&channel, &account, true)
        .await
        .unwrap();
    assert!(challenge.destination_insecure_transport_confirmed);
    let destination_account = challenge.destination.account_id.clone();
    let destination_incarnation = challenge.destination.incarnation.clone();
    let reply = source
        .runtime
        .native_authority()
        .export(challenge)
        .await
        .unwrap();
    assert!(serde_json::to_value(&reply.profile)
        .unwrap()
        .get("insecureTransportConfirmed")
        .is_none());
    control.complete_import(reply).await.unwrap();
    assert!(
        destination
            .runtime
            .platform_storage
            .load_account_metadata(&destination_account, &destination_incarnation)
            .await
            .unwrap()
            .unwrap()
            .insecure_transport_confirmed
    );
    destination.runtime.close().await;
    source.runtime.close().await;
}

#[tokio::test]
async fn shared_installation_refuses_credentials_for_another_account_or_incarnation_before_writes()
{
    let owner = sqlite_owner("independent-session", ClientPlatform::Desktop).await;
    let account = AccountId::from("account-1");
    let incarnation = crate::Incarnation::from("generation-1");
    let metadata = owner
        .runtime
        .platform_storage
        .load_account_metadata(&account, &incarnation)
        .await
        .unwrap()
        .unwrap();
    for wrong_session in [false, true] {
        let mut quick = owner
            .runtime
            .platform_storage
            .load_quick_unlock(&account, &incarnation)
            .await
            .unwrap()
            .unwrap();
        let mut session = owner
            .runtime
            .platform_storage
            .load_current_session(&account, &incarnation)
            .await
            .unwrap()
            .unwrap();
        if wrong_session {
            session.account_id = "another-account".into();
        } else {
            quick.incarnation = "another-incarnation".into();
        }
        owner.platform.clear_events();
        let result = owner
            .runtime
            .persist_account_installation(
                None,
                None,
                super::super::installation_commit::InstallationDocuments {
                    metadata: &metadata,
                    quick_unlock: Some(&quick),
                    current_session: Some(&session),
                },
            )
            .await;
        assert!(matches!(
            result,
            Err(super::super::installation_commit::InstallationCommitFailure::BeforeReplica(_))
        ));
        assert!(owner.platform.events().is_empty());
    }
    owner.runtime.close().await;
}

#[tokio::test]
async fn connected_desktop_authority_fences_independent_sign_in_before_installation() {
    let source = sqlite_owner("desktop-S2", ClientPlatform::Desktop).await;
    let source_account = AccountId::from("account-1");
    source
        .runtime
        .request(
            RuntimeRequest::Lock {
                account_id: source_account.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    for existing in [false, true] {
        let destination = if existing {
            sqlite_owner("standalone-S1", ClientPlatform::Extension).await
        } else {
            empty_sqlite_owner(
                ClientPlatform::Extension,
                Arc::new(OfflineNativeHttp),
                Arc::new(FixedClock(NOW_MS)),
            )
            .await
        };
        destination
            .runtime
            .native_authority()
            .attach_desktop(
                source
                    .runtime
                    .native_authority()
                    .attach_source("allowed-extension".into(), "source-port".into())
                    .unwrap(),
                "destination-port".into(),
            )
            .await
            .unwrap();
        destination.platform.clear_events();
        let result = destination
            .runtime
            .install_verified_authentication_with(
                verified_with_derived_muk(),
                evidence(),
                &FixedClock(NOW_MS),
                &FixedEntropy::new(&["new-account", "new-generation"]),
            )
            .await;
        assert!(
            result.is_err(),
            "connected Desktop lock authority must fence independent authentication publication"
        );
        assert!(
            destination.platform.events().is_empty(),
            "refusal must precede Device key, credentials and catalog writes"
        );
        if existing {
            assert_eq!(
                destination
                    .runtime
                    .require_snapshot(&source_account)
                    .unwrap()
                    .incarnation,
                crate::Incarnation::from("generation-1")
            );
            assert!(destination
                .runtime
                .copy_live_master_unlock_key(
                    &source_account,
                    &crate::Incarnation::from("generation-1")
                )
                .is_none());
        } else {
            assert!(destination.runtime.replica.snapshots().is_empty());
        }
        destination.runtime.close().await;
    }
    source.runtime.close().await;
}

#[tokio::test]
async fn desktop_connect_during_independent_install_keeps_committed_account_locked() {
    let source = sqlite_owner("desktop-S2", ClientPlatform::Desktop).await;
    source
        .runtime
        .request(
            RuntimeRequest::Lock {
                account_id: "account-1".into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let destination = empty_sqlite_owner(
        ClientPlatform::Extension,
        Arc::new(OfflineNativeHttp),
        Arc::new(FixedClock(NOW_MS)),
    )
    .await;
    let pause = Pause::new(PersistenceStep::PromotedCatalog);
    destination.platform.pause_at(pause.clone());
    let entropy = FixedEntropy::new(&["destination-account", "destination-incarnation"]);
    let install = destination.runtime.install_verified_authentication_with(
        verified_with_derived_muk(),
        evidence(),
        &FixedClock(NOW_MS),
        &entropy,
    );
    tokio::pin!(install);
    tokio::select! {
        result = &mut install => panic!("installation completed before catalog pause: {result:?}"),
        () = pause.wait_until_reached() => {}
    }
    destination
        .runtime
        .native_authority()
        .attach_desktop(
            source
                .runtime
                .native_authority()
                .attach_source("allowed-extension".into(), "source-port".into())
                .unwrap(),
            "destination-port".into(),
        )
        .await
        .unwrap();
    pause.release();
    assert!(install.await.is_err());
    let account = AccountId::from("destination-account");
    let incarnation = crate::Incarnation::from("destination-incarnation");
    assert_eq!(
        destination
            .runtime
            .account_access
            .lock()
            .unwrap()
            .get(&account),
        Some(&AccountAccessState::Locked)
    );
    assert!(destination
        .runtime
        .account_display_identities
        .lock()
        .unwrap()
        .contains_key(&account));
    assert!(destination
        .runtime
        .copy_live_master_unlock_key(&account, &incarnation)
        .is_none());
    assert!(
        destination
            .runtime
            .platform_storage
            .load_current_session(&account, &incarnation)
            .await
            .unwrap()
            .is_some(),
        "independent credentials already committed remain independently owned"
    );
    destination.runtime.close().await;
    source.runtime.close().await;
}

#[tokio::test]
async fn late_independent_unlock_receipt_cannot_erase_newer_borrowed_authority() {
    let source = sqlite_owner("desktop-S2", ClientPlatform::Desktop).await;
    let destination = sqlite_owner("standalone-S1", ClientPlatform::Extension).await;
    let account = AccountId::from("account-1");
    let incarnation = crate::Incarnation::from("generation-1");
    let source_control = source.runtime.native_authority();
    let control = destination.runtime.native_authority();
    let channel = control
        .attach_desktop(
            source_control
                .attach_source("allowed-extension".into(), "source-port".into())
                .unwrap(),
            "destination-port".into(),
        )
        .await
        .unwrap();
    let challenge = control
        .prepare_import_for_source(&channel, &account, false)
        .await
        .unwrap();
    control
        .complete_import(source_control.export(challenge).await.unwrap())
        .await
        .unwrap();
    let borrowed = destination
        .runtime
        .effective_session(&account, &incarnation)
        .await
        .unwrap()
        .unwrap();
    // Independent unlock receipts run after releasing execution and draining previous deliveries.
    destination.runtime.note_local_unlock_completed(&account);
    assert!(
        destination
            .runtime
            .effective_session(&account, &incarnation)
            .await
            .unwrap()
            == Some(borrowed)
    );
    destination.runtime.close().await;
    source.runtime.close().await;
}

#[tokio::test]
async fn desktop_attach_after_quick_unlock_preflight_fences_final_local_publication() {
    let source = sqlite_owner("desktop-S2", ClientPlatform::Desktop).await;
    let destination = sqlite_owner("standalone-S1", ClientPlatform::Extension).await;
    let account = AccountId::from("account-1");
    let incarnation = crate::Incarnation::from("generation-1");
    let metadata = destination
        .runtime
        .platform_storage
        .load_account_metadata(&account, &incarnation)
        .await
        .unwrap()
        .unwrap();
    let quick = destination
        .runtime
        .platform_storage
        .load_quick_unlock(&account, &incarnation)
        .await
        .unwrap()
        .unwrap();
    let key = destination
        .runtime
        .copy_live_master_unlock_key(&account, &incarnation)
        .unwrap();
    let prepared = crate::authentication_installation::prepare_quick_unlock(
        verified_with_derived_muk(),
        metadata,
        quick,
        &key,
        &FixedClock(NOW_MS),
    )
    .unwrap();
    destination
        .runtime
        .request(
            RuntimeRequest::Lock {
                account_id: account.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    destination
        .runtime
        .require_native_local_unlock_allowed(&account)
        .unwrap();
    let snapshot = destination.runtime.require_snapshot(&account).unwrap();
    let execution = destination
        .runtime
        .account_execution_lock(&account)
        .unwrap();
    let guard = execution.lock().await;
    let pause = Pause::new(PersistenceStep::CurrentSession);
    destination.platform.pause_at(pause.clone());
    let unlock = destination
        .runtime
        .commit_quick_unlock(snapshot, prepared, guard);
    tokio::pin!(unlock);
    tokio::select! {
        result = &mut unlock => panic!("unlock completed before held Session write: {result:?}"),
        () = pause.wait_until_reached() => {}
    }
    destination
        .runtime
        .native_authority()
        .attach_desktop(
            source
                .runtime
                .native_authority()
                .attach_source("allowed-extension".into(), "source-port".into())
                .unwrap(),
            "destination-port".into(),
        )
        .await
        .unwrap();
    pause.release();
    assert!(unlock.await.is_err());
    assert!(destination
        .runtime
        .copy_live_master_unlock_key(&account, &incarnation)
        .is_none());
    destination.runtime.close().await;
    source.runtime.close().await;
}

#[tokio::test]
async fn account_unlock_projection_tracks_core_desktop_authority_without_host_policy() {
    let source = sqlite_owner("desktop-S2", ClientPlatform::Desktop).await;
    let destination = sqlite_owner("standalone-S1", ClientPlatform::Extension).await;
    let account = AccountId::from("account-1");
    destination
        .runtime
        .request(
            RuntimeRequest::Lock {
                account_id: account.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        runtime_status(&destination.runtime).accounts[0].unlock_capabilities,
        AccountUnlockCapabilities {
            password: true,
            desktop: false,
            sign_in: true
        }
    );
    let channel = destination
        .runtime
        .native_authority()
        .attach_desktop(
            source
                .runtime
                .native_authority()
                .attach_source("allowed-extension".into(), "source-port".into())
                .unwrap(),
            "destination-port".into(),
        )
        .await
        .unwrap();
    assert_eq!(
        runtime_status(&destination.runtime).accounts[0].unlock_capabilities,
        AccountUnlockCapabilities {
            password: false,
            desktop: true,
            sign_in: false
        }
    );
    destination
        .runtime
        .native_authority()
        .retire_channel(&channel)
        .await
        .unwrap();
    assert_eq!(
        runtime_status(&destination.runtime).accounts[0].unlock_capabilities,
        AccountUnlockCapabilities {
            password: true,
            desktop: false,
            sign_in: true
        }
    );
    destination.runtime.close().await;
    source.runtime.close().await;
}

#[tokio::test]
async fn initial_account_status_delivery_releases_native_guard_before_host_callback() {
    struct ReentrantStatus {
        control: crate::NativeAuthorityFacade,
        channel: String,
    }
    impl ObservationSink for ReentrantStatus {
        fn publish(&self, _projection: RuntimeProjection) {
            self.control.source_snapshot(&self.channel).unwrap();
        }
    }
    let source = sqlite_owner("desktop-S2", ClientPlatform::Desktop).await;
    let control = source.runtime.native_authority();
    let authority = control
        .attach_source("allowed-extension".into(), "source-port".into())
        .unwrap();
    let runtime = source.runtime.clone();
    let (send, receive) = std::sync::mpsc::channel();
    let thread = std::thread::spawn(move || {
        let handle = runtime
            .observe(
                ObservationRequest::RuntimeStatus { account_id: None },
                Arc::new(ReentrantStatus {
                    control,
                    channel: authority.channel_id,
                }),
            )
            .unwrap();
        handle.close();
        send.send(()).unwrap();
    });
    receive
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("initial host callback must be able to reenter native control");
    thread.join().unwrap();
    source.runtime.close().await;
}

#[tokio::test]
async fn scoped_native_source_drop_retires_only_its_exact_channel() {
    let source = sqlite_owner("desktop-S2", ClientPlatform::Desktop).await;
    let first = source
        .runtime
        .native_authority()
        .attach_source_scoped("allowed-extension".into(), "first-port".into())
        .unwrap();
    let second = source
        .runtime
        .native_authority()
        .attach_source_scoped("allowed-extension".into(), "second-port".into())
        .unwrap();
    let first_channel = first.snapshot().unwrap().channel_id;
    drop(first);
    assert!(source
        .runtime
        .native_authority()
        .source_snapshot(&first_channel)
        .is_err());
    assert!(second
        .snapshot()
        .unwrap()
        .accounts
        .iter()
        .all(|account| account.unlocked));
    source.runtime.close().await;
}

#[tokio::test]
async fn legacy_account_catalog_preserves_device_metadata_and_current_unlock_eligibility() {
    let owner = sqlite_owner("desktop-legacy-accounts", ClientPlatform::Desktop).await;
    let account = AccountId::from("account-1");
    let incarnation = Incarnation::from("generation-1");
    let metadata = owner
        .runtime
        .platform_storage
        .load_account_metadata(&account, &incarnation)
        .await
        .unwrap()
        .unwrap();
    let source = owner
        .runtime
        .native_authority()
        .attach_source_scoped("allowed-extension".into(), "legacy-accounts-port".into())
        .unwrap();

    let encoded = source
        .encode_legacy_accounts(Some("accounts-request-1"))
        .await
        .unwrap();
    let frame: serde_json::Value = serde_json::from_str(&encoded).unwrap();
    assert_eq!(frame["protocolVersion"], 1);
    assert_eq!(frame["requestId"], "accounts-request-1");
    assert_eq!(frame["type"], "DESKTOP_ACCOUNTS");
    assert_eq!(frame["activeAccount"], serde_json::Value::Null);
    assert_eq!(frame["unlockedAccounts"], serde_json::json!(["account-1"]));
    assert!(frame.get("serverUrl").is_none());
    assert!(frame.get("insecureTransportConfirmed").is_none());
    let entry = &frame["accounts"][0];
    assert_eq!(entry["accountId"], account.as_str());
    assert_eq!(entry["email"], metadata.email);
    assert_eq!(entry["userId"], metadata.user_id);
    assert_eq!(entry["name"], metadata.name);
    assert_eq!(entry["secretKeyHint"], metadata.secret_key_hint);
    assert_eq!(entry["addedAt"], metadata.added_at_ms);
    assert_eq!(entry["lastActiveAt"], metadata.last_active_at_ms);
    assert_eq!(entry["biometricEnabled"], metadata.biometric_enabled);
    match metadata.team_name {
        Some(team_name) => assert_eq!(entry["teamName"], team_name),
        None => assert!(entry.get("teamName").is_none()),
    }
    let expected_avatar = metadata
        .team_avatar_url
        .map_or(serde_json::Value::Null, serde_json::Value::String);
    assert_eq!(entry["teamAvatarUrl"], expected_avatar);

    owner
        .runtime
        .request(
            RuntimeRequest::Lock {
                account_id: account,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let encoded = source.encode_legacy_accounts(None).await.unwrap();
    let locked: serde_json::Value = serde_json::from_str(&encoded).unwrap();
    assert_eq!(locked["accounts"], frame["accounts"]);
    assert_eq!(locked["activeAccount"], serde_json::Value::Null);
    assert_eq!(locked["unlockedAccounts"], serde_json::json!([]));
    assert!(locked.get("requestId").is_none());
    source.close();
    owner.runtime.close().await;
}

#[tokio::test]
async fn legacy_status_projects_core_activity_timeout_and_current_unlock() {
    let owner = sqlite_owner("desktop-legacy-status", ClientPlatform::Desktop).await;
    let account = AccountId::from("account-1");
    let source = owner
        .runtime
        .native_authority()
        .attach_source_scoped("allowed-extension".into(), "legacy-status-port".into())
        .unwrap();
    owner
        .runtime
        .request(
            RuntimeRequest::SetInactivityTimeout {
                account_id: account.clone(),
                timeout_ms: -1,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let frame: serde_json::Value =
        serde_json::from_str(&source.encode_legacy_status(Some("status-1")).await.unwrap())
            .unwrap();
    assert_eq!(frame["protocolVersion"], 1);
    assert_eq!(frame["requestId"], "status-1");
    assert_eq!(frame["type"], "DESKTOP_STATUS");
    assert_eq!(frame["available"], true);
    assert_eq!(frame["locked"], false);
    assert_eq!(frame["unlockedAccounts"], serde_json::json!(["account-1"]));
    assert_eq!(frame["timestamp"], NOW_MS);
    assert_eq!(frame["autolockTimeoutMs"], -1);
    assert!(frame.get("theme").is_none());
    owner
        .runtime
        .request(
            RuntimeRequest::Lock {
                account_id: account,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let locked: serde_json::Value =
        serde_json::from_str(&source.encode_legacy_status(None).await.unwrap()).unwrap();
    assert_eq!(locked["locked"], true);
    assert_eq!(locked["unlockedAccounts"], serde_json::json!([]));
    assert!(locked.get("requestId").is_none());
    source.close();
    owner.runtime.close().await;
}

async fn fail_status_replica(runtime: &Arc<Runtime>, account_id: &AccountId) {
    let before = runtime.replica.snapshot(account_id).unwrap();
    let result = runtime
        .replica
        .execute_recomputing(GuardedCommitPlan::new(
            account_id.clone(),
            before.incarnation,
            before.revision,
            before.lock_epoch,
            vec![PlanMutation::FailAccount {
                code: RuntimeErrorCode::InvariantViolation,
            }],
        ))
        .await
        .unwrap();
    let RecomputedPlanResult::Applied { snapshot } = result else {
        panic!("Account failure must commit");
    };
    runtime.replica.cache(snapshot);
}

#[tokio::test]
async fn legacy_status_keeps_healthy_account_when_another_replica_fails() {
    let owner = sqlite_owner("desktop-status-failed-account", ClientPlatform::Desktop).await;
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
    let failed = AccountId::from("account-2");
    fail_status_replica(&owner.runtime, &failed).await;
    assert!(owner
        .runtime
        .replica
        .snapshot(&failed)
        .unwrap()
        .failure
        .is_some());
    let healthy = owner
        .runtime
        .replica
        .snapshot(&AccountId::from("account-1"))
        .unwrap();
    assert!(owner.runtime.generation_is_preparation_eligible(&healthy));
    assert!(!owner.runtime.is_closed());

    let source = owner
        .runtime
        .native_authority()
        .attach_source_scoped("allowed-extension".into(), "failed-status-port".into())
        .unwrap();
    let frame: serde_json::Value = serde_json::from_str(
        &source
            .encode_legacy_status(Some("healthy-account-status"))
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(frame["type"], "DESKTOP_STATUS");
    assert_eq!(frame["requestId"], "healthy-account-status");
    assert_eq!(frame["available"], true);
    assert_eq!(frame["locked"], false);
    assert_eq!(frame["unlockedAccounts"], serde_json::json!(["account-1"]));
    source.close();
    owner.runtime.close().await;
}

#[tokio::test]
async fn legacy_status_unknown_selection_removed_selection_and_unreadable_policy() {
    let empty = empty_sqlite_owner(
        ClientPlatform::Desktop,
        Arc::new(OfflineNativeHttp),
        Arc::new(FixedClock(NOW_MS)),
    )
    .await;
    let source = empty
        .runtime
        .native_authority()
        .attach_source_scoped("allowed-extension".into(), "status-empty-port".into())
        .unwrap();
    let frame: serde_json::Value =
        serde_json::from_str(&source.encode_legacy_status(None).await.unwrap()).unwrap();
    assert_eq!(frame["available"], true);
    assert_eq!(frame["locked"], true);
    assert_eq!(frame["unlockedAccounts"], serde_json::json!([]));
    assert_eq!(frame["autolockTimeoutMs"], 0);
    source.close();
    empty.runtime.close().await;

    let removed = sqlite_owner("desktop-status-fallback", ClientPlatform::Desktop).await;
    let source = removed
        .runtime
        .native_authority()
        .attach_source_scoped("allowed-extension".into(), "status-fallback-port".into())
        .unwrap();
    removed
        .runtime
        .request(
            RuntimeRequest::RemoveAccount {
                account_id: AccountId::from("account-1"),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let frame: serde_json::Value =
        serde_json::from_str(&source.encode_legacy_status(None).await.unwrap()).unwrap();
    assert_eq!(frame["available"], true);
    assert_eq!(frame["locked"], true);
    assert_eq!(frame["unlockedAccounts"], serde_json::json!([]));
    assert_eq!(frame["autolockTimeoutMs"], 600_000);
    source.close();
    removed.runtime.close().await;

    let unreadable = sqlite_owner("desktop-status-policy", ClientPlatform::Desktop).await;
    let source = unreadable
        .runtime
        .native_authority()
        .attach_source_scoped("allowed-extension".into(), "status-policy-port".into())
        .unwrap();
    unreadable.platform.values.lock().unwrap().insert(
        (
            "devicePlain".into(),
            "bittery:runtime:platform-storage:account:9:account-1:local-security".into(),
        ),
        "{corrupt policy".into(),
    );
    let frame: serde_json::Value =
        serde_json::from_str(&source.encode_legacy_status(None).await.unwrap()).unwrap();
    assert_eq!(frame["available"], true);
    assert_eq!(frame["locked"], true);
    assert_eq!(frame["unlockedAccounts"], serde_json::json!([]));
    assert_eq!(frame["autolockTimeoutMs"], 0);
    source.close();
    unreadable.runtime.close().await;
}

struct StatusClock(std::sync::atomic::AtomicBool);
impl Clock for StatusClock {
    fn now_ms(&self) -> Result<u64, RuntimeError> {
        if self.0.load(std::sync::atomic::Ordering::SeqCst) {
            Err(RuntimeError::new(
                RuntimeErrorCode::StorageUnavailable,
                "clock unavailable",
            ))
        } else {
            Ok(NOW_MS)
        }
    }
}

#[tokio::test]
async fn legacy_status_refuses_unreadable_core_clock() {
    let clock = Arc::new(StatusClock(std::sync::atomic::AtomicBool::new(false)));
    let owner = sqlite_owner_with_clock(
        "desktop-status-clock",
        ClientPlatform::Desktop,
        Arc::new(OfflineNativeHttp),
        clock.clone(),
    )
    .await;
    let source = owner
        .runtime
        .native_authority()
        .attach_source_scoped("allowed-extension".into(), "status-clock-port".into())
        .unwrap();
    clock.0.store(true, std::sync::atomic::Ordering::SeqCst);
    assert!(source.encode_legacy_status(None).await.is_err());
    source.close();
    owner.runtime.close().await;
}

async fn hold_legacy_status_before_final_encoding(
    runtime: &Arc<Runtime>,
    source: Arc<NativeSourceAttachment>,
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
            .block_on(source.encode_legacy_status(Some("held-status")))
    });
    tokio::task::spawn_blocking(move || {
        entered_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("status must reach final encoding")
    })
    .await
    .unwrap();
    (pending, release_tx)
}

#[tokio::test]
async fn held_legacy_status_refuses_failure_transition_then_reports_failed_account_locked() {
    let owner = sqlite_owner("desktop-status-held-failure", ClientPlatform::Desktop).await;
    let source = Arc::new(
        owner
            .runtime
            .native_authority()
            .attach_source_scoped("allowed-extension".into(), "status-failure-port".into())
            .unwrap(),
    );
    let (pending, release) =
        hold_legacy_status_before_final_encoding(&owner.runtime, source.clone()).await;
    fail_status_replica(&owner.runtime, &AccountId::from("account-1")).await;
    release.send(()).unwrap();
    assert!(pending.await.unwrap().is_err());
    owner
        .runtime
        .foreground_attachments
        .set_before_finalization_admission_hook(None);
    let fresh: serde_json::Value =
        serde_json::from_str(&source.encode_legacy_status(None).await.unwrap()).unwrap();
    assert_eq!(fresh["type"], "DESKTOP_STATUS");
    assert_eq!(fresh["locked"], true);
    assert_eq!(fresh["unlockedAccounts"], serde_json::json!([]));
    source.close();
    owner.runtime.close().await;
}

#[tokio::test]
async fn held_legacy_status_refuses_lock_and_new_activity_revision() {
    let owner = sqlite_owner("desktop-status-lock", ClientPlatform::Desktop).await;
    let source = Arc::new(
        owner
            .runtime
            .native_authority()
            .attach_source_scoped("allowed-extension".into(), "status-lock-port".into())
            .unwrap(),
    );
    let (pending, release) = hold_legacy_status_before_final_encoding(&owner.runtime, source).await;
    owner
        .runtime
        .request(
            RuntimeRequest::Lock {
                account_id: AccountId::from("account-1"),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    release.send(()).unwrap();
    assert!(pending.await.unwrap().is_err());
    owner.runtime.close().await;

    let owner = sqlite_owner("desktop-status-revision", ClientPlatform::Desktop).await;
    let source = Arc::new(
        owner
            .runtime
            .native_authority()
            .attach_source_scoped("allowed-extension".into(), "status-revision-port".into())
            .unwrap(),
    );
    let (pending, release) = hold_legacy_status_before_final_encoding(&owner.runtime, source).await;
    owner
        .runtime
        .request(
            RuntimeRequest::RecordActivity {
                account_id: AccountId::from("account-1"),
                kind: crate::ActivityKind::Interaction,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    release.send(()).unwrap();
    assert!(pending.await.unwrap().is_err());
    owner.runtime.close().await;

    let owner = sqlite_owner("desktop-status-policy-change", ClientPlatform::Desktop).await;
    let source = Arc::new(
        owner
            .runtime
            .native_authority()
            .attach_source_scoped(
                "allowed-extension".into(),
                "status-policy-change-port".into(),
            )
            .unwrap(),
    );
    let (pending, release) = hold_legacy_status_before_final_encoding(&owner.runtime, source).await;
    owner
        .runtime
        .request(
            RuntimeRequest::SetInactivityTimeout {
                account_id: AccountId::from("account-1"),
                timeout_ms: 300_000,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    release.send(()).unwrap();
    assert!(pending.await.unwrap().is_err());
    owner.runtime.close().await;
}

#[tokio::test]
async fn held_legacy_status_refuses_peer_runtime_and_account_retirement() {
    let peer = sqlite_owner("desktop-status-peer", ClientPlatform::Desktop).await;
    let surviving_source = peer
        .runtime
        .native_authority()
        .attach_source_scoped("allowed-extension".into(), "status-surviving-port".into())
        .unwrap();
    let source = Arc::new(
        peer.runtime
            .native_authority()
            .attach_source_scoped("allowed-extension".into(), "status-peer-port".into())
            .unwrap(),
    );
    let (pending, release) =
        hold_legacy_status_before_final_encoding(&peer.runtime, source.clone()).await;
    source.close();
    release.send(()).unwrap();
    assert!(pending.await.unwrap().is_err());
    peer.runtime
        .foreground_attachments
        .set_before_finalization_admission_hook(None);
    let surviving: serde_json::Value =
        serde_json::from_str(&surviving_source.encode_legacy_status(None).await.unwrap()).unwrap();
    assert_eq!(
        surviving["unlockedAccounts"],
        serde_json::json!(["account-1"])
    );
    surviving_source.close();
    peer.runtime.close().await;

    let closed = sqlite_owner("desktop-status-close", ClientPlatform::Desktop).await;
    let source = Arc::new(
        closed
            .runtime
            .native_authority()
            .attach_source_scoped("allowed-extension".into(), "status-close-port".into())
            .unwrap(),
    );
    let (pending, release) =
        hold_legacy_status_before_final_encoding(&closed.runtime, source).await;
    closed.runtime.close().await;
    release.send(()).unwrap();
    assert!(pending.await.unwrap().is_err());

    let removed = sqlite_owner("desktop-status-remove", ClientPlatform::Desktop).await;
    let source = Arc::new(
        removed
            .runtime
            .native_authority()
            .attach_source_scoped("allowed-extension".into(), "status-remove-port".into())
            .unwrap(),
    );
    let (pending, release) =
        hold_legacy_status_before_final_encoding(&removed.runtime, source).await;
    removed
        .runtime
        .request(
            RuntimeRequest::RemoveAccount {
                account_id: AccountId::from("account-1"),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    release.send(()).unwrap();
    assert!(pending.await.unwrap().is_err());
    removed.runtime.close().await;

    let replaced = sqlite_owner("desktop-status-replace", ClientPlatform::Desktop).await;
    let source = Arc::new(
        replaced
            .runtime
            .native_authority()
            .attach_source_scoped("allowed-extension".into(), "status-replace-port".into())
            .unwrap(),
    );
    let (pending, release) =
        hold_legacy_status_before_final_encoding(&replaced.runtime, source).await;
    replaced
        .runtime
        .install_or_replace_account(
            AccountId::from("account-1"),
            "user-1".into(),
            Incarnation::from("replacement-generation"),
        )
        .await
        .unwrap();
    release.send(()).unwrap();
    assert!(pending.await.unwrap().is_err());
    replaced.runtime.close().await;
}

async fn hold_legacy_accounts_before_final_encoding(
    runtime: &Arc<Runtime>,
    source: Arc<NativeSourceAttachment>,
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
            .block_on(source.encode_legacy_accounts(Some("held-account-list")))
    });
    tokio::task::spawn_blocking(move || {
        entered_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("legacy Account catalog must reach final encoding")
    })
    .await
    .unwrap();
    (pending, release_tx)
}

#[tokio::test]
async fn held_legacy_accounts_refuse_lock_before_final_encoding() {
    let owner = sqlite_owner("desktop-legacy-accounts-lock", ClientPlatform::Desktop).await;
    let account = AccountId::from("account-1");
    let source = Arc::new(
        owner
            .runtime
            .native_authority()
            .attach_source_scoped(
                "allowed-extension".into(),
                "legacy-accounts-lock-port".into(),
            )
            .unwrap(),
    );
    let (pending, release) =
        hold_legacy_accounts_before_final_encoding(&owner.runtime, source).await;
    let runtime = owner.runtime.clone();
    let locking = tokio::spawn(async move {
        runtime
            .request(
                RuntimeRequest::Lock {
                    account_id: account,
                },
                RequestCancellation::new(),
            )
            .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), locking)
        .await
        .expect("Lock must finish while the catalog is held before final encoding")
        .unwrap()
        .unwrap();
    assert_eq!(
        owner
            .runtime
            .account_access
            .lock()
            .unwrap()
            .get(&AccountId::from("account-1")),
        Some(&AccountAccessState::Locked),
    );
    release.send(()).unwrap();
    assert!(pending.await.unwrap().is_err());
    owner.runtime.close().await;
}

#[tokio::test]
async fn held_legacy_accounts_refuse_peer_and_runtime_close_before_final_encoding() {
    let peer_closed = sqlite_owner("desktop-legacy-accounts-eof", ClientPlatform::Desktop).await;
    let source = Arc::new(
        peer_closed
            .runtime
            .native_authority()
            .attach_source_scoped(
                "allowed-extension".into(),
                "legacy-accounts-eof-port".into(),
            )
            .unwrap(),
    );
    let (pending, release) =
        hold_legacy_accounts_before_final_encoding(&peer_closed.runtime, source.clone()).await;
    source.close();
    release.send(()).unwrap();
    assert!(pending.await.unwrap().is_err());
    peer_closed.runtime.close().await;

    let owner_closed = sqlite_owner(
        "desktop-legacy-accounts-runtime-close",
        ClientPlatform::Desktop,
    )
    .await;
    let source = Arc::new(
        owner_closed
            .runtime
            .native_authority()
            .attach_source_scoped(
                "allowed-extension".into(),
                "legacy-accounts-runtime-close-port".into(),
            )
            .unwrap(),
    );
    let (pending, release) =
        hold_legacy_accounts_before_final_encoding(&owner_closed.runtime, source).await;
    owner_closed.runtime.close().await;
    release.send(()).unwrap();
    assert!(pending.await.unwrap().is_err());
}

#[tokio::test]
async fn held_legacy_accounts_refuse_removed_or_replaced_generation() {
    let removed = sqlite_owner("desktop-legacy-accounts-remove", ClientPlatform::Desktop).await;
    let source = Arc::new(
        removed
            .runtime
            .native_authority()
            .attach_source_scoped(
                "allowed-extension".into(),
                "legacy-accounts-remove-port".into(),
            )
            .unwrap(),
    );
    let (pending, release) =
        hold_legacy_accounts_before_final_encoding(&removed.runtime, source).await;
    let runtime = removed.runtime.clone();
    let removal = tokio::spawn(async move {
        runtime
            .request(
                RuntimeRequest::RemoveAccount {
                    account_id: AccountId::from("account-1"),
                },
                RequestCancellation::new(),
            )
            .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while removed
            .runtime
            .replica
            .snapshot(&AccountId::from("account-1"))
            .is_some()
        {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("RemoveAccount must retire the replica before the encoder is released");
    release.send(()).unwrap();
    assert!(pending.await.unwrap().is_err());
    removal.await.unwrap().unwrap();
    removed.runtime.close().await;

    let replaced = sqlite_owner("desktop-legacy-accounts-replace", ClientPlatform::Desktop).await;
    let source = Arc::new(
        replaced
            .runtime
            .native_authority()
            .attach_source_scoped(
                "allowed-extension".into(),
                "legacy-accounts-replace-port".into(),
            )
            .unwrap(),
    );
    let (pending, release) =
        hold_legacy_accounts_before_final_encoding(&replaced.runtime, source).await;
    replaced
        .runtime
        .install_or_replace_account(
            AccountId::from("account-1"),
            "user-1".into(),
            Incarnation::from("replacement-generation"),
        )
        .await
        .unwrap();
    release.send(()).unwrap();
    assert!(pending.await.unwrap().is_err());
    replaced.runtime.close().await;
}

async fn hold_legacy_snapshot_before_final_encoding(
    runtime: &Arc<Runtime>,
    source: Arc<NativeSourceAttachment>,
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
        source.encode_legacy_items_snapshot(Some(&["account-1".into()]), Some("held-legacy"))
    });
    tokio::task::spawn_blocking(move || {
        entered_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("legacy Core read must reach final encoding")
    })
    .await
    .unwrap();
    (pending, release_tx)
}

#[tokio::test]
async fn legacy_snapshot_timestamp_uses_the_injected_runtime_clock() {
    let owner = sqlite_owner("desktop-legacy-clock", ClientPlatform::Desktop).await;
    let source = owner
        .runtime
        .native_authority()
        .attach_source_scoped("allowed-extension".into(), "legacy-clock-port".into())
        .unwrap();
    let encoded = source
        .encode_legacy_items_snapshot(Some(&["account-1".into()]), None)
        .unwrap();
    let frame: serde_json::Value = serde_json::from_str(&encoded).unwrap();
    assert_eq!(frame["generatedAt"], serde_json::json!(NOW_MS));
    assert!(frame.get("requestId").is_none());
    source.close();
    owner.runtime.close().await;
}

#[tokio::test]
async fn held_legacy_snapshot_refuses_source_lock_before_final_encoding() {
    let owner = sqlite_owner("desktop-legacy-lock", ClientPlatform::Desktop).await;
    let source = Arc::new(
        owner
            .runtime
            .native_authority()
            .attach_source_scoped("allowed-extension".into(), "legacy-lock-port".into())
            .unwrap(),
    );
    assert!(source
        .encode_legacy_items_snapshot(Some(&["account-1".into()]), Some("before-lock"))
        .is_ok());
    let (pending, release) =
        hold_legacy_snapshot_before_final_encoding(&owner.runtime, source.clone()).await;
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
    let fenced = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while !owner
            .runtime
            .account_access_retirement_is_pending(&AccountId::from("account-1"))
        {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await;
    release.send(()).unwrap();
    fenced.expect("Lock must fence Account access before draining its private loan");
    assert!(pending.await.unwrap().is_err());
    locking.await.unwrap().unwrap();
    owner.runtime.close().await;
}

#[tokio::test]
async fn held_legacy_snapshot_refuses_peer_eof_before_final_encoding() {
    let owner = sqlite_owner("desktop-legacy-eof", ClientPlatform::Desktop).await;
    let source = Arc::new(
        owner
            .runtime
            .native_authority()
            .attach_source_scoped("allowed-extension".into(), "legacy-eof-port".into())
            .unwrap(),
    );
    let (pending, release) =
        hold_legacy_snapshot_before_final_encoding(&owner.runtime, source.clone()).await;
    source.close();
    release.send(()).unwrap();
    assert!(pending.await.unwrap().is_err());
    owner.runtime.close().await;
}

#[tokio::test]
async fn scoped_native_source_cannot_export_a_sibling_ports_challenge() {
    let source = sqlite_owner("desktop-S2", ClientPlatform::Desktop).await;
    let destination = sqlite_owner("standalone-S1", ClientPlatform::Extension).await;
    let first = source
        .runtime
        .native_authority()
        .attach_source_scoped("allowed-extension".into(), "first-port".into())
        .unwrap();
    let second = source
        .runtime
        .native_authority()
        .attach_source_scoped("allowed-extension".into(), "second-port".into())
        .unwrap();
    let destination_control = destination.runtime.native_authority();
    let channel = destination_control
        .attach_desktop(second.snapshot().unwrap(), "destination-port".into())
        .await
        .unwrap();
    let challenge = destination_control
        .prepare_import_for_source(&channel, &AccountId::from("account-1"), false)
        .await
        .unwrap();
    assert!(first.export(challenge.clone()).await.is_err());
    let reply = second.export(challenge).await.unwrap();
    destination_control.complete_import(reply).await.unwrap();
    destination.runtime.close().await;
    source.runtime.close().await;
}

#[tokio::test]
async fn closed_native_source_refuses_retained_nonsecret_response_encoding() {
    let source = sqlite_owner("desktop-S2", ClientPlatform::Desktop).await;
    let attachment = source
        .runtime
        .native_authority()
        .attach_source_scoped("allowed-extension".into(), "closed-port".into())
        .unwrap();
    let response = NativeAuthorityResponse::Source {
        snapshot: attachment.snapshot().unwrap(),
    };
    assert!(attachment.encode_response(&response).is_ok());
    assert!(attachment
        .encode_response(&NativeAuthorityResponse::Applied)
        .is_ok());
    attachment.close();
    assert!(attachment.encode_response(&response).is_err());
    assert!(attachment
        .encode_response(&NativeAuthorityResponse::Applied)
        .is_err());
    assert!(attachment
        .encode_response(&NativeAuthorityResponse::BiometricRefused {
            failure: crate::BiometricFailure::Cancelled,
        })
        .is_err());
    source.runtime.close().await;
}

#[tokio::test]
async fn closed_native_source_refuses_new_wake_subscription() {
    struct Wake;
    impl ObservationSink for Wake {
        fn publish(&self, _projection: RuntimeProjection) {}
    }
    let source = sqlite_owner("desktop-S2", ClientPlatform::Desktop).await;
    let attachment = source
        .runtime
        .native_authority()
        .attach_source_scoped("allowed-extension".into(), "closed-port".into())
        .unwrap();
    attachment.close();
    assert!(attachment.observe_changes(Arc::new(Wake)).is_err());
    source.runtime.close().await;
}

#[tokio::test]
async fn native_source_retired_by_initial_wake_cannot_return_a_live_subscription() {
    struct RetireOnWake(Arc<crate::NativeSourceAttachment>);
    impl ObservationSink for RetireOnWake {
        fn publish(&self, _projection: RuntimeProjection) {
            self.0.close();
        }
    }
    let source = sqlite_owner("desktop-S2", ClientPlatform::Desktop).await;
    let attachment = Arc::new(
        source
            .runtime
            .native_authority()
            .attach_source_scoped("allowed-extension".into(), "reentrant-port".into())
            .unwrap(),
    );
    let observers_before = source.runtime.observers.lock().unwrap().len();
    assert!(attachment
        .observe_changes(Arc::new(RetireOnWake(attachment.clone())))
        .is_err());
    assert_eq!(
        source.runtime.observers.lock().unwrap().len(),
        observers_before
    );
    source.runtime.close().await;
}

#[tokio::test]
async fn native_vault_retirement_intent_fences_source_delivery_before_durable_journal() {
    use crate::runtime::foreground_attachment_lifecycle::VaultRetirementProof;
    let source = sqlite_owner("desktop-S2", ClientPlatform::Desktop).await;
    let destination = sqlite_owner("standalone-S1", ClientPlatform::Extension).await;
    let account = AccountId::from("account-1");
    let source_control = source.runtime.native_authority();
    let destination_control = destination.runtime.native_authority();
    let authority = source_control
        .attach_source("allowed-extension".into(), "source-port".into())
        .unwrap();
    let source_channel = authority.channel_id.clone();
    let channel = destination_control
        .attach_desktop(authority, "destination-port".into())
        .await
        .unwrap();
    let challenge = destination_control
        .prepare_import(&channel, &account, &account)
        .await
        .unwrap();
    let retained_reply = source_control.export(challenge.clone()).await.unwrap();
    let snapshot = source.runtime.require_snapshot(&account).unwrap();
    assert!(snapshot.bootstrap.pending_vault_retirements.is_empty());
    let retirement = source
        .runtime
        .foreground_attachments
        .begin_vault_retirement(
            &account,
            &snapshot.incarnation,
            &["visible".into()],
            VaultRetirementProof::CompleteBootstrap(crate::replica::BootstrapGenerationId(
                "retirement-stage".into(),
            )),
        )
        .unwrap();
    let during = source_control.source_snapshot(&source_channel).unwrap();
    assert!(
        during.accounts[0].unlocked,
        "Vault retirement does not become Desktop Lock"
    );
    assert!(!during.accounts[0].key_authorization_available);
    assert!(source_control.encode_reply(retained_reply).is_err());
    assert!(source_control.export(challenge).await.is_err());
    assert!(source
        .runtime
        .require_snapshot(&account)
        .unwrap()
        .bootstrap
        .pending_vault_retirements
        .is_empty());
    source
        .runtime
        .foreground_attachments
        .acknowledge_vault_retirement(&retirement)
        .unwrap();
    assert!(source.runtime.foreground_attachments.is_vault_fenced(
        &account,
        &snapshot.incarnation,
        "visible"
    ));
    assert!(
        source_control
            .source_snapshot(&source_channel)
            .unwrap()
            .accounts[0]
            .key_authorization_available,
        "A permanent retired Vault fence must not disable every remaining source Vault"
    );
    destination.runtime.close().await;
    source.runtime.close().await;
}

#[tokio::test]
async fn native_source_key_generation_can_advance_in_private_startup_without_public_admission() {
    let source = sqlite_owner("desktop-S2", ClientPlatform::Desktop).await;
    let snapshot = source
        .runtime
        .require_snapshot(&AccountId::from("account-1"))
        .unwrap();
    source.runtime.ready.store(false, Ordering::SeqCst);
    assert!(source
        .runtime
        .native_authority()
        .attach_source("allowed-extension".into(), "too-early-port".into())
        .is_err());
    assert!(source
        .runtime
        .advance_native_retirement_authority(&snapshot, &[])
        .is_ok());
    let mut stale = snapshot.clone();
    stale.lock_epoch += 1;
    assert!(source
        .runtime
        .advance_native_retirement_authority(&stale, &[])
        .is_err());
    source.runtime.close().await;
    assert!(source
        .runtime
        .advance_native_retirement_authority(&snapshot, &[])
        .is_err());
}
