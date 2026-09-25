//! Distinct Server Users retain independent SRP proofs, Sessions, and shared Vault key envelopes.
use super::*;
#[path = "cross_account_move_attachment_tests.rs"]
mod attachment_tests;

const OTHER_USER: RoutingAuthIdentity = RoutingAuthIdentity {
    normalized_email: "user-2@example.com",
    user_id: "user-2",
    attempt_id: "attempt-other-user",
    session_id: "session-other-user",
    token: "fresh-other-user-token",
    refreshed_token: "refreshed-other-user-token",
};

fn configure_other_user(endpoint: &mut MoveEndpoint) {
    endpoint.auth = RoutingAuthHttp::with_identity(
        current_kdf_profile(),
        RoutingAuthBehavior::Success,
        None,
        OTHER_USER,
    );
    Arc::get_mut(&mut endpoint.server).unwrap().user_id = OTHER_USER.user_id;
    *endpoint.server.accepted_tokens.lock().unwrap() =
        vec![OTHER_USER.token.into(), OTHER_USER.refreshed_token.into()];
}

fn request_is_other_user(request: &Value, path: &str) -> bool {
    if path == "/api/v1/auth/login-attempts" {
        routing_request_body(request)["email"] == OTHER_USER.normalized_email
    } else if path.starts_with("/api/v1/auth/login-attempts/") {
        path == format!(
            "/api/v1/auth/login-attempts/{}/finish",
            OTHER_USER.attempt_id
        )
    } else {
        request["headers"].as_array().unwrap().iter().any(|header| {
            header["name"]
                .as_str()
                .unwrap()
                .eq_ignore_ascii_case("authorization")
                && [OTHER_USER.token, OTHER_USER.refreshed_token]
                    .iter()
                    .any(|token| header["value"] == format!("Bearer {token}"))
        })
    }
}

struct ActorHttp {
    primary: Arc<MoveHttp>,
    other_user: Arc<MoveHttp>,
    original_urls: Mutex<Vec<String>>,
}

impl ActorHttp {
    fn new() -> Arc<Self> {
        let mut primary = MoveHttp::new();
        Arc::get_mut(&mut primary)
            .unwrap()
            .target
            .use_shared_member(&TARGET_KEY);
        let mut other_user = MoveHttp::new();
        let endpoint = &mut Arc::get_mut(&mut other_user).unwrap().target;
        configure_other_user(endpoint);
        endpoint.use_shared_member(&TARGET_KEY);
        Arc::new(Self {
            primary,
            other_user,
            original_urls: Mutex::default(),
        })
    }

    fn set_offline(&self, offline: bool) {
        self.primary.offline.store(offline, Ordering::SeqCst);
        self.other_user.offline.store(offline, Ordering::SeqCst);
    }
}

#[async_trait]
impl crate::http_transport::SerializedHttpExecutor for ActorHttp {
    async fn invoke(&self, input: Zeroizing<String>) -> Result<String, RuntimeError> {
        let request: Value = serde_json::from_str(&input).unwrap();
        let url = request["url"]
            .as_str()
            .expect("the identity fixture uses ordinary HTTP");
        self.original_urls.lock().unwrap().push(url.into());
        let other_user = if let Some(path) = url.strip_prefix(TARGET_ORIGIN) {
            request_is_other_user(&request, path)
        } else {
            assert!(url.starts_with(SOURCE_ORIGIN), "unexpected Actor origin");
            false
        };
        if other_user {
            self.other_user.invoke(input).await
        } else {
            self.primary.invoke(input).await
        }
    }

    fn cancel(&self, dispatch_id: &str) {
        self.primary.cancel(dispatch_id);
        self.other_user.cancel(dispatch_id);
    }
}

/// The two endpoint stores model separate private Vaults and User-scoped retained outcomes.
/// Public requests retain one canonical Server URL; only this adapter selects their fixture store.
struct SameServerHttp {
    http: Arc<MoveHttp>,
    requests: Mutex<Vec<RecordedRequest>>,
}

