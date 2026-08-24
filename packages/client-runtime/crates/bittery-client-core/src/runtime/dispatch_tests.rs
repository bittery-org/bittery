//! Slice B: what happens to an accepted Operation once the network is allowed to fail.
//!
//! The fake Server here is deliberately not a stub. It keeps the same `(User, Operation ID)`
//! table the real Server keeps, recomputes the same length-delimited fingerprint from the raw
//! body it received, and counts Items separately from requests. That is what lets these tests
//! assert *effects* rather than call counts.

use super::*;
use crate::{
    auth_http::{AuthClientConfig, ClientPlatform},
    authentication_installation::Clock,
    device_timer::DeviceTimer,
    http_transport::{HttpHeader, HttpMethod},
    platform_storage::{AccountMetadataDocument, CurrentSessionDocument},
    protocol::Incarnation,
    replica::{
        InMemoryReplica, OperationRecord, ReplicaPersistenceRequest, SerializedReplicaExecutor,
    },
    test_fixtures::{seed_ready_personal_vault, TEST_VAULT_ID},
    LoginItemDraft,
};
use async_trait::async_trait;
use create::create_item_fingerprint;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, VecDeque},
    sync::atomic::AtomicUsize,
};
use zeroize::Zeroizing;

const ACCOUNT: &str = "account-1";
const USER: &str = "user-1";
const INCARNATION: &str = "incarnation-1";
const SERVER_URL: &str = "https://vault.example.test";
const START_MS: u64 = 1_700_000_000_000;
const FIRST_TOKEN: &str = "session-token-1";
const SECOND_TOKEN: &str = "session-token-2";

// ---------------------------------------------------------------- controllable Device time

struct TestClock(AtomicU64);

impl TestClock {
    fn new() -> Arc<Self> {
        Arc::new(Self(AtomicU64::new(START_MS)))
    }

    fn now(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }

    fn advance(&self, milliseconds: u64) {
        self.0.fetch_add(milliseconds, Ordering::SeqCst);
    }
}

impl Clock for TestClock {
    fn now_ms(&self) -> Result<u64, RuntimeError> {
        Ok(self.now())
    }
}

/// Records every delay the dispatcher asks for. Either time passes at once, or it never passes,
/// which is how a test freezes the Runtime between two durable states.
struct TestTimer {
    clock: Arc<TestClock>,
    requests: Mutex<Vec<u64>>,
    hold: AtomicBool,
    released: tokio::sync::Notify,
}

impl TestTimer {
    fn advancing(clock: Arc<TestClock>) -> Arc<Self> {
        Arc::new(Self {
            clock,
            requests: Mutex::new(Vec::new()),
            hold: AtomicBool::new(false),
            released: tokio::sync::Notify::new(),
        })
    }

    fn holding(clock: Arc<TestClock>) -> Arc<Self> {
        let timer = Self::advancing(clock);
        timer.hold.store(true, Ordering::SeqCst);
        timer
    }

    fn requested(&self) -> Vec<u64> {
        self.requests.lock().unwrap().clone()
    }
}

#[async_trait]
impl DeviceTimer for TestTimer {
    async fn sleep_ms(&self, milliseconds: u64) {
        self.requests.lock().unwrap().push(milliseconds);
        if self.hold.load(Ordering::SeqCst) {
            self.released.notified().await;
        } else {
            self.clock.advance(milliseconds);
        }
    }
}

// ---------------------------------------------------------------- the Device's local stores

struct MemoryPlatform {
    values: Mutex<BTreeMap<(String, String), String>>,
}

impl MemoryPlatform {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            values: Mutex::new(BTreeMap::new()),
        })
    }
}

#[async_trait]
impl crate::platform_storage::SerializedPlatformStorageExecutor for MemoryPlatform {
    async fn invoke(
        &self,
        request_json: Zeroizing<String>,
    ) -> Result<Zeroizing<String>, RuntimeError> {
        let request: Value = serde_json::from_str(&request_json).unwrap();
        let area = request["area"].as_str().unwrap().to_owned();
        let key = request["key"].as_str().unwrap().to_owned();
        Ok(Zeroizing::new(match request["type"].as_str().unwrap() {
            "get" => json!({
                "type": "value",
                "value": self.values.lock().unwrap().get(&(area, key)).cloned(),
            })
            .to_string(),
            "set" => {
                self.values
                    .lock()
                    .unwrap()
                    .insert((area, key), request["value"].as_str().unwrap().to_owned());
                json!({ "type": "done" }).to_string()
            }
            "delete" => {
                self.values.lock().unwrap().remove(&(area, key));
                json!({ "type": "done" }).to_string()
            }
            other => panic!("unexpected platform storage request {other}"),
        }))
    }
}

