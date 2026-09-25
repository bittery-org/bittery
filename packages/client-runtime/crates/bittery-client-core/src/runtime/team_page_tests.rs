use super::operation_fixtures::*;
use super::*;
use crate::http_transport::SerializedHttpExecutor;
use crate::protocol::TeamPageRole;
use async_trait::async_trait;
use serde_json::{json, Value};

#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum TeamScenario {
    #[default]
    Owner,
    Member,
    Absent,
    Forbidden,
    NetworkFailure,
    RepeatedCursor,
    OversizedCursor,
    EndlessCursor,
    WrongUser,
    WrongTeam,
    RefreshOnce,
    RefreshRefused,
    RefreshThenRefused,
    HoldMembers,
}

struct TeamPageServer {
    requests: Mutex<Vec<Value>>,
    scenario: TeamScenario,
    entered: tokio::sync::Semaphore,
    release: tokio::sync::Semaphore,
}

impl TeamPageServer {
    fn new(scenario: TeamScenario) -> Arc<Self> {
        Arc::new(Self {
            requests: Mutex::new(Vec::new()),
            scenario,
            entered: tokio::sync::Semaphore::new(0),
            release: tokio::sync::Semaphore::new(0),
        })
    }

    fn paths(&self) -> Vec<String> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .map(|request| {
                url::Url::parse(request["url"].as_str().unwrap())
                    .unwrap()
                    .path()
                    .to_owned()
            })
            .collect()
    }
}

fn problem(status: u16, body: Value) -> String {
    let mut response = completed(status, serde_json::to_vec(&body).unwrap());
    response["headers"][0]["value"] = json!("application/problem+json");
    response.to_string()
}

