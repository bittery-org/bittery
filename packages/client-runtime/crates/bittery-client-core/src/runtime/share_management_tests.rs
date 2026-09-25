use super::operation_fixtures::*;
use super::*;
use crate::http_transport::SerializedHttpExecutor;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::VecDeque;
use tokio::sync::Semaphore;

struct ShareServer {
    replies: Mutex<VecDeque<Value>>,
    requests: Mutex<Vec<Value>>,
    entered: Semaphore,
    hold: bool,
}
#[async_trait]
impl SerializedHttpExecutor for ShareServer {
    async fn invoke(&self, request: zeroize::Zeroizing<String>) -> Result<String, RuntimeError> {
        self.requests
            .lock()
            .unwrap()
            .push(serde_json::from_str(&request).unwrap());
        self.entered.add_permits(1);
        if self.hold {
            std::future::pending::<()>().await;
        }
        Ok(self
            .replies
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected Share exchange")
            .to_string())
    }
    fn cancel(&self, _: &str) {}
}
async fn setup(replies: Vec<Value>, hold: bool) -> (Arc<Runtime>, AccountId, Arc<ShareServer>) {
    let seed = seeded_with_share_item(true).await;
    let server = Arc::new(ShareServer {
        replies: Mutex::new(replies.into()),
        requests: Mutex::new(Vec::new()),
        entered: Semaphore::new(0),
        hold,
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
async fn setup_link(
    mut replies: Vec<Value>,
    hold: bool,
) -> (Arc<Runtime>, AccountId, Arc<ShareServer>) {
    replies.insert(0, answer(200, links()));
    setup(replies, hold).await
}
fn answer(status: u16, body: Value) -> Value {
    completed(status, serde_json::to_vec(&body).unwrap())
}
fn links() -> Value {
    json!({"baseShareUrl":"https://vault.example.test/share", "links":[{
        "id":"link-1", "status":"active", "accessMode":"email-restricted", "isOneTimeUse":false,
        "accessCount":2, "maxAccessCount":5, "allowedEmails":[{"email":"allowed@example.test","verified":true}],
        "expiresAt":"2099-01-01T00:00:00Z", "createdAt":"2026-01-01T00:00:00Z", "lastAccessedAt":null
    }]})
}
fn list(account_id: &AccountId) -> RuntimeRequest {
    RuntimeRequest::ListItemShareLinks {
        account_id: account_id.clone(),
        item_id: "item-existing".into(),
    }
}
fn logs(account_id: &AccountId) -> RuntimeRequest {
    RuntimeRequest::ListShareAccessLogs {
        account_id: account_id.clone(),
        item_id: "item-existing".into(),
        link_id: "link-1".into(),
    }
}
fn revoke(account_id: &AccountId) -> RuntimeRequest {
    RuntimeRequest::RevokeShareLink {
        account_id: account_id.clone(),
        item_id: "item-existing".into(),
        link_id: "link-1".into(),
    }
}
fn log(id: &str) -> Value {
    json!({"id":id,"success":true,"accessedAt":"2026-01-01T00:00:00Z","accessedByEmail":null,"ipAddress":"127.0.0.1","userAgent":null,"failureReason":null})
}
fn refresh() -> Value {
    answer(
        200,
        json!({"token":SECOND_TOKEN,"sessionId":"session-1","expiresAt":"2099-01-01T00:00:00Z"}),
    )
}
fn bearer(request: &Value) -> &str {
    request["headers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|h| h["name"] == "Authorization")
        .unwrap()["value"]
        .as_str()
        .unwrap()
}

#[tokio::test]
async fn share_history_uses_private_session_and_returns_existing_nonsecret_summary_without_replica_writes(
) {
    let (runtime, account, server) = setup(vec![answer(200, links())], false).await;
    let before = runtime.replica.snapshot(&account).unwrap();
    let result = runtime
        .request(list(&account), RequestCancellation::new())
        .await
        .unwrap();
    let RuntimeResponse::ItemShareLinks {
        account_id,
        item_id,
        links: result,
        base_share_url,
    } = result
    else {
        panic!("wrong Share result")
    };
    assert_eq!(account_id, account);
    assert_eq!(item_id, "item-existing");
    assert_eq!(base_share_url, "https://vault.example.test/share");
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].status, crate::ShareLinkStatus::Active);
    assert_eq!(
        result[0].access_mode,
        crate::ShareAccessMode::EmailRestricted
    );
    assert_eq!(result[0].allowed_emails[0].email, "allowed@example.test");
    assert_eq!(result[0].access_count, 2);
    let after = runtime.replica.snapshot(&account).unwrap();
    assert_eq!(before.revision, after.revision);
    assert_eq!(before.operations.len(), after.operations.len());
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0]["method"], "GET");
    assert_eq!(
        requests[0]["url"],
        format!("{SERVER_URL}/api/v1/items/item-existing/share-links")
    );
    assert_eq!(bearer(&requests[0]), format!("Bearer {FIRST_TOKEN}"));
    assert_eq!(requests[0]["body"], json!([]));
    assert!(requests[0]["headers"]
        .as_array()
        .unwrap()
        .iter()
        .any(|h| h["name"] == "Accept" && h["value"] == "application/json"));
}

