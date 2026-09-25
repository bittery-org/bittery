//! One public no-file Move history across independent Servers and a real SQLite reopen.
use super::*;
#[path = "cross_account_move_category_tests.rs"]
mod category_tests;
#[path = "cross_account_move_fault_tests.rs"]
mod fault_tests;
#[path = "cross_account_legacy_admission_tests.rs"]
mod legacy_admission_tests;
#[path = "cross_account_move_native_travel_tests.rs"]
mod native_travel_tests;
#[path = "cross_account_move_resume_tests.rs"]
mod resume_tests;
#[path = "cross_account_move_retirement_tests.rs"]
mod retirement_tests;
#[path = "cross_account_move_scope_tests.rs"]
mod scope_tests;
#[path = "cross_account_move_shared_tests.rs"]
mod shared_tests;
#[path = "cross_account_move_source_tests.rs"]
mod source_tests;
use crate::runtime::operation_fixtures::{
    item_body, item_body_for_user, FakeServer, RecordedRequest, StoredItem, StoredResult,
    SERVER_URL,
};
use crate::{OperationResolution, SqliteReplica};
use std::{path::Path, time::Duration};

const SOURCE_ORIGIN: &str = "https://move-source.example.test";
const TARGET_ORIGIN: &str = "https://move-target.example.test";
const SOURCE_ITEM: &str = "item-existing";
const TARGET_KEY: [u8; 32] = [83; 32];

struct MoveDatabase(std::path::PathBuf);

impl MoveDatabase {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!(
            "bittery-cross-account-move-{}.sqlite",
            bittery_crypto_core::generate_uuid()
        )))
    }
}

impl Drop for MoveDatabase {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Records the supported serialized persistence boundary while SQLite owns every durable write.
struct MoveSqlite {
    sqlite: SqliteReplica,
    commits: Mutex<Vec<Value>>,
    fail_next_commit: AtomicBool,
}

impl MoveSqlite {
    fn open(path: &Path) -> Arc<Self> {
        Arc::new(Self {
            sqlite: SqliteReplica::open(path).unwrap(),
            commits: Mutex::default(),
            fail_next_commit: AtomicBool::new(false),
        })
    }
}

#[async_trait]
impl SerializedReplicaExecutor for MoveSqlite {
    async fn invoke(&self, request: String) -> Result<String, RuntimeError> {
        let value: Value = serde_json::from_str(&request).unwrap();
        if value["type"] == "commit" && self.fail_next_commit.swap(false, Ordering::SeqCst) {
            return Err(RuntimeError::new(
                RuntimeErrorCode::StorageUnavailable,
                "injected source Replica commit failure before write",
            ));
        }
        let result = SerializedReplicaExecutor::invoke(&self.sqlite, request).await?;
        if value["type"] == "commit" {
            self.commits.lock().unwrap().push(value);
        }
        Ok(result)
    }
}

struct MoveGate {
    reached: tokio::sync::Semaphore,
    release: tokio::sync::Semaphore,
}

impl MoveGate {
    fn new() -> Self {
        Self {
            reached: tokio::sync::Semaphore::new(0),
            release: tokio::sync::Semaphore::new(0),
        }
    }

    async fn hold(&self) {
        self.reached.add_permits(1);
        self.release.acquire().await.unwrap().forget();
    }

    async fn wait(&self, label: &str) {
        tokio::time::timeout(Duration::from_secs(10), self.reached.acquire())
            .await
            .unwrap_or_else(|_| panic!("{label} was not reached"))
            .unwrap()
            .forget();
    }
}

struct MoveEndpoint {
    auth: RoutingAuthHttp,
    server: Arc<FakeServer>,
    vault: Value,
    vault_role_override: Mutex<Option<crate::server_contract::VaultRole>>,
    travel_policy: Mutex<Option<TravelModeResponse>>,
    include_login_vault_keys: bool,
    member_identity: Option<(String, String)>,
}

impl MoveEndpoint {
    fn new(key: &[u8; 32], source: bool) -> Self {
        let (_, item) =
            sealed_login_item_with_key(SOURCE_ITEM, "Original Login", "move-password", key);
        let server = FakeServer::new();
        *server.accepted_tokens.lock().unwrap() = vec!["fresh-token".into()];
        *server.sync_cursor.lock().unwrap() = Some("move-start".into());
        if source {
            server.created_items.lock().unwrap().push(StoredItem {
                id: SOURCE_ITEM.into(),
                vault_id: "vault-1".into(),
                category: "login".into(),
                encrypted_data: item["encryptedData"].as_str().unwrap().into(),
                encryption_iv: item["encryptionIv"].as_str().unwrap().into(),
                encryption_algorithm: item["encryptionAlgorithm"].as_str().unwrap().into(),
                encryption_version: 1,
                version: 1,
                favorite: false,
                deleted_at: None,
            });
        }
        Self {
            auth: RoutingAuthHttp::new(current_kdf_profile(), RoutingAuthBehavior::Success, None),
            server,
            vault: item["vault"].clone(),
            vault_role_override: Mutex::new(None),
            travel_policy: Mutex::new(None),
            include_login_vault_keys: false,
            member_identity: None,
        }
    }

