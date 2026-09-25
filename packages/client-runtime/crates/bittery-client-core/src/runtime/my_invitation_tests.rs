use super::operation_fixtures::*;
use super::*;
use crate::http_transport::SerializedHttpExecutor;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Clone, Copy)]
enum Scenario {
    ListOnly,
    AcceptedAndRefreshed,
    AcceptedButRefreshUnavailable,
    LostAcceptReply,
    LostDeclineReply,
}

struct MyInvitationServer {
    requests: Mutex<Vec<Value>>,
    scenario: Scenario,
    pending: AtomicBool,
    bootstrap_vaults: Value,
}

#[async_trait]
impl SerializedHttpExecutor for MyInvitationServer {
    async fn invoke(&self, request: zeroize::Zeroizing<String>) -> Result<String, RuntimeError> {
        let request: Value = serde_json::from_str(&request).unwrap();
        let url = url::Url::parse(request["url"].as_str().unwrap()).unwrap();
        let body = match (request["method"].as_str().unwrap(), url.path()) {
            ("GET", "/api/v1/users/me/team-invitations") => json!({
                "items": if self.pending.load(Ordering::SeqCst) {json!([{"id":"invitation-1", "teamId":"team-2", "teamName":"Inviting Team",
                    "role":"member", "invitedBy":"Alex", "expiresAt":"2099-01-01T00:00:00Z"}])} else {json!([])},
                "hasMore":false, "nextCursor":null
            }),
            ("GET", "/api/v1/users/me") => json!({
                "id": USER, "email":"user-1@example.com", "name":"Invitee", "role":"member",
                "publicKey":"public", "encryptedPrivateKey":"PRIVATE-NOT-FOR-HOST",
                "hasRecoveryKey":false, "createdAt":"2026-01-01T00:00:00Z",
                "teamId": if self.pending.load(Ordering::SeqCst) {Value::Null} else {json!("team-2")}
            }),
            ("GET", "/api/v1/travel-mode") => json!({
                "enabled":false, "hiddenVaultIds":[], "enabledAt":null,
                "updatedAt":"2023-11-14T22:13:20Z"
            }),
            ("POST", "/api/v1/users/me/team-invitations/invitation-1/accept") => {
                self.pending.store(false, Ordering::SeqCst);
                self.requests.lock().unwrap().push(request);
                return Ok(if matches!(self.scenario, Scenario::LostAcceptReply) {
                    json!({"type":"networkFailure"}).to_string()
                } else {
                    completed(
                        200,
                        serde_json::to_vec(&json!({
                            "teamId":"team-2", "teamName":"Inviting Team"
                        }))
                        .unwrap(),
                    )
                    .to_string()
                });
            }
            ("POST", "/api/v1/users/me/team-invitations/invitation-1/decline") => {
                self.pending.store(false, Ordering::SeqCst);
                self.requests.lock().unwrap().push(request);
                return Ok(json!({"type":"networkFailure"}).to_string());
            }
            ("GET", "/api/v1/sync/bootstrap") => {
                self.requests.lock().unwrap().push(request);
                if !matches!(self.scenario, Scenario::AcceptedAndRefreshed) {
                    return Ok(json!({"type":"networkFailure"}).to_string());
                }
                let phase = url
                    .query_pairs()
                    .find(|(key, _)| key == "phase")
                    .map(|(_, value)| value.into_owned())
                    .unwrap();
                let body = if phase == "vaults" {
                    json!({"phase":"vaults", "vaults":self.bootstrap_vaults,
                        "hasMore":false, "nextCursor":null,
                        "syncCursor":{"id":"post-accept"}})
                } else {
                    json!({"phase":"items", "items":[],
                        "hasMore":false, "nextCursor":null,
                        "syncCursor":{"id":"post-accept"}})
                };
                return Ok(completed(200, serde_json::to_vec(&body).unwrap()).to_string());
            }
            ("GET", "/api/v1/sync/changes") => json!({
                "events":[], "cursor":{"id":"post-accept"},
                "hasMore":false, "requiresFullRefresh":false
            }),
            (method, path) => panic!("unexpected current-User Invitation request: {method} {path}"),
        };
        self.requests.lock().unwrap().push(request);
        Ok(completed(200, serde_json::to_vec(&body).unwrap()).to_string())
    }

