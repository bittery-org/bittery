//! One fake Device and one fake Server, shared by the dispatch and reconciliation slices.
//!
//! The Server here is deliberately not a stub. It keeps the same final-only
//! `(User, Operation ID)` outcome table the real Server keeps, recomputes the same
//! length-delimited fingerprint from the raw body it received, answers the same
//! `GET /operations/{id}` lookup after a lost response, and counts Item rows separately from
//! requests. That is what lets these tests assert *effects* rather than call counts.

use super::*;
use crate::{
    auth_http::{AuthClientConfig, ClientPlatform},
    authentication_installation::Clock,
    device_timer::DeviceTimer,
    platform_storage::{AccountMetadataDocument, CurrentSessionDocument},
    protocol::Incarnation,
    replica::{
        AuthorityItemCategory, AuthorityItemRecord, InMemoryReplica, OperationRecord,
        ReplicaPersistenceRequest, SerializedReplicaExecutor,
    },
    test_fixtures::{personal_vault, seed_ready_personal_vault, TEST_VAULT_ID, TEST_VAULT_KEY},
    LoginItemDraft,
};
use async_trait::async_trait;
use bittery_crypto_core::{encrypt_with_aad, AadContext};
use create::{create_item_fingerprint, item_operation_fingerprint, share_operation_fingerprint};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, VecDeque},
    sync::atomic::AtomicUsize,
};
use zeroize::Zeroizing;

pub(super) const ACCOUNT: &str = "account-1";
pub(super) const USER: &str = "user-1";
pub(super) const INCARNATION: &str = "incarnation-1";
pub(super) const SERVER_URL: &str = "https://vault.example.test";
pub(super) const START_MS: u64 = 1_700_000_000_000;
pub(super) const FIRST_TOKEN: &str = "session-token-1";
pub(super) const SECOND_TOKEN: &str = "session-token-2";

// ---------------------------------------------------------------- controllable Device time

pub(super) struct TestClock(pub(super) AtomicU64);

impl TestClock {
    pub(super) fn new() -> Arc<Self> {
        Arc::new(Self(AtomicU64::new(START_MS)))
    }

    pub(super) fn now(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }

    pub(super) fn advance(&self, milliseconds: u64) {
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
pub(super) struct TestTimer {
    pub(super) clock: Arc<TestClock>,
    pub(super) requests: Mutex<Vec<u64>>,
    pub(super) hold: AtomicBool,
    pub(super) released: tokio::sync::Notify,
}

impl TestTimer {
    pub(super) fn advancing(clock: Arc<TestClock>) -> Arc<Self> {
        Arc::new(Self {
            clock,
            requests: Mutex::new(Vec::new()),
            hold: AtomicBool::new(false),
            released: tokio::sync::Notify::new(),
        })
    }

    pub(super) fn holding(clock: Arc<TestClock>) -> Arc<Self> {
        let timer = Self::advancing(clock);
        timer.hold.store(true, Ordering::SeqCst);
        timer
    }

    pub(super) fn requested(&self) -> Vec<u64> {
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

pub(super) struct MemoryPlatform {
    pub(super) values: Mutex<BTreeMap<(String, String), String>>,
}

impl MemoryPlatform {
    pub(super) fn new() -> Arc<Self> {
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

pub(super) struct PlainReplica {
    pub(super) state: InMemoryReplica,
    /// Commits to reject before any durable write, so a test can prove all-or-nothing.
    pending_commit_failures: AtomicUsize,
    failed_commits: AtomicUsize,
}

impl PlainReplica {
    pub(super) fn new(state: InMemoryReplica) -> Arc<Self> {
        Arc::new(Self {
            state,
            pending_commit_failures: AtomicUsize::new(0),
            failed_commits: AtomicUsize::new(0),
        })
    }

    pub(super) fn fail_next_commits(&self, count: usize) {
        self.pending_commit_failures
            .fetch_add(count, Ordering::SeqCst);
    }

    pub(super) fn failed_commits(&self) -> usize {
        self.failed_commits.load(Ordering::SeqCst)
    }
}

#[async_trait]
impl SerializedReplicaExecutor for PlainReplica {
    async fn invoke(&self, request_json: String) -> Result<String, RuntimeError> {
        let request: ReplicaPersistenceRequest = serde_json::from_str(&request_json).unwrap();
        if matches!(request, ReplicaPersistenceRequest::Commit { .. })
            && self
                .pending_commit_failures
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |pending| {
                    pending.checked_sub(1)
                })
                .is_ok()
        {
            self.failed_commits.fetch_add(1, Ordering::SeqCst);
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "injected commit failure",
            ));
        }
        Ok(serde_json::to_string(&self.state.invoke(request).await?).unwrap())
    }
}

// ---------------------------------------------------------------- the fake Server

#[derive(Clone, Debug)]
pub(super) struct RecordedRequest {
    pub(super) method: String,
    pub(super) url: String,
    pub(super) headers: Vec<(String, String)>,
    pub(super) body: Vec<u8>,
}

impl RecordedRequest {
    pub(super) fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(header, _)| header.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

#[derive(Clone, Copy)]
pub(super) enum Fault {
    NetworkFailure,
    Status(u16),
}

#[derive(Clone)]
pub(super) enum RefreshBehavior {
    Renews(&'static str),
    Unauthorized,
}

/// What the Server retained for one `(User, Operation ID)`. Final only, exactly like the real row.
#[derive(Clone)]
pub(super) struct StoredOutcome {
    pub(super) fingerprint: [u8; 32],
    pub(super) result: StoredResult,
}

#[derive(Clone)]
pub(super) enum StoredResult {
    Applied {
        item_id: String,
        version: i32,
    },
    ShareApplied {
        share_link_id: String,
        base_share_url: String,
        expires_at: String,
    },
    ItemRejected {
        code: &'static str,
    },
    ExistingItemApplied {
        kind: &'static str,
        item_id: String,
        version: i32,
    },
    ExistingItemRejected {
        kind: &'static str,
        code: &'static str,
    },
    ShareRejected {
        code: &'static str,
    },
}

/// One Item row the Server actually holds, with the ciphertext the client sent it.
#[derive(Clone)]
pub(super) struct StoredItem {
    pub(super) id: String,
    pub(super) vault_id: String,
    pub(super) encrypted_data: String,
    pub(super) encryption_iv: String,
    pub(super) encryption_algorithm: String,
    pub(super) version: i32,
    pub(super) favorite: bool,
    pub(super) deleted_at: Option<String>,
}

pub(super) struct FakeServer {
    pub(super) requests: Mutex<Vec<RecordedRequest>>,
    /// The Server's final-only Operation table, keyed the way the real one is keyed.
    pub(super) outcomes: Mutex<BTreeMap<String, StoredOutcome>>,
    /// Every Item row the Server actually created. This is the effect under test.
    pub(super) created_items: Mutex<Vec<StoredItem>>,
    pub(super) faults: Mutex<VecDeque<Fault>>,
    /// Faults for the authoritative Item read, so reconciliation can fail after a real outcome.
    pub(super) item_faults: Mutex<VecDeque<Fault>>,
    /// Faults for the outcome lookup.
    pub(super) outcome_faults: Mutex<VecDeque<Fault>>,
    pub(super) mutation_response_overrides: Mutex<VecDeque<Vec<u8>>>,
    pub(super) lookup_response_overrides: Mutex<VecDeque<Vec<u8>>>,
    /// Rejection codes the Server answers instead of applying, one per create.
    pub(super) rejections: Mutex<VecDeque<&'static str>>,
    /// Drops the create response *after* the Server committed, which is response loss.
    pub(super) lose_responses: AtomicUsize,
    pub(super) accepted_tokens: Mutex<Vec<String>>,
    pub(super) refresh: Mutex<RefreshBehavior>,
    pub(super) create_calls: AtomicUsize,
    pub(super) share_calls: AtomicUsize,
    pub(super) created_share_links: Mutex<Vec<String>>,
    pub(super) refresh_calls: AtomicUsize,
    pub(super) item_calls: AtomicUsize,
    pub(super) outcome_calls: AtomicUsize,
    /// What `GET /sync/changes` answers: events plus the exact Cursor they end at.
    pub(super) sync_events: Mutex<Vec<Value>>,
    pub(super) sync_cursor: Mutex<Option<String>>,
    /// Explicit consecutive pages, for exercising the real `hasMore` continuation contract.
    pub(super) sync_pages: Mutex<VecDeque<Value>>,
}

impl FakeServer {
    pub(super) fn new() -> Arc<Self> {
        Arc::new(Self {
            requests: Mutex::new(Vec::new()),
            outcomes: Mutex::new(BTreeMap::new()),
            created_items: Mutex::new(Vec::new()),
            faults: Mutex::new(VecDeque::new()),
            item_faults: Mutex::new(VecDeque::new()),
            outcome_faults: Mutex::new(VecDeque::new()),
            mutation_response_overrides: Mutex::new(VecDeque::new()),
            lookup_response_overrides: Mutex::new(VecDeque::new()),
            rejections: Mutex::new(VecDeque::new()),
            lose_responses: AtomicUsize::new(0),
            accepted_tokens: Mutex::new(vec![FIRST_TOKEN.to_owned()]),
            refresh: Mutex::new(RefreshBehavior::Unauthorized),
            create_calls: AtomicUsize::new(0),
            share_calls: AtomicUsize::new(0),
            created_share_links: Mutex::new(Vec::new()),
            refresh_calls: AtomicUsize::new(0),
            item_calls: AtomicUsize::new(0),
            outcome_calls: AtomicUsize::new(0),
            sync_events: Mutex::new(Vec::new()),
            sync_cursor: Mutex::new(None),
            sync_pages: Mutex::new(VecDeque::new()),
        })
    }

    pub(super) fn script(&self, faults: impl IntoIterator<Item = Fault>) {
        self.faults.lock().unwrap().extend(faults);
    }

    pub(super) fn script_item_faults(&self, faults: impl IntoIterator<Item = Fault>) {
        self.item_faults.lock().unwrap().extend(faults);
    }

    pub(super) fn reject_next(&self, code: &'static str) {
        self.rejections.lock().unwrap().push_back(code);
    }

    pub(super) fn answer_next_mutation_with(&self, body: Vec<u8>) {
        self.mutation_response_overrides
            .lock()
            .unwrap()
            .push_back(body);
    }

    pub(super) fn answer_next_lookup_with(&self, body: Vec<u8>) {
        self.lookup_response_overrides
            .lock()
            .unwrap()
            .push_back(body);
    }

    /// The Server commits, and the client never sees the answer.
    pub(super) fn lose_next_response(&self) {
        self.lose_responses.fetch_add(1, Ordering::SeqCst);
    }

    pub(super) fn creates(&self) -> usize {
        self.create_calls.load(Ordering::SeqCst)
    }

    pub(super) fn shares(&self) -> usize {
        self.share_calls.load(Ordering::SeqCst)
    }

    pub(super) fn outcome_lookups(&self) -> usize {
        self.outcome_calls.load(Ordering::SeqCst)
    }

    pub(super) fn create_requests(&self) -> Vec<RecordedRequest> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|request| request.method == "PUT")
            .cloned()
            .collect()
    }

    pub(super) fn existing_item_mutation_requests(&self) -> Vec<RecordedRequest> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|request| {
                request.url.contains("/api/v1/items/item-existing")
                    && request.method != "GET"
                    && !request.url.ends_with("/share-links")
            })
            .cloned()
            .collect()
    }

    pub(super) fn created_items(&self) -> Vec<String> {
        self.created_items
            .lock()
            .unwrap()
            .iter()
            .map(|item| item.id.clone())
            .collect()
    }

    pub(super) fn authorized(&self, request: &RecordedRequest) -> bool {
        request.header("authorization").is_some_and(|value| {
            value.strip_prefix("Bearer ").is_some_and(|token| {
                self.accepted_tokens
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|accepted| accepted == token)
            })
        })
    }