    fn set_vault_role(&self, role: crate::server_contract::VaultRole) {
        *self.vault_role_override.lock().unwrap() = Some(role);
    }

    fn current_vault(&self) -> Value {
        let mut vault = self.vault.clone();
        if let Some(role) = self.vault_role_override.lock().unwrap().as_ref() {
            vault["role"] = serde_json::to_value(role).unwrap();
        }
        vault
    }

    fn use_shared_member(&mut self, vault_key: &[u8; 32]) {
        let pair = bittery_crypto_core::generate_rsa_key_pair().unwrap();
        let derived = derive_keys(
            MASTER_PASSWORD,
            SECRET_KEY,
            self.auth.identity.normalized_email,
            &self.auth.kdf_profile,
        )
        .unwrap();
        let encrypted_private_key = serde_json::to_string(
            &bittery_crypto_core::encrypt(&pair.private_key, &derived.master_unlock_key).unwrap(),
        )
        .unwrap();
        self.vault["vaultType"] = json!("team");
        self.vault["role"] = json!("member");
        self.vault["encryptedVaultKey"] = json!(bittery_crypto_core::encrypt_vault_key_for_member(
            vault_key,
            &pair.public_key
        )
        .unwrap());
        self.member_identity = Some((pair.public_key.clone(), encrypted_private_key));
    }

    async fn authenticate(&self, input: Zeroizing<String>) -> Result<String, RuntimeError> {
        let request: Value = serde_json::from_str(&input).unwrap();
        if request["url"].as_str().unwrap().ends_with("/travel-mode") {
            if let Some(policy) = self.travel_policy.lock().unwrap().as_ref() {
                assert_eq!(request["method"], "GET");
                return Ok(routing_completed(
                    200,
                    serde_json::to_value(policy).unwrap(),
                ));
            }
        }
        let finish = request["url"].as_str().unwrap().ends_with("/finish");
        let answer = self.auth.invoke(input).await?;
        if !finish || (!self.include_login_vault_keys && self.member_identity.is_none()) {
            return Ok(answer);
        }
        // Preserve the fixture's real SRP proof; only its Server-provided key authority varies.
        let mut answer: Value = serde_json::from_str(&answer).unwrap();
        let body_bytes: Vec<u8> = serde_json::from_value(answer["body"].clone()).unwrap();
        let mut body: Value = serde_json::from_slice(&body_bytes).unwrap();
        if let Some((public_key, encrypted_private_key)) = &self.member_identity {
            body["user"]["publicKey"] = json!(public_key);
            body["user"]["encryptedPrivateKey"] = json!(encrypted_private_key);
        }
        let vault = self.current_vault();
        body["vaultKeys"]["items"] = json!([{
            "encryptedVaultKey": vault["encryptedVaultKey"], "role": vault["role"],
            "vaultIcon": null, "vaultId": vault["id"], "vaultImageUrl": null,
            "vaultName": vault["name"], "vaultType": vault["vaultType"]
        }]);
        answer["body"] = json!(serde_json::to_vec(&body).unwrap());
        Ok(answer.to_string())
    }

