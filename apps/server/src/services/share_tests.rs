use axum::http::{header::CONTENT_TYPE, HeaderMap, HeaderValue, StatusCode};
use serde_json::{json, Value};
use sqlx::{query, query_as, query_scalar, FromRow};

use super::*;
use crate::error::AppErrorCode;
use crate::test_support::{
    acquire_env_lock, assign_user_to_team, authenticated_json_headers, seed_item, seed_team,
    seed_user, seed_vault, seed_vault_key, with_rpc_test_app,
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
    removable_email_id: String,
    removable_email: String,
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
        access_mode: "anyone".to_string(),
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
        token: "sharetoken1234567890ABCDEFGH1234".to_string(),
        status: "active".to_string(),
        access_mode: "anyone".to_string(),
        is_one_time_use: false,
        access_count: 0,
        max_access_count: None,
        expires_at: now + time::Duration::days(1),
        created_at: now,
        last_accessed_at: None,
        vault_id: "vault_123".to_string(),
    }
}

fn set_env_var(name: &str, value: Option<&str>) {
    match value {
        Some(value) => unsafe { std::env::set_var(name, value) },
        None => unsafe { std::env::remove_var(name) },
    }
}

fn restore_env_var(name: &str, previous: Option<String>) {
    match previous.as_deref() {
        Some(value) => unsafe { std::env::set_var(name, value) },
        None => unsafe { std::env::remove_var(name) },
    }
}

fn with_env_vars<T>(
    bittery_mode_value: Option<&str>,
    web_app_url_value: Option<&str>,
    share_link_daily_limit_value: Option<&str>,
    test_fn: impl FnOnce() -> T,
) -> T {
    let _guard = acquire_env_lock();
    let previous_mode = std::env::var("BITTERY_MODE").ok();
    let previous_web_app_url = std::env::var("WEB_APP_URL").ok();
    let previous_share_link_daily_limit = std::env::var("SHARE_LINK_DAILY_LIMIT").ok();

    set_env_var("BITTERY_MODE", bittery_mode_value);
    set_env_var("WEB_APP_URL", web_app_url_value);
    set_env_var("SHARE_LINK_DAILY_LIMIT", share_link_daily_limit_value);

    let result = test_fn();

    restore_env_var("BITTERY_MODE", previous_mode);
    restore_env_var("WEB_APP_URL", previous_web_app_url);
    restore_env_var("SHARE_LINK_DAILY_LIMIT", previous_share_link_daily_limit);

    result
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
    missing_allowed_emails.access_mode = "email-restricted".to_string();
    let error = validate_create_share_input(&missing_allowed_emails)
        .expect_err("email-restricted shares should require allowed emails");
    assert_eq!(error.code, AppErrorCode::BadRequest);
    assert_eq!(
        error.message,
        "At least one email address is required for email-restricted sharing"
    );

    let mut invalid_email_input = sample_create_share_input();
    invalid_email_input.access_mode = "email-restricted".to_string();
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

#[test]
fn unique_email_ids_preserves_order_and_rejects_duplicates() {
    let unique_ids = unique_email_ids(&[
        "email_1".to_string(),
        "email_2".to_string(),
        "email_3".to_string(),
    ])
    .expect("unique ids should be accepted");
    assert_eq!(
        unique_ids,
        vec![
            "email_1".to_string(),
            "email_2".to_string(),
            "email_3".to_string(),
        ]
    );

    let error = unique_email_ids(&["email_1".to_string(), "email_1".to_string()])
        .expect_err("duplicate ids should be rejected");
    assert_eq!(error.code, AppErrorCode::BadRequest);
    assert_eq!(error.message, "Duplicate removeEmailIds are not allowed");
}

#[test]
fn effective_share_link_status_reports_expired_and_exhausted_states() {
    let now = time::OffsetDateTime::now_utc();

    let mut expired_link = sample_share_link_row();
    expired_link.expires_at = now - time::Duration::minutes(1);
    assert_eq!(effective_share_link_status(&expired_link, now), "expired");

    let mut exhausted_link = sample_share_link_row();
    exhausted_link.max_access_count = Some(1);
    exhausted_link.access_count = 1;
    assert_eq!(
        effective_share_link_status(&exhausted_link, now),
        "exhausted"
    );

    let revoked_link = DbShareLinkRow {
        status: "revoked".to_string(),
        ..sample_share_link_row()
    };
    assert_eq!(effective_share_link_status(&revoked_link, now), "revoked");
}

#[test]
fn base_share_url_uses_trimmed_env_value_and_default_fallback() {
    with_env_vars(None, Some(" https://app.example.com/ "), None, || {
        assert_eq!(base_share_url(), "https://app.example.com/share/");
    });

    with_env_vars(None, Some("   "), None, || {
        assert_eq!(base_share_url(), "https://app.bittery.com/share/");
    });
}

#[test]
fn bittery_mode_normalizes_self_hosted_aliases_and_defaults_to_cloud() {
    with_env_vars(Some("self_hosted"), None, None, || {
        assert_eq!(bittery_mode(), "self-hosted");
    });

    with_env_vars(Some("SELFHOSTED"), None, None, || {
        assert_eq!(bittery_mode(), "self-hosted");
    });

    with_env_vars(Some("cloud"), None, None, || {
        assert_eq!(bittery_mode(), "cloud");
    });

    with_env_vars(None, None, None, || {
        assert_eq!(bittery_mode(), "cloud");
    });
}

#[test]
fn share_link_daily_limit_uses_positive_env_value_or_default() {
    with_env_vars(None, None, Some("75"), || {
        assert_eq!(share_link_daily_limit(), 75);
    });

    with_env_vars(None, None, Some("0"), || {
        assert_eq!(share_link_daily_limit(), DEFAULT_SHARE_LINK_DAILY_LIMIT);
    });

    with_env_vars(None, None, Some("not-a-number"), || {
        assert_eq!(share_link_daily_limit(), DEFAULT_SHARE_LINK_DAILY_LIMIT);
    });
}

fn share_token(fill: char) -> String {
    std::iter::repeat_n(fill, 32).collect()
}

fn unauthenticated_json_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert("x-app-platform", HeaderValue::from_static("desktop"));
    headers.insert("x-client-id", HeaderValue::from_static("integration-test"));
    headers
}