struct PlainReplica(InMemoryReplica);

#[async_trait]
impl SerializedReplicaExecutor for PlainReplica {
    async fn invoke(&self, request_json: String) -> Result<String, RuntimeError> {
        let request: ReplicaPersistenceRequest = serde_json::from_str(&request_json).unwrap();
        Ok(serde_json::to_string(&self.0.invoke(request).await?).unwrap())
    }
}

// ---------------------------------------------------------------- the fake Server

#[derive(Clone, Debug)]
struct RecordedRequest {
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl RecordedRequest {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(header, _)| header.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

#[derive(Clone, Copy)]
enum Fault {
    NetworkFailure,
    Status(u16),
}

#[derive(Clone)]
enum RefreshBehavior {
    Renews(&'static str),
    Unauthorized,
}

struct FakeServer {
    requests: Mutex<Vec<RecordedRequest>>,
    /// The Server's final-only Operation table, keyed the way the real one is keyed.
    outcomes: Mutex<BTreeMap<String, ([u8; 32], String)>>,
    /// Every Item row the Server actually created. This is the effect under test.
    created_items: Mutex<Vec<String>>,
    faults: Mutex<VecDeque<Fault>>,
    accepted_tokens: Mutex<Vec<String>>,
    refresh: Mutex<RefreshBehavior>,
    create_calls: AtomicUsize,
    refresh_calls: AtomicUsize,
}

impl FakeServer {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            requests: Mutex::new(Vec::new()),
            outcomes: Mutex::new(BTreeMap::new()),
            created_items: Mutex::new(Vec::new()),
            faults: Mutex::new(VecDeque::new()),
            accepted_tokens: Mutex::new(vec![FIRST_TOKEN.to_owned()]),
            refresh: Mutex::new(RefreshBehavior::Unauthorized),
            create_calls: AtomicUsize::new(0),
            refresh_calls: AtomicUsize::new(0),
        })
    }

    fn script(&self, faults: impl IntoIterator<Item = Fault>) {
        self.faults.lock().unwrap().extend(faults);
    }

    fn creates(&self) -> usize {
        self.create_calls.load(Ordering::SeqCst)
    }

    fn create_requests(&self) -> Vec<RecordedRequest> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|request| request.method == "PUT")
            .cloned()
            .collect()
    }

    fn created_items(&self) -> Vec<String> {
        self.created_items.lock().unwrap().clone()
    }

    fn handle_create(&self, request: &RecordedRequest) -> Value {
        self.create_calls.fetch_add(1, Ordering::SeqCst);
        let authorized = request.header("authorization").is_some_and(|value| {
            value.strip_prefix("Bearer ").is_some_and(|token| {
                self.accepted_tokens
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|accepted| accepted == token)
            })
        });
        if !authorized {
            return completed(401, b"{}".to_vec());
        }
        if let Some(fault) = self.faults.lock().unwrap().pop_front() {
            return match fault {
                Fault::NetworkFailure => json!({ "type": "networkFailure" }),
                Fault::Status(status) => completed(status, b"{}".to_vec()),
            };
        }
        let Some(operation_id) = request.header("idempotency-key") else {
            return completed(400, b"{}".to_vec());
        };
        let path = request.url.trim_start_matches(SERVER_URL);
        let segments: Vec<&str> = path.split('/').collect();
        let (vault_id, item_id) = (segments[4], segments[6]);
        let fingerprint = create_item_fingerprint(vault_id, item_id, &request.body).0;

        let mut outcomes = self.outcomes.lock().unwrap();
        if let Some((stored_fingerprint, stored_item)) = outcomes.get(operation_id) {
            if *stored_fingerprint != fingerprint {
                return completed(422, b"{}".to_vec());
            }
            // The retained outcome replays. No second Item row is ever written.
            return completed(200, applied_outcome(operation_id, stored_item));
        }
        self.created_items.lock().unwrap().push(item_id.to_owned());
        outcomes.insert(operation_id.to_owned(), (fingerprint, item_id.to_owned()));
        completed(200, applied_outcome(operation_id, item_id))
    }

    fn handle_refresh(&self, request: &RecordedRequest) -> Value {
        self.refresh_calls.fetch_add(1, Ordering::SeqCst);
        match self.refresh.lock().unwrap().clone() {
            RefreshBehavior::Unauthorized => completed(401, b"{}".to_vec()),
            RefreshBehavior::Renews(token) => {
                let _ = request;
                self.accepted_tokens.lock().unwrap().push(token.to_owned());
                completed(
                    200,
                    serde_json::to_vec(&json!({
                        "token": token,
                        "sessionId": "session-1",
                        "expiresAt": "2099-01-01T00:00:00Z",
                    }))
                    .unwrap(),
                )
            }
        }
    }
}

