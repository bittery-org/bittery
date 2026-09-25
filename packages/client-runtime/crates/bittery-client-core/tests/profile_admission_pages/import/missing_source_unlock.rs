//! Genuine host credentials around unchanged producer cache/queue evidence.
use super::*;
use base64::Engine;
use bittery_client_core::{CrossAccountMoveResumeGuard, RequestCancellation, RuntimeRequest};

const PASSWORD: &str = "parked acknowledgement fixture password";

#[path = "missing_source_lifecycle.rs"]
mod lifecycle_tests;

#[path = "missing_source_sync.rs"]
mod sync_tests;

#[path = "missing_source_retry.rs"]
mod retry_tests;

#[path = "missing_source_failed.rs"]
mod failed_tests;

#[path = "missing_source_failed_zero.rs"]
mod failed_zero_tests;

#[path = "missing_source_conflicted.rs"]
mod conflicted_tests;

#[path = "missing_source_post_retry_held.rs"]
mod post_retry_held_tests;

#[path = "missing_source_reconciliation_held.rs"]
mod reconciliation_held_tests;

#[path = "missing_source_retained_deadline.rs"]
mod retained_deadline_tests;

#[path = "missing_source_preprojection.rs"]
mod preprojection_tests;

const ADMISSION_SRP_SALT: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const ADMISSION_SRP_ATTEMPT: &str = "actual-cache-login-attempt";

struct AdmissionSrpState {
    server: bittery_crypto_core::SrpServer,
    verifier: String,
    server_ephemeral: bittery_crypto_core::srp6a::Ephemeral,
}

struct AdmissionSrpNetwork {
    state: Mutex<AdmissionSrpState>,
    calls: std::sync::atomic::AtomicU64,
    refresh_calls: Mutex<Vec<String>>,
    offline: std::sync::atomic::AtomicBool,
    kdf_profile: bittery_crypto_core::KdfProfile,
    email: String,
    user_id: String,
    secret_key_hint: String,
    vault_id: String,
    wrapped_vault_key: String,
    vault_name: String,
    vault_role: &'static str,
}

impl AdmissionSrpNetwork {
    fn new(
        master_password: &str,
        secret_key: &str,
        account: &Value,
        vault: &Value,
        wrapped_vault_key: String,
        kdf_profile: bittery_crypto_core::KdfProfile,
    ) -> Result<Self, String> {
        use bittery_crypto_core::srp6a::{HashAlgorithm, PrimeGroup};

        let email = account["email"].as_str().unwrap().to_owned();
        let user_id = account["userId"].as_str().unwrap().to_owned();
        let vault_id = vault["id"].as_str().unwrap().to_owned();
        let vault_name = vault["name"].as_str().unwrap().to_owned();

        let client = bittery_crypto_core::SrpClient::new(HashAlgorithm::Sha256, PrimeGroup::G4096);
        let server = bittery_crypto_core::SrpServer::new(HashAlgorithm::Sha256, PrimeGroup::G4096);
        let derived =
            bittery_crypto_core::derive_keys(master_password, secret_key, &email, &kdf_profile)
                .map_err(|_| "Cannot derive actual cached SRP verifier")?;
        let srp_password = Zeroizing::new(String::from_utf8_lossy(&derived.auth_key).into_owned());
        let private_key = Zeroizing::new(
            client
                .derive_safe_private_key(ADMISSION_SRP_SALT, &srp_password, None)
                .map_err(|_| "Cannot derive actual cached SRP private key")?,
        );
        let verifier = client
            .derive_verifier(&private_key)
            .map_err(|_| "Cannot derive actual cached SRP verifier")?;
        let server_ephemeral = server
            .generate_ephemeral(&verifier)
            .map_err(|_| "Cannot generate actual cached SRP challenge")?;
        Ok(Self {
            state: Mutex::new(AdmissionSrpState {
                server,
                verifier,
                server_ephemeral,
            }),
            calls: std::sync::atomic::AtomicU64::new(0),
            refresh_calls: Mutex::new(Vec::new()),
            offline: std::sync::atomic::AtomicBool::new(false),
            kdf_profile,
            email,
            user_id,
            secret_key_hint: bittery_crypto_core::get_secret_key_hint(secret_key),
            vault_id,
            wrapped_vault_key,
            vault_name,
            vault_role: "owner",
        })
    }