    fn cancel(&self, _: &str) {}
}

#[tokio::test]
async fn current_user_invitations_are_a_closed_account_scoped_bounded_read() {
    let seed = seeded(true).await;
    let server = Arc::new(MyInvitationServer {
        requests: Mutex::new(Vec::new()),
        scenario: Scenario::ListOnly,
        pending: AtomicBool::new(true),
        bootstrap_vaults: Value::Null,
    });
    let runtime = Runtime::with_test_dispatch_environment(
        seed.replica,
        seed.platform,
        server.clone(),
        auth_config(),
        seed.clock,
        seed.timer,
    );
    runtime
        .replica
        .load(&seed.account_id)
        .await
        .unwrap()
        .unwrap();
    runtime.unlock_account(&seed.account_id).await.unwrap();

    let request: RuntimeRequest = serde_json::from_value(json!({
        "type":"listMyTeamInvitations", "accountId":seed.account_id
    }))
    .expect("current-User Invitation list must be a closed Runtime request");
    let response = runtime
        .request(request, RequestCancellation::new())
        .await
        .unwrap();
    let response = serde_json::to_value(response).unwrap();
    assert_eq!(response["type"], "myTeamInvitations");
    assert_eq!(response["invitations"][0]["id"], "invitation-1");
    assert_eq!(response["invitations"][0]["teamId"], "team-2");
    assert_eq!(server.requests.lock().unwrap().len(), 1);
}

async fn runtime_with_scenario(
    scenario: Scenario,
) -> (Arc<Runtime>, AccountId, Arc<MyInvitationServer>) {
    let seed = seeded(true).await;
    let bootstrap_vaults = serde_json::to_value(
        seed.replica
            .state
            .snapshot(&seed.account_id)
            .unwrap()
            .bootstrap
            .snapshot()
            .visible_vaults,
    )
    .unwrap();
    let server = Arc::new(MyInvitationServer {
        requests: Mutex::new(Vec::new()),
        scenario,
        pending: AtomicBool::new(true),
        bootstrap_vaults,
    });
    let runtime = Runtime::with_test_dispatch_environment(
        seed.replica,
        seed.platform,
        server.clone(),
        auth_config(),
        seed.clock,
        seed.timer,
    );
    runtime
        .replica
        .load(&seed.account_id)
        .await
        .unwrap()
        .unwrap();
    runtime.unlock_account(&seed.account_id).await.unwrap();
    (runtime, seed.account_id, server)
}

fn assert_accept_refresh_duty(runtime: &Runtime, account_id: &AccountId) {
    let snapshot = runtime.replica.snapshot(account_id).unwrap();
    assert_ne!(
        snapshot.bootstrap.state,
        crate::replica::ReplicaState::Ready
    );
    if snapshot.bootstrap.state == crate::replica::ReplicaState::Bootstrapping {
        let staging = snapshot.bootstrap.staging_generation.as_ref().unwrap();
        assert_eq!(
            snapshot.bootstrap.generations[staging].fallback_state,
            crate::replica::ReplicaState::RefreshRequired
        );
    } else {
        assert_eq!(
            snapshot.bootstrap.state,
            crate::replica::ReplicaState::RefreshRequired
        );
    }
}

#[tokio::test]
async fn confirmed_accept_waits_for_full_bootstrap_and_catch_up_before_success() {
    let (runtime, account_id, server) = runtime_with_scenario(Scenario::AcceptedAndRefreshed).await;
    let request: RuntimeRequest = serde_json::from_value(json!({
        "type":"acceptMyTeamInvitation", "accountId":account_id,
        "invitationId":"invitation-1"
    }))
    .unwrap();
    let response = runtime
        .request(request, RequestCancellation::new())
        .await
        .unwrap();
    let response = serde_json::to_value(response).unwrap();
    assert_eq!(response["type"], "myTeamInvitationAccepted");
    assert_eq!(response["teamId"], "team-2");
    assert_eq!(
        runtime
            .replica
            .snapshot(&account_id)
            .unwrap()
            .bootstrap
            .state,
        crate::replica::ReplicaState::Ready
    );
    let paths = server
        .requests
        .lock()
        .unwrap()
        .iter()
        .map(|request| {
            url::Url::parse(request["url"].as_str().unwrap())
                .unwrap()
                .path()
                .to_owned()
        })
        .collect::<Vec<_>>();
    assert_eq!(
        paths
            .iter()
            .filter(|path| path.ends_with("/sync/bootstrap"))
            .count(),
        2
    );
    assert_eq!(
        paths
            .iter()
            .filter(|path| path.ends_with("/sync/changes"))
            .count(),
        1
    );
}