fn completed(status: u16, body: Vec<u8>) -> Value {
    json!({
        "type": "completed",
        "status": status,
        "headers": [{ "name": "content-type", "value": "application/json" }],
        "body": body,
    })
}

fn applied_outcome(operation_id: &str, item_id: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "operationId": operation_id,
        "kind": "create_item",
        "result": { "status": "applied", "itemId": item_id, "version": 1 },
    }))
    .unwrap()
}

#[async_trait]
impl crate::http_transport::SerializedHttpExecutor for FakeServer {
    async fn invoke(&self, request_json: String) -> Result<String, RuntimeError> {
        let value: Value = serde_json::from_str(&request_json).unwrap();
        let request = RecordedRequest {
            method: value["method"].as_str().unwrap().to_owned(),
            url: value["url"].as_str().unwrap().to_owned(),
            headers: value["headers"]
                .as_array()
                .unwrap()
                .iter()
                .map(|header| {
                    (
                        header["name"].as_str().unwrap().to_owned(),
                        header["value"].as_str().unwrap().to_owned(),
                    )
                })
                .collect(),
            body: value["body"]
                .as_array()
                .unwrap()
                .iter()
                .map(|byte| byte.as_u64().unwrap() as u8)
                .collect(),
        };
        self.requests.lock().unwrap().push(request.clone());
        let response = if request.url.ends_with("/api/v1/sessions/current/refresh") {
            self.handle_refresh(&request)
        } else if request.method == "PUT" {
            self.handle_create(&request)
        } else {
            panic!("unexpected route {} {}", request.method, request.url);
        };
        Ok(response.to_string())
    }

    fn cancel(&self, _dispatch_id: &str) {}
}

// ---------------------------------------------------------------- harness

struct Harness {
    runtime: Arc<Runtime>,
    account_id: AccountId,
    replica: Arc<PlainReplica>,
    platform: Arc<MemoryPlatform>,
    server: Arc<FakeServer>,
    clock: Arc<TestClock>,
    timer: Arc<TestTimer>,
}

fn auth_config() -> AuthClientConfig {
    AuthClientConfig::new(
        "client-1".to_owned(),
        ClientPlatform::Web,
        "1.0.0".to_owned(),
    )
    .unwrap()
}

async fn seeded(hold_time: bool) -> Harness {
    let state = InMemoryReplica::default();
    let account_id = AccountId::from(ACCOUNT);
    state
        .install(
            account_id.clone(),
            USER.to_owned(),
            Incarnation::from(INCARNATION),
        )
        .unwrap();
    seed_ready_personal_vault(&state, &account_id).unwrap();
    let replica = Arc::new(PlainReplica(state));
    let platform = MemoryPlatform::new();
    let server = FakeServer::new();
    let clock = TestClock::new();
    let timer = if hold_time {
        TestTimer::holding(clock.clone())
    } else {
        TestTimer::advancing(clock.clone())
    };
    let runtime = Runtime::with_test_dispatch_environment(
        replica.clone(),
        platform.clone(),
        server.clone(),
        auth_config(),
        clock.clone(),
        timer.clone(),
    );
    runtime.replica().load(&account_id).await.unwrap().unwrap();
    runtime.unlock_account(&account_id).await.unwrap();
    store_session(&runtime, &account_id, FIRST_TOKEN).await;
    Harness {
        runtime,
        account_id,
        replica,
        platform,
        server,
        clock,
        timer,
    }
}

