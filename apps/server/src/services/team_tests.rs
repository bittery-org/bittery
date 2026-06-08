
use super::{
    assert_optional_team_management_entitlement, assert_team_management_entitlement, bittery_mode,
    ensure_exact_rotation_vault_set, ensure_team_admin, generate_secure_token,
    normalize_pending_vault_keys, parse_pending_vault_keys, validate_rotation_vault_inputs,
    validate_token, PendingVaultKeyEntry, RotationMemberKeyInput, RotationReEncryptedItemInput,
    RotationVaultInput, VaultKeyRotationInput, TEAM_MANAGEMENT_UNAVAILABLE_MESSAGE,
};
use crate::error::AppErrorCode;
use crate::services::session_control::load_session_revocation;
use crate::test_support::{
    acquire_env_lock, assign_user_to_team, authenticated_json_headers, seed_item, seed_team,
    seed_user, seed_vault, seed_vault_key, with_rpc_test_app,
};
use axum::http::{header::CONTENT_TYPE, HeaderMap, HeaderValue, StatusCode};
use serde_json::{json, Value};
use sqlx::{query, query_scalar, PgPool};
use std::{collections::HashSet, future::Future};
use time::{Duration, OffsetDateTime};

fn set_env_var(key: &str, value: Option<&str>) {
    match value {
        Some(value) => unsafe { std::env::set_var(key, value) },
        None => unsafe { std::env::remove_var(key) },
    }
}

fn restore_env_var(key: &str, value: Option<String>) {
    match value {
        Some(value) => unsafe { std::env::set_var(key, value) },
        None => unsafe { std::env::remove_var(key) },
    }
}

fn with_bittery_mode<T>(value: Option<&str>, test_fn: impl FnOnce() -> T) -> T {
    let _guard = acquire_env_lock();
    let previous = std::env::var("BITTERY_MODE").ok();

    set_env_var("BITTERY_MODE", value);

    let result = test_fn();

    restore_env_var("BITTERY_MODE", previous);

    result
}

async fn with_bittery_mode_async<T, F>(value: Option<&str>, future: F) -> T
where
    F: Future<Output = T>,
{
    let _guard = acquire_env_lock();
    let previous = std::env::var("BITTERY_MODE").ok();
    set_env_var("BITTERY_MODE", value);
    let result = future.await;
    restore_env_var("BITTERY_MODE", previous);
    result
}

async fn with_storage_env_async<T, F>(future: F) -> T
where
    F: Future<Output = T>,
{
    let _guard = acquire_env_lock();
    let previous_endpoint = std::env::var("BITTERY_STORAGE_ENDPOINT").ok();
    let previous_bucket = std::env::var("BITTERY_STORAGE_BUCKET").ok();
    let previous_access_key = std::env::var("BITTERY_STORAGE_ACCESS_KEY_ID").ok();
    let previous_secret_key = std::env::var("BITTERY_STORAGE_SECRET_ACCESS_KEY").ok();
    let previous_region = std::env::var("BITTERY_STORAGE_REGION").ok();
    let previous_public_url = std::env::var("BITTERY_STORAGE_PUBLIC_URL").ok();
    let previous_cdn_url = std::env::var("BITTERY_STORAGE_CDN_URL").ok();

    set_env_var(
        "BITTERY_STORAGE_ENDPOINT",
        Some("https://storage.example.invalid"),
    );
    set_env_var("BITTERY_STORAGE_BUCKET", Some("bittery-test"));
    set_env_var("BITTERY_STORAGE_ACCESS_KEY_ID", Some("test-access-key"));
    set_env_var("BITTERY_STORAGE_SECRET_ACCESS_KEY", Some("test-secret-key"));
    set_env_var("BITTERY_STORAGE_REGION", Some("auto"));
    set_env_var(
        "BITTERY_STORAGE_PUBLIC_URL",
        Some("https://cdn.example.invalid/public"),
    );
    set_env_var(
        "BITTERY_STORAGE_CDN_URL",
        Some("https://cdn.example.invalid/assets"),
    );

    let result = future.await;

    restore_env_var("BITTERY_STORAGE_ENDPOINT", previous_endpoint);
    restore_env_var("BITTERY_STORAGE_BUCKET", previous_bucket);
    restore_env_var("BITTERY_STORAGE_ACCESS_KEY_ID", previous_access_key);
    restore_env_var("BITTERY_STORAGE_SECRET_ACCESS_KEY", previous_secret_key);
    restore_env_var("BITTERY_STORAGE_REGION", previous_region);
    restore_env_var("BITTERY_STORAGE_PUBLIC_URL", previous_public_url);
    restore_env_var("BITTERY_STORAGE_CDN_URL", previous_cdn_url);

    result
}

fn unauthenticated_json_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert("x-app-platform", HeaderValue::from_static("desktop"));
    headers.insert("x-client-id", HeaderValue::from_static("integration-test"));
    headers
}

fn assert_rpc_error(body: &Value, code: &str, message: &str) {
    assert_eq!(body["jsonrpc"], json!("2.0"));
    assert_eq!(body["error"]["message"], json!(message));
    assert_eq!(body["error"]["data"]["code"], json!(code));
}

fn assert_handler_error(body: &Value, code: &str, message: &str) {
    assert_eq!(body["jsonrpc"], json!("2.0"));
    assert_eq!(body["result"]["Err"]["code"], json!(code));
    assert_eq!(body["result"]["Err"]["message"], json!(message));
}

fn assert_invalid_params_error(body: &Value) {
    assert_eq!(body["jsonrpc"], json!("2.0"));
    assert!(
        body["error"].is_object(),
        "unexpected invalid params body: {body}"
    );
    let message = body["error"]["message"]
        .as_str()
        .unwrap_or_default()
        .to_ascii_lowercase();
    assert!(
        message.contains("invalid params"),
        "unexpected invalid params body: {body}"
    );
}

struct TeamRouterFixture {
    owner_user_id: String,
    admin_user_id: String,
    member_user_id: String,
    remove_target_user_id: String,
    no_team_user_id: String,
    outsider_user_id: String,
    team_id: String,
    outsider_team_id: String,
    invitee_user_id: String,
    accept_user_id: String,
    decline_user_id: String,
    accessible_vault_id: String,
    hidden_vault_id: String,
    admin_inaccessible_vault_id: String,
    accessible_item_id: String,
    admin_inaccessible_item_id: String,
}

