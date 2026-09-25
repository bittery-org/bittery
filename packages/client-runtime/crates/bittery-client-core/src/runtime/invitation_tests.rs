use super::operation_fixtures::*;
use super::*;
use crate::http_transport::SerializedHttpExecutor;
use crate::protocol::Incarnation;
use crate::test_fixtures::TEST_VAULT_ID;
use async_trait::async_trait;
use bittery_crypto_core::rsa::rsa_public_key_fingerprint;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};

struct InvitationServer {
    requests: Mutex<Vec<Value>>,
    recipient_public_key: String,
    wrapped_vault_key: String,
    scenario: InvitationScenario,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum InvitationScenario {
    ExistingRecipient,
    NewRecipient,
    LostFirstSend,
    LostExecutorReply,
    HostCancelledFirstSend,
    LostCancellation,
    RejectedReplacement,
    ChangedOriginalEmail,
    ChangedVaultWrap,
    PartiallyAccessibleVaults,
    TooManyAccessibleVaults,
    LostAdminResend,
    ChangedAvailableKey,
    ChangedAvailableKeyAfterSeal,
    LostAddReply,
    LostAddExecutorReply,
    RefusedAvailable,
    RenewAddSession,
}

#[async_trait]
impl SerializedHttpExecutor for InvitationServer {
    async fn invoke(&self, request: zeroize::Zeroizing<String>) -> Result<String, RuntimeError> {
        let request: Value = serde_json::from_str(&request).unwrap();
        let url = url::Url::parse(request["url"].as_str().unwrap()).unwrap();
        let path = url.path();
        let method = request["method"].as_str().unwrap();
        let previous_sends = self
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|entry| {
                entry["method"] == "POST"
                    && entry["url"]
                        .as_str()
                        .unwrap()
                        .ends_with("/teams/team-1/invitations")
            })
            .count();
        let prior_available = self
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|entry| {
                entry["method"] == "GET"
                    && entry["url"]
                        .as_str()
                        .unwrap()
                        .contains("/vaults/vault-1/available-team-members")
            })
            .count();
        if method == "GET" && path == "/api/v1/vaults/vault-1/available-team-members" {
            if self.scenario == InvitationScenario::RefusedAvailable {
                self.requests.lock().unwrap().push(request);
                return Ok(completed(403, b"{}".to_vec()).to_string());
            }
            if self.scenario == InvitationScenario::RenewAddSession && prior_available == 0 {
                self.requests.lock().unwrap().push(request);
                let mut response = completed(
                    401,
                    serde_json::to_vec(&json!({
                        "type":"https://bittery.com/problems/unauthorized", "title":"Unauthorized",
                        "status":401, "code":"UNAUTHORIZED", "detail":"Session expired",
                        "instance":path, "requestId":"member-401", "retryable":false
                    }))
                    .unwrap(),
                );
                response["headers"][0]["value"] = json!("application/problem+json");
                return Ok(response.to_string());
            }
        }
        if method == "PUT"
            && path == "/api/v1/vaults/vault-1/members/recipient-1"
            && (self.scenario == InvitationScenario::LostAddReply
                || self.scenario == InvitationScenario::LostAddExecutorReply)
        {
            self.requests.lock().unwrap().push(request);
            if self.scenario == InvitationScenario::LostAddExecutorReply {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::InvariantViolation,
                    "host reply lost after Add-Member dispatch",
                ));
            }
            return Ok(json!({"type":"networkFailure"}).to_string());
        }
        if method == "POST" && path == "/api/v1/teams/team-1/invitations" {
            let lost = self.scenario == InvitationScenario::LostFirstSend && previous_sends == 0;
            let executor_failed =
                self.scenario == InvitationScenario::LostExecutorReply && previous_sends == 0;
            let host_cancelled =
                self.scenario == InvitationScenario::HostCancelledFirstSend && previous_sends == 0;
            let rejected =
                self.scenario == InvitationScenario::RejectedReplacement && previous_sends > 0;
            if lost || executor_failed || host_cancelled || rejected {
                self.requests.lock().unwrap().push(request);
                if executor_failed {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::InvariantViolation,
                        "host reply disappeared after dispatch",
                    ));
                }
                return Ok(if lost {
                    json!({"type": "networkFailure"}).to_string()
                } else if host_cancelled {
                    json!({"type": "cancelled"}).to_string()
                } else {
                    completed(409, b"{}".to_vec()).to_string()
                });
            }
        }
        if method == "DELETE"
            && path == "/api/v1/teams/team-1/invitations/invitation-original"
            && self.scenario == InvitationScenario::LostCancellation
        {
            self.requests.lock().unwrap().push(request);
            return Ok(json!({"type": "networkFailure"}).to_string());
        }
        if method == "POST"
            && path == "/api/v1/teams/team-1/invitations/invitation-original/resend"
            && self.scenario == InvitationScenario::LostAdminResend
        {
            self.requests.lock().unwrap().push(request);
            return Ok(json!({"type": "networkFailure"}).to_string());
        }
        let body = match (method, path) {
            ("GET", "/api/v1/users/me") => json!({
                "id": USER, "email": "owner@example.test", "name": "Owner", "role": "owner",
                "publicKey": "owner-key", "encryptedPrivateKey": "private-not-for-host",
                "hasRecoveryKey": false, "createdAt": "2026-01-01T00:00:00Z"
            }),
            ("GET", "/api/v1/teams/current") => json!({
                "id": "team-1", "name": "Runtime Team", "teamType": "organization",
                "ownerId": USER, "role": "owner", "memberCount": "1",
                "createdAt": "2026-01-01T00:00:00Z"
            }),
            ("GET", "/api/v1/teams/team-1") => json!({
                "id": "team-1", "name": "Runtime Team", "teamType": "organization",
                "ownerId": USER, "ownerName": "Owner", "userRole": "owner",
                "memberCount": "1", "createdAt": "2026-01-01T00:00:00Z",
                "updatedAt": "2026-01-01T00:00:00Z"
            }),
            ("GET", "/api/v1/billing/entitlements") => json!({
                "mode": "cloud", "billingEnabled": true, "plan": "team", "status": "active",
                "isActive": true,
                "entitlements": {"sentinel": true, "teamManagement": true, "vaultSharing": true,
                    "shareLinks": true, "billingPortal": true, "attachments": true},
                "limits": {}
            }),
            ("GET", "/api/v1/billing/status") => json!({
                "enabled": true, "plan": "team", "isActive": true,
                "status": "active", "requiresPayment": true,
                "isStripeConfigured": true, "cancelAtPeriodEnd": false
            }),
            ("GET", "/api/v1/billing/team-seats/addition-preview") => Value::Null,
            ("GET", "/api/v1/teams/team-1/vaults") => {
                let mut items = vec![json!({
                    "id": TEST_VAULT_ID, "name": "Shared",
                    "encryptedVaultKey": if self.scenario == InvitationScenario::ChangedVaultWrap {
                        "changed-wrap"
                    } else {
                        &self.wrapped_vault_key
                    }
                })];
                if self.scenario == InvitationScenario::PartiallyAccessibleVaults {
                    items.push(json!({
                        "id": "vault-not-joined", "name": "Another member's Vault",
                        "encryptedVaultKey": null
                    }));
                }
                if self.scenario == InvitationScenario::TooManyAccessibleVaults {
                    for index in 0..100 {
                        items.push(json!({
                            "id": format!("additional-team-vault-{index}"),
                            "name": "Additional Team Vault",
                            "encryptedVaultKey": &self.wrapped_vault_key
                        }));
                    }
                }
                json!({"items": items, "hasMore": false, "nextCursor": null})
            }
            ("GET", "/api/v1/vaults/vault-1/available-team-members") => json!({
                "items": [{"userId": "recipient-1", "name": "Recipient",
                    "email": "recipient@example.test", "publicKey":
                        if (self.scenario == InvitationScenario::ChangedAvailableKey && prior_available >= 1)
                        || (self.scenario == InvitationScenario::ChangedAvailableKeyAfterSeal && prior_available >= 1) {
                            format!("{}-changed", self.recipient_public_key)
                        } else { self.recipient_public_key.clone() }}],
                "hasMore": false, "nextCursor": null
            }),
            ("GET", "/api/v1/vaults/vault-1/members") => json!({
                "items": if matches!(self.scenario, InvitationScenario::LostAddReply | InvitationScenario::LostAddExecutorReply) {
                    vec![json!({"userId": USER, "name": "Owner", "email": "owner@example.test", "role": "owner"}),
                        json!({"userId": "recipient-1", "name": "Recipient", "email": "recipient@example.test", "role": "member"})]
                } else { vec![json!({"userId": USER, "name": "Owner", "email": "owner@example.test", "role": "owner"})] },
                "hasMore": false, "nextCursor": null
            }),
            ("PUT", "/api/v1/vaults/vault-1/members/recipient-1") => json!({"success": true}),
            ("POST", "/api/v1/sessions/current/refresh") => json!({
                "token":"renewed-member-session", "sessionId":"session-1",
                "expiresAt":"2099-01-01T00:00:00Z"
            }),
            ("GET", "/api/v1/teams/team-1/invitations") => json!({
                "items": [{"id": "invitation-original", "email":
                    if self.scenario == InvitationScenario::ChangedOriginalEmail {
                        "different@example.test"
                    } else {
                        "recipient@example.test"
                    },
                    "role": "member", "status": "pending", "invitedBy": USER,
                    "createdAt": "2026-01-01T00:00:00Z", "expiresAt": "2099-01-01T00:00:00Z"}],
                "hasMore": false, "nextCursor": null
            }),
            ("POST", "/api/v1/teams/team-1/invitations") => json!({
                "invitationId": if previous_sends == 0 {"invitation-original"} else {"invitation-replacement"},
                "token": if previous_sends == 0 {"first-token"} else {"replacement-token"},
                "existingUserId": if self.scenario == InvitationScenario::NewRecipient {
                    Value::Null
                } else {
                    json!("recipient-1")
                },
                "existingUserPublicKey": if self.scenario == InvitationScenario::NewRecipient {
                    Value::Null
                } else {
                    json!(self.recipient_public_key)
                }
            }),
            ("DELETE", "/api/v1/teams/team-1/invitations/invitation-original") => {
                json!({"success": true})
            }
            ("POST", "/api/v1/teams/team-1/invitations/invitation-original/resend") => {
                json!({"invitationId": "invitation-original", "token": "rotated-once-token"})
            }
            _ => panic!("unexpected Invitation request: {method} {path}"),
        };
        self.requests.lock().unwrap().push(request);
        Ok(completed(200, serde_json::to_vec(&body).unwrap()).to_string())
    }

    fn cancel(&self, _: &str) {}
}