async fn store_session(runtime: &Runtime, account_id: &AccountId, token: &str) {
    runtime
        .platform_storage
        .store_account_metadata(
            &AccountMetadataDocument::new(
                account_id.clone(),
                Incarnation::from(INCARNATION),
                USER.to_owned(),
                "user-1@example.com".to_owned(),
                "User One".to_owned(),
                SERVER_URL.to_owned(),
                None,
                None,
                "A3".to_owned(),
                START_MS,
                START_MS,
                false,
                false,
                bittery_crypto_core::current_kdf_profile(),
                None,
            )
            .unwrap(),
        )
        .await
        .unwrap();
    runtime
        .platform_storage
        .store_current_session(
            &CurrentSessionDocument::new(
                account_id.clone(),
                Incarnation::from(INCARNATION),
                token.to_owned(),
                Some("session-1".to_owned()),
                START_MS + 3_600_000,
                Some(START_MS + 3_600_000),
                Vec::new(),
                "encrypted-private-key".to_owned(),
            )
            .unwrap(),
        )
        .await
        .unwrap();
}

fn draft() -> LoginItemDraft {
    LoginItemDraft {
        title: "Bank".into(),
        url: Some("https://example.test".into()),
        urls: Vec::new(),
        username: Some("user".into()),
        password: Some("secret".into()),
        notes: None,
        note: None,
        custom_fields: Vec::new(),
        tags: Vec::new(),
    }
}

