use super::{operation_fixtures::*, outcome::CompletionResult, *};
use crate::test_fixtures::TEST_VAULT_ID;
use crate::{
    http_transport::SerializedHttpExecutor,
    replica::{
        AbandonBootstrapPlan, BeginBootstrapPlan, BootstrapGenerationId, BootstrapGuard,
        MarkRefreshRequiredPlan, ReplicaState, SyncCursor,
    },
};
use async_trait::async_trait;
use base64::Engine as _;
use serde_json::{json, Value};
use std::{collections::VecDeque, sync::atomic::AtomicUsize};
use tokio::sync::{mpsc, Mutex as AsyncMutex, Semaphore};

type ReadQueue = Arc<AsyncMutex<mpsc::UnboundedReceiver<Value>>>;
struct StreamSlot {
    sender: mpsc::UnboundedSender<Value>,
    receiver: ReadQueue,
}
struct SyncServer {
    rotation_clock: Arc<TestClock>,
    finite: Arc<FakeServer>,
    streams: Mutex<HashMap<String, StreamSlot>>,
    opens: Mutex<Vec<Value>>,
    statuses: Mutex<VecDeque<u16>>,
    opened: Semaphore,
    changes: Semaphore,
    cancelled: Mutex<Vec<String>>,
    authority_overrides: Mutex<VecDeque<Value>>,
    bootstrap_pages: Mutex<VecDeque<Value>>,
    bootstrap_hold: Mutex<Option<Arc<BootstrapReadGate>>>,
    bootstrap_reads: AtomicUsize,
    stream_reads: AtomicUsize,
    stream_open_release: Mutex<Option<Arc<Semaphore>>>,
    policy_read: Mutex<Option<Arc<PolicyReadGate>>>,
    policy_settings_response: Mutex<Option<Value>>,
    policy_settings_hold: Mutex<Option<Arc<PolicyReadGate>>>,
    policy_settings_requests: Mutex<Vec<Value>>,
    rotation: Mutex<Option<RotationScript>>,
    rotation_finalize_hold: Mutex<Option<Arc<BootstrapReadGate>>>,
    rotation_stage_hold: Mutex<Option<Arc<BootstrapReadGate>>>,
    rotation_post_stage_live_hold: Mutex<Option<Arc<BootstrapReadGate>>>,
    rotation_abandon_hold: Mutex<Option<Arc<BootstrapReadGate>>>,
    rotation_abandon_dispatches: Mutex<Vec<String>>,
    rotation_abandon_cancellations: Mutex<Vec<String>>,
}
struct RotationScript {
    team_id: String,
    start_result: Value,
    finalize_result: Value,
    retained: HashMap<String, Value>,
    requests: Vec<Value>,
    start_sends: usize,
    finalize_sends: usize,
    lose_start: bool,
    lose_finalize: bool,
    staged: Vec<Value>,
    abandoned: Vec<Value>,
    item_payload: Option<Value>,
    attachment_payload: Option<Value>,
    lose_stage_once: bool,
    member_role: String,
    initiator_live_role: String,
    extra_plan_member_role: Option<String>,
    extra_live_member_role: Option<String>,
    unexpected_live_member: bool,
    live_members_paginated: bool,
}
struct PolicyReadGate {
    entered: Semaphore,
    release: Semaphore,
    response: Value,
}
struct BootstrapReadGate {
    entered: Semaphore,
    release: Semaphore,
}

impl SyncServer {
    fn send(&self, value: Value) {
        for slot in self.streams.lock().unwrap().values() {
            slot.sender.send(value.clone()).unwrap();
        }
    }
    fn hint(&self, value: &[u8]) {
        self.send(json!({"type":"chunk","bytes":value}));
    }
    fn change(&self, deleted: bool, cursor: &str) {
        if deleted {
            self.finite.created_items.lock().unwrap().clear();
        } else {
            let mut items = self.finite.created_items.lock().unwrap();
            items[0].favorite = true;
            items[0].version = 2;
        }
        self.finite.script_sync_page(vec![json!({
            "id":cursor,"type":if deleted {"item_permanently_deleted"} else {"item_updated"},
            "entityType":"item","entityId":"item-existing","userId":USER,"vaultId":TEST_VAULT_ID,
            "clientId":null,"metadata":null,"timestamp":"1700000000000","version":2
        })], cursor, false);
    }
}
#[async_trait]
impl SerializedHttpExecutor for SyncServer {
    async fn invoke(&self, text: zeroize::Zeroizing<String>) -> Result<String, RuntimeError> {
        let value: Value = serde_json::from_str(&text).unwrap();
        if value["url"]
            .as_str()
            .is_some_and(|url| url.ends_with("/leave-rotation-plans/finalize"))
        {
            let held = self.rotation_finalize_hold.lock().unwrap().clone();
            if let Some(held) = held {
                held.entered.add_permits(1);
                held.release.acquire().await.unwrap().forget();
            }
        }
        if value["url"]
            .as_str()
            .is_some_and(|url| url.contains("/staged/"))
        {
            let held = self.rotation_stage_hold.lock().unwrap().clone();
            if let Some(held) = held {
                held.entered.add_permits(1);
                held.release.acquire().await.unwrap().forget();
            }
        }
        if value["url"]
            .as_str()
            .is_some_and(|url| url.contains(&format!("/api/v1/vaults/{TEST_VAULT_ID}/members")))
            && self
                .rotation
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|script| script.staged.len() == 2)
        {
            let held = self.rotation_post_stage_live_hold.lock().unwrap().clone();
            if let Some(held) = held {
                held.entered.add_permits(1);
                held.release.acquire().await.unwrap().forget();
            }
        }
        if value["url"]
            .as_str()
            .is_some_and(|url| url.ends_with("/api/v1/vault-key-rotation-plans/private-plan"))
            && value["method"] == "DELETE"
        {
            self.rotation_abandon_dispatches
                .lock()
                .unwrap()
                .push(value["dispatchId"].as_str().unwrap().to_owned());
            let held = self.rotation_abandon_hold.lock().unwrap().clone();
            if let Some(held) = held {
                held.entered.add_permits(1);
                held.release.acquire().await.unwrap().forget();
            }
        }
        if let Some(script) = self.rotation.lock().unwrap().as_mut() {
            let url = value["url"].as_str().unwrap_or_default();
            if url.ends_with("/api/v1/users/me") {
                return Ok(completed(
                    200,
                    serde_json::to_vec(&json!({
                        "id":USER,"email":"rotation@example.test","name":"Rotation User",
                        "encryptedPrivateKey":"","publicKey":"","role":"member",
                        "createdAt":"2026-09-23T00:00:00Z","hasRecoveryKey":false,
                        "secretKeyHint":null,"teamAvatarUrl":null,"teamId":script.team_id,
                        "teamName":"Rotation Team","teamType":"family"
                    }))
                    .unwrap(),
                )
                .to_string());
            }
            if url.ends_with("/api/v1/teams/current") {
                return Ok(completed(200, serde_json::to_vec(&json!({
                    "id":script.team_id,"name":"Rotation Team","ownerId":"owner-1",
                    "role":"member","teamType":if script.team_id == "personal-1" {"personal"} else {"family"},
                    "memberCount":"2","memberLimit":null,"imageUrl":null,
                    "createdAt":"2026-09-23T00:00:00Z"
                })).unwrap()).to_string());
            }
            if url.contains("/api/v1/operations/") {
                let operation_id = url.rsplit('/').next().unwrap();
                return Ok(match script.retained.get(operation_id) {
                    Some(outcome) => {
                        completed(200, serde_json::to_vec(outcome).unwrap()).to_string()
                    }
                    None => completed(404, b"{}".to_vec()).to_string(),
                });
            }
            if url.contains(&format!("/api/v1/vaults/{TEST_VAULT_ID}/members")) {
                let mut members = vec![
                    json!({"userId":USER,"name":"Departing Member","email":"departing@example.test","role":script.initiator_live_role}),
                    json!({"userId":"owner-1","name":"Owner","email":"owner@example.test","role":script.member_role}),
                ];
                if let Some(role) = &script.extra_live_member_role {
                    members.push(json!({"userId":"zmember-1","name":"Remaining Member","email":"remaining@example.test","role":role}));
                }
                if script.unexpected_live_member {
                    members.push(json!({"userId":"zmember-2","name":"New Member","email":"new@example.test","role":"member"}));
                }
                let second_page = script.live_members_paginated && url.contains("cursor=owner-1");
                if script.live_members_paginated {
                    members = if second_page {
                        members.into_iter().skip(2).collect()
                    } else {
                        members.into_iter().take(2).collect()
                    };
                }
                return Ok(completed(
                    200,
                    serde_json::to_vec(&json!({
                        "items":members,
                        "hasMore":script.live_members_paginated && !second_page,
                        "nextCursor":if script.live_members_paginated && !second_page {Some("owner-1")} else {None}
                    }))
                    .unwrap(),
                )
                .to_string());
            }
            if url.contains("/api/v1/vault-key-rotation-plans/") {
                if !url.contains("/preparation/") && !url.contains("/staged/") {
                    script.abandoned.push(value.clone());
                    return Ok(completed(204, Vec::new()).to_string());
                }
                if url.contains("/preparation/") {
                    let plan_id = url
                        .split("/vault-key-rotation-plans/")
                        .nth(1)
                        .unwrap()
                        .split('/')
                        .next()
                        .unwrap();
                    let kind = url
                        .split("/preparation/")
                        .nth(1)
                        .unwrap()
                        .split('?')
                        .next()
                        .unwrap();
                    let plan = script.start_result["plans"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|plan| plan["id"] == plan_id);
                    let records = if kind == "member" {
                        plan.map(|plan| {
                            let mut records = vec![json!({
                            "id":"owner-1", "expectedVersion":plan["expectedKeyVersion"],
                            "payload":json!({"userId":"owner-1", "publicKey":rotation_recipient_key().public_key,
                                "role":script.member_role}).to_string(),
                            })];
                            if let Some(role) = &script.extra_plan_member_role {
                                records.push(json!({
                                    "id":"zmember-1", "expectedVersion":plan["expectedKeyVersion"],
                                    "payload":json!({"userId":"zmember-1", "publicKey":rotation_recipient_key().public_key,
                                        "role":role}).to_string(),
                                }));
                            }
                            records
                        }).unwrap_or_default()
                    } else if kind == "item" {
                        script
                            .item_payload
                            .as_ref()
                            .map(|payload| {
                                vec![json!({
                                    "id":payload["id"], "expectedVersion":1,
                                    "payload":payload.to_string(),
                                })]
                            })
                            .unwrap_or_default()
                    } else if kind == "attachment" {
                        script.attachment_payload.as_ref().map(|payload| vec![json!({
                            "id":payload["attachmentId"], "expectedVersion":payload["envelopeVersion"],
                            "payload":payload.to_string(),
                        })]).unwrap_or_default()
                    } else {
                        Vec::new()
                    };
                    return Ok(completed(
                        200,
                        serde_json::to_vec(&json!({
                            "records":records,"nextCursor":null
                        }))
                        .unwrap(),
                    )
                    .to_string());
                }
                if url.contains("/staged/") {
                    script.staged.push(value.clone());
                    if script.lose_stage_once {
                        script.lose_stage_once = false;
                        return Ok(json!({"type":"networkFailure"}).to_string());
                    }
                    return Ok(completed(204, Vec::new()).to_string());
                }
                return Ok(completed(204, Vec::new()).to_string());
            }
            if url.ends_with("/api/v1/teams/team-1/leave-rotation-plans")
                || url.ends_with("/api/v1/teams/team-1/leave-rotation-plans/finalize")
            {
                let operation_id = value["headers"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|header| {
                        header["name"]
                            .as_str()
                            .is_some_and(|name| name.eq_ignore_ascii_case("idempotency-key"))
                    })
                    .unwrap()["value"]
                    .as_str()
                    .unwrap()
                    .to_owned();
                let finalize = url.ends_with("/finalize");
                let result = if finalize {
                    script.finalize_result.clone()
                } else {
                    script.start_result.clone()
                };
                let outcome = json!({"operationId":operation_id,
                    "kind":if finalize {"finalize_team_leave_rotation_plans"} else {"create_team_leave_rotation_plans"},
                    "result":result});
                script.retained.insert(operation_id, outcome.clone());
                script.requests.push(value.clone());
                let lose = if finalize {
                    script.finalize_sends += 1;
                    if result["status"] == "applied" {
                        script.team_id = "personal-1".into();
                    }
                    script.lose_finalize && script.finalize_sends == 1
                } else {
                    script.start_sends += 1;
                    script.lose_start && script.start_sends == 1
                };
                if lose {
                    return Ok(json!({"type":"networkFailure"}).to_string());
                }
                return Ok(completed(200, serde_json::to_vec(&outcome).unwrap()).to_string());
            }
        }
        if value["type"] == "openStream" {
            self.opens.lock().unwrap().push(value["request"].clone());
            let status = self.statuses.lock().unwrap().pop_front().unwrap_or(200);
            if status == 200 {
                let (sender, receiver) = mpsc::unbounded_channel();
                self.streams.lock().unwrap().insert(
                    value["request"]["dispatchId"].as_str().unwrap().into(),
                    StreamSlot {
                        sender,
                        receiver: Arc::new(AsyncMutex::new(receiver)),
                    },
                );
            }
            self.opened.add_permits(1);
            let release = self.stream_open_release.lock().unwrap().clone();
            if let Some(release) = release {
                release.acquire().await.unwrap().forget();
            }
            return Ok(json!({"type":"opened","status":status,"headers":[{"name":"content-type","value":"text/event-stream"}]}).to_string());
        }
        if value["type"] == "readStream" {
            self.stream_reads.fetch_add(1, Ordering::SeqCst);
            let receiver = self
                .streams
                .lock()
                .unwrap()
                .get(value["dispatchId"].as_str().unwrap())
                .unwrap()
                .receiver
                .clone();
            return Ok(receiver
                .lock()
                .await
                .recv()
                .await
                .unwrap_or(json!({"type":"ended"}))
                .to_string());
        }
        if value["url"].as_str().is_some_and(|url| {
            url.ends_with("/travel-mode/hidden-vaults") || url.ends_with("/travel-mode/enable")
        }) {
            self.policy_settings_requests
                .lock()
                .unwrap()
                .push(value.clone());
            let hold = self.policy_settings_hold.lock().unwrap().clone();
            if let Some(hold) = hold {
                hold.entered.add_permits(1);
                hold.release.acquire().await.unwrap().forget();
                return Ok(hold.response.to_string());
            }
            if let Some(response) = self.policy_settings_response.lock().unwrap().clone() {
                return Ok(response.to_string());
            }
        }
        if value["url"]
            .as_str()
            .is_some_and(|url| url.ends_with("/travel-mode"))
        {
            let gate = self.policy_read.lock().unwrap().clone();
            if let Some(gate) = gate {
                gate.entered.add_permits(1);
                gate.release.acquire().await.unwrap().forget();
                return Ok(gate.response.to_string());
            }
            return Ok(completed(
                200,
                serde_json::to_vec(&json!({
                    "enabled":false,"hiddenVaultIds":[],"enabledAt":null,
                    "updatedAt":"2023-11-14T22:13:20Z"
                }))
                .unwrap(),
            )
            .to_string());
        }
        if value["url"]
            .as_str()
            .is_some_and(|url| url.ends_with("/metadata-updates"))
        {
            let operation_id = value["headers"]
                .as_array()
                .unwrap()
                .iter()
                .find(|header| {
                    header["name"]
                        .as_str()
                        .is_some_and(|name| name.eq_ignore_ascii_case("idempotency-key"))
                })
                .unwrap()["value"]
                .clone();
            // A retained replay answers without producing any new SSE frame.
            return Ok(completed(
                200,
                serde_json::to_vec(&json!({"kind":"update_vault",
                "operationId":operation_id,"result":{"status":"applied","vaultId":TEST_VAULT_ID}}))
                .unwrap(),
            )
            .to_string());
        }
        if value["url"]
            .as_str()
            .is_some_and(|url| url.contains("/sync/bootstrap"))
        {
            self.bootstrap_reads.fetch_add(1, Ordering::SeqCst);
            let page = self
                .bootstrap_pages
                .lock()
                .unwrap()
                .pop_front()
                .expect("scripted authority page");
            let hold = self.bootstrap_hold.lock().unwrap().take();
            if let Some(hold) = hold {
                hold.entered.add_permits(1);
                hold.release.acquire().await.unwrap().forget();
            }
            if page == json!({"type":"networkFailure"}) {
                return Ok(page.to_string());
            }
            return Ok(completed(200, serde_json::to_vec(&page).unwrap()).to_string());
        }
        let changes = value["url"]
            .as_str()
            .is_some_and(|url| url.contains("/sync/changes"));
        let result = self.finite.invoke(text).await;
        if value["url"]
            .as_str()
            .is_some_and(|url| url.ends_with("/authority"))
        {
            if let Some(answer) = self.authority_overrides.lock().unwrap().pop_front() {
                return Ok(answer.to_string());
            }
        }
        if changes {
            self.changes.add_permits(1);
        }
        result
    }
    fn cancel(&self, id: &str) {
        if self
            .rotation_abandon_dispatches
            .lock()
            .unwrap()
            .iter()
            .any(|dispatch| dispatch == id)
        {
            self.rotation_abandon_cancellations
                .lock()
                .unwrap()
                .push(id.to_owned());
        }
        if self.streams.lock().unwrap().remove(id).is_some() {
            self.cancelled.lock().unwrap().push(id.into());
        }
    }
}
struct Setup {
    runtime: Arc<Runtime>,
    server: Arc<SyncServer>,
    account: AccountId,
    timer: Arc<TestTimer>,
    persistence: Arc<PlainReplica>,
    commits: Arc<CommitGate>,
}
struct CommitGate {
    persistence: Arc<PlainReplica>,
    lose_stage_retirement_ack: AtomicBool,
    lost_stage_retirement_acks: AtomicUsize,
    reject_stage_retirement: AtomicBool,
    rejected_stage_retirements: AtomicUsize,
    lose_pending_ack: Mutex<Option<bool>>,
    lost_pending_acks: AtomicUsize,
    hold_next: AtomicBool,
    entered: Semaphore,
    released: tokio::sync::Notify,
    reject_rotation_start_accept: AtomicBool,
    reject_rotation_finalize_accept: AtomicBool,
    hold_rotation_consume_ack: AtomicBool,
    consume_ack_entered: Semaphore,
    consume_ack_released: tokio::sync::Notify,
}
#[async_trait]
impl crate::replica::SerializedReplicaExecutor for CommitGate {
    async fn invoke(&self, request: String) -> Result<String, RuntimeError> {
        let value: crate::replica::ReplicaPersistenceRequest =
            serde_json::from_str(&request).unwrap();
        let before = match &value {
            crate::replica::ReplicaPersistenceRequest::Commit { prepared } => self
                .persistence
                .state
                .snapshot(&prepared.expected.account_id)
                .map(|snapshot| {
                    (
                        snapshot.account_id,
                        snapshot.bootstrap.policy_verification_pending,
                    )
                }),
            _ => None,
        };
        let mut lose_stage_ack = false;
        let mut hold_consume_ack = false;
        if let crate::replica::ReplicaPersistenceRequest::Commit { prepared } = &value {
            if self.reject_rotation_start_accept.load(Ordering::SeqCst)
                && prepared.writes.iter().any(|write| {
                    let serialized = serde_json::to_value(write).unwrap();
                    serialized["row"]["store"] == "operations"
                        && serialized["row"]["payloadJson"]
                            .as_str()
                            .is_some_and(|payload| {
                                payload.contains("create_team_leave_rotation_plans")
                            })
                })
            {
                self.reject_rotation_start_accept
                    .store(false, Ordering::SeqCst);
                return Err(RuntimeError::new(
                    RuntimeErrorCode::StorageUnavailable,
                    "injected start acceptance commit failure",
                ));
            }
            if self.reject_rotation_finalize_accept.load(Ordering::SeqCst)
                && prepared.writes.iter().any(|write| {
                    let serialized = serde_json::to_value(write).unwrap();
                    serialized["row"]["store"] == "operations"
                        && serialized["row"]["payloadJson"]
                            .as_str()
                            .is_some_and(|payload| {
                                payload.contains("finalize_team_leave_rotation_plans")
                            })
                })
            {
                self.reject_rotation_finalize_accept
                    .store(false, Ordering::SeqCst);
                return Err(RuntimeError::new(
                    RuntimeErrorCode::StorageUnavailable,
                    "injected finalize acceptance commit failure",
                ));
            }
            hold_consume_ack = self.hold_rotation_consume_ack.load(Ordering::SeqCst)
                && prepared.writes.iter().any(|write| {
                    let serialized = serde_json::to_value(write).unwrap();
                    serialized["row"]["store"] == "rotationAttempts"
                        && serialized["row"]["payloadJson"]
                            .as_str()
                            .is_some_and(|payload| {
                                serde_json::from_str::<Value>(payload)
                                    .is_ok_and(|row| row["phase"]["type"] == "consumed")
                            })
                })
                && self.hold_rotation_consume_ack.swap(false, Ordering::SeqCst);
            let complete_pending_stage = self
                .persistence
                .state
                .snapshot(&prepared.expected.account_id)
                .is_some_and(|snapshot| {
                    snapshot.bootstrap.policy_verification_pending
                        && snapshot
                            .bootstrap
                            .staging_generation
                            .as_ref()
                            .is_some_and(|id| {
                                snapshot
                                    .bootstrap
                                    .generations
                                    .get(id)
                                    .is_some_and(|stage| stage.final_page_staged)
                            })
                });
            let writes = serde_json::to_value(&prepared.writes).unwrap();
            let metadata: Vec<Value> = writes
                .as_array()
                .unwrap()
                .iter()
                .filter(|write| {
                    write["type"] == "put" && write["row"]["store"] == "replicaMetadata"
                })
                .map(|write| {
                    serde_json::from_str(write["row"]["payloadJson"].as_str().unwrap()).unwrap()
                })
                .collect();
            let retires_complete_stage = complete_pending_stage
                && metadata.iter().any(|row| {
                    row.get("stagingGeneration") == Some(&Value::Null)
                        && row["policyVerificationPending"] == true
                })
                && metadata.iter().any(|row| {
                    row["vaultIds"]
                        .as_array()
                        .is_some_and(|ids| !ids.is_empty())
                });
            if retires_complete_stage && self.reject_stage_retirement.swap(false, Ordering::SeqCst)
            {
                self.rejected_stage_retirements
                    .fetch_add(1, Ordering::SeqCst);
                return Err(RuntimeError::new(
                    RuntimeErrorCode::StorageUnavailable,
                    "injected rejected complete-stage retirement commit",
                ));
            }
            lose_stage_ack = retires_complete_stage
                && self.lose_stage_retirement_ack.swap(false, Ordering::SeqCst);
        }
        if matches!(
            value,
            crate::replica::ReplicaPersistenceRequest::Commit { .. }
        ) && self.hold_next.swap(false, Ordering::SeqCst)
        {
            let mut release = std::pin::pin!(self.released.notified());
            release.as_mut().enable();
            self.entered.add_permits(1);
            release.await;
        }
        let response = self.persistence.invoke(request).await?;
        if hold_consume_ack {
            let mut release = std::pin::pin!(self.consume_ack_released.notified());
            release.as_mut().enable();
            self.consume_ack_entered.add_permits(1);
            release.await;
        }
        if lose_stage_ack {
            self.lost_stage_retirement_acks
                .fetch_add(1, Ordering::SeqCst);
            return Err(RuntimeError::new(
                RuntimeErrorCode::StorageUnavailable,
                "injected lost complete-stage retirement acknowledgement",
            ));
        }
        if let Some((account, before)) = before {
            if let Some(after) = self.persistence.state.snapshot(&account) {
                let pending = after.bootstrap.policy_verification_pending;
                let mut armed = self.lose_pending_ack.lock().unwrap();
                if before != pending && *armed == Some(pending) {
                    armed.take();
                    self.lost_pending_acks.fetch_add(1, Ordering::SeqCst);
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::StorageUnavailable,
                        "injected lost pending marker acknowledgment",
                    ));
                }
            }
        }
        Ok(response)
    }
}
async fn setup() -> Setup {
    setup_with_platform(|platform, _| platform).await
}

