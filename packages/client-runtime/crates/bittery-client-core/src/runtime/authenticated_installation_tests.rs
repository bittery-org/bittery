use super::*;
use crate::{
    auth_http::{AuthClientConfig, ClientPlatform},
    authentication_installation::{
        AuthenticationInstallationEvidence, FixedClock, InstallationEntropy,
    },
    platform_storage::SerializedPlatformStorageExecutor,
    protocol::Incarnation,
    replica::{
        InMemoryReplica, ObservedOutcome, OperationOutcomeResult, ReplicaPersistence,
        ReplicaPersistenceRequest, SerializedReplicaExecutor,
    },
    server_contract::{
        AuthVaultKeyResponse, LoginUserResponse, TravelModeResponse, VaultRole, VaultType,
    },
};
use async_trait::async_trait;
use bittery_crypto_core::{
    current_kdf_profile, derive_keys, encrypt_vault_key_with_muk, encrypt_with_aad,
    generate_encryption_key,
    srp6a::{HashAlgorithm, PrimeGroup},
    AadContext, SrpClient, SrpServer, VaultKeyWrapContext,
};
use serde_json::{json, Value};
use std::collections::VecDeque;

const SECRET_KEY: &str = "A3-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXYZ2";
const MASTER_PASSWORD: &str = "correct horse battery staple";
const NORMALIZED_EMAIL: &str = "user-1@example.com";
const SRP_SALT: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const NOW_MS: u64 = 1_700_000_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PersistenceStep {
    DeviceKey,
    PendingCatalog,
    Metadata,
    QuickUnlock,
    Replica,
    PromotedCatalog,
    CurrentSession,
}

#[derive(Clone, Copy)]
enum ReplicaFault {
    BeforeApply,
    ApplyThenError,
    ApplyThenUnreadable,
    ThirdHead,
}

struct Pause {
    step: PersistenceStep,
    reached: AtomicBool,
    released: AtomicBool,
    reached_notify: tokio::sync::Notify,
    release_notify: tokio::sync::Notify,
}

impl Pause {
    fn new(step: PersistenceStep) -> Arc<Self> {
        Arc::new(Self {
            step,
            reached: AtomicBool::new(false),
            released: AtomicBool::new(false),
            reached_notify: tokio::sync::Notify::new(),
            release_notify: tokio::sync::Notify::new(),
        })
    }

    async fn wait_until_reached(&self) {
        while !self.reached.load(Ordering::SeqCst) {
            self.reached_notify.notified().await;
        }
    }

    fn release(&self) {
        self.released.store(true, Ordering::SeqCst);
        self.release_notify.notify_waiters();
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HttpPauseStep {
    Bootstrap,
    Events,
    AccountDeletion,
}

struct HttpPause {
    step: HttpPauseStep,
    reached: AtomicBool,
    released: AtomicBool,
    reached_notify: tokio::sync::Notify,
    release_notify: tokio::sync::Notify,
}

impl HttpPause {
    fn new(step: HttpPauseStep) -> Arc<Self> {
        Arc::new(Self {
            step,
            reached: AtomicBool::new(false),
            released: AtomicBool::new(false),
            reached_notify: tokio::sync::Notify::new(),
            release_notify: tokio::sync::Notify::new(),
        })
    }

    fn matches(&self, route: V1Route<'_>) -> bool {
        matches!(
            (self.step, route),
            (HttpPauseStep::Bootstrap, V1Route::SyncBootstrap)
                | (HttpPauseStep::Events, V1Route::SyncEvents)
                | (HttpPauseStep::AccountDeletion, V1Route::DeleteAccount)
        )
    }

    async fn wait_until_reached(&self) {
        while !self.reached.load(Ordering::SeqCst) {
            self.reached_notify.notified().await;
        }
    }

    fn release(&self) {
        self.released.store(true, Ordering::SeqCst);
        self.release_notify.notify_waiters();
    }
}

#[derive(Default)]
struct InstallationPlatform {
    values: Mutex<HashMap<(String, String), String>>,
    events: Arc<Mutex<Vec<PersistenceStep>>>,
    invocations: AtomicU64,
    fault: Mutex<Option<PersistenceStep>>,
    read_fault: Mutex<Option<RuntimeError>>,
    pause: Mutex<Option<Arc<Pause>>>,
    cancel_on_next_write: Mutex<Option<RequestCancellation>>,
}

impl InstallationPlatform {
    fn fail_at(&self, step: PersistenceStep) {
        *self.fault.lock().unwrap() = Some(step);
    }

    fn fail_next_read(&self, error: RuntimeError) {
        *self.read_fault.lock().unwrap() = Some(error);
    }

    fn pause_at(&self, pause: Arc<Pause>) {
        *self.pause.lock().unwrap() = Some(pause);
    }

    fn clear_events(&self) {
        self.events.lock().unwrap().clear();
        self.invocations.store(0, Ordering::SeqCst);
    }

    fn cancel_on_next_write(&self, cancellation: RequestCancellation) {
        *self.cancel_on_next_write.lock().unwrap() = Some(cancellation);
    }

    fn events(&self) -> Vec<PersistenceStep> {
        self.events.lock().unwrap().clone()
    }

    fn invocation_count(&self) -> u64 {
        self.invocations.load(Ordering::SeqCst)
    }

    fn catalog(&self) -> Option<DeviceCatalogDocument> {
        self.values
            .lock()
            .unwrap()
            .get(&(
                "devicePlain".into(),
                "bittery:runtime:platform-storage:device-catalog".into(),
            ))
            .map(|value| serde_json::from_str(value).unwrap())
    }

    fn has_document(&self, account: &str, incarnation: &str, document: &str) -> bool {
        let expected = generation_storage_key(account, incarnation, document);
        self.values
            .lock()
            .unwrap()
            .keys()
            .any(|(_, key)| key == &expected)
    }

    fn put_document<T: serde::Serialize>(&self, area: &str, key: String, value: &T) {
        self.values
            .lock()
            .unwrap()
            .insert((area.into(), key), serde_json::to_string(value).unwrap());
    }
}

fn classify_set(key: &str, serialized: &str) -> PersistenceStep {
    if key.ends_with("device-key") {
        PersistenceStep::DeviceKey
    } else if key.ends_with("device-catalog") {
        let value: Value = serde_json::from_str(serialized).unwrap();
        if value["accounts"].as_array().is_some_and(|accounts| {
            accounts
                .iter()
                .any(|account| !account["pendingInstall"].is_null())
        }) {
            PersistenceStep::PendingCatalog
        } else {
            PersistenceStep::PromotedCatalog
        }
    } else if key.ends_with("metadata") {
        PersistenceStep::Metadata
    } else if key.ends_with("quick-unlock") {
        PersistenceStep::QuickUnlock
    } else if key.ends_with("current-session") {
        PersistenceStep::CurrentSession
    } else {
        panic!("unknown installation test key: {key}")
    }
}

#[async_trait]
impl SerializedPlatformStorageExecutor for InstallationPlatform {
    async fn invoke(
        &self,
        request_json: Zeroizing<String>,
    ) -> Result<Zeroizing<String>, RuntimeError> {
        self.invocations.fetch_add(1, Ordering::SeqCst);
        let request: Value = serde_json::from_str(&request_json).unwrap();
        let area = request["area"].as_str().unwrap().to_owned();
        let key = request["key"].as_str().unwrap().to_owned();
        match request["type"].as_str().unwrap() {
            "get" => Ok(Zeroizing::new(
                if let Some(error) = self.read_fault.lock().unwrap().take() {
                    return Err(error);
                } else {
                    json!({
                        "type": "value",
                        "value": self.values.lock().unwrap().get(&(area, key)).cloned()
                    })
                    .to_string()
                },
            )),
            "set" => {
                let serialized = request["value"].as_str().unwrap().to_owned();
                let step = classify_set(&key, &serialized);
                self.events.lock().unwrap().push(step);
                if let Some(cancellation) = self.cancel_on_next_write.lock().unwrap().take() {
                    cancellation.cancel();
                }
                let should_fail = {
                    let mut fault = self.fault.lock().unwrap();
                    if *fault == Some(step) {
                        fault.take();
                        true
                    } else {
                        false
                    }
                };
                if should_fail {
                    return Err(startup_invariant("injected platform write failure"));
                }
                self.values.lock().unwrap().insert((area, key), serialized);
                let pause = self.pause.lock().unwrap().clone();
                if let Some(pause) = pause.filter(|pause| pause.step == step) {
                    pause.reached.store(true, Ordering::SeqCst);
                    pause.reached_notify.notify_waiters();
                    while !pause.released.load(Ordering::SeqCst) {
                        pause.release_notify.notified().await;
                    }
                }
                Ok(Zeroizing::new(json!({"type": "done"}).to_string()))
            }
            "delete" => {
                self.values.lock().unwrap().remove(&(area, key));
                Ok(Zeroizing::new(json!({"type": "done"}).to_string()))
            }
            // A namespace delete must fail an assertion, not abort the test harness.
            "deletePrefix" => Err(startup_invariant(
                "installation reached a platform namespace delete",
            )),
            other => panic!("unexpected platform request {other}"),
        }
    }
}

struct InstallationReplica {
    state: InMemoryReplica,
    events: Arc<Mutex<Vec<PersistenceStep>>>,
    fault: Mutex<Option<ReplicaFault>>,
    fail_next_load: AtomicBool,
    fail_next_commit: AtomicBool,
}

impl InstallationReplica {
    fn new(events: Arc<Mutex<Vec<PersistenceStep>>>) -> Self {
        Self {
            state: InMemoryReplica::default(),
            events,
            fault: Mutex::new(None),
            fail_next_load: AtomicBool::new(false),
            fail_next_commit: AtomicBool::new(false),
        }
    }

    fn fail_with(&self, fault: ReplicaFault) {
        *self.fault.lock().unwrap() = Some(fault);
    }

    fn fail_next_commit(&self) {
        self.fail_next_commit.store(true, Ordering::SeqCst);
    }
}

#[async_trait]
impl SerializedReplicaExecutor for InstallationReplica {
    async fn invoke(&self, request_json: String) -> Result<String, RuntimeError> {
        let mut request: ReplicaPersistenceRequest = serde_json::from_str(&request_json).unwrap();
        if matches!(request, ReplicaPersistenceRequest::Load { .. })
            && self.fail_next_load.swap(false, Ordering::SeqCst)
        {
            return Err(startup_invariant("injected Replica reread failure"));
        }
        if matches!(request, ReplicaPersistenceRequest::Commit { .. })
            && self.fail_next_commit.swap(false, Ordering::SeqCst)
        {
            return Err(startup_invariant("injected Replica commit failure"));
        }
        if let ReplicaPersistenceRequest::Install { prepared } = &mut request {
            self.events.lock().unwrap().push(PersistenceStep::Replica);
            let fault = self.fault.lock().unwrap().take();
            match fault {
                Some(ReplicaFault::BeforeApply) => {
                    return Err(startup_invariant("injected Replica failure"));
                }
                Some(ReplicaFault::ApplyThenError) => {
                    self.state.invoke(request).await?;
                    return Err(startup_invariant("lost Replica apply response"));
                }
                Some(ReplicaFault::ApplyThenUnreadable) => {
                    self.state.invoke(request).await?;
                    self.fail_next_load.store(true, Ordering::SeqCst);
                    return Err(startup_invariant("lost Replica apply response"));
                }
                Some(ReplicaFault::ThirdHead) => {
                    prepared.next_head.incarnation = Incarnation::from("third-generation");
                }
                None => {}
            }
        }
        serde_json::to_string(&self.state.invoke(request).await?)
            .map_err(|_| startup_invariant("test Replica response could not serialize"))
    }
}

struct FixedEntropy {
    ids: Mutex<VecDeque<String>>,
}

impl FixedEntropy {
    fn new(ids: &[&str]) -> Self {
        Self {
            ids: Mutex::new(ids.iter().map(|value| (*value).to_owned()).collect()),
        }
    }
}

impl InstallationEntropy for FixedEntropy {
    fn generate_uuid(&self) -> String {
        self.ids
            .lock()
            .unwrap()
            .pop_front()
            .expect("test UUID script exhausted")
    }

    fn generate_device_key(&self) -> [u8; 32] {
        [0x5A; 32]
    }
}

struct UnusedHttp;

#[derive(Default)]
struct Sink(Mutex<Vec<RuntimeProjection>>);

impl ObservationSink for Sink {
    fn publish(&self, projection: RuntimeProjection) {
        self.0.lock().unwrap().push(projection);
    }
}

#[async_trait]
impl SerializedHttpExecutor for UnusedHttp {
    async fn invoke(&self, _request_json: String) -> Result<String, RuntimeError> {
        panic!("installation coordinator tests do not use HTTP")
    }

    fn cancel(&self, _dispatch_id: &str) {}
}

#[derive(Clone, Copy)]
enum RoutingAuthBehavior {
    Success,
    BadProof,
    FollowUpError,
    CancelAfterStart,
    UserMismatch,
}

struct RoutingAuthHttp {
    state: Mutex<RoutingAuthState>,
    kdf_profile: bittery_crypto_core::KdfProfile,
    behavior: RoutingAuthBehavior,
    cancellation: Option<RequestCancellation>,
    bootstrap_pages: Mutex<Vec<Value>>,
    changes_pages: Mutex<Vec<Value>>,
    item_bodies: Mutex<HashMap<String, Value>>,
    sse_body: Mutex<Vec<u8>>,
    refresh_status: Mutex<Option<u16>>,
    disconnected: AtomicBool,
    unauthorized_sync_once: AtomicBool,
    pause: Mutex<Option<Arc<HttpPause>>>,
    account_deletion_responses: Mutex<VecDeque<(u16, Value)>>,
}

struct RoutingAuthState {
    requests: Vec<Value>,
    server: SrpServer,
    verifier: String,
    server_ephemeral: bittery_crypto_core::srp6a::Ephemeral,
    bootstrap_index: usize,
    changes_index: usize,
}

impl RoutingAuthHttp {
    fn new(
        kdf_profile: bittery_crypto_core::KdfProfile,
        behavior: RoutingAuthBehavior,
        cancellation: Option<RequestCancellation>,
    ) -> Self {
        let srp = SrpClient::new(HashAlgorithm::Sha256, PrimeGroup::G4096);
        let server = SrpServer::new(HashAlgorithm::Sha256, PrimeGroup::G4096);
        let derived =
            derive_keys(MASTER_PASSWORD, SECRET_KEY, NORMALIZED_EMAIL, &kdf_profile).unwrap();
        let password = Zeroizing::new(String::from_utf8_lossy(&derived.auth_key).into_owned());
        let private_key = Zeroizing::new(
            srp.derive_safe_private_key(SRP_SALT, &password, None)
                .unwrap(),
        );
        let verifier = srp.derive_verifier(&private_key).unwrap();
        let server_ephemeral = server.generate_ephemeral(&verifier).unwrap();
        Self {
            state: Mutex::new(RoutingAuthState {
                requests: Vec::new(),
                server,
                verifier,
                server_ephemeral,
                bootstrap_index: 0,
                changes_index: 0,
            }),
            kdf_profile,
            behavior,
            cancellation,
            bootstrap_pages: Mutex::new(Vec::new()),
            changes_pages: Mutex::new(Vec::new()),
            item_bodies: Mutex::new(HashMap::new()),
            sse_body: Mutex::new(Vec::new()),
            refresh_status: Mutex::new(None),
            disconnected: AtomicBool::new(false),
            unauthorized_sync_once: AtomicBool::new(false),
            pause: Mutex::new(None),
            account_deletion_responses: Mutex::new(VecDeque::new()),
        }
    }

    fn disconnect(&self) {
        self.disconnected.store(true, Ordering::SeqCst);
    }

    fn pause_at(&self, pause: Arc<HttpPause>) {
        *self.pause.lock().unwrap() = Some(pause);
    }

    fn requests(&self) -> Vec<Value> {
        self.state.lock().unwrap().requests.clone()
    }

    fn clear_requests(&self) {
        self.state.lock().unwrap().requests.clear();
    }

    fn start_login(&self, state: &mut RoutingAuthState) -> String {
        let body = routing_request_body(state.requests.last().unwrap());
        assert_eq!(body["email"], NORMALIZED_EMAIL);
        if matches!(self.behavior, RoutingAuthBehavior::CancelAfterStart) {
            self.cancellation.as_ref().unwrap().cancel();
        }
        routing_completed(
            201,
            json!({
                "attemptId": "attempt-1",
                "kdfParams": {
                    "algorithm": self.kdf_profile.algorithm,
                    "iterations": self.kdf_profile.iterations,
                    "schemaVersion": self.kdf_profile.schema_version
                },
                "salt": SRP_SALT,
                "serverPublicKey": state.server_ephemeral.public
            }),
        )
    }

    fn finish_login(&self, state: &mut RoutingAuthState) -> String {
        let body = routing_request_body(state.requests.last().unwrap());
        let session = state
            .server
            .derive_session(
                &state.server_ephemeral.secret,
                body["clientPublicKey"].as_str().unwrap(),
                SRP_SALT,
                "",
                &state.verifier,
                body["clientProof"].as_str().unwrap(),
            )
            .expect("the Runtime must produce the unchanged SRP proof");
        let proof = if matches!(self.behavior, RoutingAuthBehavior::BadProof) {
            "00".to_owned()
        } else {
            session.proof.clone()
        };
        let user_id = if matches!(self.behavior, RoutingAuthBehavior::UserMismatch) {
            "user-2"
        } else {
            "user-1"
        };
        routing_completed(
            200,
            json!({
                "expiresAt": "2099-01-01T00:00:00Z",
                "serverProof": proof,
                "sessionId": "session-1",
                "token": "fresh-token",
                "user": {
                    "email": NORMALIZED_EMAIL,
                    "encryptedPrivateKey": "encrypted-private-key",
                    "id": user_id,
                    "name": "User One",
                    "publicKey": "public-key",
                    "secretKeyHint": "A3-ABCDEF",
                    "teamAvatarUrl": null,
                    "teamName": "User One"
                },
                "vaultKeys": { "hasMore": false, "items": [], "nextCursor": null }
            }),
        )
    }

    fn travel_mode(&self) -> String {
        if matches!(self.behavior, RoutingAuthBehavior::FollowUpError) {
            return routing_completed(500, json!({"error": "injected"}));
        }
        routing_completed(
            200,
            json!({
                "enabled": false,
                "enabledAt": null,
                "hiddenVaultIds": [],
                "updatedAt": "2029-01-02T00:00:00Z"
            }),
        )
    }

    fn bootstrap_page(&self, state: &mut RoutingAuthState) -> String {
        let pages = self.bootstrap_pages.lock().unwrap();
        let mut page = pages
            .get(state.bootstrap_index)
            .cloned()
            .unwrap_or_else(|| {
                json!({
                    "hasMore": false,
                    "items": [],
                    "nextCursor": null,
                    "syncCursor": null
                })
            });
        if page.get("phase").is_none() {
            let requested_phase = state
                .requests
                .last()
                .and_then(|request| request["url"].as_str())
                .and_then(|url| url.split("phase=").nth(1))
                .and_then(|query| query.split('&').next())
                .unwrap_or("vaults");
            if requested_phase == "vaults" {
                let mut vaults = Vec::new();
                for item in page["items"].as_array().into_iter().flatten() {
                    if let Some(vault) = item.get("vault") {
                        if vaults
                            .iter()
                            .all(|existing: &Value| existing["id"] != vault["id"])
                        {
                            vaults.push(vault.clone());
                        }
                    }
                }
                page = json!({
                    "phase": "vaults",
                    "hasMore": false,
                    "nextCursor": null,
                    "syncCursor": page["syncCursor"].clone(),
                    "vaults": vaults
                });
            } else {
                for item in page["items"].as_array_mut().into_iter().flatten() {
                    item.as_object_mut().unwrap().remove("vault");
                }
                page["phase"] = json!("items");
                state.bootstrap_index += 1;
            }
        } else {
            state.bootstrap_index += 1;
        }
        routing_completed(200, page)
    }

    fn changes_page(&self, state: &mut RoutingAuthState) -> String {
        let pages = self.changes_pages.lock().unwrap();
        let page = pages.get(state.changes_index).cloned().unwrap_or_else(|| {
            json!({
                "cursor": null,
                "events": [],
                "hasMore": false,
                "requiresFullRefresh": false
            })
        });
        state.changes_index += 1;
        routing_completed(200, page)
    }

    fn item(&self, item_id: &str) -> String {
        match self.item_bodies.lock().unwrap().get(item_id) {
            Some(body) => routing_completed(200, body.clone()),
            None => routing_completed(404, json!({"error": "missing"})),
        }
    }

    fn sse_events(&self) -> String {
        let body = self.sse_body.lock().unwrap().clone();
        if body.is_empty() {
            return routing_completed(200, json!({}));
        }
        json!({
            "type": "completed",
            "status": 200,
            "headers": [{"name": "Content-Type", "value": "text/event-stream"}],
            "body": body
        })
        .to_string()
    }

    fn refresh_session(&self) -> String {
        routing_completed(
            200,
            json!({
                "expiresAt": "2099-01-01T00:00:00Z",
                "sessionId": "session-1",
                "token": "refreshed-token"
            }),
        )
    }
}

#[derive(Clone, Copy)]
enum V1Route<'a> {
    StartLogin,
    FinishLogin,
    TravelMode,
    RefreshSession,
    DeleteAccount,
    SyncBootstrap,
    SyncChanges,
    SyncEvents,
    Item(&'a str),
}

fn v1_route(url: &str) -> Option<V1Route<'_>> {
    let rest = url.split_once("/api/v1/")?.1;
    let path = rest.split(['?', '#']).next().unwrap_or(rest);
    match path {
        "auth/login-attempts" => Some(V1Route::StartLogin),
        "auth/login-attempts/attempt-1/finish" => Some(V1Route::FinishLogin),
        "travel-mode" => Some(V1Route::TravelMode),
        "sessions/current/refresh" => Some(V1Route::RefreshSession),
        "users/me" => Some(V1Route::DeleteAccount),
        "sync/bootstrap" => Some(V1Route::SyncBootstrap),
        "sync/changes" => Some(V1Route::SyncChanges),
        "sync/events" => Some(V1Route::SyncEvents),
        path => path.strip_prefix("items/").map(V1Route::Item),
    }
}

fn is_renewable_session_route(route: V1Route<'_>) -> bool {
    matches!(
        route,
        V1Route::RefreshSession
            | V1Route::SyncBootstrap
            | V1Route::SyncChanges
            | V1Route::SyncEvents
            | V1Route::Item(_)
    )
}

fn is_sync_route(route: V1Route<'_>) -> bool {
    matches!(
        route,
        V1Route::SyncBootstrap | V1Route::SyncChanges | V1Route::SyncEvents
    )
}

#[async_trait]
impl SerializedHttpExecutor for RoutingAuthHttp {
    async fn invoke(&self, request_json: String) -> Result<String, RuntimeError> {
        if self.disconnected.load(Ordering::SeqCst) {
            return Ok(json!({ "type": "networkFailure" }).to_string());
        }
        let request: Value = serde_json::from_str(&request_json).unwrap();
        assert_auth_headers(&request);
        let url = request["url"].as_str().unwrap().to_owned();
        {
            let mut state = self.state.lock().unwrap();
            state.requests.push(request);
        }

        let Some(route) = v1_route(&url) else {
            return Err(startup_invariant("unexpected authentication test request"));
        };
        if *self.refresh_status.lock().unwrap() == Some(401) && is_renewable_session_route(route) {
            return Ok(routing_completed(401, json!({"error": "unauthorized"})));
        }
        if is_sync_route(route) && self.unauthorized_sync_once.swap(false, Ordering::SeqCst) {
            return Ok(routing_completed(401, json!({"error": "unauthorized"})));
        }
        let pause = self.pause.lock().unwrap().clone();
        if let Some(pause) = pause {
            if pause.matches(route) {
                pause.reached.store(true, Ordering::SeqCst);
                pause.reached_notify.notify_waiters();
                while !pause.released.load(Ordering::SeqCst) {
                    pause.release_notify.notified().await;
                }
            }
        }
        let mut state = self.state.lock().unwrap();
        Ok(match v1_route(&url).expect("route was already parsed") {
            V1Route::StartLogin => self.start_login(&mut state),
            V1Route::FinishLogin => self.finish_login(&mut state),
            V1Route::TravelMode => self.travel_mode(),
            V1Route::RefreshSession => self.refresh_session(),
            V1Route::DeleteAccount => {
                let request = state.requests.last().unwrap();
                let request_id = request["headers"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|header| header["name"] == "Idempotency-Key")
                    .and_then(|header| header["value"].as_str())
                    .expect("deletion request identity header")
                    .to_owned();
                let response = self.account_deletion_responses.lock().unwrap().pop_front();
                match response {
                    Some((status @ (400 | 409), body)) => routing_problem_completed(status, body),
                    Some((status, body)) => routing_completed(status, body),
                    None => routing_completed(
                        200,
                        json!({"requestId": request_id, "outcome": "deleted"}),
                    ),
                }
            }
            V1Route::SyncBootstrap => self.bootstrap_page(&mut state),
            V1Route::SyncChanges => self.changes_page(&mut state),
            V1Route::SyncEvents => self.sse_events(),
            V1Route::Item(item_id) => self.item(item_id),
        })
    }