fn assert_handler_error(body: &Value, code: &str, message: &str) {
    assert_eq!(body["jsonrpc"], json!("2.0"));
    assert_eq!(body["result"]["Err"]["code"], json!(code));
    assert_eq!(body["result"]["Err"]["message"], json!(message));
}

fn assert_rpc_error(body: &Value, code: &str, message: &str) {
    assert_eq!(body["jsonrpc"], json!("2.0"));
    assert_eq!(body["error"]["message"], json!(message));
    assert_eq!(body["error"]["data"]["code"], json!(code));
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
        "unexpected invalid params message: {body}",
    );
}

#[tokio::test]
async fn protected_share_handlers_require_authentication() {
    with_rpc_test_app("share_handlers_require_authentication", |app| async move {
        let fixture = build_share_router_fixture(&app.pool).await;

        let protected_calls = vec![
            (
                "share.create",
                json!([{
                    "itemId": fixture.item_id.clone(),
                    "accessMode": "anyone",
                    "isOneTimeUse": false,
                    "expiresIn": "1day",
                    "allowedEmails": null,
                    "encryptedItemData": FIXTURE_ENCRYPTED_ITEM_DATA,
                    "encryptionIv": FIXTURE_ENCRYPTION_IV,
                    "encryptedShareKey": FIXTURE_ENCRYPTED_SHARE_KEY,
                    "shareKeyIv": FIXTURE_SHARE_KEY_IV
                }]),
            ),
            (
                "share.listByItem",
                json!([{ "itemId": fixture.item_id.clone() }]),
            ),
            (
                "share.get",
                json!([{ "linkId": fixture.owner_link_id.clone() }]),
            ),
            (
                "share.revoke",
                json!([{ "linkId": fixture.owner_link_id.clone() }]),
            ),
            (
                "share.update",
                json!([{ "linkId": fixture.email_link_id.clone() }]),
            ),
            (
                "share.getAccessLogs",
                json!([{ "linkId": fixture.owner_link_id.clone() }]),
            ),
        ];

        for (method, params) in protected_calls {
            let response = app
                .rpc_call(method, params, unauthenticated_json_headers())
                .await;
            assert_eq!(
                response.status,
                StatusCode::OK,
                "unexpected status for {method}"
            );
            assert_rpc_error(&response.body, "UNAUTHORIZED", "Authentication required");
        }
    })
    .await;
}