    fn bootstrap(&self, vaults: bool) -> String {
        let cursor = self
            .server
            .sync_cursor
            .lock()
            .unwrap()
            .clone()
            .expect("Move fixture Server must publish a Bootstrap watermark");
        let body = if vaults {
            json!({"phase":"vaults", "vaults":[self.current_vault()], "hasMore":false,
                "nextCursor":null, "syncCursor":{"id":cursor}})
        } else {
            let items: Vec<Value> = self
                .server
                .created_items
                .lock()
                .unwrap()
                .iter()
                .map(|item| {
                    let mut value: Value =
                        serde_json::from_slice(&item_body_for_user(item, self.server.user_id))
                            .unwrap();
                    value["attachments"] = json!(self
                        .server
                        .attachments
                        .lock()
                        .unwrap()
                        .iter()
                        .filter(|attachment| attachment["itemId"] == item.id)
                        .cloned()
                        .collect::<Vec<_>>());
                    value
                })
                .collect();
            json!({"phase":"items", "items":items, "hasMore":false,
                "nextCursor":null, "syncCursor":{"id":cursor}})
        };
        routing_completed(200, body)
    }
}

/// Origin selection is a transport fixture; each Server owns its own rows and retained outcomes.
/// The shared fixture's fixed test origin is substituted only after recording the actual request.
struct MoveHttp {
    source: MoveEndpoint,
    target: MoveEndpoint,
    requests: Mutex<Vec<RecordedRequest>>,
    offline: AtomicBool,
    resumed: AtomicBool,
    unavailable_after_delete: AtomicBool,
    failed_post_delete_reads: tokio::sync::Semaphore,
    recovery: MoveGate,
    trash_result: MoveGate,
    delete_result: MoveGate,
}

impl MoveHttp {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            source: MoveEndpoint::new(&[41; 32], true),
            target: MoveEndpoint::new(&TARGET_KEY, false),
            requests: Mutex::default(),
            offline: AtomicBool::new(false),
            resumed: AtomicBool::new(false),
            unavailable_after_delete: AtomicBool::new(false),
            failed_post_delete_reads: tokio::sync::Semaphore::new(0),
            recovery: MoveGate::new(),
            trash_result: MoveGate::new(),
            delete_result: MoveGate::new(),
        })
    }

    fn mutations(&self, origin: &str) -> Vec<RecordedRequest> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|request| {
                request.url.starts_with(origin)
                    && request.method != "GET"
                    && !request.url.contains("/auth/")
                    && !request.url.contains("/sessions/")
            })
            .cloned()
            .collect()
    }
}

#[async_trait]
impl crate::http_transport::SerializedHttpExecutor for MoveHttp {
    async fn invoke(&self, input: Zeroizing<String>) -> Result<String, RuntimeError> {
        if self.offline.load(Ordering::SeqCst) {
            return Ok(json!({"type":"networkFailure"}).to_string());
        }
        let mut value: Value = serde_json::from_str(&input).unwrap();
        if value["type"] == "readStream" {
            return Ok(json!({"type":"ended"}).to_string());
        }
        if value["type"] == "openStream" {
            let request = &value["request"];
            let url = request["url"].as_str().unwrap();
            assert!(url.starts_with(SOURCE_ORIGIN) || url.starts_with(TARGET_ORIGIN));
            assert!(url.ends_with("/api/v1/sync/events"));
            assert_eq!(request["method"], "GET");
            return Ok(json!({"type":"opened", "status":200,
                "headers":[{"name":"content-type", "value":"text/event-stream"}]})
            .to_string());
        }
        let url = value["url"].as_str().unwrap().to_owned();
        let source = url.starts_with(SOURCE_ORIGIN);
        let origin = if source { SOURCE_ORIGIN } else { TARGET_ORIGIN };
        assert!(url.starts_with(origin), "unexpected Server origin");
        let endpoint = if source { &self.source } else { &self.target };
        let route = url.strip_prefix(origin).unwrap();
        if route.starts_with("/api/v1/auth/")
            || route.ends_with("/travel-mode")
            || route.ends_with("/sessions/current/refresh")
        {
            return endpoint.authenticate(input).await;
        }
        if route.contains("/sync/bootstrap") {
            return Ok(endpoint.bootstrap(route.contains("phase=vaults")));
        }
        let request = RecordedRequest {
            method: value["method"].as_str().unwrap().into(),
            url: url.clone(),
            headers: value["headers"]
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
            body: serde_json::from_value(value["body"].clone()).unwrap(),
        };
        self.requests.lock().unwrap().push(request.clone());
        if source
            && request.method == "GET"
            && route.starts_with("/api/v1/items/item-existing")
            && self.unavailable_after_delete.load(Ordering::SeqCst)
            && endpoint.server.created_items.lock().unwrap().is_empty()
        {
            self.failed_post_delete_reads.add_permits(1);
            return Ok(json!({"type":"networkFailure"}).to_string());
        }
        if !source
            && !route.contains("/sync/changes")
            && !self.resumed.load(Ordering::SeqCst)
            && !endpoint.server.outcomes.lock().unwrap().is_empty()
        {
            self.recovery.hold().await;
        }
        let retained = request
            .header("idempotency-key")
            .is_some_and(|id| endpoint.server.outcomes.lock().unwrap().contains_key(id));
        if source && request.method == "DELETE" && !retained {
            let version = endpoint.server.created_items.lock().unwrap()[0].version;
            assert_eq!(
                request.header("if-match"),
                Some(format!("\"{version}\"").as_str()),
                "source destruction must carry its current strong precondition"
            );
        }
        value["url"] = json!(format!("{SERVER_URL}{route}"));
        let response = endpoint
            .server
            .invoke(Zeroizing::new(value.to_string()))
            .await?;
        if source && request.method == "DELETE" {
            if route.ends_with("/permanent") {
                self.delete_result.hold().await;
            } else {
                self.trash_result.hold().await;
            }
        }
        Ok(response)
    }

