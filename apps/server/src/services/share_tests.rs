use axum::http::{header::CONTENT_TYPE, HeaderMap, HeaderValue, Method, StatusCode};
use serde_json::{json, Value};
use sqlx::{query, query_as, query_scalar, FromRow};

use super::*;
use crate::config::Config;
use crate::db::enums::{ShareLinkAccessMode, ShareLinkStatus};
use crate::error::AppErrorCode;
use crate::services::auth_email::emailed_code_capture;
use crate::test_support::{
    acquire_env_lock_async, assign_user_to_team, authenticated_json_headers, seed_item, seed_team,
    seed_user, seed_vault, seed_vault_key, with_api_test_app, EnvVarGuard,
};

struct ShareActorFixture {
    user_id: String,
    item_id: String,
}

struct ShareRouterFixture {
    owner_user_id: String,
    admin_user_id: String,
    member_user_id: String,
    read_only_user_id: String,
    outsider_user_id: String,
    item_id: String,
    owner_link_id: String,
    email_link_id: String,
    email_link_token: String,
    member_link_id: String,
    read_only_link_id: String,
    one_time_link_id: String,
    one_time_token: String,
    revoked_token: String,
    allowed_email_id: String,
    allowed_email: String,
    request_email: String,
    verification_code: String,
}

const FIXTURE_ENCRYPTED_ITEM_DATA: &str = "fixture-encrypted-item-data";
const FIXTURE_ENCRYPTION_IV: &str = "fixture-item-iv";
const FIXTURE_ENCRYPTED_SHARE_KEY: &str = "fixture-encrypted-share-key";
const FIXTURE_SHARE_KEY_IV: &str = "fixture-share-key-iv";

fn sample_create_share_input() -> CreateShareLinkInput {
    CreateShareLinkInput {
        item_id: "item_123".to_string(),
        access_mode: ShareLinkAccessMode::Anyone,
        is_one_time_use: false,
        expires_in: "1day".to_string(),
        allowed_emails: None,
        encrypted_item_data: "encrypted-item-data".to_string(),
        encryption_iv: "item-iv".to_string(),
        encrypted_share_key: "encrypted-share-key".to_string(),
        share_key_iv: "share-key-iv".to_string(),
    }
}

fn sample_share_link_row() -> DbShareLinkRow {
    let now = time::OffsetDateTime::now_utc();
    DbShareLinkRow {
        id: "share_link_123".to_string(),
        item_id: "item_123".to_string(),
        created_by_id: "user_123".to_string(),
        status: ShareLinkStatus::Active,
        access_mode: ShareLinkAccessMode::Anyone,
        is_one_time_use: false,
        access_count: 0,
        max_access_count: None,
        expires_at: now + time::Duration::days(1),
        created_at: now,
        last_accessed_at: None,
        vault_id: "vault_123".to_string(),
    }
}

#[derive(FromRow)]
struct ShareLinkTestRow {
    id: String,
    created_by_id: String,
    access_mode: String,
    is_one_time_use: bool,
    max_access_count: Option<i32>,
}

#[derive(FromRow)]
struct ShareLinkStateRow {
    status: String,
    access_count: i32,
    max_access_count: Option<i32>,
    is_one_time_use: bool,
    last_accessed_at: Option<time::OffsetDateTime>,
}

#[derive(FromRow)]
struct ShareAllowedEmailStateRow {
    email: String,
    verified: bool,
    verified_at: Option<time::OffsetDateTime>,
}

#[derive(FromRow)]
struct ShareVerificationStateRow {
    attempts: i32,
    used_at: Option<time::OffsetDateTime>,
}

#[test]
fn validate_create_share_input_accepts_anyone_and_rejects_invalid_email_restrictions() {
    assert!(validate_create_share_input(&sample_create_share_input()).is_ok());

    let mut missing_allowed_emails = sample_create_share_input();
    missing_allowed_emails.access_mode = ShareLinkAccessMode::EmailRestricted;
    let error = validate_create_share_input(&missing_allowed_emails)
        .expect_err("email-restricted shares should require allowed emails");
    assert_eq!(error.code, AppErrorCode::BadRequest);
    assert_eq!(
        error.message,
        "At least one email address is required for email-restricted sharing"
    );

    let mut invalid_email_input = sample_create_share_input();
    invalid_email_input.access_mode = ShareLinkAccessMode::EmailRestricted;
    invalid_email_input.allowed_emails = Some(vec!["not-an-email".to_string()]);
    let error = validate_create_share_input(&invalid_email_input)
        .expect_err("invalid email addresses should be rejected");
    assert_eq!(error.code, AppErrorCode::BadRequest);
    assert_eq!(error.message, "Invalid email format: not-an-email");
}

#[test]
fn calculate_expiration_supports_known_values_and_rejects_unknown_values() {
    let before = time::OffsetDateTime::now_utc();
    let expires_at =
        calculate_expiration("1day").expect("known expiration options should be accepted");
    let after = time::OffsetDateTime::now_utc();

    assert!(expires_at >= before + time::Duration::days(1));
    assert!(expires_at <= after + time::Duration::days(1));

    let error =
        calculate_expiration("2weeks").expect_err("unknown expiration options should be rejected");
    assert_eq!(error.code, AppErrorCode::BadRequest);
    assert_eq!(error.message, "Invalid expiration option");
}

#[test]
fn validate_public_token_requires_expected_length_and_charset() {
    assert!(validate_public_token("AbCdEf1234567890AbCdEf1234567890").is_ok());

    let short_error = validate_public_token("short").expect_err("short tokens should be rejected");
    assert_eq!(short_error.code, AppErrorCode::NotFound);
    assert_eq!(short_error.message, "Share link not found or invalid");

    let invalid_char_error = validate_public_token("AbCdEf1234567890AbCdEf123456789!")
        .expect_err("tokens with invalid characters should be rejected");
    assert_eq!(invalid_char_error.code, AppErrorCode::NotFound);
    assert_eq!(
        invalid_char_error.message,
        "Share link not found or invalid"
    );
}

/// The share token is the entire secret half of a share URL, so its entropy is
/// the only thing standing between a guesser and a link: 32 characters drawn from
/// a 62-symbol alphabet is ~190 bits. Shrinking either the length or the alphabet
/// silently weakens every link, so both are pinned here.
#[test]
fn generate_secure_token_yields_distinct_32_character_tokens() {
    const ALPHABET: &str = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

    let token = generate_secure_token();
    assert_eq!(token.len(), 32);
    assert!(
        token.chars().all(|ch| ALPHABET.contains(ch)),
        "token {token} contains characters outside the expected alphabet",
    );
    // Whatever it generates must also survive the inbound validator.
    assert!(validate_public_token(&token).is_ok());

    assert_ne!(
        token,
        generate_secure_token(),
        "two tokens should never collide",
    );
}

#[test]
fn effective_share_link_status_reports_expired_and_exhausted_states() {
    let now = time::OffsetDateTime::now_utc();

    let mut expired_link = sample_share_link_row();
    expired_link.expires_at = now - time::Duration::minutes(1);
    assert_eq!(
        effective_share_link_status(&expired_link, now),
        ShareLinkStatus::Expired
    );

    let mut exhausted_link = sample_share_link_row();
    exhausted_link.max_access_count = Some(1);
    exhausted_link.access_count = 1;
    assert_eq!(
        effective_share_link_status(&exhausted_link, now),
        ShareLinkStatus::Exhausted
    );

    let revoked_link = DbShareLinkRow {
        status: ShareLinkStatus::Revoked,
        ..sample_share_link_row()
    };
    assert_eq!(
        effective_share_link_status(&revoked_link, now),
        ShareLinkStatus::Revoked
    );
}

#[test]
fn base_share_url_uses_startup_config_and_production_fallback() {
    let mut configured = Config::for_test().server;
    configured.web_app_url = Some("https://app.example.com/".to_string());
    assert_eq!(
        base_share_url(&configured),
        "https://app.example.com/share/"
    );

    configured.web_app_url = None;
    assert_eq!(
        base_share_url(&configured),
        "https://app.bittery.com/share/"
    );
}