    pub(super) fn handle_create(&self, request: &RecordedRequest) -> Value {
        self.create_calls.fetch_add(1, Ordering::SeqCst);
        if !self.authorized(request) {
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
        if let Some(stored) = outcomes.get(operation_id) {
            if stored.fingerprint != fingerprint {
                // The same Operation ID with other bytes is identity reuse, never a replay.
                return completed(
                    422,
                    serde_json::to_vec(&json!({
                        "type": "about:blank",
                        "title": "Unprocessable Entity",
                        "status": 422,
                        "code": "OPERATION_ID_REUSED",
                    }))
                    .unwrap(),
                );
            }
            // The retained outcome replays. No second Item row is ever written.
            return completed(200, outcome_body(operation_id, &stored.result));
        }
        let result = match self.rejections.lock().unwrap().pop_front() {
            Some(code) => StoredResult::ItemRejected { code },
            None => {
                let body: Value = serde_json::from_slice(&request.body).unwrap();
                self.created_items.lock().unwrap().push(StoredItem {
                    id: item_id.to_owned(),
                    vault_id: vault_id.to_owned(),
                    encrypted_data: body["encryptedData"].as_str().unwrap().to_owned(),
                    encryption_iv: body["encryptionIv"].as_str().unwrap().to_owned(),
                    encryption_algorithm: body["encryptionAlgorithm"].as_str().unwrap().to_owned(),
                    version: 1,
                    favorite: false,
                    deleted_at: None,
                });
                StoredResult::Applied {
                    item_id: item_id.to_owned(),
                    version: 1,
                }
            }
        };
        outcomes.insert(
            operation_id.to_owned(),
            StoredOutcome {
                fingerprint,
                result: result.clone(),
            },
        );
        drop(outcomes);
        if self
            .lose_responses
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |pending| {
                pending.checked_sub(1)
            })
            .is_ok()
        {
            // Committed on the Server, never seen by the client.
            return json!({ "type": "networkFailure" });
        }
        completed(200, outcome_body(operation_id, &result))
    }