    fn cancel(&self, _: &str) {}
}

async fn open_move_runtime(
    sqlite: Arc<MoveSqlite>,
    platform: Arc<InstallationPlatform>,
    http: Arc<MoveHttp>,
) -> Arc<Runtime> {
    open_move_runtime_with_platform(sqlite, platform, http, ClientPlatform::Desktop).await
}

async fn open_move_runtime_with_platform(
    sqlite: Arc<MoveSqlite>,
    platform: Arc<InstallationPlatform>,
    http: Arc<MoveHttp>,
    client_platform: ClientPlatform,
) -> Arc<Runtime> {
    let runtime = Runtime::with_configured_serialized_executors(
        sqlite,
        platform,
        http,
        AuthClientConfig::new(
            "client-routing".into(),
            client_platform,
            "0.5.2-test".into(),
        )
        .unwrap(),
    );
    runtime.open().await.unwrap();
    runtime
}

async fn durable_rows(path: &Path, account_id: &AccountId) -> Vec<Value> {
    let sqlite = SqliteReplica::open(path).unwrap();
    let response = SerializedReplicaExecutor::invoke(
        &sqlite,
        json!({"type":"load", "accountId":account_id}).to_string(),
    )
    .await
    .unwrap();
    let response: Value = serde_json::from_str(&response).unwrap();
    assert_eq!(response["type"], "loaded");
    response["rows"].as_array().unwrap().clone()
}

fn workflow(rows: &[Value], operation_id: &str) -> Value {
    let rows: Vec<_> = rows
        .iter()
        .filter(|row| row["store"] == "crossAccountMoves")
        .collect();
    assert_eq!(
        rows.len(),
        1,
        "one source-owned workflow must survive in SQLite"
    );
    assert_eq!(rows[0]["key"]["recordId"], operation_id);
    serde_json::from_str(rows[0]["payloadJson"].as_str().unwrap()).unwrap()
}

fn contains_value(value: &Value, expected: &Value) -> bool {
    value == expected
        || match value {
            Value::Array(values) => values.iter().any(|value| contains_value(value, expected)),
            Value::Object(values) => values.values().any(|value| contains_value(value, expected)),
            _ => false,
        }
}

fn assert_exact_retry(actual: &RecordedRequest, expected: &RecordedRequest) {
    assert_eq!(actual.method, expected.method);
    assert_eq!(actual.url, expected.url);
    assert_eq!(
        actual.body, expected.body,
        "the fingerprint covers exact bytes"
    );
    let immutable_headers = |request: &RecordedRequest| {
        request
            .headers
            .iter()
            .filter(|(name, _)| !name.eq_ignore_ascii_case("authorization"))
            .cloned()
            .collect::<Vec<_>>()
    };
    assert_eq!(immutable_headers(actual), immutable_headers(expected));
}

fn stored_request(value: &Value, method: &str, path: &str) -> Option<Value> {
    if value.get("method") == Some(&json!(method)) && value.get("path") == Some(&json!(path)) {
        return Some(value.clone());
    }
    match value {
        Value::Array(values) => values
            .iter()
            .find_map(|value| stored_request(value, method, path)),
        Value::Object(values) => values
            .values()
            .find_map(|value| stored_request(value, method, path)),
        _ => None,
    }
}