fn share_token(fill: char) -> String {
    std::iter::repeat_n(fill, 32).collect()
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

fn assert_handler_error(body: &Value, code: &str, message: &str) {
    assert_eq!(body["code"], json!(code));
    assert_eq!(body["detail"], json!(message));
}

fn assert_transport_error(body: &Value, code: &str, message: &str) {
    assert_eq!(body["detail"], json!(message));
    assert_eq!(body["code"], json!(code));
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
        "unexpected invalid params message: {body}",
    );
}

#[tokio::test]
async fn protected_share_handlers_require_authentication() {
    with_api_test_app("share_handlers_require_authentication", |app| async move {
        let fixture = build_share_router_fixture(&app.pool).await;

        let protected_calls = vec![
            (
                Method::POST,
                format!("/api/v1/items/{}/share-links", fixture.item_id),
                Some(json!({
                    "accessMode": "anyone",
                    "isOneTimeUse": false,
                    "expiresIn": "1day",
                    "allowedEmails": null,
                    "encryptedItemData": FIXTURE_ENCRYPTED_ITEM_DATA,
                    "encryptionIv": FIXTURE_ENCRYPTION_IV,
                    "encryptedShareKey": FIXTURE_ENCRYPTED_SHARE_KEY,
                    "shareKeyIv": FIXTURE_SHARE_KEY_IV
                })),
            ),
            (
                Method::GET,
                format!("/api/v1/items/{}/share-links", fixture.item_id),
                None,
            ),
            (
                Method::DELETE,
                format!("/api/v1/share-links/{}", fixture.owner_link_id),
                None,
            ),
            (
                Method::GET,
                format!("/api/v1/share-links/{}/access-logs", fixture.owner_link_id),
                None,
            ),
        ];

        for (method, path, payload) in protected_calls {
            let response = app
                .api_json(method, &path, payload, unauthenticated_json_headers())
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
async fn share_handlers_reject_malformed_params() {
    with_api_test_app("share_handlers_reject_malformed_params", |app| async move {
        let fixture = build_share_router_fixture(&app.pool).await;
        let session = app.issue_session(&fixture.owner_user_id).await;
        let headers = authenticated_json_headers(&session.token);
        let response = app
            .api_json(
                Method::POST,
                &format!("/api/v1/items/{}/share-links", fixture.item_id),
                Some(json!({ "accessMode": "anyone" })),
                headers,
            )
            .await;
        response.assert_contract_status();
        assert_invalid_params_error(&response.body);
    })
    .await;
}

#[tokio::test]
async fn create_share_via_api_rejects_read_only_users() {
    with_api_test_app("share_create_read_only_forbidden", |app| async move {
        let fixture = build_share_router_fixture(&app.pool).await;
        let session = app.issue_session(&fixture.read_only_user_id).await;

        let response = app
            .api_json(
                Method::POST,
                &format!("/api/v1/items/{}/share-links", fixture.item_id),
                Some(json!({

                    "accessMode": "anyone",
                    "isOneTimeUse": false,
                    "expiresIn": "1day",
                    "allowedEmails": null,
                    "encryptedItemData": FIXTURE_ENCRYPTED_ITEM_DATA,
                    "encryptionIv": FIXTURE_ENCRYPTION_IV,
                    "encryptedShareKey": FIXTURE_ENCRYPTED_SHARE_KEY,
                    "shareKeyIv": FIXTURE_SHARE_KEY_IV
                })),
                authenticated_json_headers(&session.token),
            )
            .await;

        response.assert_contract_status();
        assert_handler_error(
            &response.body,
            "FORBIDDEN",
            "Read-only users cannot share items",
        );

        let share_link_count = query_scalar::<_, i64>(
            "SELECT COUNT(*)::bigint FROM share_link WHERE created_by_id = $1",
        )
        .bind(&fixture.read_only_user_id)
        .fetch_one(&app.pool)
        .await
        .expect("read-only share link count should load");

        assert_eq!(share_link_count, 1);
    })
    .await;
}

#[tokio::test]
async fn list_by_item_returns_visible_links_for_owners_and_members() {
    with_api_test_app("share_list_by_item_visibility", |app| async move {
        let fixture = build_share_router_fixture(&app.pool).await;
        let owner_session = app.issue_session(&fixture.owner_user_id).await;
        let member_session = app.issue_session(&fixture.member_user_id).await;

        let owner_response = app
            .api_json(
                Method::GET,
                &format!("/api/v1/items/{}/share-links", fixture.item_id.clone()),
                None,
                authenticated_json_headers(&owner_session.token),
            )
            .await;
        owner_response.assert_contract_status();
        let owner_links = owner_response.body["links"]
            .as_array()
            .expect("owner links should be an array");
        let owner_link_ids = owner_links
            .iter()
            .map(|link| link["id"].as_str().expect("link id should be present"))
            .collect::<Vec<_>>();
        assert_eq!(owner_links.len(), 6);
        for expected_id in [
            fixture.owner_link_id.as_str(),
            fixture.email_link_id.as_str(),
            fixture.member_link_id.as_str(),
            fixture.read_only_link_id.as_str(),
            fixture.one_time_link_id.as_str(),
        ] {
            assert!(owner_link_ids.contains(&expected_id));
        }

        let member_response = app
            .api_json(
                Method::GET,
                &format!("/api/v1/items/{}/share-links", fixture.item_id),
                None,
                authenticated_json_headers(&member_session.token),
            )
            .await;
        member_response.assert_contract_status();
        let member_links = member_response.body["links"]
            .as_array()
            .expect("member links should be an array");
        assert_eq!(member_links.len(), 1);
        assert_eq!(
            member_links[0]["id"],
            json!(fixture.member_link_id),
            "members should only see links they created",
        );
    })
    .await;
}

#[tokio::test]
async fn list_by_item_returns_not_found_for_inaccessible_items() {
    with_api_test_app("share_list_by_item_not_found", |app| async move {
        let fixture = build_share_router_fixture(&app.pool).await;
        let outsider_session = app.issue_session(&fixture.outsider_user_id).await;

        let response = app
            .api_json(
                Method::GET,
                &format!("/api/v1/items/{}/share-links", fixture.item_id),
                None,
                authenticated_json_headers(&outsider_session.token),
            )
            .await;

        response.assert_contract_status();
        assert_handler_error(&response.body, "NOT_FOUND", "Item not found");
    })
    .await;
}

#[tokio::test]
async fn revoke_share_link_enforces_role_rules_and_updates_status() {
    with_api_test_app("share_revoke_paths", |app| async move {
        let fixture = build_share_router_fixture(&app.pool).await;
        let admin_session = app.issue_session(&fixture.admin_user_id).await;
        let member_session = app.issue_session(&fixture.member_user_id).await;
        let outsider_session = app.issue_session(&fixture.outsider_user_id).await;

        let forbidden_response = app
            .api_json(
                Method::DELETE,
                &format!("/api/v1/share-links/{}", fixture.owner_link_id.clone()),
                None,
                authenticated_json_headers(&admin_session.token),
            )
            .await;
        forbidden_response.assert_contract_status();
        assert_handler_error(
            &forbidden_response.body,
            "FORBIDDEN",
            "You do not have permission to revoke this link",
        );

        let success_response = app
            .api_json(
                Method::DELETE,
                &format!("/api/v1/share-links/{}", fixture.member_link_id.clone()),
                None,
                authenticated_json_headers(&member_session.token),
            )
            .await;
        success_response.assert_contract_status();
        assert_eq!(success_response.body["success"], json!(true));

        let status = query_scalar::<_, String>(
            "SELECT status::text AS status FROM share_link WHERE id = $1",
        )
        .bind(&fixture.member_link_id)
        .fetch_one(&app.pool)
        .await
        .expect("revoked share link status should load");
        assert_eq!(status, "revoked");

        let hidden_response = app
            .api_json(
                Method::DELETE,
                &format!("/api/v1/share-links/{}", fixture.owner_link_id),
                None,
                authenticated_json_headers(&outsider_session.token),
            )
            .await;
        hidden_response.assert_contract_status();
        assert_handler_error(&hidden_response.body, "NOT_FOUND", "Share link not found");
    })
    .await;
}

#[tokio::test]
async fn get_access_logs_returns_entries_and_not_found_for_hidden_links() {
    with_api_test_app("share_access_logs_paths", |app| async move {
        let fixture = build_share_router_fixture(&app.pool).await;
        let owner_session = app.issue_session(&fixture.owner_user_id).await;
        let member_session = app.issue_session(&fixture.member_user_id).await;

        let success_response = app
            .api_json(
                Method::GET,
                &format!(
                    "/api/v1/share-links/{}/access-logs?limit=1",
                    fixture.owner_link_id.clone()
                ),
                None,
                authenticated_json_headers(&owner_session.token),
            )
            .await;
        success_response.assert_contract_status();
        let logs = success_response
            .body
            .get("items")
            .and_then(serde_json::Value::as_array)
            .expect("share access log page should contain items");
        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0]["accessedByEmail"], json!("viewer@example.com"));
        assert_eq!(logs[0]["success"], json!(true));
        assert_eq!(success_response.body["hasMore"], json!(true));
        let cursor = success_response.body["nextCursor"]
            .as_str()
            .expect("first access log page should have a cursor");

        let second_response = app
            .api_json(
                Method::GET,
                &format!(
                    "/api/v1/share-links/{}/access-logs?limit=1&cursor={cursor}",
                    fixture.owner_link_id
                ),
                None,
                authenticated_json_headers(&owner_session.token),
            )
            .await;
        second_response.assert_contract_status();
        let second_logs = second_response.body["items"]
            .as_array()
            .expect("second access log page should contain items");
        assert_eq!(second_logs.len(), 1);
        assert_eq!(second_logs[0]["failureReason"], json!("Invalid code"));
        assert_eq!(second_response.body["hasMore"], json!(false));

        let hidden_response = app
            .api_json(
                Method::GET,
                &format!("/api/v1/share-links/{}/access-logs", fixture.owner_link_id),
                None,
                authenticated_json_headers(&member_session.token),
            )
            .await;
        hidden_response.assert_contract_status();
        assert_handler_error(&hidden_response.body, "NOT_FOUND", "Share link not found");
    })
    .await;
}

#[tokio::test]
async fn get_public_info_returns_valid_and_invalid_states() {
    with_api_test_app("share_public_info_paths", |app| async move {
        let fixture = build_share_router_fixture(&app.pool).await;

        let valid_response = app
            .api_json(
                Method::GET,
                &format!(
                    "/api/v1/public/share-links/{}",
                    fixture.one_time_token.clone()
                ),
                None,
                unauthenticated_json_headers(),
            )
            .await;
        valid_response.assert_contract_status();
        assert_eq!(valid_response.body["valid"], json!(true));
        assert_eq!(valid_response.body["accessMode"], json!("anyone"));
        assert_eq!(valid_response.body["isOneTimeUse"], json!(true));
        assert!(valid_response.body["expiresAt"].is_string());

        let revoked_response = app
            .api_json(
                Method::GET,
                &format!(
                    "/api/v1/public/share-links/{}",
                    fixture.revoked_token.clone()
                ),
                None,
                unauthenticated_json_headers(),
            )
            .await;
        revoked_response.assert_contract_status();
        assert_eq!(revoked_response.body["valid"], json!(false));
        assert_eq!(revoked_response.body["reason"], json!("revoked"));
        assert_eq!(revoked_response.body["isOneTimeUse"], Value::Null);

        let missing_response = app
            .api_json(
                Method::GET,
                &format!("/api/v1/public/share-links/{}", share_token('9')),
                None,
                unauthenticated_json_headers(),
            )
            .await;
        missing_response.assert_contract_status();
        assert_handler_error(
            &missing_response.body,
            "NOT_FOUND",
            "Share link not found or invalid",
        );
    })
    .await;
}

#[tokio::test]
async fn access_public_returns_payload_and_exhausts_one_time_links() {
    with_api_test_app("share_access_public_one_time", |app| async move {
			let fixture = build_share_router_fixture(&app.pool).await;

			let success_response = app
				.api_json(Method::POST, &format!("/api/v1/public/share-links/{}/accesses", fixture.one_time_token.clone()), None, unauthenticated_json_headers())
				.await;
			success_response.assert_contract_status();
			assert_eq!(
				success_response.body["encryptedItemData"],
				json!(FIXTURE_ENCRYPTED_ITEM_DATA),
			);
			assert_eq!(
				success_response.body["encryptedShareKey"],
				json!(FIXTURE_ENCRYPTED_SHARE_KEY),
			);

			let link_state = query_as::<_, ShareLinkStateRow>(
				"SELECT status::text AS status, access_count, max_access_count, is_one_time_use, last_accessed_at FROM share_link WHERE id = $1 LIMIT 1",
			)
			.bind(&fixture.one_time_link_id)
			.fetch_one(&app.pool)
			.await
			.expect("one-time share link state should load");
			assert_eq!(link_state.status, "exhausted");
			assert_eq!(link_state.access_count, 1);
			assert_eq!(link_state.max_access_count, Some(1));
			assert!(link_state.is_one_time_use);
			assert!(link_state.last_accessed_at.is_some());

			let exhausted_response = app
				.api_json(Method::POST, &format!("/api/v1/public/share-links/{}/accesses", fixture.one_time_token.clone()), None, unauthenticated_json_headers())
				.await;
			exhausted_response.assert_contract_status();
			assert_handler_error(
				&exhausted_response.body,
				"BAD_REQUEST",
				"This share link has been exhausted",
			);

			let access_log_count = query_scalar::<_, i64>(
				"SELECT COUNT(*)::bigint FROM share_access_log WHERE share_link_id = $1",
			)
			.bind(&fixture.one_time_link_id)
			.fetch_one(&app.pool)
			.await
			.expect("share access log count should load");
			assert_eq!(access_log_count, 2);
		})
		.await;
}

#[tokio::test]
async fn access_public_rejects_non_public_and_revoked_links() {
    with_api_test_app("share_access_public_rejections", |app| async move {
        let fixture = build_share_router_fixture(&app.pool).await;

        let email_restricted_response = app
            .api_json(
                Method::POST,
                &format!(
                    "/api/v1/public/share-links/{}/accesses",
                    fixture.email_link_token.clone()
                ),
                None,
                unauthenticated_json_headers(),
            )
            .await;
        email_restricted_response.assert_contract_status();
        assert_handler_error(
            &email_restricted_response.body,
            "NOT_FOUND",
            "Share link not found",
        );

        let revoked_response = app
            .api_json(
                Method::POST,
                &format!(
                    "/api/v1/public/share-links/{}/accesses",
                    fixture.revoked_token
                ),
                None,
                unauthenticated_json_headers(),
            )
            .await;
        revoked_response.assert_contract_status();
        assert_handler_error(
            &revoked_response.body,
            "BAD_REQUEST",
            "This share link has been revoked",
        );
    })
    .await;
}

#[tokio::test]
async fn request_email_verification_persists_codes_for_allowed_emails_and_rejects_invalid_access() {
    let _env_lock = acquire_env_lock_async().await;
    let _env = EnvVarGuard::set(&[
        ("BITTERY_ENABLE_DEV_AUTH_STUBS", "true"),
        ("NODE_ENV", "development"),
        ("BITTERY_DEV_MAIL_OUTBOX", ""),
    ]);

    with_api_test_app("share_request_email_verification_paths", |app| async move {
        let fixture = build_share_router_fixture(&app.pool).await;

        let success_response = app
            .api_json(
                Method::POST,
                &format!(
                    "/api/v1/public/share-links/{}/email-verifications",
                    fixture.email_link_token.clone()
                ),
                Some(json!({

                    "email": fixture.request_email.clone()
                })),
                unauthenticated_json_headers(),
            )
            .await;
        success_response.assert_contract_status();
        assert_eq!(success_response.body["success"], json!(true));
        assert_eq!(
            success_response.body["message"],
            json!("Verification code sent to your email"),
        );

        let verification_count = query_scalar::<_, i64>(
				"SELECT COUNT(*)::bigint FROM share_email_verification WHERE share_link_id = $1 AND email = $2",
			)
			.bind(&fixture.email_link_id)
			.bind(&fixture.request_email)
			.fetch_one(&app.pool)
			.await
			.expect("verification count should load");
        assert_eq!(verification_count, 1);

        let forbidden_response = app
            .api_json(
                Method::POST,
                &format!(
                    "/api/v1/public/share-links/{}/email-verifications",
                    fixture.email_link_token.clone()
                ),
                Some(json!({

                    "email": "intruder@example.com"
                })),
                unauthenticated_json_headers(),
            )
            .await;
        forbidden_response.assert_contract_status();
        assert_handler_error(
            &forbidden_response.body,
            "FORBIDDEN",
            "This email is not authorized to access this link",
        );

        let not_found_response = app
            .api_json(
                Method::POST,
                &format!(
                    "/api/v1/public/share-links/{}/email-verifications",
                    fixture.one_time_token
                ),
                Some(json!({

                    "email": fixture.request_email
                })),
                unauthenticated_json_headers(),
            )
            .await;
        not_found_response.assert_contract_status();
        assert_handler_error(
            &not_found_response.body,
            "NOT_FOUND",
            "Share link not found",
        );
    })
    .await;
}

/// An email-restricted link is only usable if the recipient actually receives the
/// code: issuing one and dropping it made the whole access mode a dead end.
#[tokio::test]
async fn request_email_verification_delivers_a_code_the_recipient_can_use() {
    let _env_lock = acquire_env_lock_async().await;
    let _env = EnvVarGuard::set(&[
        ("BITTERY_ENABLE_DEV_AUTH_STUBS", "true"),
        ("NODE_ENV", "development"),
        ("BITTERY_DEV_MAIL_OUTBOX", ""),
    ]);

    with_api_test_app(
        "share_request_email_verification_delivers",
        |app| async move {
            let fixture = build_share_router_fixture(&app.pool).await;

            let requested = app
                .api_json(
                    Method::POST,
                    &format!(
                        "/api/v1/public/share-links/{}/email-verifications",
                        fixture.email_link_token.clone()
                    ),
                    Some(json!({

                        "email": fixture.request_email.clone()
                    })),
                    unauthenticated_json_headers(),
                )
                .await;
            requested.assert_contract_status();
            assert_eq!(requested.body["success"], json!(true));

            let verification_id = query_scalar::<_, String>(
                "SELECT id FROM share_email_verification WHERE share_link_id = $1 AND email = $2 ORDER BY created_at DESC LIMIT 1",
            )
            .bind(&fixture.email_link_id)
            .bind(&fixture.request_email)
            .fetch_one(&app.pool)
            .await
            .expect("share email verification row should exist in this test database");
            let code = emailed_code_capture::latest(&verification_id)
                .expect("share email verification code should have been emailed");

            let accessed = app
                .api_json(
                    Method::POST,
                    &format!(
                        "/api/v1/public/share-links/{}/email-accesses",
                        fixture.email_link_token.clone()
                    ),
                    Some(json!({

                        "email": fixture.request_email.clone(),
                        "code": code
                    })),
                    unauthenticated_json_headers(),
                )
                .await;
            accessed.assert_contract_status();
            assert_eq!(
                accessed.body["encryptedItemData"],
                json!(FIXTURE_ENCRYPTED_ITEM_DATA),
            );
        },
    )
    .await;
}

/// A database read must not hand out a working code: `code_hash` holds the
/// digest, and the digest itself is not replayable as a code.
#[tokio::test]
async fn share_email_verification_code_is_stored_hashed_and_still_verifies() {
    let _env_lock = acquire_env_lock_async().await;
    let _env = EnvVarGuard::set(&[
        ("BITTERY_ENABLE_DEV_AUTH_STUBS", "true"),
        ("NODE_ENV", "development"),
        ("BITTERY_DEV_MAIL_OUTBOX", ""),
    ]);

    with_api_test_app("share_verification_code_hashed", |app| async move {
        let fixture = build_share_router_fixture(&app.pool).await;

        // The seeded code: the column holds its digest, not the code.
        let seeded = query_scalar::<_, String>(
			"SELECT code_hash FROM share_email_verification WHERE share_link_id = $1 AND email = $2 LIMIT 1",
		)
		.bind(&fixture.email_link_id)
		.bind(&fixture.allowed_email)
		.fetch_one(&app.pool)
		.await
		.expect("seeded verification row should load");
        assert_ne!(seeded, fixture.verification_code);
        assert_eq!(seeded, hash_token(&fixture.verification_code));
        assert_eq!(seeded.len(), 64);

        // A server-generated code is persisted the same way.
        let requested = app
            .api_json(Method::POST, &format!("/api/v1/public/share-links/{}/email-verifications", fixture.email_link_token.clone()), Some(json!({

                    "email": fixture.request_email.clone()
                })), unauthenticated_json_headers())
            .await;
        assert_eq!(requested.body["success"], json!(true));
        let generated = query_scalar::<_, String>(
			"SELECT code_hash FROM share_email_verification WHERE share_link_id = $1 AND email = $2 ORDER BY created_at DESC LIMIT 1",
		)
		.bind(&fixture.email_link_id)
		.bind(&fixture.request_email)
		.fetch_one(&app.pool)
		.await
		.expect("generated verification row should load");
        assert_eq!(generated.len(), 64);
        assert!(generated.chars().all(|ch| ch.is_ascii_hexdigit()));

        // Replaying the stored digest as the code is rejected.
        let replayed = app
            .api_json(Method::POST, &format!("/api/v1/public/share-links/{}/email-accesses", fixture.email_link_token.clone()), Some(json!({

                    "email": fixture.allowed_email.clone(),
                    "code": seeded
                })), unauthenticated_json_headers())
            .await;
        assert_handler_error(
            &replayed.body,
            "BAD_REQUEST",
            "Invalid or expired verification code",
        );

        // A wrong 6-digit code is still rejected.
        let wrong = app
            .api_json(Method::POST, &format!("/api/v1/public/share-links/{}/email-accesses", fixture.email_link_token.clone()), Some(json!({

                    "email": fixture.allowed_email.clone(),
                    "code": "000000"
                })), unauthenticated_json_headers())
            .await;
        assert_handler_error(
            &wrong.body,
            "BAD_REQUEST",
            "Invalid or expired verification code",
        );

        // The raw code still resolves the hashed row.
        let verified = app
            .api_json(Method::POST, &format!("/api/v1/public/share-links/{}/email-accesses", fixture.email_link_token.clone()), Some(json!({

                    "email": fixture.allowed_email.clone(),
                    "code": fixture.verification_code.clone()
                })), unauthenticated_json_headers())
            .await;
        assert_eq!(
            verified.body["encryptedItemData"],
            json!(FIXTURE_ENCRYPTED_ITEM_DATA),
        );
    })
    .await;
}

fn sample_create_share_params() -> Value {
    json!({
        "accessMode": "anyone",
        "isOneTimeUse": false,
        "expiresIn": "1day",
        "allowedEmails": null,
        "encryptedItemData": FIXTURE_ENCRYPTED_ITEM_DATA,
        "encryptionIv": FIXTURE_ENCRYPTION_IV,
        "encryptedShareKey": FIXTURE_ENCRYPTED_SHARE_KEY,
        "shareKeyIv": FIXTURE_SHARE_KEY_IV
    })
}

/// Finding 5d: `share_link.token_hash` must never hold the share token. Both a
/// seeded link and a freshly created one are persisted as a digest, and the raw
/// token a caller holds still resolves end to end through the public API routes.
#[tokio::test]
async fn share_link_token_is_stored_hashed_and_still_resolves() {
    with_api_test_app("share_link_token_hashed", |app| async move {
        let fixture = build_share_router_fixture(&app.pool).await;

        // The seeded link: the column holds its digest, not the token.
        let seeded =
            query_scalar::<_, String>("SELECT token_hash FROM share_link WHERE id = $1 LIMIT 1")
                .bind(&fixture.one_time_link_id)
                .fetch_one(&app.pool)
                .await
                .expect("seeded share link should load");
        assert_ne!(seeded, fixture.one_time_token);
        assert_eq!(seeded, hash_token(&fixture.one_time_token));
        assert_eq!(seeded.len(), 64);

        // A server-generated token is persisted the same way.
        let session = app.issue_session(&fixture.owner_user_id).await;
        let created = app
            .api_json(
                Method::POST,
                &format!("/api/v1/items/{}/share-links", fixture.item_id),
                Some(sample_create_share_params()),
                authenticated_json_headers(&session.token),
            )
            .await;
        created.assert_contract_status();
        let created_link_id = created.body["id"]
            .as_str()
            .expect("create should return a link id")
            .to_string();
        let created_token = created.body["token"]
            .as_str()
            .expect("create should return the raw token exactly once")
            .to_string();
        assert_eq!(created_token.len(), 32);

        let stored =
            query_scalar::<_, String>("SELECT token_hash FROM share_link WHERE id = $1 LIMIT 1")
                .bind(&created_link_id)
                .fetch_one(&app.pool)
                .await
                .expect("created share link should load");
        assert_ne!(stored, created_token);
        assert_eq!(stored, hash_token(&created_token));
        assert_eq!(stored.len(), 64);
        assert!(stored.chars().all(|ch| ch.is_ascii_hexdigit()));

        // The raw token still resolves the hashed row, end to end.
        let info = app
            .api_json(
                Method::GET,
                &format!("/api/v1/public/share-links/{}", created_token.clone()),
                None,
                unauthenticated_json_headers(),
            )
            .await;
        info.assert_contract_status();
        assert_eq!(info.body["valid"], json!(true));
        assert_eq!(info.body["accessMode"], json!("anyone"));

        let accessed = app
            .api_json(
                Method::POST,
                &format!(
                    "/api/v1/public/share-links/{}/accesses",
                    created_token.clone()
                ),
                None,
                unauthenticated_json_headers(),
            )
            .await;
        accessed.assert_contract_status();
        assert_eq!(
            accessed.body["encryptedItemData"],
            json!(FIXTURE_ENCRYPTED_ITEM_DATA),
        );
    })
    .await;
}

/// A database reader who lifts `token_hash` must not be able to use it: the digest
/// is not itself a valid token, on any public entry point.
#[tokio::test]
async fn share_link_token_hash_cannot_be_replayed_as_a_token() {
    with_api_test_app("share_link_token_hash_replay", |app| async move {
        let fixture = build_share_router_fixture(&app.pool).await;

        let stored =
            query_scalar::<_, String>("SELECT token_hash FROM share_link WHERE id = $1 LIMIT 1")
                .bind(&fixture.owner_link_id)
                .fetch_one(&app.pool)
                .await
                .expect("seeded share link should load");
        assert_eq!(stored.len(), 64);

        for (method, suffix) in [(Method::GET, ""), (Method::POST, "/accesses")] {
            let response = app
                .api_json(
                    method,
                    &format!("/api/v1/public/share-links/{stored}{suffix}"),
                    None,
                    unauthenticated_json_headers(),
                )
                .await;
            response.assert_contract_status();
            assert_handler_error(
                &response.body,
                "NOT_FOUND",
                "Share link not found or invalid",
            );
        }

        let email_stored =
            query_scalar::<_, String>("SELECT token_hash FROM share_link WHERE id = $1 LIMIT 1")
                .bind(&fixture.email_link_id)
                .fetch_one(&app.pool)
                .await
                .expect("seeded email-restricted share link should load");
        let requested = app
            .api_json(
                Method::POST,
                &format!(
                    "/api/v1/public/share-links/{}/email-verifications",
                    email_stored
                ),
                Some(json!({

                    "email": fixture.allowed_email.clone()
                })),
                unauthenticated_json_headers(),
            )
            .await;
        assert_handler_error(
            &requested.body,
            "NOT_FOUND",
            "Share link not found or invalid",
        );
    })
    .await;
}

/// The owner-facing read paths must not hand the token back: the server only holds
/// a digest, and a token without its URL fragment is a dead link anyway.
#[tokio::test]
async fn list_by_item_and_get_do_not_expose_share_tokens() {
    with_api_test_app("share_list_and_get_hide_tokens", |app| async move {
        let fixture = build_share_router_fixture(&app.pool).await;
        let session = app.issue_session(&fixture.owner_user_id).await;

        let listed = app
            .api_json(
                Method::GET,
                &format!("/api/v1/items/{}/share-links", fixture.item_id.clone()),
                None,
                authenticated_json_headers(&session.token),
            )
            .await;
        listed.assert_contract_status();
        let links = listed.body["links"]
            .as_array()
            .expect("links should be an array");
        assert!(!links.is_empty());
        for link in links {
            assert!(
                link["token"].is_null(),
                "the item share-link list must not expose a token: {link}",
            );
        }
    })
    .await;
}

/// The create response is the single legitimate disclosure of the raw token. It is
/// copy-once: nothing afterwards can return it.
#[tokio::test]
async fn create_share_returns_token_exactly_once() {
    with_api_test_app("share_create_token_once", |app| async move {
        let fixture = build_share_router_fixture(&app.pool).await;
        let session = app.issue_session(&fixture.owner_user_id).await;

        let created = app
            .api_json(
                Method::POST,
                &format!("/api/v1/items/{}/share-links", fixture.item_id),
                Some(sample_create_share_params()),
                authenticated_json_headers(&session.token),
            )
            .await;
        created.assert_contract_status();
        let created_link_id = created.body["id"]
            .as_str()
            .expect("create should return a link id")
            .to_string();
        let created_token = created.body["token"]
            .as_str()
            .expect("create should return the raw token")
            .to_string();
        assert_eq!(created_token.len(), 32);

        let stored_token_hash: String =
            query_scalar("SELECT token_hash FROM share_link WHERE id = $1")
                .bind(created_link_id)
                .fetch_one(&app.pool)
                .await
                .expect("created share token hash should load");
        assert_ne!(stored_token_hash, created_token);
    })
    .await;
}

#[tokio::test]
async fn verify_email_and_access_returns_payload_and_marks_email_verified() {
    with_api_test_app("share_verify_email_success", |app| async move {
			let fixture = build_share_router_fixture(&app.pool).await;

			let response = app
				.api_json(Method::POST, &format!("/api/v1/public/share-links/{}/email-accesses", fixture.email_link_token.clone()), Some(json!({

						"email": fixture.allowed_email.clone(),
						"code": fixture.verification_code.clone()
					})), unauthenticated_json_headers())
				.await;

			response.assert_contract_status();
			assert_eq!(
				response.body["encryptedItemData"],
				json!(FIXTURE_ENCRYPTED_ITEM_DATA),
			);
			assert_eq!(
				response.body["shareKeyIv"],
				json!(FIXTURE_SHARE_KEY_IV),
			);

			let allowed_email_state = query_as::<_, ShareAllowedEmailStateRow>(
				"SELECT email, verified, verified_at FROM share_link_allowed_email WHERE id = $1 LIMIT 1",
			)
			.bind(&fixture.allowed_email_id)
			.fetch_one(&app.pool)
			.await
			.expect("allowed email state should load");
			assert_eq!(allowed_email_state.email, fixture.allowed_email);
			assert!(allowed_email_state.verified);
			assert!(allowed_email_state.verified_at.is_some());

			let verification_state = query_as::<_, ShareVerificationStateRow>(
				"SELECT attempts, used_at FROM share_email_verification WHERE share_link_id = $1 AND email = $2 LIMIT 1",
			)
			.bind(&fixture.email_link_id)
			.bind(&allowed_email_state.email)
			.fetch_one(&app.pool)
			.await
			.expect("verification state should load");
			assert_eq!(verification_state.attempts, 0);
			assert!(verification_state.used_at.is_some());

			let link_state = query_as::<_, ShareLinkStateRow>(
				"SELECT status::text AS status, access_count, max_access_count, is_one_time_use, last_accessed_at FROM share_link WHERE id = $1 LIMIT 1",
			)
			.bind(&fixture.email_link_id)
			.fetch_one(&app.pool)
			.await
			.expect("email-restricted link state should load");
			assert_eq!(link_state.status, "active");
			assert_eq!(link_state.access_count, 1);
		})
		.await;
}

#[tokio::test]
async fn verify_email_and_access_rejects_invalid_codes_and_increments_attempts() {
    with_api_test_app("share_verify_email_invalid_code", |app| async move {
			let fixture = build_share_router_fixture(&app.pool).await;

			let response = app
				.api_json(Method::POST, &format!("/api/v1/public/share-links/{}/email-accesses", fixture.email_link_token.clone()), Some(json!({

						"email": fixture.allowed_email.clone(),
						"code": "000000"
					})), unauthenticated_json_headers())
				.await;

			response.assert_contract_status();
			assert_handler_error(
				&response.body,
				"BAD_REQUEST",
				"Invalid or expired verification code",
			);

			let verification_state = query_as::<_, ShareVerificationStateRow>(
				"SELECT attempts, used_at FROM share_email_verification WHERE share_link_id = $1 AND email = $2 LIMIT 1",
			)
			.bind(&fixture.email_link_id)
			.bind(&fixture.allowed_email)
			.fetch_one(&app.pool)
			.await
			.expect("verification attempts should load");
			assert_eq!(verification_state.attempts, 1);
			assert!(verification_state.used_at.is_none());
		})
		.await;
}

#[tokio::test]
async fn share_email_verification_lockout_burns_pending_code() {
    let _env_lock = acquire_env_lock_async().await;
    let _env = EnvVarGuard::set(&[
        ("RATE_LIMIT_SHARE_EMAIL_VERIFY_MAX", "2"),
        ("RATE_LIMIT_SHARE_EMAIL_VERIFY_LOCK_MINUTES", "15"),
    ]);

    with_api_test_app("share_email_verification_lockout", |app| async move {
        let fixture = build_share_router_fixture(&app.pool).await;

        let wrong = || async {
            app.api_json(Method::POST, &format!("/api/v1/public/share-links/{}/email-accesses", fixture.email_link_token.clone()), Some(json!({

                    "email": fixture.allowed_email.clone(),
                    "code": "000000"
                })), unauthenticated_json_headers())
            .await
        };

        let first = wrong().await;
        assert_handler_error(
            &first.body,
            "BAD_REQUEST",
            "Invalid or expired verification code",
        );

        let locked = wrong().await;
        assert_handler_error(
            &locked.body,
            "RATE_LIMITED",
            crate::services::rate_limit::RATE_LIMITED_MESSAGE,
        );

        let state = query_as::<_, ShareVerificationStateRow>(
            "SELECT attempts, used_at FROM share_email_verification WHERE share_link_id = $1 AND email = $2 LIMIT 1",
        )
        .bind(&fixture.email_link_id)
        .bind(&fixture.allowed_email)
        .fetch_one(&app.pool)
        .await
        .expect("share verification state should load");
        assert_eq!(state.attempts, 2);
        assert!(state.used_at.is_some());

        let correct = app
            .api_json(Method::POST, &format!("/api/v1/public/share-links/{}/email-accesses", fixture.email_link_token), Some(json!({

                    "email": fixture.allowed_email,
                    "code": fixture.verification_code
                })), unauthenticated_json_headers())
            .await;
        assert_handler_error(
            &correct.body,
            "RATE_LIMITED",
            crate::services::rate_limit::RATE_LIMITED_MESSAGE,
        );
    })
    .await;
}

#[tokio::test]
async fn create_share_via_api_persists_link_and_allowed_emails() {
    with_api_test_app("share_create_happy_path", |app| async move {
			let fixture = build_share_actor_fixture(&app.pool).await;
			let session = app.issue_session(&fixture.user_id).await;
			let expected_base_share_url = format!(
				"{}/share/",
				std::env::var("WEB_APP_URL")
					.ok()
					.filter(|value| !value.trim().is_empty())
					.unwrap_or_else(|| "https://app.bittery.com".to_string())
					.trim_end_matches('/'),
			);

			let response = app
				.api_json(Method::POST, &format!("/api/v1/items/{}/share-links", fixture.item_id), Some(json!({

						"accessMode": "email-restricted",
						"isOneTimeUse": true,
						"expiresIn": "1day",
						"allowedEmails": ["bob@example.com", "alice@example.com"],
						"encryptedItemData": "encrypted-item-data",
						"encryptionIv": "item-iv",
						"encryptedShareKey": "encrypted-share-key",
						"shareKeyIv": "share-key-iv"
					})), authenticated_json_headers(&session.token))
				.await;

			response.assert_contract_status();
			assert_eq!(response.body["baseShareUrl"], json!(expected_base_share_url));

			let link_id = response.body["id"]
				.as_str()
				.expect("share link id should be present");

			let stored_link = query_as::<_, ShareLinkTestRow>(
				"SELECT id, created_by_id, access_mode::text AS access_mode, is_one_time_use, max_access_count FROM share_link WHERE id = $1 LIMIT 1",
			)
			.bind(link_id)
			.fetch_one(&app.pool)
			.await
			.expect("share link should be stored");

			assert_eq!(stored_link.id, link_id);
			assert_eq!(stored_link.created_by_id, fixture.user_id);
			assert_eq!(stored_link.access_mode, "email-restricted");
			assert!(stored_link.is_one_time_use);
			assert_eq!(stored_link.max_access_count, Some(1));

			let allowed_emails = query_scalar::<_, String>(
				"SELECT email FROM share_link_allowed_email WHERE share_link_id = $1 ORDER BY email ASC",
			)
			.bind(link_id)
			.fetch_all(&app.pool)
			.await
			.expect("allowed emails should be stored");

			assert_eq!(allowed_emails, vec!["alice@example.com", "bob@example.com"]);
		})
		.await;
}

#[tokio::test]
async fn create_share_rejects_idempotency_keys_before_disclosing_a_secret() {
    with_api_test_app("share_create_rejects_idempotency", |app| async move {
        let fixture = build_share_actor_fixture(&app.pool).await;
        let session = app.issue_session(&fixture.user_id).await;
        let mut headers = authenticated_json_headers(&session.token);
        headers.insert(
            "idempotency-key",
            HeaderValue::from_static("share-secret-key"),
        );

        let response = app
            .api_json(
                Method::POST,
                &format!("/api/v1/items/{}/share-links", fixture.item_id),
                Some(json!({

                    "accessMode": "anyone",
                    "isOneTimeUse": true,
                    "expiresIn": "1day",
                    "encryptedItemData": "encrypted-item-data",
                    "encryptionIv": "item-iv",
                    "encryptedShareKey": "encrypted-share-key",
                    "shareKeyIv": "share-key-iv"
                })),
                headers,
            )
            .await;

        assert_eq!(response.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_handler_error(
            &response.body,
            "IDEMPOTENCY_NOT_ALLOWED",
            "Idempotency keys are not accepted for operations that return one-time secrets.",
        );
        let created: i64 = query_scalar(
            "SELECT COUNT(*)::bigint FROM share_link WHERE item_id = $1 AND created_by_id = $2",
        )
        .bind(&fixture.item_id)
        .bind(&fixture.user_id)
        .fetch_one(&app.pool)
        .await
        .expect("share link count should load");
        assert_eq!(created, 0);
    })
    .await;
}

#[tokio::test]
async fn create_share_via_api_rejects_invalid_access_mode() {
    with_api_test_app("share_create_invalid_access_mode", |app| async move {
        let fixture = build_share_actor_fixture(&app.pool).await;
        let session = app.issue_session(&fixture.user_id).await;

        let response = app
            .api_json(
                Method::POST,
                &format!("/api/v1/items/{}/share-links", fixture.item_id),
                Some(json!({

                    "accessMode": "invalid-mode",
                    "isOneTimeUse": false,
                    "expiresIn": "1day",
                    "allowedEmails": null,
                    "encryptedItemData": "encrypted-item-data",
                    "encryptionIv": "item-iv",
                    "encryptedShareKey": "encrypted-share-key",
                    "shareKeyIv": "share-key-iv"
                })),
                authenticated_json_headers(&session.token),
            )
            .await;

        response.assert_contract_status();
        assert_eq!(response.body["code"], json!("INVALID_REQUEST"));

        let share_link_count = query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM share_link")
            .fetch_one(&app.pool)
            .await
            .expect("share link count should load");

        assert_eq!(share_link_count, 0);
    })
    .await;
}

#[tokio::test]
async fn api_content_type_rejects_non_json_share_requests() {
    with_api_test_app("share_api_content_type_non_json", |app| async move {
        let fixture = build_share_router_fixture(&app.pool).await;
        let session = app.issue_session(&fixture.owner_user_id).await;
        let mut headers = authenticated_json_headers(&session.token);
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("text/plain"));

        let response = app
            .api_bytes(
                axum::http::Method::POST,
                &format!("/api/v1/items/{}/share-links", fixture.item_id),
                b"not-json".to_vec(),
                headers,
            )
            .await;

        assert_eq!(response.status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
        assert_eq!(response.body["code"], json!("UNSUPPORTED_MEDIA_TYPE"));
    })
    .await;
}

async fn build_share_actor_fixture(pool: &PgPool) -> ShareActorFixture {
    let user_id = "user_share_owner".to_string();
    let team_id = "team_share_owner".to_string();
    let vault_id = "vault_share_owner".to_string();
    let item_id = "item_share_owner".to_string();

    seed_user(pool, &user_id, "Share Owner", "owner@example.com").await;
    seed_team(
        pool,
        &team_id,
        "Personal Team",
        &user_id,
        "personal",
        "personal",
        "active",
    )
    .await;
    assign_user_to_team(pool, &user_id, &team_id, "owner").await;
    seed_vault(
        pool,
        &vault_id,
        "Personal Vault",
        "personal",
        &user_id,
        Some(&team_id),
    )
    .await;
    seed_vault_key(
        pool,
        "vault_key_share_owner",
        &vault_id,
        &user_id,
        "encrypted-vault-key",
        "owner",
    )
    .await;
    seed_item(
        pool,
        &item_id,
        &vault_id,
        "login",
        "encrypted-item",
        "item-iv",
        &user_id,
    )
    .await;

    ShareActorFixture { user_id, item_id }
}

async fn build_share_router_fixture(pool: &PgPool) -> ShareRouterFixture {
    let owner_user_id = "share_owner_user".to_string();
    let admin_user_id = "share_admin_user".to_string();
    let member_user_id = "share_member_user".to_string();
    let read_only_user_id = "share_read_only_user".to_string();
    let outsider_user_id = "share_outsider_user".to_string();
    let team_id = "share_team_main".to_string();
    let vault_id = "share_vault_main".to_string();
    let item_id = "share_item_main".to_string();

    seed_user(
        pool,
        &owner_user_id,
        "Share Owner",
        "share-owner@example.com",
    )
    .await;
    seed_user(
        pool,
        &admin_user_id,
        "Share Admin",
        "share-admin@example.com",
    )
    .await;
    seed_user(
        pool,
        &member_user_id,
        "Share Member",
        "share-member@example.com",
    )
    .await;
    seed_user(
        pool,
        &read_only_user_id,
        "Share Read Only",
        "share-read-only@example.com",
    )
    .await;
    seed_user(
        pool,
        &outsider_user_id,
        "Share Outsider",
        "share-outsider@example.com",
    )
    .await;

    seed_team(
        pool,
        &team_id,
        "Share Team",
        &owner_user_id,
        "organization",
        "team",
        "active",
    )
    .await;
    assign_user_to_team(pool, &owner_user_id, &team_id, "owner").await;
    assign_user_to_team(pool, &admin_user_id, &team_id, "admin").await;
    assign_user_to_team(pool, &member_user_id, &team_id, "member").await;
    assign_user_to_team(pool, &read_only_user_id, &team_id, "member").await;
    assign_user_to_team(pool, &outsider_user_id, &team_id, "member").await;

    seed_vault(
        pool,
        &vault_id,
        "Share Vault",
        "team",
        &owner_user_id,
        Some(&team_id),
    )
    .await;
    seed_vault_key(
        pool,
        "share_vault_key_owner",
        &vault_id,
        &owner_user_id,
        "encrypted-vault-key-owner",
        "owner",
    )
    .await;
    seed_vault_key(
        pool,
        "share_vault_key_admin",
        &vault_id,
        &admin_user_id,
        "encrypted-vault-key-admin",
        "admin",
    )
    .await;
    seed_vault_key(
        pool,
        "share_vault_key_member",
        &vault_id,
        &member_user_id,
        "encrypted-vault-key-member",
        "member",
    )
    .await;
    seed_vault_key(
        pool,
        "share_vault_key_read_only",
        &vault_id,
        &read_only_user_id,
        "encrypted-vault-key-read-only",
        "read-only",
    )
    .await;

    seed_item(
        pool,
        &item_id,
        &vault_id,
        "login",
        "encrypted-item",
        "item-iv",
        &owner_user_id,
    )
    .await;

    let owner_link_id = "share_link_owner".to_string();
    let owner_token = share_token('1');
    let email_link_id = "share_link_email".to_string();
    let email_link_token = share_token('2');
    let member_link_id = "share_link_member".to_string();
    let member_token = share_token('3');
    let read_only_link_id = "share_link_read_only".to_string();
    let read_only_token = share_token('4');
    let one_time_link_id = "share_link_one_time".to_string();
    let one_time_token = share_token('5');
    let revoked_link_id = "share_link_revoked".to_string();
    let revoked_token = share_token('6');
    let now = time::OffsetDateTime::now_utc();

    seed_share_link(
        pool,
        &owner_link_id,
        &item_id,
        &owner_user_id,
        &owner_token,
        "anyone",
        "active",
        false,
        0,
        None,
        now + time::Duration::days(2),
    )
    .await;
    seed_share_link(
        pool,
        &email_link_id,
        &item_id,
        &owner_user_id,
        &email_link_token,
        "email-restricted",
        "active",
        false,
        0,
        None,
        now + time::Duration::days(2),
    )
    .await;
    seed_share_link(
        pool,
        &member_link_id,
        &item_id,
        &member_user_id,
        &member_token,
        "anyone",
        "active",
        false,
        0,
        None,
        now + time::Duration::days(2),
    )
    .await;
    seed_share_link(
        pool,
        &read_only_link_id,
        &item_id,
        &read_only_user_id,
        &read_only_token,
        "anyone",
        "active",
        false,
        0,
        None,
        now + time::Duration::days(2),
    )
    .await;
    seed_share_link(
        pool,
        &one_time_link_id,
        &item_id,
        &owner_user_id,
        &one_time_token,
        "anyone",
        "active",
        true,
        0,
        Some(1),
        now + time::Duration::days(2),
    )
    .await;
    seed_share_link(
        pool,
        &revoked_link_id,
        &item_id,
        &owner_user_id,
        &revoked_token,
        "anyone",
        "revoked",
        false,
        0,
        None,
        now + time::Duration::days(2),
    )
    .await;

    let allowed_email_id = "share_allowed_email_primary".to_string();
    let allowed_email = "allowed@example.com".to_string();
    let removable_email_id = "share_allowed_email_removable".to_string();
    let removable_email = "remove@example.com".to_string();
    let request_email = "request@example.com".to_string();
    let verification_code = "123456".to_string();

    seed_share_allowed_email(
        pool,
        &allowed_email_id,
        &email_link_id,
        &allowed_email,
        false,
        None,
    )
    .await;
    seed_share_allowed_email(
        pool,
        &removable_email_id,
        &email_link_id,
        &removable_email,
        false,
        None,
    )
    .await;
    seed_share_allowed_email(
        pool,
        "share_allowed_email_request",
        &email_link_id,
        &request_email,
        false,
        None,
    )
    .await;

    seed_share_access_log(
        pool,
        "share_access_log_success",
        &owner_link_id,
        Some("viewer@example.com"),
        true,
        None,
        now - time::Duration::minutes(1),
    )
    .await;
    seed_share_access_log(
        pool,
        "share_access_log_failure",
        &owner_link_id,
        Some("blocked@example.com"),
        false,
        Some("Invalid code"),
        now - time::Duration::minutes(2),
    )
    .await;

    seed_share_email_verification(
        pool,
        "share_verification_primary",
        &email_link_id,
        &allowed_email,
        &verification_code,
        0,
        5,
        now + time::Duration::minutes(15),
        now - time::Duration::minutes(2),
        None,
    )
    .await;
    seed_share_email_verification(
        pool,
        "share_verification_removable",
        &email_link_id,
        &removable_email,
        "654321",
        0,
        5,
        now + time::Duration::minutes(15),
        now - time::Duration::minutes(3),
        None,
    )
    .await;

    ShareRouterFixture {
        owner_user_id,
        admin_user_id,
        member_user_id,
        read_only_user_id,
        outsider_user_id,
        item_id,
        owner_link_id,
        email_link_id,
        email_link_token,
        member_link_id,
        read_only_link_id,
        one_time_link_id,
        one_time_token,
        revoked_token,
        allowed_email_id,
        allowed_email,
        request_email,
        verification_code,
    }
}

/// `token` is the plaintext the tests hand to the public API routes; only its digest is
/// stored, exactly as `share.create` writes it.
#[allow(clippy::too_many_arguments)]
async fn seed_share_link(
    pool: &PgPool,
    id: &str,
    item_id: &str,
    created_by_id: &str,
    token: &str,
    access_mode: &str,
    status: &str,
    is_one_time_use: bool,
    access_count: i32,
    max_access_count: Option<i32>,
    expires_at: time::OffsetDateTime,
) {
    query(
			"INSERT INTO share_link (id, item_id, created_by_id, token_hash, status, access_mode, is_one_time_use, encrypted_item_data, encryption_iv, encrypted_share_key, share_key_iv, access_count, max_access_count, expires_at) VALUES ($1, $2, $3, $4, $5::share_link_status, $6::share_link_access_mode, $7, $8, $9, $10, $11, $12, $13, $14)",
		)
		.bind(id)
		.bind(item_id)
		.bind(created_by_id)
		.bind(hash_token(token))
		.bind(status)
		.bind(access_mode)
		.bind(is_one_time_use)
		.bind(FIXTURE_ENCRYPTED_ITEM_DATA)
		.bind(FIXTURE_ENCRYPTION_IV)
		.bind(FIXTURE_ENCRYPTED_SHARE_KEY)
		.bind(FIXTURE_SHARE_KEY_IV)
		.bind(access_count)
		.bind(max_access_count)
		.bind(expires_at)
		.execute(pool)
		.await
		.expect("share link should seed");
}

async fn seed_share_allowed_email(
    pool: &PgPool,
    id: &str,
    share_link_id: &str,
    email: &str,
    verified: bool,
    verified_at: Option<time::OffsetDateTime>,
) {
    query(
			"INSERT INTO share_link_allowed_email (id, share_link_id, email, verified, verified_at) VALUES ($1, $2, $3, $4, $5)",
		)
		.bind(id)
		.bind(share_link_id)
		.bind(email)
		.bind(verified)
		.bind(verified_at)
		.execute(pool)
		.await
		.expect("share allowed email should seed");
}

async fn seed_share_access_log(
    pool: &PgPool,
    id: &str,
    share_link_id: &str,
    accessed_by_email: Option<&str>,
    success: bool,
    failure_reason: Option<&str>,
    accessed_at: time::OffsetDateTime,
) {
    query(
			"INSERT INTO share_access_log (id, share_link_id, accessed_by_email, ip_address, user_agent, success, failure_reason, accessed_at) VALUES ($1, $2, $3, NULL, NULL, $4, $5, $6)",
		)
		.bind(id)
		.bind(share_link_id)
		.bind(accessed_by_email)
		.bind(success)
		.bind(failure_reason)
		.bind(accessed_at)
		.execute(pool)
		.await
		.expect("share access log should seed");
}

#[allow(clippy::too_many_arguments)]
async fn seed_share_email_verification(
    pool: &PgPool,
    id: &str,
    share_link_id: &str,
    email: &str,
    code: &str,
    attempts: i32,
    max_attempts: i32,
    expires_at: time::OffsetDateTime,
    created_at: time::OffsetDateTime,
    used_at: Option<time::OffsetDateTime>,
) {
    query(
			"INSERT INTO share_email_verification (id, share_link_id, email, code_hash, attempts, max_attempts, expires_at, created_at, used_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
		)
		.bind(id)
		.bind(share_link_id)
		.bind(email)
		.bind(hash_token(code))
		.bind(attempts)
		.bind(max_attempts)
		.bind(expires_at)
		.bind(created_at)
		.bind(used_at)
		.execute(pool)
		.await
		.expect("share email verification should seed");
}

#[tokio::test]
async fn create_share_via_api_is_daily_rate_limited() {
    let _guard = crate::test_support::acquire_env_lock_async().await;
    let _env = crate::test_support::EnvVarGuard::set(&[("SHARE_LINK_DAILY_LIMIT", "2")]);

    with_api_test_app("share_create_daily_rate_limit", |app| async move {
        let fixture = build_share_router_fixture(&app.pool).await;
        let session = app.issue_session(&fixture.owner_user_id).await;
        let headers = authenticated_json_headers(&session.token);

        let params = json!({
            "accessMode": "anyone",
            "isOneTimeUse": false,
            "expiresIn": "1day",
            "allowedEmails": null,
            "encryptedItemData": FIXTURE_ENCRYPTED_ITEM_DATA,
            "encryptionIv": FIXTURE_ENCRYPTION_IV,
            "encryptedShareKey": FIXTURE_ENCRYPTED_SHARE_KEY,
            "shareKeyIv": FIXTURE_SHARE_KEY_IV
        });

        for _ in 0..2 {
            let response = app
                .api_json(
                    Method::POST,
                    &format!("/api/v1/items/{}/share-links", fixture.item_id),
                    Some(params.clone()),
                    headers.clone(),
                )
                .await;
            response.assert_contract_status();
            assert!(response.body.is_object());
        }

        let blocked = app
            .api_json(
                Method::POST,
                &format!("/api/v1/items/{}/share-links", fixture.item_id),
                Some(params.clone()),
                headers.clone(),
            )
            .await;
        blocked.assert_contract_status();
        assert_handler_error(
            &blocked.body,
            "RATE_LIMITED",
            "Daily share link limit reached",
        );
    })
    .await;
}