    pub(super) fn handle_share(&self, request: &RecordedRequest) -> Value {
        self.share_calls.fetch_add(1, Ordering::SeqCst);
        if !self.authorized(request) {
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
        let item_id = request
            .url
            .trim_end_matches("/share-links")
            .rsplit('/')
            .next()
            .unwrap();
        let fingerprint = share_operation_fingerprint(item_id, &request.body).0;
        let mut outcomes = self.outcomes.lock().unwrap();
        if let Some(stored) = outcomes.get(operation_id) {
            if stored.fingerprint != fingerprint {
                return completed(
                    422,
                    serde_json::to_vec(&json!({
                        "type": "about:blank",
                        "title": "Unprocessable Entity",
                        "status": 422,
                        "code": "OPERATION_ID_REUSED",
                    }))
                    .unwrap(),
                );
            }
            return completed(200, outcome_body(operation_id, &stored.result));
        }
        let body: Value = serde_json::from_slice(&request.body).unwrap();
        assert!(body["tokenHash"].as_str().is_some());
        assert!(body.get("token").is_none());
        let result = match self.rejections.lock().unwrap().pop_front() {
            Some(code) => StoredResult::ShareRejected { code },
            None => {
                let share_link_id = format!(
                    "share-link-{}",
                    self.created_share_links.lock().unwrap().len() + 1
                );
                self.created_share_links
                    .lock()
                    .unwrap()
                    .push(share_link_id.clone());
                StoredResult::ShareApplied {
                    share_link_id,
                    base_share_url: "https://app.example.test/share/".into(),
                    expires_at: "2099-01-02T03:04:05Z".into(),
                }
            }
        };
        outcomes.insert(
            operation_id.to_owned(),
            StoredOutcome {
                fingerprint,
                result: result.clone(),
            },
        );
        drop(outcomes);
        if self
            .lose_responses
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |pending| {
                pending.checked_sub(1)
            })
            .is_ok()
        {
            return json!({ "type": "networkFailure" });
        }
        completed(200, outcome_body(operation_id, &result))
    }