fn assert_source_visible(
    runtime: &Runtime,
    account_id: &AccountId,
    status: crate::ItemProjectionStatus,
) {
    let RuntimeProjection::Items(items) = runtime
        .projection(&ObservationRequest::Items {
            account_id: account_id.clone(),
        })
        .unwrap()
        .projection
    else {
        panic!("expected Items")
    };
    assert_eq!(items.items.len(), 1);
    assert_eq!(items.items[0].item_id, SOURCE_ITEM);
    assert_eq!(items.items[0].vault_id, "vault-1");
    assert_eq!(items.items[0].status, status);
}

fn resolution(
    runtime: &Runtime,
    account_id: &AccountId,
    operation_id: &str,
) -> OperationResolution {
    let RuntimeProjection::Operations(operations) = runtime
        .projection(&ObservationRequest::Operations {
            account_id: account_id.clone(),
        })
        .unwrap()
        .projection
    else {
        panic!("expected Operations")
    };
    assert_eq!(
        operations.operations.len(),
        1,
        "child requests must not appear as separate Operations"
    );
    assert_eq!(operations.operations[0].operation_id, operation_id);
    operations.operations[0].resolution
}

async fn close_move_runtime(runtime: Arc<Runtime>, runner: tokio::task::JoinHandle<()>) {
    runner.abort();
    let _ = runner.await;
    tokio::time::timeout(Duration::from_secs(5), runtime.close())
        .await
        .unwrap();
}

async fn sign_in_move_accounts(runtime: &Runtime) -> (AccountId, AccountId) {
    let sign_in = |origin| sign_in_request_to(origin, NORMALIZED_EMAIL);
    let RuntimeResponse::SignedIn {
        account_id: source, ..
    } = runtime
        .request(sign_in(SOURCE_ORIGIN), RequestCancellation::new())
        .await
        .unwrap()
    else {
        panic!("source Sign-in failed")
    };
    let RuntimeResponse::SignedIn {
        account_id: target, ..
    } = runtime
        .request(sign_in(TARGET_ORIGIN), RequestCancellation::new())
        .await
        .unwrap()
    else {
        panic!("target Sign-in failed")
    };
    assert_ne!(
        source, target,
        "different canonical Servers are independent Accounts"
    );
    assert_source_visible(runtime, &source, crate::ItemProjectionStatus::Authoritative);
    (source, target)
}

struct AdmittedMoveFixture {
    database: MoveDatabase,
    platform: Arc<InstallationPlatform>,
    http: Arc<MoveHttp>,
    sqlite: Arc<MoveSqlite>,
    runtime: Arc<Runtime>,
    source: AccountId,
    target: AccountId,
    operation_id: String,
}

impl AdmittedMoveFixture {
    /// Two real public Sign-ins followed by offline admission; no dispatcher is started.
    async fn new() -> Self {
        Self::with_http(MoveHttp::new()).await
    }

    async fn with_http(http: Arc<MoveHttp>) -> Self {
        Self::with_http_and_platform(http, ClientPlatform::Desktop).await
    }

    async fn with_http_and_platform(http: Arc<MoveHttp>, client_platform: ClientPlatform) -> Self {
        let database = MoveDatabase::new();
        let platform = Arc::new(InstallationPlatform::default());
        let sqlite = MoveSqlite::open(&database.0);
        let runtime = open_move_runtime_with_platform(
            sqlite.clone(),
            platform.clone(),
            http.clone(),
            client_platform,
        )
        .await;
        let (source, target) = sign_in_move_accounts(&runtime).await;
        http.offline.store(true, Ordering::SeqCst);

        let request: RuntimeRequest = serde_json::from_value(json!({
            "type":"moveItem", "accountId":source, "itemId":SOURCE_ITEM,
            "targetAccountId":target, "targetVaultId":"vault-1"
        }))
        .expect("the public Move intent must admit an explicit destination Account");
        let RuntimeResponse::Accepted { operation_id, .. } = runtime
            .request(request, RequestCancellation::new())
            .await
            .expect("cross-Account Move must be accepted offline")
        else {
            panic!("expected accepted source workflow")
        };
        Self {
            database,
            platform,
            http,
            sqlite,
            runtime,
            source,
            target,
            operation_id,
        }
    }
}