impl Harness {
    async fn accept_create(&self) -> (String, String) {
        match self
            .runtime
            .request(
                RuntimeRequest::CreateLoginItem {
                    account_id: self.account_id.clone(),
                    vault_id: TEST_VAULT_ID.to_owned(),
                    draft: draft(),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap()
        {
            RuntimeResponse::Accepted {
                operation_id,
                item_id,
                ..
            } => (operation_id, item_id),
            other => panic!("expected Accepted, got {other:?}"),
        }
    }

    fn operation(&self) -> Option<OperationRecord> {
        self.runtime
            .replica()
            .snapshot(&self.account_id)
            .unwrap()
            .operations
            .first()
            .cloned()
    }

    fn waiting_reason(&self) -> Option<AccountWaitingReason> {
        match self
            .runtime
            .projection(&ObservationRequest::RuntimeStatus {
                account_id: Some(self.account_id.clone()),
            })
            .unwrap()
            .projection
        {
            RuntimeProjection::RuntimeStatus(status) => status.accounts[0].waiting_reason,
            other => panic!("expected a RuntimeStatus projection, got {other:?}"),
        }
    }
}

/// Lets every other task run until the condition holds, without any wall-clock waiting.
async fn until(label: &str, mut condition: impl FnMut() -> bool) {
    for _ in 0..20_000 {
        if condition() {
            return;
        }
        tokio::task::yield_now().await;
    }
    panic!("{label} never happened");
}

/// Gives every other task a generous run of the scheduler without asserting anything.
async fn settle() {
    for _ in 0..2_000 {
        tokio::task::yield_now().await;
    }
}

// ---------------------------------------------------------------- the required behavior

#[tokio::test]
async fn an_operation_outlives_more_than_five_transient_failures_with_identical_bytes() {
    let harness = seeded(false).await;
    harness.server.script([
        Fault::NetworkFailure,
        Fault::Status(500),
        Fault::Status(502),
        Fault::NetworkFailure,
        Fault::Status(503),
        Fault::Status(429),
    ]);
    let (operation_id, item_id) = harness.accept_create().await;
    let accepted = harness.operation().unwrap();

    let dispatcher = tokio::spawn(Arc::clone(&harness.runtime).run_operation_dispatch());
    until("seven dispatch attempts", || harness.server.creates() >= 7).await;
    settle().await;

    // Six failures never ended the Operation, and the seventh attempt reached the Server.
    assert_eq!(harness.server.creates(), 7);
    assert_eq!(harness.server.created_items(), vec![item_id.clone()]);

    let requests = harness.server.create_requests();
    assert_eq!(requests.len(), 7);
    for request in &requests {
        // Identity and bytes are the same on every attempt. Nothing about a retry is new.
        assert_eq!(
            request.header("idempotency-key"),
            Some(operation_id.as_str())
        );
        assert_eq!(request.method, "PUT");
        assert_eq!(
            request.url,
            format!("{SERVER_URL}/api/v1/vaults/{TEST_VAULT_ID}/items/{item_id}")
        );
        assert_eq!(request.body, accepted.request.body);
        assert_eq!(request.header("content-type"), Some("application/json"));
        assert_eq!(
            request.header("authorization"),
            Some(format!("Bearer {FIRST_TOKEN}").as_str())
        );
    }

    // Bounded exponential backoff, and a count that only ever describes what happened.
    assert_eq!(
        harness.timer.requested(),
        vec![1_000, 2_000, 4_000, 8_000, 16_000, 32_000]
    );
    let after = harness.operation().expect("the Operation is still owed");
    assert_eq!(after.scheduling.attempt_count, 6);
    assert_eq!(after.operation_id, operation_id);
    assert_eq!(after.request, accepted.request);
    assert_eq!(after.request_fingerprint, accepted.request_fingerprint);

    harness.runtime.close().await;
    dispatcher.await.unwrap();
}

#[tokio::test]
async fn backoff_is_durable_and_is_honored_by_the_next_process() {
    let harness = seeded(true).await;
    harness.server.script([Fault::NetworkFailure]);
    let (operation_id, item_id) = harness.accept_create().await;

    let dispatcher = tokio::spawn(Arc::clone(&harness.runtime).run_operation_dispatch());
    until("one failed attempt and a persisted backoff", || {
        harness
            .operation()
            .is_some_and(|operation| operation.scheduling.attempt_count == 1)
    })
    .await;
    let parked = harness.operation().unwrap();
    assert_eq!(parked.scheduling.not_before_ms, START_MS + 1_000);
    harness.runtime.close().await;
    dispatcher.await.unwrap();

    // A new process reads the same durable rows. Backoff was never in memory.
    let clock = TestClock::new();
    clock.advance(400);
    let timer = TestTimer::holding(clock.clone());
    let restarted = Runtime::with_test_dispatch_environment(
        harness.replica.clone(),
        harness.platform.clone(),
        harness.server.clone(),
        auth_config(),
        clock.clone(),
        timer.clone(),
    );
    restarted
        .replica()
        .load(&harness.account_id)
        .await
        .unwrap()
        .unwrap();
    let restored = restarted
        .replica()
        .snapshot(&harness.account_id)
        .unwrap()
        .operations[0]
        .clone();
    assert_eq!(restored.scheduling.attempt_count, 1);
    assert_eq!(restored.scheduling.not_before_ms, START_MS + 1_000);
    assert_eq!(restored.operation_id, operation_id);

    let before = harness.server.creates();
    let dispatcher = tokio::spawn(Arc::clone(&restarted).run_operation_dispatch());
    until("the restart waits out the remaining backoff", || {
        !timer.requested().is_empty()
    })
    .await;
    settle().await;
    // It waited exactly the remainder, and sent nothing early.
    assert_eq!(timer.requested(), vec![600]);
    assert_eq!(harness.server.creates(), before);

    clock.advance(600);
    timer.hold.store(false, Ordering::SeqCst);
    timer.released.notify_waiters();
    until("the deferred attempt runs", || {
        harness.server.creates() == before + 1
    })
    .await;
    assert_eq!(harness.server.created_items(), vec![item_id]);
    restarted.close().await;
    dispatcher.await.unwrap();
}

#[tokio::test]
async fn a_lost_lease_duplicates_no_effect_and_loses_no_operation() {
    let harness = seeded(false).await;
    let (operation_id, item_id) = harness.accept_create().await;
    let accepted = harness.operation().unwrap();

    // The lease is an optimization with an expiry, so a stalled or dead holder cannot pin work.
    let held = harness
        .runtime
        .dispatch_leases
        .acquire(&operation_id, harness.clock.now())
        .expect("a free Operation leases");
    assert!(
        harness
            .runtime
            .dispatch_leases
            .acquire(&operation_id, harness.clock.now())
            .is_none(),
        "a live lease suppresses a second local send"
    );
    harness.clock.advance(dispatch::DISPATCH_LEASE_MS + 1);
    let stolen = harness
        .runtime
        .dispatch_leases
        .acquire(&operation_id, harness.clock.now())
        .expect("an expired lease is not a lock");
    // Losing the holder's guard, exactly as a dead process would, frees nothing and breaks nothing.
    std::mem::forget(held);
    drop(stolen);

    // Two senders now believe they own the same Operation. Correctness cannot depend on that.
    let first = harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id);
    let second = harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id);
    tokio::join!(first, second);