async fn setup_with_platform(
    wrap: impl FnOnce(
        Arc<MemoryPlatform>,
        Arc<PlainReplica>,
    ) -> Arc<dyn crate::platform_storage::SerializedPlatformStorageExecutor>,
) -> Setup {
    let seed = seeded_with_existing_item(true, false).await;
    let platform = wrap(seed.platform.clone(), seed.replica.clone());
    let server = Arc::new(SyncServer {
        rotation_clock: seed.clock.clone(),
        finite: seed.server,
        streams: Mutex::new(HashMap::new()),
        opens: Mutex::new(Vec::new()),
        statuses: Mutex::new(VecDeque::new()),
        opened: Semaphore::new(0),
        changes: Semaphore::new(0),
        cancelled: Mutex::new(Vec::new()),
        authority_overrides: Mutex::new(VecDeque::new()),
        bootstrap_pages: Mutex::new(VecDeque::new()),
        bootstrap_hold: Mutex::new(None),
        bootstrap_reads: AtomicUsize::new(0),
        stream_reads: AtomicUsize::new(0),
        stream_open_release: Mutex::new(None),
        policy_read: Mutex::new(None),
        policy_settings_response: Mutex::new(None),
        policy_settings_hold: Mutex::new(None),
        policy_settings_requests: Mutex::new(Vec::new()),
        rotation: Mutex::new(None),
        rotation_finalize_hold: Mutex::new(None),
        rotation_stage_hold: Mutex::new(None),
        rotation_post_stage_live_hold: Mutex::new(None),
        rotation_abandon_hold: Mutex::new(None),
        rotation_abandon_dispatches: Mutex::new(Vec::new()),
        rotation_abandon_cancellations: Mutex::new(Vec::new()),
    });
    let commits = Arc::new(CommitGate {
        persistence: seed.replica.clone(),
        lose_stage_retirement_ack: AtomicBool::new(false),
        lost_stage_retirement_acks: AtomicUsize::new(0),
        reject_stage_retirement: AtomicBool::new(false),
        rejected_stage_retirements: AtomicUsize::new(0),
        lose_pending_ack: Mutex::new(None),
        lost_pending_acks: AtomicUsize::new(0),
        hold_next: AtomicBool::new(false),
        entered: Semaphore::new(0),
        released: tokio::sync::Notify::new(),
        reject_rotation_finalize_accept: AtomicBool::new(false),
        reject_rotation_start_accept: AtomicBool::new(false),
        hold_rotation_consume_ack: AtomicBool::new(false),
        consume_ack_entered: Semaphore::new(0),
        consume_ack_released: tokio::sync::Notify::new(),
    });
    let runtime = Runtime::with_test_dispatch_environment(
        commits.clone(),
        platform,
        server.clone(),
        auth_config(),
        seed.clock.clone(),
        seed.timer.clone(),
    );
    runtime
        .replica
        .load(&seed.account_id)
        .await
        .unwrap()
        .unwrap();
    runtime.unlock_account(&seed.account_id).await.unwrap();
    Setup {
        runtime,
        server,
        account: seed.account_id,
        timer: seed.timer,
        persistence: seed.replica,
        commits,
    }
}

async fn run_rotation_preflight(setup: &Setup) -> Result<ReplicaSnapshot, RuntimeError> {
    let before = setup.runtime.replica.snapshot(&setup.account).unwrap();
    let metadata = setup
        .runtime
        .platform_storage
        .load_account_metadata(&setup.account, &before.incarnation)
        .await
        .unwrap()
        .unwrap();
    let session = setup
        .runtime
        .effective_session(&setup.account, &before.incarnation)
        .await
        .unwrap()
        .unwrap();
    let http = AuthHttpClient::new(
        &setup.runtime.http_transport,
        &metadata.normalized_server_url,
        metadata.insecure_transport_confirmed,
        setup.runtime.auth_client_config.clone().unwrap(),
    )
    .unwrap();
    setup
        .runtime
        .preflight_rotation_authority(&setup.account, &http, session, RequestCancellation::new())
        .await
}

fn script_rotation_pages(setup: &Setup, capable: bool) {
    let snapshot = setup.runtime.replica.snapshot(&setup.account).unwrap();
    let mut authority = snapshot.bootstrap.snapshot();
    for vault in &mut authority.visible_vaults {
        vault.key_version = capable.then_some(1);
    }
    let mut vault_page = json!({
        "phase":"vaults", "vaults":authority.visible_vaults,
        "hasMore":false, "nextCursor":null, "syncCursor":null
    });
    if capable {
        vault_page["vaultKeyVersionIncluded"] = true.into();
    }
    setup.server.bootstrap_pages.lock().unwrap().extend([
        vault_page,
        json!({"phase":"items", "items":authority.visible_items,
            "hasMore":false, "nextCursor":null, "syncCursor":null}),
    ]);
}

fn script_team_leave(setup: &Setup, finalize_result: Value, lose_start: bool, lose_finalize: bool) {
    *setup.server.rotation.lock().unwrap() = Some(RotationScript {
        team_id: "team-1".into(),
        start_result: json!({"status":"applied","plans":[]}),
        finalize_result,
        retained: HashMap::new(),
        requests: Vec::new(),
        start_sends: 0,
        finalize_sends: 0,
        lose_start,
        lose_finalize,
        staged: Vec::new(),
        abandoned: Vec::new(),
        item_payload: None,
        attachment_payload: None,
        lose_stage_once: false,
        member_role: "owner".into(),
        initiator_live_role: "owner".into(),
        extra_plan_member_role: None,
        extra_live_member_role: None,
        unexpected_live_member: false,
        live_members_paginated: false,
    });
}

fn rotation_recipient_key() -> &'static bittery_crypto_core::RsaKeyPair {
    static KEY: std::sync::OnceLock<bittery_crypto_core::RsaKeyPair> = std::sync::OnceLock::new();
    KEY.get_or_init(|| bittery_crypto_core::generate_rsa_key_pair().unwrap())
}

fn prepare_team_leave(setup: &Setup, resume: Option<String>) -> RuntimeRequest {
    RuntimeRequest::PrepareRotation {
        account_id: setup.account.clone(),
        intent: crate::RotationIntent::TeamLeave {
            team_id: "team-1".into(),
        },
        start_operation_id: resume,
    }
}

