use super::{
    assert_optional_team_management_entitlement, assert_team_management_entitlement, bittery_mode,
    ensure_exact_rotation_vault_set, ensure_team_admin, generate_secure_token,
    normalize_pending_vault_keys, parse_pending_vault_keys, validate_rotation_vault_inputs,
    validate_token, PendingVaultKeyEntry, RotationMemberKeyInput, RotationReEncryptedItemInput,
    RotationVaultInput, VaultKeyRotationInput, TEAM_MANAGEMENT_UNAVAILABLE_MESSAGE,
};
use crate::error::AppErrorCode;
use crate::repo::common::hash_token;
use crate::services::session_control::load_session_revocation;
use crate::test_support::{
    acquire_env_lock, acquire_env_lock_async, assign_user_to_team, authenticated_json_headers,
    seed_item, seed_team, seed_user, seed_vault, seed_vault_key, with_api_test_app,
};
use axum::http::{header::CONTENT_TYPE, HeaderMap, HeaderValue, Method};
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
    let _guard = acquire_env_lock_async().await;
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
    let _guard = acquire_env_lock_async().await;
    let previous = (
        std::env::var("BITTERY_STORAGE_ENDPOINT").ok(),
        std::env::var("BITTERY_STORAGE_BUCKET").ok(),
        std::env::var("BITTERY_STORAGE_ACCESS_KEY_ID").ok(),
        std::env::var("BITTERY_STORAGE_SECRET_ACCESS_KEY").ok(),
        std::env::var("BITTERY_STORAGE_REGION").ok(),
        std::env::var("BITTERY_STORAGE_CDN_URL").ok(),
    );
    set_env_var(
        "BITTERY_STORAGE_ENDPOINT",
        Some("https://storage.example.invalid"),
    );
    set_env_var("BITTERY_STORAGE_BUCKET", Some("bittery-test"));
    set_env_var("BITTERY_STORAGE_ACCESS_KEY_ID", Some("test-access-key"));
    set_env_var("BITTERY_STORAGE_SECRET_ACCESS_KEY", Some("test-secret-key"));
    set_env_var("BITTERY_STORAGE_REGION", Some("auto"));
    set_env_var(
        "BITTERY_STORAGE_CDN_URL",
        Some("https://cdn.example.invalid/assets"),
    );

    let result = future.await;

    let (
        previous_endpoint,
        previous_bucket,
        previous_access_key,
        previous_secret_key,
        previous_region,
        previous_cdn_url,
    ) = previous;
    restore_env_var("BITTERY_STORAGE_ENDPOINT", previous_endpoint);
    restore_env_var("BITTERY_STORAGE_BUCKET", previous_bucket);
    restore_env_var("BITTERY_STORAGE_ACCESS_KEY_ID", previous_access_key);
    restore_env_var("BITTERY_STORAGE_SECRET_ACCESS_KEY", previous_secret_key);
    restore_env_var("BITTERY_STORAGE_REGION", previous_region);
    restore_env_var("BITTERY_STORAGE_CDN_URL", previous_cdn_url);

    result
}

fn unauthenticated_json_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(
        "bittery-client-platform",
        HeaderValue::from_static("desktop"),
    );
    headers.insert(
        "bittery-client-id",
        HeaderValue::from_static("integration-test"),
    );
    headers
}

fn assert_transport_error(body: &Value, code: &str, message: &str) {
    assert_eq!(body["detail"], json!(message));
    assert_eq!(body["code"], json!(code));
}

fn assert_handler_error(body: &Value, code: &str, message: &str) {
    assert_eq!(body["code"], json!(code));
    assert_eq!(body["detail"], json!(message));
}

fn assert_invalid_params_error(body: &Value) {
    assert!(
        body["code"].is_string(),
        "unexpected invalid params body: {body}"
    );
    let message = body["detail"]
        .as_str()
        .unwrap_or_default()
        .to_ascii_lowercase();
    assert!(
        (body["code"] == json!("INVALID_REQUEST") || message.contains("invalid")),
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
    _outsider_team_id: String,
    invitee_user_id: String,
    accept_user_id: String,
    decline_user_id: String,
    accessible_vault_id: String,
    _hidden_vault_id: String,
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
        _outsider_team_id: outsider_team_id,
        invitee_user_id,
        accept_user_id,
        decline_user_id,
        accessible_vault_id,
        _hidden_vault_id: hidden_vault_id,
        admin_inaccessible_vault_id,
        accessible_item_id,
        admin_inaccessible_item_id,
    }
}

#[allow(clippy::too_many_arguments)]
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
			"INSERT INTO team_invitation (id, team_id, email, role, invited_by_id, token_hash, pending_vault_keys, expires_at) VALUES ($1, $2, $3, $4::team_role, $5, $6, $7, $8)",
		)
		.bind(invitation_id)
		.bind(team_id)
		.bind(email)
		.bind(role)
		.bind(invited_by_id)
		.bind(hash_token(token))
		.bind(pending_vault_keys)
		.bind(expires_at)
		.execute(pool)
		.await
		.expect("team invitation should seed");
}

#[test]
fn bittery_mode_accepts_the_canonical_value_and_defaults_to_cloud() {
    with_bittery_mode(None, || {
        assert_eq!(bittery_mode(), "cloud");
    });
    with_bittery_mode(Some("self-hosted"), || {
        assert_eq!(bittery_mode(), "self-hosted");
    });
    with_bittery_mode(Some("SELF-HOSTED"), || {
        assert_eq!(bittery_mode(), "self-hosted");
    });
    with_bittery_mode(Some("cloud"), || {
        assert_eq!(bittery_mode(), "cloud");
    });
}