async fn build_team_router_fixture(pool: &PgPool) -> TeamRouterFixture {
    let owner_user_id = "team_owner_user".to_string();
    let admin_user_id = "team_admin_user".to_string();
    let member_user_id = "team_member_user".to_string();
    let remove_target_user_id = "team_remove_target_user".to_string();
    let no_team_user_id = "team_no_team_user".to_string();
    let outsider_user_id = "team_outsider_user".to_string();
    let invitee_user_id = "team_invitee_user".to_string();
    let accept_user_id = "team_accept_user".to_string();
    let decline_user_id = "team_decline_user".to_string();
    let team_id = "team_router_main".to_string();
    let outsider_team_id = "team_router_other".to_string();
    let accessible_vault_id = "team_router_accessible_vault".to_string();
    let hidden_vault_id = "team_router_hidden_vault".to_string();
    let admin_inaccessible_vault_id = "team_router_admin_hidden_vault".to_string();
    let accessible_item_id = "team_router_accessible_item".to_string();
    let admin_inaccessible_item_id = "team_router_admin_hidden_item".to_string();

    seed_user(pool, &owner_user_id, "Team Owner", "team-owner@example.com").await;
    seed_user(pool, &admin_user_id, "Team Admin", "team-admin@example.com").await;
    seed_user(
        pool,
        &member_user_id,
        "Team Member",
        "team-member@example.com",
    )
    .await;
    seed_user(
        pool,
        &remove_target_user_id,
        "Remove Target",
        "team-remove-target@example.com",
    )
    .await;
    seed_user(pool, &no_team_user_id, "No Team", "team-none@example.com").await;
    seed_user(
        pool,
        &outsider_user_id,
        "Outsider",
        "team-outsider@example.com",
    )
    .await;
    seed_user(
        pool,
        &invitee_user_id,
        "Invitee",
        "team-invitee@example.com",
    )
    .await;
    seed_user(
        pool,
        &accept_user_id,
        "Accept User",
        "team-accept@example.com",
    )
    .await;
    seed_user(
        pool,
        &decline_user_id,
        "Decline User",
        "team-decline@example.com",
    )
    .await;

    seed_team(
        pool,
        &team_id,
        "Router Team",
        &owner_user_id,
        "organization",
        "team",
        "active",
    )
    .await;
    assign_user_to_team(pool, &owner_user_id, &team_id, "owner").await;
    assign_user_to_team(pool, &admin_user_id, &team_id, "admin").await;
    assign_user_to_team(pool, &member_user_id, &team_id, "member").await;
    assign_user_to_team(pool, &remove_target_user_id, &team_id, "member").await;

    seed_team(
        pool,
        &outsider_team_id,
        "Other Team",
        &outsider_user_id,
        "organization",
        "team",
        "active",
    )
    .await;
    assign_user_to_team(pool, &outsider_user_id, &outsider_team_id, "owner").await;

    seed_vault(
        pool,
        &accessible_vault_id,
        "Accessible Vault",
        "personal",
        &owner_user_id,
        Some(&team_id),
    )
    .await;
    seed_vault(
        pool,
        &hidden_vault_id,
        "Hidden Vault",
        "personal",
        &owner_user_id,
        Some(&team_id),
    )
    .await;
    seed_vault(
        pool,
        &admin_inaccessible_vault_id,
        "Admin Inaccessible Vault",
        "personal",
        &owner_user_id,
        Some(&team_id),
    )
    .await;

    seed_vault_key(
        pool,
        "team_router_accessible_owner_key",
        &accessible_vault_id,
        &owner_user_id,
        "owner-accessible-key",
        "owner",
    )
    .await;
    seed_vault_key(
        pool,
        "team_router_accessible_admin_key",
        &accessible_vault_id,
        &admin_user_id,
        "admin-accessible-key",
        "admin",
    )
    .await;
    seed_vault_key(
        pool,
        "team_router_accessible_member_key",
        &accessible_vault_id,
        &member_user_id,
        "member-accessible-key",
        "member",
    )
    .await;
    seed_vault_key(
        pool,
        "team_router_accessible_target_key",
        &accessible_vault_id,
        &remove_target_user_id,
        "target-accessible-key",
        "member",
    )
    .await;
    seed_vault_key(
        pool,
        "team_router_hidden_owner_key",
        &hidden_vault_id,
        &owner_user_id,
        "owner-hidden-key",
        "owner",
    )
    .await;
    seed_vault_key(
        pool,
        "team_router_admin_hidden_owner_key",
        &admin_inaccessible_vault_id,
        &owner_user_id,
        "owner-admin-hidden-key",
        "owner",
    )
    .await;
    seed_vault_key(
        pool,
        "team_router_admin_hidden_target_key",
        &admin_inaccessible_vault_id,
        &remove_target_user_id,
        "target-admin-hidden-key",
        "member",
    )
    .await;

    seed_item(
        pool,
        &accessible_item_id,
        &accessible_vault_id,
        "login",
        "accessible-ciphertext",
        "accessible-iv",
        &owner_user_id,
    )
    .await;
    seed_item(
        pool,
        &admin_inaccessible_item_id,
        &admin_inaccessible_vault_id,
        "login",
        "admin-hidden-ciphertext",
        "admin-hidden-iv",
        &owner_user_id,
    )
    .await;

    TeamRouterFixture {
        owner_user_id,
        admin_user_id,
        member_user_id,
        remove_target_user_id,
        no_team_user_id,
        outsider_user_id,
        team_id,
        outsider_team_id,
        invitee_user_id,
        accept_user_id,
        decline_user_id,
        accessible_vault_id,
        hidden_vault_id,
        admin_inaccessible_vault_id,
        accessible_item_id,
        admin_inaccessible_item_id,
    }
}

async fn seed_team_invitation(
    pool: &PgPool,
    invitation_id: &str,
    team_id: &str,
    email: &str,
    role: &str,
    invited_by_id: &str,
    token: &str,
    pending_vault_keys: Option<&str>,
    expires_at: OffsetDateTime,
) {
    query(
			"INSERT INTO team_invitation (id, team_id, email, role, invited_by_id, token, pending_vault_keys, expires_at) VALUES ($1, $2, $3, $4::team_role, $5, $6, $7, $8)",
		)
		.bind(invitation_id)
		.bind(team_id)
		.bind(email)
		.bind(role)
		.bind(invited_by_id)
		.bind(token)
		.bind(pending_vault_keys)
		.bind(expires_at)
		.execute(pool)
		.await
		.expect("team invitation should seed");
}

#[test]
fn bittery_mode_normalizes_self_hosted_aliases_and_defaults_to_cloud() {
    with_bittery_mode(None, || {
        assert_eq!(bittery_mode(), "cloud");
    });
    with_bittery_mode(Some("self-hosted"), || {
        assert_eq!(bittery_mode(), "self-hosted");
    });
    with_bittery_mode(Some("SELF_HOSTED"), || {
        assert_eq!(bittery_mode(), "self-hosted");
    });
    with_bittery_mode(Some("selfhosted"), || {
        assert_eq!(bittery_mode(), "self-hosted");
    });
    with_bittery_mode(Some("cloud"), || {
        assert_eq!(bittery_mode(), "cloud");
    });
}

#[test]
fn assert_team_management_entitlement_respects_mode_and_billing() {
    with_bittery_mode(Some("self_hosted"), || {
        assert!(assert_team_management_entitlement("free", "none").is_ok());
    });

    with_bittery_mode(Some("cloud"), || {
        assert!(assert_team_management_entitlement("team", "active").is_ok());
        assert!(assert_team_management_entitlement("family", "trialing").is_ok());

        let error = assert_team_management_entitlement("free", "none").unwrap_err();
        assert_eq!(error.code, AppErrorCode::Forbidden);
        assert_eq!(error.message, TEAM_MANAGEMENT_UNAVAILABLE_MESSAGE);
    });
}

#[test]
fn assert_optional_team_management_entitlement_requires_team_billing_fields() {
    let missing_plan =
        assert_optional_team_management_entitlement(None, Some("active")).unwrap_err();
    assert_eq!(missing_plan.code, AppErrorCode::NotFound);
    assert_eq!(missing_plan.message, "Team not found");

    let missing_status =
        assert_optional_team_management_entitlement(Some("team"), None).unwrap_err();
    assert_eq!(missing_status.code, AppErrorCode::NotFound);
    assert_eq!(missing_status.message, "Team not found");
}

#[test]
fn validate_token_rejects_invalid_input() {
    let error = validate_token("not-a-valid-token").unwrap_err();
    assert_eq!(error.code, AppErrorCode::BadRequest);
    assert_eq!(error.message, "Invalid token");
}

#[test]
fn parse_pending_vault_keys_rejects_invalid_payload() {
    let error = parse_pending_vault_keys(Some("{not-json}")).unwrap_err();
    assert_eq!(error.code, AppErrorCode::BadRequest);
    assert_eq!(error.message, "Invalid pendingVaultKeys payload");
}

#[test]
fn parse_pending_vault_keys_accepts_missing_or_blank_values() {
    assert!(parse_pending_vault_keys(None).unwrap().is_empty());
    assert!(parse_pending_vault_keys(Some("   ")).unwrap().is_empty());
}

#[test]
fn normalize_pending_vault_keys_rejects_duplicate_vault_ids() {
    let error = normalize_pending_vault_keys(Some(vec![
        PendingVaultKeyEntry {
            vault_id: "vault_1".to_string(),
            encrypted_vault_key: "encrypted-a".to_string(),
        },
        PendingVaultKeyEntry {
            vault_id: "vault_1".to_string(),
            encrypted_vault_key: "encrypted-b".to_string(),
        },
    ]))
    .unwrap_err();

    assert_eq!(error.code, AppErrorCode::BadRequest);
    assert_eq!(
        error.message,
        "Duplicate vault IDs are not allowed in pendingVaultKeys",
    );
}

