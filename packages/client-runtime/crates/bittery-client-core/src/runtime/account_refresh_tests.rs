use super::{operation_fixtures::*, *};
use crate::{auth_http::ClientPlatform, protocol::Incarnation};
use async_trait::async_trait;
use serde_json::{json, Value};

struct RefreshServer {
    requests: Mutex<Vec<Value>>,
    statuses: Mutex<VecDeque<u16>>,
    hold: AtomicBool,
    entered: tokio::sync::Semaphore,
    release: tokio::sync::Semaphore,
    cancelled: AtomicU64,
    malformed: AtomicBool,
}
impl RefreshServer {
    fn new(statuses: impl IntoIterator<Item = u16>) -> Arc<Self> {
        Arc::new(Self {
            requests: Mutex::new(Vec::new()),
            statuses: Mutex::new(statuses.into_iter().collect()),
            hold: AtomicBool::new(false),
            entered: tokio::sync::Semaphore::new(0),
            release: tokio::sync::Semaphore::new(0),
            cancelled: AtomicU64::new(0),
            malformed: AtomicBool::new(false),
        })
    }
}
#[async_trait]
impl SerializedHttpExecutor for RefreshServer {
    fn cancel(&self, _: &str) {
        self.cancelled.fetch_add(1, Ordering::SeqCst);
    }
    async fn invoke(&self, request: zeroize::Zeroizing<String>) -> Result<String, RuntimeError> {
        let request: Value = serde_json::from_str(&request).unwrap();
        self.requests.lock().unwrap().push(request.clone());
        let url = request["url"].as_str().unwrap();
        if url.ends_with("/auth/me") {
            assert_eq!(request["method"], "GET");
        } else if url.ends_with("/sessions/current/refresh") {
            assert_eq!(request["method"], "POST");
        } else {
            return Ok(json!({"type":"networkFailure"}).to_string());
        }
        self.entered.add_permits(1);
        if self.hold.swap(false, Ordering::SeqCst) {
            self.release.acquire().await.unwrap().forget();
        }
        let status = self.statuses.lock().unwrap().pop_front().unwrap_or(200);
        let body = if url.ends_with("/sessions/current/refresh") {
            json!({"token":SECOND_TOKEN,"sessionId":"session-1","expiresAt":"2030-01-01T00:00:00Z"})
        } else {
            json!({"id":USER,"email":"user-1@example.com","name":"User One",
            "teamName":"New Team","teamAvatarUrl":"https://images.example/new.png",
            "role":"owner","publicKey":"public","encryptedPrivateKey":"private",
            "hasRecoveryKey":false,"createdAt":"2023-11-14T00:00:00Z"})
        };
        Ok(json!({"type":"completed","status":status,
            "headers":[{"name":"content-type","value":"application/json"}],
            "body":if self.malformed.load(Ordering::SeqCst) { b"malformed JSON".to_vec() } else {serde_json::to_vec(&body).unwrap()}})
        .to_string())
    }
}

#[tokio::test]
async fn desktop_driver_refreshes_team_metadata_through_account_status() {
    let harness = seeded(true).await;
    let server = RefreshServer::new([]);
    let runtime = Runtime::with_test_dispatch_environment(
        harness.replica.clone(),
        harness.platform.clone(),
        server.clone(),
        AuthClientConfig::new("desktop".into(), ClientPlatform::Desktop, "test".into()).unwrap(),
        harness.clock.clone(),
        harness.timer.clone(),
    );
    runtime.replica.load(&harness.account_id).await.unwrap();
    runtime.unlock_account(&harness.account_id).await.unwrap();
    store_session(&runtime, &harness.account_id, FIRST_TOKEN).await;
    tokio::select! {
        () = runtime.clone().run_operation_dispatch() => panic!("driver unexpectedly stopped"),
        () = async {
            for _ in 0..100 { tokio::task::yield_now().await; }
            assert_eq!(server.requests.lock().unwrap().len(),1,"startup reads coalesce");
            let status = runtime.projection(&ObservationRequest::RuntimeStatus { account_id: None }).unwrap();
            let RuntimeProjection::RuntimeStatus(status) = status.projection else { panic!("status") };
            assert_eq!(status.accounts[0].display_identity.as_ref().unwrap().team_name.as_deref(),Some("New Team"));
        } => {}
    }
    let metadata = runtime
        .platform_storage
        .load_account_metadata(&harness.account_id, &Incarnation::from(INCARNATION))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        metadata.team_avatar_url.as_deref(),
        Some("https://images.example/new.png")
    );
    runtime.close().await;
}