#[tokio::test]
async fn vault_member_requires_exact_verified_current_candidate_and_seals_inside_core() {
    let seed = seeded_with_team_vault(true).await;
    let vault = seed
        .replica
        .state
        .snapshot(&seed.account_id)
        .unwrap()
        .bootstrap
        .snapshot()
        .visible_vaults[0]
        .clone();
    let recipient = bittery_crypto_core::generate_rsa_key_pair().unwrap();
    let fingerprint = rsa_public_key_fingerprint(&recipient.public_key).unwrap();
    let server = Arc::new(InvitationServer {
        requests: Mutex::new(Vec::new()),
        recipient_public_key: recipient.public_key.clone(),
        wrapped_vault_key: vault.encrypted_vault_key,
        scenario: InvitationScenario::ExistingRecipient,
    });
    let account_id = seed.account_id.clone();
    let runtime = Runtime::with_test_dispatch_environment(
        seed.replica,
        seed.platform,
        server.clone(),
        auth_config(),
        seed.clock,
        seed.timer,
    );
    runtime.replica.load(&account_id).await.unwrap().unwrap();
    runtime.unlock_account(&account_id).await.unwrap();
    let add = || {
        serde_json::from_value::<RuntimeRequest>(json!({
            "type": "addVaultMember", "accountId": account_id,
            "vaultId": TEST_VAULT_ID, "userId": "recipient-1", "role": "member"
        }))
        .expect("closed Add-Member request")
    };
    assert!(runtime
        .request(add(), RequestCancellation::new())
        .await
        .is_err());
    assert!(!server
        .requests
        .lock()
        .unwrap()
        .iter()
        .any(|r| r["method"] == "PUT"));
    let scope = match runtime
        .request(
            RuntimeRequest::RecipientKeyScope {
                account_id: account_id.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    {
        RuntimeResponse::RecipientKeyScope { scope } => scope,
        _ => panic!("recipient scope"),
    };
    runtime
        .request(
            RuntimeRequest::VerifyRecipientKey {
                account_id: account_id.clone(),
                recipient_user_id: "recipient-1".into(),
                public_key: recipient.public_key.clone(),
                expected_fingerprint: fingerprint,
                scope,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let response = runtime
        .request(add(), RequestCancellation::new())
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(response).unwrap()["type"],
        "vaultMemberAdded"
    );
    let puts = server
        .requests
        .lock()
        .unwrap()
        .iter()
        .filter(|r| r["method"] == "PUT")
        .count();
    assert_eq!(puts, 1);
    runtime.close().await;
}

fn add_member_request(account_id: &AccountId) -> RuntimeRequest {
    RuntimeRequest::AddVaultMember {
        account_id: account_id.clone(),
        vault_id: TEST_VAULT_ID.into(),
        user_id: "recipient-1".into(),
        role: crate::server_contract::VaultRole::Member,
    }
}

#[tokio::test]
async fn vault_member_changed_key_wrapper_or_permission_refuses_without_put() {
    for scenario in [
        InvitationScenario::ChangedAvailableKey,
        InvitationScenario::ChangedAvailableKeyAfterSeal,
        InvitationScenario::ChangedVaultWrap,
        InvitationScenario::RefusedAvailable,
    ] {
        let (runtime, server, account, key, fingerprint, _) = prepared_invitation(scenario).await;
        if scenario == InvitationScenario::ChangedAvailableKey {
            let response = runtime
                .request(
                    RuntimeRequest::ListAvailableVaultMembers {
                        account_id: account.clone(),
                        vault_id: TEST_VAULT_ID.into(),
                    },
                    RequestCancellation::new(),
                )
                .await
                .unwrap();
            let value = serde_json::to_value(response).unwrap();
            assert_eq!(value["members"][0]["publicKey"], key);
        }
        verify_recipient(&runtime, &account, &key, &fingerprint).await;
        assert!(
            runtime
                .request(add_member_request(&account), RequestCancellation::new())
                .await
                .is_err(),
            "stale or refused authority must stop Add-Member"
        );
        assert!(!server
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|r| r["method"] == "PUT"));
        runtime.close().await;
    }
}

#[tokio::test]
async fn vault_member_lost_reply_reports_identity_only_without_retry_or_success_proof() {
    for scenario in [
        InvitationScenario::LostAddReply,
        InvitationScenario::LostAddExecutorReply,
    ] {
        let (runtime, server, account, key, fingerprint, _) = prepared_invitation(scenario).await;
        verify_recipient(&runtime, &account, &key, &fingerprint).await;
        let response = runtime
            .request(add_member_request(&account), RequestCancellation::new())
            .await
            .unwrap();
        let value = serde_json::to_value(response).unwrap();
        assert_eq!(value["type"], "vaultMemberAddUncertain");
        assert_eq!(value["currentRole"], "member");
        assert_eq!(value["userId"], "recipient-1");
        assert_eq!(
            server
                .requests
                .lock()
                .unwrap()
                .iter()
                .filter(|r| r["method"] == "PUT")
                .count(),
            1
        );
        runtime.close().await;
    }
}

#[tokio::test]
async fn vault_member_closed_request_refuses_host_key_ciphertext_and_owner_role() {
    for field in ["publicKey", "encryptedVaultKey", "bearer", "url"] {
        let mut request = json!({"type":"addVaultMember", "accountId":"account-1",
            "vaultId":TEST_VAULT_ID, "userId":"recipient-1", "role":"member"});
        request[field] = json!("host-controlled");
        assert!(serde_json::from_value::<RuntimeRequest>(request).is_err());
    }
    let (runtime, server, account, key, fingerprint, _) =
        prepared_invitation(InvitationScenario::ExistingRecipient).await;
    verify_recipient(&runtime, &account, &key, &fingerprint).await;
    let owner = RuntimeRequest::AddVaultMember {
        account_id: account.clone(),
        vault_id: TEST_VAULT_ID.into(),
        user_id: "recipient-1".into(),
        role: crate::server_contract::VaultRole::Owner,
    };
    assert!(runtime
        .request(owner, RequestCancellation::new())
        .await
        .is_err());
    assert!(!server
        .requests
        .lock()
        .unwrap()
        .iter()
        .any(|r| r["method"] == "PUT"));
    runtime.close().await;
}

#[tokio::test]
async fn vault_member_read_renews_same_account_session_only_once_before_put() {
    let (runtime, server, account, key, fingerprint, _) =
        prepared_invitation(InvitationScenario::RenewAddSession).await;
    verify_recipient(&runtime, &account, &key, &fingerprint).await;
    let result = runtime
        .request(add_member_request(&account), RequestCancellation::new())
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(result).unwrap()["type"],
        "vaultMemberAdded"
    );
    {
        let requests = server.requests.lock().unwrap();
        assert_eq!(
            requests
                .iter()
                .filter(|r| r["url"]
                    .as_str()
                    .unwrap()
                    .ends_with("/sessions/current/refresh"))
                .count(),
            1
        );
        assert_eq!(requests.iter().filter(|r| r["method"] == "PUT").count(), 1);
    }
    runtime.close().await;
}

struct HoldSecondAvailableRead {
    inner: Arc<InvitationServer>,
    available_reads: AtomicUsize,
    entered: tokio::sync::Notify,
    release: tokio::sync::Notify,
}

#[async_trait]
impl SerializedHttpExecutor for HoldSecondAvailableRead {
    async fn invoke(&self, request: zeroize::Zeroizing<String>) -> Result<String, RuntimeError> {
        let value: Value = serde_json::from_str(&request).unwrap();
        let url = value["url"].as_str().unwrap();
        if url.contains("/vaults/vault-1/available-team-members")
            && self.available_reads.fetch_add(1, Ordering::SeqCst) == 1
        {
            self.entered.notify_one();
            self.release.notified().await;
        }
        self.inner.invoke(request).await
    }
    fn cancel(&self, dispatch_id: &str) {
        self.inner.cancel(dispatch_id);
    }
}

#[tokio::test]
async fn vault_member_held_after_sealing_retires_on_caller_loss_lock_and_replacement() {
    for retirement in ["caller-loss", "lock", "replacement"] {
        let seed = seeded_with_team_vault(true).await;
        let vault = seed
            .replica
            .state
            .snapshot(&seed.account_id)
            .unwrap()
            .bootstrap
            .snapshot()
            .visible_vaults[0]
            .clone();
        let recipient = bittery_crypto_core::generate_rsa_key_pair().unwrap();
        let fingerprint = rsa_public_key_fingerprint(&recipient.public_key).unwrap();
        let inner = Arc::new(InvitationServer {
            requests: Mutex::new(Vec::new()),
            recipient_public_key: recipient.public_key.clone(),
            wrapped_vault_key: vault.encrypted_vault_key,
            scenario: InvitationScenario::ExistingRecipient,
        });
        let gate = Arc::new(HoldSecondAvailableRead {
            inner: inner.clone(),
            available_reads: AtomicUsize::new(0),
            entered: tokio::sync::Notify::new(),
            release: tokio::sync::Notify::new(),
        });
        let account = seed.account_id.clone();
        let replica = seed.replica.clone();
        let runtime = Runtime::with_test_dispatch_environment(
            seed.replica,
            seed.platform,
            gate.clone(),
            auth_config(),
            seed.clock,
            seed.timer,
        );
        runtime.replica.load(&account).await.unwrap().unwrap();
        runtime.unlock_account(&account).await.unwrap();
        verify_recipient(&runtime, &account, &recipient.public_key, &fingerprint).await;
        let cancellation = RequestCancellation::new();
        let running = {
            let runtime = runtime.clone();
            let account = account.clone();
            let cancellation = cancellation.clone();
            tokio::spawn(async move {
                runtime
                    .request(add_member_request(&account), cancellation)
                    .await
            })
        };
        gate.entered.notified().await;
        if retirement == "lock" {
            // Hold the lifecycle fence so retirement intent remains observable even when
            // cancelling the held HTTP read lets the request drop its execution fence quickly.
            let lifecycle = runtime.account_lifecycle_lock(&account).unwrap();
            let lifecycle_guard = lifecycle.lock().await;
            let retiring_runtime = runtime.clone();
            let retiring_account = account.clone();
            let retiring = tokio::spawn(async move {
                retiring_runtime
                    .mark_account_locked(&retiring_account)
                    .await
            });
            tokio::time::timeout(std::time::Duration::from_secs(5), async {
                while !runtime.account_access_retirement_is_pending(&account) {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("Lock must register retirement intent");
            assert!(!retiring.is_finished());
            gate.release.notify_one();
            drop(lifecycle_guard);
            retiring.await.unwrap().unwrap();
            assert!(runtime
                .copy_live_vault_key_material(
                    &account,
                    &runtime.require_snapshot(&account).unwrap().incarnation
                )
                .is_none());
        } else if retirement == "replacement" {
            let user_id = runtime.require_snapshot(&account).unwrap().user_id;
            replica
                .state
                .invoke(crate::replica::ReplicaPersistenceRequest::DeleteAccount {
                    account_id: account.clone(),
                })
                .await
                .unwrap();
            replica
                .state
                .install(
                    account.clone(),
                    user_id,
                    Incarnation::from("replacement-incarnation"),
                )
                .unwrap();
            let replacement = runtime.replica.load(&account).await.unwrap().unwrap();
            assert_eq!(
                replacement.incarnation,
                Incarnation::from("replacement-incarnation")
            );
            gate.release.notify_one();
        } else {
            cancellation.cancel();
            gate.release.notify_one();
        }
        assert!(running.await.unwrap().is_err());
        assert_eq!(gate.available_reads.load(Ordering::SeqCst), 2);
        assert!(!inner
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|r| r["method"] == "PUT"));
        runtime.close().await;
    }
}

#[tokio::test]
async fn existing_recipient_invitation_uses_one_bound_verified_continuation() {
    let seed = seeded_with_team_vault(true).await;
    let vault = seed
        .replica
        .state
        .snapshot(&seed.account_id)
        .unwrap()
        .bootstrap
        .snapshot()
        .visible_vaults[0]
        .clone();
    let recipient = bittery_crypto_core::generate_rsa_key_pair().unwrap();
    let fingerprint = rsa_public_key_fingerprint(&recipient.public_key).unwrap();
    let server = Arc::new(InvitationServer {
        requests: Mutex::new(Vec::new()),
        recipient_public_key: recipient.public_key.clone(),
        wrapped_vault_key: vault.encrypted_vault_key,
        scenario: InvitationScenario::ExistingRecipient,
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

    let composer: RuntimeRequest = serde_json::from_value(json!({
        "type": "readInvitationComposer", "accountId": seed.account_id, "teamId": "team-1"
    }))
    .expect("Invitation composer must be a closed Runtime request");
    let composer = runtime
        .request(composer, RequestCancellation::new())
        .await
        .unwrap();
    let composer = serde_json::to_value(composer).unwrap();
    assert_eq!(composer["type"], "invitationComposer");
    assert_eq!(composer["composer"]["teamId"], "team-1");
    assert_eq!(composer["composer"]["vaults"][0]["id"], TEST_VAULT_ID);

    let create: RuntimeRequest = serde_json::from_value(json!({
        "type": "createTeamInvitation", "accountId": seed.account_id,
        "teamId": "team-1", "email": "  RECIPIENT@EXAMPLE.TEST  ", "role": "member"
    }))
    .expect("Invitation creation must be a closed Runtime request");
    let created = runtime
        .request(create, RequestCancellation::new())
        .await
        .unwrap();
    let created = serde_json::to_value(created).unwrap();
    assert_eq!(created["token"], "first-token");
    assert_eq!(created["invitationId"], "invitation-original");
    assert_eq!(created["candidate"]["recipientUserId"], "recipient-1");
    assert_eq!(created["candidate"]["publicKey"], recipient.public_key);
    assert_eq!(created["candidate"]["fingerprint"], fingerprint);
    let continuation = created["continuationId"].as_str().unwrap().to_owned();

    let first_send = server
        .requests
        .lock()
        .unwrap()
        .iter()
        .find(|request| request["method"] == "POST")
        .unwrap()
        .clone();
    let body: Vec<u8> = serde_json::from_value(first_send["body"].clone()).unwrap();
    let body: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(body["pendingVaultKeys"], Value::Null);
    assert_eq!(body["email"], "recipient@example.test");
    assert_eq!(body["role"], "member");

    let provision = || {
        serde_json::from_value::<RuntimeRequest>(json!({
            "type": "provisionTeamInvitation", "accountId": seed.account_id,
            "continuationId": continuation
        }))
        .unwrap()
    };
    assert!(runtime
        .request(provision(), RequestCancellation::new())
        .await
        .is_err());
    assert_eq!(
        server
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|request| request["method"] == "DELETE")
            .count(),
        0
    );

    let scope = match runtime
        .request(
            RuntimeRequest::RecipientKeyScope {
                account_id: seed.account_id.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    {
        RuntimeResponse::RecipientKeyScope { scope } => scope,
        _ => panic!("Recipient scope"),
    };
    runtime
        .request(
            RuntimeRequest::VerifyRecipientKey {
                account_id: seed.account_id.clone(),
                recipient_user_id: "recipient-1".into(),
                public_key: recipient.public_key.clone(),
                expected_fingerprint: fingerprint,
                scope,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let provisioned = runtime
        .request(provision(), RequestCancellation::new())
        .await
        .unwrap();
    let provisioned = serde_json::to_value(provisioned).unwrap();
    assert_eq!(provisioned["token"], "replacement-token");
    {
        let requests = server.requests.lock().unwrap();
        let mut mutations = requests
            .iter()
            .filter(|request| request["method"] == "POST" || request["method"] == "DELETE");
        assert_eq!(mutations.next().unwrap()["method"], "POST");
        assert_eq!(mutations.next().unwrap()["method"], "DELETE");
        let replacement = mutations.next().unwrap();
        assert_eq!(replacement["method"], "POST");
        let replacement_body: Vec<u8> =
            serde_json::from_value(replacement["body"].clone()).unwrap();
        let replacement_body: Value = serde_json::from_slice(&replacement_body).unwrap();
        assert_eq!(
            replacement_body["pendingVaultKeys"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            replacement_body["pendingVaultKeys"][0]["vaultId"],
            TEST_VAULT_ID
        );
        assert!(mutations.next().is_none(), "one replacement is submitted");
    }
    runtime.close().await;
}

async fn prepared_invitation(
    scenario: InvitationScenario,
) -> (
    Arc<Runtime>,
    Arc<InvitationServer>,
    AccountId,
    String,
    String,
    Arc<TestClock>,
) {
    let seed = seeded_with_team_vault(true).await;
    let vault = seed
        .replica
        .state
        .snapshot(&seed.account_id)
        .unwrap()
        .bootstrap
        .snapshot()
        .visible_vaults[0]
        .clone();
    let recipient = bittery_crypto_core::generate_rsa_key_pair().unwrap();
    let fingerprint = rsa_public_key_fingerprint(&recipient.public_key).unwrap();
    let server = Arc::new(InvitationServer {
        requests: Mutex::new(Vec::new()),
        recipient_public_key: recipient.public_key.clone(),
        wrapped_vault_key: vault.encrypted_vault_key,
        scenario,
    });
    let clock = seed.clock.clone();
    let account_id = seed.account_id.clone();
    let runtime = Runtime::with_test_dispatch_environment(
        seed.replica,
        seed.platform,
        server.clone(),
        auth_config(),
        seed.clock,
        seed.timer,
    );
    runtime.replica.load(&account_id).await.unwrap().unwrap();
    runtime.unlock_account(&account_id).await.unwrap();
    (
        runtime,
        server,
        account_id,
        recipient.public_key.clone(),
        fingerprint,
        clock,
    )
}

async fn create_invitation(runtime: &Runtime, account_id: &AccountId) -> Value {
    let response = runtime
        .request(
            RuntimeRequest::CreateTeamInvitation {
                account_id: account_id.clone(),
                team_id: "team-1".into(),
                email: "recipient@example.test".into(),
                role: crate::server_contract::TeamRole::Member,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    serde_json::to_value(response).unwrap()
}

async fn verify_recipient(
    runtime: &Runtime,
    account_id: &AccountId,
    public_key: &str,
    fingerprint: &str,
) {
    let scope = match runtime
        .request(
            RuntimeRequest::RecipientKeyScope {
                account_id: account_id.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    {
        RuntimeResponse::RecipientKeyScope { scope } => scope,
        _ => panic!("Recipient scope"),
    };
    runtime
        .request(
            RuntimeRequest::VerifyRecipientKey {
                account_id: account_id.clone(),
                recipient_user_id: "recipient-1".into(),
                public_key: public_key.into(),
                expected_fingerprint: fingerprint.into(),
                scope,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
}

fn mutation_methods(server: &InvitationServer) -> Vec<String> {
    server
        .requests
        .lock()
        .unwrap()
        .iter()
        .filter_map(|request| match request["method"].as_str()? {
            "POST" => Some("POST".into()),
            "DELETE" => Some("DELETE".into()),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn new_recipient_has_one_token_and_no_provisioning_continuation() {
    let (runtime, server, account, _, _, _) =
        prepared_invitation(InvitationScenario::NewRecipient).await;
    let created = create_invitation(&runtime, &account).await;
    assert_eq!(created["type"], "teamInvitationCreated");
    assert_eq!(created["token"], "first-token");
    assert!(created["candidate"].is_null());
    assert!(created["continuationId"].is_null());
    assert_eq!(mutation_methods(&server), ["POST"]);
    runtime.close().await;
}

#[tokio::test]
async fn admin_cancel_and_resend_use_current_team_and_one_time_token_outcomes() {
    for (action, scenario) in [
        (
            "cancelTeamInvitation",
            InvitationScenario::ExistingRecipient,
        ),
        (
            "resendTeamInvitation",
            InvitationScenario::ExistingRecipient,
        ),
        ("resendTeamInvitation", InvitationScenario::LostAdminResend),
    ] {
        let (runtime, server, account, _, _, _) = prepared_invitation(scenario).await;
        let request = |team_id: &str| -> RuntimeRequest {
            serde_json::from_value(json!({
                "type": action,
                "accountId": account,
                "teamId": team_id,
                "invitationId": "invitation-original"
            }))
            .expect("admin Invitation action must be a closed Runtime request")
        };
        assert!(runtime
            .request(request("another-team"), RequestCancellation::new())
            .await
            .is_err());
        assert!(mutation_methods(&server).is_empty());
        let response = runtime
            .request(request("team-1"), RequestCancellation::new())
            .await
            .unwrap();
        let response = serde_json::to_value(response).unwrap();
        if action == "cancelTeamInvitation" {
            assert_eq!(response["type"], "teamInvitationCancelled");
            assert_eq!(mutation_methods(&server), ["DELETE"]);
        } else if scenario == InvitationScenario::LostAdminResend {
            assert_eq!(response["type"], "teamInvitationAdminUncertain");
            assert_eq!(response["action"], "resend");
            assert_eq!(response["invitationId"], "invitation-original");
            assert_eq!(response["pending"], true);
            assert!(response.get("token").is_none());
            assert_eq!(mutation_methods(&server), ["POST"]);
        } else {
            assert_eq!(response["type"], "teamInvitationResent");
            assert_eq!(response["invitationId"], "invitation-original");
            assert_eq!(response["token"], "rotated-once-token");
            assert_eq!(mutation_methods(&server), ["POST"]);
        }
        runtime.close().await;
    }
}

#[tokio::test]
async fn lost_first_send_is_uncertain_and_never_replays_for_a_token() {
    for scenario in [
        InvitationScenario::LostFirstSend,
        InvitationScenario::LostExecutorReply,
        InvitationScenario::HostCancelledFirstSend,
    ] {
        let (runtime, server, account, _, _, _) = prepared_invitation(scenario).await;
        let response = create_invitation(&runtime, &account).await;
        assert_eq!(response["type"], "teamInvitationUncertain");
        assert_eq!(response["phase"], "firstSend");
        assert!(response.get("token").is_none());
        assert_eq!(mutation_methods(&server), ["POST"]);
        runtime.close().await;
    }
}

#[tokio::test]
async fn lost_cancel_and_rejected_replacement_consume_the_exact_continuation() {
    for (scenario, phase, methods) in [
        (
            InvitationScenario::LostCancellation,
            "cancelOriginal",
            vec!["POST", "DELETE"],
        ),
        (
            InvitationScenario::RejectedReplacement,
            "replacementSend",
            vec!["POST", "DELETE", "POST"],
        ),
    ] {
        let (runtime, server, account, key, fingerprint, _) = prepared_invitation(scenario).await;
        let created = create_invitation(&runtime, &account).await;
        let continuation_id = created["continuationId"].as_str().unwrap();
        verify_recipient(&runtime, &account, &key, &fingerprint).await;
        let provision = || RuntimeRequest::ProvisionTeamInvitation {
            account_id: account.clone(),
            continuation_id: continuation_id.into(),
        };
        let response = runtime
            .request(provision(), RequestCancellation::new())
            .await
            .unwrap();
        let response = serde_json::to_value(response).unwrap();
        assert_eq!(response["type"], "teamInvitationUncertain");
        assert_eq!(response["phase"], phase);
        assert_eq!(response["originalInvitationId"], "invitation-original");
        assert!(response.get("token").is_none());
        assert!(runtime
            .request(provision(), RequestCancellation::new())
            .await
            .is_err());
        assert_eq!(mutation_methods(&server), methods);
        runtime.close().await;
    }
}

#[tokio::test]
async fn changed_invitation_or_vault_evidence_cannot_trigger_cancel_or_replacement() {
    for scenario in [
        InvitationScenario::ChangedOriginalEmail,
        InvitationScenario::ChangedVaultWrap,
    ] {
        let (runtime, server, account, key, fingerprint, _) = prepared_invitation(scenario).await;
        let created = create_invitation(&runtime, &account).await;
        let continuation_id = created["continuationId"].as_str().unwrap().to_owned();
        verify_recipient(&runtime, &account, &key, &fingerprint).await;
        assert!(runtime
            .request(
                RuntimeRequest::ProvisionTeamInvitation {
                    account_id: account.clone(),
                    continuation_id: continuation_id.clone(),
                },
                RequestCancellation::new()
            )
            .await
            .is_err());
        assert_eq!(mutation_methods(&server), ["POST"]);
        runtime
            .request(
                RuntimeRequest::ReleaseInvitationContinuation {
                    account_id: account.clone(),
                    continuation_id: continuation_id.clone(),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap();
        assert!(runtime
            .request(
                RuntimeRequest::ProvisionTeamInvitation {
                    account_id: account,
                    continuation_id,
                },
                RequestCancellation::new()
            )
            .await
            .is_err());
        assert_eq!(mutation_methods(&server), ["POST"]);
        runtime.close().await;
    }
}

#[tokio::test]
async fn provision_seals_only_current_accessible_team_vaults() {
    let (runtime, server, account, key, fingerprint, _) =
        prepared_invitation(InvitationScenario::PartiallyAccessibleVaults).await;
    let created = create_invitation(&runtime, &account).await;
    let continuation_id = created["continuationId"].as_str().unwrap().to_owned();
    verify_recipient(&runtime, &account, &key, &fingerprint).await;
    let provisioned = runtime
        .request(
            RuntimeRequest::ProvisionTeamInvitation {
                account_id: account,
                continuation_id,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let provisioned = serde_json::to_value(provisioned).unwrap();
    assert_eq!(provisioned["type"], "teamInvitationProvisioned");
    {
        let requests = server.requests.lock().unwrap();
        let replacement = requests
            .iter()
            .filter(|request| request["method"] == "POST")
            .nth(1)
            .unwrap();
        let body: Vec<u8> = serde_json::from_value(replacement["body"].clone()).unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["pendingVaultKeys"].as_array().unwrap().len(), 1);
        assert_eq!(body["pendingVaultKeys"][0]["vaultId"], TEST_VAULT_ID);
    }
    runtime.close().await;
}

#[tokio::test]
async fn more_than_one_hundred_accessible_vaults_refuses_before_cancelling_original() {
    let (runtime, server, account, key, fingerprint, _) =
        prepared_invitation(InvitationScenario::TooManyAccessibleVaults).await;
    let created = create_invitation(&runtime, &account).await;
    let continuation_id = created["continuationId"].as_str().unwrap().to_owned();
    verify_recipient(&runtime, &account, &key, &fingerprint).await;
    let result = runtime
        .request(
            RuntimeRequest::ProvisionTeamInvitation {
                account_id: account,
                continuation_id,
            },
            RequestCancellation::new(),
        )
        .await;
    assert_eq!(result.unwrap_err().code, RuntimeErrorCode::QuotaExceeded);
    assert_eq!(mutation_methods(&server), ["POST"]);
    runtime.close().await;
}

#[tokio::test]
async fn lock_retires_a_verified_continuation_before_any_private_or_mutation_work() {
    let (runtime, server, account, key, fingerprint, _) =
        prepared_invitation(InvitationScenario::ExistingRecipient).await;
    let created = create_invitation(&runtime, &account).await;
    let continuation_id = created["continuationId"].as_str().unwrap().to_owned();
    verify_recipient(&runtime, &account, &key, &fingerprint).await;
    runtime
        .request(
            RuntimeRequest::Lock {
                account_id: account.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert!(runtime
        .request(
            RuntimeRequest::ProvisionTeamInvitation {
                account_id: account,
                continuation_id,
            },
            RequestCancellation::new()
        )
        .await
        .is_err());
    assert_eq!(mutation_methods(&server), ["POST"]);
    runtime.close().await;
}

#[test]
fn continuation_has_exact_scope_capacity_deadline_and_retirement() {
    use super::foreground_attachment_lifecycle::{
        ForegroundAttachmentRegistry, InvitationLeaseBinding,
    };
    let registry = ForegroundAttachmentRegistry::default();
    let account = AccountId::from("lease-account");
    let other_account = AccountId::from("other-account");
    let incarnation = Incarnation::from("generation-1");
    let binding = |index| InvitationLeaseBinding {
        account_id: account.clone(),
        incarnation: incarnation.clone(),
        lock_epoch: 3,
        team_id: "team-1".into(),
        invitation_id: format!("invitation-{index}"),
        email: "recipient@example.test".into(),
        role: crate::server_contract::TeamRole::Member,
        recipient_user_id: "recipient-1".into(),
        public_key: "key-1".into(),
    };
    let ids = (0..16)
        .map(|index| registry.issue_invitation_lease(binding(index), 0).unwrap())
        .collect::<Vec<_>>();
    assert!(registry
        .require_invitation_lease_capacity(&account, 0)
        .is_err());
    assert!(registry.issue_invitation_lease(binding(16), 0).is_err());

    let signal = RequestCancellation::new();
    assert!(registry
        .reserve_invitation_lease(&other_account, &incarnation, 3, &ids[0], 0, signal.clone(),)
        .is_err());
    assert!(registry
        .reserve_invitation_lease(&account, &incarnation, 4, &ids[0], 0, signal.clone(),)
        .is_err());
    registry
        .reserve_invitation_lease(&account, &incarnation, 3, &ids[0], 0, signal.clone())
        .unwrap();
    assert!(registry
        .reserve_invitation_lease(
            &account,
            &incarnation,
            3,
            &ids[0],
            0,
            RequestCancellation::new(),
        )
        .is_err());
    registry.release_invitation_lease(&other_account, &incarnation, 3, &ids[0]);
    assert!(!signal.is_cancelled());
    registry.release_invitation_lease(&account, &incarnation, 3, &ids[0]);
    assert!(signal.is_cancelled());
    assert!(registry
        .reserve_invitation_lease(
            &account,
            &incarnation,
            3,
            &ids[0],
            0,
            RequestCancellation::new(),
        )
        .is_err());

    let expiry = RequestCancellation::new();
    registry
        .reserve_invitation_lease(&account, &incarnation, 3, &ids[1], 0, expiry.clone())
        .unwrap();
    registry
        .require_invitation_lease_capacity(&account, 600_000)
        .unwrap();
    assert!(expiry.is_cancelled());
    assert!(registry
        .reserve_invitation_lease(
            &account,
            &incarnation,
            3,
            &ids[1],
            600_000,
            RequestCancellation::new(),
        )
        .is_err());

    let retired = RequestCancellation::new();
    let id = registry
        .issue_invitation_lease(binding(17), 600_000)
        .unwrap();
    registry
        .reserve_invitation_lease(&account, &incarnation, 3, &id, 600_000, retired.clone())
        .unwrap();
    let retirement = registry.begin_account_retirement(&account);
    assert!(retired.is_cancelled());
    assert!(registry
        .reserve_invitation_lease(
            &account,
            &incarnation,
            3,
            &id,
            600_000,
            RequestCancellation::new(),
        )
        .is_err());
    drop(retirement);

    assert!(serde_json::from_value::<RuntimeRequest>(json!({
        "type": "provisionTeamInvitation", "accountId": account,
        "continuationId": "forged", "publicKey": "host-chosen-key"
    }))
    .is_err());
}