#[test]
fn normalize_pending_vault_keys_trims_valid_entries() {
    let entries = normalize_pending_vault_keys(Some(vec![PendingVaultKeyEntry {
        vault_id: " vault_1 ".to_string(),
        encrypted_vault_key: " wrapped-key ".to_string(),
    }]))
    .unwrap();

    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].vault_id, "vault_1");
    assert_eq!(entries[0].encrypted_vault_key, "wrapped-key");
}

#[test]
fn normalize_pending_vault_keys_rejects_blank_entries() {
    let error = normalize_pending_vault_keys(Some(vec![PendingVaultKeyEntry {
        vault_id: " ".to_string(),
        encrypted_vault_key: "wrapped-key".to_string(),
    }]))
    .unwrap_err();

    assert_eq!(error.code, AppErrorCode::BadRequest);
    assert_eq!(error.message, "Invalid pendingVaultKeys entry at index 0");
}

#[test]
fn validate_rotation_vault_inputs_rejects_too_many_vaults() {
    let error = validate_rotation_vault_inputs(
        &(0..101)
            .map(|index| RotationVaultInput {
                vault_id: format!("vault_{index}"),
                key_rotation: VaultKeyRotationInput {
                    member_keys: Vec::new(),
                    re_encrypted_items: Vec::new(),
                },
            })
            .collect::<Vec<_>>(),
    )
    .unwrap_err();

    assert_eq!(error.code, AppErrorCode::BadRequest);
    assert_eq!(error.message, "Too many vault rotations provided.");
}

#[test]
fn validate_rotation_vault_inputs_rejects_too_many_member_keys() {
    let error = validate_rotation_vault_inputs(&[RotationVaultInput {
        vault_id: "vault_1".to_string(),
        key_rotation: VaultKeyRotationInput {
            member_keys: (0..101)
                .map(|index| RotationMemberKeyInput {
                    user_id: format!("user_{index}"),
                    encrypted_vault_key: "wrapped".to_string(),
                })
                .collect(),
            re_encrypted_items: Vec::new(),
        },
    }])
    .unwrap_err();

    assert_eq!(error.code, AppErrorCode::BadRequest);
    assert_eq!(
        error.message,
        "Too many member key rotations provided for a vault.",
    );
}

#[test]
fn validate_rotation_vault_inputs_rejects_too_many_reencrypted_items() {
    let error = validate_rotation_vault_inputs(&[RotationVaultInput {
        vault_id: "vault_1".to_string(),
        key_rotation: VaultKeyRotationInput {
            member_keys: Vec::new(),
            re_encrypted_items: (0..101)
                .map(|index| RotationReEncryptedItemInput {
                    item_id: format!("item_{index}"),
                    encrypted_data: "ciphertext".to_string(),
                    encryption_iv: "iv".to_string(),
                })
                .collect(),
        },
    }])
    .unwrap_err();

    assert_eq!(error.code, AppErrorCode::BadRequest);
    assert_eq!(
        error.message,
        "Too many re-encrypted items provided for a vault.",
    );
}

#[test]
fn ensure_exact_rotation_vault_set_rejects_duplicates() {
    let expected = HashSet::from(["vault_1".to_string()]);
    let error = ensure_exact_rotation_vault_set(
        &expected,
        &[
            RotationVaultInput {
                vault_id: "vault_1".to_string(),
                key_rotation: VaultKeyRotationInput {
                    member_keys: Vec::new(),
                    re_encrypted_items: Vec::new(),
                },
            },
            RotationVaultInput {
                vault_id: "vault_1".to_string(),
                key_rotation: VaultKeyRotationInput {
                    member_keys: Vec::new(),
                    re_encrypted_items: Vec::new(),
                },
            },
        ],
        "Rotation mismatch.",
    )
    .unwrap_err();

    assert_eq!(error.code, AppErrorCode::BadRequest);
    assert_eq!(
        error.message,
        "Duplicate vault rotation entries are not allowed.",
    );
}

#[test]
fn ensure_exact_rotation_vault_set_rejects_extra_vaults() {
    let expected = HashSet::from(["vault_1".to_string()]);
    let error = ensure_exact_rotation_vault_set(
        &expected,
        &[
            RotationVaultInput {
                vault_id: "vault_1".to_string(),
                key_rotation: VaultKeyRotationInput {
                    member_keys: Vec::new(),
                    re_encrypted_items: Vec::new(),
                },
            },
            RotationVaultInput {
                vault_id: "vault_2".to_string(),
                key_rotation: VaultKeyRotationInput {
                    member_keys: Vec::new(),
                    re_encrypted_items: Vec::new(),
                },
            },
        ],
        "Rotation mismatch.",
    )
    .unwrap_err();

    assert_eq!(error.code, AppErrorCode::BadRequest);
    assert_eq!(error.message, "Rotation mismatch.");
}

#[test]
fn ensure_exact_rotation_vault_set_rejects_missing_vaults() {
    let expected = HashSet::from(["vault_1".to_string(), "vault_2".to_string()]);
    let error = ensure_exact_rotation_vault_set(
        &expected,
        &[RotationVaultInput {
            vault_id: "vault_1".to_string(),
            key_rotation: VaultKeyRotationInput {
                member_keys: Vec::new(),
                re_encrypted_items: Vec::new(),
            },
        }],
        "Rotation mismatch.",
    )
    .unwrap_err();

    assert_eq!(error.code, AppErrorCode::BadRequest);
    assert_eq!(error.message, "Rotation mismatch.");
}

#[test]
fn ensure_team_admin_rejects_members() {
    assert!(ensure_team_admin("owner").is_ok());
    assert!(ensure_team_admin("admin").is_ok());

    let error = ensure_team_admin("member").unwrap_err();
    assert_eq!(error.code, AppErrorCode::Forbidden);
    assert_eq!(error.message, "Insufficient permissions");
}

#[test]
fn generate_secure_token_returns_32_url_safe_characters() {
    let token = generate_secure_token();

    assert_eq!(token.len(), 32);
    assert!(token
        .chars()
        .all(|character| character.is_ascii_alphanumeric()));
}

#[tokio::test]
async fn team_protected_handlers_require_authentication() {
    with_rpc_test_app("team_auth_matrix", |app| async move {
        let valid_token = "A234567890123456789012345678901";
        for (method, params) in [
            ("team.list", json!([])),
            ("team.get", json!([{ "teamId": "team_test" }])),
            ("team.vaults", json!([{ "teamId": "team_test" }])),
            ("team.create", json!([{ "name": "Example Team" }])),
            (
                "team.update",
                json!([{ "teamId": "team_test", "name": "Updated Team" }]),
            ),
            (
                "team.createImageUpload",
                json!([{
                    "teamId": "team_test",
                    "fileName": "logo.png",
                    "contentType": "image/png"
                }]),
            ),
            ("team.delete", json!([{ "teamId": "team_test" }])),
            (
                "team.leave",
                json!([{ "teamId": "team_test", "vaultRotations": [] }]),
            ),
            (
                "team.getLeaveRotationData",
                json!([{ "teamId": "team_test" }]),
            ),
            ("team.members.list", json!([{ "teamId": "team_test" }])),
            (
                "team.members.getTeamRotationData",
                json!([{ "teamId": "team_test", "excludeUserId": "user_test" }]),
            ),
            (
                "team.members.remove",
                json!([{
                    "teamId": "team_test",
                    "userId": "user_test",
                    "vaultRotations": []
                }]),
            ),
            (
                "team.members.deleteAccount",
                json!([{
                    "teamId": "team_test",
                    "userId": "user_test",
                    "confirmation": "DELETE"
                }]),
            ),
            ("team.invitations.list", json!([{ "teamId": "team_test" }])),
            ("team.invitations.pending", json!([])),
            (
                "team.invitations.send",
                json!([{ "teamId": "team_test", "email": "invitee@example.com" }]),
            ),
            ("team.invitations.accept", json!([{ "token": valid_token }])),
            (
                "team.invitations.cancel",
                json!([{ "invitationId": "invitation_test" }]),
            ),
            (
                "team.invitations.resend",
                json!([{ "invitationId": "invitation_test" }]),
            ),
            (
                "team.invitations.decline",
                json!([{ "token": valid_token }]),
            ),
        ] {
            let response = app
                .rpc_call(method, params, unauthenticated_json_headers())
                .await;

            assert_eq!(response.status, axum::http::StatusCode::OK, "{method}");
            assert_rpc_error(&response.body, "UNAUTHORIZED", "Authentication required");
        }
    })
    .await;
}