#[tokio::test]
async fn public_zero_plan_team_leave_requires_fresh_preflight_and_terminal_convergence() {
    let setup = setup().await;
    script_team_leave(
        &setup,
        json!({"status":"applied","rotations":[],"personalTeamId":"personal-1"}),
        false,
        false,
    );
    script_rotation_pages(&setup, true);
    let prepared = setup
        .runtime
        .request(prepare_team_leave(&setup, None), RequestCancellation::new())
        .await
        .unwrap();
    let RuntimeResponse::RotationPrepared { selection } = prepared else {
        panic!("expected prepared empty selection")
    };
    assert!(selection.plans.is_empty());
    assert!(selection.candidates.is_empty());
    let after_start = setup.runtime.replica.snapshot(&setup.account).unwrap();
    assert_eq!(after_start.rotation_attempts.len(), 1);
    assert_eq!(after_start.receipts.len(), 1);
    script_rotation_pages(&setup, true);
    let completed = setup
        .runtime
        .request(
            RuntimeRequest::CompleteRotation {
                account_id: setup.account.clone(),
                selection: selection.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert!(
        matches!(completed, RuntimeResponse::RotationCompleted { personal_team_id } if personal_team_id == "personal-1")
    );
    let after = setup.runtime.replica.snapshot(&setup.account).unwrap();
    assert!(after.operations.is_empty());
    assert_eq!(after.receipts.len(), 2);
    assert!(matches!(
        after.rotation_attempts[0].phase,
        crate::replica::RotationAttemptPhase::Completed { .. }
    ));
    let RuntimeResponse::TeamLeaveAttempts { attempts } = setup
        .runtime
        .request(
            RuntimeRequest::ListTeamLeaveAttempts {
                account_id: setup.account.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("unacknowledged result must remain discoverable")
    };
    assert_eq!(attempts[0].start_operation_id, selection.start_operation_id);
    assert!(matches!(
        setup
            .runtime
            .request(
                RuntimeRequest::AcknowledgeTeamLeaveAttempt {
                    account_id: setup.account.clone(),
                    start_operation_id: selection.start_operation_id.clone(),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap(),
        RuntimeResponse::TeamLeaveAttemptAcknowledged
    ));
    let RuntimeResponse::TeamLeaveAttempts { attempts } = setup
        .runtime
        .request(
            RuntimeRequest::ListTeamLeaveAttempts {
                account_id: setup.account.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("acknowledged result list")
    };
    assert!(attempts.is_empty());
    let acknowledged = setup.runtime.replica.snapshot(&setup.account).unwrap();
    assert_eq!(acknowledged.receipts, after.receipts);
    assert_eq!(acknowledged.rotation_attempts.len(), 1);
    assert_eq!(
        acknowledged.rotation_attempts[0].start_operation_id,
        selection.start_operation_id
    );
    assert!(acknowledged.rotation_attempts[0].presentation_acknowledged);
    assert!(matches!(
        setup
            .runtime
            .request(
                RuntimeRequest::InspectRotation {
                    account_id: setup.account.clone(),
                    start_operation_id: selection.start_operation_id.clone(),
                },
                RequestCancellation::new()
            )
            .await
            .unwrap(),
        RuntimeResponse::RotationCompleted { .. }
    ));
    assert_eq!(setup.server.bootstrap_reads.load(Ordering::SeqCst), 4);
    let script = setup.server.rotation.lock().unwrap();
    let script = script.as_ref().unwrap();
    assert_eq!(script.start_sends, 1);
    assert_eq!(script.finalize_sends, 1);
    assert_eq!(
        script.requests[1]["body"],
        json!([123, 34, 112, 108, 97, 110, 73, 100, 115, 34, 58, 91, 93, 125])
    );
}

#[tokio::test]
async fn public_rotation_refuses_incompatible_bootstrap_before_any_start_operation() {
    let setup = setup().await;
    script_team_leave(
        &setup,
        json!({"status":"applied","rotations":[],"personalTeamId":"personal-1"}),
        false,
        false,
    );
    script_rotation_pages(&setup, false);
    let error = setup
        .runtime
        .request(prepare_team_leave(&setup, None), RequestCancellation::new())
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::VersionEvidenceUnavailable);
    let snapshot = setup.runtime.replica.snapshot(&setup.account).unwrap();
    assert!(snapshot.operations.is_empty());
    assert!(snapshot.rotation_attempts.is_empty());
    assert_eq!(
        setup
            .server
            .rotation
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .start_sends,
        0
    );
}

#[tokio::test]
async fn failed_atomic_start_accept_sends_no_http_and_leaves_no_starting_attempt() {
    let setup = setup().await;
    script_team_leave(
        &setup,
        json!({"status":"applied","rotations":[],"personalTeamId":"personal-1"}),
        false,
        false,
    );
    script_rotation_pages(&setup, true);
    setup
        .commits
        .reject_rotation_start_accept
        .store(true, Ordering::SeqCst);
    let error = setup
        .runtime
        .request(prepare_team_leave(&setup, None), RequestCancellation::new())
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::StorageUnavailable);
    let snapshot = setup.runtime.replica.snapshot(&setup.account).unwrap();
    assert!(snapshot.operations.is_empty());
    assert!(snapshot.rotation_attempts.is_empty());
    assert_eq!(
        setup
            .server
            .rotation
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .start_sends,
        0
    );
}

#[tokio::test]
async fn public_rotation_lost_start_and_finalize_replay_exact_bytes_and_keep_refresh_duty() {
    let setup = setup().await;
    script_team_leave(
        &setup,
        json!({"status":"applied","rotations":[],"personalTeamId":"personal-1"}),
        true,
        true,
    );
    script_rotation_pages(&setup, true);
    let first = setup
        .runtime
        .request(prepare_team_leave(&setup, None), RequestCancellation::new())
        .await
        .unwrap();
    let RuntimeResponse::RotationStartPending { start_operation_id } = first else {
        panic!("lost start must remain pending")
    };
    let accepted = setup.runtime.replica.snapshot(&setup.account).unwrap();
    assert_eq!(accepted.operations.len(), 1);
    assert!(matches!(
        accepted.rotation_attempts[0].phase,
        crate::replica::RotationAttemptPhase::Starting
    ));
    assert_eq!(
        accepted.rotation_attempts[0]
            .authority_generation_id
            .as_deref(),
        accepted
            .bootstrap
            .active_generation
            .as_ref()
            .map(|generation| generation.0.as_str())
    );
    setup.server.rotation_clock.advance(1_000);
    let second = setup
        .runtime
        .request(
            prepare_team_leave(&setup, Some(start_operation_id.clone())),
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let RuntimeResponse::RotationPrepared { selection } = second else {
        panic!("exact start replay must prepare")
    };
    assert_eq!(
        selection.authority_generation_id,
        accepted.rotation_attempts[0]
            .authority_generation_id
            .clone()
            .unwrap()
    );
    script_rotation_pages(&setup, true);
    let first_complete = setup
        .runtime
        .request(
            RuntimeRequest::CompleteRotation {
                account_id: setup.account.clone(),
                selection: selection.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert!(matches!(
        first_complete,
        RuntimeResponse::RotationFinalizePending { .. }
    ));
    assert!(
        setup
            .runtime
            .request(
                RuntimeRequest::CompleteRotation {
                    account_id: setup.account.clone(),
                    selection,
                },
                RequestCancellation::new()
            )
            .await
            .is_err(),
        "consumed selection cannot complete twice"
    );
    setup.server.rotation_clock.advance(1_000);
    let _ = setup
        .runtime
        .request(
            RuntimeRequest::InspectRotation {
                account_id: setup.account.clone(),
                start_operation_id: start_operation_id.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let terminal = setup
        .runtime
        .request(
            RuntimeRequest::InspectRotation {
                account_id: setup.account.clone(),
                start_operation_id,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert!(matches!(
        terminal,
        RuntimeResponse::RotationCompleted { .. }
    ));
    let script = setup.server.rotation.lock().unwrap();
    let requests = &script.as_ref().unwrap().requests;
    assert_eq!(requests.len(), 4);
    assert_eq!(requests[0]["body"], requests[1]["body"]);
    assert_eq!(requests[2]["body"], requests[3]["body"]);
}

#[tokio::test]
async fn public_lost_start_cannot_substitute_later_bootstrap_for_frozen_preflight() {
    let setup = setup().await;
    script_team_leave(
        &setup,
        json!({"status":"applied","rotations":[],"personalTeamId":"personal-1"}),
        true,
        false,
    );
    script_rotation_pages(&setup, true);
    let RuntimeResponse::RotationStartPending { start_operation_id } = setup
        .runtime
        .request(prepare_team_leave(&setup, None), RequestCancellation::new())
        .await
        .unwrap()
    else {
        panic!("lost start")
    };
    let frozen = setup
        .runtime
        .replica
        .snapshot(&setup.account)
        .unwrap()
        .rotation_attempts[0]
        .authority_generation_id
        .clone()
        .unwrap();
    script_rotation_pages(&setup, true);
    let fresh = run_rotation_preflight(&setup).await.unwrap();
    assert_ne!(fresh.bootstrap.active_generation.unwrap().0, frozen);
    setup.server.rotation_clock.advance(1_000);
    assert!(setup
        .runtime
        .request(
            prepare_team_leave(&setup, Some(start_operation_id)),
            RequestCancellation::new(),
        )
        .await
        .is_err());
    let snapshot = setup.runtime.replica.snapshot(&setup.account).unwrap();
    assert_eq!(
        snapshot.rotation_attempts[0]
            .authority_generation_id
            .as_deref(),
        Some(frozen.as_str())
    );
    assert_eq!(
        setup
            .server
            .rotation
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .finalize_sends,
        0
    );
}

#[tokio::test]
async fn public_rejected_finalize_publishes_only_after_fresh_authority() {
    let setup = setup().await;
    script_team_leave(
        &setup,
        json!({"status":"rejected","code":"rotation_plan_set_mismatch"}),
        false,
        false,
    );
    script_rotation_pages(&setup, true);
    let RuntimeResponse::RotationPrepared { selection } = setup
        .runtime
        .request(prepare_team_leave(&setup, None), RequestCancellation::new())
        .await
        .unwrap()
    else {
        panic!("start")
    };
    script_rotation_pages(&setup, false);
    let unavailable = setup
        .runtime
        .request(
            RuntimeRequest::CompleteRotation {
                account_id: setup.account.clone(),
                selection: selection.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert!(matches!(
        unavailable,
        RuntimeResponse::RotationRefreshRequired {
            outcome: crate::RotationTerminalOutcome::Rejected { .. },
            ..
        }
    ));
    let start_operation_id = selection.start_operation_id;
    let awaiting = setup.runtime.replica.snapshot(&setup.account).unwrap();
    assert!(matches!(
        awaiting.rotation_attempts[0].phase,
        crate::replica::RotationAttemptPhase::RejectedAwaitingRefresh { .. }
    ));
    script_rotation_pages(&setup, true);
    let rejected = setup
        .runtime
        .request(
            RuntimeRequest::InspectRotation {
                account_id: setup.account.clone(),
                start_operation_id,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert!(matches!(
        rejected,
        RuntimeResponse::RotationRejected {
            code: crate::RotationFinalizeRejectionCode::RotationPlanSetMismatch
        }
    ));
    assert_eq!(setup.server.bootstrap_reads.load(Ordering::SeqCst), 6);
}

#[tokio::test]
async fn public_applied_finalize_incomplete_catchup_stays_refresh_required_until_retry() {
    let setup = setup().await;
    script_team_leave(
        &setup,
        json!({"status":"applied","rotations":[],"personalTeamId":"personal-1"}),
        false,
        false,
    );
    script_rotation_pages(&setup, true);
    let RuntimeResponse::RotationPrepared { selection } = setup
        .runtime
        .request(prepare_team_leave(&setup, None), RequestCancellation::new())
        .await
        .unwrap()
    else {
        panic!("start")
    };
    script_rotation_pages(&setup, true);
    setup
        .server
        .bootstrap_pages
        .lock()
        .unwrap()
        .back_mut()
        .unwrap()["hasMore"] = true.into();
    let start_operation_id = selection.start_operation_id.clone();
    let incomplete = setup
        .runtime
        .request(
            RuntimeRequest::CompleteRotation {
                account_id: setup.account.clone(),
                selection,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert!(matches!(
        incomplete,
        RuntimeResponse::RotationRefreshRequired {
            outcome: crate::RotationTerminalOutcome::Applied { .. },
            ..
        }
    ));
    let waiting = setup.runtime.replica.snapshot(&setup.account).unwrap();
    assert!(matches!(
        waiting.rotation_attempts[0].phase,
        crate::replica::RotationAttemptPhase::AppliedAwaitingRefresh { .. }
    ));
    assert!(waiting.operations.is_empty());
    assert_eq!(waiting.receipts.len(), 2);
    script_rotation_pages(&setup, true);
    let completed = setup
        .runtime
        .request(
            RuntimeRequest::InspectRotation {
                account_id: setup.account.clone(),
                start_operation_id,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert!(matches!(
        completed,
        RuntimeResponse::RotationCompleted { personal_team_id } if personal_team_id == "personal-1"
    ));
}

#[tokio::test]
async fn private_team_leave_prepares_an_authoritative_nonempty_vault_plan() {
    let setup = setup().await;
    script_team_leave(
        &setup,
        json!({"status":"applied","rotations":[],"personalTeamId":"personal-1"}),
        false,
        false,
    );
    setup
        .server
        .rotation
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .start_result = json!({
        "status":"applied", "plans":[{
            "id":"private-plan", "vaultId":TEST_VAULT_ID, "initiatorUserId":USER,
            "expectedKeyVersion":1, "state":"preparing",
            "idleExpiresAt":"2026-09-25T01:00:00Z", "absoluteExpiresAt":"2026-09-26T00:00:00Z"
        }]
    });
    script_rotation_pages(&setup, true);
    let answer = setup
        .runtime
        .request(prepare_team_leave(&setup, None), RequestCancellation::new())
        .await
        .unwrap();
    let RuntimeResponse::RotationPrepared { selection } = answer else {
        panic!("nonempty Team leave must prepare its authoritative private plan: {answer:?}");
    };
    assert_eq!(selection.plans.len(), 1);
    assert_eq!(selection.plans[0].plan_id, "private-plan");
    assert_eq!(selection.plans[0].vault_id, TEST_VAULT_ID);
    assert_eq!(selection.plans[0].expected_key_version, 1);
    assert_eq!(selection.candidates.len(), 1);
    let RuntimeResponse::TeamLeaveAttempts { attempts } = setup
        .runtime
        .request(
            RuntimeRequest::ListTeamLeaveAttempts {
                account_id: setup.account.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("retained Team leave attempt list")
    };
    assert_eq!(attempts.len(), 1);
    assert_eq!(attempts[0].start_operation_id, selection.start_operation_id);
    assert!(setup
        .runtime
        .request(
            RuntimeRequest::AcknowledgeTeamLeaveAttempt {
                account_id: setup.account.clone(),
                start_operation_id: selection.start_operation_id.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .is_err());
    assert_eq!(selection.candidates[0].user_id, "owner-1");
    assert_eq!(
        selection.candidates[0].public_key,
        rotation_recipient_key().public_key
    );
}

#[tokio::test]
async fn private_team_leave_stages_exact_member_item_and_attachment_bytes_then_fences() {
    let setup = setup().await;
    script_team_leave(
        &setup,
        json!({
            "status":"applied", "personalTeamId":"personal-1",
            "rotations":[{"planId":"private-plan","vaultId":TEST_VAULT_ID,
                "keyVersion":2,"rotationId":"rotation-1"}]
        }),
        false,
        false,
    );
    let snapshot = setup.runtime.replica.snapshot(&setup.account).unwrap();
    let item = snapshot
        .bootstrap
        .snapshot()
        .visible_items
        .into_iter()
        .find(|item| item.id == "item-existing")
        .unwrap();
    let attachment_key = [47_u8; 32];
    let attachment_context = bittery_crypto_core::AadContext {
        vault_id: TEST_VAULT_ID.into(),
        entity_id: "attachment-1".into(),
        entity_type: "attachment_key".into(),
        version: 1,
        user_id: USER.into(),
    };
    let envelope = bittery_crypto_core::encrypt_with_aad(
        &base64::engine::general_purpose::STANDARD.encode(attachment_key),
        &crate::test_fixtures::TEST_VAULT_KEY,
        &attachment_context,
    )
    .unwrap();
    {
        let mut lock = setup.server.rotation.lock().unwrap();
        let script = lock.as_mut().unwrap();
        script.start_result = json!({"status":"applied","plans":[{
            "id":"private-plan","vaultId":TEST_VAULT_ID,"initiatorUserId":USER,
            "expectedKeyVersion":1,"state":"preparing",
            "idleExpiresAt":"2026-09-25T01:00:00Z","absoluteExpiresAt":"2026-09-26T00:00:00Z"
        }]});
        script.item_payload = Some(json!({
            "id":item.id,"vaultId":item.vault_id,"encryptedData":item.encrypted_data,
            "encryptionIv":item.encryption_iv,"encryptionAlgorithm":item.encryption_algorithm,
            "encryptionVersion":item.encryption_version,"encryptedByUserId":item.encrypted_by_user_id,
        }));
        script.attachment_payload = Some(json!({
            "attachmentId":"attachment-1","vaultId":TEST_VAULT_ID,"uploadedBy":USER,
            "encryptedAttachmentKey":envelope.ciphertext,"attachmentKeyIv":envelope.iv,
            "attachmentKeyAlgorithm":envelope.algorithm,"envelopeVersion":1,
        }));
        script.lose_stage_once = true;
    }
    script_rotation_pages(&setup, true);
    let RuntimeResponse::RotationPrepared { selection } = setup
        .runtime
        .request(prepare_team_leave(&setup, None), RequestCancellation::new())
        .await
        .unwrap()
    else {
        panic!("private plan must prepare")
    };
    assert_eq!(selection.candidates.len(), 1);
    let RuntimeResponse::RecipientKeyScope { scope } = setup
        .runtime
        .request(
            RuntimeRequest::RecipientKeyScope {
                account_id: setup.account.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("recipient scope")
    };
    let unverified = setup
        .runtime
        .request(
            RuntimeRequest::CompleteRotation {
                account_id: setup.account.clone(),
                selection: selection.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(unverified.code, RuntimeErrorCode::RecipientKeyUnverified);
    let wrong_fingerprint = setup
        .runtime
        .request(
            RuntimeRequest::VerifyRecipientKey {
                account_id: setup.account.clone(),
                recipient_user_id: "owner-1".into(),
                public_key: rotation_recipient_key().public_key.clone(),
                expected_fingerprint: format!("BVK1-{}", "0".repeat(64)),
                scope: scope.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(
        wrong_fingerprint.code,
        RuntimeErrorCode::RecipientFingerprintMismatch
    );
    assert!(setup
        .server
        .rotation
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .staged
        .is_empty());
    setup
        .runtime
        .request(
            RuntimeRequest::VerifyRecipientKey {
                account_id: setup.account.clone(),
                recipient_user_id: "owner-1".into(),
                public_key: rotation_recipient_key().public_key.clone(),
                expected_fingerprint: selection.candidates[0].fingerprint.clone(),
                scope,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    setup
        .server
        .rotation
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .member_role = "read-only".into();
    script_rotation_pages(&setup, true);
    let changed_role = setup
        .runtime
        .request(
            RuntimeRequest::CompleteRotation {
                account_id: setup.account.clone(),
                selection: selection.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(changed_role.code, RuntimeErrorCode::InvariantViolation);
    assert!(
        setup
            .server
            .rotation
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .staged
            .is_empty(),
        "changed remaining-Member role must refuse before private staging"
    );
    setup
        .server
        .rotation
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .member_role = "owner".into();
    let sink = Arc::new(ItemsSink::default());
    let _observer = setup
        .runtime
        .observe(
            ObservationRequest::Items {
                account_id: setup.account.clone(),
            },
            sink.clone(),
        )
        .unwrap();
    assert!(
        matches!(sink.0.lock().unwrap().last(), Some(RuntimeProjection::Items(items))
        if items.items.iter().any(|item| item.vault_id == TEST_VAULT_ID))
    );
    script_rotation_pages(&setup, true);
    let held = Arc::new(BootstrapReadGate {
        entered: Semaphore::new(0),
        release: Semaphore::new(0),
    });
    *setup.server.rotation_finalize_hold.lock().unwrap() = Some(held.clone());
    let runtime = setup.runtime.clone();
    let account = setup.account.clone();
    let selected = selection.clone();
    let completing = tokio::spawn(async move {
        runtime
            .request(
                RuntimeRequest::CompleteRotation {
                    account_id: account,
                    selection: selected,
                },
                RequestCancellation::new(),
            )
            .await
    });
    held.entered.acquire().await.unwrap().forget();
    assert!(
        matches!(sink.0.lock().unwrap().last(), Some(RuntimeProjection::Items(items))
        if items.items.iter().all(|item| item.vault_id != TEST_VAULT_ID)
            && items.vaults.iter().all(|vault| vault.vault_id != TEST_VAULT_ID)),
        "mounted Items observer must be fenced while finalize HTTP is held"
    );
    held.release.add_permits(1);
    *setup.server.rotation_finalize_hold.lock().unwrap() = None;
    let answer = completing.await.unwrap().unwrap();
    assert!(matches!(
        answer,
        RuntimeResponse::RotationRefreshRequired { .. }
    ));
    let after = setup.runtime.replica.snapshot(&setup.account).unwrap();
    assert!(after.require_vault_accepting_work(TEST_VAULT_ID).is_err());
    assert!(after.require_vault_accepting_work("vault-2").is_ok());
    assert!(
        matches!(sink.0.lock().unwrap().last(), Some(RuntimeProjection::Items(items))
        if items.items.iter().all(|item| item.vault_id != TEST_VAULT_ID)
            && items.vaults.iter().all(|vault| vault.vault_id != TEST_VAULT_ID)),
        "already mounted Items observers must receive the selective fence"
    );
    assert_eq!(after.rotation_attempts[0].applied_results.len(), 1);
    {
        let rotation = setup.server.rotation.lock().unwrap();
        let requests = &rotation.as_ref().unwrap().staged;
        assert_eq!(
            requests.len(),
            4,
            "one lost Member reply resends identical bytes"
        );
        assert_eq!(requests[0]["body"], requests[1]["body"]);
        let staged = |index: usize| -> Value {
            let bytes: Vec<u8> = serde_json::from_value(requests[index]["body"].clone()).unwrap();
            let body: Value = serde_json::from_slice(&bytes).unwrap();
            serde_json::from_str(body["outputs"][0]["payload"].as_str().unwrap()).unwrap()
        };
        let member = staged(0);
        let encoded = bittery_crypto_core::rsa_decrypt(
            member["encryptedVaultKey"].as_str().unwrap(),
            &rotation_recipient_key().private_key,
        )
        .unwrap();
        let rotated_key = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap();
        let new_item = staged(2);
        let item_context = bittery_crypto_core::AadContext {
            vault_id: TEST_VAULT_ID.into(),
            entity_id: "item-existing".into(),
            entity_type: "item".into(),
            version: 1,
            user_id: USER.into(),
        };
        let encrypted_item = bittery_crypto_core::EncryptedData {
            ciphertext: new_item["encryptedData"].as_str().unwrap().into(),
            iv: new_item["encryptionIv"].as_str().unwrap().into(),
            algorithm: new_item["encryptionAlgorithm"].as_str().unwrap().into(),
        };
        assert!(bittery_crypto_core::decrypt_with_aad(
            &encrypted_item,
            &rotated_key,
            &item_context
        )
        .is_ok());
        assert!(bittery_crypto_core::decrypt_with_aad(
            &encrypted_item,
            &crate::test_fixtures::TEST_VAULT_KEY,
            &item_context
        )
        .is_err());
        let new_attachment = staged(3);
        let new_context = bittery_crypto_core::AadContext {
            version: 2,
            ..attachment_context
        };
        let wrapped_attachment = bittery_crypto_core::EncryptedData {
            ciphertext: new_attachment["encryptedAttachmentKey"]
                .as_str()
                .unwrap()
                .into(),
            iv: new_attachment["attachmentKeyIv"].as_str().unwrap().into(),
            algorithm: new_attachment["attachmentKeyAlgorithm"]
                .as_str()
                .unwrap()
                .into(),
        };
        assert_eq!(
            bittery_crypto_core::decrypt_with_aad(&wrapped_attachment, &rotated_key, &new_context)
                .unwrap(),
            base64::engine::general_purpose::STANDARD.encode(attachment_key)
        );
    }
    assert!(setup
        .runtime
        .request(
            RuntimeRequest::CompleteRotation {
                account_id: setup.account.clone(),
                selection,
            },
            RequestCancellation::new()
        )
        .await
        .is_err());
    assert_eq!(
        setup
            .server
            .rotation
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .staged
            .len(),
        4
    );
    script_rotation_pages(&setup, true);
    {
        let mut pages = setup.server.bootstrap_pages.lock().unwrap();
        for page in pages.iter_mut() {
            if page["phase"] == "vaults" {
                page["vaults"] = json!([]);
            }
            if page["phase"] == "items" {
                page["items"] = json!([]);
            }
        }
    }
    let reopened = setup
        .runtime
        .request(
            RuntimeRequest::InspectRotation {
                account_id: setup.account.clone(),
                start_operation_id: after.rotation_attempts[0].start_operation_id.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert!(matches!(
        reopened,
        RuntimeResponse::RotationCompleted { .. }
    ));
    let reopened_snapshot = setup.runtime.replica.snapshot(&setup.account).unwrap();
    assert!(reopened_snapshot.rotation_fenced_vault_ids().is_empty());
}

async fn prepared_live_role_rotation() -> (Setup, crate::RotationSelection) {
    let setup = setup().await;
    script_team_leave(
        &setup,
        json!({"status":"applied","rotations":[],"personalTeamId":"personal-1"}),
        false,
        false,
    );
    {
        let mut rotation = setup.server.rotation.lock().unwrap();
        let script = rotation.as_mut().unwrap();
        script.start_result = json!({"status":"applied","plans":[{
            "id":"private-plan","vaultId":TEST_VAULT_ID,"initiatorUserId":USER,
            "expectedKeyVersion":1,"state":"preparing",
            "idleExpiresAt":"2026-09-25T01:00:00Z","absoluteExpiresAt":"2026-09-26T00:00:00Z"
        }]});
        script.extra_plan_member_role = Some("member".into());
        script.extra_live_member_role = Some("member".into());
    }
    script_rotation_pages(&setup, true);
    let RuntimeResponse::RotationPrepared { selection } = setup
        .runtime
        .request(prepare_team_leave(&setup, None), RequestCancellation::new())
        .await
        .unwrap()
    else {
        panic!("private plan must prepare")
    };
    assert_eq!(selection.candidates.len(), 2);
    let RuntimeResponse::RecipientKeyScope { scope } = setup
        .runtime
        .request(
            RuntimeRequest::RecipientKeyScope {
                account_id: setup.account.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("recipient scope")
    };
    for candidate in &selection.candidates {
        setup
            .runtime
            .request(
                RuntimeRequest::VerifyRecipientKey {
                    account_id: setup.account.clone(),
                    recipient_user_id: candidate.user_id.clone(),
                    public_key: candidate.public_key.clone(),
                    expected_fingerprint: candidate.fingerprint.clone(),
                    scope: scope.clone(),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap();
    }
    (setup, selection)
}

#[tokio::test]
async fn private_team_leave_rejects_live_initiator_permission_and_member_set_changes() {
    for change in ["initiatorRole", "remainingRemoved", "remainingAdded"] {
        let (setup, selection) = prepared_live_role_rotation().await;
        {
            let mut rotation = setup.server.rotation.lock().unwrap();
            let script = rotation.as_mut().unwrap();
            script.live_members_paginated = true;
            match change {
                "initiatorRole" => script.initiator_live_role = "read-only".into(),
                "remainingRemoved" => script.extra_live_member_role = None,
                "remainingAdded" => script.unexpected_live_member = true,
                _ => unreachable!(),
            }
        }
        let stopped = setup
            .runtime
            .request(
                RuntimeRequest::CompleteRotation {
                    account_id: setup.account.clone(),
                    selection,
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap_err();
        assert_eq!(
            stopped.code,
            RuntimeErrorCode::InvariantViolation,
            "{change}"
        );
        let rotation = setup.server.rotation.lock().unwrap();
        let script = rotation.as_ref().unwrap();
        assert!(script.staged.is_empty(), "{change}");
        assert_eq!(script.abandoned.len(), 1, "{change}");
        assert_eq!(script.finalize_sends, 0, "{change}");
        assert_eq!(script.extra_plan_member_role.as_deref(), Some("member"));
        let snapshot = setup.runtime.replica.snapshot(&setup.account).unwrap();
        assert!(matches!(
            snapshot.rotation_attempts[0].phase,
            crate::replica::RotationAttemptPhase::Consumed { .. }
        ));
        assert!(snapshot.operations.is_empty());
    }
}

#[tokio::test]
async fn private_team_leave_rechecks_live_non_owner_role_before_and_between_stages() {
    let (setup, selection) = prepared_live_role_rotation().await;

    // The plan pages above remain unchanged. Only the live Vault Member role moves.
    setup
        .server
        .rotation
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .extra_live_member_role = Some("read-only".into());
    let changed_before = setup
        .runtime
        .request(
            RuntimeRequest::CompleteRotation {
                account_id: setup.account.clone(),
                selection: selection.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(changed_before.code, RuntimeErrorCode::InvariantViolation);
    {
        let rotation = setup.server.rotation.lock().unwrap();
        let script = rotation.as_ref().unwrap();
        assert!(script.staged.is_empty());
        assert_eq!(script.abandoned.len(), 1);
        assert_eq!(script.finalize_sends, 0);
        assert_eq!(script.extra_plan_member_role.as_deref(), Some("member"));
    }
    let snapshot = setup.runtime.replica.snapshot(&setup.account).unwrap();
    assert!(matches!(
        snapshot.rotation_attempts[0].phase,
        crate::replica::RotationAttemptPhase::Consumed { .. }
    ));
    assert!(snapshot.operations.is_empty());

    // A separate unchanged plan reaches its first stage before live authority moves.
    let (setup, selection) = prepared_live_role_rotation().await;
    setup
        .server
        .rotation
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .live_members_paginated = true;
    let held = Arc::new(BootstrapReadGate {
        entered: Semaphore::new(0),
        release: Semaphore::new(0),
    });
    *setup.server.rotation_stage_hold.lock().unwrap() = Some(held.clone());
    let runtime = setup.runtime.clone();
    let account = setup.account.clone();
    let mut completing = tokio::spawn(async move {
        runtime
            .request(
                RuntimeRequest::CompleteRotation {
                    account_id: account,
                    selection,
                },
                RequestCancellation::new(),
            )
            .await
    });
    tokio::select! {
        entered = held.entered.acquire() => entered.unwrap().forget(),
        result = &mut completing => panic!("completion stopped before first stage: {result:?}"),
    }
    setup
        .server
        .rotation
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .extra_live_member_role = Some("read-only".into());
    *setup.server.rotation_stage_hold.lock().unwrap() = None;
    held.release.add_permits(1);
    let changed_between = tokio::time::timeout(std::time::Duration::from_secs(10), completing)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert_eq!(changed_between.code, RuntimeErrorCode::InvariantViolation);
    let rotation = setup.server.rotation.lock().unwrap();
    let script = rotation.as_ref().unwrap();
    assert_eq!(script.staged.len(), 1, "no second wrapper or staged page");
    assert_eq!(script.abandoned.len(), 1);
    assert_eq!(script.finalize_sends, 0);
    assert_eq!(script.extra_plan_member_role.as_deref(), Some("member"));
    let snapshot = setup.runtime.replica.snapshot(&setup.account).unwrap();
    assert!(matches!(
        snapshot.rotation_attempts[0].phase,
        crate::replica::RotationAttemptPhase::Consumed { .. }
    ));
    assert!(snapshot.operations.is_empty());
}

#[tokio::test]
async fn private_team_leave_abandons_after_last_stage_when_live_role_changes() {
    let (setup, selection) = prepared_live_role_rotation().await;
    setup
        .server
        .rotation
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .live_members_paginated = true;
    let held = Arc::new(BootstrapReadGate {
        entered: Semaphore::new(0),
        release: Semaphore::new(0),
    });
    *setup.server.rotation_post_stage_live_hold.lock().unwrap() = Some(held.clone());
    let runtime = setup.runtime.clone();
    let account = setup.account.clone();
    let mut completing = tokio::spawn(async move {
        runtime
            .request(
                RuntimeRequest::CompleteRotation {
                    account_id: account,
                    selection,
                },
                RequestCancellation::new(),
            )
            .await
    });
    tokio::select! {
        entered = held.entered.acquire() => entered.unwrap().forget(),
        result = &mut completing => panic!("completion stopped before final live read: {result:?}"),
    }
    {
        let mut rotation = setup.server.rotation.lock().unwrap();
        let script = rotation.as_mut().unwrap();
        assert_eq!(script.staged.len(), 2, "all private stages completed");
        assert!(script.abandoned.is_empty());
        script.extra_live_member_role = Some("read-only".into());
    }
    *setup.server.rotation_post_stage_live_hold.lock().unwrap() = None;
    held.release.add_permits(1);
    let stopped = tokio::time::timeout(std::time::Duration::from_secs(10), completing)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert_eq!(stopped.code, RuntimeErrorCode::InvariantViolation);
    let rotation = setup.server.rotation.lock().unwrap();
    let script = rotation.as_ref().unwrap();
    assert_eq!(script.extra_plan_member_role.as_deref(), Some("member"));
    assert_eq!(script.staged.len(), 2);
    assert_eq!(script.finalize_sends, 0);
    assert_eq!(script.abandoned.len(), 1, "authorized plan-abandon attempt");
    assert!(script.abandoned[0]["url"]
        .as_str()
        .unwrap()
        .ends_with("/vault-key-rotation-plans/private-plan"));
    let snapshot = setup.runtime.replica.snapshot(&setup.account).unwrap();
    assert!(matches!(
        snapshot.rotation_attempts[0].phase,
        crate::replica::RotationAttemptPhase::Consumed { .. }
    ));
    assert!(snapshot.operations.is_empty());
}

#[tokio::test]
async fn private_team_leave_skips_abandon_after_last_stage_with_pending_lock_intent() {
    let (setup, selection) = prepared_live_role_rotation().await;
    let held = Arc::new(BootstrapReadGate {
        entered: Semaphore::new(0),
        release: Semaphore::new(0),
    });
    *setup.server.rotation_post_stage_live_hold.lock().unwrap() = Some(held.clone());
    let runtime = setup.runtime.clone();
    let account = setup.account.clone();
    let completing = tokio::spawn(async move {
        runtime
            .request(
                RuntimeRequest::CompleteRotation {
                    account_id: account,
                    selection,
                },
                RequestCancellation::new(),
            )
            .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(10), held.entered.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    assert_eq!(
        setup
            .server
            .rotation
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .staged
            .len(),
        2
    );
    // A queued Lock installs this intent before it waits for the Account execution fence.
    let intent = setup
        .runtime
        .account_access_retirement_intent(&setup.account);
    *intent.lock().unwrap() += 1;
    *setup.server.rotation_post_stage_live_hold.lock().unwrap() = None;
    held.release.add_permits(1);
    let stopped = tokio::time::timeout(std::time::Duration::from_secs(10), completing)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert_eq!(stopped.code, RuntimeErrorCode::Cancelled);
    *intent.lock().unwrap() -= 1;
    let rotation = setup.server.rotation.lock().unwrap();
    let script = rotation.as_ref().unwrap();
    assert!(
        script.abandoned.is_empty(),
        "no HTTP after Account retirement"
    );
    assert_eq!(script.finalize_sends, 0);
    let snapshot = setup.runtime.replica.snapshot(&setup.account).unwrap();
    assert!(matches!(
        snapshot.rotation_attempts[0].phase,
        crate::replica::RotationAttemptPhase::Consumed { .. }
    ));
    assert!(snapshot.operations.is_empty());
}

#[tokio::test]
async fn private_team_leave_drains_held_abandon_delete_before_public_lock() {
    let (setup, selection) = prepared_live_role_rotation().await;
    let live_read = Arc::new(BootstrapReadGate {
        entered: Semaphore::new(0),
        release: Semaphore::new(0),
    });
    let abandon = Arc::new(BootstrapReadGate {
        entered: Semaphore::new(0),
        release: Semaphore::new(0),
    });
    *setup.server.rotation_post_stage_live_hold.lock().unwrap() = Some(live_read.clone());
    *setup.server.rotation_abandon_hold.lock().unwrap() = Some(abandon.clone());
    let runtime = setup.runtime.clone();
    let account = setup.account.clone();
    let completing = tokio::spawn(async move {
        runtime
            .request(
                RuntimeRequest::CompleteRotation {
                    account_id: account,
                    selection,
                },
                RequestCancellation::new(),
            )
            .await
    });
    tokio::time::timeout(
        std::time::Duration::from_secs(10),
        live_read.entered.acquire(),
    )
    .await
    .unwrap()
    .unwrap()
    .forget();
    {
        let mut rotation = setup.server.rotation.lock().unwrap();
        let script = rotation.as_mut().unwrap();
        assert_eq!(script.staged.len(), 2);
        script.extra_live_member_role = Some("read-only".into());
    }
    *setup.server.rotation_post_stage_live_hold.lock().unwrap() = None;
    live_read.release.add_permits(1);
    // This is the actual DELETE inside the serialized transport, after both private stages.
    tokio::time::timeout(
        std::time::Duration::from_secs(10),
        abandon.entered.acquire(),
    )
    .await
    .unwrap()
    .unwrap()
    .forget();
    let runtime = setup.runtime.clone();
    let account = setup.account.clone();
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
        .expect("Lock must cancel and drain the held plan DELETE")
        .unwrap()
        .unwrap();
    let stopped = tokio::time::timeout(std::time::Duration::from_secs(5), completing)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert_eq!(stopped.code, RuntimeErrorCode::InvariantViolation);
    let dispatched = setup.server.rotation_abandon_dispatches.lock().unwrap();
    let cancelled = setup.server.rotation_abandon_cancellations.lock().unwrap();
    assert_eq!(dispatched.len(), 1);
    assert_eq!(
        *cancelled, *dispatched,
        "the held external DELETE was cancelled"
    );
    let script = setup.server.rotation.lock().unwrap();
    let script = script.as_ref().unwrap();
    assert_eq!(script.staged.len(), 2);
    assert_eq!(script.finalize_sends, 0);
    assert!(script.abandoned.is_empty(), "held DELETE never completed");
    let snapshot = setup.runtime.replica.snapshot(&setup.account).unwrap();
    assert!(matches!(
        snapshot.rotation_attempts[0].phase,
        crate::replica::RotationAttemptPhase::Consumed { .. }
    ));
    assert!(snapshot.operations.is_empty());
}

#[tokio::test]
async fn private_team_leave_drains_held_abandon_delete_before_runtime_close() {
    let (setup, selection) = prepared_live_role_rotation().await;
    let live_read = Arc::new(BootstrapReadGate {
        entered: Semaphore::new(0),
        release: Semaphore::new(0),
    });
    let abandon = Arc::new(BootstrapReadGate {
        entered: Semaphore::new(0),
        release: Semaphore::new(0),
    });
    *setup.server.rotation_post_stage_live_hold.lock().unwrap() = Some(live_read.clone());
    *setup.server.rotation_abandon_hold.lock().unwrap() = Some(abandon.clone());
    let runtime = setup.runtime.clone();
    let account = setup.account.clone();
    let completing = tokio::spawn(async move {
        runtime
            .request(
                RuntimeRequest::CompleteRotation {
                    account_id: account,
                    selection,
                },
                RequestCancellation::new(),
            )
            .await
    });
    tokio::time::timeout(
        std::time::Duration::from_secs(10),
        live_read.entered.acquire(),
    )
    .await
    .unwrap()
    .unwrap()
    .forget();
    {
        let mut rotation = setup.server.rotation.lock().unwrap();
        let script = rotation.as_mut().unwrap();
        assert_eq!(script.staged.len(), 2);
        script.extra_live_member_role = Some("read-only".into());
    }
    *setup.server.rotation_post_stage_live_hold.lock().unwrap() = None;
    live_read.release.add_permits(1);
    tokio::time::timeout(
        std::time::Duration::from_secs(10),
        abandon.entered.acquire(),
    )
    .await
    .unwrap()
    .unwrap()
    .forget();
    let runtime = setup.runtime.clone();
    tokio::time::timeout(std::time::Duration::from_secs(5), runtime.close())
        .await
        .expect("Runtime close must cancel and drain the held plan DELETE");
    let stopped = tokio::time::timeout(std::time::Duration::from_secs(5), completing)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert_eq!(stopped.code, RuntimeErrorCode::InvariantViolation);
    let dispatched = setup.server.rotation_abandon_dispatches.lock().unwrap();
    let cancelled = setup.server.rotation_abandon_cancellations.lock().unwrap();
    assert_eq!(dispatched.len(), 1);
    assert_eq!(
        *cancelled, *dispatched,
        "the held external DELETE was cancelled"
    );
    let script = setup.server.rotation.lock().unwrap();
    let script = script.as_ref().unwrap();
    assert_eq!(script.finalize_sends, 0);
    assert!(script.abandoned.is_empty(), "held DELETE never completed");
}

#[tokio::test]
async fn private_team_leave_drains_held_stage_on_caller_loss_without_finalizing() {
    let setup = setup().await;
    script_team_leave(
        &setup,
        json!({"status":"applied","rotations":[],"personalTeamId":"personal-1"}),
        false,
        false,
    );
    setup
        .server
        .rotation
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .start_result = json!({
        "status":"applied", "plans":[{
            "id":"private-plan", "vaultId":TEST_VAULT_ID, "initiatorUserId":USER,
            "expectedKeyVersion":1, "state":"preparing",
            "idleExpiresAt":"2026-09-25T01:00:00Z", "absoluteExpiresAt":"2026-09-26T00:00:00Z"
        }]
    });
    script_rotation_pages(&setup, true);
    let RuntimeResponse::RotationPrepared { selection } = setup
        .runtime
        .request(prepare_team_leave(&setup, None), RequestCancellation::new())
        .await
        .unwrap()
    else {
        panic!("private plan selection")
    };
    let RuntimeResponse::RecipientKeyScope { scope } = setup
        .runtime
        .request(
            RuntimeRequest::RecipientKeyScope {
                account_id: setup.account.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("recipient scope")
    };
    setup
        .runtime
        .request(
            RuntimeRequest::VerifyRecipientKey {
                account_id: setup.account.clone(),
                recipient_user_id: "owner-1".into(),
                public_key: rotation_recipient_key().public_key.clone(),
                expected_fingerprint: selection.candidates[0].fingerprint.clone(),
                scope,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let held = Arc::new(BootstrapReadGate {
        entered: Semaphore::new(0),
        release: Semaphore::new(0),
    });
    *setup.server.rotation_stage_hold.lock().unwrap() = Some(held.clone());
    let cancellation = RequestCancellation::new();
    let runtime = setup.runtime.clone();
    let account_id = setup.account.clone();
    let active = cancellation.clone();
    let completing = tokio::spawn(async move {
        runtime
            .request(
                RuntimeRequest::CompleteRotation {
                    account_id,
                    selection,
                },
                active,
            )
            .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(10), held.entered.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    cancellation.cancel();
    held.release.add_permits(1);
    let stopped = tokio::time::timeout(std::time::Duration::from_secs(10), completing)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert_eq!(stopped.code, RuntimeErrorCode::Cancelled);
    let script = setup.server.rotation.lock().unwrap();
    let script = script.as_ref().unwrap();
    assert_eq!(
        script.staged.len(),
        0,
        "held transport drains before any staged page is sent"
    );
    assert_eq!(
        script.abandoned.len(),
        1,
        "caller loss still permits scoped abandon"
    );
    assert_eq!(script.finalize_sends, 0);
    let snapshot = setup.runtime.replica.snapshot(&setup.account).unwrap();
    assert!(matches!(
        snapshot.rotation_attempts[0].phase,
        crate::replica::RotationAttemptPhase::Consumed { .. }
    ));
    assert!(snapshot.operations.is_empty());
}

#[tokio::test]
async fn private_team_leave_retains_exact_finalize_after_its_first_reply_is_lost() {
    let setup = setup().await;
    script_team_leave(
        &setup,
        json!({
            "status":"applied", "personalTeamId":"personal-1",
            "rotations":[{"planId":"private-plan","vaultId":TEST_VAULT_ID,
                "keyVersion":2,"rotationId":"rotation-lost"}]
        }),
        false,
        true,
    );
    setup
        .server
        .rotation
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .start_result = json!({
        "status":"applied", "plans":[{
            "id":"private-plan", "vaultId":TEST_VAULT_ID, "initiatorUserId":USER,
            "expectedKeyVersion":1, "state":"preparing",
            "idleExpiresAt":"2026-09-25T01:00:00Z", "absoluteExpiresAt":"2026-09-26T00:00:00Z"
        }]
    });
    script_rotation_pages(&setup, true);
    let RuntimeResponse::RotationPrepared { selection } = setup
        .runtime
        .request(prepare_team_leave(&setup, None), RequestCancellation::new())
        .await
        .unwrap()
    else {
        panic!("private plan must prepare")
    };
    let RuntimeResponse::RecipientKeyScope { scope } = setup
        .runtime
        .request(
            RuntimeRequest::RecipientKeyScope {
                account_id: setup.account.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("recipient scope")
    };
    setup
        .runtime
        .request(
            RuntimeRequest::VerifyRecipientKey {
                account_id: setup.account.clone(),
                recipient_user_id: "owner-1".into(),
                public_key: rotation_recipient_key().public_key.clone(),
                expected_fingerprint: selection.candidates[0].fingerprint.clone(),
                scope,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    script_rotation_pages(&setup, true);
    let answer = setup
        .runtime
        .request(
            RuntimeRequest::CompleteRotation {
                account_id: setup.account.clone(),
                selection,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert!(matches!(
        answer,
        RuntimeResponse::RotationFinalizePending { .. }
            | RuntimeResponse::RotationRefreshRequired { .. }
    ));
    let snapshot = setup.runtime.replica.snapshot(&setup.account).unwrap();
    assert_eq!(
        snapshot.rotation_fenced_vault_ids(),
        vec![TEST_VAULT_ID.to_owned()]
    );
    let script = setup.server.rotation.lock().unwrap();
    let script = script.as_ref().unwrap();
    assert!(script.lose_finalize);
    assert!(script.finalize_sends >= 1);
    assert!(
        script.abandoned.is_empty(),
        "accepted finalize is never abandoned"
    );
    let finalizes: Vec<_> = script
        .requests
        .iter()
        .filter(|request| request["url"].as_str().unwrap().ends_with("/finalize"))
        .collect();
    assert!(!finalizes.is_empty());
    let exact_body = serde_json::to_vec(&json!({"planIds":["private-plan"]})).unwrap();
    assert!(finalizes
        .iter()
        .all(|request| request["body"] == json!(exact_body)));
    assert!(finalizes
        .iter()
        .all(|request| request["headers"] == finalizes[0]["headers"]));
}

#[tokio::test]
async fn private_nonempty_team_plan_retains_selection_without_finalizing() {
    let setup = setup().await;
    script_team_leave(
        &setup,
        json!({"status":"applied","rotations":[],"personalTeamId":"personal-1"}),
        false,
        false,
    );
    setup
        .server
        .rotation
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .start_result = json!({
        "status":"applied", "plans":[{
            "id":"plan-1", "vaultId":TEST_VAULT_ID, "initiatorUserId":USER,
            "expectedKeyVersion":1, "state":"preparing",
            "idleExpiresAt":"2026-09-23T01:00:00Z", "absoluteExpiresAt":"2026-09-24T00:00:00Z"
        }]
    });
    script_rotation_pages(&setup, true);
    let answer = setup
        .runtime
        .request(prepare_team_leave(&setup, None), RequestCancellation::new())
        .await
        .unwrap();
    let RuntimeResponse::RotationPrepared { selection } = answer else {
        panic!("nonempty plan must be selected")
    };
    let start_operation_id = selection.start_operation_id;
    let plans = selection.plans;
    assert_eq!(plans.len(), 1);
    assert_eq!(plans[0].plan_id, "plan-1");
    let snapshot = setup.runtime.replica.snapshot(&setup.account).unwrap();
    assert_eq!(
        snapshot.rotation_attempts[0].start_operation_id,
        start_operation_id
    );
    assert!(matches!(
        snapshot.rotation_attempts[0].phase,
        crate::replica::RotationAttemptPhase::Prepared
    ));
    assert_eq!(
        setup
            .server
            .rotation
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .finalize_sends,
        0
    );
}

#[tokio::test]
async fn public_nonempty_changed_version_retains_server_plan_without_private_completion() {
    let setup = setup().await;
    script_team_leave(
        &setup,
        json!({"status":"applied","rotations":[],"personalTeamId":"personal-1"}),
        false,
        false,
    );
    setup
        .server
        .rotation
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .start_result = json!({
        "status":"applied", "plans":[{
            "id":"stale-plan", "vaultId":TEST_VAULT_ID, "initiatorUserId":USER,
            "expectedKeyVersion":2, "state":"preparing",
            "idleExpiresAt":"2026-09-23T01:00:00Z", "absoluteExpiresAt":"2026-09-24T00:00:00Z"
        }]
    });
    script_rotation_pages(&setup, true);
    let error = setup
        .runtime
        .request(prepare_team_leave(&setup, None), RequestCancellation::new())
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
    let snapshot = setup.runtime.replica.snapshot(&setup.account).unwrap();
    assert!(snapshot.failure.is_none());
    assert!(snapshot.operations.is_empty());
    assert_eq!(snapshot.receipts.len(), 1);
    assert_eq!(snapshot.rotation_attempts.len(), 1);
    assert!(!snapshot.rotation_attempts[0].start_operation_id.is_empty());
    assert_eq!(snapshot.rotation_attempts[0].plans[0].plan_id, "stale-plan");
    assert!(matches!(
        snapshot.rotation_attempts[0].phase,
        crate::replica::RotationAttemptPhase::Prepared
    ));
    assert_eq!(
        setup
            .server
            .rotation
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .finalize_sends,
        0
    );
    script_rotation_pages(&setup, true);
    run_rotation_preflight(&setup).await.unwrap();
    let inspected = setup
        .runtime
        .request(
            RuntimeRequest::InspectRotation {
                account_id: setup.account.clone(),
                start_operation_id: snapshot.rotation_attempts[0].start_operation_id.clone(),
            },
            RequestCancellation::new(),
        )
        .await;
    assert!(
        inspected.is_err(),
        "later authority cannot revive a stale plan"
    );
}

#[tokio::test]
async fn public_rotation_lock_and_cancel_preserve_account_bound_selection() {
    let setup = setup().await;
    script_team_leave(
        &setup,
        json!({"status":"applied","rotations":[],"personalTeamId":"personal-1"}),
        false,
        false,
    );
    let cancelled = RequestCancellation::new();
    cancelled.cancel();
    let error = setup
        .runtime
        .request(prepare_team_leave(&setup, None), cancelled)
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::Cancelled);
    assert_eq!(
        setup
            .server
            .rotation
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .start_sends,
        0
    );
    script_rotation_pages(&setup, true);
    let RuntimeResponse::RotationPrepared { selection } = setup
        .runtime
        .request(prepare_team_leave(&setup, None), RequestCancellation::new())
        .await
        .unwrap()
    else {
        panic!("start")
    };
    setup
        .runtime
        .request(
            RuntimeRequest::Lock {
                account_id: setup.account.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let error = setup
        .runtime
        .request(
            RuntimeRequest::CompleteRotation {
                account_id: setup.account.clone(),
                selection,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert!(matches!(
        error.code,
        RuntimeErrorCode::InvariantViolation | RuntimeErrorCode::AuthenticationRequired
    ));
    assert_eq!(
        setup
            .server
            .rotation
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .finalize_sends,
        0
    );
}

#[tokio::test]
async fn public_rotation_cancel_during_consumed_ack_leaves_an_orphan_without_finalize() {
    let setup = setup().await;
    script_team_leave(
        &setup,
        json!({"status":"applied","rotations":[],"personalTeamId":"personal-1"}),
        false,
        false,
    );
    script_rotation_pages(&setup, true);
    let RuntimeResponse::RotationPrepared { selection } = setup
        .runtime
        .request(prepare_team_leave(&setup, None), RequestCancellation::new())
        .await
        .unwrap()
    else {
        panic!("start")
    };
    script_rotation_pages(&setup, true);
    setup
        .commits
        .hold_rotation_consume_ack
        .store(true, Ordering::SeqCst);
    let runtime = Arc::clone(&setup.runtime);
    let account_id = setup.account.clone();
    let start_operation_id = selection.start_operation_id.clone();
    let cancellation = RequestCancellation::new();
    let active_cancellation = cancellation.clone();
    let completing = tokio::spawn(async move {
        runtime
            .request(
                RuntimeRequest::CompleteRotation {
                    account_id,
                    selection,
                },
                active_cancellation,
            )
            .await
    });
    setup
        .commits
        .consume_ack_entered
        .acquire()
        .await
        .unwrap()
        .forget();
    let persisted = setup.persistence.state.snapshot(&setup.account).unwrap();
    assert!(matches!(
        persisted.rotation_attempts[0].phase,
        crate::replica::RotationAttemptPhase::Consumed { .. }
    ));
    cancellation.cancel();
    setup.commits.consume_ack_released.notify_one();
    let error = completing.await.unwrap().unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::Cancelled);
    let snapshot = setup.runtime.replica.snapshot(&setup.account).unwrap();
    assert!(matches!(
        snapshot.rotation_attempts[0].phase,
        crate::replica::RotationAttemptPhase::Consumed { .. }
    ));
    assert!(snapshot.operations.is_empty());
    let inspected = setup
        .runtime
        .request(
            RuntimeRequest::InspectRotation {
                account_id: setup.account.clone(),
                start_operation_id,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert!(matches!(
        inspected,
        RuntimeResponse::RotationAttemptConsumed { .. }
    ));
    assert_eq!(
        setup
            .server
            .rotation
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .finalize_sends,
        0
    );
}

#[tokio::test]
async fn public_rotation_pending_lock_during_consumed_ack_leaves_no_finalize() {
    let setup = setup().await;
    script_team_leave(
        &setup,
        json!({"status":"applied","rotations":[],"personalTeamId":"personal-1"}),
        false,
        false,
    );
    script_rotation_pages(&setup, true);
    let RuntimeResponse::RotationPrepared { selection } = setup
        .runtime
        .request(prepare_team_leave(&setup, None), RequestCancellation::new())
        .await
        .unwrap()
    else {
        panic!("start")
    };
    script_rotation_pages(&setup, true);
    setup
        .commits
        .hold_rotation_consume_ack
        .store(true, Ordering::SeqCst);
    let runtime = Arc::clone(&setup.runtime);
    let account_id = setup.account.clone();
    let completing = tokio::spawn(async move {
        runtime
            .request(
                RuntimeRequest::CompleteRotation {
                    account_id,
                    selection,
                },
                RequestCancellation::new(),
            )
            .await
    });
    setup
        .commits
        .consume_ack_entered
        .acquire()
        .await
        .unwrap()
        .forget();
    let runtime = Arc::clone(&setup.runtime);
    let account_id = setup.account.clone();
    let locking = tokio::spawn(async move {
        runtime
            .request(
                RuntimeRequest::Lock { account_id },
                RequestCancellation::new(),
            )
            .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while !setup
            .runtime
            .account_access_retirement_is_pending(&setup.account)
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    setup.commits.consume_ack_released.notify_one();
    let error = completing.await.unwrap().unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::Cancelled);
    locking.await.unwrap().unwrap();
    let snapshot = setup.runtime.replica.snapshot(&setup.account).unwrap();
    assert!(matches!(
        snapshot.rotation_attempts[0].phase,
        crate::replica::RotationAttemptPhase::Consumed { .. }
    ));
    assert!(snapshot.operations.is_empty());
    assert_eq!(
        setup
            .server
            .rotation
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .finalize_sends,
        0
    );
}

#[tokio::test]
async fn public_rotation_late_cancel_and_lock_preserve_admitted_finalize() {
    let setup = setup().await;
    script_team_leave(
        &setup,
        json!({"status":"applied","rotations":[],"personalTeamId":"personal-1"}),
        false,
        false,
    );
    script_rotation_pages(&setup, true);
    let RuntimeResponse::RotationPrepared { selection } = setup
        .runtime
        .request(prepare_team_leave(&setup, None), RequestCancellation::new())
        .await
        .unwrap()
    else {
        panic!("start")
    };
    script_rotation_pages(&setup, true);
    setup
        .commits
        .hold_rotation_consume_ack
        .store(true, Ordering::SeqCst);
    let runtime = Arc::clone(&setup.runtime);
    let account_id = setup.account.clone();
    let cancellation = RequestCancellation::new();
    let active_cancellation = cancellation.clone();
    let completing = tokio::spawn(async move {
        runtime
            .request(
                RuntimeRequest::CompleteRotation {
                    account_id,
                    selection,
                },
                active_cancellation,
            )
            .await
    });
    setup
        .commits
        .consume_ack_entered
        .acquire()
        .await
        .unwrap()
        .forget();
    // The next commit is accepted finalize. Its persistence gate is after the existing
    // foreground admission decision, and before the operation is durable.
    setup.commits.hold_next.store(true, Ordering::SeqCst);
    setup.commits.consume_ack_released.notify_one();
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        setup.commits.entered.acquire(),
    )
    .await
    .unwrap()
    .unwrap()
    .forget();
    cancellation.cancel();
    let runtime = Arc::clone(&setup.runtime);
    let account_id = setup.account.clone();
    let locking = tokio::spawn(async move {
        runtime
            .request(
                RuntimeRequest::Lock { account_id },
                RequestCancellation::new(),
            )
            .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while !setup
            .runtime
            .account_access_retirement_is_pending(&setup.account)
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    setup.commits.released.notify_one();
    let _ = tokio::time::timeout(std::time::Duration::from_secs(10), completing)
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(10), locking)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let snapshot = setup.runtime.replica.snapshot(&setup.account).unwrap();
    let finalize_operation_id = match &snapshot.rotation_attempts[0].phase {
        crate::replica::RotationAttemptPhase::Finalizing {
            finalize_operation_id,
            ..
        }
        | crate::replica::RotationAttemptPhase::AppliedAwaitingRefresh {
            finalize_operation_id,
            ..
        }
        | crate::replica::RotationAttemptPhase::Completed {
            finalize_operation_id,
            ..
        }
        | crate::replica::RotationAttemptPhase::RejectedAwaitingRefresh {
            finalize_operation_id,
            ..
        }
        | crate::replica::RotationAttemptPhase::Rejected {
            finalize_operation_id,
            ..
        } => finalize_operation_id,
        other => panic!("admitted finalize was erased: {other:?}"),
    };
    assert!(
        snapshot
            .operations
            .iter()
            .any(|operation| operation.operation_id == *finalize_operation_id)
            || snapshot
                .receipts
                .iter()
                .any(|receipt| receipt.operation_id == *finalize_operation_id)
    );
}

#[tokio::test]
async fn public_rotation_rejects_edited_and_replaced_authority_generation() {
    let setup = setup().await;
    script_team_leave(
        &setup,
        json!({"status":"applied","rotations":[],"personalTeamId":"personal-1"}),
        false,
        false,
    );
    script_rotation_pages(&setup, true);
    let RuntimeResponse::RotationPrepared { selection } = setup
        .runtime
        .request(prepare_team_leave(&setup, None), RequestCancellation::new())
        .await
        .unwrap()
    else {
        panic!("start")
    };
    let mut edited = selection.clone();
    edited.authority_generation_id = "host-edited-generation".into();
    assert!(setup
        .runtime
        .request(
            RuntimeRequest::CompleteRotation {
                account_id: setup.account.clone(),
                selection: edited,
            },
            RequestCancellation::new(),
        )
        .await
        .is_err());
    script_rotation_pages(&setup, true);
    let fresh = run_rotation_preflight(&setup).await.unwrap();
    assert_ne!(
        fresh.bootstrap.active_generation.as_ref().unwrap().0,
        selection.authority_generation_id
    );
    assert!(setup
        .runtime
        .request(
            RuntimeRequest::CompleteRotation {
                account_id: setup.account.clone(),
                selection,
            },
            RequestCancellation::new(),
        )
        .await
        .is_err());
    let snapshot = setup.runtime.replica.snapshot(&setup.account).unwrap();
    assert!(matches!(
        snapshot.rotation_attempts[0].phase,
        crate::replica::RotationAttemptPhase::Prepared
    ));
    assert_eq!(
        setup
            .server
            .rotation
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .finalize_sends,
        0
    );
}

#[tokio::test]
async fn failed_atomic_finalize_accept_leaves_consumed_orphan_without_http() {
    let setup = setup().await;
    script_team_leave(
        &setup,
        json!({"status":"applied","rotations":[],"personalTeamId":"personal-1"}),
        false,
        false,
    );
    script_rotation_pages(&setup, true);
    let RuntimeResponse::RotationPrepared { selection } = setup
        .runtime
        .request(prepare_team_leave(&setup, None), RequestCancellation::new())
        .await
        .unwrap()
    else {
        panic!("start")
    };
    setup
        .commits
        .reject_rotation_finalize_accept
        .store(true, Ordering::SeqCst);
    let start_operation_id = selection.start_operation_id.clone();
    let failure = setup
        .runtime
        .request(
            RuntimeRequest::CompleteRotation {
                account_id: setup.account.clone(),
                selection,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(failure.code, RuntimeErrorCode::StorageUnavailable);
    let persisted = setup
        .runtime
        .replica
        .load(&setup.account)
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        persisted.rotation_attempts[0].phase,
        crate::replica::RotationAttemptPhase::Consumed { .. }
    ));
    assert!(persisted.operations.is_empty());
    assert_eq!(
        setup
            .server
            .rotation
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .finalize_sends,
        0
    );
    let inspected = setup
        .runtime
        .request(
            RuntimeRequest::InspectRotation {
                account_id: setup.account.clone(),
                start_operation_id,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert!(matches!(
        inspected,
        RuntimeResponse::RotationAttemptConsumed { .. }
    ));
}

#[tokio::test]
async fn rotation_preflight_forces_new_ready_generation_and_requires_versioned_pages() {
    for capable in [false, true] {
        let setup = setup().await;
        let before = setup.runtime.replica.snapshot(&setup.account).unwrap();
        let mut authority = before.bootstrap.snapshot();
        if capable {
            for vault in &mut authority.visible_vaults {
                vault.key_version = Some(1);
            }
        }
        let mut vault_page = json!({
            "phase":"vaults", "vaults":authority.visible_vaults,
            "hasMore":false, "nextCursor":null, "syncCursor":null
        });
        if capable {
            vault_page["vaultKeyVersionIncluded"] = true.into();
        }
        setup.server.bootstrap_pages.lock().unwrap().extend([
            vault_page,
            json!({
                "phase":"items", "items":authority.visible_items,
                "hasMore":false, "nextCursor":null, "syncCursor":null
            }),
        ]);
        let result = run_rotation_preflight(&setup).await;
        assert_eq!(
            setup.server.bootstrap_reads.load(Ordering::SeqCst),
            2,
            "a Ready head cannot substitute for a fresh version-capable generation"
        );
        if capable {
            let after = result.unwrap();
            assert_ne!(
                after.bootstrap.active_generation,
                before.bootstrap.active_generation
            );
            assert!(
                after.bootstrap.generations[after.bootstrap.active_generation.as_ref().unwrap()]
                    .vault_key_version_proved
            );
        } else {
            let error = match result {
                Ok(_) => panic!("old Server must refuse before start"),
                Err(error) => error,
            };
            assert_eq!(error.code, RuntimeErrorCode::VersionEvidenceUnavailable);
        }
        setup.runtime.close().await;
    }
}

#[tokio::test]
async fn rotation_preflight_uses_the_structural_refresh_completed_after_its_pinned_cursor() {
    for second_capable in [true, false] {
        let setup = setup().await;
        let before = setup.runtime.replica.snapshot(&setup.account).unwrap();
        let mut authority = before.bootstrap.snapshot();
        for vault in &mut authority.visible_vaults {
            vault.key_version = Some(1);
        }
        let first_vaults = authority.visible_vaults.clone();
        let first_items = authority.visible_items.clone();
        let second_vaults = authority.visible_vaults;
        let second_items = authority.visible_items;
        let mut second_vault_page = json!({
            "phase":"vaults", "vaults":second_vaults,
            "hasMore":false, "nextCursor":null,
            "syncCursor":{"id":"rotation-event"}
        });
        if second_capable {
            second_vault_page["vaultKeyVersionIncluded"] = true.into();
        }
        setup.server.bootstrap_pages.lock().unwrap().extend([
            json!({
                "phase":"vaults", "vaults":first_vaults,
                "hasMore":false, "nextCursor":null, "syncCursor":null,
                "vaultKeyVersionIncluded":true
            }),
            json!({
                "phase":"items", "items":first_items,
                "hasMore":false, "nextCursor":null, "syncCursor":null
            }),
            second_vault_page,
            json!({
                "phase":"items", "items":second_items,
                "hasMore":false, "nextCursor":null,
                "syncCursor":{"id":"rotation-event"}
            }),
        ]);
        setup.server.finite.script_sync_page(
            vec![json!({
                "id":"rotation-event", "type":"vault_updated", "entityType":"vault",
                "entityId":TEST_VAULT_ID, "userId":USER, "vaultId":TEST_VAULT_ID,
                "clientId":null, "metadata":null, "timestamp":"1700000000000", "version":2
            })],
            "rotation-event",
            false,
        );
        setup
            .server
            .finite
            .script_sync_page(Vec::new(), "rotation-event", false);
        let result = run_rotation_preflight(&setup).await;
        assert_eq!(
            setup.server.bootstrap_reads.load(Ordering::SeqCst),
            4,
            "structural change after the first pinned watermark needs another full generation"
        );
        if second_capable {
            let after = result.unwrap();
            assert_ne!(
                after.bootstrap.active_generation,
                before.bootstrap.active_generation
            );
            assert!(
                after.bootstrap.generations[after.bootstrap.active_generation.as_ref().unwrap()]
                    .vault_key_version_proved
            );
        } else {
            let error = match result {
                Ok(_) => panic!("second generation lacks version proof"),
                Err(error) => error,
            };
            assert_eq!(error.code, RuntimeErrorCode::VersionEvidenceUnavailable);
        }
        setup.runtime.close().await;
    }
}

#[tokio::test]
async fn failed_rotation_refresh_abandons_only_its_stage_and_retains_the_previous_duty() {
    for refresh_required in [false, true] {
        let setup = setup().await;
        if refresh_required {
            let before = setup.runtime.replica.snapshot(&setup.account).unwrap();
            assert!(matches!(
                setup
                    .runtime
                    .replica
                    .mark_refresh_required(MarkRefreshRequiredPlan {
                        guard: BootstrapGuard {
                            account_id: before.account_id.clone(),
                            user_id: before.user_id.clone(),
                            incarnation: before.incarnation.clone(),
                            expected_replica_revision: before.revision,
                            expected_lock_epoch: before.lock_epoch,
                        },
                    })
                    .await
                    .unwrap(),
                PlanResult::Applied { .. }
            ));
        }
        let before = setup.runtime.replica.snapshot(&setup.account).unwrap();
        setup
            .server
            .bootstrap_pages
            .lock()
            .unwrap()
            .push_back(json!({
                "type":"networkFailure"
            }));
        assert!(run_rotation_preflight(&setup).await.is_err());
        let after = setup.runtime.replica.snapshot(&setup.account).unwrap();
        assert_eq!(
            after.bootstrap.active_generation,
            before.bootstrap.active_generation
        );
        assert!(after.bootstrap.staging_generation.is_none());
        assert_eq!(after.bootstrap.state, before.bootstrap.state);
        assert_eq!(setup.server.bootstrap_reads.load(Ordering::SeqCst), 1);
        setup.runtime.close().await;
    }
}

#[tokio::test]
async fn native_travel_verification_refusal_does_not_leave_the_forced_rotation_stage_open() {
    let setup = setup().await;
    let before = setup.runtime.replica.snapshot(&setup.account).unwrap();
    setup
        .runtime
        .foreground_attachments
        .receive_native_policy_verification(
            super::foreground_attachment_lifecycle::NativeVerificationToken {
                account_id: setup.account.clone(),
                incarnation: before.incarnation.clone(),
                channel: "desktop-policy".into(),
                source: super::native_authority::NativeAccountScope {
                    account_id: setup.account.clone(),
                    incarnation: before.incarnation.clone(),
                    lock_epoch: before.lock_epoch,
                    server_url: SERVER_URL.into(),
                    user_id: before.user_id.clone(),
                },
                revision: 1,
            },
            true,
        )
        .unwrap();

    let result = run_rotation_preflight(&setup).await;
    assert!(
        result.is_err(),
        "pending native Travel proof cannot start Rotation"
    );
    let after = setup.runtime.replica.snapshot(&setup.account).unwrap();
    assert_eq!(
        after.bootstrap.active_generation,
        before.bootstrap.active_generation
    );
    assert!(
        after.bootstrap.staging_generation.is_none(),
        "the owned stage must be abandoned"
    );
    assert!(
        after.bootstrap.policy_verification_pending,
        "Travel duty must remain"
    );
    assert_eq!(setup.server.bootstrap_reads.load(Ordering::SeqCst), 0);
    setup.runtime.close().await;
}

#[tokio::test]
async fn held_old_vault_page_neither_populates_nor_abandons_a_replacement_generation() {
    // Controlled Replica/HTTP seam: ordinary callers serialize Account execution, but the
    // captured request must still fail closed if its exact stage was retired while HTTP held it.
    let setup = setup().await;
    let gate = Arc::new(BootstrapReadGate {
        entered: Semaphore::new(0),
        release: Semaphore::new(0),
    });
    *setup.server.bootstrap_hold.lock().unwrap() = Some(gate.clone());
    let mut authority = setup
        .runtime
        .replica
        .snapshot(&setup.account)
        .unwrap()
        .bootstrap
        .snapshot();
    authority.visible_vaults[0].key_version = Some(1);
    setup
        .server
        .bootstrap_pages
        .lock()
        .unwrap()
        .push_back(json!({
            "phase":"vaults", "vaults":authority.visible_vaults,
            "hasMore":false, "nextCursor":null, "syncCursor":null,
            "vaultKeyVersionIncluded":true
        }));
    let runtime = setup.runtime.clone();
    let account = setup.account.clone();
    let task = tokio::spawn(async move {
        let before = runtime.replica.snapshot(&account).unwrap();
        let metadata = runtime
            .platform_storage
            .load_account_metadata(&account, &before.incarnation)
            .await
            .unwrap()
            .unwrap();
        let session = runtime
            .effective_session(&account, &before.incarnation)
            .await
            .unwrap()
            .unwrap();
        let http = AuthHttpClient::new(
            &runtime.http_transport,
            &metadata.normalized_server_url,
            metadata.insecure_transport_confirmed,
            runtime.auth_client_config.clone().unwrap(),
        )
        .unwrap();
        runtime
            .preflight_rotation_authority(&account, &http, session, RequestCancellation::new())
            .await
    });
    permit(&gate.entered).await;
    let held = setup.runtime.replica.snapshot(&setup.account).unwrap();
    let old = held.bootstrap.staging_generation.clone().unwrap();
    let guard = |snapshot: &ReplicaSnapshot| BootstrapGuard {
        account_id: snapshot.account_id.clone(),
        user_id: snapshot.user_id.clone(),
        incarnation: snapshot.incarnation.clone(),
        expected_replica_revision: snapshot.revision,
        expected_lock_epoch: snapshot.lock_epoch,
    };
    assert!(matches!(
        setup
            .runtime
            .replica
            .abandon_bootstrap(AbandonBootstrapPlan {
                guard: guard(&held),
                generation_id: old.clone(),
            })
            .await
            .unwrap(),
        PlanResult::Applied { .. }
    ));
    let after_abandon = setup.runtime.replica.snapshot(&setup.account).unwrap();
    let replacement = BootstrapGenerationId("replacement-generation".into());
    assert!(matches!(
        setup
            .runtime
            .replica
            .begin_bootstrap(BeginBootstrapPlan {
                guard: guard(&after_abandon),
                generation_id: replacement.clone(),
            })
            .await
            .unwrap(),
        PlanResult::Applied { .. }
    ));
    gate.release.add_permits(1);
    let error = task.await.unwrap().unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
    let after = setup.runtime.replica.snapshot(&setup.account).unwrap();
    assert_eq!(
        after.bootstrap.staging_generation,
        Some(replacement.clone())
    );
    assert!(after
        .bootstrap
        .pages
        .keys()
        .all(|(id, _)| id != &replacement));
    assert!(after
        .bootstrap
        .vaults
        .keys()
        .all(|(id, _)| id != &replacement));
    assert_eq!(setup.server.bootstrap_reads.load(Ordering::SeqCst), 1);
    setup.runtime.close().await;
}

#[tokio::test]
async fn nonpositive_bootstrap_key_version_refuses_before_authority_promotion() {
    let setup = setup().await;
    let before = setup.runtime.replica.snapshot(&setup.account).unwrap();
    let mut authority = before.bootstrap.snapshot();
    authority.visible_vaults[0].key_version = Some(0);
    setup
        .server
        .bootstrap_pages
        .lock()
        .unwrap()
        .push_back(json!({
            "phase":"vaults", "vaults":authority.visible_vaults,
            "hasMore":false, "nextCursor":null, "syncCursor":null,
            "vaultKeyVersionIncluded":true
        }));
    let error = match run_rotation_preflight(&setup).await {
        Ok(_) => panic!("zero version cannot prove current Vault authority"),
        Err(error) => error,
    };
    assert_eq!(
        error.code,
        RuntimeErrorCode::VersionEvidenceUnavailable,
        "{}",
        error.message
    );
    let after = setup.runtime.replica.snapshot(&setup.account).unwrap();
    assert_eq!(
        after.bootstrap.active_generation,
        before.bootstrap.active_generation
    );
    assert_eq!(after.bootstrap.state, ReplicaState::Ready);
    assert!(after.bootstrap.staging_generation.is_none());
    assert_eq!(setup.server.bootstrap_reads.load(Ordering::SeqCst), 1);
    setup.runtime.close().await;
}
async fn permit(semaphore: &Semaphore) {
    tokio::time::timeout(std::time::Duration::from_secs(2), semaphore.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
}
async fn until(mut predicate: impl FnMut() -> bool) {
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while !predicate() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}
fn cursor(setup: &Setup) -> SyncCursor {
    setup
        .runtime
        .replica
        .snapshot(&setup.account)
        .unwrap()
        .bootstrap
        .active_cursor
}

#[tokio::test]
async fn quiet_stream_refreshes_local_vault_completion_without_reopening_or_unrelated_fetches() {
    let setup = setup().await;
    let task = tokio::spawn(setup.runtime.clone().run_live_sync());
    permit(&setup.server.changes).await;
    until(|| setup.server.stream_reads.load(Ordering::SeqCst) == 1).await;
    let response = setup
        .runtime
        .request(
            RuntimeRequest::UpdateVault {
                account_id: setup.account.clone(),
                vault_id: TEST_VAULT_ID.into(),
                name: Some("Renamed Vault".into()),
                icon: crate::VaultIconPatch::Unchanged,
                image: crate::VaultImageChange::Unchanged,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let RuntimeResponse::VaultUpdateAccepted { operation_id, .. } = response else {
        panic!("Vault update accepted");
    };
    // Acceptance republishes Operations but carries no new Vault authority or refresh obligation.
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
    assert_eq!(setup.server.bootstrap_reads.load(Ordering::SeqCst), 0);
    assert_eq!(setup.server.stream_reads.load(Ordering::SeqCst), 1);
    let mut authority = setup
        .runtime
        .replica
        .snapshot(&setup.account)
        .unwrap()
        .bootstrap
        .snapshot();
    authority.visible_vaults[0].name = "Renamed Vault".into();
    setup.server.bootstrap_pages.lock().unwrap().extend([
        json!({"phase":"vaults","vaults":authority.visible_vaults,"hasMore":false,"nextCursor":null,"syncCursor":null}),
        json!({"phase":"items","items":authority.visible_items,"hasMore":false,"nextCursor":null,"syncCursor":null}),
    ]);
    setup
        .runtime
        .dispatch_once_ignoring_lease(&setup.account, &operation_id)
        .await;
    until(|| {
        let projection = setup.runtime.projection(&ObservationRequest::Items { account_id: setup.account.clone() }).unwrap().projection;
        matches!(projection, RuntimeProjection::Items(items) if items.vaults.iter().any(|vault| vault.name == "Renamed Vault"))
    }).await;
    assert_eq!(setup.server.bootstrap_reads.load(Ordering::SeqCst), 2);
    assert_eq!(setup.server.opens.lock().unwrap().len(), 1);
    assert_eq!(
        setup.server.stream_reads.load(Ordering::SeqCst),
        1,
        "local publications preserve the pending stream read"
    );
    assert!(setup.server.cancelled.lock().unwrap().is_empty());
    // The same reader still consumes the next real frame after local refresh.
    setup.server.change(false, "after-local-refresh");
    setup.server.hint(b"event: sync\ndata: {}\n\n");
    until(|| {
        cursor(&setup)
            == SyncCursor::CapturedValue {
                id: "after-local-refresh".into(),
            }
    })
    .await;
    assert_eq!(setup.server.bootstrap_reads.load(Ordering::SeqCst), 2);
    setup.runtime.close().await;
    task.await.unwrap();
}

#[tokio::test]
async fn held_stream_delivers_idle_authority_and_does_not_hold_the_mutation_fence() {
    let setup = setup().await;
    let task = tokio::spawn(setup.runtime.clone().run_live_sync());
    permit(&setup.server.opened).await;
    permit(&setup.server.changes).await;
    let accepted = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        setup.runtime.request(
            RuntimeRequest::CreateItem {
                account_id: setup.account.clone(),
                vault_id: TEST_VAULT_ID.into(),
                draft: draft(),
            },
            RequestCancellation::new(),
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(matches!(accepted, RuntimeResponse::Accepted { .. }));
    setup.server.change(false, "event-2");
    setup
        .server
        .hint(b"event: sync\ndata: {\"cursor\":\"forged\"}\n\n");
    until(|| {
        cursor(&setup)
            == SyncCursor::CapturedValue {
                id: "event-2".into(),
            }
    })
    .await;
    let snapshot = setup.runtime.replica.snapshot(&setup.account).unwrap();
    assert_eq!(snapshot.operations.len(), 1);
    assert!(
        snapshot
            .bootstrap
            .snapshot()
            .visible_items
            .iter()
            .find(|item| item.id == "item-existing")
            .unwrap()
            .favorite
    );
    assert_eq!(setup.server.opens.lock().unwrap().len(), 1);
    setup.runtime.close().await;
    task.await.unwrap();
    assert!(setup.server.streams.lock().unwrap().is_empty());
}

#[tokio::test]
async fn first_connected_frame_closes_subscribe_race_and_repeated_connected_frames_are_inert() {
    let setup = setup().await;
    let task = tokio::spawn(setup.runtime.clone().run_live_sync());
    permit(&setup.server.changes).await;
    setup.server.change(false, "event-race");
    setup.server.hint(b"event: connected\ndata: {}\n\n");
    until(|| {
        cursor(&setup)
            == SyncCursor::CapturedValue {
                id: "event-race".into(),
            }
    })
    .await;
    permit(&setup.server.changes).await;
    setup
        .server
        .hint(b"event: connected\ndata: {}\n\n: heartbeat\n\n");
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
    assert_eq!(setup.server.changes.available_permits(), 0);
    assert_eq!(setup.server.opens.lock().unwrap().len(), 1);
    setup.runtime.close().await;
    task.await.unwrap();
}

#[tokio::test]
async fn remote_permanent_delete_removes_authority_before_advancing_its_cursor() {
    let setup = setup().await;
    let task = tokio::spawn(setup.runtime.clone().run_live_sync());
    permit(&setup.server.changes).await;
    setup.server.change(true, "event-delete");
    setup.server.hint(b"event: sync\ndata: {}\n\n");
    until(|| {
        cursor(&setup)
            == SyncCursor::CapturedValue {
                id: "event-delete".into(),
            }
    })
    .await;
    assert!(setup
        .runtime
        .replica
        .snapshot(&setup.account)
        .unwrap()
        .bootstrap
        .snapshot()
        .visible_items
        .is_empty());
    setup.runtime.close().await;
    task.await.unwrap();
}

#[tokio::test]
async fn eof_backs_off_and_lock_drains_the_stream_and_timer_without_deleting_work() {
    let setup = setup().await;
    let task = tokio::spawn(setup.runtime.clone().run_live_sync());
    permit(&setup.server.changes).await;
    let accepted = setup
        .runtime
        .request(
            RuntimeRequest::CreateItem {
                account_id: setup.account.clone(),
                vault_id: TEST_VAULT_ID.into(),
                draft: draft(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert!(matches!(accepted, RuntimeResponse::Accepted { .. }));
    let before = setup
        .runtime
        .replica
        .snapshot(&setup.account)
        .unwrap()
        .operations;
    setup.server.send(json!({"type":"ended"}));
    until(|| setup.timer.requested() == vec![1_000]).await;
    assert!(setup.server.streams.lock().unwrap().is_empty());
    assert_eq!(setup.server.opens.lock().unwrap().len(), 1);
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        setup.runtime.mark_account_locked(&setup.account),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        setup
            .runtime
            .replica
            .snapshot(&setup.account)
            .unwrap()
            .operations,
        before
    );
    assert!(setup
        .runtime
        .replica
        .snapshot(&setup.account)
        .unwrap()
        .failure
        .is_none());
    setup.timer.released.notify_waiters();
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
    assert_eq!(setup.server.opens.lock().unwrap().len(), 1);
    setup.runtime.close().await;
    task.await.unwrap();
}

#[tokio::test]
async fn live_sync_open_renews_once_and_second_401_parks_without_deleting_accepted_work() {
    for statuses in [vec![401, 200], vec![401, 401]] {
        let setup = setup().await;
        setup
            .server
            .statuses
            .lock()
            .unwrap()
            .extend(statuses.clone());
        *setup.server.finite.refresh.lock().unwrap() = RefreshBehavior::Renews(SECOND_TOKEN);
        setup
            .runtime
            .request(
                RuntimeRequest::CreateItem {
                    account_id: setup.account.clone(),
                    vault_id: TEST_VAULT_ID.into(),
                    draft: draft(),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap();
        let work = setup
            .runtime
            .replica
            .snapshot(&setup.account)
            .unwrap()
            .operations;
        let task = tokio::spawn(setup.runtime.clone().run_live_sync());
        permit(&setup.server.opened).await;
        permit(&setup.server.opened).await;
        assert_eq!(setup.server.finite.refresh_calls.load(Ordering::SeqCst), 1);
        let opens = setup.server.opens.lock().unwrap().clone();
        let authorization = |request: &Value| {
            request["headers"]
                .as_array()
                .unwrap()
                .iter()
                .find(|header| header["name"] == "Authorization")
                .unwrap()["value"]
                .as_str()
                .unwrap()
                .to_owned()
        };
        assert_eq!(authorization(&opens[0]), format!("Bearer {FIRST_TOKEN}"));
        assert_eq!(authorization(&opens[1]), format!("Bearer {SECOND_TOKEN}"));
        if statuses[1] == 401 {
            until(|| {
                setup
                    .runtime
                    .waiting_reasons
                    .lock()
                    .unwrap()
                    .get(&setup.account)
                    == Some(&AccountWaitingReason::ReauthenticationRequired)
            })
            .await;
            assert!(setup.server.streams.lock().unwrap().is_empty());
        } else {
            permit(&setup.server.changes).await;
            assert_eq!(setup.server.streams.lock().unwrap().len(), 1);
        }
        assert_eq!(
            setup
                .runtime
                .replica
                .snapshot(&setup.account)
                .unwrap()
                .operations,
            work
        );
        assert!(setup
            .runtime
            .replica
            .snapshot(&setup.account)
            .unwrap()
            .failure
            .is_none());
        setup.runtime.close().await;
        task.await.unwrap();
    }
}

#[tokio::test]
async fn live_sync_remote_operation_events_advance_without_guessing_another_devices_fingerprint() {
    let setup = setup().await;
    let task = tokio::spawn(setup.runtime.clone().run_live_sync());
    permit(&setup.server.changes).await;
    setup
        .server
        .finite
        .script_operation_event("another-devices-operation", "foreign-event");
    setup.server.hint(b"event: sync\ndata: {}\n\n");
    until(|| {
        cursor(&setup)
            == SyncCursor::CapturedValue {
                id: "foreign-event".into(),
            }
    })
    .await;
    assert_eq!(setup.server.finite.outcome_lookups(), 0);
    assert!(setup
        .runtime
        .replica
        .snapshot(&setup.account)
        .unwrap()
        .failure
        .is_none());
    setup.runtime.close().await;
    task.await.unwrap();
}

#[tokio::test]
async fn live_sync_failed_authority_commit_preserves_cursor_and_reconnect_replays_the_page() {
    let setup = setup().await;
    let task = tokio::spawn(setup.runtime.clone().run_live_sync());
    permit(&setup.server.changes).await;
    let before = cursor(&setup);
    setup.persistence.fail_next_commits(1);
    setup.server.change(false, "event-retry");
    setup.server.hint(b"event: sync\ndata: {}\n\n");
    until(|| setup.timer.requested() == vec![1_000]).await;
    assert_eq!(setup.persistence.failed_commits(), 1);
    assert_eq!(cursor(&setup), before);
    assert!(
        !setup
            .runtime
            .replica
            .snapshot(&setup.account)
            .unwrap()
            .bootstrap
            .snapshot()
            .visible_items[0]
            .favorite
    );
    // The Server still owns the same page because its Cursor was never advanced locally.
    setup.server.change(false, "event-retry");
    setup.timer.released.notify_one();
    permit(&setup.server.opened).await;
    permit(&setup.server.opened).await;
    until(|| {
        cursor(&setup)
            == SyncCursor::CapturedValue {
                id: "event-retry".into(),
            }
    })
    .await;
    assert_eq!(setup.server.opens.lock().unwrap().len(), 2);
    assert_eq!(
        setup
            .runtime
            .replica
            .snapshot(&setup.account)
            .unwrap()
            .bootstrap
            .snapshot()
            .visible_items[0]
            .version,
        2
    );
    setup.runtime.close().await;
    task.await.unwrap();
}

#[tokio::test]
async fn live_sync_delayed_absence_cannot_remove_a_newer_authority_revision() {
    let setup = setup().await;
    let before = setup.runtime.replica.snapshot(&setup.account).unwrap();
    let guard = crate::replica::BootstrapGuard {
        account_id: setup.account.clone(),
        user_id: before.user_id.clone(),
        incarnation: before.incarnation.clone(),
        expected_replica_revision: before.revision,
        expected_lock_epoch: before.lock_epoch,
    };
    let mut item = before.bootstrap.snapshot().visible_items[0].clone();
    item.version = 3;
    assert!(matches!(
        setup
            .runtime
            .replica
            .apply_sync_item_authority(
                guard.clone(),
                before.bootstrap.active_cursor.clone(),
                item.id.clone(),
                Some(item)
            )
            .await
            .unwrap(),
        crate::replica::PlanResult::Applied { .. }
    ));
    assert!(matches!(
        setup
            .runtime
            .replica
            .apply_sync_item_authority(
                guard,
                before.bootstrap.active_cursor.clone(),
                "item-existing".into(),
                None
            )
            .await
            .unwrap(),
        crate::replica::PlanResult::Stale { .. }
    ));
    let after = setup.runtime.replica.snapshot(&setup.account).unwrap();
    assert_eq!(after.bootstrap.snapshot().visible_items[0].version, 3);
    assert_eq!(
        after.bootstrap.active_cursor,
        before.bootstrap.active_cursor
    );
    setup.runtime.close().await;
}

#[tokio::test]
async fn malformed_change_page_never_applies_authority_or_repeats_without_backoff() {
    for (next, has_more, empty) in [
        (None, true, false),
        (Some(""), false, false),
        (Some("bootstrap-watermark"), true, false),
        (None, true, true),
    ] {
        let setup = setup().await;
        let task = tokio::spawn(setup.runtime.clone().run_live_sync());
        permit(&setup.server.changes).await;
        setup.server.change(false, "event-before-malformed");
        setup.server.hint(b"event: sync\ndata: {}\n\n");
        until(|| {
            cursor(&setup)
                == SyncCursor::CapturedValue {
                    id: "event-before-malformed".into(),
                }
        })
        .await;
        permit(&setup.server.changes).await;
        let before = setup.runtime.replica.snapshot(&setup.account).unwrap();
        let same = match &before.bootstrap.active_cursor {
            SyncCursor::CapturedValue { id } => id.clone(),
            _ => panic!("seed must have a captured nonempty Cursor"),
        };
        setup.server.change(false, "malformed-event");
        let mut page = setup
            .server
            .finite
            .sync_pages
            .lock()
            .unwrap()
            .pop_back()
            .unwrap();
        page["cursor"] = match next {
            Some("bootstrap-watermark") => json!({"id":same}),
            Some(value) => json!({"id":value}),
            None => Value::Null,
        };
        page["hasMore"] = json!(has_more);
        if empty {
            page["events"] = json!([]);
        }
        setup
            .server
            .finite
            .sync_pages
            .lock()
            .unwrap()
            .push_back(page);
        setup.server.hint(b"event: sync\ndata: {}\n\n");
        until(|| setup.timer.requested() == vec![1_000]).await;
        let after = setup.runtime.replica.snapshot(&setup.account).unwrap();
        assert_eq!(
            after.bootstrap.active_cursor,
            before.bootstrap.active_cursor
        );
        assert_eq!(
            after.bootstrap.snapshot().visible_items,
            before.bootstrap.snapshot().visible_items
        );
        assert_eq!(setup.server.changes.available_permits(), 1);
        assert_eq!(setup.server.opens.lock().unwrap().len(), 1);
        setup.runtime.close().await;
        task.await.unwrap();
    }
}

#[tokio::test]
async fn held_stream_lifecycle_cancellation_preserves_or_deletes_only_the_requested_scope() {
    for action in ["sign-out", "remove", "wipe", "failure"] {
        let setup = setup().await;
        setup
            .runtime
            .request(
                RuntimeRequest::CreateItem {
                    account_id: setup.account.clone(),
                    vault_id: TEST_VAULT_ID.into(),
                    draft: draft(),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap();
        let work = setup
            .runtime
            .replica
            .snapshot(&setup.account)
            .unwrap()
            .operations;
        assert_eq!(work.len(), 1);
        let task = tokio::spawn(setup.runtime.clone().run_live_sync());
        permit(&setup.server.changes).await;
        let sender = setup
            .server
            .streams
            .lock()
            .unwrap()
            .values()
            .next()
            .unwrap()
            .sender
            .clone();
        if action == "failure" {
            setup
                .persistence
                .state
                .fail(&setup.account, RuntimeErrorCode::InvariantViolation)
                .unwrap();
            setup
                .runtime
                .replica
                .cache(setup.persistence.state.snapshot(&setup.account).unwrap());
            setup.runtime.publish_all();
        } else {
            let request = match action {
                "sign-out" => RuntimeRequest::SignOut {
                    account_id: setup.account.clone(),
                },
                "remove" => RuntimeRequest::RemoveAccount {
                    account_id: setup.account.clone(),
                },
                "wipe" => RuntimeRequest::Wipe,
                _ => unreachable!(),
            };
            tokio::time::timeout(
                std::time::Duration::from_secs(2),
                setup.runtime.request(request, RequestCancellation::new()),
            )
            .await
            .unwrap()
            .unwrap();
        }
        until(|| setup.server.streams.lock().unwrap().is_empty()).await;
        assert_eq!(setup.server.cancelled.lock().unwrap().len(), 1, "{action}");
        assert!(sender
            .send(json!({"type":"chunk","bytes":b"event: sync\ndata: {}\n\n"}))
            .is_err());
        setup.timer.released.notify_waiters();
        setup.runtime.publish_all();
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        assert_eq!(setup.server.opens.lock().unwrap().len(), 1, "{action}");
        assert!(setup.timer.requested().is_empty());
        if matches!(action, "remove" | "wipe") {
            assert!(
                setup.persistence.state.snapshot(&setup.account).is_none(),
                "{action}"
            );
        } else {
            assert_eq!(
                setup
                    .persistence
                    .state
                    .snapshot(&setup.account)
                    .unwrap()
                    .operations,
                work,
                "{action}"
            );
        }
        setup.runtime.close().await;
        task.await.unwrap();
    }
}

#[tokio::test]
async fn hint_queued_while_authority_commit_is_held_is_reconciled_after_that_exact_page() {
    let setup = setup().await;
    let runner = tokio::spawn(setup.runtime.clone().run_live_sync());
    permit(&setup.server.changes).await;
    setup.commits.hold_next.store(true, Ordering::SeqCst);
    setup.server.change(false, "held-page");
    setup.server.hint(b"event: sync\ndata: {}\n\n");
    permit(&setup.commits.entered).await;
    assert_eq!(cursor(&setup), SyncCursor::CapturedEmpty);
    setup.server.change(false, "queued-page");
    {
        let mut items = setup.server.finite.created_items.lock().unwrap();
        items[0].version = 3;
        items[0].favorite = false;
    }
    setup.server.hint(b"event: sync\ndata: {}\n\n");
    setup.commits.released.notify_waiters();
    until(|| {
        cursor(&setup)
            == SyncCursor::CapturedValue {
                id: "queued-page".into(),
            }
    })
    .await;
    let snapshot = setup.runtime.replica.snapshot(&setup.account).unwrap();
    let items = snapshot.bootstrap.snapshot().visible_items;
    assert_eq!(items[0].version, 3);
    assert!(!items[0].favorite);
    assert_eq!(setup.server.changes.available_permits(), 2);
    assert_eq!(setup.server.opens.lock().unwrap().len(), 1);
    setup.runtime.close().await;
    runner.await.unwrap();
}

#[tokio::test]
async fn final_page_commit_cannot_rebase_a_stale_fetched_boundary_onto_a_new_cursor() {
    let setup = setup().await;
    let old = cursor(&setup);
    let newer = SyncCursor::CapturedValue {
        id: "newer-page".into(),
    };
    assert!(matches!(
        setup
            .runtime
            .advance_sync_page_cursor_fenced(
                &setup.account,
                vec![],
                crate::replica::CursorAdvance {
                    expected: old.clone(),
                    next: newer.clone()
                }
            )
            .await,
        CompletionResult::Completed
    ));
    assert!(matches!(
        setup
            .runtime
            .advance_sync_page_cursor_fenced(
                &setup.account,
                vec![],
                crate::replica::CursorAdvance {
                    expected: old,
                    next: SyncCursor::CapturedValue {
                        id: "stale-page".into()
                    }
                }
            )
            .await,
        CompletionResult::Retry
    ));
    assert_eq!(cursor(&setup), newer);
    setup.runtime.close().await;
}

#[tokio::test]
async fn repeated_eof_reconnects_use_a_bounded_device_timer_budget() {
    let setup = setup().await;
    let runner = tokio::spawn(setup.runtime.clone().run_live_sync());
    let expected = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000];
    for (index, delay) in expected.into_iter().enumerate() {
        permit(&setup.server.changes).await;
        setup.server.send(json!({"type":"ended"}));
        until(|| setup.timer.requested().len() == index + 1).await;
        assert_eq!(setup.timer.requested()[index], delay);
        assert_eq!(setup.server.opens.lock().unwrap().len(), index + 1);
        assert!(setup.server.streams.lock().unwrap().is_empty());
        if index != expected.len() - 1 {
            setup.timer.released.notify_waiters();
        }
    }
    setup.runtime.close().await;
    runner.await.unwrap();
    setup.timer.released.notify_waiters();
    assert_eq!(setup.server.opens.lock().unwrap().len(), expected.len());
}

#[tokio::test]
async fn session_revoked_control_uses_private_renewal_and_parks_when_rejected() {
    let setup = setup().await;
    *setup.server.finite.refresh.lock().unwrap() = RefreshBehavior::Unauthorized;
    let runner = tokio::spawn(setup.runtime.clone().run_live_sync());
    permit(&setup.server.changes).await;
    setup.server.hint(b"event: session_revoked\ndata: {}\n\n");
    until(|| {
        setup
            .runtime
            .waiting_reasons
            .lock()
            .unwrap()
            .get(&setup.account)
            == Some(&AccountWaitingReason::ReauthenticationRequired)
    })
    .await;
    assert_eq!(setup.server.finite.refresh_calls.load(Ordering::SeqCst), 1);
    assert!(setup.server.streams.lock().unwrap().is_empty());
    assert!(setup.timer.requested().is_empty());
    assert!(setup
        .runtime
        .replica
        .snapshot(&setup.account)
        .unwrap()
        .failure
        .is_none());
    setup.runtime.close().await;
    runner.await.unwrap();
}

#[tokio::test]
async fn ordinary_sync_reads_complete_item_authority_without_paid_attachment_or_bootstrap_requests()
{
    let setup = setup().await;
    setup
        .server
        .finite
        .script_attachment_faults([Some(Fault::Status(403))]);
    let runner = tokio::spawn(setup.runtime.clone().run_live_sync());
    permit(&setup.server.changes).await;
    setup.server.change(false, "complete-authority");
    setup.server.hint(b"event: sync\ndata: {}\n\n");
    until(|| {
        cursor(&setup)
            == SyncCursor::CapturedValue {
                id: "complete-authority".into(),
            }
    })
    .await;
    let snapshot = setup.runtime.replica.snapshot(&setup.account).unwrap();
    assert!(snapshot.bootstrap.snapshot().visible_items[0].favorite);
    assert!(snapshot.bootstrap.snapshot().visible_items[0]
        .attachments
        .is_empty());
    let requests = setup.server.finite.requests.lock().unwrap().clone();
    assert_eq!(
        requests
            .iter()
            .filter(|request| request.url.ends_with("/items/item-existing/authority"))
            .count(),
        1
    );
    assert!(!requests
        .iter()
        .any(|request| request.url.contains("/attachments?")
            || request.url.contains("/sync/bootstrap")
            || request.url.ends_with("/items/item-existing")));
    assert_eq!(
        setup.server.finite.attachment_faults.lock().unwrap().len(),
        1
    );
    setup.runtime.close().await;
    runner.await.unwrap();
}

#[tokio::test]
async fn incomplete_or_foreign_complete_authority_cannot_change_items_cursor_or_accepted_work() {
    for defect in [
        "missing-attachments",
        "foreign-item",
        "foreign-vault",
        "foreign-attachment",
        "malformed",
        "forbidden",
        "oversized",
    ] {
        let setup = setup().await;
        setup
            .runtime
            .request(
                RuntimeRequest::CreateItem {
                    account_id: setup.account.clone(),
                    vault_id: TEST_VAULT_ID.into(),
                    draft: draft(),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap();
        let runner = tokio::spawn(setup.runtime.clone().run_live_sync());
        permit(&setup.server.changes).await;
        let before = setup.runtime.replica.snapshot(&setup.account).unwrap();
        setup.server.change(false, "invalid-complete-authority");
        let mut body: Value = serde_json::from_slice(&item_body(
            &setup.server.finite.created_items.lock().unwrap()[0],
        ))
        .unwrap();
        body["attachments"] = json!([]);
        match defect {
            "missing-attachments" => {
                body.as_object_mut().unwrap().remove("attachments");
            }
            "foreign-item" => body["id"] = json!("another-item"),
            "foreign-vault" => body["vaultId"] = json!("another-vault"),
            "foreign-attachment" => {
                body["attachments"] = json!([{
                    "id":"attachment-1", "itemId":"foreign-item", "vaultId":TEST_VAULT_ID,
                    "storageKey":"attachments/attachment-1", "encryptedName":"ciphertext", "encryptionIv":"iv", "encryptionAlgorithm":"AES-256-GCM", "encryptedAttachmentKey":"key", "attachmentKeyIv":"iv", "attachmentKeyAlgorithm":"AES-256-GCM", "encryptedContentType":"content-type", "encryptedContentTypeIv":"iv", "envelopeVersion":1, "fileSize":17, "uploadedBy":USER, "createdAt":"2026-08-30T00:00:00Z"
                }]);
            }
            _ => {}
        }
        let answer = match defect {
            "malformed" => completed(200, b"{".to_vec()),
            "forbidden" => completed(403, b"{}".to_vec()),
            "oversized" => completed(200, vec![b' '; 4 * 1024 * 1024 + 1]),
            _ => completed(200, serde_json::to_vec(&body).unwrap()),
        };
        setup
            .server
            .authority_overrides
            .lock()
            .unwrap()
            .push_back(answer);
        setup.server.hint(b"event: sync\ndata: {}\n\n");
        until(|| setup.timer.requested() == vec![1_000]).await;
        let after = setup.runtime.replica.snapshot(&setup.account).unwrap();
        assert_eq!(after, before, "{defect}");
        assert!(!setup
            .server
            .finite
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|request| request.url.contains("/sync/bootstrap")
                || request.url.contains("/attachments?")));
        setup.runtime.close().await;
        runner.await.unwrap();
    }
}

#[tokio::test]
async fn complete_item_authority_renews_once_and_a_second_401_preserves_work_and_cursor() {
    for refusals in [1, 2] {
        let setup = setup().await;
        setup
            .runtime
            .request(
                RuntimeRequest::CreateItem {
                    account_id: setup.account.clone(),
                    vault_id: TEST_VAULT_ID.into(),
                    draft: draft(),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap();
        let before = setup.runtime.replica.snapshot(&setup.account).unwrap();
        *setup.server.finite.refresh.lock().unwrap() = RefreshBehavior::Renews(SECOND_TOKEN);
        let runner = tokio::spawn(setup.runtime.clone().run_live_sync());
        permit(&setup.server.changes).await;
        setup
            .server
            .finite
            .script_item_faults(std::iter::repeat_n(Fault::Status(401), refusals));
        setup.server.change(false, "renewed-complete-authority");
        setup.server.hint(b"event: sync\ndata: {}\n\n");
        if refusals == 1 {
            until(|| {
                cursor(&setup)
                    == SyncCursor::CapturedValue {
                        id: "renewed-complete-authority".into(),
                    }
            })
            .await;
        } else {
            until(|| {
                setup
                    .runtime
                    .waiting_reasons
                    .lock()
                    .unwrap()
                    .get(&setup.account)
                    == Some(&AccountWaitingReason::ReauthenticationRequired)
            })
            .await;
            assert_eq!(cursor(&setup), before.bootstrap.active_cursor);
        }
        assert_eq!(setup.server.finite.refresh_calls.load(Ordering::SeqCst), 1);
        let tokens: Vec<_> = setup
            .server
            .finite
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|request| request.url.ends_with("/authority"))
            .map(|request| request.header("authorization").unwrap().to_owned())
            .collect();
        assert_eq!(
            tokens,
            vec![
                format!("Bearer {FIRST_TOKEN}"),
                format!("Bearer {SECOND_TOKEN}")
            ]
        );
        assert_eq!(
            setup
                .runtime
                .replica
                .snapshot(&setup.account)
                .unwrap()
                .operations,
            before.operations
        );
        assert!(setup
            .runtime
            .replica
            .snapshot(&setup.account)
            .unwrap()
            .failure
            .is_none());
        setup.runtime.close().await;
        runner.await.unwrap();
    }
}

#[derive(Default)]
struct ItemsSink(Mutex<Vec<RuntimeProjection>>);
impl crate::ObservationSink for ItemsSink {
    fn publish(&self, projection: RuntimeProjection) {
        self.0.lock().unwrap().push(projection);
    }
}

#[tokio::test]
async fn newly_created_remote_item_reaches_a_mounted_plaintext_observer_after_its_operation_event()
{
    let setup = setup().await;
    let sink = Arc::new(ItemsSink::default());
    let _observer = setup
        .runtime
        .observe(
            ObservationRequest::Items {
                account_id: setup.account.clone(),
            },
            sink.clone(),
        )
        .unwrap();
    let runner = tokio::spawn(setup.runtime.clone().run_live_sync());
    permit(&setup.server.changes).await;
    let item_id = "new-remote-item";
    let raced_publications = Arc::new(AtomicUsize::new(0));
    let weak_runtime = Arc::downgrade(&setup.runtime);
    let raced = raced_publications.clone();
    // Another Account can publish all observations after authority commits but before this
    // Account finishes decryption. Exercise that interleaving without changing delivery guards.
    setup
        .runtime
        .set_before_plaintext_commit_hook(Some(Arc::new(move || {
            let runtime = weak_runtime.upgrade().unwrap();
            if runtime
                .replica
                .snapshot(&AccountId::from(ACCOUNT))
                .unwrap()
                .bootstrap
                .snapshot()
                .visible_items
                .iter()
                .any(|item| item.id == item_id)
            {
                raced.fetch_add(1, Ordering::SeqCst);
                runtime.publish_all();
            }
        })));
    let sealed = bittery_crypto_core::encrypt_with_aad(
        &super::create::item_plaintext(&draft()).unwrap(),
        &crate::test_fixtures::TEST_VAULT_KEY,
        &bittery_crypto_core::AadContext {
            vault_id: TEST_VAULT_ID.into(),
            entity_id: item_id.into(),
            entity_type: "item".into(),
            version: 1,
            user_id: USER.into(),
        },
    )
    .unwrap();
    {
        let mut items = setup.server.finite.created_items.lock().unwrap();
        let mut remote = items[0].clone();
        remote.id = item_id.into();
        remote.encrypted_data = sealed.ciphertext;
        remote.encryption_iv = sealed.iv;
        remote.encryption_algorithm = sealed.algorithm;
        items.push(remote);
    }
    setup.server.finite.script_sync_page(vec![
        json!({"id":"remote-item-event", "type":"item_created", "entityType":"item", "entityId":item_id, "userId":USER, "vaultId":TEST_VAULT_ID, "clientId":"another-device", "metadata":null, "timestamp":"1700000000000", "version":1}),
        json!({"id":"remote-operation-event", "type":"operation_resolved", "entityType":"operation", "entityId":"remote-operation", "userId":USER, "vaultId":TEST_VAULT_ID, "clientId":"another-device", "metadata":null, "timestamp":"1700000000000", "version":1}),
    ], "remote-operation-event", false);
    setup.server.hint(b"event: sync\ndata: {}\n\n");
    until(|| {
        cursor(&setup)
            == SyncCursor::CapturedValue {
                id: "remote-operation-event".into(),
            }
    })
    .await;
    assert_eq!(
        setup
            .runtime
            .replica
            .snapshot(&setup.account)
            .unwrap()
            .bootstrap
            .snapshot()
            .visible_items
            .len(),
        2
    );
    until(|| sink.0.lock().unwrap().last().is_some_and(|projection| matches!(projection, RuntimeProjection::Items(items) if items.items.iter().any(|item| item.item_id == item_id && item.status == ItemProjectionStatus::Authoritative)))).await;
    assert!(raced_publications.load(Ordering::SeqCst) > 0);
    setup.runtime.set_before_plaintext_commit_hook(None);
    let revisions: Vec<_> = sink
        .0
        .lock()
        .unwrap()
        .iter()
        .filter_map(|projection| match projection {
            RuntimeProjection::Items(items) => Some(items.replica_revision),
            _ => None,
        })
        .collect();
    assert!(
        revisions.windows(2).all(|pair| pair[0] < pair[1]),
        "Items delivery still rejects duplicate or older revisions"
    );
    assert_eq!(setup.server.finite.outcome_calls.load(Ordering::SeqCst), 0);
    setup.runtime.close().await;
    runner.await.unwrap();
}

#[tokio::test]
async fn incoming_travel_invalidation_blocks_fresh_plaintext_until_current_policy_is_verified() {
    let setup = setup().await;
    let sink = Arc::new(ItemsSink::default());
    let _observer = setup
        .runtime
        .observe(
            ObservationRequest::Items {
                account_id: setup.account.clone(),
            },
            sink.clone(),
        )
        .unwrap();
    assert!(sink
        .0
        .lock()
        .unwrap()
        .iter()
        .any(|projection| matches!(projection,
        RuntimeProjection::Items(items) if !items.items.is_empty())));
    let runner = tokio::spawn(setup.runtime.clone().run_live_sync());
    permit(&setup.server.changes).await;
    until(|| setup.server.stream_reads.load(Ordering::SeqCst) == 1).await;
    let previous_cursor = cursor(&setup);
    let previous_deliveries = sink.0.lock().unwrap().len();
    let gate = Arc::new(PolicyReadGate {
        entered: Semaphore::new(0),
        release: Semaphore::new(0),
        response: json!({"type":"networkFailure"}),
    });
    *setup.server.policy_read.lock().unwrap() = Some(gate.clone());
    // Bootstrap still returns membership authority: it cannot stand in for verified Travel policy.
    let authority = setup
        .runtime
        .replica
        .snapshot(&setup.account)
        .unwrap()
        .bootstrap
        .snapshot();
    setup.server.bootstrap_pages.lock().unwrap().extend([
        json!({"phase":"vaults","vaults":authority.visible_vaults,"hasMore":false,"nextCursor":null,"syncCursor":{"id":"travel-event"}}),
        json!({"phase":"items","items":authority.visible_items,"hasMore":false,"nextCursor":null,"syncCursor":{"id":"travel-event"}}),
    ]);
    setup.server.finite.script_sync_page(
        vec![json!({
            "id":"travel-event","type":"travel_mode_updated","entityType":"user",
            "entityId":USER,"userId":USER,"vaultId":null,"clientId":null,
            "metadata":{"enabled":true,"hiddenVaultIds":[TEST_VAULT_ID]},
            "timestamp":"1700000000001","version":1
        })],
        "travel-event",
        false,
    );
    setup.server.hint(b"event: sync\ndata: {}\n\n");
    let verification_started =
        tokio::time::timeout(std::time::Duration::from_secs(2), gate.entered.acquire()).await;
    assert!(
        verification_started.is_ok(),
        "incoming Travel must verify current policy before replacing or publishing authority"
    );
    verification_started.unwrap().unwrap().forget();
    assert_eq!(cursor(&setup), previous_cursor);
    assert_eq!(setup.server.bootstrap_reads.load(Ordering::SeqCst), 0);
    assert_eq!(
        sink.0.lock().unwrap().len(),
        previous_deliveries,
        "known pending policy must not produce another plaintext delivery"
    );
    let fresh_sink = Arc::new(ItemsSink::default());
    let fresh = setup
        .runtime
        .observe(
            ObservationRequest::Items {
                account_id: setup.account.clone(),
            },
            fresh_sink.clone(),
        )
        .expect("the subscription waits without a private initial frame");
    assert!(
        fresh_sink.0.lock().unwrap().is_empty(),
        "cached plaintext is not an exemption for a fresh observation"
    );
    let _status = setup
        .runtime
        .observe(
            ObservationRequest::Operations {
                account_id: setup.account.clone(),
            },
            Arc::new(ItemsSink::default()),
        )
        .expect("nonplaintext accepted-work status remains available");
    gate.release.add_permits(1);
    until(|| setup.timer.requested().contains(&1_000)).await;
    assert_eq!(
        cursor(&setup),
        previous_cursor,
        "failed current-policy verification must not consume its invalidation"
    );
    let failed_read_sink = Arc::new(ItemsSink::default());
    let failed_read = setup
        .runtime
        .observe(
            ObservationRequest::Items {
                account_id: setup.account.clone(),
            },
            failed_read_sink.clone(),
        )
        .expect("failed verification still permits a silent subscription");
    assert!(
        failed_read_sink.0.lock().unwrap().is_empty() && fresh_sink.0.lock().unwrap().is_empty(),
        "transport failure cannot reopen fresh plaintext using cached policy"
    );
    failed_read.close();
    fresh.close();
    let create = setup
        .runtime
        .request(
            RuntimeRequest::CreateItem {
                account_id: setup.account.clone(),
                vault_id: TEST_VAULT_ID.into(),
                draft: draft(),
            },
            RequestCancellation::new(),
        )
        .await;
    assert!(
        matches!(create, Err(error) if error.code == RuntimeErrorCode::AuthorityMissing),
        "new accepted work cannot borrow authority while current Travel verification is pending"
    );
    setup.runtime.close().await;
    runner.await.unwrap();
}

#[path = "live_sync_policy_apply_tests.rs"]
mod policy_apply;

#[path = "travel_policy_failure_tests.rs"]
mod policy_failure;

#[path = "live_sync_session_lifetime_tests.rs"]
mod session_lifetime;

#[path = "travel_command_tests.rs"]
mod travel_commands_test;

#[path = "vault_export_tests.rs"]
mod vault_export;

#[path = "travel_observation_tests.rs"]
mod travel_observation;