    pub(super) fn handle_existing_item_mutation(&self, request: &RecordedRequest) -> Value {
        if !self.authorized(request) {
            return completed(401, b"{}".to_vec());
        }
        if let Some(fault) = self.faults.lock().unwrap().pop_front() {
            return match fault {
                Fault::NetworkFailure => json!({ "type": "networkFailure" }),
                Fault::Status(status) => completed(status, b"{}".to_vec()),
            };
        }
        if let Some(body) = self.mutation_response_overrides.lock().unwrap().pop_front() {
            return completed(200, body);
        }
        let Some(operation_id) = request.header("idempotency-key") else {
            return completed(400, b"{}".to_vec());
        };
        let Some(expected_version) = request
            .header("if-match")
            .and_then(|value| value.trim_matches('"').parse::<i32>().ok())
        else {
            return completed(428, b"{}".to_vec());
        };
        let path = request.url.trim_start_matches(SERVER_URL);
        let (kind, operation_kind, route) = match (request.method.as_str(), path) {
            ("PATCH", "/api/v1/items/item-existing") => (
                "update_item",
                crate::replica::OperationKind::UpdateItem,
                "PATCH /api/v1/items/{itemId}",
            ),
            ("PATCH", "/api/v1/items/item-existing/favorite") => (
                "set_item_favorite",
                crate::replica::OperationKind::SetItemFavorite,
                "PATCH /api/v1/items/{itemId}/favorite",
            ),
            ("DELETE", "/api/v1/items/item-existing") => (
                "trash_item",
                crate::replica::OperationKind::TrashItem,
                "DELETE /api/v1/items/{itemId}",
            ),
            ("POST", "/api/v1/items/item-existing/restore") => (
                "restore_item",
                crate::replica::OperationKind::RestoreItem,
                "POST /api/v1/items/{itemId}/restore",
            ),
            ("POST", "/api/v1/items/item-existing/moves") => (
                "move_item",
                crate::replica::OperationKind::MoveItem,
                "POST /api/v1/items/{itemId}/moves",
            ),
            ("DELETE", "/api/v1/items/item-existing/permanent") => (
                "permanently_delete_item",
                crate::replica::OperationKind::PermanentlyDeleteItem,
                "DELETE /api/v1/items/{itemId}/permanent",
            ),
            _ => return completed(404, b"{}".to_vec()),
        };
        let fingerprint = item_operation_fingerprint(
            operation_kind,
            route,
            "item-existing",
            &request.body,
            expected_version,
        )
        .0;
        let mut outcomes = self.outcomes.lock().unwrap();
        if let Some(stored) = outcomes.get(operation_id) {
            if stored.fingerprint != fingerprint {
                return completed(
                    422,
                    serde_json::to_vec(&json!({
                        "type": "about:blank",
                        "title": "Unprocessable Entity",
                        "status": 422,
                        "code": "OPERATION_ID_REUSED",
                    }))
                    .unwrap(),
                );
            }
            return completed(200, outcome_body(operation_id, &stored.result));
        }
        let result = if let Some(code) = self.rejections.lock().unwrap().pop_front() {
            StoredResult::ExistingItemRejected { kind, code }
        } else {
            let mut items = self.created_items.lock().unwrap();
            let position = items.iter().position(|item| item.id == "item-existing");
            let Some(position) = position else {
                return completed(500, b"{}".to_vec());
            };
            let next_version = expected_version + 1;
            if operation_kind == crate::replica::OperationKind::PermanentlyDeleteItem {
                items.remove(position);
            } else {
                let item = &mut items[position];
                let body: Value = serde_json::from_slice(&request.body).unwrap_or(Value::Null);
                match operation_kind {
                    crate::replica::OperationKind::UpdateItem => {
                        item.encrypted_data = body["encryptedData"].as_str().unwrap().to_owned();
                        item.encryption_iv = body["encryptionIv"].as_str().unwrap().to_owned();
                        item.encryption_algorithm =
                            body["encryptionAlgorithm"].as_str().unwrap().to_owned();
                    }
                    crate::replica::OperationKind::SetItemFavorite => {
                        item.favorite = body["favorite"].as_bool().unwrap();
                    }
                    crate::replica::OperationKind::TrashItem => {
                        item.deleted_at = Some("2026-08-28T00:00:00Z".into());
                    }
                    crate::replica::OperationKind::RestoreItem => item.deleted_at = None,
                    crate::replica::OperationKind::MoveItem => {
                        item.vault_id = body["targetVaultId"].as_str().unwrap().to_owned();
                        item.encrypted_data = body["encryptedData"].as_str().unwrap().to_owned();
                        item.encryption_iv = body["encryptionIv"].as_str().unwrap().to_owned();
                        item.encryption_algorithm =
                            body["encryptionAlgorithm"].as_str().unwrap().to_owned();
                    }
                    _ => {}
                }
                item.version = next_version;
            }
            StoredResult::ExistingItemApplied {
                kind,
                item_id: "item-existing".into(),
                version: next_version,
            }
        };
        outcomes.insert(
            operation_id.to_owned(),
            StoredOutcome {
                fingerprint,
                result: result.clone(),
            },
        );
        drop(outcomes);
        if self
            .lose_responses
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |pending| {
                pending.checked_sub(1)
            })
            .is_ok()
        {
            return json!({ "type": "networkFailure" });
        }
        completed(200, outcome_body(operation_id, &result))
    }

    /// `GET /api/v1/operations/{operationId}`: the retained outcome, after a lost response.
    pub(super) fn handle_outcome_lookup(&self, request: &RecordedRequest) -> Value {
        self.outcome_calls.fetch_add(1, Ordering::SeqCst);
        if !self.authorized(request) {
            return completed(401, b"{}".to_vec());
        }
        if let Some(fault) = self.outcome_faults.lock().unwrap().pop_front() {
            return match fault {
                Fault::NetworkFailure => json!({ "type": "networkFailure" }),
                Fault::Status(status) => completed(status, b"{}".to_vec()),
            };
        }
        if let Some(body) = self.lookup_response_overrides.lock().unwrap().pop_front() {
            return completed(200, body);
        }
        let operation_id = request.url.rsplit('/').next().unwrap();
        match self.outcomes.lock().unwrap().get(operation_id) {
            Some(stored) => completed(200, outcome_body(operation_id, &stored.result)),
            None => completed(404, b"{}".to_vec()),
        }
    }

    /// `GET /api/v1/items/{itemId}`: the authoritative encrypted Item.
    pub(super) fn handle_item(&self, request: &RecordedRequest) -> Value {
        self.item_calls.fetch_add(1, Ordering::SeqCst);
        if !self.authorized(request) {
            return completed(401, b"{}".to_vec());
        }
        if let Some(fault) = self.item_faults.lock().unwrap().pop_front() {
            return match fault {
                Fault::NetworkFailure => json!({ "type": "networkFailure" }),
                Fault::Status(status) => completed(status, b"{}".to_vec()),
            };
        }
        let item_id = request.url.rsplit('/').next().unwrap();
        let stored = self
            .created_items
            .lock()
            .unwrap()
            .iter()
            .find(|item| item.id == item_id)
            .cloned();
        match stored {
            Some(item) => completed(200, item_body(&item)),
            None => completed(404, b"{}".to_vec()),
        }
    }

    /// Publishes the `operation_resolved` event the real Server writes in the same transaction.
    pub(super) fn script_operation_event(&self, operation_id: &str, cursor: &str) {
        self.sync_events.lock().unwrap().push(json!({
            "id": cursor,
            "type": "operation_resolved",
            "entityType": "operation",
            "entityId": operation_id,
            "userId": USER,
            "vaultId": null,
            "clientId": null,
            "metadata": null,
            "timestamp": "1700000000000",
            "version": 1,
        }));
        *self.sync_cursor.lock().unwrap() = Some(cursor.to_owned());
    }

    pub(super) fn script_sync_page(&self, events: Vec<Value>, cursor: &str, has_more: bool) {
        self.sync_pages.lock().unwrap().push_back(json!({
            "events": events,
            "cursor": { "id": cursor },
            "hasMore": has_more,
            "requiresFullRefresh": false,
        }));
    }

    pub(super) fn handle_sync_changes(&self, request: &RecordedRequest) -> Value {
        if !self.authorized(request) {
            return completed(401, b"{}".to_vec());
        }
        if let Some(page) = self.sync_pages.lock().unwrap().pop_front() {
            return completed(200, serde_json::to_vec(&page).unwrap());
        }
        let events = self.sync_events.lock().unwrap().clone();
        let cursor = self
            .sync_cursor
            .lock()
            .unwrap()
            .clone()
            .map(|id| json!({ "id": id }));
        completed(
            200,
            serde_json::to_vec(&json!({
                "events": events,
                "cursor": cursor,
                "hasMore": false,
                "requiresFullRefresh": false,
            }))
            .unwrap(),
        )
    }

    pub(super) fn handle_refresh(&self, request: &RecordedRequest) -> Value {
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

pub(super) fn completed(status: u16, body: Vec<u8>) -> Value {
    json!({
        "type": "completed",
        "status": status,
        "headers": [{ "name": "content-type", "value": "application/json" }],
        "body": body,
    })
}

pub(super) fn outcome_body(operation_id: &str, result: &StoredResult) -> Vec<u8> {
    let (kind, result) = match result {
        StoredResult::Applied { item_id, version } => (
            "create_item",
            json!({ "status": "applied", "itemId": item_id, "version": version }),
        ),
        StoredResult::ShareApplied {
            share_link_id,
            base_share_url,
            expires_at,
        } => (
            "create_share",
            json!({
                "status": "applied",
                "shareLinkId": share_link_id,
                "baseShareUrl": base_share_url,
                "expiresAt": expires_at,
            }),
        ),
        StoredResult::ItemRejected { code } => {
            ("create_item", json!({ "status": "rejected", "code": code }))
        }
        StoredResult::ExistingItemApplied {
            kind,
            item_id,
            version,
        } => (
            *kind,
            json!({ "status": "applied", "itemId": item_id, "version": version }),
        ),
        StoredResult::ExistingItemRejected { kind, code } => {
            (*kind, json!({ "status": "rejected", "code": code }))
        }
        StoredResult::ShareRejected { code } => (
            "create_share",
            json!({ "status": "rejected", "code": code }),
        ),
    };
    serde_json::to_vec(&json!({
        "operationId": operation_id,
        "kind": kind,
        "result": result,
    }))
    .unwrap()
}

pub(super) fn item_body(item: &StoredItem) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "id": item.id,
        "vaultId": item.vault_id,
        "category": "login",
        "favorite": item.favorite,
        "encryptedData": item.encrypted_data,
        "encryptionIv": item.encryption_iv,
        "encryptionAlgorithm": item.encryption_algorithm,
        "encryptionVersion": 1,
        "version": item.version,
        "encryptedByUserId": USER,
        "lastModifiedBy": USER,
        "createdAt": "2026-08-24T00:00:00Z",
        "updatedAt": "2026-08-24T00:00:00Z",
        "deletedAt": item.deleted_at,
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
        } else if request.method == "POST" && request.url.ends_with("/share-links") {
            self.handle_share(&request)
        } else if request.method != "GET" && request.url.contains("/api/v1/items/item-existing") {
            self.handle_existing_item_mutation(&request)
        } else if request.method == "GET" && request.url.contains("/api/v1/sync/changes") {
            self.handle_sync_changes(&request)
        } else if request.method == "GET" && request.url.contains("/api/v1/sync/events") {
            // The SSE hint is only a wake-up. A non-200 is a normal, silent answer.
            completed(204, Vec::new())
        } else if request.method == "GET" && request.url.contains("/api/v1/operations/") {
            self.handle_outcome_lookup(&request)
        } else if request.method == "GET" && request.url.contains("/api/v1/items/") {
            self.handle_item(&request)
        } else {
            panic!("unexpected route {} {}", request.method, request.url);
        };
        Ok(response.to_string())
    }

    fn cancel(&self, _dispatch_id: &str) {}
}