impl SameServerHttp {
    fn new() -> Arc<Self> {
        let mut http = MoveHttp::new();
        let endpoints = Arc::get_mut(&mut http).unwrap();
        endpoints.source.include_login_vault_keys = true;
        let target = &mut endpoints.target;
        configure_other_user(target);
        let derived = derive_keys(
            MASTER_PASSWORD,
            SECRET_KEY,
            OTHER_USER.normalized_email,
            &current_kdf_profile(),
        )
        .unwrap();
        target.vault["id"] = json!("vault-2");
        target.vault["encryptedVaultKey"] = json!(encrypt_vault_key_with_muk(
            &TARGET_KEY,
            &derived.master_unlock_key,
            &VaultKeyWrapContext::new("vault-2", OTHER_USER.user_id, 1),
        )
        .unwrap());
        target.include_login_vault_keys = true;
        Arc::new(Self {
            http,
            requests: Mutex::default(),
        })
    }
}

#[async_trait]
impl crate::http_transport::SerializedHttpExecutor for SameServerHttp {
    async fn invoke(&self, input: Zeroizing<String>) -> Result<String, RuntimeError> {
        let mut request: Value = serde_json::from_str(&input).unwrap();
        let url = request["url"].as_str().unwrap().to_owned();
        let path = url
            .strip_prefix(SOURCE_ORIGIN)
            .expect("both actual Accounts use the same canonical Server");
        let other_user = request_is_other_user(&request, path);
        self.requests.lock().unwrap().push(RecordedRequest {
            method: request["method"].as_str().unwrap().into(),
            url: url.clone(),
            headers: request["headers"]
                .as_array()
                .unwrap()
                .iter()
                .map(|header| {
                    (
                        header["name"].as_str().unwrap().into(),
                        header["value"].as_str().unwrap().into(),
                    )
                })
                .collect(),
            body: serde_json::from_value(request["body"].clone()).unwrap(),
        });
        if other_user {
            request["url"] = json!(format!("{TARGET_ORIGIN}{path}"));
        }
        self.http.invoke(Zeroizing::new(request.to_string())).await
    }

    fn cancel(&self, dispatch_id: &str) {
        self.http.cancel(dispatch_id);
    }
}