#[tokio::test]
async fn share_logs_preserve_page_order_and_opaque_cursors_with_one_renewal_budget_across_pages() {
    let cursor = "opaque+/=cursor";
    let (runtime, account, server) = setup_link(
        vec![
            answer(
                200,
                json!({"items":[log("first")],"hasMore":true,"nextCursor":cursor}),
            ),
            answer(401, json!({})),
            refresh(),
            answer(
                200,
                json!({"items":[log("second")],"hasMore":false,"nextCursor":null}),
            ),
        ],
        false,
    )
    .await;
    let result = runtime
        .request(logs(&account), RequestCancellation::new())
        .await
        .unwrap();
    let RuntimeResponse::ShareAccessLogs { logs, .. } = result else {
        panic!("wrong logs result")
    };
    assert_eq!(
        logs.iter().map(|l| l.id.as_str()).collect::<Vec<_>>(),
        vec!["first", "second"]
    );
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 5);
    assert_eq!(requests[2]["url"], requests[4]["url"]);
    let url = url::Url::parse(requests[2]["url"].as_str().unwrap()).unwrap();
    assert_eq!(
        url.query_pairs().collect::<Vec<_>>(),
        vec![("cursor".into(), cursor.into())]
    );
    assert_eq!(bearer(&requests[4]), format!("Bearer {SECOND_TOKEN}"));
    assert_eq!(requests[3]["method"], "POST");
}

#[tokio::test]
async fn share_logs_reject_missing_or_repeated_cursors_without_publishing_partial_history() {
    for replies in [
        vec![answer(200, json!({"items":[log("hidden")],"hasMore":true}))],
        vec![
            answer(
                200,
                json!({"items":[log("hidden")],"hasMore":true,"nextCursor":"again"}),
            ),
            answer(
                200,
                json!({"items":[],"hasMore":false,"nextCursor":"again"}),
            ),
        ],
    ] {
        let count = replies.len() + 1;
        let (runtime, account, server) = setup_link(replies, false).await;
        assert_eq!(
            runtime
                .request(logs(&account), RequestCancellation::new())
                .await
                .unwrap_err()
                .code,
            RuntimeErrorCode::InvariantViolation
        );
        assert_eq!(server.requests.lock().unwrap().len(), count);
    }
}