#[tokio::test]
async fn refused_retained_session_locks_without_forgetting_quick_unlock_or_accepted_work() {
    let harness = seeded(true).await;
    let server = RefreshServer::new([401, 401]);
    let runtime = Runtime::with_test_dispatch_environment(
        harness.replica.clone(),
        harness.platform.clone(),
        server.clone(),
        AuthClientConfig::new("desktop".into(), ClientPlatform::Desktop, "test".into()).unwrap(),
        harness.clock.clone(),
        harness.timer.clone(),
    );
    runtime.replica.load(&harness.account_id).await.unwrap();
    runtime.unlock_account(&harness.account_id).await.unwrap();
    store_session(&runtime, &harness.account_id, FIRST_TOKEN).await;
    let quick = crate::platform_storage::QuickUnlockDocument::new(
        harness.account_id.clone(),
        Incarnation::from(INCARNATION),
        bittery_crypto_core::EncryptedData {
            ciphertext: "ciphertext".into(),
            iv: "iv".into(),
            algorithm: "AES-GCM-AAD-V1".into(),
        },
        "A3-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXYZ2".into(),
        START_MS,
        Some(START_MS),
        true,
    )
    .unwrap();
    runtime
        .platform_storage
        .store_quick_unlock(&quick)
        .await
        .unwrap();
    runtime
        .platform_storage
        .store_device_key(&DeviceKeyDocument::new([7; 32]))
        .await
        .unwrap();
    runtime
        .platform_storage
        .store_device_catalog(
            &DeviceCatalogDocument::new(vec![DeviceCatalogAccount {
                account_id: harness.account_id.clone(),
                active_incarnation: Some(INCARNATION.into()),
                pending_retirement: None,
                pending_install: None,
            }])
            .unwrap(),
        )
        .await
        .unwrap();
    runtime
        .request(
            RuntimeRequest::CreateItem {
                account_id: harness.account_id.clone(),
                vault_id: crate::test_fixtures::TEST_VAULT_ID.into(),
                draft: draft(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let accepted = runtime
        .replica
        .snapshot(&harness.account_id)
        .unwrap()
        .operations
        .len();
    tokio::select! {
        () = runtime.clone().run_operation_dispatch() => panic!("driver stopped"),
        () = async {
            for _ in 0..200 { tokio::task::yield_now().await; }
            let status = runtime.projection(&ObservationRequest::RuntimeStatus { account_id:None }).unwrap().projection;
            let RuntimeProjection::RuntimeStatus(status) = status else { panic!("status") };
            assert_eq!(status.accounts[0].access,AccountAccessState::Locked);
            assert_eq!(status.accounts[0].waiting_reason,Some(AccountWaitingReason::ReauthenticationRequired));
        } => {}
    }
    assert!(runtime
        .platform_storage
        .load_current_session(&harness.account_id, &Incarnation::from(INCARNATION))
        .await
        .unwrap()
        .is_none());
    let retained = runtime
        .platform_storage
        .load_quick_unlock(&harness.account_id, &Incarnation::from(INCARNATION))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retained.secret_key.as_ref(), quick.secret_key.as_ref());
    assert_eq!(
        runtime
            .replica
            .snapshot(&harness.account_id)
            .unwrap()
            .operations
            .len(),
        accepted
    );
    runtime.close().await;
    let reopened = Runtime::with_configured_serialized_executors(
        harness.replica.clone(),
        harness.platform.clone(),
        server,
        AuthClientConfig::new("desktop".into(), ClientPlatform::Desktop, "test".into()).unwrap(),
    );
    reopened.open().await.unwrap();
    let RuntimeProjection::RuntimeStatus(status) = reopened
        .projection(&ObservationRequest::RuntimeStatus { account_id: None })
        .unwrap()
        .projection
    else {
        panic!("status")
    };
    assert_eq!(
        status.accounts[0].access,
        AccountAccessState::Locked,
        "retained Quick Unlock survives reopen"
    );
    assert!(
        reopened
            .platform_storage
            .load_current_session(&harness.account_id, &INCARNATION.into())
            .await
            .unwrap()
            .is_none(),
        "reopen cannot restore the refused Session"
    );
    assert_eq!(
        reopened
            .replica
            .snapshot(&harness.account_id)
            .unwrap()
            .operations
            .len(),
        accepted
    );
    reopened.close().await;
}

async fn configured_refresh(
    server: Arc<RefreshServer>,
    platform: ClientPlatform,
) -> (Arc<Runtime>, Harness) {
    let harness = seeded(true).await;
    let runtime = Runtime::with_test_dispatch_environment(
        harness.replica.clone(),
        harness.platform.clone(),
        server,
        AuthClientConfig::new("refresh-test".into(), platform, "test".into()).unwrap(),
        harness.clock.clone(),
        harness.timer.clone(),
    );
    runtime.replica.load(&harness.account_id).await.unwrap();
    runtime.unlock_account(&harness.account_id).await.unwrap();
    store_session(&runtime, &harness.account_id, FIRST_TOKEN).await;
    (runtime, harness)
}
async fn settle() {
    for _ in 0..100 {
        tokio::task::yield_now().await;
    }
}

#[tokio::test]
async fn locked_validation_uses_five_minutes_and_unlock_refreshes_metadata_immediately() {
    let server = RefreshServer::new([]);
    let (runtime, h) = configured_refresh(server.clone(), ClientPlatform::Desktop).await;
    runtime
        .request(
            RuntimeRequest::Lock {
                account_id: h.account_id.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let driver = tokio::spawn(runtime.clone().run_operation_dispatch());
    settle().await;
    assert_eq!(server.requests.lock().unwrap().len(), 1);
    let metadata = runtime
        .platform_storage
        .load_account_metadata(&h.account_id, &INCARNATION.into())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        metadata.team_name, None,
        "locked validation is not metadata refresh"
    );
    h.clock.advance(299_999);
    runtime.wake_dispatch();
    settle().await;
    assert_eq!(server.requests.lock().unwrap().len(), 1);
    h.clock.advance(1);
    runtime.wake_dispatch();
    settle().await;
    assert_eq!(server.requests.lock().unwrap().len(), 2);
    runtime.unlock_account(&h.account_id).await.unwrap();
    runtime.wake_dispatch();
    settle().await;
    assert_eq!(
        server.requests.lock().unwrap().len(),
        3,
        "unlock mounts metadata refresh immediately"
    );
    h.clock.advance(59_999);
    runtime.wake_dispatch();
    settle().await;
    assert_eq!(server.requests.lock().unwrap().len(), 3);
    h.clock.advance(1);
    runtime.wake_dispatch();
    settle().await;
    assert_eq!(server.requests.lock().unwrap().len(), 4);
    runtime.close().await;
    driver.await.unwrap();
}

#[tokio::test]
async fn web_driver_does_not_activate_desktop_account_refresh() {
    let server = RefreshServer::new([]);
    let (runtime, h) = configured_refresh(server.clone(), ClientPlatform::Web).await;
    let driver = tokio::spawn(runtime.clone().run_operation_dispatch());
    settle().await;
    h.clock.advance(300_000);
    runtime.wake_dispatch();
    settle().await;
    assert!(server.requests.lock().unwrap().is_empty());
    runtime.close().await;
    driver.await.unwrap();
}

#[tokio::test]
async fn successful_session_renewal_retries_once_with_the_new_bearer() {
    let server = RefreshServer::new([401, 200, 200]);
    let (runtime, h) = configured_refresh(server.clone(), ClientPlatform::Desktop).await;
    let driver = tokio::spawn(runtime.clone().run_operation_dispatch());
    settle().await;
    let requests = server.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 3);
    assert_eq!(
        requests[0]["headers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|h| h["name"]
                .as_str()
                .unwrap()
                .eq_ignore_ascii_case("authorization"))
            .unwrap()["value"],
        format!("Bearer {FIRST_TOKEN}")
    );
    assert_eq!(
        requests[2]["headers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|h| h["name"]
                .as_str()
                .unwrap()
                .eq_ignore_ascii_case("authorization"))
            .unwrap()["value"],
        format!("Bearer {SECOND_TOKEN}")
    );
    assert_eq!(
        runtime
            .platform_storage
            .load_current_session(&h.account_id, &INCARNATION.into())
            .await
            .unwrap()
            .unwrap()
            .token
            .as_ref(),
        SECOND_TOKEN
    );
    runtime.close().await;
    driver.await.unwrap();
}

#[tokio::test]
async fn lock_cancels_a_held_refresh_and_never_publishes_its_late_metadata() {
    let server = RefreshServer::new([]);
    server.hold.store(true, Ordering::SeqCst);
    let (runtime, h) = configured_refresh(server.clone(), ClientPlatform::Desktop).await;
    let driver = tokio::spawn(runtime.clone().run_operation_dispatch());
    server.entered.acquire().await.unwrap().forget();
    runtime
        .request(
            RuntimeRequest::Lock {
                account_id: h.account_id.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    server.release.add_permits(1);
    settle().await;
    assert!(server.cancelled.load(Ordering::SeqCst) > 0);
    let metadata = runtime
        .platform_storage
        .load_account_metadata(&h.account_id, &INCARNATION.into())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(metadata.team_name, None);
    assert!(runtime
        .platform_storage
        .load_current_session(&h.account_id, &INCARNATION.into())
        .await
        .unwrap()
        .is_some());
    runtime.close().await;
    driver.await.unwrap();
}

struct FailingSessionDelete {
    inner: Arc<MemoryPlatform>,
    deletes: AtomicU64,
    effect_before_error: bool,
}
#[async_trait]
impl SerializedPlatformStorageExecutor for FailingSessionDelete {
    async fn invoke(&self, request: Zeroizing<String>) -> Result<Zeroizing<String>, RuntimeError> {
        let value: Value = serde_json::from_str(&request).unwrap();
        if value["type"] == "delete"
            && value["key"]
                .as_str()
                .is_some_and(|key| key.ends_with("current-session"))
            && self.deletes.fetch_add(1, Ordering::SeqCst) == 0
        {
            if self.effect_before_error {
                self.inner.invoke(request.clone()).await?;
            }
            return Err(RuntimeError::new(
                RuntimeErrorCode::StorageUnavailable,
                "injected Session deletion failure",
            ));
        }
        self.inner.invoke(request).await
    }
}

async fn check_cleanup_retry(effect_before_error: bool) {
    let h = seeded(true).await;
    let platform = Arc::new(FailingSessionDelete {
        inner: h.platform.clone(),
        deletes: AtomicU64::new(0),
        effect_before_error,
    });
    let server = RefreshServer::new([401, 401]);
    let runtime = Runtime::with_test_dispatch_environment(
        h.replica.clone(),
        platform.clone(),
        server.clone(),
        AuthClientConfig::new("desktop".into(), ClientPlatform::Desktop, "test".into()).unwrap(),
        h.clock.clone(),
        h.timer.clone(),
    );
    runtime.replica.load(&h.account_id).await.unwrap();
    runtime.unlock_account(&h.account_id).await.unwrap();
    store_session(&runtime, &h.account_id, FIRST_TOKEN).await;
    let driver = tokio::spawn(runtime.clone().run_operation_dispatch());
    settle().await;
    assert_eq!(platform.deletes.load(Ordering::SeqCst), 1);
    assert_eq!(
        runtime
            .platform_storage
            .load_current_session(&h.account_id, &INCARNATION.into())
            .await
            .unwrap()
            .is_none(),
        effect_before_error
    );
    let RuntimeProjection::RuntimeStatus(status) = runtime
        .projection(&ObservationRequest::RuntimeStatus { account_id: None })
        .unwrap()
        .projection
    else {
        panic!("status")
    };
    assert_eq!(status.accounts[0].access, AccountAccessState::Locked);
    assert_eq!(
        status.accounts[0].waiting_reason,
        Some(AccountWaitingReason::ReauthenticationRequired)
    );
    h.clock.advance(999);
    runtime.wake_dispatch();
    settle().await;
    assert_eq!(platform.deletes.load(Ordering::SeqCst), 1);
    h.clock.advance(1);
    runtime.wake_dispatch();
    settle().await;
    assert_eq!(
        platform.deletes.load(Ordering::SeqCst),
        2,
        "failed cleanup must not park forever behind its own reauthentication state"
    );
    assert!(runtime
        .platform_storage
        .load_current_session(&h.account_id, &INCARNATION.into())
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        server.requests.lock().unwrap().len(),
        2,
        "cleanup retry performs no HTTP"
    );
    assert_eq!(
        runtime.replica.snapshot(&h.account_id).unwrap().lock_epoch,
        1,
        "cleanup completes the original pending retirement"
    );
    runtime.close().await;
    driver.await.unwrap();
}

#[tokio::test]
async fn refused_session_storage_failure_retries_cleanup_at_a_bounded_deadline() {
    check_cleanup_retry(false).await;
}
#[tokio::test]
async fn ambiguous_session_deletion_finishes_only_its_existing_pending_retirement() {
    check_cleanup_retry(true).await;
}

#[tokio::test]
async fn transient_and_malformed_account_reads_preserve_local_authority_until_next_interval() {
    for malformed in [false, true] {
        let server = RefreshServer::new(if malformed {
            vec![200, 200]
        } else {
            vec![503, 200]
        });
        server.malformed.store(malformed, Ordering::SeqCst);
        let (runtime, h) = configured_refresh(server.clone(), ClientPlatform::Desktop).await;
        let before = runtime
            .platform_storage
            .load_current_session(&h.account_id, &INCARNATION.into())
            .await
            .unwrap();
        let driver = tokio::spawn(runtime.clone().run_operation_dispatch());
        settle().await;
        assert_eq!(server.requests.lock().unwrap().len(), 1);
        assert!(
            runtime
                .platform_storage
                .load_current_session(&h.account_id, &INCARNATION.into())
                .await
                .unwrap()
                == before
        );
        assert_eq!(
            runtime
                .platform_storage
                .load_account_metadata(&h.account_id, &INCARNATION.into())
                .await
                .unwrap()
                .unwrap()
                .team_name,
            None
        );
        h.clock.advance(59_999);
        runtime.wake_dispatch();
        settle().await;
        assert_eq!(server.requests.lock().unwrap().len(), 1);
        server.malformed.store(false, Ordering::SeqCst);
        h.clock.advance(1);
        runtime.wake_dispatch();
        settle().await;
        assert_eq!(
            runtime
                .platform_storage
                .load_account_metadata(&h.account_id, &INCARNATION.into())
                .await
                .unwrap()
                .unwrap()
                .team_name
                .as_deref(),
            Some("New Team")
        );
        runtime.close().await;
        driver.await.unwrap();
    }
}

#[tokio::test]
async fn a_held_read_cannot_publish_after_another_request_replaces_its_session() {
    let server = RefreshServer::new([]);
    server.hold.store(true, Ordering::SeqCst);
    let (runtime, h) = configured_refresh(server.clone(), ClientPlatform::Desktop).await;
    let driver = tokio::spawn(runtime.clone().run_operation_dispatch());
    server.entered.acquire().await.unwrap().forget();
    store_session(&runtime, &h.account_id, SECOND_TOKEN).await;
    server.release.add_permits(1);
    settle().await;
    assert_eq!(
        runtime
            .platform_storage
            .load_account_metadata(&h.account_id, &INCARNATION.into())
            .await
            .unwrap()
            .unwrap()
            .team_name,
        None
    );
    assert_eq!(
        runtime
            .platform_storage
            .load_current_session(&h.account_id, &INCARNATION.into())
            .await
            .unwrap()
            .unwrap()
            .token
            .as_ref(),
        SECOND_TOKEN
    );
    runtime.close().await;
    driver.await.unwrap();
}

#[tokio::test]
async fn close_and_removal_cancel_pending_account_reads_and_leave_no_late_writes() {
    for remove in [false, true] {
        let server = RefreshServer::new([]);
        server.hold.store(true, Ordering::SeqCst);
        let (runtime, h) = configured_refresh(server.clone(), ClientPlatform::Desktop).await;
        let driver = tokio::spawn(runtime.clone().run_operation_dispatch());
        server.entered.acquire().await.unwrap().forget();
        if remove {
            runtime
                .request(
                    RuntimeRequest::RemoveAccount {
                        account_id: h.account_id.clone(),
                    },
                    RequestCancellation::new(),
                )
                .await
                .unwrap();
        } else {
            runtime.close().await;
        }
        let after = h.platform.values.lock().unwrap().clone();
        server.release.add_permits(1);
        settle().await;
        assert_eq!(*h.platform.values.lock().unwrap(), after);
        assert!(server.cancelled.load(Ordering::SeqCst) > 0);
        runtime.close().await;
        driver.await.unwrap();
    }
}

async fn install_generation_from(
    runtime: &Runtime,
    source: &AccountId,
    target: AccountId,
    incarnation: Incarnation,
) {
    let mut metadata = runtime
        .platform_storage
        .load_account_metadata(source, &INCARNATION.into())
        .await
        .unwrap()
        .unwrap();
    let mut session = runtime
        .platform_storage
        .load_current_session(source, &INCARNATION.into())
        .await
        .unwrap()
        .unwrap();
    metadata.account_id = target.clone();
    metadata.incarnation = incarnation.clone();
    metadata.normalized_server_url = "https://another-server.example.test".into();
    session.account_id = target.clone();
    session.incarnation = incarnation.clone();
    let session = crate::platform_storage::CurrentSessionDocument::new(
        session.account_id.clone(),
        session.incarnation.clone(),
        SECOND_TOKEN.into(),
        session.session_id.clone(),
        session.expires_at_ms,
        session.server_expires_at_ms,
        session.vault_keys.clone(),
        session.encrypted_private_key.clone(),
    )
    .unwrap();
    runtime
        .install_or_replace_account(target, USER.into(), incarnation)
        .await
        .unwrap();
    runtime
        .platform_storage
        .store_account_metadata(&metadata)
        .await
        .unwrap();
    runtime
        .platform_storage
        .store_current_session(&session)
        .await
        .unwrap();
}

#[tokio::test]
async fn a_slow_account_does_not_block_another_accounts_scoped_refresh() {
    let server = RefreshServer::new([]);
    server.hold.store(true, Ordering::SeqCst);
    let (runtime, h) = configured_refresh(server.clone(), ClientPlatform::Desktop).await;
    let driver = tokio::spawn(runtime.clone().run_operation_dispatch());
    server.entered.acquire().await.unwrap().forget();
    let other = AccountId::from("another-account");
    let incarnation = Incarnation::from("another-generation");
    install_generation_from(&runtime, &h.account_id, other.clone(), incarnation.clone()).await;
    runtime.unlock_account(&other).await.unwrap();
    runtime.wake_dispatch();
    settle().await;
    assert_eq!(
        runtime
            .platform_storage
            .load_account_metadata(&other, &incarnation)
            .await
            .unwrap()
            .unwrap()
            .team_name
            .as_deref(),
        Some("New Team")
    );
    assert_eq!(
        runtime
            .platform_storage
            .load_account_metadata(&h.account_id, &INCARNATION.into())
            .await
            .unwrap()
            .unwrap()
            .team_name,
        None
    );
    runtime.close().await;
    driver.await.unwrap();
}

#[tokio::test]
async fn replacement_before_refusal_cleanup_retry_preserves_the_new_session() {
    let h = seeded(true).await;
    let platform = Arc::new(FailingSessionDelete {
        inner: h.platform.clone(),
        deletes: AtomicU64::new(0),
        effect_before_error: false,
    });
    let server = RefreshServer::new([401, 401]);
    let runtime = Runtime::with_test_dispatch_environment(
        h.replica.clone(),
        platform.clone(),
        server,
        AuthClientConfig::new("desktop".into(), ClientPlatform::Desktop, "test".into()).unwrap(),
        h.clock.clone(),
        h.timer.clone(),
    );
    runtime.replica.load(&h.account_id).await.unwrap();
    runtime.unlock_account(&h.account_id).await.unwrap();
    store_session(&runtime, &h.account_id, FIRST_TOKEN).await;
    let driver = tokio::spawn(runtime.clone().run_operation_dispatch());
    settle().await;
    assert_eq!(platform.deletes.load(Ordering::SeqCst), 1);
    let incarnation = Incarnation::from("replacement-generation");
    install_generation_from(
        &runtime,
        &h.account_id,
        h.account_id.clone(),
        incarnation.clone(),
    )
    .await;
    h.clock.advance(1_000);
    runtime.wake_dispatch();
    settle().await;
    assert_eq!(platform.deletes.load(Ordering::SeqCst), 1);
    assert_eq!(
        runtime
            .platform_storage
            .load_current_session(&h.account_id, &incarnation)
            .await
            .unwrap()
            .unwrap()
            .token
            .as_ref(),
        SECOND_TOKEN
    );
    runtime.close().await;
    driver.await.unwrap();
}

#[tokio::test]
async fn stale_refusal_waiting_for_lifecycle_cannot_fence_new_device_setup_disclosure() {
    let (runtime, h) = configured_refresh(RefreshServer::new([]), ClientPlatform::Desktop).await;
    let old = runtime
        .platform_storage
        .load_current_session(&h.account_id, &INCARNATION.into())
        .await
        .unwrap()
        .unwrap();
    let incarnation = Incarnation::from("new-generation");
    install_generation_from(
        &runtime,
        &h.account_id,
        h.account_id.clone(),
        incarnation.clone(),
    )
    .await;
    runtime.unlock_account(&h.account_id).await.unwrap();
    let quick = crate::platform_storage::QuickUnlockDocument::new(
        h.account_id.clone(),
        incarnation,
        bittery_crypto_core::EncryptedData {
            ciphertext: "ciphertext".into(),
            iv: "iv".into(),
            algorithm: "AES-GCM-AAD-V1".into(),
        },
        "A3-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXYZ2".into(),
        START_MS,
        Some(START_MS),
        true,
    )
    .unwrap();
    runtime
        .platform_storage
        .store_quick_unlock(&quick)
        .await
        .unwrap();
    let response = runtime
        .request(
            RuntimeRequest::DeviceSetup {
                account_id: h.account_id.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let lifecycle = runtime.account_lifecycle_lock(&h.account_id).unwrap();
    let held = lifecycle.lock().await;
    let mut refusal = Box::pin(runtime.retire_refused_session(&old, 0));
    std::future::poll_fn(|cx| {
        assert!(std::future::Future::poll(refusal.as_mut(), cx).is_pending());
        std::task::Poll::Ready(())
    })
    .await;
    let encoded = runtime.encode_outcome(crate::RuntimeOutcome::Succeeded(response));
    assert!(
        encoded.is_ok(),
        "stale background refusal must not fence a current disclosure"
    );
    drop(held);
    assert!(matches!(
        refusal.await,
        Err(RuntimeError {
            code: RuntimeErrorCode::Cancelled,
            ..
        })
    ));
    runtime.close().await;
}

struct HeldSessionRead {
    inner: Arc<MemoryPlatform>,
    reads: AtomicU64,
    entered: tokio::sync::Semaphore,
    release: tokio::sync::Semaphore,
}
#[async_trait]
impl SerializedPlatformStorageExecutor for HeldSessionRead {
    async fn invoke(&self, request: Zeroizing<String>) -> Result<Zeroizing<String>, RuntimeError> {
        let value: Value = serde_json::from_str(&request).unwrap();
        if value["type"] == "get"
            && value["key"]
                .as_str()
                .is_some_and(|key| key.ends_with("current-session"))
            && self.reads.fetch_add(1, Ordering::SeqCst) == 1
        {
            self.entered.add_permits(1);
            self.release.acquire().await.unwrap().forget();
        }
        self.inner.invoke(request).await
    }
}
#[tokio::test]
async fn lock_during_session_recheck_prevents_a_late_authentication_refresh() {
    let h = seeded(true).await;
    let platform = Arc::new(HeldSessionRead {
        inner: h.platform.clone(),
        reads: AtomicU64::new(0),
        entered: tokio::sync::Semaphore::new(0),
        release: tokio::sync::Semaphore::new(0),
    });
    let server = RefreshServer::new([401, 200, 200]);
    let runtime = Runtime::with_test_dispatch_environment(
        h.replica.clone(),
        platform.clone(),
        server.clone(),
        AuthClientConfig::new("desktop".into(), ClientPlatform::Desktop, "test".into()).unwrap(),
        h.clock.clone(),
        h.timer.clone(),
    );
    runtime.replica.load(&h.account_id).await.unwrap();
    runtime.unlock_account(&h.account_id).await.unwrap();
    store_session(&runtime, &h.account_id, FIRST_TOKEN).await;
    let driver = tokio::spawn(runtime.clone().run_operation_dispatch());
    platform.entered.acquire().await.unwrap().forget();
    let locking = tokio::spawn({
        let runtime = runtime.clone();
        let account_id = h.account_id.clone();
        async move {
            runtime
                .request(
                    RuntimeRequest::Lock { account_id },
                    RequestCancellation::new(),
                )
                .await
        }
    });
    settle().await;
    platform.release.add_permits(1);
    locking.await.unwrap().unwrap();
    settle().await;
    assert_eq!(
        server.requests.lock().unwrap().len(),
        1,
        "queued Lock prevents new renewal HTTP after a held Session recheck"
    );
    runtime.close().await;
    driver.await.unwrap();
}

#[tokio::test]
async fn stale_session_refresh_cannot_restore_a_retired_vault_key() {
    let harness = seeded(true).await;
    let runtime = &harness.runtime;
    store_session(runtime, &harness.account_id, FIRST_TOKEN).await;
    let incarnation = Incarnation::from(INCARNATION);
    let mut original = runtime
        .platform_storage
        .load_current_session(&harness.account_id, &incarnation)
        .await
        .unwrap()
        .unwrap();
    original.vault_keys = ["retired-vault", "visible-vault"]
        .into_iter()
        .map(|vault_id| {
            let authority = crate::test_fixtures::personal_vault(vault_id, USER);
            crate::server_contract::AuthVaultKeyResponse {
                encrypted_vault_key: authority.encrypted_vault_key,
                role: crate::server_contract::VaultRole::Owner,
                vault_icon: None,
                vault_id: vault_id.into(),
                vault_image_url: None,
                vault_name: "Vault".into(),
                vault_type: crate::server_contract::VaultType::Personal,
            }
        })
        .collect();
    runtime
        .platform_storage
        .store_current_session(&original)
        .await
        .unwrap();
    let mut pruned = original.clone();
    pruned
        .vault_keys
        .retain(|key| key.vault_id != "retired-vault");
    runtime
        .platform_storage
        .store_current_session(&pruned)
        .await
        .unwrap();
    let execution = runtime.account_execution_lock(&harness.account_id).unwrap();
    let _execution = execution.lock().await;
    let result = runtime
        .store_renewed_session(
            &original,
            crate::server_contract::RefreshSessionResponse {
                token: SECOND_TOKEN.into(),
                session_id: "session-1".into(),
                expires_at: "2030-01-01T00:00:00Z".into(),
            },
        )
        .await;
    assert!(
        matches!(result, Err(error) if error.code == RuntimeErrorCode::Cancelled),
        "a stale refresh must not restore removed wrapped Vault keys"
    );
    let current = runtime
        .platform_storage
        .load_current_session(&harness.account_id, &incarnation)
        .await
        .unwrap()
        .unwrap();
    assert!(
        current == pruned,
        "all current Session fields must survive stale replacement"
    );
    let renewed = runtime
        .store_renewed_session(
            &pruned,
            crate::server_contract::RefreshSessionResponse {
                token: SECOND_TOKEN.into(),
                session_id: "session-1".into(),
                expires_at: "2030-01-01T00:00:00Z".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(renewed.token.as_ref(), SECOND_TOKEN);
    assert_eq!(renewed.vault_keys.len(), 1);
    assert_eq!(renewed.vault_keys[0].vault_id, "visible-vault");
    assert_eq!(renewed.encrypted_private_key, pruned.encrypted_private_key);
}

#[tokio::test]
async fn independent_session_replacement_preserves_account_and_native_provenance() {
    let harness = seeded(true).await;
    let runtime = &harness.runtime;
    store_session(runtime, &harness.account_id, FIRST_TOKEN).await;
    let incarnation = Incarnation::from(INCARNATION);
    let expected = runtime
        .platform_storage
        .load_current_session(&harness.account_id, &incarnation)
        .await
        .unwrap()
        .unwrap();
    let execution = runtime.account_execution_lock(&harness.account_id).unwrap();
    let _execution = execution.lock().await;
    let mut other_account = expected.clone();
    other_account.account_id = AccountId::from("other-account");
    let mut other_incarnation = expected.clone();
    other_incarnation.incarnation = Incarnation::from("replacement-incarnation");
    let mut borrowed = expected.clone();
    borrowed.provenance = crate::platform_storage::SessionProvenance::Borrowed {
        grant_id: "native-grant".into(),
    };
    for replacement in [other_account, other_incarnation, borrowed] {
        assert!(
            matches!(runtime.replace_independent_session(&expected, replacement).await,
            Err(error) if error.code == RuntimeErrorCode::Cancelled)
        );
    }
    let current = runtime
        .platform_storage
        .load_current_session(&harness.account_id, &incarnation)
        .await
        .unwrap()
        .unwrap();
    assert!(current == expected);
}

#[tokio::test]
async fn owner_close_during_session_comparison_prevents_late_credential_replacement() {
    let h = seeded(true).await;
    let platform = Arc::new(HeldSessionRead {
        inner: h.platform.clone(),
        reads: AtomicU64::new(0),
        entered: tokio::sync::Semaphore::new(0),
        release: tokio::sync::Semaphore::new(0),
    });
    let runtime = Runtime::with_test_dispatch_environment(
        h.replica.clone(),
        platform.clone(),
        h.server.clone(),
        AuthClientConfig::new("desktop".into(), ClientPlatform::Desktop, "test".into()).unwrap(),
        h.clock.clone(),
        h.timer.clone(),
    );
    runtime.replica.load(&h.account_id).await.unwrap();
    runtime.unlock_account(&h.account_id).await.unwrap();
    store_session(&runtime, &h.account_id, FIRST_TOKEN).await;
    let expected = runtime
        .platform_storage
        .load_current_session(&h.account_id, &INCARNATION.into())
        .await
        .unwrap()
        .unwrap();
    let renewing = tokio::spawn({
        let runtime = runtime.clone();
        let expected = expected.clone();
        async move {
            let execution = runtime
                .account_execution_lock(&expected.account_id)
                .unwrap();
            let _execution = execution.lock().await;
            runtime
                .store_renewed_session(
                    &expected,
                    crate::server_contract::RefreshSessionResponse {
                        token: SECOND_TOKEN.into(),
                        session_id: "session-1".into(),
                        expires_at: "2030-01-01T00:00:00Z".into(),
                    },
                )
                .await
        }
    });
    platform.entered.acquire().await.unwrap().forget();
    let closing = tokio::spawn({
        let runtime = runtime.clone();
        async move { runtime.close().await }
    });
    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        while !runtime.is_closed() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    platform.release.add_permits(1);
    let result = renewing.await.unwrap();
    closing.await.unwrap();
    assert!(
        matches!(result, Err(error) if error.code == RuntimeErrorCode::RuntimeClosed),
        "closed owner must not replace credentials after a held comparison"
    );
    let current = runtime
        .platform_storage
        .load_current_session(&h.account_id, &INCARNATION.into())
        .await
        .unwrap()
        .unwrap();
    assert!(current == expected);
}