    fn call_count(&self) -> u64 {
        self.calls.load(std::sync::atomic::Ordering::SeqCst)
    }
}

fn admission_http_completed(status: u16, body: serde_json::Value) -> String {
    json!({
        "type":"completed",
        "status":status,
        "headers":[{"name":"Content-Type","value":"application/json"}],
        "body":serde_json::to_vec(&body).expect("fixture response serializes")
    })
    .to_string()
}

#[async_trait]
impl SerializedHttpExecutor for AdmissionSrpNetwork {
    async fn invoke(&self, request_json: Zeroizing<String>) -> Result<String, RuntimeError> {
        self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if self.offline.load(std::sync::atomic::Ordering::SeqCst) {
            return Ok(json!({"type":"networkFailure"}).to_string());
        }
        let request: serde_json::Value =
            serde_json::from_str(&request_json).expect("Runtime emits typed HTTP requests");
        let url = request["url"]
            .as_str()
            .expect("Runtime HTTP request has a URL");
        if url.ends_with("/api/v1/auth/me") {
            assert_eq!(request["method"], "GET");
            self.refresh_calls.lock().unwrap().push(url.to_owned());
            // The public driver also starts Account refresh. Keep that independent request
            // in flight so the dispatch scan can be checked without a metadata response.
            return std::future::pending().await;
        }
        if url.ends_with("/api/v1/auth/login-attempts") {
            let body: Vec<u8> =
                serde_json::from_value(request["body"].clone()).expect("start body is bytes");
            let body: serde_json::Value =
                serde_json::from_slice(&body).expect("start body is JSON");
            assert_eq!(body["email"], self.email);
            let state = self.state.lock().unwrap();
            return Ok(admission_http_completed(
                201,
                json!({
                    "attemptId":ADMISSION_SRP_ATTEMPT,
                    "kdfParams":{
                        "algorithm":self.kdf_profile.algorithm,
                        "iterations":self.kdf_profile.iterations,
                        "schemaVersion":self.kdf_profile.schema_version
                    },
                    "salt":ADMISSION_SRP_SALT,
                    "serverPublicKey":state.server_ephemeral.public
                }),
            ));
        }
        if url.ends_with(&format!(
            "/api/v1/auth/login-attempts/{ADMISSION_SRP_ATTEMPT}/finish"
        )) {
            let body: Vec<u8> =
                serde_json::from_value(request["body"].clone()).expect("finish body is bytes");
            let body: serde_json::Value =
                serde_json::from_slice(&body).expect("finish body is JSON");
            let state = self.state.lock().unwrap();
            let session = state
                .server
                .derive_session(
                    &state.server_ephemeral.secret,
                    body["clientPublicKey"]
                        .as_str()
                        .expect("finish has client public key"),
                    ADMISSION_SRP_SALT,
                    "",
                    &state.verifier,
                    body["clientProof"]
                        .as_str()
                        .expect("finish has client proof"),
                )
                .expect("Runtime must prove the fixture password and Secret Key");
            return Ok(admission_http_completed(
                200,
                json!({
                    "expiresAt":"2099-01-01T00:00:00Z",
                    "serverProof":session.proof,
                    "sessionId":"actual-cache-session",
                    "token":"actual-cache-token",
                    "user":{
                        "email":self.email,
                        "encryptedPrivateKey":"retained-private-key",
                        "id":self.user_id,
                        "name":"Actual cached admission",
                        "publicKey":"actual-cache-public-key",
                        "secretKeyHint":self.secret_key_hint,
                        "teamAvatarUrl":null,
                        "teamName":null
                    },
                    "vaultKeys":{
                        "hasMore":false,
                        "items":[{
                            "encryptedVaultKey":self.wrapped_vault_key,
                            "role":self.vault_role,
                            "vaultIcon":null,
                            "vaultId":self.vault_id,
                            "vaultImageUrl":null,
                            "vaultName":self.vault_name,
                            "vaultType":"personal"
                        }],
                        "nextCursor":null
                    }
                }),
            ));
        }
        if url
            .split(['?', '#'])
            .next()
            .is_some_and(|path| path.ends_with("/api/v1/travel-mode"))
        {
            return Ok(admission_http_completed(
                200,
                json!({
                    "enabled":false,
                    "enabledAt":null,
                    "hiddenVaultIds":[],
                    "updatedAt":"2026-09-21T00:00:00Z"
                }),
            ));
        }
        if url
            .split(['?', '#'])
            .next()
            .is_some_and(|path| path.ends_with("/api/v1/sync/changes"))
        {
            return Ok(admission_http_completed(
                200,
                json!({
                    "cursor":null,
                    "events":[],
                    "hasMore":false,
                    "requiresFullRefresh":false
                }),
            ));
        }
        panic!("unexpected HTTP outside the ordinary authentication ceremony: {url}")
    }