#[tokio::test]
async fn team_handlers_reject_malformed_request_input() {
    with_rpc_test_app("team_bad_params", |app| async move {
        let fixture = build_team_router_fixture(&app.pool).await;
        let owner_session = app.issue_session(&fixture.owner_user_id).await;
        let headers = authenticated_json_headers(&owner_session.token);

        let get_response = app.rpc_call("team.get", json!([{}]), headers.clone()).await;
        assert_eq!(get_response.status, StatusCode::OK);
        assert_invalid_params_error(&get_response.body);

        let remove_response = app
            .rpc_call(
                "team.members.remove",
                json!([{ "teamId": fixture.team_id, "vaultRotations": [] }]),
                headers,
            )
            .await;
        assert_eq!(remove_response.status, StatusCode::OK);
        assert_invalid_params_error(&remove_response.body);

        let token_response = app
            .rpc_call(
                "team.invitations.getByToken",
                json!([{}]),
                unauthenticated_json_headers(),
            )
            .await;
        assert_eq!(token_response.status, StatusCode::OK);
        assert_invalid_params_error(&token_response.body);
    })
    .await;
}

#[tokio::test]
async fn team_invitation_lookup_send_list_pending_cancel_and_resend_paths() {
    with_rpc_test_app("team_invite_manage", |app| async move {
        let fixture = build_team_router_fixture(&app.pool).await;
        let owner_session = app.issue_session(&fixture.owner_user_id).await;
        let owner_headers = authenticated_json_headers(&owner_session.token);

        let send_response = app
            .rpc_call(
                "team.invitations.send",
                json!([{
                    "teamId": fixture.team_id,
                    "email": "team-invitee@example.com",
                    "pendingVaultKeys": [{
                        "vaultId": fixture.accessible_vault_id,
                        "encryptedVaultKey": "invitee-wrapped-key"
                    }]
                }]),
                owner_headers.clone(),
            )
            .await;
        assert_eq!(send_response.status, StatusCode::OK);
        assert_eq!(
            send_response.body["result"]["Ok"]["existingUserPublicKey"],
            json!("public-key")
        );
        let invitation_id = send_response.body["result"]["Ok"]["invitationId"]
            .as_str()
            .expect("invitation id should exist")
            .to_string();
        let invitation_token = send_response.body["result"]["Ok"]["token"]
            .as_str()
            .expect("invitation token should exist")
            .to_string();

        let list_response = app
            .rpc_call(
                "team.invitations.list",
                json!([{ "teamId": fixture.team_id }]),
                owner_headers.clone(),
            )
            .await;
        assert_eq!(list_response.status, StatusCode::OK);
        assert_eq!(
            list_response.body["result"]["Ok"][0]["id"],
            json!(invitation_id.clone())
        );

        let invitee_session = app.issue_session(&fixture.invitee_user_id).await;
        let pending_response = app
            .rpc_call(
                "team.invitations.pending",
                json!([]),
                authenticated_json_headers(&invitee_session.token),
            )
            .await;
        assert_eq!(pending_response.status, StatusCode::OK);
        assert_eq!(
            pending_response.body["result"]["Ok"][0]["token"],
            json!(invitation_token.clone())
        );

        let public_lookup = app
            .rpc_call(
                "team.invitations.getByToken",
                json!([{ "token": invitation_token.clone() }]),
                unauthenticated_json_headers(),
            )
            .await;
        assert_eq!(public_lookup.status, StatusCode::OK);
        assert_eq!(
            public_lookup.body["result"]["Ok"]["status"],
            json!("pending")
        );
        assert_eq!(
            public_lookup.body["result"]["Ok"]["teamId"],
            json!(fixture.team_id.clone())
        );

        let invalid_token_response = app
            .rpc_call(
                "team.invitations.getByToken",
                json!([{ "token": "short-token" }]),
                unauthenticated_json_headers(),
            )
            .await;
        assert_eq!(invalid_token_response.status, StatusCode::OK);
        assert_handler_error(&invalid_token_response.body, "BAD_REQUEST", "Invalid token");

        let missing_token = "0123456789abcdefghijklmnopqrstuv";
        let missing_response = app
            .rpc_call(
                "team.invitations.getByToken",
                json!([{ "token": missing_token }]),
                unauthenticated_json_headers(),
            )
            .await;
        assert_eq!(missing_response.status, StatusCode::OK);
        assert_handler_error(&missing_response.body, "NOT_FOUND", "Invitation not found");

        seed_team_invitation(
            &app.pool,
            "team_invitation_expired",
            &fixture.team_id,
            "team-decline@example.com",
            "member",
            &fixture.owner_user_id,
            "ZXCVBNMASDFGHJKLQWERTYUIOP123456",
            None,
            OffsetDateTime::now_utc() - Duration::days(1),
        )
        .await;
        let expired_lookup = app
            .rpc_call(
                "team.invitations.getByToken",
                json!([{ "token": "ZXCVBNMASDFGHJKLQWERTYUIOP123456" }]),
                unauthenticated_json_headers(),
            )
            .await;
        assert_eq!(expired_lookup.status, StatusCode::OK);
        assert_eq!(
            expired_lookup.body["result"]["Ok"]["status"],
            json!("expired")
        );

        let member_session = app.issue_session(&fixture.member_user_id).await;
        let forbidden_list = app
            .rpc_call(
                "team.invitations.list",
                json!([{ "teamId": fixture.team_id }]),
                authenticated_json_headers(&member_session.token),
            )
            .await;
        assert_eq!(forbidden_list.status, StatusCode::OK);
        assert_handler_error(
            &forbidden_list.body,
            "FORBIDDEN",
            "Insufficient permissions",
        );

        query("UPDATE team_invitation SET expires_at = $1 WHERE id = $2")
            .bind(OffsetDateTime::now_utc() - Duration::hours(1))
            .bind(&invitation_id)
            .execute(&app.pool)
            .await
            .expect("invitation should update");
        let resend_response = app
            .rpc_call(
                "team.invitations.resend",
                json!([{ "invitationId": invitation_id.clone() }]),
                owner_headers.clone(),
            )
            .await;
        assert_eq!(resend_response.status, StatusCode::OK);
        assert_eq!(resend_response.body["result"]["Ok"]["success"], json!(true));
        let resent_expires_at = query_scalar::<_, OffsetDateTime>(
            "SELECT expires_at FROM team_invitation WHERE id = $1",
        )
        .bind(&invitation_id)
        .fetch_one(&app.pool)
        .await
        .expect("resent invitation should exist");
        assert!(resent_expires_at > OffsetDateTime::now_utc());

        let cancel_response = app
            .rpc_call(
                "team.invitations.cancel",
                json!([{ "invitationId": invitation_id.clone() }]),
                owner_headers,
            )
            .await;
        assert_eq!(cancel_response.status, StatusCode::OK);
        assert_eq!(cancel_response.body["result"]["Ok"]["success"], json!(true));
        let invitation_exists =
            query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM team_invitation WHERE id = $1)")
                .bind(&invitation_id)
                .fetch_one(&app.pool)
                .await
                .expect("cancel existence query should succeed");
        assert!(!invitation_exists);
    })
    .await;
}

