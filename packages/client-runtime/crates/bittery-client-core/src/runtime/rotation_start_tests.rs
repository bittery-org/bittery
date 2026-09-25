//! A retained Team-leave start crosses HTTP, the closed outcome parser, and one Replica journal.

use super::{operation_fixtures::*, *};
use crate::{
    auth_http::ClientPlatform,
    replica::{GuardedCommitPlan, OperationRecord, PlanMutation},
    test_fixtures::TEST_VAULT_ID,
};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::atomic::AtomicUsize;

const FINGERPRINT: &str = "7a6deb2215d2e2f11538109abe9d6195e32123b831bebc09a9140b975c20106a";

struct RotationStartServer {
    requests: Mutex<Vec<Value>>,
    sends: AtomicUsize,
    lose_first_reply: bool,
    result: Value,
}

impl RotationStartServer {
    fn new(lose_first_reply: bool, result: Value) -> Arc<Self> {
        Arc::new(Self {
            requests: Mutex::new(Vec::new()),
            sends: AtomicUsize::new(0),
            lose_first_reply,
            result,
        })
    }
}

#[async_trait]
impl SerializedHttpExecutor for RotationStartServer {
    async fn invoke(&self, request: zeroize::Zeroizing<String>) -> Result<String, RuntimeError> {
        let request: Value = serde_json::from_str(&request).unwrap();
        let url = request["url"].as_str().unwrap();
        self.requests.lock().unwrap().push(request.clone());
        if url.ends_with("/api/v1/operations/rotation-start") {
            return Ok(completed(200, serde_json::to_vec(&self.result).unwrap()).to_string());
        }
        assert_eq!(request["method"], "POST");
        assert!(url.ends_with("/api/v1/teams/team-1/leave-rotation-plans"));
        assert_eq!(request["body"], json!([]));
        assert!(request["headers"].as_array().unwrap().iter().any(|header| {
            header["name"]
                .as_str()
                .unwrap()
                .eq_ignore_ascii_case("idempotency-key")
                && header["value"] == "rotation-start"
        }));
        if self.sends.fetch_add(1, Ordering::SeqCst) == 0 && self.lose_first_reply {
            return Ok(json!({"type": "networkFailure"}).to_string());
        }
        Ok(completed(200, serde_json::to_vec(&self.result).unwrap()).to_string())
    }

    fn cancel(&self, _: &str) {}
}

fn operation() -> OperationRecord {
    serde_json::from_value(json!({
        "operationId": "rotation-start",
        "kind": "create_team_leave_rotation_plans",
        "target": {"type": "team", "teamId": "team-1"},
        "request": {
            "method": "POST",
            "path": "/api/v1/teams/team-1/leave-rotation-plans",
            "headers": [],
            "body": []
        },
        "requestFingerprint": FINGERPRINT,
        "scheduling": {"attemptCount": "0", "notBeforeMs": "0"}
    }))
    .unwrap()
}

async fn setup(
    result: Value,
    lose_first_reply: bool,
) -> (Harness, Arc<Runtime>, Arc<RotationStartServer>) {
    let harness = seeded(true).await;
    let server = RotationStartServer::new(lose_first_reply, result);
    let runtime = Runtime::with_test_dispatch_environment(
        harness.replica.clone(),
        harness.platform.clone(),
        server.clone(),
        AuthClientConfig::new(
            "rotation-test".into(),
            ClientPlatform::Desktop,
            "test".into(),
        )
        .unwrap(),
        harness.clock.clone(),
        harness.timer.clone(),
    );
    runtime.replica.load(&harness.account_id).await.unwrap();
    runtime.unlock_account(&harness.account_id).await.unwrap();
    store_session(&runtime, &harness.account_id, FIRST_TOKEN).await;
    let initial = runtime.replica.snapshot(&harness.account_id).unwrap();
    runtime
        .replica
        .execute(GuardedCommitPlan::new(
            harness.account_id.clone(),
            initial.incarnation,
            initial.revision,
            initial.lock_epoch,
            vec![PlanMutation::AcceptOperation(operation())],
        ))
        .await
        .unwrap();
    (harness, runtime, server)
}