#[tokio::test]
async fn same_server_distinct_users_move_between_their_own_private_vaults() {
    let database = MoveDatabase::new();
    let platform = Arc::new(InstallationPlatform::default());
    let http = SameServerHttp::new();
    let runtime = Runtime::with_configured_serialized_executors(
        MoveSqlite::open(&database.0),
        platform,
        http.clone(),
        AuthClientConfig::new(
            "client-routing".into(),
            ClientPlatform::Desktop,
            "0.5.2-test".into(),
        )
        .unwrap(),
    );
    runtime.open().await.unwrap();
    let mut accounts = Vec::new();
    for identity in [RoutingAuthIdentity::default(), OTHER_USER] {
        let RuntimeResponse::SignedIn { account_id, .. } = runtime
            .request(
                sign_in_request_to(SOURCE_ORIGIN, identity.normalized_email),
                RequestCancellation::new(),
            )
            .await
            .unwrap()
        else {
            panic!("each User must complete its own public SRP Sign-in")
        };
        let snapshot = runtime.require_snapshot(&account_id).unwrap();
        assert_eq!(snapshot.user_id, identity.user_id);
        assert_eq!(
            snapshot.bootstrap.state,
            crate::replica::ReplicaState::Ready
        );
        let metadata = runtime
            .platform_storage
            .load_account_metadata(&account_id, &snapshot.incarnation)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(metadata.normalized_server_url, SOURCE_ORIGIN);
        let session = runtime
            .platform_storage
            .load_current_session(&account_id, &snapshot.incarnation)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(session.token.as_ref(), identity.token);
        assert_eq!(session.session_id.as_deref(), Some(identity.session_id));
        accounts.push(account_id);
    }
    let [source, target]: [AccountId; 2] = accounts.try_into().unwrap();
    assert_ne!(source, target);
    assert_source_visible(
        &runtime,
        &source,
        crate::ItemProjectionStatus::Authoritative,
    );
    for (account, vault_id) in [(&source, "vault-1"), (&target, "vault-2")] {
        let RuntimeProjection::Items(items) = runtime
            .projection(&ObservationRequest::Items {
                account_id: account.clone(),
            })
            .unwrap()
            .projection
        else {
            panic!("expected public private Vault authority")
        };
        assert_eq!(items.vaults.len(), 1);
        assert_eq!(items.vaults[0].vault_id, vault_id);
        assert_eq!(
            items.vaults[0].vault_type,
            crate::VaultProjectionType::Personal
        );
        assert_eq!(items.vaults[0].role, crate::VaultProjectionRole::Owner);
    }
    http.http.offline.store(true, Ordering::SeqCst);
    let RuntimeResponse::Accepted { operation_id, .. } = runtime
        .request(
            RuntimeRequest::MoveItem {
                account_id: source.clone(),
                item_id: SOURCE_ITEM.into(),
                target_account_id: Some(target.clone()),
                target_vault_id: "vault-2".into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("same-Server Accounts must admit a source-owned cross-Account workflow")
    };
    let accepted = workflow(&durable_rows(&database.0, &source).await, &operation_id);
    assert_eq!(accepted["sourceIdentity"]["serverUrl"], SOURCE_ORIGIN);
    assert_eq!(accepted["destinationIdentity"]["serverUrl"], SOURCE_ORIGIN);
    assert_eq!(accepted["sourceIdentity"]["userId"], "user-1");
    assert_eq!(
        accepted["destinationIdentity"]["userId"],
        OTHER_USER.user_id
    );
    assert_eq!(accepted["source"]["vaultId"], "vault-1");
    assert_eq!(accepted["target"]["vaultId"], "vault-2");
    assert_eq!(accepted["target"]["encryptedByUserId"], OTHER_USER.user_id);
    assert_source_visible(&runtime, &source, crate::ItemProjectionStatus::Pending);
    assert!(!durable_rows(&database.0, &target)
        .await
        .iter()
        .any(|row| row["store"] == "operations" || row["store"] == "crossAccountMoves"));

    http.http.resumed.store(true, Ordering::SeqCst);
    http.http.trash_result.release.add_permits(1);
    http.http.delete_result.release.add_permits(1);
    http.http.offline.store(false, Ordering::SeqCst);
    let runner = tokio::spawn(runtime.clone().run_operation_dispatch());
    let completed = tokio::time::timeout(Duration::from_secs(10), async {
        while resolution(&runtime, &source, &operation_id) != OperationResolution::Applied {
            tokio::task::yield_now().await;
        }
    })
    .await;
    if completed.is_err() {
        close_move_runtime(runtime, runner).await;
        panic!("both real User Sessions must complete the same-Server Move");
    }
    let requests = http.requests.lock().unwrap().clone();
    assert!(requests
        .iter()
        .all(|request| request.url.starts_with(SOURCE_ORIGIN)));
    let mutations: Vec<_> = requests
        .iter()
        .filter(|request| request.header("idempotency-key").is_some())
        .collect();
    assert_eq!(mutations.len(), 3);
    assert_eq!(mutations[0].method, "PUT");
    assert_eq!(
        mutations[0].header("authorization"),
        Some(format!("Bearer {}", OTHER_USER.token).as_str())
    );
    for request in &mutations[1..] {
        assert_eq!(request.method, "DELETE");
        assert_eq!(request.header("authorization"), Some("Bearer fresh-token"));
    }
    let target_items = http
        .http
        .target
        .server
        .created_items
        .lock()
        .unwrap()
        .clone();
    assert_eq!(target_items.len(), 1);
    let item = &target_items[0];
    assert_eq!(item.id, accepted["target"]["id"].as_str().unwrap());
    assert_eq!(item.vault_id, "vault-2");
    let ciphertext = bittery_crypto_core::EncryptedData {
        ciphertext: item.encrypted_data.clone(),
        iv: item.encryption_iv.clone(),
        algorithm: item.encryption_algorithm.clone(),
    };
    let mut aad = AadContext {
        vault_id: item.vault_id.clone(),
        entity_id: item.id.clone(),
        entity_type: "item".into(),
        user_id: OTHER_USER.user_id.into(),
        version: u64::try_from(item.encryption_version).unwrap(),
    };
    let plaintext = bittery_crypto_core::decrypt_with_aad(&ciphertext, &TARGET_KEY, &aad).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&plaintext).unwrap(),
        json!({"title":"Original Login", "username":"ada", "password":"move-password"})
    );
    aad.user_id = "user-1".into();
    assert!(bittery_crypto_core::decrypt_with_aad(&ciphertext, &TARGET_KEY, &aad).is_err());
    let completed = workflow(&durable_rows(&database.0, &source).await, &operation_id);
    assert_eq!(completed["stage"], json!({"type":"completed"}));
    assert_eq!(completed["target"], accepted["target"]);
    let children = completed["children"].as_array().unwrap();
    assert_eq!(children.len(), 3);
    for (index, (child, request)) in children.iter().zip(&mutations).enumerate() {
        let child_id = request.header("idempotency-key").unwrap();
        assert_eq!(child["operationId"], child_id);
        assert_ne!(child_id, operation_id);
        assert_eq!(child["request"]["method"], request.method);
        assert_eq!(
            child["request"]["path"],
            request.url.strip_prefix(SOURCE_ORIGIN).unwrap()
        );
        assert_eq!(child["request"]["body"], json!(request.body));
        assert_eq!(child["result"]["operationId"], child_id);
        let expected_entity = if index == 0 {
            item.id.as_str()
        } else {
            SOURCE_ITEM
        };
        assert_eq!(
            child["result"]["result"],
            json!({"type":"applied", "entityId":expected_entity, "version":index + 1})
        );
        let server = if index == 0 {
            &http.http.target.server
        } else {
            &http.http.source.server
        };
        let stored = server.outcomes.lock().unwrap()[child_id].clone();
        let fingerprint: String = stored
            .fingerprint
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        assert_eq!(child["requestFingerprint"], fingerprint);
        assert_eq!(child["result"]["requestFingerprint"], fingerprint);
        match (&stored.result, index) {
            (StoredResult::Applied { item_id, version }, 0) => {
                assert_eq!(item_id, &item.id);
                assert_eq!(*version, 1);
            }
            (
                StoredResult::ExistingItemApplied {
                    kind,
                    item_id,
                    version,
                },
                1 | 2,
            ) => {
                assert_eq!(
                    *kind,
                    if index == 1 {
                        "trash_item"
                    } else {
                        "permanently_delete_item"
                    }
                );
                assert_eq!(item_id, SOURCE_ITEM);
                assert_eq!(*version, i32::try_from(index + 1).unwrap());
            }
            _ => panic!("the exact wire child must have its own retained Applied result"),
        }
    }
    assert_eq!(http.http.target.server.creates(), 1);
    assert!(http.http.source.server.created_items().is_empty());
    let RuntimeProjection::Items(items) = runtime
        .projection(&ObservationRequest::Items { account_id: source })
        .unwrap()
        .projection
    else {
        panic!("expected completed source Items")
    };
    assert!(items.items.is_empty());
    close_move_runtime(runtime, runner).await;
}