#[tokio::test]
async fn team_list_get_create_update_and_image_upload_paths() {
    with_rpc_test_app("team_core_mutations", |app| async move {
        let fixture = build_team_router_fixture(&app.pool).await;
        let owner_session = app.issue_session(&fixture.owner_user_id).await;
        let owner_headers = authenticated_json_headers(&owner_session.token);

        let list_response = app
            .rpc_call("team.list", json!([]), owner_headers.clone())
            .await;
        assert_eq!(list_response.status, StatusCode::OK);
        assert_eq!(
            list_response.body["result"]["Ok"]["id"],
            json!(fixture.team_id.clone())
        );
        assert_eq!(list_response.body["result"]["Ok"]["memberCount"], json!(4));

        let no_team_session = app.issue_session(&fixture.no_team_user_id).await;
        let no_team_list = app
            .rpc_call(
                "team.list",
                json!([]),
                authenticated_json_headers(&no_team_session.token),
            )
            .await;
        assert_eq!(no_team_list.status, StatusCode::OK);
        assert_handler_error(&no_team_list.body, "NOT_FOUND", "User has no team");

        let get_response = app
            .rpc_call(
                "team.get",
                json!([{ "teamId": fixture.team_id }]),
                owner_headers.clone(),
            )
            .await;
        assert_eq!(get_response.status, StatusCode::OK);
        assert_eq!(
            get_response.body["result"]["Ok"]["ownerId"],
            json!(fixture.owner_user_id.clone())
        );
        assert_eq!(
            get_response.body["result"]["Ok"]["userRole"],
            json!("owner")
        );

        let outsider_session = app.issue_session(&fixture.outsider_user_id).await;
        let forbidden_get = app
            .rpc_call(
                "team.get",
                json!([{ "teamId": fixture.team_id }]),
                authenticated_json_headers(&outsider_session.token),
            )
            .await;
        assert_eq!(forbidden_get.status, StatusCode::OK);
        assert_handler_error(
            &forbidden_get.body,
            "FORBIDDEN",
            "You are not a member of this team",
        );

        let create_response = app
            .rpc_call(
                "team.create",
                json!([{ "name": "Manual Team" }]),
                owner_headers.clone(),
            )
            .await;
        assert_eq!(create_response.status, StatusCode::OK);
        assert_handler_error(
            &create_response.body,
            "BAD_REQUEST",
            "Teams are automatically created on signup. Contact support to upgrade your team type.",
        );

        let member_session = app.issue_session(&fixture.member_user_id).await;
        let forbidden_update = app
            .rpc_call(
                "team.update",
                json!([{
                    "teamId": fixture.team_id,
                    "name": "Forbidden Rename"
                }]),
                authenticated_json_headers(&member_session.token),
            )
            .await;
        assert_eq!(forbidden_update.status, StatusCode::OK);
        assert_handler_error(
            &forbidden_update.body,
            "FORBIDDEN",
            "Insufficient permissions",
        );

        let update_response = app
            .rpc_call(
                "team.update",
                json!([{
                    "teamId": fixture.team_id,
                    "name": "Renamed Router Team",
                    "imageKey": "teams/team_router_main/custom-logo.png"
                }]),
                owner_headers.clone(),
            )
            .await;
        assert_eq!(update_response.status, StatusCode::OK);
        assert_eq!(update_response.body["result"]["Ok"]["success"], json!(true));
        let updated_name = query_scalar::<_, String>("SELECT name FROM team WHERE id = $1")
            .bind(&fixture.team_id)
            .fetch_one(&app.pool)
            .await
            .expect("team name should load");
        let updated_image_key =
            query_scalar::<_, Option<String>>("SELECT image_key FROM team WHERE id = $1")
                .bind(&fixture.team_id)
                .fetch_one(&app.pool)
                .await
                .expect("team image key should load");
        assert_eq!(updated_name, "Renamed Router Team");
        assert_eq!(
            updated_image_key,
            Some("teams/team_router_main/custom-logo.png".to_string())
        );

        let forbidden_upload = app
            .rpc_call(
                "team.createImageUpload",
                json!([{
                    "teamId": fixture.team_id,
                    "fileName": "logo.png",
                    "contentType": "image/png"
                }]),
                authenticated_json_headers(&member_session.token),
            )
            .await;
        assert_eq!(forbidden_upload.status, StatusCode::OK);
        assert_handler_error(
            &forbidden_upload.body,
            "FORBIDDEN",
            "Insufficient permissions",
        );

        let invalid_upload = app
            .rpc_call(
                "team.createImageUpload",
                json!([{
                    "teamId": fixture.team_id,
                    "fileName": "logo.txt",
                    "contentType": "text/plain"
                }]),
                owner_headers.clone(),
            )
            .await;
        assert_eq!(invalid_upload.status, StatusCode::OK);
        assert_handler_error(
            &invalid_upload.body,
            "BAD_REQUEST",
            "Only image files are allowed",
        );

        let upload_response = with_storage_env_async(app.rpc_call(
            "team.createImageUpload",
            json!([{
                "teamId": fixture.team_id,
                "fileName": "logo.png",
                "contentType": "image/png"
            }]),
            owner_headers,
        ))
        .await;
        assert_eq!(upload_response.status, StatusCode::OK);
        let key = upload_response.body["result"]["Ok"]["key"]
            .as_str()
            .expect("upload key should exist");
        assert!(
            key.starts_with("teams/team_router_main/"),
            "unexpected key: {key}"
        );
        assert!(
            upload_response.body["result"]["Ok"]["uploadUrl"]
                .as_str()
                .expect("upload url should exist")
                .contains("storage.example.invalid/bittery-test/"),
            "unexpected upload response: {}",
            upload_response.body
        );
        assert!(
            upload_response.body["result"]["Ok"]["publicUrl"]
                .as_str()
                .expect("public url should exist")
                .starts_with("https://cdn.example.invalid/assets/teams/team_router_main/"),
            "unexpected upload response: {}",
            upload_response.body
        );
    })
    .await;
}

#[tokio::test]
async fn team_vaults_members_and_leave_rotation_queries() {
    with_rpc_test_app("team_query_paths", |app| async move {
        let fixture = build_team_router_fixture(&app.pool).await;
        let owner_session = app.issue_session(&fixture.owner_user_id).await;
        let owner_headers = authenticated_json_headers(&owner_session.token);

        let vaults_response = app
            .rpc_call(
                "team.vaults",
                json!([{ "teamId": fixture.team_id }]),
                owner_headers.clone(),
            )
            .await;
        assert_eq!(vaults_response.status, StatusCode::OK);
        assert_eq!(
            vaults_response.body["result"]["Ok"]
                .as_array()
                .expect("vaults should be an array")
                .len(),
            3
        );
        assert_eq!(
            vaults_response.body["result"]["Ok"][0]["encryptedVaultKey"],
            json!("owner-accessible-key")
        );

        let member_session = app.issue_session(&fixture.member_user_id).await;
        let forbidden_vaults = app
            .rpc_call(
                "team.vaults",
                json!([{ "teamId": fixture.team_id }]),
                authenticated_json_headers(&member_session.token),
            )
            .await;
        assert_eq!(forbidden_vaults.status, StatusCode::OK);
        assert_handler_error(
            &forbidden_vaults.body,
            "FORBIDDEN",
            "Insufficient permissions",
        );

        let members_response = app
            .rpc_call(
                "team.members.list",
                json!([{ "teamId": fixture.team_id }]),
                owner_headers.clone(),
            )
            .await;
        assert_eq!(members_response.status, StatusCode::OK);
        let members = members_response.body["result"]["Ok"]
            .as_array()
            .expect("members should be an array");
        assert_eq!(members.len(), 4);
        assert!(members
            .iter()
            .any(|member| member["role"] == json!("owner")));
        assert!(members
            .iter()
            .any(|member| member["role"] == json!("admin")));
        assert!(members
            .iter()
            .any(|member| member["role"] == json!("member")));

        let outsider_session = app.issue_session(&fixture.outsider_user_id).await;
        let forbidden_members = app
            .rpc_call(
                "team.members.list",
                json!([{ "teamId": fixture.team_id }]),
                authenticated_json_headers(&outsider_session.token),
            )
            .await;
        assert_eq!(forbidden_members.status, StatusCode::OK);
        assert_handler_error(
            &forbidden_members.body,
            "FORBIDDEN",
            "You are not a member of this team",
        );

        let leave_rotation_response = app
            .rpc_call(
                "team.getLeaveRotationData",
                json!([{ "teamId": fixture.team_id }]),
                authenticated_json_headers(&member_session.token),
            )
            .await;
        assert_eq!(leave_rotation_response.status, StatusCode::OK);
        let rotation_vaults = leave_rotation_response.body["result"]["Ok"]["vaults"]
            .as_array()
            .expect("rotation vaults should be an array");
        assert_eq!(rotation_vaults.len(), 1);
        assert_eq!(
            rotation_vaults[0]["vaultId"],
            json!(fixture.accessible_vault_id)
        );
        assert_eq!(
            rotation_vaults[0]["items"][0]["id"],
            json!(fixture.accessible_item_id)
        );
        assert!(rotation_vaults[0]["members"]
            .as_array()
            .expect("members should be an array")
            .iter()
            .all(|member| member["userId"] != json!(fixture.member_user_id.clone())));
    })
    .await;
}