    fn cancel(&self, _dispatch_id: &str) {}
}

fn assert_auth_headers(request: &Value) {
    let headers = request["headers"].as_array().unwrap();
    for (name, value) in [
        ("Bittery-Client-Id", "client-routing"),
        ("Bittery-Client-Platform", "desktop"),
        ("Bittery-Client-Version", "0.5.2-test"),
    ] {
        assert!(headers
            .iter()
            .any(|header| header["name"] == name && header["value"] == value));
    }
}

fn routing_request_body(request: &Value) -> Value {
    let body: Vec<u8> = serde_json::from_value(request["body"].clone()).unwrap();
    serde_json::from_slice(&body).unwrap()
}

fn routing_completed(status: u16, body: Value) -> String {
    json!({
        "type": "completed",
        "status": status,
        "headers": [{"name": "Content-Type", "value": "application/json"}],
        "body": serde_json::to_vec(&body).unwrap()
    })
    .to_string()
}

fn routing_problem_completed(status: u16, body: Value) -> String {
    json!({
        "type": "completed",
        "status": status,
        "headers": [
            {"name": "Content-Type", "value": "application/problem+json"},
            {"name": "Idempotency-Replayed", "value": "true"}
        ],
        "body": serde_json::to_vec(&body).unwrap()
    })
    .to_string()
}

fn vault_key(id: &str) -> AuthVaultKeyResponse {
    AuthVaultKeyResponse {
        encrypted_vault_key: format!("wrapped-{id}"),
        role: VaultRole::Owner,
        vault_icon: None,
        vault_id: id.into(),
        vault_image_url: None,
        vault_name: id.into(),
        vault_type: VaultType::Personal,
    }
}

fn verified(user_id: &str) -> VerifiedAuthentication {
    VerifiedAuthentication {
        normalized_server_url: "https://vault.example.com".into(),
        kdf_profile: bittery_crypto_core::current_kdf_profile(),
        master_unlock_key: Zeroizing::new([0xA5; 32]),
        token: Zeroizing::new("session-token".into()),
        session_id: "session-id".into(),
        expires_at: "2030-01-01T00:00:00Z".into(),
        user: LoginUserResponse {
            email: format!("{user_id}@example.com"),
            encrypted_private_key: "encrypted-private-key".into(),
            id: user_id.into(),
            name: "User".into(),
            public_key: "public-key".into(),
            secret_key_hint: "A3-A••••".into(),
            team_avatar_url: None,
            team_name: None,
        },
        vault_keys: vec![vault_key("visible"), vault_key("hidden")],
        travel_mode: TravelModeResponse {
            enabled: true,
            enabled_at: Some("2029-01-01T00:00:00Z".into()),
            hidden_vault_ids: vec!["hidden".into()],
            updated_at: "2029-01-02T00:00:00Z".into(),
        },
    }
}

fn evidence() -> AuthenticationInstallationEvidence {
    AuthenticationInstallationEvidence::new(SECRET_KEY.into(), false)
}

async fn harness() -> (
    Arc<Runtime>,
    Arc<InstallationReplica>,
    Arc<InstallationPlatform>,
) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let replica = Arc::new(InstallationReplica::new(events.clone()));
    let platform = Arc::new(InstallationPlatform {
        events,
        ..InstallationPlatform::default()
    });
    let runtime =
        Runtime::with_serialized_executors(replica.clone(), platform.clone(), Arc::new(UnusedHttp));
    runtime.open().await.unwrap();
    platform.clear_events();
    (runtime, replica, platform)
}

async fn routing_harness(
    http: Arc<RoutingAuthHttp>,
) -> (
    Arc<Runtime>,
    Arc<InstallationReplica>,
    Arc<InstallationPlatform>,
) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let replica = Arc::new(InstallationReplica::new(events.clone()));
    let platform = Arc::new(InstallationPlatform {
        events,
        ..InstallationPlatform::default()
    });
    let runtime = Runtime::with_configured_serialized_executors(
        replica.clone(),
        platform.clone(),
        http,
        AuthClientConfig::new(
            "client-routing".into(),
            ClientPlatform::Desktop,
            "0.5.2-test".into(),
        )
        .unwrap(),
    );
    runtime.open().await.unwrap();
    platform.clear_events();
    (runtime, replica, platform)
}

async fn install(
    runtime: &Runtime,
    user_id: &str,
    entropy: &FixedEntropy,
) -> Result<RuntimeResponse, RuntimeError> {
    runtime
        .install_verified_authentication_with(
            verified(user_id),
            evidence(),
            &FixedClock(NOW_MS),
            entropy,
        )
        .await
}

fn runtime_status(runtime: &Runtime) -> RuntimeStatusProjection {
    let projected = runtime
        .projection(&ObservationRequest::RuntimeStatus { account_id: None })
        .unwrap();
    let RuntimeProjection::RuntimeStatus(status) = projected.projection else {
        panic!("Runtime-status observation returned another projection");
    };
    status
}

fn create_request(account_id: &str) -> RuntimeRequest {
    RuntimeRequest::CreateLoginItem {
        account_id: AccountId::from(account_id),
        // The Bootstrap fixtures publish one personal Vault, and a local write has to name the
        // Vault the Replica actually holds.
        vault_id: "vault-1".into(),
        draft: crate::LoginItemDraft {
            title: "Login".into(),
            url: None,
            urls: Vec::new(),
            username: None,
            password: None,
            notes: None,
            note: None,
            custom_fields: Vec::new(),
            tags: Vec::new(),
        },
    }
}

fn sign_in_request(email: &str) -> RuntimeRequest {
    sign_in_request_to("https://vault.example.com", email)
}

fn sign_in_request_to(server_url: &str, email: &str) -> RuntimeRequest {
    RuntimeRequest::SignIn {
        server_url: server_url.into(),
        email: email.into(),
        master_password: MASTER_PASSWORD.into(),
        secret_key: SECRET_KEY.into(),
        insecure_transport_confirmed: false,
    }
}

fn quick_unlock_request(account_id: &str) -> RuntimeRequest {
    RuntimeRequest::QuickUnlock {
        account_id: AccountId::from(account_id),
        master_password: MASTER_PASSWORD.into(),
    }
}

fn verified_with_derived_muk() -> VerifiedAuthentication {
    let mut result = verified("user-1");
    result.user.email = NORMALIZED_EMAIL.into();
    result.master_unlock_key = Zeroizing::new(
        derive_keys(
            MASTER_PASSWORD,
            SECRET_KEY,
            NORMALIZED_EMAIL,
            &result.kdf_profile,
        )
        .unwrap()
        .master_unlock_key,
    );
    result
}

async fn install_quick_unlock_account(runtime: &Runtime, platform: &InstallationPlatform) {
    runtime
        .install_verified_authentication_with(
            verified_with_derived_muk(),
            evidence(),
            &FixedClock(NOW_MS),
            &FixedEntropy::new(&["account-1", "generation-1"]),
        )
        .await
        .unwrap();
    runtime
        .mark_account_locked(&AccountId::from("account-1"))
        .await
        .unwrap();
    platform.clear_events();
}