    fn cancel(&self, _: &str) {}
}

struct AccountNetworks {
    source: AdmissionSrpNetwork,
    target: AdmissionSrpNetwork,
}
impl AccountNetworks {
    fn call_count(&self) -> u64 {
        self.source.call_count() + self.target.call_count()
    }
}
#[async_trait]
impl SerializedHttpExecutor for AccountNetworks {
    async fn invoke(&self, request: Zeroizing<String>) -> Result<String, RuntimeError> {
        let value: Value = serde_json::from_str(&request).unwrap();
        let url = url::Url::parse(value["url"].as_str().unwrap()).unwrap();
        match url.origin().ascii_serialization().as_str() {
            SOURCE_SERVER => self.source.invoke(request).await,
            TARGET_SERVER => self.target.invoke(request).await,
            _ => panic!("unexpected Account origin"),
        }
    }
    fn cancel(&self, _: &str) {}
}

fn protected_crash_source() -> (Arc<Source>, Value, Arc<AccountNetworks>) {
    protected_crash_source_from(&acknowledgement_crash_oracle())
}

fn protected_crash_source_from(oracle: &Value) -> (Arc<Source>, Value, Arc<AccountNetworks>) {
    let (source, mut commands, network) = protected_crash_source_commands(oracle);
    assert_eq!(commands.len(), 1);
    (source, commands.remove(0), network)
}

fn protected_crash_source_commands(
    oracle: &Value,
) -> (Arc<Source>, Vec<Value>, Arc<AccountNetworks>) {
    let accounts = oracle["accounts"]
        .as_array()
        .expect("producer oracle accounts must be an array");
    let mut account_ids: Vec<_> = accounts
        .iter()
        .map(|account| {
            account["accountId"]
                .as_str()
                .expect("producer account must have an accountId")
        })
        .collect();
    account_ids.sort_unstable();
    let mut expected_ids = vec![desktop::ACCOUNT, SECOND_ACCOUNT];
    expected_ids.sort_unstable();
    assert_eq!(
        account_ids, expected_ids,
        "producer oracle must contain exactly the source and target Accounts"
    );
    let (mut source, commands) = acknowledgement_crash_source_commands(oracle);
    let fixture = Arc::get_mut(&mut source).unwrap();
    let device_key = [0x83; 32];
    fixture.inner.credentials[0] =
        Some(base64::engine::general_purpose::STANDARD.encode(device_key));
    let mut networks = std::collections::HashMap::new();
    for account in accounts {
        let id = account["accountId"].as_str().unwrap();
        let email = account["email"].as_str().unwrap();
        let user = account["userId"].as_str().unwrap();
        let vault = oracle["records"]
            .as_array()
            .unwrap()
            .iter()
            .find_map(|row| {
                let value: Value = serde_json::from_str(row["value"].as_str().unwrap()).unwrap();
                (value["accountId"] == id && value["type"] == "personal").then_some(value)
            })
            .unwrap();
        let vault_id = vault["id"].as_str().unwrap();
        let secret = bittery_crypto_core::generate_secret_key();
        let kdf = bittery_crypto_core::current_kdf_profile();
        let muk = bittery_crypto_core::derive_keys(PASSWORD, &secret, email, &kdf)
            .unwrap()
            .master_unlock_key;
        let encrypted = bittery_crypto_core::encrypt(
            &base64::engine::general_purpose::STANDARD.encode(muk),
            &device_key,
        )
        .unwrap();
        let wrapped = bittery_crypto_core::encrypt_vault_key_with_muk(
            &[0x47; 32],
            &muk,
            &bittery_crypto_core::VaultKeyWrapContext::new(vault_id, user, 1),
        )
        .unwrap();
        let session = json!({"encryptedMasterUnlockKey":encrypted,"email":email,"userId":user,"createdAt":1,"expiresAt":1209600000}).to_string();
        let keys = json!([{"vaultId":vault_id,"encryptedVaultKey":wrapped,"role":"owner",
            "vaultIcon":vault["icon"],"vaultImageUrl":vault["imageUrl"],"vaultName":vault["name"],"vaultType":"personal"}]).to_string();
        if id == desktop::ACCOUNT {
            fixture.inner.credentials[1] = Some(secret.clone());
            fixture.inner.credentials[2] = Some(session);
            fixture.inner.credentials[3] = None;
            fixture.inner.credentials[4] = Some(keys);
        } else {
            let credentials = fixture.second_credentials.as_mut().unwrap();
            credentials[0] = Some(secret.clone());
            credentials[1] = Some(session);
            credentials[2] = None;
            credentials[3] = Some(keys);
        }
        networks.insert(
            id,
            AdmissionSrpNetwork::new(PASSWORD, &secret, account, &vault, wrapped, kdf).unwrap(),
        );
    }
    let target = networks.remove(SECOND_ACCOUNT).unwrap();
    let source_http = networks.remove(desktop::ACCOUNT).unwrap();
    // Real credentials are host-only scaffolding: the actual account, cache and queue pages remain
    // byte-identical, and no source ciphertext or Attachment inventory has been manufactured.
    assert_eq!(
        fixture.inner.sync.as_deref(),
        Some(oracle["sync"].to_string().as_str())
    );
    (
        source,
        commands,
        Arc::new(AccountNetworks {
            source: source_http,
            target,
        }),
    )
}