#[async_trait]
impl SerializedHttpExecutor for TeamPageServer {
    async fn invoke(&self, request: zeroize::Zeroizing<String>) -> Result<String, RuntimeError> {
        let request: Value = serde_json::from_str(&request).unwrap();
        let url = url::Url::parse(request["url"].as_str().unwrap()).unwrap();
        let path = url.path().to_owned();
        let cursor = url
            .query_pairs()
            .find(|(key, _)| key == "cursor")
            .map(|(_, value)| value.into_owned());
        self.requests.lock().unwrap().push(request);
        let count = self
            .paths()
            .iter()
            .filter(|candidate| candidate.as_str() == path.as_str())
            .count();
        if self.scenario == TeamScenario::HoldMembers && path.ends_with("/members") {
            self.entered.add_permits(1);
            self.release.acquire().await.unwrap().forget();
        }
        if path == "/api/v1/teams/current" {
            match self.scenario {
                TeamScenario::Absent => return Ok(completed(404, Vec::new()).to_string()),
                TeamScenario::NetworkFailure => return Ok(json!({"type":"networkFailure"}).to_string()),
                TeamScenario::Forbidden => return Ok(json!({
                    "type":"completed", "status":403,
                    "headers":[{"name":"content-type","value":"application/problem+json"},{"name":"Retry-After","value":"12"}],
                    "body":serde_json::to_vec(&json!({
                        "type":"https://bittery.com/problems/forbidden", "title":"Forbidden", "status":403,
                        "code":"FORBIDDEN", "detail":"Team read refused", "instance":"/api/v1/teams/current",
                        "requestId":"request-403", "retryable":false,
                        "errors":[{"pointer":"/team","code":"not_allowed"}]
                    })).unwrap()
                }).to_string()),
                TeamScenario::RefreshThenRefused => return Ok(problem(401, json!({
                    "type":"https://bittery.com/problems/unauthorized", "title":"Unauthorized", "status":401,
                    "code":"UNAUTHORIZED", "detail":"Session expired again", "instance":"/api/v1/teams/current",
                    "requestId":"request-401-second", "retryable":false
                }))),
                _ => {}
            }
        }
        if path == "/api/v1/users/me"
            && matches!(
                self.scenario,
                TeamScenario::RefreshOnce
                    | TeamScenario::RefreshRefused
                    | TeamScenario::RefreshThenRefused
            )
            && (count == 1 || self.scenario == TeamScenario::RefreshRefused)
        {
            return Ok(problem(
                401,
                json!({
                    "type":"https://bittery.com/problems/unauthorized", "title":"Unauthorized", "status":401,
                    "code":"UNAUTHORIZED", "detail":"Session expired", "instance":"/api/v1/users/me",
                    "requestId":"request-401", "retryable":false
                }),
            ));
        }
        let body = match path.as_str() {
            "/api/v1/users/me" => {
                let id = if self.scenario == TeamScenario::WrongUser {
                    "wrong-user"
                } else {
                    USER
                };
                json!({"id": id, "email":"owner@example.test", "name":"Owner", "role":"owner", "publicKey":"public", "encryptedPrivateKey":"PRIVATE-NOT-FOR-HOST", "hasRecoveryKey":false, "createdAt":"2026-01-01T00:00:00Z"})
            }
            "/api/v1/teams/current" => {
                let role = if self.scenario == TeamScenario::Member {
                    "member"
                } else {
                    "owner"
                };
                json!({"id":"team-1", "name":"Runtime Team", "teamType":"organization", "ownerId":USER, "role":role, "memberCount":"1", "createdAt":"2026-01-01T00:00:00Z"})
            }
            "/api/v1/teams/team-1" => {
                let role = if self.scenario == TeamScenario::Member {
                    "member"
                } else {
                    "owner"
                };
                let id = if self.scenario == TeamScenario::WrongTeam {
                    "wrong-team"
                } else {
                    "team-1"
                };
                json!({"id":id, "name":"Runtime Team", "teamType":"organization", "ownerId":USER, "ownerName":"Owner", "userRole":role, "memberCount":"1", "createdAt":"2026-01-01T00:00:00Z", "updatedAt":"2026-01-01T00:00:00Z"})
            }
            "/api/v1/sessions/current/refresh" => {
                json!({"token":SECOND_TOKEN,"sessionId":"session-1","expiresAt":"2099-01-01T00:00:00Z"})
            }
            "/api/v1/billing/entitlements" => {
                json!({"mode":"cloud", "billingEnabled":true, "plan":"team", "status":"active", "isActive":true, "entitlements":{"sentinel":true,"teamManagement":true,"vaultSharing":true,"shareLinks":true,"billingPortal":true,"attachments":true}, "limits":{}})
            }
            "/api/v1/teams/team-1/members" => {
                if matches!(
                    self.scenario,
                    TeamScenario::RepeatedCursor
                        | TeamScenario::OversizedCursor
                        | TeamScenario::EndlessCursor
                ) {
                    let next = if self.scenario == TeamScenario::OversizedCursor {
                        "x".repeat(1_025)
                    } else if self.scenario == TeamScenario::EndlessCursor {
                        format!("cursor-{count}")
                    } else {
                        "same".to_owned()
                    };
                    json!({"items":[],"hasMore":true,"nextCursor":next})
                } else {
                    assert!(cursor.is_none());
                    json!({"items":[{"userId":USER,"name":"Owner","email":"owner@example.test","role":"owner","joinedAt":"2026-01-01T00:00:00Z"}],"hasMore":false,"nextCursor":null})
                }
            }
            "/api/v1/teams/team-1/invitations" => {
                json!({"items":[],"hasMore":false,"nextCursor":null})
            }
            _ => panic!("unexpected Team route: {path}"),
        };
        Ok(completed(200, serde_json::to_vec(&body).unwrap()).to_string())
    }
    fn cancel(&self, _: &str) {}
}

async fn setup(scenario: TeamScenario) -> (Arc<Runtime>, AccountId, Arc<TeamPageServer>) {
    let seed = seeded_with_share_item(true).await;
    let server = TeamPageServer::new(scenario);
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

fn request(account_id: AccountId) -> RuntimeRequest {
    RuntimeRequest::ReadTeamPage { account_id }
}

#[tokio::test]
async fn team_page_read_uses_the_account_session_and_never_returns_private_identity() {
    let (runtime, account_id, server) = setup(TeamScenario::Owner).await;
    let answer = runtime
        .request(request(account_id), RequestCancellation::new())
        .await
        .unwrap();
    let value = serde_json::to_value(answer).unwrap();
    assert_eq!(value["page"]["team"]["name"], "Runtime Team");
    assert_eq!(value["page"]["user"]["id"], USER);
    assert_eq!(value["page"]["members"].as_array().unwrap().len(), 1);
    assert!(value.to_string().find("PRIVATE-NOT-FOR-HOST").is_none());
    {
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests.len(), 6);
        assert!(requests.iter().all(|request| request["method"] == "GET"
            && request["headers"]
                .as_array()
                .unwrap()
                .iter()
                .any(|header| header["name"] == "Authorization")));
    }
    runtime.close().await;
}