#[tokio::test]
async fn sign_in_routes_the_verified_ceremony_into_one_published_unlocked_account() {
    let http = Arc::new(RoutingAuthHttp::new(
        current_kdf_profile(),
        RoutingAuthBehavior::Success,
        None,
    ));
    let (runtime, _replica, platform) = routing_harness(http.clone()).await;
    let status_sink = Arc::new(Sink::default());
    let _status = runtime
        .observe(
            ObservationRequest::RuntimeStatus { account_id: None },
            status_sink.clone(),
        )
        .unwrap();

    let response = runtime
        .request(
            sign_in_request("  ＵＳＥＲ-1＠ＥＸＡＭＰＬＥ．ＣＯＭ  "),
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let RuntimeResponse::SignedIn {
        account_id,
        user_id,
    } = response
    else {
        panic!("Sign-in returned another response");
    };

    assert_eq!(user_id, "user-1");
    assert!(http.requests().len() >= 3);
    assert_eq!(platform.catalog().unwrap().accounts.len(), 1);
    let snapshot = runtime.replica.snapshot(&account_id).unwrap();
    assert!(runtime.has_live_master_unlock_key(&account_id, &snapshot.incarnation));
    assert_eq!(
        runtime.account_access_state(&account_id),
        Some(AccountAccessState::Unlocked)
    );
    let projections = status_sink.0.lock().unwrap();
    assert!(projections.len() >= 2);
    let RuntimeProjection::RuntimeStatus(status) = projections.last().unwrap() else {
        panic!("status observer received another projection");
    };
    assert_eq!(status.accounts.len(), 1);
    assert_eq!(status.accounts[0].account_id, account_id);
    assert_eq!(status.accounts[0].access, AccountAccessState::Unlocked);
    assert_eq!(
        status.accounts[0]
            .display_identity
            .as_ref()
            .map(|identity| identity.email.as_str()),
        Some(NORMALIZED_EMAIL)
    );
}

#[tokio::test]
async fn server_account_deletion_uses_the_scoped_session_and_exact_wire_contract() {
    let http = Arc::new(RoutingAuthHttp::new(
        current_kdf_profile(),
        RoutingAuthBehavior::Success,
        None,
    ));
    let (runtime, _replica, _platform) = routing_harness(http.clone()).await;
    let RuntimeResponse::SignedIn { account_id, .. } = runtime
        .request(
            sign_in_request(NORMALIZED_EMAIL),
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("expected SignedIn");
    };
    http.clear_requests();
    let request_id = "018f05c4-7b6a-4a89-9237-2e612fa96d11";

    let response = runtime
        .request(
            RuntimeRequest::DeleteServerAccount {
                account_id: account_id.clone(),
                confirm_email: "  ＵＳＥＲ-1＠ＥＸＡＭＰＬＥ．ＣＯＭ  ".into(),
                request_id: request_id.into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        response,
        RuntimeResponse::ServerAccountDeletion {
            account_id,
            request_id: request_id.into(),
            outcome: crate::protocol::ServerAccountDeletionOutcome::Deleted,
        }
    );

    let requests = http.requests();
    assert_eq!(requests.len(), 1);
    let request = &requests[0];
    assert_eq!(request["method"], "DELETE");
    assert!(request["url"]
        .as_str()
        .unwrap()
        .ends_with("/api/v1/users/me"));
    assert_eq!(
        routing_request_body(request),
        json!({"confirmEmail": NORMALIZED_EMAIL})
    );
    let headers = request["headers"].as_array().unwrap();
    assert!(headers.iter().any(|header| {
        header["name"] == "Authorization" && header["value"] == "Bearer fresh-token"
    }));
    assert!(headers
        .iter()
        .any(|header| { header["name"] == "Idempotency-Key" && header["value"] == request_id }));
}

#[tokio::test]
async fn server_account_deletion_refreshes_once_then_retries_identical_bytes() {
    let http = Arc::new(RoutingAuthHttp::new(
        current_kdf_profile(),
        RoutingAuthBehavior::Success,
        None,
    ));
    let (runtime, _replica, _platform) = routing_harness(http.clone()).await;
    let RuntimeResponse::SignedIn { account_id, .. } = runtime
        .request(
            sign_in_request(NORMALIZED_EMAIL),
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("expected SignedIn");
    };
    let request_id = "018f05c4-7b6a-4a89-9237-2e612fa96d12";
    *http.account_deletion_responses.lock().unwrap() = VecDeque::from([
        (401, json!({"error": "expired"})),
        (200, json!({"requestId": request_id, "outcome": "deleted"})),
    ]);
    http.clear_requests();

    runtime
        .request(
            RuntimeRequest::DeleteServerAccount {
                account_id: account_id.clone(),
                confirm_email: NORMALIZED_EMAIL.into(),
                request_id: request_id.into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();

    let requests = http.requests();
    assert_eq!(requests.len(), 3);
    assert!(requests[0]["url"].as_str().unwrap().ends_with("/users/me"));
    assert!(requests[1]["url"]
        .as_str()
        .unwrap()
        .ends_with("/sessions/current/refresh"));
    assert!(requests[2]["url"].as_str().unwrap().ends_with("/users/me"));
    assert_eq!(requests[0]["body"], requests[2]["body"]);
    let first_headers = requests[0]["headers"].as_array().unwrap();
    let retry_headers = requests[2]["headers"].as_array().unwrap();
    assert!(first_headers.iter().any(|header| {
        header["name"] == "Authorization" && header["value"] == "Bearer fresh-token"
    }));
    assert!(retry_headers.iter().any(|header| {
        header["name"] == "Authorization" && header["value"] == "Bearer refreshed-token"
    }));
    assert_eq!(
        first_headers
            .iter()
            .find(|header| header["name"] == "Idempotency-Key"),
        retry_headers
            .iter()
            .find(|header| header["name"] == "Idempotency-Key")
    );
    let snapshot = runtime.replica.snapshot(&account_id).unwrap();
    let stored = runtime
        .platform_storage
        .load_current_session(&account_id, &snapshot.incarnation)
        .await
        .unwrap()
        .expect("refreshed Session must remain stored under the same Account incarnation");
    assert_eq!(stored.account_id, account_id);
    assert_eq!(stored.incarnation, snapshot.incarnation);
    assert_eq!(stored.session_id.as_deref(), Some("session-1"));
    assert_eq!(stored.token.as_ref(), "refreshed-token");
}

#[tokio::test]
async fn server_account_deletion_ambiguity_does_not_refresh_or_claim_no_deletion() {
    let http = Arc::new(RoutingAuthHttp::new(
        current_kdf_profile(),
        RoutingAuthBehavior::Success,
        None,
    ));
    let (runtime, _replica, _platform) = routing_harness(http.clone()).await;
    let RuntimeResponse::SignedIn { account_id, .. } = runtime
        .request(
            sign_in_request(NORMALIZED_EMAIL),
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("expected SignedIn");
    };
    http.clear_requests();
    http.disconnect();
    let error = runtime
        .request(
            RuntimeRequest::DeleteServerAccount {
                account_id,
                confirm_email: NORMALIZED_EMAIL.into(),
                request_id: "018f05c4-7b6a-4a89-9237-2e612fa96d13".into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::AuthenticationUnavailable);
    assert_eq!(error.message, "Account deletion is not confirmed");
    assert!(
        http.requests().is_empty(),
        "no refresh may follow transport loss"
    );
}

fn account_deletion_problem(request_id: &str, status: u16, code: &str) -> Value {
    json!({
        "type": format!("https://bittery.com/problems/{}", code.to_ascii_lowercase().replace('_', "-")),
        "title": "Account deletion closed",
        "status": status,
        "code": code,
        "detail": "closed",
        "instance": format!("urn:bittery:account-deletion:{request_id}"),
        "requestId": request_id,
        "retryable": false
    })
}

#[tokio::test]
async fn server_account_deletion_maps_closed_refusals_and_rejects_mismatched_echoes() {
    let http = Arc::new(RoutingAuthHttp::new(
        current_kdf_profile(),
        RoutingAuthBehavior::Success,
        None,
    ));
    let (runtime, _replica, _platform) = routing_harness(http.clone()).await;
    let RuntimeResponse::SignedIn { account_id, .. } = runtime
        .request(
            sign_in_request(NORMALIZED_EMAIL),
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("expected SignedIn");
    };
    let mismatch_id = "018f05c4-7b6a-4a89-9237-2e612fa96d14";
    *http.account_deletion_responses.lock().unwrap() = VecDeque::from([(
        400,
        account_deletion_problem(mismatch_id, 400, "ACCOUNT_DELETION_CONFIRMATION_MISMATCH"),
    )]);
    let mismatch = runtime
        .request(
            RuntimeRequest::DeleteServerAccount {
                account_id: account_id.clone(),
                confirm_email: NORMALIZED_EMAIL.into(),
                request_id: mismatch_id.into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        mismatch,
        RuntimeResponse::ServerAccountDeletion {
            account_id: account_id.clone(),
            request_id: mismatch_id.into(),
            outcome: crate::protocol::ServerAccountDeletionOutcome::ConfirmationEmailMismatch,
        }
    );

    let blocked_id = "018f05c4-7b6a-4a89-9237-2e612fa96d18";
    *http.account_deletion_responses.lock().unwrap() = VecDeque::from([(
        409,
        account_deletion_problem(blocked_id, 409, "ACCOUNT_DELETION_BLOCKED"),
    )]);
    let blocked = runtime
        .request(
            RuntimeRequest::DeleteServerAccount {
                account_id: account_id.clone(),
                confirm_email: NORMALIZED_EMAIL.into(),
                request_id: blocked_id.into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        blocked,
        RuntimeResponse::ServerAccountDeletion {
            account_id: account_id.clone(),
            request_id: blocked_id.into(),
            outcome: crate::protocol::ServerAccountDeletionOutcome::Blocked,
        }
    );

    *http.account_deletion_responses.lock().unwrap() = VecDeque::from([(
        200,
        json!({
            "requestId": "018f05c4-7b6a-4a89-9237-2e612fa96d99",
            "outcome": "deleted"
        }),
    )]);
    let error = runtime
        .request(
            RuntimeRequest::DeleteServerAccount {
                account_id,
                confirm_email: NORMALIZED_EMAIL.into(),
                request_id: "018f05c4-7b6a-4a89-9237-2e612fa96d15".into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
}

#[tokio::test]
async fn server_account_deletion_pre_dispatch_cancellation_contacts_no_authority() {
    let http = Arc::new(RoutingAuthHttp::new(
        current_kdf_profile(),
        RoutingAuthBehavior::Success,
        None,
    ));
    let (runtime, _replica, _platform) = routing_harness(http.clone()).await;
    let RuntimeResponse::SignedIn { account_id, .. } = runtime
        .request(
            sign_in_request(NORMALIZED_EMAIL),
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("expected SignedIn");
    };
    http.clear_requests();
    let cancellation = RequestCancellation::new();
    cancellation.cancel();
    let error = runtime
        .request(
            RuntimeRequest::DeleteServerAccount {
                account_id,
                confirm_email: NORMALIZED_EMAIL.into(),
                request_id: "018f05c4-7b6a-4a89-9237-2e612fa96d16".into(),
            },
            cancellation,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::Cancelled);
    assert!(http.requests().is_empty());
}

#[tokio::test]
async fn server_account_deletion_holds_the_account_fence_against_sign_out() {
    let http = Arc::new(RoutingAuthHttp::new(
        current_kdf_profile(),
        RoutingAuthBehavior::Success,
        None,
    ));
    let (runtime, _replica, _platform) = routing_harness(http.clone()).await;
    let RuntimeResponse::SignedIn { account_id, .. } = runtime
        .request(
            sign_in_request(NORMALIZED_EMAIL),
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("expected SignedIn");
    };
    let pause = HttpPause::new(HttpPauseStep::AccountDeletion);
    http.pause_at(pause.clone());
    let deleting_runtime = runtime.clone();
    let deleting_account = account_id.clone();
    let deletion = tokio::spawn(async move {
        deleting_runtime
            .request(
                RuntimeRequest::DeleteServerAccount {
                    account_id: deleting_account,
                    confirm_email: NORMALIZED_EMAIL.into(),
                    request_id: "018f05c4-7b6a-4a89-9237-2e612fa96d17".into(),
                },
                RequestCancellation::new(),
            )
            .await
    });
    pause.wait_until_reached().await;
    let signing_out_runtime = runtime.clone();
    let sign_out = tokio::spawn(async move {
        signing_out_runtime
            .request(
                RuntimeRequest::SignOut { account_id },
                RequestCancellation::new(),
            )
            .await
    });
    tokio::task::yield_now().await;
    assert!(
        !sign_out.is_finished(),
        "Sign-out must wait for deletion classification"
    );
    pause.release();
    deletion.await.unwrap().unwrap();
    sign_out.await.unwrap().unwrap();
}

#[tokio::test]
async fn server_account_deletion_holds_session_and_admission_against_remove_account() {
    let http = Arc::new(RoutingAuthHttp::new(
        current_kdf_profile(),
        RoutingAuthBehavior::Success,
        None,
    ));
    let (runtime, _replica, _platform) = routing_harness(http.clone()).await;
    let RuntimeResponse::SignedIn { account_id, .. } = runtime
        .request(
            sign_in_request(NORMALIZED_EMAIL),
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("expected SignedIn");
    };
    let snapshot = runtime.replica.snapshot(&account_id).unwrap();
    let pause = HttpPause::new(HttpPauseStep::AccountDeletion);
    http.pause_at(pause.clone());
    let deleting_runtime = runtime.clone();
    let deleting_account = account_id.clone();
    let deletion = tokio::spawn(async move {
        deleting_runtime
            .request(
                RuntimeRequest::DeleteServerAccount {
                    account_id: deleting_account,
                    confirm_email: NORMALIZED_EMAIL.into(),
                    request_id: "018f05c4-7b6a-4a89-9237-2e612fa96d19".into(),
                },
                RequestCancellation::new(),
            )
            .await
    });
    pause.wait_until_reached().await;
    let removing_runtime = runtime.clone();
    let removing_account = account_id.clone();
    let removal = tokio::spawn(async move {
        removing_runtime
            .request(
                RuntimeRequest::RemoveAccount {
                    account_id: removing_account,
                },
                RequestCancellation::new(),
            )
            .await
    });
    tokio::task::yield_now().await;
    assert!(
        !removal.is_finished(),
        "RemoveAccount must wait for deletion admission"
    );
    assert!(runtime
        .platform_storage
        .load_current_session(&account_id, &snapshot.incarnation)
        .await
        .unwrap()
        .is_some());
    removal.abort();
    assert!(removal.await.unwrap_err().is_cancelled());
    pause.release();
    deletion.await.unwrap().unwrap();
}

#[tokio::test]
async fn server_account_deletion_finishes_classification_before_close_retires_authority() {
    let http = Arc::new(RoutingAuthHttp::new(
        current_kdf_profile(),
        RoutingAuthBehavior::Success,
        None,
    ));
    let (runtime, _replica, _platform) = routing_harness(http.clone()).await;
    let RuntimeResponse::SignedIn { account_id, .. } = runtime
        .request(
            sign_in_request(NORMALIZED_EMAIL),
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("expected SignedIn");
    };
    let snapshot = runtime.replica.snapshot(&account_id).unwrap();
    let pause = HttpPause::new(HttpPauseStep::AccountDeletion);
    http.pause_at(pause.clone());
    let deleting_runtime = runtime.clone();
    let deleting_account = account_id.clone();
    let deletion = tokio::spawn(async move {
        deleting_runtime
            .request(
                RuntimeRequest::DeleteServerAccount {
                    account_id: deleting_account,
                    confirm_email: NORMALIZED_EMAIL.into(),
                    request_id: "018f05c4-7b6a-4a89-9237-2e612fa96d20".into(),
                },
                RequestCancellation::new(),
            )
            .await
    });
    pause.wait_until_reached().await;
    let closing_runtime = runtime.clone();
    let closing = tokio::spawn(async move { closing_runtime.close().await });
    tokio::task::yield_now().await;
    assert!(
        !closing.is_finished(),
        "close must wait for deletion classification"
    );
    assert!(runtime
        .platform_storage
        .load_current_session(&account_id, &snapshot.incarnation)
        .await
        .unwrap()
        .is_some());
    pause.release();
    deletion.await.unwrap().unwrap();
    closing.await.unwrap();
    assert!(
        runtime
            .platform_storage
            .load_current_session(&account_id, &snapshot.incarnation)
            .await
            .unwrap()
            .is_some(),
        "close preserves durable exact-retry Session authority"
    );
}

#[tokio::test]
async fn pending_account_teardown_fences_only_the_sign_in_that_resolves_to_that_account() {
    let http = Arc::new(RoutingAuthHttp::new(
        current_kdf_profile(),
        RoutingAuthBehavior::Success,
        None,
    ));
    let (runtime, _replica, platform) = routing_harness(http.clone()).await;
    let RuntimeResponse::SignedIn {
        account_id: removed,
        ..
    } = runtime
        .request(
            sign_in_request_to("https://vault.example.com", NORMALIZED_EMAIL),
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("Sign-in returned another response");
    };
    let RuntimeResponse::SignedIn {
        account_id: unrelated,
        ..
    } = runtime
        .request(
            sign_in_request_to("https://other.example.com", NORMALIZED_EMAIL),
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("Sign-in returned another response");
    };
    assert_ne!(removed, unrelated);

    // A failed catalog detach keeps the removed Account in the catalog, so its Sign-in identity
    // still resolves to the tombstoned Account instead of a fresh one.
    platform.fail_at(PersistenceStep::PromotedCatalog);
    let teardown = runtime
        .request(
            RuntimeRequest::RemoveAccount {
                account_id: removed.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let RuntimeResponse::Teardown { status, .. } = teardown else {
        panic!("removal returned another response");
    };
    assert_eq!(status, TeardownStatus::Incomplete);
    assert!(platform
        .catalog()
        .unwrap()
        .accounts
        .iter()
        .any(|account| account.account_id == removed));

    platform.clear_events();
    let permitted = runtime
        .request(
            sign_in_request_to("https://other.example.com", NORMALIZED_EMAIL),
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        permitted,
        RuntimeResponse::SignedIn {
            account_id: unrelated,
            user_id: "user-1".into(),
        }
    );

    platform.clear_events();
    let rejected = runtime
        .request(
            sign_in_request_to("https://vault.example.com", NORMALIZED_EMAIL),
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(rejected.code, RuntimeErrorCode::AccountMissing);
    assert_eq!(rejected.message, "Account teardown is pending");
    assert!(
        platform.events().is_empty(),
        "a fenced Sign-in must not mutate catalog, generation, or Replica state"
    );
}

#[tokio::test]
async fn quick_unlock_reauthenticates_and_updates_only_the_existing_generation_session() {
    let http = Arc::new(RoutingAuthHttp::new(
        current_kdf_profile(),
        RoutingAuthBehavior::Success,
        None,
    ));
    let (runtime, _replica, platform) = routing_harness(http.clone()).await;
    install_quick_unlock_account(&runtime, &platform).await;
    {
        let key = (
                "deviceSecret".into(),
                "bittery:runtime:platform-storage:account:9:account-1:incarnation:12:generation-1:quick-unlock".into(),
            );
        let mut values = platform.values.lock().unwrap();
        let mut document: Value = serde_json::from_str(values.get(&key).unwrap()).unwrap();
        document["lastMasterPasswordEntryMs"] = json!(0);
        values.insert(key, document.to_string());
    }
    http.clear_requests();
    let before = runtime
        .replica
        .snapshot(&AccountId::from("account-1"))
        .unwrap();
    let catalog_before = platform.catalog().unwrap();
    let sink = Arc::new(Sink::default());
    let _observation = runtime
        .observe(
            ObservationRequest::RuntimeStatus {
                account_id: Some(AccountId::from("account-1")),
            },
            sink.clone(),
        )
        .unwrap();

    let response = runtime
        .request(
            quick_unlock_request("account-1"),
            RequestCancellation::new(),
        )
        .await
        .unwrap();

    assert_eq!(
        response,
        RuntimeResponse::SignedIn {
            account_id: AccountId::from("account-1"),
            user_id: "user-1".into(),
        }
    );
    assert!(http.requests().len() >= 3);
    assert_eq!(
        platform.events(),
        vec![
            PersistenceStep::Metadata,
            PersistenceStep::QuickUnlock,
            PersistenceStep::CurrentSession,
        ]
    );
    assert_eq!(platform.catalog().unwrap(), catalog_before);
    let after = runtime
        .replica
        .snapshot(&AccountId::from("account-1"))
        .unwrap();
    assert_eq!(after, before);
    assert!(runtime.has_live_master_unlock_key(
        &AccountId::from("account-1"),
        &Incarnation::from("generation-1")
    ));
    assert_eq!(
        runtime.account_access_state(&AccountId::from("account-1")),
        Some(AccountAccessState::Unlocked)
    );
    let quick_unlock = runtime
        .platform_storage
        .load_quick_unlock(
            &AccountId::from("account-1"),
            &Incarnation::from("generation-1"),
        )
        .await
        .unwrap()
        .unwrap();
    assert!(quick_unlock.last_master_password_entry_ms.unwrap() > NOW_MS);
    assert!(sink.0.lock().unwrap().len() >= 2);
}

#[tokio::test]
async fn quick_unlock_ordinary_failures_leave_generation_and_quick_material_untouched() {
    for behavior in [
        RoutingAuthBehavior::BadProof,
        RoutingAuthBehavior::FollowUpError,
    ] {
        let http = Arc::new(RoutingAuthHttp::new(current_kdf_profile(), behavior, None));
        let (runtime, _replica, platform) = routing_harness(http).await;
        install_quick_unlock_account(&runtime, &platform).await;
        let before = runtime
            .platform_storage
            .load_quick_unlock(
                &AccountId::from("account-1"),
                &Incarnation::from("generation-1"),
            )
            .await
            .unwrap()
            .unwrap();
        platform.clear_events();

        assert!(runtime
            .request(
                quick_unlock_request("account-1"),
                RequestCancellation::new(),
            )
            .await
            .is_err());
        assert!(platform.events().is_empty());
        let after = runtime
            .platform_storage
            .load_quick_unlock(
                &AccountId::from("account-1"),
                &Incarnation::from("generation-1"),
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            after.last_master_password_entry_ms,
            before.last_master_password_entry_ms
        );
        assert_eq!(
            runtime.account_access_state(&AccountId::from("account-1")),
            Some(AccountAccessState::Locked)
        );
    }
}

#[tokio::test]
async fn missing_quick_unlock_material_and_pending_lock_epoch_fail_before_http() {
    let http = Arc::new(RoutingAuthHttp::new(
        current_kdf_profile(),
        RoutingAuthBehavior::Success,
        None,
    ));
    let (runtime, _replica, platform) = routing_harness(http.clone()).await;
    install_quick_unlock_account(&runtime, &platform).await;
    http.clear_requests();
    runtime
        .platform_storage
        .remove_quick_unlock(
            &AccountId::from("account-1"),
            &Incarnation::from("generation-1"),
        )
        .await
        .unwrap();
    let error = runtime
        .request(
            quick_unlock_request("account-1"),
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::AuthenticationRequired);
    assert!(http.requests().is_empty());

    let http = Arc::new(RoutingAuthHttp::new(
        current_kdf_profile(),
        RoutingAuthBehavior::Success,
        None,
    ));
    let (runtime, _replica, platform) = routing_harness(http.clone()).await;
    install_quick_unlock_account(&runtime, &platform).await;
    http.clear_requests();
    runtime
        .lock_epoch_pending
        .lock()
        .unwrap()
        .insert(AccountId::from("account-1"), 2);
    let error = runtime
        .request(
            quick_unlock_request("account-1"),
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
    assert!(http.requests().is_empty());
}

#[tokio::test]
async fn corrupt_quick_material_requires_full_sign_in_but_executor_errors_are_preserved() {
    let http = Arc::new(RoutingAuthHttp::new(
        current_kdf_profile(),
        RoutingAuthBehavior::Success,
        None,
    ));
    let (runtime, _replica, platform) = routing_harness(http.clone()).await;
    install_quick_unlock_account(&runtime, &platform).await;
    http.clear_requests();
    platform.values.lock().unwrap().insert(
            (
                "deviceSecret".into(),
                "bittery:runtime:platform-storage:account:9:account-1:incarnation:12:generation-1:quick-unlock".into(),
            ),
            "{broken".into(),
        );
    let error = runtime
        .request(
            quick_unlock_request("account-1"),
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::AuthenticationRequired);
    assert!(http.requests().is_empty());

    let http = Arc::new(RoutingAuthHttp::new(
        current_kdf_profile(),
        RoutingAuthBehavior::Success,
        None,
    ));
    let (runtime, _replica, platform) = routing_harness(http.clone()).await;
    install_quick_unlock_account(&runtime, &platform).await;
    http.clear_requests();
    platform.fail_next_read(RuntimeError::new(
        RuntimeErrorCode::AuthenticationUnavailable,
        "host storage is offline",
    ));
    let error = runtime
        .request(
            quick_unlock_request("account-1"),
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::AuthenticationUnavailable);
    assert_eq!(error.message, "host storage is offline");
    assert!(http.requests().is_empty());
}

#[tokio::test]
async fn mismatched_local_muk_or_server_user_never_starts_quick_unlock_writes() {
    let http = Arc::new(RoutingAuthHttp::new(
        current_kdf_profile(),
        RoutingAuthBehavior::Success,
        None,
    ));
    let (runtime, _replica, platform) = routing_harness(http).await;
    install_quick_unlock_account(&runtime, &platform).await;
    let key = (
            "deviceSecret".into(),
            "bittery:runtime:platform-storage:account:9:account-1:incarnation:12:generation-1:quick-unlock".into(),
        );
    {
        let mut values = platform.values.lock().unwrap();
        let mut document: Value = serde_json::from_str(values.get(&key).unwrap()).unwrap();
        document["encryptedMasterUnlockKey"] = serde_json::to_value(
            crate::authentication_installation::wrap_master_unlock_key(&[0x11; 32], &[0x5A; 32])
                .unwrap(),
        )
        .unwrap();
        values.insert(key, document.to_string());
    }
    platform.clear_events();
    let error = runtime
        .request(
            quick_unlock_request("account-1"),
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::AuthenticationRequired);
    assert!(platform.events().is_empty());

    let http = Arc::new(RoutingAuthHttp::new(
        current_kdf_profile(),
        RoutingAuthBehavior::UserMismatch,
        None,
    ));
    let (runtime, _replica, platform) = routing_harness(http).await;
    install_quick_unlock_account(&runtime, &platform).await;
    let error = runtime
        .request(
            quick_unlock_request("account-1"),
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::AuthenticationUnavailable);
    assert!(platform.events().is_empty());
}

#[tokio::test]
async fn cancelled_waiter_and_close_cannot_publish_a_stale_quick_unlock() {
    let http = Arc::new(RoutingAuthHttp::new(
        current_kdf_profile(),
        RoutingAuthBehavior::Success,
        None,
    ));
    let (runtime, _replica, platform) = routing_harness(http.clone()).await;
    install_quick_unlock_account(&runtime, &platform).await;
    http.clear_requests();
    platform.clear_events();
    let lock = runtime
        .account_execution_lock(&AccountId::from("account-1"))
        .unwrap();
    let guard = lock.lock().await;
    let cancellation = RequestCancellation::new();
    let waiting = {
        let runtime = runtime.clone();
        let cancellation = cancellation.clone();
        tokio::spawn(async move {
            runtime
                .request(quick_unlock_request("account-1"), cancellation)
                .await
        })
    };
    tokio::task::yield_now().await;
    cancellation.cancel();
    drop(guard);
    assert_eq!(
        waiting.await.unwrap().unwrap_err().code,
        RuntimeErrorCode::Cancelled
    );
    assert_eq!(platform.invocation_count(), 0);
    assert!(http.requests().is_empty());

    let guard = lock.lock().await;
    let waiting = {
        let runtime = runtime.clone();
        tokio::spawn(async move {
            runtime
                .request(
                    quick_unlock_request("account-1"),
                    RequestCancellation::new(),
                )
                .await
        })
    };
    tokio::task::yield_now().await;
    let closing = {
        let runtime = runtime.clone();
        tokio::spawn(async move { runtime.close().await })
    };
    while !runtime.is_closed() {
        tokio::task::yield_now().await;
    }
    drop(guard);
    assert_eq!(
        waiting.await.unwrap().unwrap_err().code,
        RuntimeErrorCode::RuntimeClosed
    );
    closing.await.unwrap();
    assert!(!runtime.has_live_master_unlock_key(
        &AccountId::from("account-1"),
        &Incarnation::from("generation-1")
    ));
}

#[tokio::test]
async fn accepted_quick_unlock_write_failures_fence_without_replacing_the_replica() {
    for failure in [
        PersistenceStep::Metadata,
        PersistenceStep::QuickUnlock,
        PersistenceStep::CurrentSession,
    ] {
        let http = Arc::new(RoutingAuthHttp::new(
            current_kdf_profile(),
            RoutingAuthBehavior::Success,
            None,
        ));
        let (runtime, _replica, platform) = routing_harness(http).await;
        install_quick_unlock_account(&runtime, &platform).await;
        let before = runtime
            .replica
            .snapshot(&AccountId::from("account-1"))
            .unwrap();
        platform.fail_at(failure);

        assert!(runtime
            .request(
                quick_unlock_request("account-1"),
                RequestCancellation::new(),
            )
            .await
            .is_err());
        assert_eq!(
            runtime.account_access_state(&AccountId::from("account-1")),
            Some(AccountAccessState::SignedOut)
        );
        assert!(!runtime.has_live_master_unlock_key(
            &AccountId::from("account-1"),
            &Incarnation::from("generation-1")
        ));
        assert_eq!(
            runtime
                .replica
                .snapshot(&AccountId::from("account-1"))
                .unwrap(),
            before
        );
        assert!(runtime
            .platform_storage
            .load_quick_unlock(
                &AccountId::from("account-1"),
                &Incarnation::from("generation-1"),
            )
            .await
            .unwrap()
            .is_some());

        runtime
            .request(
                quick_unlock_request("account-1"),
                RequestCancellation::new(),
            )
            .await
            .unwrap();
        assert_eq!(
            runtime.account_access_state(&AccountId::from("account-1")),
            Some(AccountAccessState::Unlocked)
        );
    }
}

#[tokio::test]
async fn quick_unlock_cancellation_has_one_final_pre_write_acceptance_boundary() {
    let cancellation = RequestCancellation::new();
    let http = Arc::new(RoutingAuthHttp::new(
        current_kdf_profile(),
        RoutingAuthBehavior::Success,
        None,
    ));
    let (runtime, _replica, platform) = routing_harness(http).await;
    install_quick_unlock_account(&runtime, &platform).await;
    let error = runtime
        .request_with_hooks(
            quick_unlock_request("account-1"),
            cancellation.clone(),
            || cancellation.cancel(),
            || panic!("pre-acceptance cancellation must not be accepted"),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::Cancelled);
    assert!(platform.events().is_empty());

    let cancellation = RequestCancellation::new();
    let response = runtime
        .request_with_acceptance_hook(
            quick_unlock_request("account-1"),
            cancellation.clone(),
            || cancellation.cancel(),
        )
        .await
        .unwrap();
    assert!(matches!(response, RuntimeResponse::SignedIn { .. }));
    assert_eq!(
        platform.events(),
        vec![
            PersistenceStep::Metadata,
            PersistenceStep::QuickUnlock,
            PersistenceStep::CurrentSession,
        ]
    );
}

#[tokio::test]
async fn confirmed_remote_http_is_used_and_persisted_as_account_local_evidence() {
    let http = Arc::new(RoutingAuthHttp::new(
        current_kdf_profile(),
        RoutingAuthBehavior::Success,
        None,
    ));
    let (runtime, _replica, _platform) = routing_harness(http.clone()).await;
    let mut request = sign_in_request(NORMALIZED_EMAIL);
    let RuntimeRequest::SignIn {
        server_url,
        insecure_transport_confirmed,
        ..
    } = &mut request
    else {
        unreachable!()
    };
    *server_url = "http://vault.example.com".into();
    *insecure_transport_confirmed = true;

    let RuntimeResponse::SignedIn { account_id, .. } = runtime
        .request(request, RequestCancellation::new())
        .await
        .unwrap()
    else {
        panic!("Sign-in returned another response");
    };
    assert!(http.requests().iter().all(|request| request["url"]
        .as_str()
        .unwrap()
        .starts_with("http://vault.example.com/")));
    let incarnation = runtime.replica.snapshot(&account_id).unwrap().incarnation;
    let metadata = runtime
        .platform_storage
        .load_account_metadata(&account_id, &incarnation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(metadata.normalized_server_url, "http://vault.example.com");
    assert!(metadata.insecure_transport_confirmed);
}

#[tokio::test]
async fn unavailable_invalid_and_pre_cancelled_sign_in_contact_no_host() {
    let (runtime, _replica, platform) = harness().await;
    let error = runtime
        .request(
            sign_in_request(NORMALIZED_EMAIL),
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::AuthenticationUnavailable);
    assert_eq!(platform.invocation_count(), 0);

    assert_eq!(
        AuthClientConfig::new("bad\rclient".into(), ClientPlatform::Web, "0.5.2".into(),)
            .unwrap_err()
            .code,
        RuntimeErrorCode::AuthenticationUnavailable
    );

    for (request, cancellation) in [
        {
            let mut request = sign_in_request(NORMALIZED_EMAIL);
            let RuntimeRequest::SignIn { secret_key, .. } = &mut request else {
                unreachable!()
            };
            *secret_key = "invalid-secret-key".into();
            (request, RequestCancellation::new())
        },
        {
            let cancellation = RequestCancellation::new();
            cancellation.cancel();
            (sign_in_request(NORMALIZED_EMAIL), cancellation)
        },
        {
            let mut request = sign_in_request(NORMALIZED_EMAIL);
            let RuntimeRequest::SignIn {
                server_url,
                insecure_transport_confirmed,
                ..
            } = &mut request
            else {
                unreachable!()
            };
            *server_url = "http://vault.example.com".into();
            *insecure_transport_confirmed = false;
            (request, RequestCancellation::new())
        },
    ] {
        let http = Arc::new(RoutingAuthHttp::new(
            current_kdf_profile(),
            RoutingAuthBehavior::Success,
            None,
        ));
        let (runtime, _replica, platform) = routing_harness(http.clone()).await;
        assert!(runtime.request(request, cancellation).await.is_err());
        assert!(http.requests().is_empty());
        assert_eq!(platform.invocation_count(), 0);
        assert!(runtime.replica.snapshots().is_empty());
    }
}

#[tokio::test]
async fn cancellation_and_remote_authentication_failures_never_start_installation() {
    for behavior in [
        RoutingAuthBehavior::CancelAfterStart,
        RoutingAuthBehavior::BadProof,
        RoutingAuthBehavior::FollowUpError,
    ] {
        let cancellation = RequestCancellation::new();
        let http = Arc::new(RoutingAuthHttp::new(
            current_kdf_profile(),
            behavior,
            Some(cancellation.clone()),
        ));
        let (runtime, _replica, platform) = routing_harness(http.clone()).await;
        assert!(runtime
            .request(sign_in_request(NORMALIZED_EMAIL), cancellation)
            .await
            .is_err());
        assert!(!http.requests().is_empty());
        assert!(platform.events().is_empty());
        assert!(platform.catalog().is_none());
        assert!(runtime.replica.snapshots().is_empty());
        assert!(runtime_status(&runtime).accounts.is_empty());
    }
}

#[tokio::test]
async fn final_cancellation_check_precedes_acceptance_and_later_cancellation_is_fenced() {
    let cancellation = RequestCancellation::new();
    let http = Arc::new(RoutingAuthHttp::new(
        current_kdf_profile(),
        RoutingAuthBehavior::Success,
        None,
    ));
    let (runtime, _replica, platform) = routing_harness(http).await;
    let error = runtime
        .request_with_hooks(
            sign_in_request(NORMALIZED_EMAIL),
            cancellation.clone(),
            || cancellation.cancel(),
            || panic!("cancelled authentication must not be accepted"),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::Cancelled);
    assert!(platform.events().is_empty());
    assert!(runtime.replica.snapshots().is_empty());

    for cancel_from_first_write in [false, true] {
        let cancellation = RequestCancellation::new();
        let http = Arc::new(RoutingAuthHttp::new(
            current_kdf_profile(),
            RoutingAuthBehavior::Success,
            None,
        ));
        let (runtime, _replica, platform) = routing_harness(http).await;
        if cancel_from_first_write {
            platform.cancel_on_next_write(cancellation.clone());
        }
        let response = if cancel_from_first_write {
            runtime
                .request(sign_in_request(NORMALIZED_EMAIL), cancellation)
                .await
        } else {
            runtime
                .request_with_acceptance_hook(
                    sign_in_request(NORMALIZED_EMAIL),
                    cancellation.clone(),
                    || cancellation.cancel(),
                )
                .await
        }
        .unwrap();
        let RuntimeResponse::SignedIn { account_id, .. } = response else {
            panic!("accepted Sign-in returned another response");
        };
        let snapshot = runtime.replica.snapshot(&account_id).unwrap();
        assert!(runtime.has_live_master_unlock_key(&account_id, &snapshot.incarnation));
        assert_eq!(
            runtime.account_access_state(&account_id),
            Some(AccountAccessState::Unlocked)
        );
        assert!(platform.catalog().unwrap().accounts[0]
            .pending_install
            .is_none());
    }
}

#[tokio::test]
async fn route_uses_only_matching_kdf_pin_and_existing_installation_fence() {
    let stronger = bittery_crypto_core::KdfProfile {
        iterations: current_kdf_profile().iterations + 1,
        ..current_kdf_profile()
    };
    let http = Arc::new(RoutingAuthHttp::new(
        current_kdf_profile(),
        RoutingAuthBehavior::Success,
        None,
    ));
    let (runtime, _replica, platform) = routing_harness(http.clone()).await;
    let mut existing = verified("user-1");
    existing.kdf_profile = stronger.clone();
    runtime
        .install_verified_authentication_with(
            existing,
            evidence(),
            &FixedClock(NOW_MS),
            &FixedEntropy::new(&["account-1", "generation-1"]),
        )
        .await
        .unwrap();
    platform.clear_events();
    http.clear_requests();
    let error = runtime
        .request(
            sign_in_request(NORMALIZED_EMAIL),
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::AuthenticationUnavailable);
    assert_eq!(http.requests().len(), 1);
    assert!(platform.events().is_empty());

    let http = Arc::new(RoutingAuthHttp::new(
        current_kdf_profile(),
        RoutingAuthBehavior::Success,
        None,
    ));
    let (runtime, _replica, platform) = routing_harness(http).await;
    let mut unrelated = verified("user-2");
    unrelated.kdf_profile = stronger;
    runtime
        .install_verified_authentication_with(
            unrelated,
            evidence(),
            &FixedClock(NOW_MS),
            &FixedEntropy::new(&["account-2", "generation-2"]),
        )
        .await
        .unwrap();
    platform.clear_events();
    platform.fail_at(PersistenceStep::CurrentSession);
    let error = runtime
        .request(
            sign_in_request(NORMALIZED_EMAIL),
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
    let status = runtime_status(&runtime);
    assert_eq!(status.accounts.len(), 2);
    assert!(status.accounts.iter().any(|account| {
        account.account_id != AccountId::from("account-2")
            && account.access == AccountAccessState::SignedOut
    }));
}

#[tokio::test]
async fn first_install_obeys_the_exact_durable_order_before_publication() {
    let (runtime, _replica, platform) = harness().await;
    let response = install(
        &runtime,
        "user-1",
        &FixedEntropy::new(&["account-1", "generation-1"]),
    )
    .await
    .unwrap();

    assert_eq!(
        platform.events(),
        vec![
            PersistenceStep::DeviceKey,
            PersistenceStep::PendingCatalog,
            PersistenceStep::Metadata,
            PersistenceStep::QuickUnlock,
            PersistenceStep::Replica,
            PersistenceStep::PromotedCatalog,
            PersistenceStep::CurrentSession,
        ]
    );
    assert_eq!(
        response,
        RuntimeResponse::SignedIn {
            account_id: AccountId::from("account-1"),
            user_id: "user-1".into(),
        }
    );
    assert_eq!(
        runtime.account_access_state(&AccountId::from("account-1")),
        Some(AccountAccessState::Unlocked)
    );
    assert!(runtime.has_live_master_unlock_key(
        &AccountId::from("account-1"),
        &Incarnation::from("generation-1")
    ));
    let session = runtime
        .platform_storage
        .load_current_session(
            &AccountId::from("account-1"),
            &Incarnation::from("generation-1"),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(session.vault_keys.len(), 1);
    assert_eq!(session.vault_keys[0].vault_id, "visible");
}

#[tokio::test]
async fn replacement_keeps_the_account_id_and_duplicate_identity_rejects_before_writes() {
    let (runtime, replica, platform) = harness().await;
    install(
        &runtime,
        "user-1",
        &FixedEntropy::new(&["account-1", "generation-1"]),
    )
    .await
    .unwrap();
    platform.clear_events();
    let response = install(&runtime, "user-1", &FixedEntropy::new(&["generation-2"]))
        .await
        .unwrap();
    assert_eq!(
        response,
        RuntimeResponse::SignedIn {
            account_id: AccountId::from("account-1"),
            user_id: "user-1".into(),
        }
    );
    assert!(!runtime.has_live_master_unlock_key(
        &AccountId::from("account-1"),
        &Incarnation::from("generation-1")
    ));
    assert!(runtime.has_live_master_unlock_key(
        &AccountId::from("account-1"),
        &Incarnation::from("generation-2")
    ));

    replica
        .state
        .install(
            AccountId::from("duplicate"),
            "user-1".into(),
            Incarnation::from("duplicate-generation"),
        )
        .unwrap();
    let mut duplicate_metadata = runtime
        .platform_storage
        .load_account_metadata(
            &AccountId::from("account-1"),
            &Incarnation::from("generation-2"),
        )
        .await
        .unwrap()
        .unwrap();
    duplicate_metadata.account_id = AccountId::from("duplicate");
    duplicate_metadata.incarnation = Incarnation::from("duplicate-generation");
    platform.put_document(
        "devicePlain",
        generation_storage_key("duplicate", "duplicate-generation", "metadata"),
        &duplicate_metadata,
    );
    let mut catalog = platform.catalog().unwrap();
    catalog.accounts.push(DeviceCatalogAccount {
        account_id: AccountId::from("duplicate"),
        active_incarnation: Some(Incarnation::from("duplicate-generation")),
        pending_install: None,
    });
    platform.put_document(
        "devicePlain",
        "bittery:runtime:platform-storage:device-catalog".into(),
        &DeviceCatalogDocument::new(catalog.accounts).unwrap(),
    );
    platform.clear_events();

    let error = install(&runtime, "user-1", &FixedEntropy::new(&["unused"]))
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
    assert!(platform.events().is_empty());
}

#[tokio::test]
async fn persistence_failures_rollback_before_replica_and_fence_after_replica() {
    for step in [
        PersistenceStep::DeviceKey,
        PersistenceStep::PendingCatalog,
        PersistenceStep::Metadata,
        PersistenceStep::QuickUnlock,
    ] {
        let (runtime, _replica, platform) = harness().await;
        platform.fail_at(step);
        assert!(install(
            &runtime,
            "user-1",
            &FixedEntropy::new(&["account-1", "generation-1"]),
        )
        .await
        .is_err());
        assert!(runtime.replica.snapshots().is_empty());
        assert!(runtime
            .account_access_state(&AccountId::from("account-1"))
            .is_none());
        assert!(!runtime.has_live_master_unlock_key(
            &AccountId::from("account-1"),
            &Incarnation::from("generation-1")
        ));
    }

    for fault in [
        ReplicaFault::BeforeApply,
        ReplicaFault::ApplyThenError,
        ReplicaFault::ApplyThenUnreadable,
        ReplicaFault::ThirdHead,
    ] {
        let (runtime, replica, _platform) = harness().await;
        replica.fail_with(fault);
        assert!(install(
            &runtime,
            "user-1",
            &FixedEntropy::new(&["account-1", "generation-1"]),
        )
        .await
        .is_err());
        assert!(!runtime.has_live_master_unlock_key(
            &AccountId::from("account-1"),
            &Incarnation::from("generation-1")
        ));
        if matches!(fault, ReplicaFault::BeforeApply) {
            assert!(runtime.replica.snapshots().is_empty());
        } else {
            assert_ne!(
                runtime.account_access_state(&AccountId::from("account-1")),
                Some(AccountAccessState::Unlocked)
            );
        }
    }

    for step in [
        PersistenceStep::PromotedCatalog,
        PersistenceStep::CurrentSession,
    ] {
        let (runtime, _replica, platform) = harness().await;
        platform.fail_at(step);
        assert!(install(
            &runtime,
            "user-1",
            &FixedEntropy::new(&["account-1", "generation-1"]),
        )
        .await
        .is_err());
        assert_eq!(
            runtime.account_access_state(&AccountId::from("account-1")),
            Some(AccountAccessState::SignedOut)
        );
        assert!(!runtime.has_live_master_unlock_key(
            &AccountId::from("account-1"),
            &Incarnation::from("generation-1")
        ));
    }
}

#[tokio::test]
async fn unreadable_replica_outcomes_remain_visible_signed_out_without_a_usable_account() {
    let (runtime, replica, platform) = harness().await;
    replica.fail_with(ReplicaFault::ApplyThenUnreadable);
    let error = install(
        &runtime,
        "user-1",
        &FixedEntropy::new(&["account-1", "generation-1"]),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
    assert_eq!(
        runtime_status(&runtime).accounts,
        vec![AccountStatus {
            account_id: AccountId::from("account-1"),
            replica_revision: 0,
            access: AccountAccessState::SignedOut,
            display_identity: None,
            waiting_reason: None,
            failure: None,
        }]
    );
    assert!(runtime
        .replica
        .snapshot(&AccountId::from("account-1"))
        .is_none());
    assert!(runtime
        .observe(
            ObservationRequest::Items {
                account_id: AccountId::from("account-1"),
            },
            Arc::new(Sink::default()),
        )
        .is_err());
    assert_eq!(
        runtime
            .request(create_request("account-1"), RequestCancellation::new())
            .await
            .unwrap_err()
            .code,
        RuntimeErrorCode::AccountMissing
    );
    assert!(platform.catalog().unwrap().accounts[0]
        .pending_install
        .is_some());

    let (runtime, replica, platform) = harness().await;
    install(
        &runtime,
        "user-1",
        &FixedEntropy::new(&["account-1", "generation-1"]),
    )
    .await
    .unwrap();
    let items = Arc::new(Sink::default());
    let _items_handle = runtime
        .observe(
            ObservationRequest::Items {
                account_id: AccountId::from("account-1"),
            },
            items.clone(),
        )
        .unwrap();
    let delivered_before = items.0.lock().unwrap().len();
    let _ = take_zeroized_live_master_unlock_key_drops();
    replica.fail_with(ReplicaFault::ApplyThenUnreadable);
    assert!(
        install(&runtime, "user-1", &FixedEntropy::new(&["generation-2"]),)
            .await
            .is_err()
    );

    let status = runtime_status(&runtime);
    assert_eq!(status.accounts.len(), 1);
    assert_eq!(status.accounts[0].account_id, AccountId::from("account-1"));
    assert_eq!(status.accounts[0].access, AccountAccessState::SignedOut);
    assert_eq!(status.accounts[0].display_identity, None);
    assert_eq!(items.0.lock().unwrap().len(), delivered_before);
    assert!(!runtime.has_live_master_unlock_key(
        &AccountId::from("account-1"),
        &Incarnation::from("generation-1")
    ));
    assert_eq!(take_zeroized_live_master_unlock_key_drops(), 1);
    assert_eq!(
        runtime
            .request(create_request("account-1"), RequestCancellation::new())
            .await
            .unwrap_err()
            .code,
        RuntimeErrorCode::AccountMissing
    );
    let catalog = platform.catalog().unwrap();
    assert_eq!(catalog.accounts.len(), 1);
    assert_eq!(catalog.accounts[0].account_id, AccountId::from("account-1"));
    assert_eq!(
        catalog.accounts[0].active_incarnation,
        Some(Incarnation::from("generation-1"))
    );
    assert_eq!(
        catalog.accounts[0]
            .pending_install
            .as_ref()
            .map(|pending| pending.incarnation.clone()),
        Some(Incarnation::from("generation-2"))
    );
}

#[tokio::test]
async fn concurrent_same_identity_installations_serialize_to_one_stable_account() {
    let (runtime, _replica, platform) = harness().await;
    let status_sink = Arc::new(Sink::default());
    let _status_handle = runtime
        .observe(
            ObservationRequest::RuntimeStatus { account_id: None },
            status_sink.clone(),
        )
        .unwrap();
    let pause = Pause::new(PersistenceStep::CurrentSession);
    platform.pause_at(pause.clone());
    let first = {
        let runtime = runtime.clone();
        tokio::spawn(async move {
            install(
                &runtime,
                "user-1",
                &FixedEntropy::new(&["account-1", "generation-1"]),
            )
            .await
        })
    };
    pause.wait_until_reached().await;
    assert!(runtime_status(&runtime).accounts.is_empty());
    let events_before_second = platform.events();
    let second_started = Arc::new(tokio::sync::Notify::new());
    let second = {
        let runtime = runtime.clone();
        let second_started = second_started.clone();
        tokio::spawn(async move {
            second_started.notify_one();
            install(&runtime, "user-1", &FixedEntropy::new(&["generation-2"])).await
        })
    };
    second_started.notified().await;
    tokio::task::yield_now().await;
    assert_eq!(platform.events(), events_before_second);
    assert!(runtime_status(&runtime).accounts.is_empty());
    let _ = take_zeroized_live_master_unlock_key_drops();
    pause.release();

    let first_response = first.await.unwrap().unwrap();
    let second_response = second.await.unwrap().unwrap();
    for response in [first_response, second_response] {
        assert_eq!(
            response,
            RuntimeResponse::SignedIn {
                account_id: AccountId::from("account-1"),
                user_id: "user-1".into(),
            }
        );
    }
    let catalog = platform.catalog().unwrap();
    assert_eq!(catalog.accounts.len(), 1);
    assert_eq!(
        catalog.accounts[0].active_incarnation,
        Some(Incarnation::from("generation-2"))
    );
    assert!(catalog.accounts[0].pending_install.is_none());
    assert_eq!(
        runtime
            .replica
            .snapshot(&AccountId::from("account-1"))
            .unwrap()
            .incarnation,
        Incarnation::from("generation-2")
    );
    assert!(!runtime.has_live_master_unlock_key(
        &AccountId::from("account-1"),
        &Incarnation::from("generation-1")
    ));
    assert!(runtime.has_live_master_unlock_key(
        &AccountId::from("account-1"),
        &Incarnation::from("generation-2")
    ));
    assert!(take_zeroized_live_master_unlock_key_drops() >= 1);
    for projection in status_sink.0.lock().unwrap().iter() {
        let RuntimeProjection::RuntimeStatus(status) = projection else {
            panic!("status sink received another projection");
        };
        assert!(status.accounts.len() <= 1);
        assert!(status
            .accounts
            .iter()
            .all(|status| status.account_id == AccountId::from("account-1")));
    }
}

#[tokio::test]
async fn lock_close_and_close_racing_final_publication_retire_live_keys_without_callbacks() {
    let (runtime, _replica, platform) = harness().await;
    install(
        &runtime,
        "user-1",
        &FixedEntropy::new(&["account-1", "generation-1"]),
    )
    .await
    .unwrap();
    let _ = take_zeroized_live_master_unlock_key_drops();
    runtime
        .mark_account_locked(&AccountId::from("account-1"))
        .await
        .unwrap();
    assert_eq!(take_zeroized_live_master_unlock_key_drops(), 1);
    assert!(!runtime.has_live_master_unlock_key(
        &AccountId::from("account-1"),
        &Incarnation::from("generation-1")
    ));
    install(&runtime, "user-1", &FixedEntropy::new(&["generation-2"]))
        .await
        .unwrap();
    let _ = take_zeroized_live_master_unlock_key_drops();

    let sink = Arc::new(Sink::default());
    let _handle = runtime
        .observe(
            ObservationRequest::RuntimeStatus { account_id: None },
            sink.clone(),
        )
        .unwrap();
    let before_close = sink.0.lock().unwrap().len();
    let pause = Pause::new(PersistenceStep::CurrentSession);
    platform.pause_at(pause.clone());
    let installing = {
        let runtime = runtime.clone();
        tokio::spawn(async move {
            install(&runtime, "user-1", &FixedEntropy::new(&["generation-3"])).await
        })
    };
    pause.wait_until_reached().await;
    let closing = {
        let runtime = runtime.clone();
        tokio::spawn(async move { runtime.close().await })
    };
    while !runtime.is_closed() {
        tokio::task::yield_now().await;
    }
    pause.release();

    let error = installing.await.unwrap().unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::RuntimeClosed);
    closing.await.unwrap();
    assert_eq!(sink.0.lock().unwrap().len(), before_close);
    assert!(runtime.live_master_unlock_keys.lock().unwrap().is_empty());
    assert!(take_zeroized_live_master_unlock_key_drops() >= 1);
}

fn sealed_login_item(item_id: &str, title: &str, password: &str) -> (String, Value) {
    let derived = derive_keys(
        MASTER_PASSWORD,
        SECRET_KEY,
        NORMALIZED_EMAIL,
        &current_kdf_profile(),
    )
    .unwrap();
    let vault_key = generate_encryption_key();
    let wrapped = encrypt_vault_key_with_muk(
        &vault_key,
        &derived.master_unlock_key,
        &VaultKeyWrapContext::new("vault-1", "user-1", 1),
    )
    .unwrap();
    let encrypted = encrypt_with_aad(
        &serde_json::json!({
            "title": title,
            "username": "ada",
            "password": password
        })
        .to_string(),
        &vault_key,
        &AadContext {
            vault_id: "vault-1".into(),
            entity_id: item_id.into(),
            entity_type: "item".into(),
            version: 1,
            user_id: "user-1".into(),
        },
    )
    .unwrap();
    (
        wrapped.clone(),
        serde_json::json!({
            "attachments": [],
            "category": "login",
            "createdAt": "2026-08-23T00:00:00Z",
            "deletedAt": null,
            "encryptedByUserId": "user-1",
            "encryptedData": encrypted.ciphertext,
            "encryptionAlgorithm": encrypted.algorithm,
            "encryptionIv": encrypted.iv,
            "encryptionVersion": 1,
            "favorite": false,
            "id": item_id,
            "lastModifiedBy": "user-1",
            "updatedAt": "2026-08-23T00:00:00Z",
            "vault": {
                "encryptedVaultKey": wrapped,
                "icon": null,
                "id": "vault-1",
                "imageUrl": null,
                "name": "Personal",
                "role": "owner",
                "vaultType": "personal"
            },
            "vaultId": "vault-1",
            "version": 1
        }),
    )
}

#[tokio::test]
async fn bootstrap_stages_a_standalone_empty_vault_before_the_item_phase() {
    let http = Arc::new(RoutingAuthHttp::new(
        current_kdf_profile(),
        RoutingAuthBehavior::Success,
        None,
    ));
    let (wrapped, _item) = sealed_login_item("unused-item", "Unused", "unused");
    *http.bootstrap_pages.lock().unwrap() = vec![
        json!({
            "phase": "vaults",
            "hasMore": false,
            "nextCursor": null,
            "syncCursor": { "id": "evt-empty-vault" },
            "vaults": [{
                "encryptedVaultKey": wrapped,
                "icon": null,
                "id": "vault-1",
                "imageUrl": null,
                "name": "Empty Personal",
                "role": "owner",
                "vaultType": "personal"
            }]
        }),
        json!({
            "phase": "items",
            "hasMore": false,
            "items": [],
            "nextCursor": null,
            "syncCursor": { "id": "evt-empty-vault" }
        }),
    ];
    let (runtime, _replica, _platform) = routing_harness(http.clone()).await;

    let RuntimeResponse::SignedIn { account_id, .. } = runtime
        .request(
            sign_in_request(NORMALIZED_EMAIL),
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("expected SignedIn");
    };

    let snapshot = runtime.replica.snapshot(&account_id).unwrap();
    let authority = snapshot.bootstrap.snapshot();
    assert_eq!(authority.visible_vaults.len(), 1);
    assert_eq!(authority.visible_vaults[0].id, "vault-1");
    assert!(authority.visible_items.is_empty());
    assert_eq!(
        snapshot.bootstrap.active_cursor,
        crate::replica::SyncCursor::CapturedValue {
            id: "evt-empty-vault".into()
        }
    );
    let bootstrap_urls: Vec<_> = http
        .requests()
        .into_iter()
        .filter_map(|request| request["url"].as_str().map(ToOwned::to_owned))
        .filter(|url| url.contains("/sync/bootstrap"))
        .collect();
    assert_eq!(bootstrap_urls.len(), 2);
    assert!(bootstrap_urls[0].contains("phase=vaults"));
    assert!(bootstrap_urls[1].contains("phase=items"));
}

#[tokio::test]
async fn bootstrap_rejects_a_response_from_the_wrong_phase_without_promotion() {
    let http = Arc::new(RoutingAuthHttp::new(
        current_kdf_profile(),
        RoutingAuthBehavior::Success,
        None,
    ));
    *http.bootstrap_pages.lock().unwrap() = vec![json!({
        "phase": "items",
        "hasMore": false,
        "items": [],
        "nextCursor": null,
        "syncCursor": { "id": "evt-wrong-phase" }
    })];
    let (runtime, _replica, _platform) = routing_harness(http.clone()).await;
    let RuntimeResponse::SignedIn { account_id, .. } = runtime
        .request(
            sign_in_request(NORMALIZED_EMAIL),
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("expected SignedIn");
    };

    let snapshot = runtime.replica.snapshot(&account_id).unwrap();
    assert_eq!(snapshot.bootstrap.state, crate::replica::ReplicaState::Cold);
    assert!(snapshot.bootstrap.active_generation.is_none());
    assert!(snapshot.bootstrap.vaults.is_empty());
    assert!(snapshot.bootstrap.items.is_empty());
    let bootstrap_urls: Vec<_> = http
        .requests()
        .into_iter()
        .filter_map(|request| request["url"].as_str().map(ToOwned::to_owned))
        .filter(|url| url.contains("/sync/bootstrap"))
        .collect();
    assert_eq!(bootstrap_urls.len(), 1);
    assert!(bootstrap_urls[0].contains("phase=vaults"));
}

#[tokio::test]
async fn bootstrap_promotes_captured_empty_distinct_from_cold() {
    let http = Arc::new(RoutingAuthHttp::new(
        current_kdf_profile(),
        RoutingAuthBehavior::Success,
        None,
    ));
    let (runtime, _replica, _platform) = routing_harness(http).await;
    let RuntimeResponse::SignedIn { account_id, .. } = runtime
        .request(
            sign_in_request(NORMALIZED_EMAIL),
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("expected SignedIn");
    };
    let snapshot = runtime.replica.snapshot(&account_id).unwrap();
    assert_eq!(
        snapshot.bootstrap.state,
        crate::replica::ReplicaState::Ready
    );
    assert_eq!(
        snapshot.bootstrap.active_cursor,
        crate::replica::SyncCursor::CapturedEmpty
    );
    assert_ne!(
        snapshot.bootstrap.active_cursor,
        crate::replica::SyncCursor::Cold
    );
}

#[tokio::test]
async fn full_sign_in_completes_without_waiting_for_the_live_sse_body() {
    let http = Arc::new(RoutingAuthHttp::new(
        current_kdf_profile(),
        RoutingAuthBehavior::Success,
        None,
    ));
    let held_sse = HttpPause::new(HttpPauseStep::Events);
    http.pause_at(held_sse.clone());
    let (runtime, _replica, _platform) = routing_harness(http).await;

    let signing_in = tokio::spawn(async move {
        runtime
            .request(
                sign_in_request(NORMALIZED_EMAIL),
                RequestCancellation::new(),
            )
            .await
    });
    for _ in 0..128 {
        if signing_in.is_finished() || held_sse.reached.load(Ordering::SeqCst) {
            break;
        }
        tokio::task::yield_now().await;
    }

    assert!(
        signing_in.is_finished(),
        "full Sign-in remained blocked after bounded Bootstrap entered the held SSE response"
    );
    assert!(
        !held_sse.reached.load(Ordering::SeqCst),
        "full Sign-in must not synchronously open the live SSE endpoint"
    );
    assert!(matches!(
        signing_in.await.unwrap().unwrap(),
        RuntimeResponse::SignedIn { .. }
    ));
}

#[tokio::test]
async fn bootstrap_decrypts_login_items_and_sse_hint_is_not_authority() {
    let http = Arc::new(RoutingAuthHttp::new(
        current_kdf_profile(),
        RoutingAuthBehavior::Success,
        None,
    ));
    let (_wrapped, mut item) = sealed_login_item("item-1", "Bank", "secret-password");
    item["favorite"] = json!(true);
    *http.bootstrap_pages.lock().unwrap() = vec![json!({
        "hasMore": false,
        "items": [item],
        "nextCursor": null,
        "syncCursor": { "id": "evt-1" }
    })];
    *http.sse_body.lock().unwrap() = b"data: {\"title\":\"leaked-plaintext\"}\n\n".to_vec();
    let (runtime, _replica, _platform) = routing_harness(http.clone()).await;
    let RuntimeResponse::SignedIn { account_id, .. } = runtime
        .request(
            sign_in_request(NORMALIZED_EMAIL),
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("expected SignedIn");
    };
    let sink = Arc::new(Sink::default());
    let _items = runtime
        .observe(
            ObservationRequest::Items {
                account_id: account_id.clone(),
            },
            sink.clone(),
        )
        .unwrap();
    let RuntimeProjection::Items(projection) = sink.0.lock().unwrap().last().cloned().unwrap()
    else {
        panic!("expected Items");
    };
    assert_eq!(projection.items.len(), 1);
    assert_eq!(projection.items[0].title, "Bank");
    assert_eq!(
        projection.items[0].password.as_deref(),
        Some("secret-password")
    );
    assert!(projection.items[0].favorite);
    assert_eq!(projection.items[0].created_at, "2026-08-23T00:00:00Z");
    assert_eq!(projection.items[0].updated_at, "2026-08-23T00:00:00Z");
    let snapshot = runtime.replica.snapshot(&account_id).unwrap();
    for item in snapshot.bootstrap.items.values() {
        assert!(!item.encrypted_data.contains("secret-password"));
        assert!(!item.encrypted_data.contains("leaked-plaintext"));
    }
    assert_eq!(
        snapshot.bootstrap.active_cursor,
        crate::replica::SyncCursor::CapturedValue { id: "evt-1".into() }
    );
}

#[tokio::test]
async fn bootstrap_pages_resume_by_fingerprint_and_reject_watermark_races() {
    let http = Arc::new(RoutingAuthHttp::new(
        current_kdf_profile(),
        RoutingAuthBehavior::Success,
        None,
    ));
    let (_wrapped, item_one) = sealed_login_item("item-1", "One", "p1");
    let (_wrapped, item_two) = sealed_login_item("item-2", "Two", "p2");
    *http.bootstrap_pages.lock().unwrap() = vec![
        json!({
            "hasMore": true,
            "items": [item_one],
            "nextCursor": "page-2",
            "syncCursor": { "id": "evt-1" }
        }),
        json!({
            "hasMore": false,
            "items": [item_two],
            "nextCursor": null,
            "syncCursor": { "id": "evt-changed" }
        }),
    ];
    let (runtime, _replica, _platform) = routing_harness(http).await;
    let RuntimeResponse::SignedIn { account_id, .. } = runtime
        .request(
            sign_in_request(NORMALIZED_EMAIL),
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("expected SignedIn");
    };
    let snapshot = runtime.replica.snapshot(&account_id).unwrap();
    assert_ne!(
        snapshot.bootstrap.state,
        crate::replica::ReplicaState::Ready
    );
    assert!(snapshot.bootstrap.snapshot().visible_items.is_empty());
}

#[tokio::test]
async fn session_refresh_installs_a_usable_token() {
    let http = Arc::new(RoutingAuthHttp::new(
        current_kdf_profile(),
        RoutingAuthBehavior::Success,
        None,
    ));
    let (runtime, _replica, _platform) = routing_harness(http.clone()).await;
    let RuntimeResponse::SignedIn { account_id, .. } = runtime
        .request(
            sign_in_request(NORMALIZED_EMAIL),
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("expected SignedIn");
    };
    http.clear_requests();
    http.unauthorized_sync_once.store(true, Ordering::SeqCst);
    runtime
        .bootstrap_account(&account_id, RequestCancellation::new())
        .await
        .unwrap();
    let urls: Vec<String> = http
        .requests()
        .iter()
        .map(|request| request["url"].as_str().unwrap().to_owned())
        .collect();
    assert!(urls
        .iter()
        .any(|url| url.contains("/sessions/current/refresh")));
    let refresh_index = http
        .requests()
        .iter()
        .position(|request| {
            request["url"]
                .as_str()
                .unwrap()
                .contains("/sessions/current/refresh")
        })
        .unwrap();
    let later = &http.requests()[refresh_index + 1];
    let headers = later["headers"].as_array().unwrap();
    assert!(headers.iter().any(|header| {
        header["name"] == "Authorization" && header["value"] == "Bearer refreshed-token"
    }));
}

#[tokio::test]
async fn session_refresh_installs_a_usable_token_and_401_preserves_operations() {
    let http = Arc::new(RoutingAuthHttp::new(
        current_kdf_profile(),
        RoutingAuthBehavior::Success,
        None,
    ));
    // The first Bootstrap has to publish the personal Vault the accepted create writes into.
    let (_wrapped, item) = sealed_login_item("item-1", "Bank", "secret-password");
    *http.bootstrap_pages.lock().unwrap() = vec![json!({
        "hasMore": false,
        "items": [item],
        "nextCursor": null,
        "syncCursor": { "id": "evt-1" }
    })];
    let (runtime, _replica, platform) = routing_harness(http.clone()).await;
    let RuntimeResponse::SignedIn { account_id, .. } = runtime
        .request(
            sign_in_request(NORMALIZED_EMAIL),
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("expected SignedIn");
    };
    runtime
        .request(
            create_request(account_id.as_str()),
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    *http.refresh_status.lock().unwrap() = Some(401);
    *http.bootstrap_pages.lock().unwrap() = vec![json!({
        "hasMore": false,
        "items": [],
        "nextCursor": null,
        "syncCursor": { "id": "evt-2" }
    })];
    http.state.lock().unwrap().bootstrap_index = 0;
    let error = runtime
        .bootstrap_account(&account_id, RequestCancellation::new())
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::AuthenticationRequired);
    let status = runtime_status(&runtime);
    assert_eq!(
        status.accounts[0].waiting_reason,
        Some(AccountWaitingReason::ReauthenticationRequired)
    );
    let snapshot = runtime.replica.snapshot(&account_id).unwrap();
    assert!(!snapshot.operations.is_empty());
    let _ = platform;
}

#[tokio::test]
async fn restart_from_durable_replica_reads_offline_after_online_unlock() {
    let http = Arc::new(RoutingAuthHttp::new(
        current_kdf_profile(),
        RoutingAuthBehavior::Success,
        None,
    ));
    let (_wrapped, item) = sealed_login_item("item-1", "Bank", "secret-password");
    *http.bootstrap_pages.lock().unwrap() = vec![json!({
        "hasMore": false,
        "items": [item],
        "nextCursor": null,
        "syncCursor": { "id": "evt-1" }
    })];
    let events = Arc::new(Mutex::new(Vec::new()));
    let replica = Arc::new(InstallationReplica::new(events.clone()));
    let platform = Arc::new(InstallationPlatform {
        events,
        ..InstallationPlatform::default()
    });
    let first = Runtime::with_configured_serialized_executors(
        replica.clone(),
        platform.clone(),
        http.clone(),
        AuthClientConfig::new(
            "client-routing".into(),
            ClientPlatform::Desktop,
            "0.5.2-test".into(),
        )
        .unwrap(),
    );
    first.open().await.unwrap();
    let RuntimeResponse::SignedIn { account_id, .. } = first
        .request(
            sign_in_request(NORMALIZED_EMAIL),
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("expected SignedIn");
    };
    let RuntimeResponse::Accepted {
        operation_id: share_operation_id,
        ..
    } = first
        .request(
            RuntimeRequest::CreateShare {
                account_id: account_id.clone(),
                item_id: "item-1".into(),
                draft: crate::CreateShareDraft {
                    access_mode: crate::ShareAccessMode::Anyone,
                    expires_in: crate::ShareExpiration::SevenDays,
                    is_one_time_use: false,
                    allowed_emails: Vec::new(),
                },
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("expected Share acceptance");
    };
    let accepted = first.replica.snapshot(&account_id).unwrap();
    let immutable_share_bytes = accepted.operations[0].request.body.clone();
    assert_eq!(accepted.share_capabilities.len(), 1);
    first.close().await;

    let restored = Runtime::with_configured_serialized_executors(
        replica.clone(),
        platform.clone(),
        http.clone(),
        AuthClientConfig::new(
            "client-routing".into(),
            ClientPlatform::Desktop,
            "0.5.2-test".into(),
        )
        .unwrap(),
    );
    restored.open().await.unwrap();
    let status = runtime_status(&restored);
    // The restart kept the Quick Unlock material the first Sign-in wrote, so the Account comes
    // back Locked and the master password alone reopens it.
    assert_eq!(status.accounts[0].access, AccountAccessState::Locked);
    restored
        .request(
            quick_unlock_request(account_id.as_str()),
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let recovered = restored.replica.snapshot(&account_id).unwrap();
    assert_eq!(recovered.operations[0].request.body, immutable_share_bytes);
    let capability = recovered
        .share_capabilities
        .iter()
        .find(|capability| capability.operation_id == share_operation_id)
        .unwrap();
    let live_muk = restored
        .copy_live_master_unlock_key(&account_id, &recovered.incarnation)
        .unwrap();
    assert!(bittery_crypto_core::decrypt_share_capability(
        &bittery_crypto_core::EncryptedData {
            ciphertext: capability.ciphertext.clone(),
            iv: capability.iv.clone(),
            algorithm: capability.algorithm.clone(),
        },
        live_muk.as_slice(),
        &bittery_crypto_core::ShareCapabilityAadContext::new(
            account_id.as_str().into(),
            share_operation_id.clone(),
        )
        .unwrap(),
    )
    .is_ok());
    let operation = recovered
        .operations
        .iter()
        .find(|operation| operation.operation_id == share_operation_id)
        .unwrap()
        .clone();
    let reconciled = restored
        .replica
        .execute_recomputing(GuardedCommitPlan::new(
            account_id.clone(),
            recovered.incarnation,
            recovered.revision,
            recovered.lock_epoch,
            vec![PlanMutation::ReconcileShareOutcome {
                outcome: ObservedOutcome {
                    operation_id: share_operation_id.clone(),
                    request_fingerprint: operation.request_fingerprint,
                    result: OperationOutcomeResult::ShareApplied {
                        share_link_id: "share-link-after-restart".into(),
                        base_share_url: "https://app.example.test/share/".into(),
                        expires_at: "2099-01-02T03:04:05Z".into(),
                    },
                },
                cursor: None,
            }],
        ))
        .await
        .unwrap();
    let RecomputedPlanResult::Applied { snapshot } = reconciled else {
        panic!("Share reconciliation must commit");
    };
    restored.replica.cache(snapshot);
    restored.close().await;

    let restored_again = Runtime::with_configured_serialized_executors(
        replica,
        platform,
        http.clone(),
        AuthClientConfig::new(
            "client-routing".into(),
            ClientPlatform::Desktop,
            "0.5.2-test".into(),
        )
        .unwrap(),
    );
    restored_again.open().await.unwrap();
    restored_again
        .request(
            quick_unlock_request(account_id.as_str()),
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let RuntimeProjection::PendingShareResults(pending) = restored_again
        .projection(&ObservationRequest::PendingShareResults {
            account_id: account_id.clone(),
        })
        .unwrap()
        .projection
    else {
        panic!("expected PendingShareResults after Quick Unlock");
    };
    assert_eq!(pending.results.len(), 1);
    assert_eq!(pending.results[0].operation_id, share_operation_id);
    assert!(pending.results[0]
        .share_url
        .starts_with("https://app.example.test/share/"));
    assert!(pending.results[0].share_url.contains('#'));
    http.disconnect();
    http.clear_requests();
    let sink = Arc::new(Sink::default());
    let _items = restored_again
        .observe(
            ObservationRequest::Items {
                account_id: account_id.clone(),
            },
            sink.clone(),
        )
        .unwrap();
    let RuntimeProjection::Items(projection) = sink.0.lock().unwrap().last().cloned().unwrap()
    else {
        panic!("expected Items");
    };
    assert_eq!(projection.items[0].title, "Bank");
    assert!(http.requests().is_empty());
}

#[tokio::test]
async fn expired_cursor_starts_staging_while_old_projection_stays_readable() {
    let http = Arc::new(RoutingAuthHttp::new(
        current_kdf_profile(),
        RoutingAuthBehavior::Success,
        None,
    ));
    let (_wrapped, item) = sealed_login_item("item-1", "Bank", "secret-password");
    *http.bootstrap_pages.lock().unwrap() = vec![json!({
        "hasMore": false,
        "items": [item],
        "nextCursor": null,
        "syncCursor": { "id": "evt-1" }
    })];
    let (runtime, _replica, _platform) = routing_harness(http.clone()).await;
    let RuntimeResponse::SignedIn { account_id, .. } = runtime
        .request(
            sign_in_request(NORMALIZED_EMAIL),
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("expected SignedIn");
    };
    let sink = Arc::new(Sink::default());
    let _items = runtime
        .observe(
            ObservationRequest::Items {
                account_id: account_id.clone(),
            },
            sink.clone(),
        )
        .unwrap();
    let RuntimeProjection::Items(before) = sink.0.lock().unwrap().last().cloned().unwrap() else {
        panic!("expected Items");
    };
    assert_eq!(before.items[0].title, "Bank");
    let previous_generation = runtime
        .replica
        .snapshot(&account_id)
        .unwrap()
        .bootstrap
        .active_generation
        .clone()
        .unwrap();

    let (_wrapped, refreshed) = sealed_login_item("item-2", "Treasury", "new-password");
    *http.changes_pages.lock().unwrap() = vec![json!({
        "cursor": null,
        "events": [],
        "hasMore": false,
        "requiresFullRefresh": true
    })];
    *http.bootstrap_pages.lock().unwrap() = vec![json!({
        "hasMore": false,
        "items": [refreshed],
        "nextCursor": null,
        "syncCursor": { "id": "evt-2" }
    })];
    http.state.lock().unwrap().bootstrap_index = 0;
    http.state.lock().unwrap().changes_index = 0;
    let pause = HttpPause::new(HttpPauseStep::Bootstrap);
    http.pause_at(pause.clone());
    let running = {
        let runtime = runtime.clone();
        let account_id = account_id.clone();
        tokio::spawn(async move {
            runtime
                .bootstrap_account(&account_id, RequestCancellation::new())
                .await
        })
    };
    pause.wait_until_reached().await;
    let snapshot = runtime.replica.snapshot(&account_id).unwrap();
    assert_eq!(
        snapshot.bootstrap.state,
        crate::replica::ReplicaState::Bootstrapping
    );
    assert_eq!(
        snapshot.bootstrap.active_generation.as_ref(),
        Some(&previous_generation)
    );
    let staging = snapshot.bootstrap.staging_generation.clone().unwrap();
    assert_ne!(staging, previous_generation);
    assert_eq!(
        snapshot
            .bootstrap
            .generations
            .get(&staging)
            .unwrap()
            .fallback_state,
        crate::replica::ReplicaState::RefreshRequired
    );
    let RuntimeProjection::Items(during) = sink.0.lock().unwrap().last().cloned().unwrap() else {
        panic!("expected Items");
    };
    assert_eq!(during.items[0].title, "Bank");
    assert!(!during.items.iter().any(|item| item.title == "Treasury"));
    pause.release();
    running.await.unwrap().unwrap();
    let RuntimeProjection::Items(after) = sink.0.lock().unwrap().last().cloned().unwrap() else {
        panic!("expected Items");
    };
    assert_eq!(after.items[0].title, "Treasury");
    assert_eq!(
        runtime
            .replica
            .snapshot(&account_id)
            .unwrap()
            .bootstrap
            .state,
        crate::replica::ReplicaState::Ready
    );
}

#[tokio::test]
async fn lock_during_bootstrap_publishes_no_plaintext() {
    let http = Arc::new(RoutingAuthHttp::new(
        current_kdf_profile(),
        RoutingAuthBehavior::Success,
        None,
    ));
    let (_wrapped, item) = sealed_login_item("item-1", "Bank", "secret-password");
    *http.bootstrap_pages.lock().unwrap() = vec![json!({
        "hasMore": false,
        "items": [item],
        "nextCursor": null,
        "syncCursor": { "id": "evt-1" }
    })];
    let pause = HttpPause::new(HttpPauseStep::Bootstrap);
    http.pause_at(pause.clone());
    let (runtime, _replica, _platform) = routing_harness(http).await;
    let reached_plaintext_commit = Arc::new(AtomicBool::new(false));
    runtime.set_before_plaintext_commit_hook(Some(Arc::new({
        let reached_plaintext_commit = reached_plaintext_commit.clone();
        move || {
            reached_plaintext_commit.store(true, Ordering::SeqCst);
        }
    })));
    let running = {
        let runtime = runtime.clone();
        tokio::spawn(async move {
            runtime
                .request(
                    sign_in_request(NORMALIZED_EMAIL),
                    RequestCancellation::new(),
                )
                .await
        })
    };
    pause.wait_until_reached().await;
    let account_id = runtime.replica.snapshots()[0].account_id.clone();
    let sink = Arc::new(Sink::default());
    let _items = runtime
        .observe(
            ObservationRequest::Items {
                account_id: account_id.clone(),
            },
            sink.clone(),
        )
        .unwrap();
    let locking = tokio::spawn({
        let runtime = runtime.clone();
        let account_id = account_id.clone();
        async move { runtime.mark_account_locked(&account_id).await }
    });
    while !runtime.account_access_retirement_is_pending(&account_id) {
        tokio::task::yield_now().await;
    }
    assert!(
        !locking.is_finished(),
        "Lock must wait while Bootstrap owns the Account execution fence"
    );
    pause.release();
    let (signed_in, locked) = tokio::join!(running, locking);
    signed_in.unwrap().unwrap();
    locked.unwrap().unwrap();
    let published: Vec<_> = sink.0.lock().unwrap().clone();
    for projection in published {
        let RuntimeProjection::Items(items) = projection else {
            continue;
        };
        for item in items.items {
            assert_ne!(item.password.as_deref(), Some("secret-password"));
            assert_ne!(item.title.as_str(), "Bank");
        }
    }
    let snapshot = runtime.replica.snapshot(&account_id).unwrap();
    for item in snapshot.bootstrap.items.values() {
        assert!(!item.encrypted_data.contains("secret-password"));
    }
    assert!(
        !reached_plaintext_commit.load(Ordering::SeqCst),
        "queued Lock must fence Bootstrap before plaintext reaches the final commit boundary"
    );
}

#[tokio::test]
async fn lock_at_the_final_bootstrap_boundary_publishes_no_plaintext() {
    let http = Arc::new(RoutingAuthHttp::new(
        current_kdf_profile(),
        RoutingAuthBehavior::Success,
        None,
    ));
    let (_wrapped, item) = sealed_login_item("item-1", "Bank", "secret-password");
    *http.bootstrap_pages.lock().unwrap() = vec![json!({
        "hasMore": false,
        "items": [item],
        "nextCursor": null,
        "syncCursor": { "id": "evt-1" }
    })];
    let bootstrap_pause = HttpPause::new(HttpPauseStep::Bootstrap);
    http.pause_at(bootstrap_pause.clone());
    let (runtime, _replica, _platform) = routing_harness(http).await;
    let reached_plaintext_commit = Arc::new(AtomicBool::new(false));
    let release_plaintext_commit = Arc::new(AtomicBool::new(false));
    runtime.set_before_plaintext_commit_hook(Some(Arc::new({
        let reached = reached_plaintext_commit.clone();
        let release = release_plaintext_commit.clone();
        move || {
            reached.store(true, Ordering::SeqCst);
            while !release.load(Ordering::SeqCst) {
                std::thread::yield_now();
            }
        }
    })));
    let signing_in = std::thread::spawn({
        let runtime = runtime.clone();
        move || {
            tokio::runtime::Builder::new_current_thread()
                .build()
                .unwrap()
                .block_on(runtime.request(
                    sign_in_request(NORMALIZED_EMAIL),
                    RequestCancellation::new(),
                ))
        }
    });
    bootstrap_pause.wait_until_reached().await;
    let account_id = runtime.replica.snapshots()[0].account_id.clone();
    let sink = Arc::new(Sink::default());
    let _items = runtime
        .observe(
            ObservationRequest::Items {
                account_id: account_id.clone(),
            },
            sink.clone(),
        )
        .unwrap();
    bootstrap_pause.release();
    while !reached_plaintext_commit.load(Ordering::SeqCst) {
        tokio::task::yield_now().await;
    }
    let locking = tokio::spawn({
        let runtime = runtime.clone();
        let account_id = account_id.clone();
        async move { runtime.mark_account_locked(&account_id).await }
    });
    while !runtime.account_access_retirement_is_pending(&account_id) {
        tokio::task::yield_now().await;
    }

    release_plaintext_commit.store(true, Ordering::SeqCst);
    signing_in.join().unwrap().unwrap();
    locking.await.unwrap().unwrap();
    for projection in sink.0.lock().unwrap().clone() {
        let RuntimeProjection::Items(items) = projection else {
            continue;
        };
        for item in items.items {
            assert_ne!(item.password.as_deref(), Some("secret-password"));
            assert_ne!(item.title.as_str(), "Bank");
        }
    }
}

#[tokio::test]
async fn cancelled_lock_waiter_does_not_fence_bootstrap_decryption() {
    let http = Arc::new(RoutingAuthHttp::new(
        current_kdf_profile(),
        RoutingAuthBehavior::Success,
        None,
    ));
    let (_wrapped, item) = sealed_login_item("item-1", "Bank", "secret-password");
    *http.bootstrap_pages.lock().unwrap() = vec![json!({
        "hasMore": false,
        "items": [item],
        "nextCursor": null,
        "syncCursor": { "id": "evt-1" }
    })];
    let pause = HttpPause::new(HttpPauseStep::Bootstrap);
    http.pause_at(pause.clone());
    let (runtime, _replica, _platform) = routing_harness(http).await;
    let signing_in = tokio::spawn({
        let runtime = runtime.clone();
        async move {
            runtime
                .request(
                    sign_in_request(NORMALIZED_EMAIL),
                    RequestCancellation::new(),
                )
                .await
        }
    });
    pause.wait_until_reached().await;
    let account_id = runtime.replica.snapshots()[0].account_id.clone();
    let locking = tokio::spawn({
        let runtime = runtime.clone();
        let account_id = account_id.clone();
        async move { runtime.mark_account_locked(&account_id).await }
    });
    while !runtime.account_access_retirement_is_pending(&account_id) {
        tokio::task::yield_now().await;
    }

    locking.abort();
    assert!(locking.await.unwrap_err().is_cancelled());
    assert!(!runtime.account_access_retirement_is_pending(&account_id));
    pause.release();
    signing_in.await.unwrap().unwrap();

    let sink = Arc::new(Sink::default());
    let _items = runtime
        .observe(
            ObservationRequest::Items {
                account_id: account_id.clone(),
            },
            sink.clone(),
        )
        .unwrap();
    let RuntimeProjection::Items(projection) = sink.0.lock().unwrap().last().cloned().unwrap()
    else {
        panic!("expected Items");
    };
    assert_eq!(
        projection.items[0].password.as_deref(),
        Some("secret-password")
    );
}

#[tokio::test]
async fn failed_authority_fetch_leaves_prior_generation_and_cursor() {
    let http = Arc::new(RoutingAuthHttp::new(
        current_kdf_profile(),
        RoutingAuthBehavior::Success,
        None,
    ));
    let (_wrapped, item) = sealed_login_item("item-1", "Bank", "secret-password");
    *http.bootstrap_pages.lock().unwrap() = vec![json!({
        "hasMore": false,
        "items": [item],
        "nextCursor": null,
        "syncCursor": { "id": "evt-1" }
    })];
    let (runtime, _replica, _platform) = routing_harness(http.clone()).await;
    let RuntimeResponse::SignedIn { account_id, .. } = runtime
        .request(
            sign_in_request(NORMALIZED_EMAIL),
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("expected SignedIn");
    };
    let before = runtime.replica.snapshot(&account_id).unwrap();
    let previous_generation = before.bootstrap.active_generation.clone();
    let previous_cursor = before.bootstrap.active_cursor.clone();
    *http.changes_pages.lock().unwrap() = vec![json!({
        "cursor": { "id": "evt-2" },
        "events": [{
            "clientId": null,
            "entityId": "item-2",
            "entityType": "item",
            "id": "evt-2",
            "metadata": null,
            "timestamp": "0",
            "type": "item_created",
            "userId": "user-1",
            "vaultId": "vault-1",
            "version": 1
        }],
        "hasMore": false,
        "requiresFullRefresh": false
    })];
    http.state.lock().unwrap().changes_index = 0;
    runtime
        .bootstrap_account(&account_id, RequestCancellation::new())
        .await
        .unwrap();
    let after = runtime.replica.snapshot(&account_id).unwrap();
    assert_eq!(after.bootstrap.active_generation, previous_generation);
    assert_eq!(after.bootstrap.active_cursor, previous_cursor);
    assert!(!after
        .bootstrap
        .items
        .keys()
        .any(|(_, item_id)| item_id == "item-2"));
}

#[tokio::test]
async fn failed_authority_commit_leaves_prior_generation_and_cursor() {
    let http = Arc::new(RoutingAuthHttp::new(
        current_kdf_profile(),
        RoutingAuthBehavior::Success,
        None,
    ));
    let (_wrapped, item) = sealed_login_item("item-1", "Bank", "secret-password");
    let (_wrapped, mut next_item) = sealed_login_item("item-2", "Treasury", "new-password");
    next_item.as_object_mut().unwrap().remove("attachments");
    next_item.as_object_mut().unwrap().remove("vault");
    *http.bootstrap_pages.lock().unwrap() = vec![json!({
        "hasMore": false,
        "items": [item],
        "nextCursor": null,
        "syncCursor": { "id": "evt-1" }
    })];
    let (runtime, replica, _platform) = routing_harness(http.clone()).await;
    let RuntimeResponse::SignedIn { account_id, .. } = runtime
        .request(
            sign_in_request(NORMALIZED_EMAIL),
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("expected SignedIn");
    };
    let before = runtime.replica.snapshot(&account_id).unwrap();
    let previous_generation = before.bootstrap.active_generation.clone();
    let previous_cursor = before.bootstrap.active_cursor.clone();
    http.item_bodies
        .lock()
        .unwrap()
        .insert("item-2".into(), next_item);
    *http.changes_pages.lock().unwrap() = vec![json!({
        "cursor": { "id": "evt-2" },
        "events": [{
            "clientId": null,
            "entityId": "item-2",
            "entityType": "item",
            "id": "evt-2",
            "metadata": null,
            "timestamp": "0",
            "type": "item_created",
            "userId": "user-1",
            "vaultId": "vault-1",
            "version": 1
        }],
        "hasMore": false,
        "requiresFullRefresh": false
    })];
    http.state.lock().unwrap().changes_index = 0;
    replica.fail_next_commit();
    runtime
        .bootstrap_account(&account_id, RequestCancellation::new())
        .await
        .unwrap();
    let after = runtime.replica.snapshot(&account_id).unwrap();
    assert_eq!(after.bootstrap.active_generation, previous_generation);
    assert_eq!(after.bootstrap.active_cursor, previous_cursor);
    assert!(!after
        .bootstrap
        .items
        .keys()
        .any(|(_, item_id)| item_id == "item-2"));
}

fn generation_storage_key(account: &str, incarnation: &str, document: &str) -> String {
    format!(
            "bittery:runtime:platform-storage:account:{}:{account}:incarnation:{}:{incarnation}:{document}",
            account.len(),
            incarnation.len()
        )
}

fn signed_in_account(runtime: &Runtime) -> (AccountId, Incarnation) {
    let snapshot = runtime.replica.snapshots().into_iter().next().unwrap();
    (snapshot.account_id, snapshot.incarnation)
}

fn last_status_access(sink: &Sink, account_id: &AccountId) -> Option<AccountAccessState> {
    sink.0
        .lock()
        .unwrap()
        .iter()
        .rev()
        .find_map(|projection| match projection {
            RuntimeProjection::RuntimeStatus(status) => Some(status.clone()),
            RuntimeProjection::Items(_) | RuntimeProjection::PendingShareResults(_) => None,
        })?
        .accounts
        .into_iter()
        .find(|status| &status.account_id == account_id)
        .map(|status| status.access)
}

async fn signed_in_runtime_with_one_sealed_item() -> (
    Arc<Runtime>,
    Arc<InstallationPlatform>,
    AccountId,
    Incarnation,
) {
    let http = Arc::new(RoutingAuthHttp::new(
        current_kdf_profile(),
        RoutingAuthBehavior::Success,
        None,
    ));
    let (_wrapped, item) = sealed_login_item("item-1", "Bank", "secret-password");
    *http.bootstrap_pages.lock().unwrap() = vec![json!({
        "hasMore": false,
        "items": [item],
        "nextCursor": null,
        "syncCursor": { "id": "evt-1" }
    })];
    let (runtime, _replica, platform) = routing_harness(http).await;
    runtime
        .request(
            sign_in_request(NORMALIZED_EMAIL),
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let (account_id, incarnation) = signed_in_account(&runtime);
    (runtime, platform, account_id, incarnation)
}

#[tokio::test]
async fn sign_out_destroys_live_keys_decrypted_items_and_quick_unlock_material() {
    let (runtime, platform, account_id, incarnation) =
        signed_in_runtime_with_one_sealed_item().await;
    let RuntimeResponse::Accepted { operation_id, .. } = runtime
        .request(
            create_request(account_id.as_str()),
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("expected Accepted");
    };
    let status_sink = Arc::new(Sink::default());
    let _status = runtime
        .observe(
            ObservationRequest::RuntimeStatus { account_id: None },
            status_sink.clone(),
        )
        .unwrap();
    let items_sink = Arc::new(Sink::default());
    let _items = runtime
        .observe(
            ObservationRequest::Items {
                account_id: account_id.clone(),
            },
            items_sink.clone(),
        )
        .unwrap();
    assert!(runtime.has_live_master_unlock_key(&account_id, &incarnation));
    assert!(runtime
        .unlocked_items
        .lock()
        .unwrap()
        .get(&account_id)
        .is_some_and(|items| items
            .iter()
            .any(|item| item.password.as_deref() == Some("secret-password"))));
    let published_items_before_sign_out = items_sink.0.lock().unwrap().len();
    assert!(published_items_before_sign_out > 0);
    let _ = take_zeroized_live_master_unlock_key_drops();

    let response = runtime
        .request(
            RuntimeRequest::SignOut {
                account_id: account_id.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();

    assert_eq!(
        response,
        RuntimeResponse::AccessChanged {
            account_id: account_id.clone(),
            access: AccountAccessState::SignedOut,
        }
    );
    assert!(runtime.live_master_unlock_keys.lock().unwrap().is_empty());
    assert!(take_zeroized_live_master_unlock_key_drops() >= 1);
    assert!(!runtime.has_live_master_unlock_key(&account_id, &incarnation));
    assert!(runtime
        .unlocked_items
        .lock()
        .unwrap()
        .get(&account_id)
        .is_none());
    assert_eq!(
        runtime.account_access_state(&account_id),
        Some(AccountAccessState::SignedOut)
    );
    let Err(error) = runtime.projection(&ObservationRequest::Items {
        account_id: account_id.clone(),
    }) else {
        panic!("a signed-out Account must not project decrypted Items");
    };
    assert_eq!(error.code, RuntimeErrorCode::AuthenticationRequired);
    assert_eq!(
        last_status_access(&status_sink, &account_id),
        Some(AccountAccessState::SignedOut)
    );
    assert_eq!(
        items_sink.0.lock().unwrap().len(),
        published_items_before_sign_out,
        "sign-out published another Items projection to an observation it just retired"
    );
    assert!(runtime
        .replica
        .snapshot(&account_id)
        .unwrap()
        .operations
        .iter()
        .any(|operation| operation.operation_id == operation_id));
    assert!(!platform.has_document(account_id.as_str(), incarnation.as_str(), "quick-unlock"));
    assert!(!platform.has_document(account_id.as_str(), incarnation.as_str(), "current-session"));
    assert!(platform.has_document(account_id.as_str(), incarnation.as_str(), "metadata"));
    assert_eq!(platform.catalog().unwrap().accounts.len(), 1);
}

#[tokio::test]
async fn lock_keeps_quick_unlock_material_that_sign_out_deletes() {
    let (runtime, platform, account_id, incarnation) =
        signed_in_runtime_with_one_sealed_item().await;

    let locked = runtime
        .request(
            RuntimeRequest::Lock {
                account_id: account_id.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();

    assert_eq!(
        locked,
        RuntimeResponse::AccessChanged {
            account_id: account_id.clone(),
            access: AccountAccessState::Locked,
        }
    );
    assert_eq!(
        runtime.account_access_state(&account_id),
        Some(AccountAccessState::Locked)
    );
    assert!(!runtime.has_live_master_unlock_key(&account_id, &incarnation));
    assert!(platform.has_document(account_id.as_str(), incarnation.as_str(), "quick-unlock"));
    runtime
        .request(
            quick_unlock_request(account_id.as_str()),
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        runtime.account_access_state(&account_id),
        Some(AccountAccessState::Unlocked)
    );

    runtime
        .request(
            RuntimeRequest::SignOut {
                account_id: account_id.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();

    let error = runtime
        .request(
            quick_unlock_request(account_id.as_str()),
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::AuthenticationRequired);
    assert_eq!(
        runtime.account_access_state(&account_id),
        Some(AccountAccessState::SignedOut)
    );
}

#[tokio::test]
async fn repeated_and_unknown_sign_out_and_lock_answer_without_failing() {
    let (runtime, _platform, account_id, _incarnation) =
        signed_in_runtime_with_one_sealed_item().await;
    let unknown = AccountId::from("account-that-was-never-installed");

    for _ in 0..2 {
        assert_eq!(
            runtime
                .request(
                    RuntimeRequest::SignOut {
                        account_id: account_id.clone()
                    },
                    RequestCancellation::new(),
                )
                .await
                .unwrap(),
            RuntimeResponse::AccessChanged {
                account_id: account_id.clone(),
                access: AccountAccessState::SignedOut,
            }
        );
    }
    for request in [
        RuntimeRequest::SignOut {
            account_id: unknown.clone(),
        },
        RuntimeRequest::Lock {
            account_id: unknown.clone(),
        },
    ] {
        assert_eq!(
            runtime.request(request, RequestCancellation::new()).await,
            Ok(RuntimeResponse::AccessChanged {
                account_id: unknown.clone(),
                access: AccountAccessState::SignedOut,
            })
        );
    }
    assert_eq!(
        runtime
            .request(
                RuntimeRequest::Lock {
                    account_id: account_id.clone()
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap(),
        RuntimeResponse::AccessChanged {
            account_id: account_id.clone(),
            access: AccountAccessState::Locked,
        }
    );
    assert!(runtime.replica.snapshot(&unknown).is_none());
}