#[test]
fn assert_team_management_entitlement_respects_mode_and_billing() {
    with_bittery_mode(Some("self-hosted"), || {
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
fn team_invitation_and_rotation_reject_oversized_vault_keys() {
    let oversized = "k".repeat(crate::services::vault_key::ENCRYPTED_VAULT_KEY_MAX_BYTES + 1);
    assert!(
        normalize_pending_vault_keys(Some(vec![PendingVaultKeyEntry {
            vault_id: "vault_pending_limit".to_string(),
            encrypted_vault_key: oversized.clone(),
        }]))
        .is_err()
    );
    assert!(validate_rotation_vault_inputs(&[RotationVaultInput {
        vault_id: "vault_rotation_limit".to_string(),
        key_rotation: VaultKeyRotationInput {
            member_keys: vec![RotationMemberKeyInput {
                user_id: "user_rotation_limit".to_string(),
                encrypted_vault_key: oversized,
            }],
            re_encrypted_items: Vec::new(),
        },
    }])
    .is_err());
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
    with_api_test_app("team_auth_matrix", |app| async move {
        for (method, path, payload) in [
            (Method::GET, "/api/v1/teams/current", None),
            (Method::GET, "/api/v1/teams/team_test", None),
            (Method::GET, "/api/v1/teams/team_test/vaults", None),
            (
                Method::POST,
                "/api/v1/teams",
                Some(json!({ "name": "Example Team" })),
            ),
            (
                Method::PATCH,
                "/api/v1/teams/team_test",
                Some(json!({ "name": "Updated Team" })),
            ),
            (
                Method::POST,
                "/api/v1/teams/team_test/image-uploads",
                Some(json!({
                    "fileName": "logo.png",
                    "contentType": "image/png"
                })),
            ),
            (Method::DELETE, "/api/v1/teams/team_test", None),
            (
                Method::POST,
                "/api/v1/teams/team_test/leave",
                Some(json!({ "vaultRotations": [] })),
            ),
            (
                Method::GET,
                "/api/v1/teams/team_test/leave-rotation-data",
                None,
            ),
            (Method::GET, "/api/v1/teams/team_test/members", None),
            (
                Method::GET,
                "/api/v1/teams/team_test/members/user_test/removal-rotation-data",
                None,
            ),
            (
                Method::DELETE,
                "/api/v1/teams/team_test/members/user_test",
                Some(json!({
                    "vaultRotations": []
                })),
            ),
            (Method::GET, "/api/v1/teams/team_test/invitations", None),
            (Method::GET, "/api/v1/users/me/team-invitations", None),
            (
                Method::POST,
                "/api/v1/teams/team_test/invitations",
                Some(json!({ "email": "invitee@example.com" })),
            ),
            (
                Method::POST,
                "/api/v1/public/team-invitations/A234567890123456789012345678901/accept",
                None,
            ),
            (
                Method::DELETE,
                "/api/v1/teams/team_test/invitations/invitation_test",
                None,
            ),
            (
                Method::POST,
                "/api/v1/teams/team_test/invitations/invitation_test/resend",
                None,
            ),
            (
                Method::POST,
                "/api/v1/public/team-invitations/A234567890123456789012345678901/decline",
                None,
            ),
        ] {
            let response = app
                .api_json(method, path, payload, unauthenticated_json_headers())
                .await;

            response.assert_contract_status();
            assert_transport_error(
                &response.body,
                "UNAUTHORIZED",
                "A valid bearer session is required.",
            );
        }
    })
    .await;
}

#[tokio::test]
async fn team_handlers_reject_malformed_request_input() {
    with_api_test_app("team_bad_params", |app| async move {
        let token_response = app
            .api_json(
                Method::GET,
                &format!("/api/v1/public/team-invitations/{}", "missing-token"),
                None,
                unauthenticated_json_headers(),
            )
            .await;
        token_response.assert_contract_status();
        assert_invalid_params_error(&token_response.body);
    })
    .await;
}

#[tokio::test]
async fn team_invitation_lookup_send_list_pending_cancel_and_resend_paths() {
    with_api_test_app("team_invite_manage", |app| async move {
        let fixture = build_team_router_fixture(&app.pool).await;
        let owner_session = app.issue_session(&fixture.owner_user_id).await;
        let owner_headers = authenticated_json_headers(&owner_session.token);

        let send_response = app
            .api_json(
                Method::POST,
                &format!("/api/v1/teams/{}/invitations", fixture.team_id),
                Some(json!({

                    "email": "team-invitee@example.com",
                    "pendingVaultKeys": [{
                        "vaultId": fixture.accessible_vault_id,
                        "encryptedVaultKey": "invitee-wrapped-key"
                    }]
                })),
                owner_headers.clone(),
            )
            .await;
        send_response.assert_contract_status();
        assert_eq!(
            send_response.body["existingUserPublicKey"],
            json!("public-key")
        );
        let invitation_id = send_response.body["invitationId"]
            .as_str()
            .expect("invitation id should exist")
            .to_string();
        let invitation_token = send_response.body["token"]
            .as_str()
            .expect("invitation token should exist")
            .to_string();

        let list_response = app
            .api_json(
                Method::GET,
                &format!("/api/v1/teams/{}/invitations", fixture.team_id),
                None,
                owner_headers.clone(),
            )
            .await;
        list_response.assert_contract_status();
        assert_eq!(
            list_response.body["items"][0]["id"],
            json!(invitation_id.clone())
        );

        let invitee_session = app.issue_session(&fixture.invitee_user_id).await;
        let pending_response = app
            .api_json(
                Method::GET,
                "/api/v1/users/me/team-invitations",
                None,
                authenticated_json_headers(&invitee_session.token),
            )
            .await;
        pending_response.assert_contract_status();
        // The pending list addresses the invitation by id: the raw token is no
        // longer readable back out of the database.
        assert_eq!(
            pending_response.body["items"][0]["id"],
            json!(invitation_id.clone())
        );
        assert!(pending_response.body["items"][0]["token"].is_null());

        let public_lookup = app
            .api_json(
                Method::GET,
                &format!(
                    "/api/v1/public/team-invitations/{}",
                    invitation_token.clone()
                ),
                None,
                unauthenticated_json_headers(),
            )
            .await;
        public_lookup.assert_contract_status();
        assert_eq!(public_lookup.body["status"], json!("pending"));
        assert_eq!(public_lookup.body["teamId"], json!(fixture.team_id.clone()));

        let invalid_token_response = app
            .api_json(
                Method::GET,
                &format!("/api/v1/public/team-invitations/{}", "short-token"),
                None,
                unauthenticated_json_headers(),
            )
            .await;
        invalid_token_response.assert_contract_status();
        assert_handler_error(&invalid_token_response.body, "BAD_REQUEST", "Invalid token");

        let missing_token = "0123456789abcdefghijklmnopqrstuv";
        let missing_response = app
            .api_json(
                Method::GET,
                &format!("/api/v1/public/team-invitations/{}", missing_token),
                None,
                unauthenticated_json_headers(),
            )
            .await;
        missing_response.assert_contract_status();
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
            .api_json(
                Method::GET,
                &format!(
                    "/api/v1/public/team-invitations/{}",
                    "ZXCVBNMASDFGHJKLQWERTYUIOP123456"
                ),
                None,
                unauthenticated_json_headers(),
            )
            .await;
        expired_lookup.assert_contract_status();
        assert_eq!(expired_lookup.body["status"], json!("expired"));

        let member_session = app.issue_session(&fixture.member_user_id).await;
        let forbidden_list = app
            .api_json(
                Method::GET,
                &format!("/api/v1/teams/{}/invitations", fixture.team_id),
                None,
                authenticated_json_headers(&member_session.token),
            )
            .await;
        forbidden_list.assert_contract_status();
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
            .api_json(
                Method::POST,
                &format!(
                    "/api/v1/teams/{}/invitations/{}/resend",
                    fixture.team_id,
                    invitation_id.clone()
                ),
                None,
                owner_headers.clone(),
            )
            .await;
        resend_response.assert_contract_status();
        assert_eq!(
            resend_response.body["invitationId"],
            json!(invitation_id.clone())
        );
        assert!(
            resend_response.body["token"].is_string(),
            "resend must hand back the rotated invite token"
        );
        let resent_expires_at = query_scalar::<_, OffsetDateTime>(
            "SELECT expires_at FROM team_invitation WHERE id = $1",
        )
        .bind(&invitation_id)
        .fetch_one(&app.pool)
        .await
        .expect("resent invitation should exist");
        assert!(resent_expires_at > OffsetDateTime::now_utc());

        let cancel_response = app
            .api_json(
                Method::DELETE,
                &format!(
                    "/api/v1/teams/{}/invitations/{}",
                    fixture.team_id,
                    invitation_id.clone()
                ),
                None,
                owner_headers,
            )
            .await;
        cancel_response.assert_contract_status();
        assert_eq!(cancel_response.body["success"], json!(true));
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
    with_api_test_app("team_core_mutations", |app| async move {
        let fixture = build_team_router_fixture(&app.pool).await;
        let owner_session = app.issue_session(&fixture.owner_user_id).await;
        let owner_headers = authenticated_json_headers(&owner_session.token);

        let list_response = app
            .api_json(
                Method::GET,
                "/api/v1/teams/current",
                None,
                owner_headers.clone(),
            )
            .await;
        list_response.assert_contract_status();
        assert_eq!(list_response.body["id"], json!(fixture.team_id.clone()));
        assert_eq!(list_response.body["memberCount"], json!("4"));

        let no_team_session = app.issue_session(&fixture.no_team_user_id).await;
        let no_team_list = app
            .api_json(
                Method::GET,
                "/api/v1/teams/current",
                None,
                authenticated_json_headers(&no_team_session.token),
            )
            .await;
        no_team_list.assert_contract_status();
        assert_handler_error(&no_team_list.body, "NOT_FOUND", "User has no team");

        let get_response = app
            .api_json(
                Method::GET,
                &format!("/api/v1/teams/{}", fixture.team_id),
                None,
                owner_headers.clone(),
            )
            .await;
        get_response.assert_contract_status();
        assert_eq!(
            get_response.body["ownerId"],
            json!(fixture.owner_user_id.clone())
        );
        assert_eq!(get_response.body["userRole"], json!("owner"));

        let outsider_session = app.issue_session(&fixture.outsider_user_id).await;
        let forbidden_get = app
            .api_json(
                Method::GET,
                &format!("/api/v1/teams/{}", fixture.team_id),
                None,
                authenticated_json_headers(&outsider_session.token),
            )
            .await;
        forbidden_get.assert_contract_status();
        assert_handler_error(
            &forbidden_get.body,
            "FORBIDDEN",
            "You are not a member of this team",
        );

        let create_response = app
            .api_json(
                Method::POST,
                "/api/v1/teams",
                Some(json!({ "name": "Manual Team" })),
                owner_headers.clone(),
            )
            .await;
        create_response.assert_contract_status();
        assert_handler_error(
            &create_response.body,
            "BAD_REQUEST",
            "Teams are automatically created on signup. Contact support to upgrade your team type.",
        );

        let member_session = app.issue_session(&fixture.member_user_id).await;
        let forbidden_update = app
            .api_json(
                Method::PATCH,
                &format!("/api/v1/teams/{}", fixture.team_id),
                Some(json!({

                    "name": "Forbidden Rename"
                })),
                authenticated_json_headers(&member_session.token),
            )
            .await;
        forbidden_update.assert_contract_status();
        assert_handler_error(
            &forbidden_update.body,
            "FORBIDDEN",
            "Insufficient permissions",
        );

        let update_response = app
            .api_json(
                Method::PATCH,
                &format!("/api/v1/teams/{}", fixture.team_id),
                Some(json!({

                    "name": "Renamed Router Team",
                    "imageKey": "teams/team_router_main/custom-logo.png"
                })),
                owner_headers.clone(),
            )
            .await;
        update_response.assert_contract_status();
        assert_eq!(update_response.body["success"], json!(true));
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

        let team_after_update = with_storage_env_async(app.api_json(
            Method::GET,
            &format!("/api/v1/teams/{}", fixture.team_id),
            None,
            owner_headers.clone(),
        ))
        .await;
        team_after_update.assert_contract_status();
        assert_eq!(
            team_after_update.body["imageUrl"],
            json!("https://cdn.example.invalid/assets/teams/team_router_main/custom-logo.png")
        );

        let forbidden_upload = app
            .api_json(
                Method::POST,
                &format!("/api/v1/teams/{}/image-uploads", fixture.team_id),
                Some(json!({

                    "fileName": "logo.png",
                    "contentType": "image/png"
                })),
                authenticated_json_headers(&member_session.token),
            )
            .await;
        forbidden_upload.assert_contract_status();
        assert_handler_error(
            &forbidden_upload.body,
            "FORBIDDEN",
            "Insufficient permissions",
        );

        let invalid_upload = app
            .api_json(
                Method::POST,
                &format!("/api/v1/teams/{}/image-uploads", fixture.team_id),
                Some(json!({

                    "fileName": "logo.txt",
                    "contentType": "text/plain"
                })),
                owner_headers.clone(),
            )
            .await;
        invalid_upload.assert_contract_status();
        assert_handler_error(
            &invalid_upload.body,
            "BAD_REQUEST",
            "Only image files are allowed",
        );

        let upload_response = with_storage_env_async(app.api_json(
            Method::POST,
            &format!("/api/v1/teams/{}/image-uploads", fixture.team_id),
            Some(json!({

                "fileName": "logo.png",
                "contentType": "image/png"
            })),
            owner_headers,
        ))
        .await;
        upload_response.assert_contract_status();
        let key = upload_response.body["key"]
            .as_str()
            .expect("upload key should exist");
        assert!(
            key.starts_with("teams/team_router_main/"),
            "unexpected key: {key}"
        );
        assert!(
            upload_response.body["uploadUrl"]
                .as_str()
                .expect("upload url should exist")
                .contains("storage.example.invalid/bittery-test/"),
            "unexpected upload response: {}",
            upload_response.body
        );
        assert!(
            upload_response.body["publicUrl"]
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
    with_api_test_app("team_query_paths", |app| async move {
        let fixture = build_team_router_fixture(&app.pool).await;
        let owner_session = app.issue_session(&fixture.owner_user_id).await;
        let owner_headers = authenticated_json_headers(&owner_session.token);

        let vaults_response = app
            .api_json(
                Method::GET,
                &format!("/api/v1/teams/{}/vaults", fixture.team_id),
                None,
                owner_headers.clone(),
            )
            .await;
        vaults_response.assert_contract_status();
        assert_eq!(
            vaults_response
                .body
                .get("items")
                .and_then(Value::as_array)
                .expect("vaults should be an array")
                .len(),
            3
        );
        assert_eq!(
            vaults_response.body["items"][0]["encryptedVaultKey"],
            json!("owner-accessible-key")
        );

        let member_session = app.issue_session(&fixture.member_user_id).await;
        let forbidden_vaults = app
            .api_json(
                Method::GET,
                &format!("/api/v1/teams/{}/vaults", fixture.team_id),
                None,
                authenticated_json_headers(&member_session.token),
            )
            .await;
        forbidden_vaults.assert_contract_status();
        assert_handler_error(
            &forbidden_vaults.body,
            "FORBIDDEN",
            "Insufficient permissions",
        );

        let members_response = app
            .api_json(
                Method::GET,
                &format!("/api/v1/teams/{}/members", fixture.team_id),
                None,
                owner_headers.clone(),
            )
            .await;
        members_response.assert_contract_status();
        let members = members_response
            .body
            .get("items")
            .and_then(Value::as_array)
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
            .api_json(
                Method::GET,
                &format!("/api/v1/teams/{}/members", fixture.team_id),
                None,
                authenticated_json_headers(&outsider_session.token),
            )
            .await;
        forbidden_members.assert_contract_status();
        assert_handler_error(
            &forbidden_members.body,
            "FORBIDDEN",
            "You are not a member of this team",
        );

        let leave_rotation_response = app
            .api_json(
                Method::GET,
                &format!("/api/v1/teams/{}/leave-rotation-data", fixture.team_id),
                None,
                authenticated_json_headers(&member_session.token),
            )
            .await;
        leave_rotation_response.assert_contract_status();
        let rotation_vaults = leave_rotation_response.body["vaults"]
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

/// Finding 5c: `team_invitation.token_hash` must never hold the invite token
/// itself. The raw token is returned once to the inviter (for the emailed link)
/// and is still redeemable, but a database read discloses only a digest.
#[tokio::test]
async fn team_invitation_token_is_stored_hashed_and_still_accepts() {
    with_api_test_app("team_invitation_token_hashed", |app| async move {
        let fixture = build_team_router_fixture(&app.pool).await;
        let owner_session = app.issue_session(&fixture.owner_user_id).await;
        let owner_headers = authenticated_json_headers(&owner_session.token);

        let send_response = app
            .api_json(
                Method::POST,
                &format!("/api/v1/teams/{}/invitations", fixture.team_id),
                Some(json!({

                    "email": "team-accept@example.com"
                })),
                owner_headers,
            )
            .await;
        send_response.assert_contract_status();
        let invitation_id = send_response.body["invitationId"]
            .as_str()
            .expect("invitation id should exist")
            .to_string();
        let token = send_response.body["token"]
            .as_str()
            .expect("invitation token should exist")
            .to_string();

        let stored =
            query_scalar::<_, String>("SELECT token_hash FROM team_invitation WHERE id = $1")
                .bind(&invitation_id)
                .fetch_one(&app.pool)
                .await
                .expect("invitation should load");
        assert_ne!(stored, token, "the raw invite token must not be persisted");
        assert_eq!(stored, hash_token(&token));
        assert_eq!(stored.len(), 64);

        // The stored digest is not a bearer token: replaying it must not resolve.
        let replayed = app
            .api_json(
                Method::GET,
                &format!("/api/v1/public/team-invitations/{}", stored),
                None,
                unauthenticated_json_headers(),
            )
            .await;
        assert_handler_error(&replayed.body, "BAD_REQUEST", "Invalid token");

        // A well-formed but wrong token still fails.
        let wrong = app
            .api_json(
                Method::GET,
                &format!(
                    "/api/v1/public/team-invitations/{}",
                    "0123456789abcdefghijklmnopqrstuv"
                ),
                None,
                unauthenticated_json_headers(),
            )
            .await;
        assert_handler_error(&wrong.body, "NOT_FOUND", "Invitation not found");

        // The raw token from the emailed link still resolves and accepts.
        let lookup = app
            .api_json(
                Method::GET,
                &format!("/api/v1/public/team-invitations/{}", token.clone()),
                None,
                unauthenticated_json_headers(),
            )
            .await;
        assert_eq!(lookup.body["status"], json!("pending"));

        let accept_session = app.issue_session(&fixture.accept_user_id).await;
        let accepted = app
            .api_json(
                Method::POST,
                &format!("/api/v1/public/team-invitations/{}/accept", token),
                None,
                authenticated_json_headers(&accept_session.token),
            )
            .await;
        assert_eq!(accepted.body["teamId"], json!(fixture.team_id.clone()));
    })
    .await;
}

/// Regression: resending must mint a brand new token. Only the digest of the
/// original token is stored, so reviving the row without rotating leaves a
/// `pending` invitation whose link nobody can produce. The caller therefore gets
/// a fresh raw token back, and the previous one must stop working.
#[tokio::test]
async fn team_invitation_resend_rotates_token_and_returns_a_working_link() {
    with_api_test_app("team_invitation_resend_rotates", |app| async move {
        let fixture = build_team_router_fixture(&app.pool).await;
        let owner_session = app.issue_session(&fixture.owner_user_id).await;
        let owner_headers = authenticated_json_headers(&owner_session.token);

        let send_response = app
            .api_json(
                Method::POST,
                &format!("/api/v1/teams/{}/invitations", fixture.team_id),
                Some(json!({

                    "email": "team-accept@example.com"
                })),
                owner_headers.clone(),
            )
            .await;
        send_response.assert_contract_status();
        let invitation_id = send_response.body["invitationId"]
            .as_str()
            .expect("invitation id should exist")
            .to_string();
        let original_token = send_response.body["token"]
            .as_str()
            .expect("invitation token should exist")
            .to_string();

        let hash_before =
            query_scalar::<_, String>("SELECT token_hash FROM team_invitation WHERE id = $1")
                .bind(&invitation_id)
                .fetch_one(&app.pool)
                .await
                .expect("invitation should load");

        let resend_response = app
            .api_json(
                Method::POST,
                &format!(
                    "/api/v1/teams/{}/invitations/{}/resend",
                    fixture.team_id,
                    invitation_id.clone()
                ),
                None,
                owner_headers,
            )
            .await;
        resend_response.assert_contract_status();
        assert_eq!(
            resend_response.body["invitationId"],
            json!(invitation_id.clone())
        );
        let rotated_token = resend_response.body["token"]
            .as_str()
            .expect("resend should return a fresh invitation token")
            .to_string();
        assert_ne!(
            rotated_token, original_token,
            "resend must not hand back the token it was given at creation time"
        );

        let hash_after =
            query_scalar::<_, String>("SELECT token_hash FROM team_invitation WHERE id = $1")
                .bind(&invitation_id)
                .fetch_one(&app.pool)
                .await
                .expect("invitation should load");
        assert_ne!(
            hash_after, hash_before,
            "resend must rotate the stored token digest"
        );
        assert_eq!(hash_after, hash_token(&rotated_token));
        assert_ne!(
            hash_after, rotated_token,
            "the raw invite token must not be persisted"
        );

        // The link handed out before the resend is dead.
        let stale_lookup = app
            .api_json(
                Method::GET,
                &format!("/api/v1/public/team-invitations/{}", original_token.clone()),
                None,
                unauthenticated_json_headers(),
            )
            .await;
        assert_handler_error(&stale_lookup.body, "NOT_FOUND", "Invitation not found");

        let accept_session = app.issue_session(&fixture.accept_user_id).await;
        let stale_accept = app
            .api_json(
                Method::POST,
                &format!("/api/v1/public/team-invitations/{}/accept", original_token),
                None,
                authenticated_json_headers(&accept_session.token),
            )
            .await;
        assert_handler_error(
            &stale_accept.body,
            "NOT_FOUND",
            "Invitation not found or already used",
        );

        // The link built from the resend response works end to end.
        let fresh_lookup = app
            .api_json(
                Method::GET,
                &format!("/api/v1/public/team-invitations/{}", rotated_token.clone()),
                None,
                unauthenticated_json_headers(),
            )
            .await;
        assert_eq!(fresh_lookup.body["status"], json!("pending"));

        let accepted = app
            .api_json(
                Method::POST,
                &format!("/api/v1/public/team-invitations/{}/accept", rotated_token),
                None,
                authenticated_json_headers(&accept_session.token),
            )
            .await;
        assert_eq!(accepted.body["teamId"], json!(fixture.team_id.clone()));
    })
    .await;
}

/// Regression: an invitation that already lapsed is the main reason an admin hits
/// resend. It must come back as `pending` with a token the admin can actually
/// hand out, not with the unreachable digest it was stored with.
#[tokio::test]
async fn team_invitation_resend_revives_expired_invitation_with_a_fresh_token() {
    with_api_test_app("team_invitation_resend_expired", |app| async move {
        let fixture = build_team_router_fixture(&app.pool).await;
        let invitation_id = "team_invitation_resend_expired";
        let original_token = "ZXCVBNMASDFGHJKLQWERTYUIOP123456";
        seed_team_invitation(
            &app.pool,
            invitation_id,
            &fixture.team_id,
            "team-accept@example.com",
            "member",
            &fixture.owner_user_id,
            original_token,
            None,
            OffsetDateTime::now_utc() - Duration::days(1),
        )
        .await;
        query("UPDATE team_invitation SET status = 'expired' WHERE id = $1")
            .bind(invitation_id)
            .execute(&app.pool)
            .await
            .expect("invitation should expire");

        let owner_session = app.issue_session(&fixture.owner_user_id).await;
        let resend_response = app
            .api_json(
                Method::POST,
                &format!(
                    "/api/v1/teams/{}/invitations/{}/resend",
                    fixture.team_id, invitation_id
                ),
                None,
                authenticated_json_headers(&owner_session.token),
            )
            .await;
        resend_response.assert_contract_status();
        let rotated_token = resend_response.body["token"]
            .as_str()
            .expect("resend should return a fresh invitation token")
            .to_string();
        assert_ne!(rotated_token, original_token);

        let stored =
            query_scalar::<_, String>("SELECT token_hash FROM team_invitation WHERE id = $1")
                .bind(invitation_id)
                .fetch_one(&app.pool)
                .await
                .expect("invitation should load");
        assert_eq!(stored, hash_token(&rotated_token));
        assert_ne!(stored, hash_token(original_token));

        let stale_lookup = app
            .api_json(
                Method::GET,
                &format!("/api/v1/public/team-invitations/{}", original_token),
                None,
                unauthenticated_json_headers(),
            )
            .await;
        assert_handler_error(&stale_lookup.body, "NOT_FOUND", "Invitation not found");

        let accept_session = app.issue_session(&fixture.accept_user_id).await;
        let accepted = app
            .api_json(
                Method::POST,
                &format!("/api/v1/public/team-invitations/{}/accept", rotated_token),
                None,
                authenticated_json_headers(&accept_session.token),
            )
            .await;
        assert_eq!(accepted.body["teamId"], json!(fixture.team_id.clone()));
    })
    .await;
}

/// Finding 5c follow-on: the in-app pending list can no longer hand back the raw
/// token, so accepting/declining from it addresses the invitation by id.
#[tokio::test]
async fn team_invitation_accept_and_decline_by_id_paths() {
    with_api_test_app("team_accept_decline_by_id", |app| async move {
        let fixture = build_team_router_fixture(&app.pool).await;
        let owner_session = app.issue_session(&fixture.owner_user_id).await;
        let owner_headers = authenticated_json_headers(&owner_session.token);

        let accept_invitation = app
            .api_json(
                Method::POST,
                &format!("/api/v1/teams/{}/invitations", fixture.team_id),
                Some(json!({

                    "email": "team-accept@example.com"
                })),
                owner_headers.clone(),
            )
            .await;
        let accept_invitation_id = accept_invitation.body["invitationId"]
            .as_str()
            .expect("accept invitation id should exist")
            .to_string();

        // Someone else's invitation id is not a credential.
        let wrong_user_session = app.issue_session(&fixture.no_team_user_id).await;
        let wrong_user_accept = app
            .api_json(
                Method::POST,
                &format!(
                    "/api/v1/users/me/team-invitations/{}/accept",
                    accept_invitation_id.clone()
                ),
                None,
                authenticated_json_headers(&wrong_user_session.token),
            )
            .await;
        assert_handler_error(
            &wrong_user_accept.body,
            "FORBIDDEN",
            "This invitation is not for you",
        );

        let unknown_accept = app
            .api_json(
                Method::POST,
                &format!(
                    "/api/v1/users/me/team-invitations/{}/accept",
                    "team_invitation_missing"
                ),
                None,
                authenticated_json_headers(&wrong_user_session.token),
            )
            .await;
        assert_handler_error(
            &unknown_accept.body,
            "NOT_FOUND",
            "Invitation not found or already used",
        );

        let accept_user_session = app.issue_session(&fixture.accept_user_id).await;
        let accepted = app
            .api_json(
                Method::POST,
                &format!(
                    "/api/v1/users/me/team-invitations/{}/accept",
                    accept_invitation_id.clone()
                ),
                None,
                authenticated_json_headers(&accept_user_session.token),
            )
            .await;
        assert_eq!(accepted.body["teamId"], json!(fixture.team_id.clone()));
        let accepted_status =
            query_scalar::<_, String>("SELECT status::text FROM team_invitation WHERE id = $1")
                .bind(&accept_invitation_id)
                .fetch_one(&app.pool)
                .await
                .expect("accepted invitation status should load");
        assert_eq!(accepted_status, "accepted");

        let decline_invitation = app
            .api_json(
                Method::POST,
                &format!("/api/v1/teams/{}/invitations", fixture.team_id),
                Some(json!({

                    "email": "team-decline@example.com"
                })),
                owner_headers,
            )
            .await;
        let decline_invitation_id = decline_invitation.body["invitationId"]
            .as_str()
            .expect("decline invitation id should exist")
            .to_string();

        let decline_user_session = app.issue_session(&fixture.decline_user_id).await;
        let declined = app
            .api_json(
                Method::POST,
                &format!(
                    "/api/v1/users/me/team-invitations/{}/decline",
                    decline_invitation_id.clone()
                ),
                None,
                authenticated_json_headers(&decline_user_session.token),
            )
            .await;
        assert_eq!(declined.body["success"], json!(true));
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
async fn team_invitation_accept_and_decline_paths() {
    with_api_test_app("team_accept_decline", |app| async move {
        let fixture = build_team_router_fixture(&app.pool).await;
        let owner_session = app.issue_session(&fixture.owner_user_id).await;
        let owner_headers = authenticated_json_headers(&owner_session.token);

        let accept_invitation = app
            .api_json(
                Method::POST,
                &format!("/api/v1/teams/{}/invitations", fixture.team_id),
                Some(json!({

                    "email": "team-accept@example.com",
                    "pendingVaultKeys": [{
                        "vaultId": fixture.accessible_vault_id,
                        "encryptedVaultKey": "accepted-user-key"
                    }]
                })),
                owner_headers.clone(),
            )
            .await;
        accept_invitation.assert_contract_status();
        let accept_invitation_id = accept_invitation.body["invitationId"]
            .as_str()
            .expect("accept invitation id should exist")
            .to_string();
        let accept_token = accept_invitation.body["token"]
            .as_str()
            .expect("accept token should exist")
            .to_string();

        let wrong_user_session = app.issue_session(&fixture.no_team_user_id).await;
        let wrong_user_accept = app
            .api_json(
                Method::POST,
                &format!(
                    "/api/v1/public/team-invitations/{}/accept",
                    accept_token.clone()
                ),
                None,
                authenticated_json_headers(&wrong_user_session.token),
            )
            .await;
        wrong_user_accept.assert_contract_status();
        assert_handler_error(
            &wrong_user_accept.body,
            "FORBIDDEN",
            "This invitation is not for you",
        );

        let accept_user_session = app.issue_session(&fixture.accept_user_id).await;
        let accept_response = app
            .api_json(
                Method::POST,
                &format!(
                    "/api/v1/public/team-invitations/{}/accept",
                    accept_token.clone()
                ),
                None,
                authenticated_json_headers(&accept_user_session.token),
            )
            .await;
        accept_response.assert_contract_status();
        assert_eq!(
            accept_response.body["teamId"],
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
            .api_json(
                Method::POST,
                &format!("/api/v1/teams/{}/invitations", fixture.team_id),
                Some(json!({

                    "email": "team-decline@example.com"
                })),
                owner_headers,
            )
            .await;
        decline_invitation.assert_contract_status();
        let decline_invitation_id = decline_invitation.body["invitationId"]
            .as_str()
            .expect("decline invitation id should exist")
            .to_string();
        let decline_token = decline_invitation.body["token"]
            .as_str()
            .expect("decline token should exist")
            .to_string();

        let decline_user_session = app.issue_session(&fixture.decline_user_id).await;
        let decline_response = app
            .api_json(
                Method::POST,
                &format!("/api/v1/public/team-invitations/{}/decline", decline_token),
                None,
                authenticated_json_headers(&decline_user_session.token),
            )
            .await;
        decline_response.assert_contract_status();
        assert_eq!(decline_response.body["success"], json!(true));
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

/// Same invariant as the vault-side rotation: the team member-removal rotation re-seals each
/// ciphertext under the context it already carried, so the apply step must not re-stamp
/// `encryption_version`/`encrypted_by_user_id`. Doing so leaves the stored context describing a
/// binding the ciphertext never had, and the item becomes permanently undecryptable.
#[tokio::test]
async fn team_rotation_advances_version_without_rebinding_encryption_context() {
    with_api_test_app("team_rotation_preserves_encryption_context", |app| async move {
        let fixture = build_team_router_fixture(&app.pool).await;

        let before: (i32, i32, String) = sqlx::query_as(
            "SELECT version, encryption_version, encrypted_by_user_id FROM item WHERE id = $1",
        )
        .bind(&fixture.accessible_item_id)
        .fetch_one(&app.pool)
        .await
        .expect("pre-rotation item context should load");
        assert_eq!(before, (1, 1, fixture.owner_user_id.clone()));

        // The leaving member drives the rotation; the item was sealed by the owner.
        let leaving_session = app.issue_session(&fixture.member_user_id).await;
        let leave_response = app
            .api_json(
                Method::POST,
                &format!("/api/v1/teams/{}/leave", fixture.team_id),
                Some(json!({
                    "vaultRotations": [{
                        "vaultId": fixture.accessible_vault_id,
                        "keyRotation": {
                            "memberKeys": [
                                { "userId": fixture.owner_user_id, "encryptedVaultKey": "rotated-owner-key" },
                                { "userId": fixture.admin_user_id, "encryptedVaultKey": "rotated-admin-key" },
                                { "userId": fixture.remove_target_user_id, "encryptedVaultKey": "rotated-target-key" }
                            ],
                            "reEncryptedItems": [{
                                "itemId": fixture.accessible_item_id,
                                "encryptedData": "rotated-item-ciphertext",
                                "encryptionIv": "rotated-item-iv"
                            }]
                        }
                    }]
                })),
                authenticated_json_headers(&leaving_session.token),
            )
            .await;
        leave_response.assert_contract_status();
        assert_eq!(leave_response.body["success"], json!(true));

        let after: (String, String, i32, i32, String, String) = sqlx::query_as(
            "SELECT encrypted_data, encryption_iv, version, encryption_version, encrypted_by_user_id, last_modified_by FROM item WHERE id = $1",
        )
        .bind(&fixture.accessible_item_id)
        .fetch_one(&app.pool)
        .await
        .expect("rotated item should load");

        assert_eq!(after.0, "rotated-item-ciphertext");
        assert_eq!(after.1, "rotated-item-iv");
        assert_eq!(after.2, before.0 + 1);
        assert_eq!(after.3, before.1);
        assert_eq!(after.4, before.2);
        assert_eq!(after.5, fixture.member_user_id);
    })
    .await;
}

#[tokio::test]
async fn team_leave_paths() {
    with_api_test_app("team_leave", |app| async move {
        let fixture = build_team_router_fixture(&app.pool).await;

        let owner_session = app.issue_session(&fixture.owner_user_id).await;
        let owner_leave = app
            .api_json(
                Method::POST,
                &format!("/api/v1/teams/{}/leave", fixture.team_id),
                Some(json!({  "vaultRotations": [] })),
                authenticated_json_headers(&owner_session.token),
            )
            .await;
        owner_leave.assert_contract_status();
        assert_handler_error(
            &owner_leave.body,
            "BAD_REQUEST",
            "The team owner cannot leave. Transfer ownership first.",
        );

        let leaving_session = app.issue_session(&fixture.member_user_id).await;
        let additional_session = app.issue_session(&fixture.member_user_id).await;
        let leave_response = app
            .api_json(
                Method::POST,
                &format!("/api/v1/teams/{}/leave", fixture.team_id),
                Some(json!({

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
                })),
                authenticated_json_headers(&leaving_session.token),
            )
            .await;
        leave_response.assert_contract_status();
        assert_eq!(leave_response.body["success"], json!(true));

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
        let rotated_item: (String, String, i32, Option<i32>, Option<String>) = sqlx::query_as(
            "SELECT encrypted_data, encryption_iv, version, encryption_version, encrypted_by_user_id FROM item WHERE id = $1",
        )
        .bind(&fixture.accessible_item_id)
        .fetch_one(&app.pool)
        .await
        .expect("rotated item should load");
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
        // Rotation advances the concurrency counter but leaves the AAD binding
        // (`encryption_version`/`encrypted_by_user_id`) exactly as the ciphertext was sealed.
        assert_eq!(
            rotated_item,
            (
                "rotated-item-ciphertext".to_string(),
                "rotated-item-iv".to_string(),
                2,
                Some(1),
                Some(fixture.owner_user_id.clone()),
            )
        );
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
    with_api_test_app("team_delete", |app| async move {
        let fixture = build_team_router_fixture(&app.pool).await;

        let member_session = app.issue_session(&fixture.member_user_id).await;
        let forbidden_delete = with_bittery_mode_async(
            Some("cloud"),
            app.api_json(
                Method::DELETE,
                &format!("/api/v1/teams/{}", fixture.team_id),
                None,
                authenticated_json_headers(&member_session.token),
            ),
        )
        .await;
        forbidden_delete.assert_contract_status();
        assert_handler_error(
            &forbidden_delete.body,
            "FORBIDDEN",
            "Only the team owner can delete the team",
        );

        let owner_session = app.issue_session(&fixture.owner_user_id).await;
        let self_hosted_delete = with_bittery_mode_async(
            Some("self-hosted"),
            app.api_json(
                Method::DELETE,
                &format!("/api/v1/teams/{}", fixture.team_id),
                None,
                authenticated_json_headers(&owner_session.token),
            ),
        )
        .await;
        self_hosted_delete.assert_contract_status();
        assert_handler_error(
            &self_hosted_delete.body,
            "BAD_REQUEST",
            "Team deletion is disabled in self-hosted mode. This instance uses a single team.",
        );

        let members_blocked = with_bittery_mode_async(
            Some("cloud"),
            app.api_json(
                Method::DELETE,
                &format!("/api/v1/teams/{}", fixture.team_id),
                None,
                authenticated_json_headers(&owner_session.token),
            ),
        )
        .await;
        members_blocked.assert_contract_status();
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
            app.api_json(
                Method::DELETE,
                &format!("/api/v1/teams/{}", vault_team_id),
                None,
                authenticated_json_headers(&vault_owner_session.token),
            ),
        )
        .await;
        vault_blocked.assert_contract_status();
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
            app.api_json(
                Method::DELETE,
                &format!("/api/v1/teams/{}", success_team_id),
                None,
                authenticated_json_headers(&success_session.token),
            ),
        )
        .await;
        delete_success.assert_contract_status();
        assert_eq!(delete_success.body["success"], json!(true));
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
    with_api_test_app(
			"team_member_remove",
			|app| async move {
				let fixture = build_team_router_fixture(&app.pool).await;

				let owner_session = app.issue_session(&fixture.owner_user_id).await;
				let owner_headers = authenticated_json_headers(&owner_session.token);
				let owner_rotation = app
					.api_json(Method::GET, &format!("/api/v1/teams/{}/members/{}/removal-rotation-data", fixture.team_id, fixture.remove_target_user_id), None, owner_headers.clone())
					.await;
				owner_rotation.assert_contract_status();
				let owner_vaults = owner_rotation.body["vaults"]
					.as_array()
					.expect("owner rotation vaults should be an array");
				assert_eq!(owner_vaults.len(), 2);
				assert!(owner_vaults.iter().any(|vault| vault["vaultId"] == json!(fixture.accessible_vault_id.clone())));
				assert!(owner_vaults.iter().any(|vault| vault["vaultId"] == json!(fixture.admin_inaccessible_vault_id.clone())));

				let admin_session = app.issue_session(&fixture.admin_user_id).await;
				let admin_rotation = app
					.api_json(Method::GET, &format!("/api/v1/teams/{}/members/{}/removal-rotation-data", fixture.team_id, fixture.remove_target_user_id), None, authenticated_json_headers(&admin_session.token))
					.await;
				admin_rotation.assert_contract_status();
				assert_handler_error(
					&admin_rotation.body,
					"FORBIDDEN",
					"You cannot remove this member from only part of their team vault access.",
				);

				let member_session = app.issue_session(&fixture.member_user_id).await;
				let member_rotation = app
					.api_json(Method::GET, &format!("/api/v1/teams/{}/members/{}/removal-rotation-data", fixture.team_id, fixture.remove_target_user_id), None, authenticated_json_headers(&member_session.token))
					.await;
				member_rotation.assert_contract_status();
				assert_handler_error(
					&member_rotation.body,
					"FORBIDDEN",
					"Only owner or admin can perform key rotation",
				);

				let missing_target = app
					.api_json(Method::DELETE, &format!("/api/v1/teams/{}/members/{}", fixture.team_id, "missing-user"), Some(json!({


							"vaultRotations": []
						})), owner_headers.clone())
					.await;
				missing_target.assert_contract_status();
				assert_handler_error(
					&missing_target.body,
					"NOT_FOUND",
					"Team member not found",
				);

				let self_remove = app
					.api_json(Method::DELETE, &format!("/api/v1/teams/{}/members/{}", fixture.team_id, fixture.owner_user_id), Some(json!({


							"vaultRotations": []
						})), owner_headers.clone())
					.await;
				self_remove.assert_contract_status();
				assert_handler_error(
					&self_remove.body,
					"BAD_REQUEST",
					"You cannot remove yourself from the team",
				);

				let removed_session = app.issue_session(&fixture.remove_target_user_id).await;
				let remove_response = app
					.api_json(Method::DELETE, &format!("/api/v1/teams/{}/members/{}", fixture.team_id, fixture.remove_target_user_id), Some(json!({


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
						})), owner_headers)
					.await;
				remove_response.assert_contract_status();
				assert_eq!(remove_response.body["success"], json!(true));
				assert_eq!(
					remove_response.body["vaultRotations"]
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

			},
		)
		.await;
}