#[tokio::test]
async fn team_invitation_accept_and_decline_paths() {
    with_rpc_test_app("team_accept_decline", |app| async move {
        let fixture = build_team_router_fixture(&app.pool).await;
        let owner_session = app.issue_session(&fixture.owner_user_id).await;
        let owner_headers = authenticated_json_headers(&owner_session.token);

        let accept_invitation = app
            .rpc_call(
                "team.invitations.send",
                json!([{
                    "teamId": fixture.team_id,
                    "email": "team-accept@example.com",
                    "pendingVaultKeys": [{
                        "vaultId": fixture.accessible_vault_id,
                        "encryptedVaultKey": "accepted-user-key"
                    }]
                }]),
                owner_headers.clone(),
            )
            .await;
        assert_eq!(accept_invitation.status, StatusCode::OK);
        let accept_invitation_id = accept_invitation.body["result"]["Ok"]["invitationId"]
            .as_str()
            .expect("accept invitation id should exist")
            .to_string();
        let accept_token = accept_invitation.body["result"]["Ok"]["token"]
            .as_str()
            .expect("accept token should exist")
            .to_string();

        let wrong_user_session = app.issue_session(&fixture.no_team_user_id).await;
        let wrong_user_accept = app
            .rpc_call(
                "team.invitations.accept",
                json!([{ "token": accept_token.clone() }]),
                authenticated_json_headers(&wrong_user_session.token),
            )
            .await;
        assert_eq!(wrong_user_accept.status, StatusCode::OK);
        assert_handler_error(
            &wrong_user_accept.body,
            "FORBIDDEN",
            "This invitation is not for you",
        );

        let accept_user_session = app.issue_session(&fixture.accept_user_id).await;
        let accept_response = app
            .rpc_call(
                "team.invitations.accept",
                json!([{ "token": accept_token.clone() }]),
                authenticated_json_headers(&accept_user_session.token),
            )
            .await;
        assert_eq!(accept_response.status, StatusCode::OK);
        assert_eq!(
            accept_response.body["result"]["Ok"]["teamId"],
            json!(fixture.team_id.clone())
        );
        let accepted_team_id =
            query_scalar::<_, Option<String>>("SELECT team_id FROM \"user\" WHERE id = $1")
                .bind(&fixture.accept_user_id)
                .fetch_one(&app.pool)
                .await
                .expect("accepted user team should load");
        let accepted_role =
            query_scalar::<_, String>("SELECT role::text FROM \"user\" WHERE id = $1")
                .bind(&fixture.accept_user_id)
                .fetch_one(&app.pool)
                .await
                .expect("accepted user role should load");
        let accepted_vault_role = query_scalar::<_, String>(
            "SELECT role::text FROM vault_key WHERE vault_id = $1 AND user_id = $2",
        )
        .bind(&fixture.accessible_vault_id)
        .bind(&fixture.accept_user_id)
        .fetch_one(&app.pool)
        .await
        .expect("accepted vault key should load");
        let accepted_status =
            query_scalar::<_, String>("SELECT status::text FROM team_invitation WHERE id = $1")
                .bind(&accept_invitation_id)
                .fetch_one(&app.pool)
                .await
                .expect("accepted invitation status should load");
        assert_eq!(accepted_team_id, Some(fixture.team_id.clone()));
        assert_eq!(accepted_role, "member");
        assert_eq!(accepted_vault_role, "member");
        assert_eq!(accepted_status, "accepted");

        let decline_invitation = app
            .rpc_call(
                "team.invitations.send",
                json!([{
                    "teamId": fixture.team_id,
                    "email": "team-decline@example.com"
                }]),
                owner_headers,
            )
            .await;
        assert_eq!(decline_invitation.status, StatusCode::OK);
        let decline_invitation_id = decline_invitation.body["result"]["Ok"]["invitationId"]
            .as_str()
            .expect("decline invitation id should exist")
            .to_string();
        let decline_token = decline_invitation.body["result"]["Ok"]["token"]
            .as_str()
            .expect("decline token should exist")
            .to_string();

        let decline_user_session = app.issue_session(&fixture.decline_user_id).await;
        let decline_response = app
            .rpc_call(
                "team.invitations.decline",
                json!([{ "token": decline_token }]),
                authenticated_json_headers(&decline_user_session.token),
            )
            .await;
        assert_eq!(decline_response.status, StatusCode::OK);
        assert_eq!(
            decline_response.body["result"]["Ok"]["success"],
            json!(true)
        );
        let declined_status =
            query_scalar::<_, String>("SELECT status::text FROM team_invitation WHERE id = $1")
                .bind(&decline_invitation_id)
                .fetch_one(&app.pool)
                .await
                .expect("declined invitation status should load");
        assert_eq!(declined_status, "declined");
    })
    .await;
}