#[tokio::test]
async fn resume_refuses_different_user_with_current_membership_on_the_original_server() {
    let database = MoveDatabase::new();
    let platform = Arc::new(InstallationPlatform::default());
    let sqlite = MoveSqlite::open(&database.0);
    let http = ActorHttp::new();
    let runtime = Runtime::with_configured_serialized_executors(
        sqlite.clone(),
        platform.clone(),
        http.clone(),
        AuthClientConfig::new(
            "client-routing".into(),
            ClientPlatform::Desktop,
            "0.5.2-test".into(),
        )
        .unwrap(),
    );
    runtime.open().await.unwrap();
    let (source, target) = sign_in_move_accounts(&runtime).await;
    http.set_offline(true);
    let RuntimeResponse::Accepted { operation_id, .. } = runtime
        .request(
            RuntimeRequest::MoveItem {
                account_id: source.clone(),
                item_id: SOURCE_ITEM.into(),
                target_account_id: Some(target.clone()),
                target_vault_id: "vault-1".into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("expected an offline accepted Move")
    };
    let fixture = AdmittedMoveFixture {
        database,
        platform,
        http: http.primary.clone(),
        sqlite,
        runtime,
        source,
        target,
        operation_id,
    };
    let _artifacts = remove_target(&fixture).await;
    http.set_offline(false);
    let RuntimeResponse::SignedIn {
        account_id: candidate,
        ..
    } = fixture
        .runtime
        .request(
            sign_in_request_to(TARGET_ORIGIN, OTHER_USER.normalized_email),
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("the other User must complete its own SRP Sign-in")
    };
    assert_ne!(candidate, fixture.source);
    assert_ne!(candidate, fixture.target);
    let source_before = durable_rows(&fixture.database.0, &fixture.source).await;
    let candidate_before = durable_rows(&fixture.database.0, &candidate).await;
    let retired = workflow(&source_before, &fixture.operation_id);
    assert_eq!(retired["destinationBinding"]["status"], "retired");
    assert_eq!(retired["destinationIdentity"]["userId"], "user-1");
    let snapshot = fixture.runtime.require_snapshot(&candidate).unwrap();
    assert_eq!(snapshot.user_id, OTHER_USER.user_id);
    assert_eq!(
        snapshot.bootstrap.state,
        crate::replica::ReplicaState::Ready
    );
    let metadata = fixture
        .runtime
        .platform_storage
        .load_account_metadata(&candidate, &snapshot.incarnation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(metadata.normalized_server_url, TARGET_ORIGIN);
    assert_eq!(
        json!(metadata.normalized_server_url),
        retired["destinationIdentity"]["serverUrl"]
    );
    let RuntimeProjection::Items(items) = fixture
        .runtime
        .projection(&ObservationRequest::Items {
            account_id: candidate.clone(),
        })
        .unwrap()
        .projection
    else {
        panic!("expected candidate Items")
    };
    assert!(items.items.is_empty());
    assert!(items.vaults.iter().any(|vault| vault.vault_id == "vault-1"
        && vault.vault_type == crate::VaultProjectionType::Team
        && vault.role == crate::VaultProjectionRole::Member));
    assert_eq!(
        fixture.runtime.account_access_state(&candidate),
        Some(AccountAccessState::Unlocked)
    );
    let requests_before = http.original_urls.lock().unwrap().len();
    let error = fixture
        .runtime
        .request(
            RuntimeRequest::PrepareCrossAccountMoveResume {
                account_id: fixture.source.clone(),
                operation_id: fixture.operation_id.clone(),
                target_account_id: candidate.clone(),
                expected_binding_revision: 1,
            },
            RequestCancellation::new(),
        )
        .await
        .expect_err(
            "current shared-Vault membership cannot substitute for the accepted Server User",
        );
    assert_eq!(error.code, RuntimeErrorCode::AccessDenied);
    assert_eq!(http.original_urls.lock().unwrap().len(), requests_before);
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.source).await,
        source_before
    );
    assert_eq!(
        durable_rows(&fixture.database.0, &candidate).await,
        candidate_before
    );
    assert_source_visible(
        &fixture.runtime,
        &fixture.source,
        crate::ItemProjectionStatus::Pending,
    );
    assert_eq!(
        resolution(&fixture.runtime, &fixture.source, &fixture.operation_id),
        OperationResolution::Pending
    );
    for endpoint in [&http.primary, &http.other_user] {
        assert!(endpoint.mutations(SOURCE_ORIGIN).is_empty());
        assert!(endpoint.mutations(TARGET_ORIGIN).is_empty());
        assert!(endpoint.target.server.created_items().is_empty());
        assert!(endpoint.target.server.outcomes.lock().unwrap().is_empty());
    }
    tokio::time::timeout(Duration::from_secs(5), fixture.runtime.close())
        .await
        .unwrap();
}