#[tokio::test]
async fn member_reads_a_valid_team_without_requesting_owner_only_invitations() {
    let (runtime, account, server) = setup(TeamScenario::Member).await;
    let RuntimeResponse::TeamPage { page } = runtime
        .request(request(account), RequestCancellation::new())
        .await
        .unwrap()
    else {
        panic!("Team page result");
    };
    assert_eq!(page.team.unwrap().user_role, TeamPageRole::Member);
    assert!(page.team_management_enabled);
    assert!(page.invitations.is_empty());
    assert!(!server
        .paths()
        .iter()
        .any(|path| path.ends_with("/invitations")));
    runtime.close().await;
}

#[tokio::test]
async fn absence_is_distinct_from_forbidden_and_network_failure() {
    let (runtime, account, server) = setup(TeamScenario::Absent).await;
    let RuntimeResponse::TeamPage { page } = runtime
        .request(request(account), RequestCancellation::new())
        .await
        .unwrap()
    else {
        panic!("Team page result");
    };
    assert!(page.team.is_none());
    assert_eq!(
        server.paths(),
        vec![
            "/api/v1/users/me".to_owned(),
            "/api/v1/teams/current".to_owned()
        ]
    );
    runtime.close().await;

    let (runtime, account, _) = setup(TeamScenario::Forbidden).await;
    let denied = runtime
        .request(request(account), RequestCancellation::new())
        .await
        .unwrap_err();
    assert_eq!(denied.code, RuntimeErrorCode::AccessDenied);
    let problem = denied.team_page_problem.unwrap();
    assert_eq!(problem.status, 403);
    assert_eq!(problem.code, crate::server_contract::ErrorCode::Forbidden);
    assert_eq!(problem.message, "Team read refused");
    assert_eq!(problem.request_id, "request-403");
    assert!(!problem.retryable);
    assert_eq!(problem.retry_after_seconds, Some(12));
    assert_eq!(problem.field_errors[0].pointer, "/team");
    runtime.close().await;

    let (runtime, account, _) = setup(TeamScenario::NetworkFailure).await;
    let failure = runtime
        .request(request(account), RequestCancellation::new())
        .await
        .unwrap_err();
    assert_eq!(failure.code, RuntimeErrorCode::RetryableTransport);
    assert!(failure.team_page_problem.is_none());
    runtime.close().await;
}

#[tokio::test]
async fn pages_refuse_repeated_oversized_or_endless_cursors() {
    for scenario in [
        TeamScenario::RepeatedCursor,
        TeamScenario::OversizedCursor,
        TeamScenario::EndlessCursor,
    ] {
        let (runtime, account, server) = setup(scenario).await;
        let failure = runtime
            .request(request(account), RequestCancellation::new())
            .await
            .unwrap_err();
        assert_eq!(failure.code, RuntimeErrorCode::AuthenticationUnavailable);
        let member_requests = server
            .paths()
            .into_iter()
            .filter(|path| path.ends_with("/members"))
            .count();
        assert_eq!(
            member_requests,
            match scenario {
                TeamScenario::RepeatedCursor => 2,
                TeamScenario::OversizedCursor => 1,
                TeamScenario::EndlessCursor => 64,
                _ => unreachable!(),
            }
        );
        runtime.close().await;
    }
}

#[tokio::test]
async fn refuses_cross_user_or_inconsistent_team_identity_before_publication() {
    for scenario in [TeamScenario::WrongUser, TeamScenario::WrongTeam] {
        let (runtime, account, server) = setup(scenario).await;
        let failure = runtime
            .request(request(account), RequestCancellation::new())
            .await
            .unwrap_err();
        assert_eq!(failure.code, RuntimeErrorCode::AuthenticationUnavailable);
        assert!(!server.paths().iter().any(|path| path.ends_with("/members")));
        runtime.close().await;
    }
}