async fn authenticated_runtime(
    directory: &TestDirectory,
    platform: Arc<dyn SerializedPlatformStorageExecutor>,
    network: Arc<dyn SerializedHttpExecutor>,
) -> Arc<Runtime> {
    let replica: Arc<dyn SerializedReplicaExecutor> =
        Arc::new(SqliteReplica::open(directory.0.join("replica.sqlite")).unwrap());
    let attachments = Arc::new(
        SqliteAttachmentArtifactStore::open(directory.0.join("attachments.sqlite")).unwrap(),
    );
    let runtime = Runtime::with_configured_serialized_executors_and_attachment_move_preparation(
        replica,
        platform,
        network.clone(),
        AuthClientConfig::new(
            "profile-pages".into(),
            ClientPlatform::Desktop,
            "0.5.2".into(),
        )
        .unwrap(),
        AttachmentMovePreparationFacade::new(attachments.clone(), attachments, Arc::new(NoNetwork)),
        Arc::new(LiveLeasePort),
    );
    runtime.install_vault_image_ingress(
        VaultImageIngressFacade::new(
            "profile-page-runtime",
            Arc::new(UnusedVaultImageSource),
            Arc::new(
                SqliteVaultImageArtifactStore::open(directory.0.join("vault-images.sqlite"))
                    .unwrap(),
            ),
        )
        .unwrap(),
    );
    runtime
}