    assert_eq!(harness.server.creates(), 2);
    // One Operation ID and one fingerprint mean one Item row, whatever the local lease did.
    assert_eq!(harness.server.created_items(), vec![item_id]);
    let requests = harness.server.create_requests();
    assert_eq!(requests[0].body, requests[1].body);
    assert_eq!(
        requests[0].header("idempotency-key"),
        requests[1].header("idempotency-key")
    );

    // And the Operation is still owed: no transport answer removed it.
    let after = harness
        .operation()
        .expect("the Operation survived both sends");
    assert_eq!(after.operation_id, operation_id);
    assert_eq!(after.request, accepted.request);
}

#[tokio::test]
async fn a_renewable_session_error_refreshes_and_keeps_the_same_bytes() {
    let harness = seeded(false).await;
    *harness.server.refresh.lock().unwrap() = RefreshBehavior::Renews(SECOND_TOKEN);
    harness.server.accepted_tokens.lock().unwrap().clear();
    let (operation_id, item_id) = harness.accept_create().await;

    let dispatcher = tokio::spawn(Arc::clone(&harness.runtime).run_operation_dispatch());
    until("the Item is created after a Session renewal", || {
        !harness.server.created_items().is_empty()
    })
    .await;
    settle().await;

    assert_eq!(harness.server.refresh_calls.load(Ordering::SeqCst), 1);
    assert_eq!(harness.server.created_items(), vec![item_id]);
    let requests = harness.server.create_requests();
    // The credential changed between attempts; nothing else did.
    assert_eq!(
        requests[0].header("authorization"),
        Some(format!("Bearer {FIRST_TOKEN}").as_str())
    );
    assert_eq!(
        requests[1].header("authorization"),
        Some(format!("Bearer {SECOND_TOKEN}").as_str())
    );
    assert_eq!(requests[0].body, requests[1].body);
    assert_eq!(
        requests[0].header("idempotency-key"),
        Some(operation_id.as_str())
    );
    assert_eq!(
        requests[1].header("idempotency-key"),
        Some(operation_id.as_str())
    );

    harness.runtime.close().await;
    dispatcher.await.unwrap();
}

#[tokio::test]
async fn an_unrenewable_session_parks_the_operation_and_resumes_when_a_session_arrives() {
    let harness = seeded(false).await;
    harness.server.accepted_tokens.lock().unwrap().clear();
    let (_, item_id) = harness.accept_create().await;

    let dispatcher = tokio::spawn(Arc::clone(&harness.runtime).run_operation_dispatch());
    until("the Account reports it needs reauthentication", || {
        harness.waiting_reason() == Some(AccountWaitingReason::ReauthenticationRequired)
    })
    .await;

    // Parked is parked: no timer, no further sends, no busy loop.
    let creates = harness.server.creates();
    let refreshes = harness.server.refresh_calls.load(Ordering::SeqCst);
    settle().await;
    assert_eq!(harness.server.creates(), creates);
    assert_eq!(
        harness.server.refresh_calls.load(Ordering::SeqCst),
        refreshes
    );
    assert!(harness.timer.requested().is_empty());
    assert!(harness.operation().is_some(), "parking never discards work");

    // A Session arrives, and the same durable bytes go out again.
    harness
        .server
        .accepted_tokens
        .lock()
        .unwrap()
        .push(SECOND_TOKEN.to_owned());
    store_session(&harness.runtime, &harness.account_id, SECOND_TOKEN).await;
    harness.runtime.note_session_available(&harness.account_id);

    until("the parked Operation resumes", || {
        !harness.server.created_items().is_empty()
    })
    .await;
    assert_eq!(harness.server.created_items(), vec![item_id]);
    assert_eq!(harness.waiting_reason(), None);

    harness.runtime.close().await;
    dispatcher.await.unwrap();
}