// ---------------------------------------------------------------- harness

pub(super) struct Harness {
    pub(super) runtime: Arc<Runtime>,
    pub(super) account_id: AccountId,
    pub(super) replica: Arc<PlainReplica>,
    pub(super) platform: Arc<MemoryPlatform>,
    pub(super) server: Arc<FakeServer>,
    pub(super) clock: Arc<TestClock>,
    pub(super) timer: Arc<TestTimer>,
}

pub(super) fn auth_config() -> AuthClientConfig {
    AuthClientConfig::new(
        "client-1".to_owned(),
        ClientPlatform::Web,
        "1.0.0".to_owned(),
    )
    .unwrap()
}

pub(super) async fn seeded(hold_time: bool) -> Harness {
    seeded_inner(hold_time, SeedAuthority::Empty).await
}

pub(super) async fn seeded_with_share_item(hold_time: bool) -> Harness {
    seeded_inner(
        hold_time,
        SeedAuthority::ExistingItem {
            deleted: false,
            include_target_vault: false,
        },
    )
    .await
}

pub(super) async fn seeded_with_existing_item(hold_time: bool, deleted: bool) -> Harness {
    seeded_inner(
        hold_time,
        SeedAuthority::ExistingItem {
            deleted,
            include_target_vault: true,
        },
    )
    .await
}