#[tokio::test]
async fn refreshes_the_account_session_at_most_once() {
    let (runtime, account, server) = setup(TeamScenario::RefreshOnce).await;
    let RuntimeResponse::TeamPage { page } = runtime
        .request(request(account), RequestCancellation::new())
        .await
        .unwrap()
    else {
        panic!("Team page result");
    };
    assert_eq!(page.team.unwrap().name, "Runtime Team");
    assert_eq!(
        server
            .paths()
            .iter()
            .filter(|path| path.ends_with("/refresh"))
            .count(),
        1
    );
    runtime.close().await;

    let (runtime, account, server) = setup(TeamScenario::RefreshRefused).await;
    let failure = runtime
        .request(request(account), RequestCancellation::new())
        .await
        .unwrap_err();
    assert_eq!(failure.code, RuntimeErrorCode::AuthenticationRequired);
    assert_eq!(
        server
            .paths()
            .iter()
            .filter(|path| path.ends_with("/refresh"))
            .count(),
        1
    );
    assert_eq!(failure.team_page_problem.unwrap().request_id, "request-401");
    runtime.close().await;

    let (runtime, account, server) = setup(TeamScenario::RefreshThenRefused).await;
    let failure = runtime
        .request(request(account), RequestCancellation::new())
        .await
        .unwrap_err();
    assert_eq!(failure.code, RuntimeErrorCode::AuthenticationRequired);
    assert_eq!(
        server
            .paths()
            .iter()
            .filter(|path| path.ends_with("/refresh"))
            .count(),
        1
    );
    assert_eq!(
        failure.team_page_problem.unwrap().request_id,
        "request-401-second"
    );
    runtime.close().await;
}

#[tokio::test]
async fn caller_loss_and_lock_retire_a_held_team_read() {
    let (runtime, account, server) = setup(TeamScenario::HoldMembers).await;
    let cancellation = RequestCancellation::new();
    let read = tokio::spawn({
        let runtime = runtime.clone();
        let account = account.clone();
        let cancellation = cancellation.clone();
        async move { runtime.request(request(account), cancellation).await }
    });
    server.entered.acquire().await.unwrap().forget();
    cancellation.cancel();
    server.release.add_permits(1);
    assert_eq!(
        read.await.unwrap().unwrap_err().code,
        RuntimeErrorCode::Cancelled
    );
    runtime.close().await;

    let (runtime, account, server) = setup(TeamScenario::HoldMembers).await;
    let mut read = tokio::spawn({
        let runtime = runtime.clone();
        let account = account.clone();
        async move {
            runtime
                .request(request(account), RequestCancellation::new())
                .await
        }
    });
    server.entered.acquire().await.unwrap().forget();
    let lock = tokio::spawn({
        let runtime = runtime.clone();
        let account = account.clone();
        async move {
            runtime
                .request(
                    RuntimeRequest::Lock {
                        account_id: account,
                    },
                    RequestCancellation::new(),
                )
                .await
        }
    });
    let read_result = tokio::time::timeout(std::time::Duration::from_secs(5), &mut read)
        .await
        .expect("Lock must retire a held Team read")
        .unwrap();
    assert_eq!(read_result.unwrap_err().code, RuntimeErrorCode::Cancelled);
    server.release.add_permits(1);
    lock.await.unwrap().unwrap();
    runtime.close().await;
}

#[tokio::test]
async fn removing_the_account_cancels_its_held_team_read() {
    let (runtime, account, server) = setup(TeamScenario::HoldMembers).await;
    let mut read = tokio::spawn({
        let runtime = runtime.clone();
        let account = account.clone();
        async move {
            runtime
                .request(request(account), RequestCancellation::new())
                .await
        }
    });
    server.entered.acquire().await.unwrap().forget();
    let removal = tokio::spawn({
        let runtime = runtime.clone();
        let account = account.clone();
        async move {
            runtime
                .request(
                    RuntimeRequest::RemoveAccount {
                        account_id: account,
                    },
                    RequestCancellation::new(),
                )
                .await
        }
    });
    let read_result = tokio::time::timeout(std::time::Duration::from_secs(5), &mut read)
        .await
        .expect("Account removal must retire a held Team read")
        .unwrap();
    assert_eq!(read_result.unwrap_err().code, RuntimeErrorCode::Cancelled);
    server.release.add_permits(1);
    removal.await.unwrap().unwrap();
    runtime.close().await;
}