#[tokio::test]
async fn team_leave_paths() {
    with_rpc_test_app("team_leave", |app| async move {
        let fixture = build_team_router_fixture(&app.pool).await;

        let owner_session = app.issue_session(&fixture.owner_user_id).await;
        let owner_leave = app
            .rpc_call(
                "team.leave",
                json!([{ "teamId": fixture.team_id, "vaultRotations": [] }]),
                authenticated_json_headers(&owner_session.token),
            )
            .await;
        assert_eq!(owner_leave.status, StatusCode::OK);
        assert_handler_error(
            &owner_leave.body,
            "BAD_REQUEST",
            "The team owner cannot leave. Transfer ownership first.",
        );

        let leaving_session = app.issue_session(&fixture.member_user_id).await;
        let additional_session = app.issue_session(&fixture.member_user_id).await;
        let leave_response = app
            .rpc_call(
                "team.leave",
                json!([{
                    "teamId": fixture.team_id,
                    "vaultRotations": [{
                        "vaultId": fixture.accessible_vault_id,
                        "keyRotation": {
                            "memberKeys": [
                                {
                                    "userId": fixture.owner_user_id,
                                    "encryptedVaultKey": "rotated-owner-key"
                                },
                                {
                                    "userId": fixture.admin_user_id,
                                    "encryptedVaultKey": "rotated-admin-key"
                                },
                                {
                                    "userId": fixture.remove_target_user_id,
                                    "encryptedVaultKey": "rotated-target-key"
                                }
                            ],
                            "reEncryptedItems": [{
                                "itemId": fixture.accessible_item_id,
                                "encryptedData": "rotated-item-ciphertext",
                                "encryptionIv": "rotated-item-iv"
                            }]
                        }
                    }]
                }]),
                authenticated_json_headers(&leaving_session.token),
            )
            .await;
        assert_eq!(leave_response.status, StatusCode::OK);
        assert_eq!(leave_response.body["result"]["Ok"]["success"], json!(true));

        let new_team_id =
            query_scalar::<_, Option<String>>("SELECT team_id FROM \"user\" WHERE id = $1")
                .bind(&fixture.member_user_id)
                .fetch_one(&app.pool)
                .await
                .expect("leaving user team should load")
                .expect("leaving user should have a new team");
        let new_role = query_scalar::<_, String>("SELECT role::text FROM \"user\" WHERE id = $1")
            .bind(&fixture.member_user_id)
            .fetch_one(&app.pool)
            .await
            .expect("leaving user role should load");
        let old_vault_key_exists = query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM vault_key WHERE vault_id = $1 AND user_id = $2)",
        )
        .bind(&fixture.accessible_vault_id)
        .bind(&fixture.member_user_id)
        .fetch_one(&app.pool)
        .await
        .expect("vault key existence query should succeed");
        let rotated_owner_key = query_scalar::<_, String>(
            "SELECT encrypted_vault_key FROM vault_key WHERE vault_id = $1 AND user_id = $2",
        )
        .bind(&fixture.accessible_vault_id)
        .bind(&fixture.owner_user_id)
        .fetch_one(&app.pool)
        .await
        .expect("rotated owner key should load");
        let new_key_version = query_scalar::<_, i32>("SELECT key_version FROM vault WHERE id = $1")
            .bind(&fixture.accessible_vault_id)
            .fetch_one(&app.pool)
            .await
            .expect("rotated vault version should load");
        let completed_rotations = query_scalar::<_, i64>(
				"SELECT COUNT(*)::bigint FROM vault_key_rotation WHERE vault_id = $1 AND status = 'completed'",
			)
			.bind(&fixture.accessible_vault_id)
			.fetch_one(&app.pool)
			.await
			.expect("rotation count should load");
        let remaining_sessions =
            query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM session WHERE user_id = $1")
                .bind(&fixture.member_user_id)
                .fetch_one(&app.pool)
                .await
                .expect("session count should load");

        assert_ne!(new_team_id, fixture.team_id);
        assert_eq!(new_role, "owner");
        assert!(!old_vault_key_exists);
        assert_eq!(rotated_owner_key, "rotated-owner-key");
        assert_eq!(new_key_version, 2);
        assert_eq!(completed_rotations, 1);
        assert_eq!(remaining_sessions, 0);

        let revoked_session = load_session_revocation(
            &app.pool,
            &fixture.member_user_id,
            &additional_session.session_id,
        )
        .await
        .expect("revoked session should load")
        .expect("revoked session record should exist");
        assert_eq!(revoked_session.reason.as_deref(), Some("team_left"));
    })
    .await;
}

#[tokio::test]
async fn team_delete_paths() {
    with_rpc_test_app("team_delete", |app| async move {
        let fixture = build_team_router_fixture(&app.pool).await;

        let member_session = app.issue_session(&fixture.member_user_id).await;
        let forbidden_delete = with_bittery_mode_async(
            Some("cloud"),
            app.rpc_call(
                "team.delete",
                json!([{ "teamId": fixture.team_id }]),
                authenticated_json_headers(&member_session.token),
            ),
        )
        .await;
        assert_eq!(forbidden_delete.status, StatusCode::OK);
        assert_handler_error(
            &forbidden_delete.body,
            "FORBIDDEN",
            "Only the team owner can delete the team",
        );

        let owner_session = app.issue_session(&fixture.owner_user_id).await;
        let self_hosted_delete = with_bittery_mode_async(
            Some("self_hosted"),
            app.rpc_call(
                "team.delete",
                json!([{ "teamId": fixture.team_id }]),
                authenticated_json_headers(&owner_session.token),
            ),
        )
        .await;
        assert_eq!(self_hosted_delete.status, StatusCode::OK);
        assert_handler_error(
            &self_hosted_delete.body,
            "BAD_REQUEST",
            "Team deletion is disabled in self-hosted mode. This instance uses a single team.",
        );

        let members_blocked = with_bittery_mode_async(
            Some("cloud"),
            app.rpc_call(
                "team.delete",
                json!([{ "teamId": fixture.team_id }]),
                authenticated_json_headers(&owner_session.token),
            ),
        )
        .await;
        assert_eq!(members_blocked.status, StatusCode::OK);
        assert_handler_error(
            &members_blocked.body,
            "BAD_REQUEST",
            "Team deletion is blocked until the owner is the only remaining member.",
        );

        let vault_owner_id = "team_delete_vault_owner";
        let vault_team_id = "team_delete_vault_team";
        seed_user(
            &app.pool,
            vault_owner_id,
            "Vault Delete Owner",
            "team-delete-vault-owner@example.com",
        )
        .await;
        seed_team(
            &app.pool,
            vault_team_id,
            "Vault Delete Team",
            vault_owner_id,
            "organization",
            "team",
            "active",
        )
        .await;
        assign_user_to_team(&app.pool, vault_owner_id, vault_team_id, "owner").await;
        seed_vault(
            &app.pool,
            "team_delete_blocking_vault",
            "Blocking Vault",
            "personal",
            vault_owner_id,
            Some(vault_team_id),
        )
        .await;
        let vault_owner_session = app.issue_session(vault_owner_id).await;
        let vault_blocked = with_bittery_mode_async(
            Some("cloud"),
            app.rpc_call(
                "team.delete",
                json!([{ "teamId": vault_team_id }]),
                authenticated_json_headers(&vault_owner_session.token),
            ),
        )
        .await;
        assert_eq!(vault_blocked.status, StatusCode::OK);
        assert_handler_error(
            &vault_blocked.body,
            "BAD_REQUEST",
            "Team deletion is blocked until all team vaults have been removed or converted.",
        );

        let success_owner_id = "team_delete_success_owner";
        let success_team_id = "team_delete_success_team";
        seed_user(
            &app.pool,
            success_owner_id,
            "Delete Success Owner",
            "team-delete-success-owner@example.com",
        )
        .await;
        seed_team(
            &app.pool,
            success_team_id,
            "Delete Success Team",
            success_owner_id,
            "organization",
            "team",
            "active",
        )
        .await;
        assign_user_to_team(&app.pool, success_owner_id, success_team_id, "owner").await;
        let success_session = app.issue_session(success_owner_id).await;
        let delete_success = with_bittery_mode_async(
            Some("cloud"),
            app.rpc_call(
                "team.delete",
                json!([{ "teamId": success_team_id }]),
                authenticated_json_headers(&success_session.token),
            ),
        )
        .await;
        assert_eq!(delete_success.status, StatusCode::OK);
        assert_eq!(delete_success.body["result"]["Ok"]["success"], json!(true));
        let deleted_team_exists =
            query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM team WHERE id = $1)")
                .bind(success_team_id)
                .fetch_one(&app.pool)
                .await
                .expect("deleted team existence query should load");
        let reassigned_team_type = query_scalar::<_, String>(
				"SELECT t.type::text FROM team t INNER JOIN \"user\" u ON u.team_id = t.id WHERE u.id = $1",
			)
			.bind(success_owner_id)
			.fetch_one(&app.pool)
			.await
			.expect("reassigned team type should load");
        assert!(!deleted_team_exists);
        assert_eq!(reassigned_team_type, "personal");
    })
    .await;
}