enum SeedAuthority {
    Empty,
    ExistingItem {
        deleted: bool,
        include_target_vault: bool,
    },
}

async fn seeded_inner(hold_time: bool, authority: SeedAuthority) -> Harness {
    let state = InMemoryReplica::default();
    let account_id = AccountId::from(ACCOUNT);
    state
        .install(
            account_id.clone(),
            USER.to_owned(),
            Incarnation::from(INCARNATION),
        )
        .unwrap();
    match authority {
        SeedAuthority::Empty => seed_ready_personal_vault(&state, &account_id).unwrap(),
        SeedAuthority::ExistingItem {
            deleted,
            include_target_vault,
        } => {
            let sealed = encrypt_with_aad(
                &serde_json::to_string(&draft()).unwrap(),
                &TEST_VAULT_KEY,
                &AadContext {
                    vault_id: TEST_VAULT_ID.into(),
                    entity_id: "item-existing".into(),
                    entity_type: "item".into(),
                    version: 1,
                    user_id: USER.into(),
                },
            )
            .unwrap();
            let mut vaults = vec![personal_vault(TEST_VAULT_ID, USER)];
            if include_target_vault {
                vaults.push(personal_vault("vault-2", USER));
            }
            state
                .seed_ready_authority(
                    &account_id,
                    vaults,
                    vec![AuthorityItemRecord {
                        id: "item-existing".into(),
                        vault_id: TEST_VAULT_ID.into(),
                        category: AuthorityItemCategory::Login,
                        favorite: false,
                        encrypted_data: sealed.ciphertext,
                        encryption_iv: sealed.iv,
                        encryption_algorithm: sealed.algorithm,
                        version: 1,
                        encryption_version: 1,
                        encrypted_by_user_id: USER.into(),
                        last_modified_by: USER.into(),
                        created_at: "2026-08-23T00:00:00Z".into(),
                        updated_at: "2026-08-23T00:00:00Z".into(),
                        deleted_at: deleted.then(|| "2026-08-24T00:00:00Z".into()),
                        attachments: Vec::new(),
                    }],
                )
                .unwrap();
        }
    }
    let seeded_server_items = state
        .snapshot(&account_id)
        .unwrap()
        .bootstrap
        .snapshot()
        .visible_items
        .into_iter()
        .map(|item| StoredItem {
            id: item.id,
            vault_id: item.vault_id,
            encrypted_data: item.encrypted_data,
            encryption_iv: item.encryption_iv,
            encryption_algorithm: item.encryption_algorithm,
            version: item.version,
            favorite: item.favorite,
            deleted_at: item.deleted_at,
        })
        .collect();
    let replica = PlainReplica::new(state);
    let platform = MemoryPlatform::new();
    let server = FakeServer::new();
    *server.created_items.lock().unwrap() = seeded_server_items;
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

pub(super) async fn store_session(runtime: &Runtime, account_id: &AccountId, token: &str) {
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

pub(super) fn draft() -> LoginItemDraft {
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
    pub(super) async fn accept_create(&self) -> (String, String) {
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

    pub(super) async fn accept_existing(&self, request: RuntimeRequest) -> (String, String) {
        match self
            .runtime
            .request(request, RequestCancellation::new())
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

    pub(super) fn operation(&self) -> Option<OperationRecord> {
        self.runtime
            .replica()
            .snapshot(&self.account_id)
            .unwrap()
            .operations
            .first()
            .cloned()
    }

    pub(super) fn waiting_reason(&self) -> Option<AccountWaitingReason> {
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
pub(super) async fn until(label: &str, mut condition: impl FnMut() -> bool) {
    for _ in 0..20_000 {
        if condition() {
            return;
        }
        tokio::task::yield_now().await;
    }
    panic!("{label} never happened");
}

/// Gives every other task a generous run of the scheduler without asserting anything.
pub(super) async fn settle() {
    for _ in 0..2_000 {
        tokio::task::yield_now().await;
    }
}