#[tokio::test]
async fn share_revoke_requires_explicit_success_and_never_replays_ambiguous_or_refused_deletes() {
    for (reply, expected) in [
        (
            json!({"type":"networkFailure"}),
            RuntimeErrorCode::RetryableTransport,
        ),
        (answer(503, json!({})), RuntimeErrorCode::RetryableTransport),
        (answer(403, json!({})), RuntimeErrorCode::AccessDenied),
        (answer(404, json!({})), RuntimeErrorCode::AuthorityMissing),
        (
            answer(200, json!({"success":false})),
            RuntimeErrorCode::InvariantViolation,
        ),
        (
            answer(200, json!({"success":true,"extra":"not accepted"})),
            RuntimeErrorCode::InvariantViolation,
        ),
    ] {
        let (runtime, account, server) = setup_link(vec![reply], false).await;
        assert_eq!(
            runtime
                .request(revoke(&account), RequestCancellation::new())
                .await
                .unwrap_err()
                .code,
            expected
        );
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[1]["method"], "DELETE");
        assert!(!requests[1]["headers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|h| h["name"] == "Idempotency-Key"));
        assert!(runtime
            .replica
            .snapshot(&account)
            .unwrap()
            .operations
            .is_empty());
    }
    let (runtime, account, _) = setup_link(vec![answer(200, json!({"success":true}))], false).await;
    assert_eq!(
        runtime
            .request(revoke(&account), RequestCancellation::new())
            .await
            .unwrap(),
        RuntimeResponse::ShareLinkRevoked {
            account_id: account,
            link_id: "link-1".into()
        }
    );
}

#[tokio::test]
async fn share_revoke_renews_only_after_explicit_401_and_second_401_requires_reauthentication() {
    for final_status in [200, 401] {
        let (runtime, account, server) = setup_link(
            vec![
                answer(401, json!({})),
                refresh(),
                answer(final_status, json!({"success":true})),
            ],
            false,
        )
        .await;
        let result = runtime
            .request(revoke(&account), RequestCancellation::new())
            .await;
        if final_status == 200 {
            assert!(result.is_ok());
        } else {
            assert_eq!(
                result.unwrap_err().code,
                RuntimeErrorCode::AuthenticationRequired
            );
        }
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests.len(), 4);
        assert_eq!(requests[1]["url"], requests[3]["url"]);
        assert_eq!(bearer(&requests[3]), format!("Bearer {SECOND_TOKEN}"));
    }
}