#[tokio::test]
async fn lost_team_leave_start_reply_replays_exact_request_then_commits_receipt_and_attempt() {
    let result = json!({
        "kind": "create_team_leave_rotation_plans",
        "operationId": "rotation-start",
        "result": {"status": "applied", "plans": []}
    });
    let (harness, runtime, server) = setup(result, true).await;
    runtime
        .dispatch_once_ignoring_lease(&harness.account_id, "rotation-start")
        .await;
    let pending = runtime.replica.snapshot(&harness.account_id).unwrap();
    assert_eq!(pending.operations.len(), 1);
    assert!(pending.receipts.is_empty());
    assert!(pending.rotation_attempts.is_empty());
    assert_eq!(pending.operations[0].scheduling.attempt_count, 1);

    harness.clock.advance(1_000);
    runtime
        .dispatch_once_ignoring_lease(&harness.account_id, "rotation-start")
        .await;
    let done = runtime.replica.snapshot(&harness.account_id).unwrap();
    assert!(done.operations.is_empty());
    assert_eq!(done.receipts.len(), 1);
    assert_eq!(done.rotation_attempts.len(), 1);
    assert_eq!(done.rotation_attempts[0].plans.len(), 0);
    assert_eq!(
        serde_json::to_value(&done.rotation_attempts[0].phase).unwrap(),
        json!({"type":"prepared"})
    );
    assert_eq!(server.sends.load(Ordering::SeqCst), 2);
    let requests = server.requests.lock().unwrap();
    assert_eq!(
        requests.len(),
        3,
        "send, retained-outcome lookup, exact replay"
    );
    assert_eq!(requests[0]["body"], requests[2]["body"]);
}

#[tokio::test]
async fn rejected_team_leave_start_commits_only_a_typed_receipt() {
    let result = json!({
        "kind": "create_team_leave_rotation_plans",
        "operationId": "rotation-start",
        "result": {"status": "rejected", "code": "team_owner_leave_forbidden"}
    });
    let (harness, runtime, server) = setup(result, false).await;
    runtime
        .dispatch_once_ignoring_lease(&harness.account_id, "rotation-start")
        .await;
    let done = runtime.replica.snapshot(&harness.account_id).unwrap();
    assert!(done.operations.is_empty());
    assert_eq!(done.receipts.len(), 1);
    assert!(done.rotation_attempts.is_empty());
    assert_eq!(server.sends.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn failed_start_journal_commit_keeps_the_operation_for_exact_replay() {
    let result = json!({
        "kind": "create_team_leave_rotation_plans",
        "operationId": "rotation-start",
        "result": {"status": "applied", "plans": []}
    });
    let (harness, runtime, server) = setup(result, false).await;
    harness.replica.fail_next_commits(1);
    runtime
        .dispatch_once_ignoring_lease(&harness.account_id, "rotation-start")
        .await;
    let pending = runtime.replica.snapshot(&harness.account_id).unwrap();
    assert_eq!(pending.operations.len(), 1);
    assert!(pending.receipts.is_empty());
    assert!(pending.rotation_attempts.is_empty());
    assert_eq!(harness.replica.failed_commits(), 1);

    harness.clock.advance(1_000);
    runtime
        .dispatch_once_ignoring_lease(&harness.account_id, "rotation-start")
        .await;
    let done = runtime.replica.snapshot(&harness.account_id).unwrap();
    assert!(done.operations.is_empty());
    assert_eq!(done.receipts.len(), 1);
    assert_eq!(done.rotation_attempts.len(), 1);
    assert_eq!(server.sends.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn vault_retirement_progresses_with_a_retained_team_leave_start_receipt() {
    let result = json!({
        "kind": "create_team_leave_rotation_plans",
        "operationId": "rotation-start",
        "result": {"status": "applied", "plans": []}
    });
    let (harness, runtime, _) = setup(result, false).await;
    runtime
        .dispatch_once_ignoring_lease(&harness.account_id, "rotation-start")
        .await;
    let started = runtime.replica.snapshot(&harness.account_id).unwrap();
    assert_eq!(started.receipts.len(), 1);
    assert_eq!(started.rotation_attempts.len(), 1);
    runtime
        .replica
        .execute(GuardedCommitPlan::new(
            harness.account_id.clone(),
            started.incarnation,
            started.revision,
            started.lock_epoch,
            vec![PlanMutation::RetireVaults {
                vault_ids: vec![TEST_VAULT_ID.into()],
            }],
        ))
        .await
        .unwrap();
    let retired = runtime.replica.snapshot(&harness.account_id).unwrap();
    assert_eq!(retired.bootstrap.pending_vault_retirements, [TEST_VAULT_ID]);
    runtime.resume_vault_retirements(&retired).await.unwrap();
    let finished = runtime.replica.snapshot(&harness.account_id).unwrap();
    assert!(finished.bootstrap.pending_vault_retirements.is_empty());
    assert_eq!(finished.receipts, started.receipts);
    assert_eq!(finished.rotation_attempts, started.rotation_attempts);
}