#[tokio::test]
async fn an_http_success_is_not_local_completion() {
    let harness = seeded(false).await;
    let (operation_id, item_id) = harness.accept_create().await;
    let accepted = harness.operation().unwrap();

    let dispatcher = tokio::spawn(Arc::clone(&harness.runtime).run_operation_dispatch());
    until("the Server applied the create", || {
        !harness.server.created_items().is_empty()
    })
    .await;
    settle().await;

    // The Operation, its scheduling, and its encrypted overlay all survive a 2xx untouched.
    let after = harness
        .operation()
        .expect("only a semantic outcome may end an Operation");
    assert_eq!(after, accepted);
    let snapshot = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap();
    assert_eq!(snapshot.items.len(), 1);
    assert_eq!(snapshot.items[0].item_id, item_id);
    assert_eq!(snapshot.items[0].operation_id, operation_id);
    let projection = match harness
        .runtime
        .projection(&ObservationRequest::Items {
            account_id: harness.account_id.clone(),
        })
        .unwrap()
        .projection
    {
        RuntimeProjection::Items(items) => items,
        other => panic!("expected an Items projection, got {other:?}"),
    };
    assert_eq!(projection.items[0].status, ItemProjectionStatus::Pending);

    // And the Runtime stops re-sending bytes it already has an answer for.
    assert_eq!(harness.server.creates(), 1);

    harness.runtime.close().await;
    dispatcher.await.unwrap();
}

#[tokio::test]
async fn dispatch_attaches_only_what_the_durable_bytes_deliberately_omit() {
    let harness = seeded(false).await;
    let (operation_id, _) = harness.accept_create().await;
    let accepted = harness.operation().unwrap();
    assert_eq!(
        accepted.request.headers,
        vec![HttpHeader {
            name: "Content-Type".to_owned(),
            value: "application/json".to_owned(),
        }]
    );
    assert_eq!(accepted.request.method, HttpMethod::Put);

    let dispatcher = tokio::spawn(Arc::clone(&harness.runtime).run_operation_dispatch());
    until("one attempt", || harness.server.creates() == 1).await;
    let sent = harness.server.create_requests()[0].clone();

    let names: Vec<String> = sent
        .headers
        .iter()
        .map(|(name, _)| name.to_ascii_lowercase())
        .collect();
    assert_eq!(
        names,
        vec![
            "content-type",
            "idempotency-key",
            "bittery-client-id",
            "bittery-client-platform",
            "bittery-client-version",
            "authorization",
        ]
    );
    // The Operation ID is the wire idempotency key, exactly as the Server route requires.
    assert_eq!(sent.header("idempotency-key"), Some(operation_id.as_str()));
    assert_eq!(
        sent.header("authorization"),
        Some(format!("Bearer {FIRST_TOKEN}").as_str())
    );

    harness.runtime.close().await;
    dispatcher.await.unwrap();
}

#[tokio::test]
async fn rescheduling_can_never_move_an_accepted_operations_bytes() {
    let harness = seeded(false).await;
    let (operation_id, _) = harness.accept_create().await;
    let snapshot = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap();
    let mut tampered = snapshot.operations[0].clone();
    tampered.request.body.push(b' ');

    let error = harness
        .runtime
        .execute_plan(GuardedCommitPlan::new(
            harness.account_id.clone(),
            snapshot.incarnation.clone(),
            snapshot.revision,
            snapshot.lock_epoch,
            vec![PlanMutation::RescheduleOperation(tampered)],
        ))
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
    assert_eq!(
        harness.operation().unwrap().request,
        snapshot.operations[0].request
    );

    let unknown = crate::test_fixtures::test_operation("operation-unknown", "item-unknown");
    let error = harness
        .runtime
        .execute_plan(GuardedCommitPlan::new(
            harness.account_id.clone(),
            snapshot.incarnation,
            snapshot.revision,
            snapshot.lock_epoch,
            vec![PlanMutation::RescheduleOperation(unknown)],
        ))
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
    assert!(harness
        .operation()
        .is_some_and(|operation| operation.operation_id == operation_id));
}