#[tokio::test]
async fn share_management_missing_account_and_locked_account_do_not_dispatch() {
    let (runtime, account, server) = setup(vec![], false).await;
    assert_eq!(
        runtime
            .request(
                list(&AccountId::from("other-account")),
                RequestCancellation::new()
            )
            .await
            .unwrap_err()
            .code,
        RuntimeErrorCode::AccountMissing
    );
    runtime
        .request(
            RuntimeRequest::Lock {
                account_id: account.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        runtime
            .request(list(&account), RequestCancellation::new())
            .await
            .unwrap_err()
            .code,
        RuntimeErrorCode::AuthenticationRequired
    );
    assert!(server.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn share_management_caller_cancel_lock_and_signout_cancel_hung_requests_before_result_delivery(
) {
    for retirement in ["caller", "lock", "signout", "close"] {
        let (runtime, account, server) = setup(vec![], true).await;
        let cancellation = RequestCancellation::new();
        let work = tokio::spawn({
            let runtime = runtime.clone();
            let request = list(&account);
            let cancel = cancellation.clone();
            async move { runtime.request(request, cancel).await }
        });
        server.entered.acquire().await.unwrap().forget();
        match retirement {
            "caller" => cancellation.cancel(),
            "close" => runtime.close().await,
            _ => {
                runtime
                    .request(
                        if retirement == "lock" {
                            RuntimeRequest::Lock {
                                account_id: account.clone(),
                            }
                        } else {
                            RuntimeRequest::SignOut {
                                account_id: account.clone(),
                            }
                        },
                        RequestCancellation::new(),
                    )
                    .await
                    .unwrap();
            }
        }
        let result = tokio::time::timeout(std::time::Duration::from_secs(2), work)
            .await
            .expect("foreground work did not drain")
            .unwrap();
        assert_eq!(result.unwrap_err().code, RuntimeErrorCode::Cancelled);
        assert_eq!(server.requests.lock().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn share_management_scopes_the_server_and_private_session_to_the_explicit_account() {
    let seed = seeded_with_share_item(true).await;
    let other = AccountId::from("account-2");
    let incarnation = crate::Incarnation::from("incarnation-2");
    seed.replica
        .state
        .install(other.clone(), "user-2".into(), incarnation.clone())
        .unwrap();
    let authority = seed
        .replica
        .state
        .snapshot(&seed.account_id)
        .unwrap()
        .bootstrap
        .snapshot();
    seed.replica
        .state
        .seed_ready_authority(&other, authority.visible_vaults, authority.visible_items)
        .unwrap();
    let server = Arc::new(ShareServer {
        replies: Mutex::new(vec![answer(200, links()), answer(200, links())].into()),
        requests: Mutex::new(Vec::new()),
        entered: Semaphore::new(0),
        hold: false,
    });
    let runtime = Runtime::with_test_dispatch_environment(
        seed.replica,
        seed.platform,
        server.clone(),
        auth_config(),
        seed.clock,
        seed.timer,
    );
    for account in [&seed.account_id, &other] {
        runtime.replica.load(account).await.unwrap().unwrap();
        runtime.unlock_account(account).await.unwrap();
    }
    let mut metadata = runtime
        .platform_storage
        .load_account_metadata(&seed.account_id, &crate::Incarnation::from(INCARNATION))
        .await
        .unwrap()
        .unwrap();
    metadata.account_id = other.clone();
    metadata.incarnation = incarnation.clone();
    metadata.user_id = "user-2".into();
    metadata.normalized_server_url = "https://other.example.test".into();
    runtime
        .platform_storage
        .store_account_metadata(&metadata)
        .await
        .unwrap();
    let other_session = crate::platform_storage::CurrentSessionDocument::new(
        other.clone(),
        incarnation,
        "other-private-session".into(),
        Some("other-session-id".into()),
        START_MS + 3_600_000,
        Some(START_MS + 3_600_000),
        Vec::new(),
        "other-encrypted-key".into(),
    )
    .unwrap();
    runtime
        .platform_storage
        .store_current_session(&other_session)
        .await
        .unwrap();
    for account in [&other, &seed.account_id] {
        let RuntimeResponse::ItemShareLinks { account_id, .. } = runtime
            .request(list(account), RequestCancellation::new())
            .await
            .unwrap()
        else {
            panic!("wrong result")
        };
        assert_eq!(&account_id, account);
    }
    let requests = server.requests.lock().unwrap();
    assert_eq!(
        requests[0]["url"],
        "https://other.example.test/api/v1/items/item-existing/share-links"
    );
    assert_eq!(bearer(&requests[0]), "Bearer other-private-session");
    assert_eq!(
        requests[1]["url"],
        format!("{SERVER_URL}/api/v1/items/item-existing/share-links")
    );
    assert_eq!(bearer(&requests[1]), format!("Bearer {FIRST_TOKEN}"));
}

#[tokio::test]
async fn share_log_pagination_does_not_reset_the_session_renewal_budget() {
    let (runtime, account, server) = setup_link(
        vec![
            answer(401, json!({})),
            refresh(),
            answer(
                200,
                json!({"items":[log("first")],"hasMore":true,"nextCursor":"second"}),
            ),
            answer(401, json!({})),
        ],
        false,
    )
    .await;
    assert_eq!(
        runtime
            .request(logs(&account), RequestCancellation::new())
            .await
            .unwrap_err()
            .code,
        RuntimeErrorCode::AuthenticationRequired
    );
    assert_eq!(server.requests.lock().unwrap().len(), 5);
}

#[tokio::test]
async fn selective_share_actions_require_authenticated_parent_membership() {
    for request in [logs, revoke] {
        let (runtime, account, server) = setup(
            vec![answer(
                200,
                json!({"baseShareUrl":"https://vault.example.test/share", "links":[]}),
            )],
            false,
        )
        .await;
        let failure = runtime
            .request(request(&account), RequestCancellation::new())
            .await
            .expect_err("unproven Link parent must be refused");
        assert_eq!(failure.code, RuntimeErrorCode::AccessDenied);
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert!(requests[0]["url"]
            .as_str()
            .unwrap()
            .ends_with("/items/item-existing/share-links"));
    }
}

#[tokio::test]
async fn selective_share_retirement_cancels_its_parent_vault_before_http_returns() {
    let (runtime, account, server) = setup(vec![], true).await;
    let mut request = tokio::spawn({
        let runtime = runtime.clone();
        let account = account.clone();
        async move {
            runtime
                .request(list(&account), RequestCancellation::new())
                .await
        }
    });
    server.entered.acquire().await.unwrap().forget();
    let retirement = runtime
        .foreground_attachments
        .begin_vault_retirement(
            &account,
            &runtime.replica.snapshot(&account).unwrap().incarnation,
            &[crate::test_fixtures::TEST_VAULT_ID.into()],
            super::foreground_attachment_lifecycle::VaultRetirementProof::DurableJournal {
                revision: runtime.replica.snapshot(&account).unwrap().revision,
            },
        )
        .unwrap();
    let result = tokio::time::timeout(std::time::Duration::from_secs(1), &mut request).await;
    if result.is_err() {
        request.abort();
    }
    assert_eq!(
        result
            .expect("Vault retirement must cancel its Share request")
            .unwrap()
            .err()
            .unwrap()
            .code,
        RuntimeErrorCode::Cancelled
    );
    retirement.drain().await;
}