#[tokio::test]
async fn confirmed_accept_keeps_new_vault_authority_unavailable_until_fresh_sync() {
    let (runtime, account_id, server) =
        runtime_with_scenario(Scenario::AcceptedButRefreshUnavailable).await;
    let request: RuntimeRequest = serde_json::from_value(json!({
        "type":"acceptMyTeamInvitation", "accountId":account_id,
        "invitationId":"invitation-1"
    }))
    .expect("accept by ID must be a closed Runtime request");
    let response = runtime
        .request(request, RequestCancellation::new())
        .await
        .unwrap();
    let response = serde_json::to_value(response).unwrap();
    assert_eq!(response["type"], "myTeamInvitationAcceptRefreshRequired");
    assert_eq!(response["teamId"], "team-2");
    assert_accept_refresh_duty(&runtime, &account_id);
    assert_eq!(
        server
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r["method"] == "POST")
            .count(),
        1
    );
}

#[tokio::test]
async fn lost_accept_reply_reconciles_without_replaying_and_keeps_refresh_duty() {
    let (runtime, account_id, server) = runtime_with_scenario(Scenario::LostAcceptReply).await;
    let request: RuntimeRequest = serde_json::from_value(json!({
        "type":"acceptMyTeamInvitation", "accountId":account_id,
        "invitationId":"invitation-1"
    }))
    .unwrap();
    let response = runtime
        .request(request, RequestCancellation::new())
        .await
        .unwrap();
    let response = serde_json::to_value(response).unwrap();
    assert_eq!(response["type"], "myTeamInvitationUncertain");
    assert_eq!(response["currentTeamId"], "team-2");
    assert_eq!(response["pending"], false);
    assert_accept_refresh_duty(&runtime, &account_id);
    assert_eq!(
        server
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r["method"] == "POST")
            .count(),
        1
    );
}

#[tokio::test]
async fn lost_decline_reply_only_reports_observed_absence() {
    let (runtime, account_id, server) = runtime_with_scenario(Scenario::LostDeclineReply).await;
    let request: RuntimeRequest = serde_json::from_value(json!({
        "type":"declineMyTeamInvitation", "accountId":account_id,
        "invitationId":"invitation-1"
    }))
    .unwrap();
    let response = runtime
        .request(request, RequestCancellation::new())
        .await
        .unwrap();
    let response = serde_json::to_value(response).unwrap();
    assert_eq!(response["type"], "myTeamInvitationUncertain");
    assert_eq!(response["pending"], false);
    assert_eq!(
        server
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r["method"] == "POST")
            .count(),
        1
    );
}

#[tokio::test]
async fn control_result_admission_survives_policy_duty_but_not_account_retirement() {
    let (runtime, account_id, _) = runtime_with_scenario(Scenario::ListOnly).await;
    let snapshot = runtime.replica.snapshot(&account_id).unwrap();
    let cancellation = RequestCancellation::new();
    let guard = runtime
        .foreground_attachments
        .register(&account_id, &snapshot.incarnation, cancellation.clone())
        .unwrap();
    let publication = runtime.foreground_attachments.publication(&guard);
    assert!(publication.begin());
    runtime
        .foreground_attachments
        .ensure_server_policy_verification(&account_id, &snapshot.incarnation)
        .unwrap();
    assert!(!publication.begin());
    assert!(publication.begin_control_result());

    let retirement = runtime
        .foreground_attachments
        .begin_account_retirement(&account_id);
    assert!(cancellation.is_cancelled());
    assert!(!publication.begin_control_result());
    drop(retirement);
}