#[tokio::test]
async fn team_member_rotation_remove_and_delete_account_paths() {
    with_rpc_test_app(
			"team_member_remove",
			|app| async move {
				let fixture = build_team_router_fixture(&app.pool).await;

				let owner_session = app.issue_session(&fixture.owner_user_id).await;
				let owner_headers = authenticated_json_headers(&owner_session.token);
				let owner_rotation = app
					.rpc_call(
						"team.members.getTeamRotationData",
						json!([{
							"teamId": fixture.team_id,
							"excludeUserId": fixture.remove_target_user_id
						}]),
						owner_headers.clone(),
					)
					.await;
				assert_eq!(owner_rotation.status, StatusCode::OK);
				let owner_vaults = owner_rotation.body["result"]["Ok"]["vaults"]
					.as_array()
					.expect("owner rotation vaults should be an array");
				assert_eq!(owner_vaults.len(), 2);
				assert!(owner_vaults.iter().any(|vault| vault["vaultId"] == json!(fixture.accessible_vault_id.clone())));
				assert!(owner_vaults.iter().any(|vault| vault["vaultId"] == json!(fixture.admin_inaccessible_vault_id.clone())));

				let admin_session = app.issue_session(&fixture.admin_user_id).await;
				let admin_rotation = app
					.rpc_call(
						"team.members.getTeamRotationData",
						json!([{
							"teamId": fixture.team_id,
							"excludeUserId": fixture.remove_target_user_id
						}]),
						authenticated_json_headers(&admin_session.token),
					)
					.await;
				assert_eq!(admin_rotation.status, StatusCode::OK);
				assert_handler_error(
					&admin_rotation.body,
					"FORBIDDEN",
					"You cannot remove this member from only part of their team vault access.",
				);

				let member_session = app.issue_session(&fixture.member_user_id).await;
				let member_rotation = app
					.rpc_call(
						"team.members.getTeamRotationData",
						json!([{
							"teamId": fixture.team_id,
							"excludeUserId": fixture.remove_target_user_id
						}]),
						authenticated_json_headers(&member_session.token),
					)
					.await;
				assert_eq!(member_rotation.status, StatusCode::OK);
				assert_handler_error(
					&member_rotation.body,
					"FORBIDDEN",
					"Only owner or admin can perform key rotation",
				);

				let missing_target = app
					.rpc_call(
						"team.members.remove",
						json!([{
							"teamId": fixture.team_id,
							"userId": "missing-user",
							"vaultRotations": []
						}]),
						owner_headers.clone(),
					)
					.await;
				assert_eq!(missing_target.status, StatusCode::OK);
				assert_handler_error(
					&missing_target.body,
					"NOT_FOUND",
					"Team member not found",
				);

				let self_remove = app
					.rpc_call(
						"team.members.remove",
						json!([{
							"teamId": fixture.team_id,
							"userId": fixture.owner_user_id,
							"vaultRotations": []
						}]),
						owner_headers.clone(),
					)
					.await;
				assert_eq!(self_remove.status, StatusCode::OK);
				assert_handler_error(
					&self_remove.body,
					"BAD_REQUEST",
					"You cannot remove yourself from the team",
				);

				let removed_session = app.issue_session(&fixture.remove_target_user_id).await;
				let remove_response = app
					.rpc_call(
						"team.members.remove",
						json!([{
							"teamId": fixture.team_id,
							"userId": fixture.remove_target_user_id,
							"vaultRotations": [
								{
									"vaultId": fixture.accessible_vault_id,
									"keyRotation": {
										"memberKeys": [
											{
												"userId": fixture.owner_user_id,
												"encryptedVaultKey": "remove-owner-key"
											},
											{
												"userId": fixture.admin_user_id,
												"encryptedVaultKey": "remove-admin-key"
											},
											{
												"userId": fixture.member_user_id,
												"encryptedVaultKey": "remove-member-key"
											}
										],
										"reEncryptedItems": [{
											"itemId": fixture.accessible_item_id,
											"encryptedData": "remove-accessible-ciphertext",
											"encryptionIv": "remove-accessible-iv"
										}]
									}
								},
								{
									"vaultId": fixture.admin_inaccessible_vault_id,
									"keyRotation": {
										"memberKeys": [{
											"userId": fixture.owner_user_id,
											"encryptedVaultKey": "remove-owner-hidden-key"
										}],
										"reEncryptedItems": [{
											"itemId": fixture.admin_inaccessible_item_id,
											"encryptedData": "remove-hidden-ciphertext",
											"encryptionIv": "remove-hidden-iv"
										}]
									}
								}
							]
						}]),
						owner_headers,
					)
					.await;
				assert_eq!(remove_response.status, StatusCode::OK);
				assert_eq!(remove_response.body["result"]["Ok"]["success"], json!(true));
				assert_eq!(
					remove_response.body["result"]["Ok"]["vaultRotations"]
						.as_array()
						.expect("rotation results should be an array")
						.len(),
					2
				);

				let removed_user_team = query_scalar::<_, Option<String>>(
					"SELECT team_id FROM \"user\" WHERE id = $1",
				)
				.bind(&fixture.remove_target_user_id)
				.fetch_one(&app.pool)
				.await
				.expect("removed user team should load")
				.expect("removed user should have a personal team");
				let removed_user_role = query_scalar::<_, String>(
					"SELECT role::text FROM \"user\" WHERE id = $1",
				)
				.bind(&fixture.remove_target_user_id)
				.fetch_one(&app.pool)
				.await
				.expect("removed user role should load");
				let removed_user_old_key_exists = query_scalar::<_, bool>(
					"SELECT EXISTS(SELECT 1 FROM vault_key WHERE vault_id = $1 AND user_id = $2)",
				)
				.bind(&fixture.accessible_vault_id)
				.bind(&fixture.remove_target_user_id)
				.fetch_one(&app.pool)
				.await
				.expect("removed user old vault key query should succeed");
				let accessible_version = query_scalar::<_, i32>(
					"SELECT key_version FROM vault WHERE id = $1",
				)
				.bind(&fixture.accessible_vault_id)
				.fetch_one(&app.pool)
				.await
				.expect("accessible vault version should load");
				let hidden_version = query_scalar::<_, i32>(
					"SELECT key_version FROM vault WHERE id = $1",
				)
				.bind(&fixture.admin_inaccessible_vault_id)
				.fetch_one(&app.pool)
				.await
				.expect("hidden vault version should load");
				let completed_rotations = query_scalar::<_, i64>(
					"SELECT COUNT(*)::bigint FROM vault_key_rotation WHERE removed_user_id = $1 AND status = 'completed'",
				)
				.bind(&fixture.remove_target_user_id)
				.fetch_one(&app.pool)
				.await
				.expect("completed rotation count should load");
				let removed_user_session_count = query_scalar::<_, i64>(
					"SELECT COUNT(*)::bigint FROM session WHERE user_id = $1",
				)
				.bind(&fixture.remove_target_user_id)
				.fetch_one(&app.pool)
				.await
				.expect("removed user session count should load");

				assert_ne!(removed_user_team, fixture.team_id);
				assert_eq!(removed_user_role, "owner");
				assert!(!removed_user_old_key_exists);
				assert_eq!(accessible_version, 2);
				assert_eq!(hidden_version, 2);
				assert_eq!(completed_rotations, 2);
				assert_eq!(removed_user_session_count, 0);

				let removed_session_revoked = load_session_revocation(
					&app.pool,
					&fixture.remove_target_user_id,
					&removed_session.session_id,
				)
				.await
				.expect("removed session revocation should load")
				.expect("removed session revocation record should exist");
				assert_eq!(
					removed_session_revoked.reason.as_deref(),
					Some("team_member_removed")
				);

				let invalid_delete_account = app
					.rpc_call(
						"team.members.deleteAccount",
						json!([{
							"teamId": fixture.team_id,
							"userId": fixture.member_user_id,
							"confirmation": "NOPE"
						}]),
						authenticated_json_headers(&admin_session.token),
					)
					.await;
				assert_eq!(invalid_delete_account.status, StatusCode::OK);
				assert_handler_error(
					&invalid_delete_account.body,
					"BAD_REQUEST",
					"Invalid params",
				);

				let deprecated_delete_account = app
					.rpc_call(
						"team.members.deleteAccount",
						json!([{
							"teamId": fixture.team_id,
							"userId": fixture.member_user_id,
							"confirmation": "DELETE"
						}]),
						authenticated_json_headers(&admin_session.token),
					)
					.await;
				assert_eq!(deprecated_delete_account.status, StatusCode::OK);
				assert_handler_error(
					&deprecated_delete_account.body,
					"BAD_REQUEST",
					"Account deletion by team admins is no longer supported. Use 'Remove member' instead. The removed user can delete their own account.",
				);
			},
		)
		.await;
}