#[tokio::test]
async fn cross_account_move_without_files_recovers_committed_target_create_after_sqlite_reopen() {
    let AdmittedMoveFixture {
        database,
        platform,
        http,
        sqlite,
        runtime,
        source,
        target,
        operation_id,
    } = AdmittedMoveFixture::new().await;
    assert_source_visible(&runtime, &source, crate::ItemProjectionStatus::Pending);
    assert_eq!(
        resolution(&runtime, &source, &operation_id),
        OperationResolution::Pending
    );
    assert!(http.mutations(SOURCE_ORIGIN).is_empty());
    assert!(http.mutations(TARGET_ORIGIN).is_empty());
    let admitted = workflow(&durable_rows(&database.0, &source).await, &operation_id);
    assert!(contains_value(&admitted, &json!(SOURCE_ORIGIN)));
    assert!(contains_value(&admitted, &json!(TARGET_ORIGIN)));
    assert!(!durable_rows(&database.0, &target)
        .await
        .iter()
        .any(|row| row["store"] == "operations" || row["store"] == "crossAccountMoves"));
    assert!(
        sqlite.commits.lock().unwrap().iter().any(|commit| {
            let writes = commit["prepared"]["writes"].as_array().unwrap();
            writes
                .iter()
                .any(|write| write["row"]["store"] == "crossAccountMoves")
                && writes
                    .iter()
                    .any(|write| write["row"]["store"] == "optimisticItems")
        }),
        "source visibility and workflow must be admitted by one durable commit"
    );

    http.offline.store(false, Ordering::SeqCst);
    http.target.server.lose_next_response();
    let runner = tokio::spawn(runtime.clone().run_operation_dispatch());
    http.recovery
        .wait("reconciliation after the committed target response was lost")
        .await;
    let requests = http.mutations(TARGET_ORIGIN);
    assert!(!requests.is_empty());
    let target_create = &requests[0];
    for request in &requests {
        assert_exact_retry(request, target_create);
    }
    assert_eq!(target_create.method, "PUT");
    let target_item_id = target_create.url.rsplit('/').next().unwrap().to_owned();
    assert_ne!(target_item_id, SOURCE_ITEM);
    let child_id = target_create.header("idempotency-key").unwrap().to_owned();
    assert_ne!(
        child_id, operation_id,
        "semantic Move identity is separate from the HTTP child"
    );
    assert_eq!(
        http.target.server.created_items(),
        vec![target_item_id.clone()]
    );
    assert!(matches!(
        http.target.server.outcomes.lock().unwrap()[&child_id].result,
        StoredResult::Applied { .. }
    ));
    assert!(http.mutations(SOURCE_ORIGIN).is_empty());
    assert_source_visible(&runtime, &source, crate::ItemProjectionStatus::Pending);
    let before_reopen = workflow(&durable_rows(&database.0, &source).await, &operation_id);
    let path = target_create.url.strip_prefix(TARGET_ORIGIN).unwrap();
    let immutable = stored_request(&before_reopen, "PUT", path)
        .expect("prepared child request is durable before dispatch");
    assert_eq!(immutable["body"], json!(target_create.body));
    assert!(contains_value(&before_reopen, &json!(child_id)));
    assert!(
        contains_value(&admitted, &json!(target_item_id)),
        "target identity was fixed at admission"
    );
    let encrypted_body: Value = serde_json::from_slice(&target_create.body).unwrap();
    assert!(
        contains_value(&admitted, &encrypted_body["encryptedData"]),
        "accepted ciphertext was not regenerated for dispatch"
    );

    close_move_runtime(runtime, runner).await;
    drop(sqlite);
    let persisted = workflow(&durable_rows(&database.0, &source).await, &operation_id);
    assert_eq!(stored_request(&persisted, "PUT", path).unwrap(), immutable);
    assert!(contains_value(&persisted, &json!(child_id)));
    assert!(contains_value(&persisted, &json!(target_item_id)));
    http.resumed.store(true, Ordering::SeqCst);
    let runtime = open_move_runtime(MoveSqlite::open(&database.0), platform, http.clone()).await;
    for account in [&source, &target] {
        assert_eq!(
            runtime.account_access_state(account),
            Some(AccountAccessState::Locked)
        );
        runtime
            .request(
                quick_unlock_request(account.as_str()),
                RequestCancellation::new(),
            )
            .await
            .unwrap();
    }
    assert_source_visible(&runtime, &source, crate::ItemProjectionStatus::Pending);
    let runner = tokio::spawn(runtime.clone().run_operation_dispatch());
    http.trash_result
        .wait("committed source trash before its applied result is delivered")
        .await;
    assert_eq!(
        resolution(&runtime, &source, &operation_id),
        OperationResolution::Pending
    );
    assert_source_visible(&runtime, &source, crate::ItemProjectionStatus::Pending);
    assert_eq!(http.mutations(SOURCE_ORIGIN).len(), 1);
    assert!(http.target.server.outcome_lookups() >= 1);
    let all_creates = http.mutations(TARGET_ORIGIN);
    assert!(
        http.target.server.creates() >= 2,
        "the retained lookup has no fingerprint: prove it by exact immutable request replay"
    );
    for request in &all_creates {
        assert_exact_retry(request, target_create);
    }
    assert_eq!(
        http.target.server.created_items(),
        vec![target_item_id.clone()],
        "replay must preserve the single original target effect"
    );
    http.trash_result.release.add_permits(1);

    http.delete_result
        .wait("committed source deletion before its applied result is delivered")
        .await;
    assert!(
        http.source.server.created_items().is_empty(),
        "remote absence precedes proven local completion"
    );
    assert_eq!(
        resolution(&runtime, &source, &operation_id),
        OperationResolution::Pending
    );
    assert_source_visible(&runtime, &source, crate::ItemProjectionStatus::Pending);
    http.delete_result.release.add_permits(1);
    tokio::time::timeout(Duration::from_secs(10), async {
        while resolution(&runtime, &source, &operation_id) != OperationResolution::Applied {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("Move completes only after both applied destructive results");
    let source_requests = http.mutations(SOURCE_ORIGIN);
    assert_eq!(source_requests.len(), 2);
    for (request, kind, version) in [
        (&source_requests[0], "trash_item", 2),
        (&source_requests[1], "permanently_delete_item", 3),
    ] {
        let id = request.header("idempotency-key").unwrap();
        assert_ne!(id, operation_id);
        assert_ne!(id, child_id);
        assert!(
            matches!(&http.source.server.outcomes.lock().unwrap()[id].result,
            StoredResult::ExistingItemApplied { kind: actual_kind, item_id, version: actual_version }
                if *actual_kind == kind && item_id == SOURCE_ITEM && *actual_version == version)
        );
    }
    assert_ne!(
        source_requests[0].header("idempotency-key"),
        source_requests[1].header("idempotency-key")
    );
    let RuntimeProjection::Items(items) = runtime
        .projection(&ObservationRequest::Items { account_id: source })
        .unwrap()
        .projection
    else {
        panic!("expected Items")
    };
    assert!(items.items.is_empty());
    let target_items = http.target.server.created_items.lock().unwrap().clone();
    assert_eq!(target_items.len(), 1);
    let item = &target_items[0];
    let plaintext = bittery_crypto_core::decrypt_with_aad(
        &bittery_crypto_core::EncryptedData {
            ciphertext: item.encrypted_data.clone(),
            iv: item.encryption_iv.clone(),
            algorithm: item.encryption_algorithm.clone(),
        },
        &TARGET_KEY,
        &AadContext {
            vault_id: item.vault_id.clone(),
            entity_id: item.id.clone(),
            entity_type: "item".into(),
            version: 1,
            user_id: "user-1".into(),
        },
    )
    .unwrap();
    let plaintext: Value = serde_json::from_str(&plaintext).unwrap();
    assert_eq!(plaintext["title"], "Original Login");
    assert_eq!(plaintext["password"], "move-password");
    close_move_runtime(runtime, runner).await;
}

#[tokio::test]
async fn applied_source_delete_proof_survives_unavailable_authority_and_sqlite_reopen() {
    let AdmittedMoveFixture {
        database,
        platform,
        http,
        sqlite,
        runtime,
        source,
        target,
        operation_id,
    } = AdmittedMoveFixture::new().await;
    http.offline.store(false, Ordering::SeqCst);
    http.resumed.store(true, Ordering::SeqCst);
    http.unavailable_after_delete.store(true, Ordering::SeqCst);
    http.trash_result.release.add_permits(1);
    http.delete_result.release.add_permits(1);
    let runner = tokio::spawn(runtime.clone().run_operation_dispatch());
    tokio::time::timeout(
        Duration::from_secs(10),
        http.failed_post_delete_reads.acquire(),
    )
    .await
    .expect("the fresh source read after applied deletion must be attempted")
    .unwrap()
    .forget();
    // Wait for the failed read's durable retry decision, not merely its transport entry.
    let waiting = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let row = workflow(&durable_rows(&database.0, &source).await, &operation_id);
            if row["disposition"]["type"] == "waiting" {
                break row;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("failed current-authority read must retain a durable waiting workflow");
    assert_eq!(waiting["stage"]["type"], "sourceDelete");
    let delete = waiting["children"]
        .as_array()
        .unwrap()
        .iter()
        .find(|child| child["step"]["type"] == "sourceDelete")
        .expect("the immutable source-delete child remains accepted")
        .clone();
    assert!(
        !delete["result"].is_null(),
        "the applied source-delete proof must be durable even when the next current-authority read fails"
    );
    let proof: crate::replica::ObservedOutcome =
        serde_json::from_value(delete["result"].clone()).unwrap();
    assert_eq!(
        proof.result,
        OperationOutcomeResult::Applied {
            entity_id: SOURCE_ITEM.into(),
            version: 3,
        }
    );
    assert_eq!(proof.operation_id, delete["operationId"]);
    assert_eq!(
        serde_json::to_value(proof.request_fingerprint).unwrap(),
        delete["requestFingerprint"]
    );
    assert_eq!(
        resolution(&runtime, &source, &operation_id),
        OperationResolution::Pending
    );
    assert_source_visible(&runtime, &source, crate::ItemProjectionStatus::Pending);
    assert!(http.source.server.created_items().is_empty());
    let source_requests = http.mutations(SOURCE_ORIGIN);
    assert_eq!(source_requests.len(), 2);
    assert_eq!(
        source_requests[1].header("idempotency-key"),
        Some(proof.operation_id.as_str())
    );
    let target_items = http.target.server.created_items();
    assert_eq!(target_items.len(), 1);
    close_move_runtime(runtime, runner).await;
    drop(sqlite);

    let persisted = workflow(&durable_rows(&database.0, &source).await, &operation_id);
    assert!(
        persisted["children"].as_array().unwrap().contains(&delete),
        "fresh SQLite load must retain the original request and proved result together"
    );
    while let Ok(permit) = http.failed_post_delete_reads.try_acquire() {
        permit.forget();
    }
    let runtime = open_move_runtime(MoveSqlite::open(&database.0), platform, http.clone()).await;
    for account in [&source, &target] {
        runtime
            .request(
                quick_unlock_request(account.as_str()),
                RequestCancellation::new(),
            )
            .await
            .unwrap();
    }
    let runner = tokio::spawn(runtime.clone().run_operation_dispatch());
    tokio::time::timeout(
        Duration::from_secs(10),
        http.failed_post_delete_reads.acquire(),
    )
    .await
    .expect("the reopened owner still needs fresh source authority")
    .unwrap()
    .forget();
    assert_eq!(
        resolution(&runtime, &source, &operation_id),
        OperationResolution::Pending
    );
    assert_source_visible(&runtime, &source, crate::ItemProjectionStatus::Pending);
    let reopened = workflow(&durable_rows(&database.0, &source).await, &operation_id);
    assert!(reopened["children"].as_array().unwrap().contains(&delete));
    assert_eq!(
        http.mutations(SOURCE_ORIGIN).len(),
        2,
        "a durable proved delete is not repeated just because current authority was unavailable"
    );
    assert_eq!(http.target.server.created_items(), target_items);

    http.unavailable_after_delete.store(false, Ordering::SeqCst);
    tokio::time::timeout(Duration::from_secs(10), async {
        while resolution(&runtime, &source, &operation_id) != OperationResolution::Applied {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("fresh source absence completes the already-proven Move");
    let completed = workflow(&durable_rows(&database.0, &source).await, &operation_id);
    assert_eq!(completed["stage"]["type"], "completed");
    assert!(completed["children"].as_array().unwrap().contains(&delete));
    let RuntimeProjection::Items(items) = runtime
        .projection(&ObservationRequest::Items { account_id: source })
        .unwrap()
        .projection
    else {
        panic!("expected Items")
    };
    assert!(items.items.is_empty());
    assert_eq!(http.mutations(SOURCE_ORIGIN).len(), 2);
    assert_eq!(http.target.server.created_items(), target_items);
    close_move_runtime(runtime, runner).await;
}