#[tokio::test]
async fn share_handlers_reject_malformed_params() {
    with_rpc_test_app("share_handlers_reject_malformed_params", |app| async move {
        let fixture = build_share_router_fixture(&app.pool).await;
        let session = app.issue_session(&fixture.owner_user_id).await;
        let headers = authenticated_json_headers(&session.token);
        let malformed_calls = vec![
            "share.create",
            "share.listByItem",
            "share.get",
            "share.revoke",
            "share.update",
            "share.getAccessLogs",
            "share.getPublicInfo",
            "share.requestEmailVerification",
            "share.verifyEmailAndAccess",
            "share.accessPublic",
        ];

        for method in malformed_calls {
            let response = app.rpc_call(method, json!([{}]), headers.clone()).await;
            assert_eq!(
                response.status,
                StatusCode::OK,
                "unexpected status for {method}"
            );
            assert_invalid_params_error(&response.body);
        }
    })
    .await;
}

#[tokio::test]
async fn create_share_via_rpc_rejects_read_only_users() {
    with_rpc_test_app("share_create_read_only_forbidden", |app| async move {
        let fixture = build_share_router_fixture(&app.pool).await;
        let session = app.issue_session(&fixture.read_only_user_id).await;

        let response = app
            .rpc_call(
                "share.create",
                json!([{
                    "itemId": fixture.item_id,
                    "accessMode": "anyone",
                    "isOneTimeUse": false,
                    "expiresIn": "1day",
                    "allowedEmails": null,
                    "encryptedItemData": FIXTURE_ENCRYPTED_ITEM_DATA,
                    "encryptionIv": FIXTURE_ENCRYPTION_IV,
                    "encryptedShareKey": FIXTURE_ENCRYPTED_SHARE_KEY,
                    "shareKeyIv": FIXTURE_SHARE_KEY_IV
                }]),
                authenticated_json_headers(&session.token),
            )
            .await;

        assert_eq!(response.status, StatusCode::OK);
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
    with_rpc_test_app("share_list_by_item_visibility", |app| async move {
        let fixture = build_share_router_fixture(&app.pool).await;
        let owner_session = app.issue_session(&fixture.owner_user_id).await;
        let member_session = app.issue_session(&fixture.member_user_id).await;

        let owner_response = app
            .rpc_call(
                "share.listByItem",
                json!([{ "itemId": fixture.item_id.clone() }]),
                authenticated_json_headers(&owner_session.token),
            )
            .await;
        assert_eq!(owner_response.status, StatusCode::OK);
        let owner_links = owner_response.body["result"]["Ok"]["links"]
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
            .rpc_call(
                "share.listByItem",
                json!([{ "itemId": fixture.item_id }]),
                authenticated_json_headers(&member_session.token),
            )
            .await;
        assert_eq!(member_response.status, StatusCode::OK);
        let member_links = member_response.body["result"]["Ok"]["links"]
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
    with_rpc_test_app("share_list_by_item_not_found", |app| async move {
        let fixture = build_share_router_fixture(&app.pool).await;
        let outsider_session = app.issue_session(&fixture.outsider_user_id).await;

        let response = app
            .rpc_call(
                "share.listByItem",
                json!([{ "itemId": fixture.item_id }]),
                authenticated_json_headers(&outsider_session.token),
            )
            .await;

        assert_eq!(response.status, StatusCode::OK);
        assert_handler_error(&response.body, "NOT_FOUND", "Item not found");
    })
    .await;
}

#[tokio::test]
async fn get_share_link_returns_details_for_visible_links_and_not_found_for_hidden_links() {
    with_rpc_test_app("share_get_visibility", |app| async move {
        let fixture = build_share_router_fixture(&app.pool).await;
        let owner_session = app.issue_session(&fixture.owner_user_id).await;
        let member_session = app.issue_session(&fixture.member_user_id).await;

        let owner_response = app
            .rpc_call(
                "share.get",
                json!([{ "linkId": fixture.email_link_id.clone() }]),
                authenticated_json_headers(&owner_session.token),
            )
            .await;

        assert_eq!(owner_response.status, StatusCode::OK);
        assert_eq!(
            owner_response.body["result"]["Ok"]["id"],
            json!(fixture.email_link_id)
        );
        assert_eq!(
            owner_response.body["result"]["Ok"]["token"],
            json!(fixture.email_link_token)
        );
        assert_eq!(
            owner_response.body["result"]["Ok"]["accessMode"],
            json!("email-restricted")
        );
        let allowed_emails = owner_response.body["result"]["Ok"]["allowedEmails"]
            .as_array()
            .expect("allowed emails should be present");
        assert_eq!(allowed_emails.len(), 3);
        assert!(allowed_emails
            .iter()
            .any(|entry| entry["email"] == json!(fixture.allowed_email)));

        let hidden_response = app
            .rpc_call(
                "share.get",
                json!([{ "linkId": fixture.owner_link_id }]),
                authenticated_json_headers(&member_session.token),
            )
            .await;

        assert_eq!(hidden_response.status, StatusCode::OK);
        assert_handler_error(&hidden_response.body, "NOT_FOUND", "Share link not found");
    })
    .await;
}

#[tokio::test]
async fn revoke_share_link_enforces_role_rules_and_updates_status() {
    with_rpc_test_app("share_revoke_paths", |app| async move {
        let fixture = build_share_router_fixture(&app.pool).await;
        let admin_session = app.issue_session(&fixture.admin_user_id).await;
        let member_session = app.issue_session(&fixture.member_user_id).await;
        let outsider_session = app.issue_session(&fixture.outsider_user_id).await;

        let forbidden_response = app
            .rpc_call(
                "share.revoke",
                json!([{ "linkId": fixture.owner_link_id.clone() }]),
                authenticated_json_headers(&admin_session.token),
            )
            .await;
        assert_eq!(forbidden_response.status, StatusCode::OK);
        assert_handler_error(
            &forbidden_response.body,
            "FORBIDDEN",
            "You do not have permission to revoke this link",
        );

        let success_response = app
            .rpc_call(
                "share.revoke",
                json!([{ "linkId": fixture.member_link_id.clone() }]),
                authenticated_json_headers(&member_session.token),
            )
            .await;
        assert_eq!(success_response.status, StatusCode::OK);
        assert_eq!(
            success_response.body["result"]["Ok"]["success"],
            json!(true)
        );

        let status = query_scalar::<_, String>(
            "SELECT status::text AS status FROM share_link WHERE id = $1",
        )
        .bind(&fixture.member_link_id)
        .fetch_one(&app.pool)
        .await
        .expect("revoked share link status should load");
        assert_eq!(status, "revoked");

        let hidden_response = app
            .rpc_call(
                "share.revoke",
                json!([{ "linkId": fixture.owner_link_id }]),
                authenticated_json_headers(&outsider_session.token),
            )
            .await;
        assert_eq!(hidden_response.status, StatusCode::OK);
        assert_handler_error(&hidden_response.body, "NOT_FOUND", "Share link not found");
    })
    .await;
}

#[tokio::test]
async fn update_share_link_updates_access_and_email_membership() {
    with_rpc_test_app("share_update_success", |app| async move {
			let fixture = build_share_router_fixture(&app.pool).await;
			let owner_session = app.issue_session(&fixture.owner_user_id).await;
			let added_email = "added@example.com";

			let response = app
				.rpc_call(
					"share.update",
					json!([{
						"linkId": fixture.email_link_id.clone(),
						"isOneTimeUse": true,
						"addEmails": [added_email],
						"removeEmailIds": [fixture.removable_email_id.clone()]
					}]),
					authenticated_json_headers(&owner_session.token),
				)
				.await;

			assert_eq!(response.status, StatusCode::OK);
			assert_eq!(response.body["result"]["Ok"]["success"], json!(true));

			let link_state = query_as::<_, ShareLinkStateRow>(
				"SELECT status::text AS status, access_count, max_access_count, is_one_time_use, last_accessed_at FROM share_link WHERE id = $1 LIMIT 1",
			)
			.bind(&fixture.email_link_id)
			.fetch_one(&app.pool)
			.await
			.expect("updated share link state should load");
			assert_eq!(link_state.status, "active");
			assert!(link_state.is_one_time_use);
			assert_eq!(link_state.max_access_count, Some(1));

			let allowed_emails = query_scalar::<_, String>(
				"SELECT email FROM share_link_allowed_email WHERE share_link_id = $1 ORDER BY email ASC",
			)
			.bind(&fixture.email_link_id)
			.fetch_all(&app.pool)
			.await
			.expect("updated allowed emails should load");
			assert_eq!(
				allowed_emails,
				vec![
					added_email.to_string(),
					fixture.allowed_email.clone(),
					fixture.request_email.clone(),
				],
			);

			let removed_verification = query_as::<_, ShareVerificationStateRow>(
				"SELECT attempts, used_at FROM share_email_verification WHERE share_link_id = $1 AND email = $2 LIMIT 1",
			)
			.bind(&fixture.email_link_id)
			.bind(&fixture.removable_email)
			.fetch_one(&app.pool)
			.await
			.expect("removed verification should load");
			assert!(removed_verification.used_at.is_some());
		})
		.await;
}

#[tokio::test]
async fn update_share_link_rejects_read_only_actors_and_invalid_emails() {
    with_rpc_test_app("share_update_rejections", |app| async move {
        let fixture = build_share_router_fixture(&app.pool).await;
        let read_only_session = app.issue_session(&fixture.read_only_user_id).await;
        let owner_session = app.issue_session(&fixture.owner_user_id).await;

        let forbidden_response = app
            .rpc_call(
                "share.update",
                json!([{ "linkId": fixture.read_only_link_id.clone(), "isOneTimeUse": true }]),
                authenticated_json_headers(&read_only_session.token),
            )
            .await;
        assert_eq!(forbidden_response.status, StatusCode::OK);
        assert_handler_error(&forbidden_response.body, "FORBIDDEN", "Access denied");

        let invalid_email_response = app
            .rpc_call(
                "share.update",
                json!([{
                    "linkId": fixture.email_link_id.clone(),
                    "addEmails": ["not-an-email"]
                }]),
                authenticated_json_headers(&owner_session.token),
            )
            .await;
        assert_eq!(invalid_email_response.status, StatusCode::OK);
        assert_handler_error(
            &invalid_email_response.body,
            "BAD_REQUEST",
            "Invalid email format: not-an-email",
        );
    })
    .await;
}

#[tokio::test]
async fn get_access_logs_returns_entries_and_not_found_for_hidden_links() {
    with_rpc_test_app("share_access_logs_paths", |app| async move {
        let fixture = build_share_router_fixture(&app.pool).await;
        let owner_session = app.issue_session(&fixture.owner_user_id).await;
        let member_session = app.issue_session(&fixture.member_user_id).await;

        let success_response = app
            .rpc_call(
                "share.getAccessLogs",
                json!([{ "linkId": fixture.owner_link_id.clone() }]),
                authenticated_json_headers(&owner_session.token),
            )
            .await;
        assert_eq!(success_response.status, StatusCode::OK);
        let logs = success_response.body["result"]["Ok"]
            .as_array()
            .expect("share access logs should be an array");
        assert_eq!(logs.len(), 2);
        assert_eq!(logs[0]["accessedByEmail"], json!("viewer@example.com"));
        assert_eq!(logs[0]["success"], json!(true));
        assert_eq!(logs[1]["failureReason"], json!("Invalid code"));

        let hidden_response = app
            .rpc_call(
                "share.getAccessLogs",
                json!([{ "linkId": fixture.owner_link_id }]),
                authenticated_json_headers(&member_session.token),
            )
            .await;
        assert_eq!(hidden_response.status, StatusCode::OK);
        assert_handler_error(&hidden_response.body, "NOT_FOUND", "Share link not found");
    })
    .await;
}

#[tokio::test]
async fn get_public_info_returns_valid_and_invalid_states() {
    with_rpc_test_app("share_public_info_paths", |app| async move {
        let fixture = build_share_router_fixture(&app.pool).await;

        let valid_response = app
            .rpc_call(
                "share.getPublicInfo",
                json!([{ "token": fixture.one_time_token.clone() }]),
                unauthenticated_json_headers(),
            )
            .await;
        assert_eq!(valid_response.status, StatusCode::OK);
        assert_eq!(valid_response.body["result"]["Ok"]["valid"], json!(true));
        assert_eq!(
            valid_response.body["result"]["Ok"]["accessMode"],
            json!("anyone")
        );
        assert_eq!(
            valid_response.body["result"]["Ok"]["isOneTimeUse"],
            json!(true)
        );
        assert!(valid_response.body["result"]["Ok"]["expiresAt"].is_string());

        let revoked_response = app
            .rpc_call(
                "share.getPublicInfo",
                json!([{ "token": fixture.revoked_token.clone() }]),
                unauthenticated_json_headers(),
            )
            .await;
        assert_eq!(revoked_response.status, StatusCode::OK);
        assert_eq!(revoked_response.body["result"]["Ok"]["valid"], json!(false));
        assert_eq!(
            revoked_response.body["result"]["Ok"]["reason"],
            json!("revoked")
        );
        assert_eq!(
            revoked_response.body["result"]["Ok"]["isOneTimeUse"],
            Value::Null
        );

        let missing_response = app
            .rpc_call(
                "share.getPublicInfo",
                json!([{ "token": share_token('9') }]),
                unauthenticated_json_headers(),
            )
            .await;
        assert_eq!(missing_response.status, StatusCode::OK);
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
    with_rpc_test_app("share_access_public_one_time", |app| async move {
			let fixture = build_share_router_fixture(&app.pool).await;

			let success_response = app
				.rpc_call(
					"share.accessPublic",
					json!([{ "token": fixture.one_time_token.clone() }]),
					unauthenticated_json_headers(),
				)
				.await;
			assert_eq!(success_response.status, StatusCode::OK);
			assert_eq!(
				success_response.body["result"]["Ok"]["encryptedItemData"],
				json!(FIXTURE_ENCRYPTED_ITEM_DATA),
			);
			assert_eq!(
				success_response.body["result"]["Ok"]["encryptedShareKey"],
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
				.rpc_call(
					"share.accessPublic",
					json!([{ "token": fixture.one_time_token.clone() }]),
					unauthenticated_json_headers(),
				)
				.await;
			assert_eq!(exhausted_response.status, StatusCode::OK);
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
    with_rpc_test_app("share_access_public_rejections", |app| async move {
        let fixture = build_share_router_fixture(&app.pool).await;

        let email_restricted_response = app
            .rpc_call(
                "share.accessPublic",
                json!([{ "token": fixture.email_link_token.clone() }]),
                unauthenticated_json_headers(),
            )
            .await;
        assert_eq!(email_restricted_response.status, StatusCode::OK);
        assert_handler_error(
            &email_restricted_response.body,
            "NOT_FOUND",
            "Share link not found",
        );

        let revoked_response = app
            .rpc_call(
                "share.accessPublic",
                json!([{ "token": fixture.revoked_token }]),
                unauthenticated_json_headers(),
            )
            .await;
        assert_eq!(revoked_response.status, StatusCode::OK);
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
    with_rpc_test_app("share_request_email_verification_paths", |app| async move {
        let fixture = build_share_router_fixture(&app.pool).await;

        let success_response = app
            .rpc_call(
                "share.requestEmailVerification",
                json!([{
                    "token": fixture.email_link_token.clone(),
                    "email": fixture.request_email.clone()
                }]),
                unauthenticated_json_headers(),
            )
            .await;
        assert_eq!(success_response.status, StatusCode::OK);
        assert_eq!(
            success_response.body["result"]["Ok"]["success"],
            json!(true)
        );
        assert_eq!(
            success_response.body["result"]["Ok"]["message"],
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
            .rpc_call(
                "share.requestEmailVerification",
                json!([{
                    "token": fixture.email_link_token.clone(),
                    "email": "intruder@example.com"
                }]),
                unauthenticated_json_headers(),
            )
            .await;
        assert_eq!(forbidden_response.status, StatusCode::OK);
        assert_handler_error(
            &forbidden_response.body,
            "FORBIDDEN",
            "This email is not authorized to access this link",
        );

        let not_found_response = app
            .rpc_call(
                "share.requestEmailVerification",
                json!([{
                    "token": fixture.one_time_token,
                    "email": fixture.request_email
                }]),
                unauthenticated_json_headers(),
            )
            .await;
        assert_eq!(not_found_response.status, StatusCode::OK);
        assert_handler_error(
            &not_found_response.body,
            "NOT_FOUND",
            "Share link not found",
        );
    })
    .await;
}

#[tokio::test]
async fn verify_email_and_access_returns_payload_and_marks_email_verified() {
    with_rpc_test_app("share_verify_email_success", |app| async move {
			let fixture = build_share_router_fixture(&app.pool).await;

			let response = app
				.rpc_call(
					"share.verifyEmailAndAccess",
					json!([{
						"token": fixture.email_link_token.clone(),
						"email": fixture.allowed_email.clone(),
						"code": fixture.verification_code.clone()
					}]),
					unauthenticated_json_headers(),
				)
				.await;

			assert_eq!(response.status, StatusCode::OK);
			assert_eq!(
				response.body["result"]["Ok"]["encryptedItemData"],
				json!(FIXTURE_ENCRYPTED_ITEM_DATA),
			);
			assert_eq!(
				response.body["result"]["Ok"]["shareKeyIv"],
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
    with_rpc_test_app("share_verify_email_invalid_code", |app| async move {
			let fixture = build_share_router_fixture(&app.pool).await;

			let response = app
				.rpc_call(
					"share.verifyEmailAndAccess",
					json!([{
						"token": fixture.email_link_token.clone(),
						"email": fixture.allowed_email.clone(),
						"code": "000000"
					}]),
					unauthenticated_json_headers(),
				)
				.await;

			assert_eq!(response.status, StatusCode::OK);
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
async fn create_share_via_rpc_persists_link_and_allowed_emails() {
    with_rpc_test_app("share_create_happy_path", |app| async move {
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
				.rpc_call(
					"share.create",
					json!([{
						"itemId": fixture.item_id,
						"accessMode": "email-restricted",
						"isOneTimeUse": true,
						"expiresIn": "1day",
						"allowedEmails": ["bob@example.com", "alice@example.com"],
						"encryptedItemData": "encrypted-item-data",
						"encryptionIv": "item-iv",
						"encryptedShareKey": "encrypted-share-key",
						"shareKeyIv": "share-key-iv"
					}]),
					authenticated_json_headers(&session.token),
				)
				.await;

			assert_eq!(response.status, StatusCode::OK);
			assert_eq!(response.body["jsonrpc"], json!("2.0"));
			assert_eq!(response.body["result"]["Ok"]["baseShareUrl"], json!(expected_base_share_url));

			let link_id = response.body["result"]["Ok"]["id"]
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
async fn create_share_via_rpc_rejects_invalid_access_mode() {
    with_rpc_test_app("share_create_invalid_access_mode", |app| async move {
        let fixture = build_share_actor_fixture(&app.pool).await;
        let session = app.issue_session(&fixture.user_id).await;

        let response = app
            .rpc_call(
                "share.create",
                json!([{
                    "itemId": fixture.item_id,
                    "accessMode": "invalid-mode",
                    "isOneTimeUse": false,
                    "expiresIn": "1day",
                    "allowedEmails": null,
                    "encryptedItemData": "encrypted-item-data",
                    "encryptionIv": "item-iv",
                    "encryptedShareKey": "encrypted-share-key",
                    "shareKeyIv": "share-key-iv"
                }]),
                authenticated_json_headers(&session.token),
            )
            .await;

        assert_eq!(response.status, StatusCode::OK);
        assert_eq!(response.body["result"]["Err"]["code"], json!("BAD_REQUEST"));
        assert_eq!(
            response.body["result"]["Err"]["message"],
            json!("Invalid access mode")
        );

        let share_link_count = query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM share_link")
            .fetch_one(&app.pool)
            .await
            .expect("share link count should load");

        assert_eq!(share_link_count, 0);
    })
    .await;
}

#[tokio::test]
async fn rpc_guard_rejects_non_json_share_requests() {
    with_rpc_test_app("share_rpc_guard_non_json", |app| async move {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("text/plain"));

        let response = app.post_rpc_bytes(b"not-json".to_vec(), headers).await;

        assert_eq!(response.status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
        assert_eq!(response.body["error"], json!("Unsupported Media Type"));
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
        removable_email_id,
        removable_email,
        request_email,
        verification_code,
    }
}

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
			"INSERT INTO share_link (id, item_id, created_by_id, token, status, access_mode, is_one_time_use, encrypted_item_data, encryption_iv, encrypted_share_key, share_key_iv, access_count, max_access_count, expires_at) VALUES ($1, $2, $3, $4, $5::share_link_status, $6::share_link_access_mode, $7, $8, $9, $10, $11, $12, $13, $14)",
		)
		.bind(id)
		.bind(item_id)
		.bind(created_by_id)
		.bind(token)
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
			"INSERT INTO share_email_verification (id, share_link_id, email, code, attempts, max_attempts, expires_at, created_at, used_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
		)
		.bind(id)
		.bind(share_link_id)
		.bind(email)
		.bind(code)
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
async fn create_share_via_rpc_is_daily_rate_limited() {
    let _guard = crate::test_support::acquire_env_lock_async().await;
    let previous = std::env::var("SHARE_LINK_DAILY_LIMIT").ok();
    unsafe { std::env::set_var("SHARE_LINK_DAILY_LIMIT", "2") };

    with_rpc_test_app("share_create_daily_rate_limit", |app| async move {
        let fixture = build_share_router_fixture(&app.pool).await;
        let session = app.issue_session(&fixture.owner_user_id).await;
        let headers = authenticated_json_headers(&session.token);

        let params = json!([{
            "itemId": fixture.item_id,
            "accessMode": "anyone",
            "isOneTimeUse": false,
            "expiresIn": "1day",
            "allowedEmails": null,
            "encryptedItemData": FIXTURE_ENCRYPTED_ITEM_DATA,
            "encryptionIv": FIXTURE_ENCRYPTION_IV,
            "encryptedShareKey": FIXTURE_ENCRYPTED_SHARE_KEY,
            "shareKeyIv": FIXTURE_SHARE_KEY_IV
        }]);

        for _ in 0..2 {
            let response = app
                .rpc_call("share.create", params.clone(), headers.clone())
                .await;
            assert_eq!(response.status, StatusCode::OK);
            assert!(response.body["result"]["Ok"].is_object());
        }

        let blocked = app
            .rpc_call("share.create", params.clone(), headers.clone())
            .await;
        assert_eq!(blocked.status, StatusCode::OK);
        assert_handler_error(
            &blocked.body,
            "TOO_MANY_REQUESTS",
            "Daily share link limit reached",
        );
    })
    .await;

    match previous {
        Some(value) => unsafe { std::env::set_var("SHARE_LINK_DAILY_LIMIT", value) },
        None => unsafe { std::env::remove_var("SHARE_LINK_DAILY_LIMIT") },
    }
}