#[tokio::test]
async fn actual_ack_crash_unlocks_from_source_free_sqlite_and_never_dispatches_parked_work() {
    let (source, command, network) = protected_crash_source();
    let frozen_store = source.inner.store.clone();
    let frozen_sync = source.inner.sync.clone();
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
    runtime.open().await.unwrap();
    assert_eq!(source.inner.store, frozen_store);
    assert_eq!(source.inner.sync, frozen_sync);
    assert_two_locked(&runtime);
    let original = row(
        &snapshot(&directory, desktop::ACCOUNT).await,
        "crossAccountMoves",
    );
    assert_eq!(network.call_count(), 0);
    runtime.close().await;
    let source_calls = source.calls.lock().unwrap().len();
    let reopened = authenticated_runtime(&directory, platform, network.clone()).await;
    reopened.open().await.unwrap();
    assert_two_locked(&reopened);
    assert_eq!(network.call_count(), 0);
    for account in [desktop::ACCOUNT, SECOND_ACCOUNT] {
        reopened
            .request(
                RuntimeRequest::QuickUnlock {
                    account_id: AccountId::from(account),
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
        panic!("status")
    };
    assert!(status
        .accounts
        .iter()
        .all(|account| account.access == AccountAccessState::Unlocked));
    observation.close();
    assert!(
        network.call_count() >= 6,
        "both Accounts use genuine SRP authentication"
    );
    assert_unavailable_resume_and_dispatch(&reopened, &directory, &network, &command).await;
    let source_before = snapshot(&directory, desktop::ACCOUNT).await;
    assert_eq!(row(&source_before, "crossAccountMoves"), original);
    assert!(source_before["rows"]
        .as_array()
        .unwrap()
        .iter()
        .all(|row| row["store"] != "authorityItems"
            && row["store"] != "optimisticItems"
            && row["store"] != "operations"));
    assert_parked_projection(&reopened, command["operationId"].as_str().unwrap());
    assert_eq!(source.calls.lock().unwrap().len(), source_calls);
    assert_eq!(source.inner.store, frozen_store);
    assert_eq!(source.inner.sync, frozen_sync);
    reopened.close().await;
}

/// The combined public driver performs Account refresh as well as the workflow scan.
async fn assert_parked_dispatch_scan(runtime: &Arc<Runtime>, network: &AccountNetworks) {
    use std::future::Future;
    let before = network.call_count();
    let source_before = network.source.refresh_calls.lock().unwrap().len();
    let target_before = network.target.refresh_calls.lock().unwrap().len();
    {
        let mut runner = Box::pin(runtime.clone().run_operation_dispatch());
        std::future::poll_fn(|cx| {
            assert!(runner.as_mut().poll(cx).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
    }
    assert_eq!(
        &network.source.refresh_calls.lock().unwrap()[source_before..],
        &[format!("{SOURCE_SERVER}/api/v1/auth/me")]
    );
    assert_eq!(
        &network.target.refresh_calls.lock().unwrap()[target_before..],
        &[format!("{TARGET_SERVER}/api/v1/auth/me")]
    );
    assert_eq!(
        network.call_count(),
        before + 2,
        "only independent Account refresh uses HTTP"
    );
}

async fn assert_unavailable_resume_and_dispatch(
    runtime: &Arc<Runtime>,
    directory: &TestDirectory,
    network: &AccountNetworks,
    command: &Value,
) {
    let source_before = snapshot(directory, desktop::ACCOUNT).await;
    let target_before = snapshot(directory, SECOND_ACCOUNT).await;
    assert_unavailable_resume(runtime, directory, network, command).await;
    assert_parked_dispatch_scan(runtime, network).await;
    assert_eq!(snapshot(directory, desktop::ACCOUNT).await, source_before);
    assert_eq!(snapshot(directory, SECOND_ACCOUNT).await, target_before);
}

async fn assert_unavailable_resume(
    runtime: &Arc<Runtime>,
    directory: &TestDirectory,
    network: &AccountNetworks,
    command: &Value,
) {
    let source_before = snapshot(directory, desktop::ACCOUNT).await;
    let target_before = snapshot(directory, SECOND_ACCOUNT).await;
    let http_before = network.call_count();
    let error = runtime
        .request(
            RuntimeRequest::PrepareCrossAccountMoveResume {
                account_id: AccountId::from(desktop::ACCOUNT),
                operation_id: command["operationId"].as_str().unwrap().into(),
                target_account_id: AccountId::from(SECOND_ACCOUNT),
                expected_binding_revision: 0,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::AccessDenied);
    assert_eq!(error.message, "The source Move is unavailable");
    let authority = runtime
        .native_authority()
        .attach_source("parked-fixture".into(), "parked-transport".into())
        .unwrap();
    let guard: CrossAccountMoveResumeGuard = serde_json::from_value(json!({
        "accountId":desktop::ACCOUNT,"sourceIncarnation":source_before["head"]["incarnation"],
        "sourceLockEpoch":source_before["head"]["lockEpoch"],"targetAccountId":SECOND_ACCOUNT,
        "targetIncarnation":target_before["head"]["incarnation"],"targetLockEpoch":target_before["head"]["lockEpoch"],
        "operationId":command["operationId"],"bindingRevision":"0",
        "sourceReplicaRevision":source_before["head"]["replicaRevision"],"ownerIncarnation":authority.owner_id
    })).unwrap();
    let error = runtime
        .request(
            RuntimeRequest::ResumeCrossAccountMove { guard },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::AccessDenied);
    assert_eq!(error.message, "The source Move is unavailable");
    assert_eq!(network.call_count(), http_before);
    assert_eq!(snapshot(directory, desktop::ACCOUNT).await, source_before);
    assert_eq!(snapshot(directory, SECOND_ACCOUNT).await, target_before);
}
