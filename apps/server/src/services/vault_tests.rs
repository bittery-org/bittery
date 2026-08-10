use super::{
    assert_item_write_access, attachment_quota_lock_key, base64_encoded_length,
    encrypted_attachment_storage_size, pending_attachment_upload_expiry, toggle_vault_favorite,
    ToggleFavoriteInput,
};
use crate::error::AppErrorCode;
use crate::test_support::{
    acquire_env_lock_async, assign_user_to_team, authenticated_json_headers, seed_item, seed_team,
    seed_user, seed_vault, seed_vault_key, with_api_test_app,
};
use axum::http::{
    header::{CONTENT_TYPE, ETAG, IF_MATCH},
    HeaderMap, HeaderValue, Method, StatusCode,
};
use serde_json::{json, Value};
use sqlx::{query, query_scalar, PgPool};
use std::future::Future;
use time::{Duration, OffsetDateTime};

fn with_if_match(mut headers: HeaderMap, version: impl std::fmt::Display) -> HeaderMap {
    headers.insert(
        IF_MATCH,
        HeaderValue::from_str(&format!("\"{version}\""))
            .expect("fixture version should produce a valid ETag"),
    );
    headers
}

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
        std::env::var("BITTERY_STORAGE_PUBLIC_URL").ok(),
        std::env::var("BITTERY_STORAGE_CDN_URL").ok(),
        std::env::var("BITTERY_ATTACHMENT_UPLOAD_SECRET").ok(),
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
        "BITTERY_STORAGE_PUBLIC_URL",
        Some("https://cdn.example.invalid/public"),
    );
    set_env_var(
        "BITTERY_STORAGE_CDN_URL",
        Some("https://cdn.example.invalid/assets"),
    );
    set_env_var(
        "BITTERY_ATTACHMENT_UPLOAD_SECRET",
        Some("test-attachment-secret"),
    );

    let result = future.await;

    let (
        previous_endpoint,
        previous_bucket,
        previous_access_key,
        previous_secret_key,
        previous_region,
        previous_public_url,
        previous_cdn_url,
        previous_attachment_secret,
    ) = previous;
    restore_env_var("BITTERY_STORAGE_ENDPOINT", previous_endpoint);
    restore_env_var("BITTERY_STORAGE_BUCKET", previous_bucket);
    restore_env_var("BITTERY_STORAGE_ACCESS_KEY_ID", previous_access_key);
    restore_env_var("BITTERY_STORAGE_SECRET_ACCESS_KEY", previous_secret_key);
    restore_env_var("BITTERY_STORAGE_REGION", previous_region);
    restore_env_var("BITTERY_STORAGE_PUBLIC_URL", previous_public_url);
    restore_env_var("BITTERY_STORAGE_CDN_URL", previous_cdn_url);
    restore_env_var(
        "BITTERY_ATTACHMENT_UPLOAD_SECRET",
        previous_attachment_secret,
    );

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

fn unauthenticated_json_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert("x-app-platform", HeaderValue::from_static("desktop"));
    headers.insert("x-client-id", HeaderValue::from_static("integration-test"));
    headers
}

fn idempotent_item_headers(token: &str, version: i32, key: &str) -> HeaderMap {
    let mut headers = authenticated_json_headers(token);
    headers.insert(
        IF_MATCH,
        HeaderValue::from_str(&format!("\"{version}\"")).expect("version ETag should be valid"),
    );
    headers.insert(
        "idempotency-key",
        HeaderValue::from_str(key).expect("idempotency key should be valid"),
    );
    headers
}

fn idempotency_headers(token: &str, key: &str) -> HeaderMap {
    let mut headers = authenticated_json_headers(token);
    headers.insert(
        "idempotency-key",
        HeaderValue::from_str(key).expect("idempotency key should be valid"),
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
        (matches!(
            body["code"].as_str(),
            Some("INVALID_REQUEST" | "INVALID_JSON")
        ) || message.contains("invalid")),
        "unexpected invalid params body: {body}"
    );
}

fn find_entry_by_id<'a>(values: &'a [Value], id: &str) -> &'a Value {
    values
        .iter()
        .find(|value| value["id"] == json!(id))
        .unwrap_or_else(|| panic!("entry {id} not found in {values:?}"))
}

struct VaultRouterFixture {
    owner_user_id: String,
    admin_user_id: String,
    member_user_id: String,
    readonly_user_id: String,
    addable_user_id: String,
    outsider_user_id: String,
    solo_user_id: String,
    paid_team_id: String,
    other_team_id: String,
    main_vault_id: String,
    target_vault_id: String,
    owner_personal_vault_id: String,
    active_item_id: String,
    deleted_item_id: String,
    movable_item_id: String,
    personal_item_id: String,
    attachment_id: String,
}

async fn build_vault_router_fixture(pool: &PgPool) -> VaultRouterFixture {
    let fixture = VaultRouterFixture {
        owner_user_id: "vault_owner_user".to_string(),
        admin_user_id: "vault_admin_user".to_string(),
        member_user_id: "vault_member_user".to_string(),
        readonly_user_id: "vault_readonly_user".to_string(),
        addable_user_id: "vault_addable_user".to_string(),
        outsider_user_id: "vault_outsider_user".to_string(),
        solo_user_id: "vault_solo_user".to_string(),
        paid_team_id: "vault_paid_team".to_string(),
        other_team_id: "vault_other_team".to_string(),
        main_vault_id: "vault_main_team_vault".to_string(),
        target_vault_id: "vault_target_team_vault".to_string(),
        owner_personal_vault_id: "vault_owner_personal_vault".to_string(),
        active_item_id: "vault_active_item".to_string(),
        deleted_item_id: "vault_deleted_item".to_string(),
        movable_item_id: "vault_movable_item".to_string(),
        personal_item_id: "vault_personal_item".to_string(),
        attachment_id: "vault_main_attachment".to_string(),
    };

    seed_user(
        pool,
        &fixture.owner_user_id,
        "Vault Owner",
        "vault-owner@example.com",
    )
    .await;
    seed_user(
        pool,
        &fixture.admin_user_id,
        "Vault Admin",
        "vault-admin@example.com",
    )
    .await;
    seed_user(
        pool,
        &fixture.member_user_id,
        "Vault Member",
        "vault-member@example.com",
    )
    .await;
    seed_user(
        pool,
        &fixture.readonly_user_id,
        "Vault Read Only",
        "vault-readonly@example.com",
    )
    .await;
    seed_user(
        pool,
        &fixture.addable_user_id,
        "Vault Addable",
        "vault-addable@example.com",
    )
    .await;
    seed_user(
        pool,
        &fixture.outsider_user_id,
        "Vault Outsider",
        "vault-outsider@example.com",
    )
    .await;
    seed_user(
        pool,
        &fixture.solo_user_id,
        "Vault Solo",
        "vault-solo@example.com",
    )
    .await;

    seed_team(
        pool,
        &fixture.paid_team_id,
        "Vault Paid Team",
        &fixture.owner_user_id,
        "family",
        "family",
        "active",
    )
    .await;
    seed_team(
        pool,
        &fixture.other_team_id,
        "Vault Other Team",
        &fixture.outsider_user_id,
        "family",
        "family",
        "active",
    )
    .await;

    assign_user_to_team(pool, &fixture.owner_user_id, &fixture.paid_team_id, "owner").await;
    assign_user_to_team(pool, &fixture.admin_user_id, &fixture.paid_team_id, "admin").await;
    assign_user_to_team(
        pool,
        &fixture.member_user_id,
        &fixture.paid_team_id,
        "member",
    )
    .await;
    assign_user_to_team(
        pool,
        &fixture.readonly_user_id,
        &fixture.paid_team_id,
        "member",
    )
    .await;
    assign_user_to_team(
        pool,
        &fixture.addable_user_id,
        &fixture.paid_team_id,
        "member",
    )
    .await;
    assign_user_to_team(
        pool,
        &fixture.outsider_user_id,
        &fixture.other_team_id,
        "owner",
    )
    .await;

    seed_vault(
        pool,
        &fixture.main_vault_id,
        "Main Team Vault",
        "team",
        &fixture.owner_user_id,
        Some(&fixture.paid_team_id),
    )
    .await;
    seed_vault(
        pool,
        &fixture.target_vault_id,
        "Target Team Vault",
        "team",
        &fixture.owner_user_id,
        Some(&fixture.paid_team_id),
    )
    .await;
    seed_vault(
        pool,
        &fixture.owner_personal_vault_id,
        "Owner Personal Vault",
        "personal",
        &fixture.owner_user_id,
        None,
    )
    .await;

    seed_vault_key(
        pool,
        "vault_key_main_owner",
        &fixture.main_vault_id,
        &fixture.owner_user_id,
        "main-owner-key",
        "owner",
    )
    .await;
    seed_vault_key(
        pool,
        "vault_key_main_admin",
        &fixture.main_vault_id,
        &fixture.admin_user_id,
        "main-admin-key",
        "admin",
    )
    .await;
    seed_vault_key(
        pool,
        "vault_key_main_member",
        &fixture.main_vault_id,
        &fixture.member_user_id,
        "main-member-key",
        "member",
    )
    .await;
    seed_vault_key(
        pool,
        "vault_key_main_readonly",
        &fixture.main_vault_id,
        &fixture.readonly_user_id,
        "main-readonly-key",
        "read-only",
    )
    .await;
    seed_vault_key(
        pool,
        "vault_key_target_owner",
        &fixture.target_vault_id,
        &fixture.owner_user_id,
        "target-owner-key",
        "owner",
    )
    .await;
    seed_vault_key(
        pool,
        "vault_key_personal_owner",
        &fixture.owner_personal_vault_id,
        &fixture.owner_user_id,
        "personal-owner-key",
        "owner",
    )
    .await;

    seed_item(
        pool,
        &fixture.active_item_id,
        &fixture.main_vault_id,
        "login",
        "active-encrypted-data",
        "active-iv",
        &fixture.owner_user_id,
    )
    .await;
    seed_item(
        pool,
        &fixture.deleted_item_id,
        &fixture.main_vault_id,
        "login",
        "deleted-encrypted-data",
        "deleted-iv",
        &fixture.owner_user_id,
    )
    .await;
    seed_item(
        pool,
        &fixture.movable_item_id,
        &fixture.main_vault_id,
        "login",
        "movable-encrypted-data",
        "movable-iv",
        &fixture.owner_user_id,
    )
    .await;
    seed_item(
        pool,
        &fixture.personal_item_id,
        &fixture.owner_personal_vault_id,
        "login",
        "personal-encrypted-data",
        "personal-iv",
        &fixture.owner_user_id,
    )
    .await;
    mark_item_deleted(pool, &fixture.deleted_item_id).await;
    seed_attachment(
        pool,
        &fixture.attachment_id,
        &fixture.active_item_id,
        &fixture.main_vault_id,
        &fixture.owner_user_id,
    )
    .await;

    fixture
}

async fn seed_attachment(
    pool: &PgPool,
    attachment_id: &str,
    item_id: &str,
    vault_id: &str,
    uploaded_by: &str,
) {
    query(
			"INSERT INTO item_attachment (id, item_id, vault_id, storage_key, encrypted_name, encrypted_content_type, encryption_iv, encrypted_content_type_iv, encryption_algorithm, file_size, storage_size, uploaded_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)",
		)
		.bind(attachment_id)
		.bind(item_id)
		.bind(vault_id)
		.bind(format!("attachments/{attachment_id}"))
		.bind("encrypted-attachment-name")
		.bind("encrypted-content-type")
		.bind("attachment-iv")
		.bind(Some("attachment-content-type-iv"))
		.bind("AES-GCM-AAD-V1")
		.bind(128_i32)
		.bind(128_i32)
		.bind(uploaded_by)
		.bind(OffsetDateTime::now_utc())
		.execute(pool)
		.await
		.expect("attachment should seed");
}

async fn mark_item_deleted(pool: &PgPool, item_id: &str) {
    query("UPDATE item SET deleted_at = $1 WHERE id = $2")
        .bind(OffsetDateTime::now_utc())
        .bind(item_id)
        .execute(pool)
        .await
        .expect("item should mark deleted");
}

async fn set_team_billing(pool: &PgPool, team_id: &str, plan: &str, status: &str) {
    query(
			"UPDATE team SET billing_plan = $1::billing_plan, billing_status = $2::billing_status WHERE id = $3",
		)
		.bind(plan)
		.bind(status)
		.bind(team_id)
		.execute(pool)
		.await
		.expect("team billing should update");
}

#[test]
fn assert_item_write_access_rejects_read_only_access() {
    assert_item_write_access("owner", "write denied").unwrap();
    assert_item_write_access("admin", "write denied").unwrap();
    assert_item_write_access("member", "write denied").unwrap();

    let error = assert_item_write_access("read-only", "write denied").unwrap_err();
    assert_eq!(error.code, AppErrorCode::Forbidden);
    assert_eq!(error.message, "write denied");
}

#[test]
fn attachment_quota_lock_key_scopes_by_team() {
    assert_eq!(
        attachment_quota_lock_key("team_123"),
        "attachment-quota:team_123"
    );
}

#[test]
fn base64_encoded_length_uses_three_byte_chunks() {
    assert_eq!(base64_encoded_length(0), 0);
    assert_eq!(base64_encoded_length(1), 4);
    assert_eq!(base64_encoded_length(2), 4);
    assert_eq!(base64_encoded_length(3), 4);
    assert_eq!(base64_encoded_length(4), 8);
}

#[test]
fn encrypted_attachment_storage_size_accounts_for_metadata_overhead() {
    assert_eq!(encrypted_attachment_storage_size(1), 98);
    assert_eq!(encrypted_attachment_storage_size(3), 98);
    assert_eq!(encrypted_attachment_storage_size(4), 102);
}

#[test]
fn pending_attachment_upload_expiry_adds_fifteen_minutes() {
    let now = OffsetDateTime::from_unix_timestamp(1_717_171_717).unwrap();

    assert_eq!(
        pending_attachment_upload_expiry(now) - now,
        Duration::minutes(15)
    );
}

#[tokio::test]
async fn vault_handlers_require_authentication() {
    with_api_test_app("vault_handlers_require_authentication", |app| async move {
        let protected_calls = [
            (Method::GET, "/api/v1/vaults", None),
            (Method::GET, "/api/v1/vaults/vault_test", None),
            (
                Method::POST,
                "/api/v1/vaults/vault_test/image-uploads",
                Some(json!({})),
            ),
            (
                Method::POST,
                "/api/v1/items/item_test/attachment-uploads",
                Some(json!({})),
            ),
            (
                Method::POST,
                "/api/v1/items/item_test/attachments",
                Some(json!({})),
            ),
            (Method::GET, "/api/v1/items/item_test/attachments", None),
            (
                Method::POST,
                "/api/v1/attachments/attachment_test/download-urls",
                None,
            ),
            (
                Method::PATCH,
                "/api/v1/attachments/attachment_test",
                Some(json!({})),
            ),
            (Method::DELETE, "/api/v1/attachments/attachment_test", None),
            (Method::PUT, "/api/v1/vaults/vault_test", Some(json!({}))),
            (Method::PATCH, "/api/v1/vaults/vault_test", Some(json!({}))),
            (
                Method::POST,
                "/api/v1/vaults/vault_test/type-conversions",
                Some(json!({})),
            ),
            (Method::DELETE, "/api/v1/vaults/vault_test", None),
            (Method::GET, "/api/v1/vaults/vault_test/items", None),
            (Method::GET, "/api/v1/items", None),
            (Method::GET, "/api/v1/items/trashed", None),
            (Method::GET, "/api/v1/items/item_test", None),
            (
                Method::PUT,
                "/api/v1/vaults/vault_test/items/item_test",
                Some(json!({})),
            ),
            (
                Method::POST,
                "/api/v1/vaults/vault_test/item-imports",
                Some(json!({})),
            ),
            (Method::PATCH, "/api/v1/items/item_test", Some(json!({}))),
            (
                Method::PATCH,
                "/api/v1/items/item_test/favorite",
                Some(json!({})),
            ),
            (Method::DELETE, "/api/v1/items/item_test", None),
            (Method::GET, "/api/v1/vaults/vault_test/items/trashed", None),
            (Method::POST, "/api/v1/items/item_test/restore", None),
            (
                Method::POST,
                "/api/v1/items/item_test/moves",
                Some(json!({})),
            ),
            (Method::DELETE, "/api/v1/items/item_test/permanent", None),
            (Method::GET, "/api/v1/vault-stats", None),
            (Method::GET, "/api/v1/vaults/vault_test/members", None),
            (
                Method::GET,
                "/api/v1/vaults/vault_test/available-team-members",
                None,
            ),
            (
                Method::PATCH,
                "/api/v1/vaults/vault_test/members/user_test",
                Some(json!({})),
            ),
            (
                Method::PUT,
                "/api/v1/vaults/vault_test/members/user_test",
                Some(json!({})),
            ),
            (
                Method::GET,
                "/api/v1/vaults/vault_test/members/user_test/removal-rotation-data",
                None,
            ),
            (
                Method::DELETE,
                "/api/v1/vaults/vault_test/members/user_test",
                Some(json!({})),
            ),
        ];

        for (method, path, payload) in protected_calls {
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
async fn vault_handlers_reject_malformed_request_input() {
    with_api_test_app(
        "vault_handlers_reject_malformed_request_input",
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            let owner_session = app.issue_session(&fixture.owner_user_id).await;
            let headers = authenticated_json_headers(&owner_session.token);

            for (method, path) in [
                (
                    Method::POST,
                    format!(
                        "/api/v1/items/{}/attachment-uploads",
                        fixture.active_item_id
                    ),
                ),
                (
                    Method::POST,
                    format!("/api/v1/items/{}/attachments", fixture.active_item_id),
                ),
                (
                    Method::PUT,
                    format!(
                        "/api/v1/vaults/{}/items/malformed-item!",
                        fixture.main_vault_id
                    ),
                ),
                (
                    Method::DELETE,
                    format!(
                        "/api/v1/vaults/{}/members/{}",
                        fixture.main_vault_id, fixture.member_user_id
                    ),
                ),
            ] {
                let response = app
                    .api_json(method, &path, Some(json!({})), headers.clone())
                    .await;

                response.assert_contract_status();
                assert_invalid_params_error(&response.body);
            }
        },
    )
    .await;
}

#[tokio::test]
async fn vault_query_handlers_return_expected_results() {
    with_api_test_app(
        "vault_query_handlers_return_expected_results",
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            let owner_session = app.issue_session(&fixture.owner_user_id).await;
            let owner_headers = authenticated_json_headers(&owner_session.token);

            let list_response = app
                .api_json(Method::GET, "/api/v1/vaults", None, owner_headers.clone())
                .await;
            list_response.assert_contract_status();
            let listed_vaults = list_response
                .body
                .get("items")
                .and_then(Value::as_array)
                .expect("vault collection should contain items");
            assert_eq!(listed_vaults.len(), 3);
            let main_vault = find_entry_by_id(listed_vaults, &fixture.main_vault_id);
            assert_eq!(main_vault["role"], json!("owner"));
            assert_eq!(main_vault["encryptedVaultKey"], json!("main-owner-key"));
            assert_eq!(main_vault["itemCount"], json!("2"));

            let get_response = app
                .api_json(
                    Method::GET,
                    &format!("/api/v1/vaults/{}", fixture.main_vault_id),
                    None,
                    owner_headers.clone(),
                )
                .await;
            get_response.assert_contract_status();
            assert_eq!(get_response.body["id"], json!(fixture.main_vault_id));
            assert_eq!(get_response.body["itemCount"], json!("2"));
            assert_eq!(get_response.body["memberCount"], json!("4"));

            let list_items_response = app
                .api_json(
                    Method::GET,
                    &format!("/api/v1/vaults/{}/items", fixture.main_vault_id),
                    None,
                    owner_headers.clone(),
                )
                .await;
            list_items_response.assert_contract_status();
            let list_items = list_items_response
                .body
                .get("items")
                .and_then(Value::as_array)
                .expect("vault item collection should contain items");
            assert_eq!(list_items.len(), 2);
            let active_item = find_entry_by_id(list_items, &fixture.active_item_id);
            assert_eq!(active_item["attachments"].as_array().unwrap().len(), 1);
            assert_eq!(
                active_item["attachments"][0]["id"],
                json!(fixture.attachment_id)
            );

            query("UPDATE item SET updated_at = $1 WHERE vault_id = $2 AND deleted_at IS NULL")
                .bind(OffsetDateTime::from_unix_timestamp(1_710_000_000).unwrap())
                .bind(&fixture.main_vault_id)
                .execute(&app.pool)
                .await
                .expect("equal item timestamps should be set");
            let first_page = app
                .api_json(
                    Method::GET,
                    &format!("/api/v1/vaults/{}/items?limit={}", fixture.main_vault_id, 1),
                    None,
                    owner_headers.clone(),
                )
                .await;
            first_page.assert_contract_status();
            assert_eq!(first_page.body["items"].as_array().unwrap().len(), 1);
            assert_eq!(first_page.body["hasMore"], json!(true));
            let cursor = first_page.body["nextCursor"]
                .as_str()
                .expect("continued page should include a cursor");
            let second_page = app
                .api_json(
                    Method::GET,
                    &format!(
                        "/api/v1/vaults/{}/items?cursor={}&limit={}",
                        fixture.main_vault_id, cursor, 1
                    ),
                    None,
                    owner_headers.clone(),
                )
                .await;
            second_page.assert_contract_status();
            assert_ne!(
                first_page.body["items"][0]["id"],
                second_page.body["items"][0]["id"]
            );
            assert_eq!(second_page.body["hasMore"], json!(false));

            let tampered_page = app
                .api_json(
                    Method::GET,
                    &format!(
                        "/api/v1/vaults/{}/items?cursor={}&limit={}",
                        fixture.main_vault_id,
                        format!("{cursor}x"),
                        1
                    ),
                    None,
                    owner_headers.clone(),
                )
                .await;
            assert_eq!(tampered_page.status, StatusCode::BAD_REQUEST);
            assert_eq!(tampered_page.body["code"], json!("INVALID_CURSOR"));

            let list_all_items_response = app
                .api_json(Method::GET, "/api/v1/items", None, owner_headers.clone())
                .await;
            list_all_items_response.assert_contract_status();
            let all_items = list_all_items_response
                .body
                .get("items")
                .and_then(Value::as_array)
                .expect("item collection should contain items");
            assert_eq!(all_items.len(), 3);
            let personal_item = find_entry_by_id(all_items, &fixture.personal_item_id);
            assert_eq!(
                personal_item["vault"]["id"],
                json!(fixture.owner_personal_vault_id)
            );

            let invalid_query = app
                .api_json(
                    Method::GET,
                    "/api/v1/items?unknown=true",
                    None,
                    owner_headers.clone(),
                )
                .await;
            assert_eq!(invalid_query.status, StatusCode::BAD_REQUEST);
            assert_eq!(invalid_query.body["code"], json!("INVALID_QUERY"));
            assert_eq!(
                invalid_query.headers.get(CONTENT_TYPE),
                Some(&HeaderValue::from_static("application/problem+json"))
            );

            let list_all_deleted_response = app
                .api_json(
                    Method::GET,
                    "/api/v1/items/trashed",
                    None,
                    owner_headers.clone(),
                )
                .await;
            list_all_deleted_response.assert_contract_status();
            let all_deleted_items = list_all_deleted_response
                .body
                .get("items")
                .and_then(Value::as_array)
                .expect("trashed item collection should contain items");
            assert_eq!(all_deleted_items.len(), 1);
            assert_eq!(all_deleted_items[0]["id"], json!(fixture.deleted_item_id));

            let list_deleted_response = app
                .api_json(
                    Method::GET,
                    &format!("/api/v1/vaults/{}/items/trashed", fixture.main_vault_id),
                    None,
                    owner_headers.clone(),
                )
                .await;
            list_deleted_response.assert_contract_status();
            let deleted_items = list_deleted_response
                .body
                .get("items")
                .and_then(Value::as_array)
                .expect("trashed vault item collection should contain items");
            assert_eq!(deleted_items.len(), 1);
            assert_eq!(deleted_items[0]["id"], json!(fixture.deleted_item_id));

            let get_item_response = app
                .api_json(
                    Method::GET,
                    &format!("/api/v1/items/{}", fixture.active_item_id),
                    None,
                    owner_headers.clone(),
                )
                .await;
            get_item_response.assert_contract_status();
            assert_eq!(get_item_response.body["id"], json!(fixture.active_item_id));

            let stats_response = app
                .api_json(Method::GET, "/api/v1/vault-stats", None, owner_headers)
                .await;
            stats_response.assert_contract_status();
            assert_eq!(stats_response.body["teamCount"], json!(1));
            assert_eq!(stats_response.body["vaultCount"], json!("3"));
            assert_eq!(stats_response.body["itemCount"], json!("3"));
        },
    )
    .await;
}

#[tokio::test]
async fn max_ciphertext_item_pages_stay_byte_bounded_and_continue() {
    with_api_test_app("max_ciphertext_item_page_budget", |app| async move {
        let fixture = build_vault_router_fixture(&app.pool).await;
        let session = app.issue_session(&fixture.owner_user_id).await;
        let headers = authenticated_json_headers(&session.token);
        let ciphertext = "x".repeat(1_048_576);
        let expected_ids: Vec<String> = (0..6)
            .map(|index| format!("zz_item_budget_{index}"))
            .collect();
        for item_id in &expected_ids {
            seed_item(
                &app.pool,
                item_id,
                &fixture.main_vault_id,
                "login",
                &ciphertext,
                "budget-iv",
                &fixture.owner_user_id,
            )
            .await;
        }

        let mut cursor = None;
        let mut seen_ids = Vec::new();
        for _ in 0..4 {
            let query = cursor.as_deref().map_or_else(
                || "limit=500".to_string(),
                |cursor| format!("limit=500&cursor={cursor}"),
            );
            let response = app
                .api_json(
                    Method::GET,
                    &format!("/api/v1/vaults/{}/items?{query}", fixture.main_vault_id),
                    None,
                    headers.clone(),
                )
                .await;
            response.assert_contract_status();
            assert!(
                response.body_bytes <= crate::http::api::pagination::RESPONSE_PAGE_BYTES,
                "serialized page was {} bytes",
                response.body_bytes
            );
            let items = response.body["items"]
                .as_array()
                .expect("bounded item page should contain items");
            assert!(
                items
                    .iter()
                    .filter(|item| {
                        item["encryptedData"]
                            .as_str()
                            .is_some_and(|value| value.len() >= 1_048_576)
                    })
                    .count()
                    <= 3,
                "pre-budget query materialized too many maximum-size rows"
            );
            seen_ids.extend(
                items
                    .iter()
                    .filter_map(|item| item["id"].as_str().map(str::to_string)),
            );
            if response.body["hasMore"] == json!(false) {
                break;
            }
            cursor = Some(
                response.body["nextCursor"]
                    .as_str()
                    .expect("continued item page should have a cursor")
                    .to_string(),
            );
        }

        for item_id in expected_ids {
            assert_eq!(
                seen_ids.iter().filter(|seen| **seen == item_id).count(),
                1,
                "item {item_id} should occur exactly once across pages"
            );
        }
    })
    .await;
}

#[tokio::test]
async fn large_vault_metadata_pages_stay_byte_bounded_and_continue() {
    with_api_test_app("large_vault_metadata_page_budget", |app| async move {
        let fixture = build_vault_router_fixture(&app.pool).await;
        let session = app.issue_session(&fixture.owner_user_id).await;
        let headers = authenticated_json_headers(&session.token);
        let large_name = "n".repeat(super::VAULT_NAME_MAX_CHARS);
        let large_key = "k".repeat(crate::services::vault_key::ENCRYPTED_VAULT_KEY_MAX_BYTES);
        let expected_ids: Vec<String> = (0..70)
            .map(|index| format!("vault_metadata_budget_{index:03}"))
            .collect();
        for (index, vault_id) in expected_ids.iter().enumerate() {
            seed_vault(
                &app.pool,
                vault_id,
                &large_name,
                "personal",
                &fixture.owner_user_id,
                None,
            )
            .await;
            seed_vault_key(
                &app.pool,
                &format!("vault_key_metadata_budget_{index:03}"),
                vault_id,
                &fixture.owner_user_id,
                &large_key,
                "owner",
            )
            .await;
        }

        let mut cursor = None;
        let mut seen_ids = Vec::new();
        for _ in 0..4 {
            let query = cursor.as_deref().map_or_else(
                || "limit=500".to_string(),
                |cursor| format!("limit=500&cursor={cursor}"),
            );
            let response = app
                .api_json(
                    Method::GET,
                    &format!("/api/v1/vaults?{query}"),
                    None,
                    headers.clone(),
                )
                .await;
            response.assert_contract_status();
            assert!(response.body_bytes <= crate::http::api::pagination::RESPONSE_PAGE_BYTES);
            seen_ids.extend(
                response.body["items"]
                    .as_array()
                    .expect("vault page should contain items")
                    .iter()
                    .filter_map(|vault| vault["id"].as_str().map(str::to_string)),
            );
            if response.body["hasMore"] == json!(false) {
                break;
            }
            cursor = Some(
                response.body["nextCursor"]
                    .as_str()
                    .expect("continued vault page should have a cursor")
                    .to_string(),
            );
        }
        for vault_id in expected_ids {
            assert_eq!(seen_ids.iter().filter(|seen| **seen == vault_id).count(), 1);
        }
    })
    .await;
}

#[tokio::test]
async fn vault_query_handlers_enforce_access_and_not_found() {
    with_api_test_app(
        "vault_query_handlers_enforce_access_and_not_found",
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            let owner_session = app.issue_session(&fixture.owner_user_id).await;
            let outsider_session = app.issue_session(&fixture.outsider_user_id).await;
            let owner_headers = authenticated_json_headers(&owner_session.token);
            let outsider_headers = authenticated_json_headers(&outsider_session.token);

            let missing_vault_response = app
                .api_json(
                    Method::GET,
                    &format!("/api/v1/vaults/{}", "vault_missing"),
                    None,
                    owner_headers.clone(),
                )
                .await;
            missing_vault_response.assert_contract_status();
            assert_handler_error(
                &missing_vault_response.body,
                "NOT_FOUND",
                "Vault not found or access denied",
            );

            let list_items_response = app
                .api_json(
                    Method::GET,
                    &format!("/api/v1/vaults/{}/items", fixture.main_vault_id),
                    None,
                    outsider_headers.clone(),
                )
                .await;
            list_items_response.assert_contract_status();
            assert_handler_error(
                &list_items_response.body,
                "FORBIDDEN",
                "Access denied to this vault",
            );

            let missing_item_response = app
                .api_json(
                    Method::GET,
                    &format!("/api/v1/items/{}", "item_missing"),
                    None,
                    owner_headers.clone(),
                )
                .await;
            missing_item_response.assert_contract_status();
            assert_handler_error(&missing_item_response.body, "NOT_FOUND", "Item not found");

            let outsider_item_response = app
                .api_json(
                    Method::GET,
                    &format!("/api/v1/items/{}", fixture.active_item_id),
                    None,
                    outsider_headers,
                )
                .await;
            outsider_item_response.assert_contract_status();
            assert_handler_error(&outsider_item_response.body, "FORBIDDEN", "Access denied");
        },
    )
    .await;
}

#[tokio::test]
async fn vault_item_mutation_handlers_manage_item_lifecycle() {
    with_api_test_app(
        "vault_item_mutation_handlers_manage_item_lifecycle",
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            let owner_session = app.issue_session(&fixture.owner_user_id).await;
            let owner_headers = authenticated_json_headers(&owner_session.token);
            let created_item_id = "vault_created_item";
            let imported_item_a = "vault_import_item_a";
            let imported_item_b = "vault_import_item_b";

            let empty_import_response = app
                .api_json(Method::POST, &format!("/api/v1/vaults/{}/item-imports", fixture.owner_personal_vault_id), Some(json!({ "items": [] })), owner_headers.clone())
                .await;
            empty_import_response.assert_contract_status();
            assert_eq!(empty_import_response.body["importedCount"], json!(0));

            let create_item_response = app
                .api_json(Method::PUT, &format!("/api/v1/vaults/{}/items/{}", fixture.owner_personal_vault_id, created_item_id), Some(json!({ "category": "login", "encryptedData": "created-encrypted-data", "encryptionIv": "created-iv" })), owner_headers.clone())
                .await;
            create_item_response.assert_contract_status();
            assert_eq!(create_item_response.body["itemId"], json!(created_item_id));

            let bulk_import_response = app
                .api_json(Method::POST, &format!("/api/v1/vaults/{}/item-imports", fixture.owner_personal_vault_id), Some(json!({ "items": [
                            {
                                "itemId": imported_item_a,
                                "category": "login",
                                "favorite": true,
                                "encryptedData": "imported-a-data",
                                "encryptionIv": "imported-a-iv"
                            },
                            {
                                "itemId": imported_item_b,
                                "category": "login",
                                "encryptedData": "imported-b-data",
                                "encryptionIv": "imported-b-iv"
                            }
                        ] })), owner_headers.clone())
                .await;
            bulk_import_response.assert_contract_status();
            assert_eq!(bulk_import_response.body["importedCount"], json!(2));

            let current_version: i32 = query_scalar("SELECT version FROM item WHERE id = $1")
                .bind(&fixture.active_item_id)
                .fetch_one(&app.pool)
                .await
                .expect("active item version should load");
            let update_response = app
                .api_json(Method::PATCH, &format!("/api/v1/items/{}", fixture.active_item_id), Some(json!({ "encryptedData": "active-encrypted-data-updated", "encryptionIv": "active-iv-updated" })), with_if_match(owner_headers.clone(), current_version))
                .await;
            update_response.assert_contract_status();
            assert_eq!(update_response.body["version"], json!(current_version + 1));
            let updated_data: String =
                query_scalar("SELECT encrypted_data FROM item WHERE id = $1")
                    .bind(&fixture.active_item_id)
                    .fetch_one(&app.pool)
                    .await
                    .expect("updated item data should load");
            assert_eq!(updated_data, "active-encrypted-data-updated");

            let toggle_response = app
                .api_json(Method::PATCH, &format!("/api/v1/items/{}/favorite", fixture.active_item_id), Some(json!({ "favorite": true })), with_if_match(owner_headers.clone(), current_version + 1))
                .await;
            toggle_response.assert_contract_status();
            let favorite: bool = query_scalar("SELECT favorite FROM item WHERE id = $1")
                .bind(&fixture.active_item_id)
                .fetch_one(&app.pool)
                .await
                .expect("favorite flag should load");
            assert!(favorite);

            let delete_response = app
                .api_json(Method::DELETE, &format!("/api/v1/items/{}", imported_item_a), None, with_if_match(owner_headers.clone(), 1))
                .await;
            delete_response.assert_contract_status();
            let deleted_at: Option<OffsetDateTime> =
                query_scalar("SELECT deleted_at FROM item WHERE id = $1")
                    .bind(imported_item_a)
                    .fetch_one(&app.pool)
                    .await
                    .expect("deleted_at should load");
            assert!(deleted_at.is_some());

            let restore_response = app
                .api_json(Method::POST, &format!("/api/v1/items/{}/restore", fixture.deleted_item_id), None, with_if_match(owner_headers.clone(), 1))
                .await;
            restore_response.assert_contract_status();
            let restored_deleted_at: Option<OffsetDateTime> =
                query_scalar("SELECT deleted_at FROM item WHERE id = $1")
                    .bind(&fixture.deleted_item_id)
                    .fetch_one(&app.pool)
                    .await
                    .expect("restored deleted_at should load");
            assert!(restored_deleted_at.is_none());

            let move_response = app
                .api_json(Method::POST, &format!("/api/v1/items/{}/moves", fixture.movable_item_id), Some(json!({ "sourceVaultId": fixture.main_vault_id, "targetVaultId": fixture.target_vault_id, "encryptedData": "moved-encrypted-data", "encryptionIv": "moved-iv" })), with_if_match(owner_headers.clone(), 1))
                .await;
            move_response.assert_contract_status();
            let moved_vault_id: String = query_scalar("SELECT vault_id FROM item WHERE id = $1")
                .bind(&fixture.movable_item_id)
                .fetch_one(&app.pool)
                .await
                .expect("moved item vault id should load");
            assert_eq!(moved_vault_id, fixture.target_vault_id);

            let permanent_delete_response = app
                .api_json(Method::DELETE, &format!("/api/v1/items/{}/permanent", imported_item_a), None, with_if_match(owner_headers, 2))
                .await;
            permanent_delete_response.assert_contract_status();
            let remaining_rows: i64 =
                query_scalar("SELECT COUNT(*)::bigint FROM item WHERE id = $1")
                    .bind(imported_item_a)
                    .fetch_one(&app.pool)
                    .await
                    .expect("remaining item rows should load");
            assert_eq!(remaining_rows, 0);
        },
    )
    .await;
}

#[tokio::test]
async fn rest_item_mutations_require_and_advance_strong_versions() {
    with_api_test_app(
        "rest_item_mutations_require_and_advance_strong_versions",
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            let owner_session = app.issue_session(&fixture.owner_user_id).await;
            let headers = authenticated_json_headers(&owner_session.token);
            let item_uri = format!("/api/v1/items/{}", fixture.active_item_id);

            let get = app
                .api_json(Method::GET, &item_uri, None, headers.clone())
                .await;
            get.assert_contract_status();
            assert_eq!(get.headers.get(ETAG).unwrap(), "\"1\"");

            let missing_patch = app
                .api_json(
                    Method::PATCH,
                    &item_uri,
                    Some(json!({ "encryptedData": "must-not-write" })),
                    headers.clone(),
                )
                .await;
            assert_eq!(missing_patch.status, StatusCode::PRECONDITION_REQUIRED);
            assert_eq!(missing_patch.body["code"], json!("PRECONDITION_REQUIRED"));

            let missing_delete = app
                .api_json(Method::DELETE, &item_uri, None, headers.clone())
                .await;
            assert_eq!(missing_delete.status, StatusCode::PRECONDITION_REQUIRED);

            let mut stale_headers = headers.clone();
            stale_headers.insert(IF_MATCH, HeaderValue::from_static("\"99\""));
            let stale = app
                .api_json(
                    Method::PATCH,
                    &item_uri,
                    Some(json!({ "encryptedData": "stale-write" })),
                    stale_headers,
                )
                .await;
            assert_eq!(stale.status, StatusCode::PRECONDITION_FAILED);
            assert_eq!(stale.body["code"], json!("VERSION_CONFLICT"));
            let mut stale_delete_headers = headers.clone();
            stale_delete_headers.insert(IF_MATCH, HeaderValue::from_static("\"99\""));
            let stale_delete = app
                .api_json(Method::DELETE, &item_uri, None, stale_delete_headers)
                .await;
            assert_eq!(stale_delete.status, StatusCode::PRECONDITION_FAILED);
            assert_eq!(stale_delete.body["code"], json!("VERSION_CONFLICT"));
            let unchanged: (String, i32, bool, Option<OffsetDateTime>) = sqlx::query_as(
                "SELECT encrypted_data, version, favorite, deleted_at FROM item WHERE id = $1",
            )
            .bind(&fixture.active_item_id)
            .fetch_one(&app.pool)
            .await
            .unwrap();
            assert_eq!(
                unchanged,
                ("active-encrypted-data".to_string(), 1, false, None)
            );

            let mut version_headers = headers.clone();
            version_headers.insert(IF_MATCH, HeaderValue::from_static("\"1\""));
            let updated = app
                .api_json(
                    Method::PATCH,
                    &item_uri,
                    Some(json!({ "encryptedData": "version-two" })),
                    version_headers,
                )
                .await;
            updated.assert_contract_status();
            assert_eq!(updated.headers.get(ETAG).unwrap(), "\"2\"");

            let mut favorite_headers = headers.clone();
            favorite_headers.insert(IF_MATCH, HeaderValue::from_static("\"2\""));
            let favorite = app
                .api_json(
                    Method::PATCH,
                    &format!("{item_uri}/favorite"),
                    Some(json!({ "favorite": true })),
                    favorite_headers,
                )
                .await;
            favorite.assert_contract_status();
            let after_favorite: (i32, bool) =
                sqlx::query_as("SELECT version, favorite FROM item WHERE id = $1")
                    .bind(&fixture.active_item_id)
                    .fetch_one(&app.pool)
                    .await
                    .unwrap();
            assert_eq!(after_favorite, (3, true));

            let mut trash_headers = headers.clone();
            trash_headers.insert(IF_MATCH, HeaderValue::from_static("\"3\""));
            let trashed = app
                .api_json(Method::DELETE, &item_uri, None, trash_headers)
                .await;
            trashed.assert_contract_status();
            let after_trash: (i32, Option<OffsetDateTime>) =
                sqlx::query_as("SELECT version, deleted_at FROM item WHERE id = $1")
                    .bind(&fixture.active_item_id)
                    .fetch_one(&app.pool)
                    .await
                    .unwrap();
            assert_eq!(after_trash.0, 4);
            assert!(after_trash.1.is_some());

            let mut restore_headers = headers;
            restore_headers.insert(IF_MATCH, HeaderValue::from_static("\"4\""));
            let restored = app
                .api_json(
                    Method::POST,
                    &format!("{item_uri}/restore"),
                    None,
                    restore_headers,
                )
                .await;
            restored.assert_contract_status();
            let after_restore: (i32, Option<OffsetDateTime>) =
                sqlx::query_as("SELECT version, deleted_at FROM item WHERE id = $1")
                    .bind(&fixture.active_item_id)
                    .fetch_one(&app.pool)
                    .await
                    .unwrap();
            assert_eq!(after_restore, (5, None));
        },
    )
    .await;
}

#[tokio::test]
async fn favorite_service_advances_item_version() {
    with_api_test_app("favorite_service_advances_item_version", |app| async move {
        let fixture = build_vault_router_fixture(&app.pool).await;
        toggle_vault_favorite(
            &app.pool,
            &fixture.owner_user_id,
            ToggleFavoriteInput {
                item_id: fixture.active_item_id.clone(),
                favorite: true,
                expected_version: None,
            },
        )
        .await
        .expect("favorite mutation should succeed");

        let version: i32 = query_scalar("SELECT version FROM item WHERE id = $1")
            .bind(&fixture.active_item_id)
            .fetch_one(&app.pool)
            .await
            .unwrap();
        assert_eq!(version, 2);
    })
    .await;
}

#[tokio::test]
async fn move_item_requires_source_vault_write_access() {
    with_api_test_app(
        "move_item_requires_source_vault_write_access",
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            seed_vault_key(
                &app.pool,
                "vault_key_target_readonly_source",
                &fixture.target_vault_id,
                &fixture.readonly_user_id,
                "target-member-key",
                "member",
            )
            .await;
            let readonly_session = app.issue_session(&fixture.readonly_user_id).await;

            let response = app
                .api_json(Method::POST, &format!("/api/v1/items/{}/moves", fixture.movable_item_id), Some(json!({ "sourceVaultId": fixture.main_vault_id, "targetVaultId": fixture.target_vault_id, "encryptedData": "moved-encrypted-data", "encryptionIv": "moved-iv" })), with_if_match(authenticated_json_headers(&readonly_session.token), 1))
                .await;

            response.assert_contract_status();
            assert_handler_error(
                &response.body,
                "FORBIDDEN",
                "Cannot move items from a read-only vault",
            );
            let vault_id: String = query_scalar("SELECT vault_id FROM item WHERE id = $1")
                .bind(&fixture.movable_item_id)
                .fetch_one(&app.pool)
                .await
                .expect("item vault should load");
            assert_eq!(vault_id, fixture.main_vault_id);
        },
    )
    .await;
}

#[tokio::test]
async fn item_update_idempotency_replays_without_a_second_mutation() {
    with_api_test_app(
        "item_update_idempotency_replay",
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            let session = app.issue_session(&fixture.owner_user_id).await;
            let body = json!({
                "encryptedData": "idempotent-encrypted-data",
                "encryptionIv": "idempotent-iv"
            });

            let first = app
                .api_json(
                    Method::PATCH,
                    &format!("/api/v1/items/{}", fixture.active_item_id),
                    Some(body.clone()),
                    idempotent_item_headers(&session.token, 1, "update-replay-key"),
                )
                .await;
            let replay = app
                .api_json(
                    Method::PATCH,
                    &format!("/api/v1/items/{}", fixture.active_item_id),
                    Some(body),
                    idempotent_item_headers(&session.token, 1, "update-replay-key"),
                )
                .await;

            assert_eq!(first.status, StatusCode::OK);
            assert_eq!(replay.status, first.status);
            assert_eq!(replay.body, first.body);
            assert_eq!(replay.headers.get(ETAG), first.headers.get(ETAG));
            assert_eq!(
                replay.headers.get("idempotency-replayed"),
                Some(&HeaderValue::from_static("true")),
            );
            let version: i32 = query_scalar("SELECT version FROM item WHERE id = $1")
                .bind(&fixture.active_item_id)
                .fetch_one(&app.pool)
                .await
                .expect("item version should load");
            let events: i64 = query_scalar(
                "SELECT COUNT(*)::bigint FROM sync_event WHERE entity_id = $1 AND event_type = 'item_updated'::sync_event_type",
            )
            .bind(&fixture.active_item_id)
            .fetch_one(&app.pool)
            .await
            .expect("sync event count should load");
            assert_eq!(version, 2);
            assert_eq!(events, 1);
        },
    )
    .await;
}

#[tokio::test]
async fn queued_item_create_replays_a_lost_success_without_duplicate_side_effects() {
    with_api_test_app("queued_item_create_replay", |app| async move {
        let fixture = build_vault_router_fixture(&app.pool).await;
        let session = app.issue_session(&fixture.owner_user_id).await;
        let item_id = "item_queued_create_replay";
        let uri = format!(
            "/api/v1/vaults/{}/items/{item_id}",
            fixture.main_vault_id
        );
        let body = json!({
            "category": "login",
            "encryptedData": "queued-create-ciphertext",
            "encryptionIv": "queued-create-iv"
        });

        let first = app
            .api_json(
                Method::PUT,
                &uri,
                Some(body.clone()),
                idempotency_headers(&session.token, "queued-create-key"),
            )
            .await;
        let replay = app
            .api_json(
                Method::PUT,
                &uri,
                Some(body),
                idempotency_headers(&session.token, "queued-create-key"),
            )
            .await;

        assert_eq!(first.status, StatusCode::OK);
        assert_eq!(replay.status, first.status);
        assert_eq!(replay.body, first.body);
        assert_eq!(first.headers.get(ETAG), Some(&HeaderValue::from_static("\"1\"")));
        assert_eq!(replay.headers.get(ETAG), first.headers.get(ETAG));
        assert_eq!(
            replay.headers.get("idempotency-replayed"),
            Some(&HeaderValue::from_static("true")),
        );
        let item_count: i64 = query_scalar("SELECT COUNT(*)::bigint FROM item WHERE id = $1")
            .bind(item_id)
            .fetch_one(&app.pool)
            .await
            .expect("created item count should load");
        let event_count: i64 = query_scalar(
            "SELECT COUNT(*)::bigint FROM sync_event WHERE entity_id = $1 AND event_type = 'item_created'::sync_event_type",
        )
        .bind(item_id)
        .fetch_one(&app.pool)
        .await
        .expect("created event count should load");
        assert_eq!(item_count, 1);
        assert_eq!(event_count, 1);
    })
    .await;
}

#[tokio::test]
async fn queued_item_trash_replays_a_lost_success_without_advancing_twice() {
    with_api_test_app("queued_item_trash_replay", |app| async move {
        let fixture = build_vault_router_fixture(&app.pool).await;
        let session = app.issue_session(&fixture.owner_user_id).await;
        let uri = format!("/api/v1/items/{}", fixture.active_item_id);
        let headers = || idempotent_item_headers(&session.token, 1, "queued-trash-key");

        let first = app.api_json(Method::DELETE, &uri, None, headers()).await;
        let replay = app.api_json(Method::DELETE, &uri, None, headers()).await;

        assert_eq!(first.status, StatusCode::OK);
        assert_eq!(replay.status, first.status);
        assert_eq!(replay.body, first.body);
        assert_eq!(replay.headers.get(ETAG), first.headers.get(ETAG));
        assert_eq!(
            replay.headers.get("idempotency-replayed"),
            Some(&HeaderValue::from_static("true")),
        );
        let version: i32 = query_scalar("SELECT version FROM item WHERE id = $1")
            .bind(&fixture.active_item_id)
            .fetch_one(&app.pool)
            .await
            .expect("trashed item version should load");
        let events: i64 = query_scalar(
            "SELECT COUNT(*)::bigint FROM sync_event WHERE entity_id = $1 AND event_type = 'item_deleted'::sync_event_type",
        )
        .bind(&fixture.active_item_id)
        .fetch_one(&app.pool)
        .await
        .expect("trash event count should load");
        assert_eq!(version, 2);
        assert_eq!(events, 1);
    })
    .await;
}

#[tokio::test]
async fn queued_item_permanent_delete_replays_a_lost_success_without_second_delete() {
    with_api_test_app("queued_item_permanent_delete_replay", |app| async move {
        let fixture = build_vault_router_fixture(&app.pool).await;
        let session = app.issue_session(&fixture.owner_user_id).await;
        let uri = format!(
            "/api/v1/items/{}/permanent",
            fixture.deleted_item_id
        );
        let headers = || {
            idempotent_item_headers(&session.token, 1, "queued-permanent-delete-key")
        };

        let first = app.api_json(Method::DELETE, &uri, None, headers()).await;
        let replay = app.api_json(Method::DELETE, &uri, None, headers()).await;

        assert_eq!(first.status, StatusCode::OK);
        assert_eq!(replay.status, first.status);
        assert_eq!(replay.body, first.body);
        assert_eq!(replay.headers.get(ETAG), first.headers.get(ETAG));
        assert_eq!(
            replay.headers.get("idempotency-replayed"),
            Some(&HeaderValue::from_static("true")),
        );
        let item_count: i64 = query_scalar("SELECT COUNT(*)::bigint FROM item WHERE id = $1")
            .bind(&fixture.deleted_item_id)
            .fetch_one(&app.pool)
            .await
            .expect("permanently deleted item count should load");
        let events: i64 = query_scalar(
            "SELECT COUNT(*)::bigint FROM sync_event WHERE entity_id = $1 AND event_type = 'item_permanently_deleted'::sync_event_type",
        )
        .bind(&fixture.deleted_item_id)
        .fetch_one(&app.pool)
        .await
        .expect("permanent delete event count should load");
        assert_eq!(item_count, 0);
        assert_eq!(events, 1);
    })
    .await;
}

#[tokio::test]
async fn queued_item_idempotency_rejects_changed_bodies_and_preconditions() {
    with_api_test_app("queued_item_idempotency_mismatch", |app| async move {
        let fixture = build_vault_router_fixture(&app.pool).await;
        let session = app.issue_session(&fixture.owner_user_id).await;
        let create_uri = format!(
            "/api/v1/vaults/{}/items/item_queued_mismatch",
            fixture.main_vault_id
        );
        let create_headers = || idempotency_headers(&session.token, "queued-create-mismatch");
        let first = app
            .api_json(
                Method::PUT,
                &create_uri,
                Some(json!({
                    "category": "login",
                    "encryptedData": "first",
                    "encryptionIv": "iv"
                })),
                create_headers(),
            )
            .await;
        assert_eq!(first.status, StatusCode::OK);
        let body_mismatch = app
            .api_json(
                Method::PUT,
                &create_uri,
                Some(json!({
                    "category": "login",
                    "encryptedData": "second",
                    "encryptionIv": "iv"
                })),
                create_headers(),
            )
            .await;
        assert_eq!(body_mismatch.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(body_mismatch.body["code"], json!("IDEMPOTENCY_KEY_REUSED"));

        let trash_uri = format!("/api/v1/items/{}", fixture.active_item_id);
        let first = app
            .api_json(
                Method::DELETE,
                &trash_uri,
                None,
                idempotent_item_headers(&session.token, 1, "queued-trash-mismatch"),
            )
            .await;
        assert_eq!(first.status, StatusCode::OK);
        let precondition_mismatch = app
            .api_json(
                Method::DELETE,
                &trash_uri,
                None,
                idempotent_item_headers(&session.token, 2, "queued-trash-mismatch"),
            )
            .await;
        assert_eq!(
            precondition_mismatch.status,
            StatusCode::UNPROCESSABLE_ENTITY
        );
        assert_eq!(
            precondition_mismatch.body["code"],
            json!("IDEMPOTENCY_KEY_REUSED")
        );
    })
    .await;
}

#[tokio::test]
async fn concurrent_queued_item_create_executes_once_and_then_replays() {
    with_api_test_app("concurrent_queued_item_create", |app| async move {
        let fixture = build_vault_router_fixture(&app.pool).await;
        let session = app.issue_session(&fixture.owner_user_id).await;
        let item_id = "item_concurrent_queued_create";
        let uri = format!(
            "/api/v1/vaults/{}/items/{item_id}",
            fixture.main_vault_id
        );
        let body = json!({
            "category": "login",
            "encryptedData": "concurrent-create",
            "encryptionIv": "concurrent-iv"
        });
        let first = app.api_json(
            Method::PUT,
            &uri,
            Some(body.clone()),
            idempotency_headers(&session.token, "concurrent-create-key"),
        );
        let second = app.api_json(
            Method::PUT,
            &uri,
            Some(body.clone()),
            idempotency_headers(&session.token, "concurrent-create-key"),
        );
        let (first, second) = tokio::join!(first, second);
        assert!(matches!(
            first.status,
            StatusCode::OK | StatusCode::SERVICE_UNAVAILABLE
        ));
        assert!(matches!(
            second.status,
            StatusCode::OK | StatusCode::SERVICE_UNAVAILABLE
        ));
        assert!(first.status == StatusCode::OK || second.status == StatusCode::OK);

        let replay = app
            .api_json(
                Method::PUT,
                &uri,
                Some(body),
                idempotency_headers(&session.token, "concurrent-create-key"),
            )
            .await;
        assert_eq!(replay.status, StatusCode::OK);
        assert_eq!(
            replay.headers.get("idempotency-replayed"),
            Some(&HeaderValue::from_static("true"))
        );
        let item_count: i64 = query_scalar("SELECT COUNT(*)::bigint FROM item WHERE id = $1")
            .bind(item_id)
            .fetch_one(&app.pool)
            .await
            .expect("created item count should load");
        let event_count: i64 = query_scalar(
            "SELECT COUNT(*)::bigint FROM sync_event WHERE entity_id = $1 AND event_type = 'item_created'::sync_event_type",
        )
        .bind(item_id)
        .fetch_one(&app.pool)
        .await
        .expect("created event count should load");
        assert_eq!(item_count, 1);
        assert_eq!(event_count, 1);
    })
    .await;
}

#[tokio::test]
async fn stale_idempotency_claims_fail_closed_and_completed_records_are_cleaned() {
    use crate::services::idempotency::{claim, Claim, RequestScope};

    with_api_test_app("idempotency_claim_lifecycle", |app| async move {
        let fingerprint = [7_u8; 32];
        let scope = RequestScope {
            principal_id: "user_idempotency_lifecycle",
            method: "DELETE",
            route_target: "/api/v1/items/item_stale",
            key: "stale-key",
        };
        assert!(matches!(
            claim(&app.pool, &scope, &fingerprint).await.unwrap(),
            Claim::Execute
        ));
        query(
            "UPDATE idempotency_record SET claim_expires_at = NOW() - INTERVAL '1 second' WHERE idempotency_key = $1",
        )
        .bind(scope.key)
        .execute(&app.pool)
        .await
        .expect("claim should become stale");
        assert!(matches!(
            claim(&app.pool, &scope, &fingerprint).await.unwrap(),
            Claim::Indeterminate
        ));
        assert!(matches!(
            claim(&app.pool, &scope, &fingerprint).await.unwrap(),
            Claim::Indeterminate
        ));

        query(
            "INSERT INTO idempotency_record (principal_id, method, route_target, idempotency_key, request_fingerprint, state, response_status, response_content_type, response_body, expires_at) VALUES ($1, 'PATCH', '/api/v1/items/expired', 'expired-key', $2, 'completed', 200, 'application/json', $3, NOW() - INTERVAL '1 second')",
        )
        .bind(scope.principal_id)
        .bind(fingerprint.as_slice())
        .bind(b"{}".as_slice())
        .execute(&app.pool)
        .await
        .expect("expired completed record should insert");
        let maintenance_scope = RequestScope {
            principal_id: scope.principal_id,
            method: "POST",
            route_target: "/api/v1/items/maintenance",
            key: "maintenance-key",
        };
        assert!(matches!(
            claim(&app.pool, &maintenance_scope, &[8_u8; 32])
                .await
                .unwrap(),
            Claim::Execute
        ));
        let expired_count: i64 = query_scalar(
            "SELECT COUNT(*)::bigint FROM idempotency_record WHERE idempotency_key = 'expired-key'",
        )
        .fetch_one(&app.pool)
        .await
        .expect("expired record count should load");
        let stale_state: String = query_scalar(
            "SELECT state FROM idempotency_record WHERE idempotency_key = 'stale-key'",
        )
        .fetch_one(&app.pool)
        .await
        .expect("stale record should remain terminal");
        assert_eq!(expired_count, 0);
        assert_eq!(stale_state, "indeterminate");
    })
    .await;
}

#[tokio::test]
async fn concurrent_item_update_idempotency_executes_once() {
    with_api_test_app("concurrent_item_update_idempotency", |app| async move {
        let fixture = build_vault_router_fixture(&app.pool).await;
        let session = app.issue_session(&fixture.owner_user_id).await;
        let uri = format!("/api/v1/items/{}", fixture.active_item_id);
        let body = json!({
            "encryptedData": "concurrent-encrypted-data",
            "encryptionIv": "concurrent-iv"
        });
        let request_a = app.api_json(
            Method::PATCH,
            &uri,
            Some(body.clone()),
            idempotent_item_headers(&session.token, 1, "concurrent-update-key"),
        );
        let request_b = app.api_json(
            Method::PATCH,
            &uri,
            Some(body),
            idempotent_item_headers(&session.token, 1, "concurrent-update-key"),
        );

        let (first, second) = tokio::join!(request_a, request_b);
        assert!(matches!(
            first.status,
            StatusCode::OK | StatusCode::SERVICE_UNAVAILABLE
        ));
        assert!(matches!(
            second.status,
            StatusCode::OK | StatusCode::SERVICE_UNAVAILABLE
        ));
        assert!(first.status == StatusCode::OK || second.status == StatusCode::OK);
        let version: i32 = query_scalar("SELECT version FROM item WHERE id = $1")
            .bind(&fixture.active_item_id)
            .fetch_one(&app.pool)
            .await
            .expect("item version should load");
        assert_eq!(version, 2);
    })
    .await;
}

#[tokio::test]
async fn item_update_idempotency_rejects_body_mismatch() {
    with_api_test_app("item_update_idempotency_mismatch", |app| async move {
        let fixture = build_vault_router_fixture(&app.pool).await;
        let session = app.issue_session(&fixture.owner_user_id).await;
        let uri = format!("/api/v1/items/{}", fixture.active_item_id);
        let headers = || idempotent_item_headers(&session.token, 1, "mismatch-key");
        let first = app
            .api_json(
                Method::PATCH,
                &uri,
                Some(json!({ "encryptedData": "first", "encryptionIv": "iv" })),
                headers(),
            )
            .await;
        assert_eq!(first.status, StatusCode::OK);

        let mismatch = app
            .api_json(
                Method::PATCH,
                &uri,
                Some(json!({ "encryptedData": "second", "encryptionIv": "iv" })),
                headers(),
            )
            .await;
        assert_eq!(mismatch.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_handler_error(
            &mismatch.body,
            "IDEMPOTENCY_KEY_REUSED",
            "The idempotency key was already used for a different request.",
        );

        let precondition_mismatch = app
            .api_json(
                Method::PATCH,
                &uri,
                Some(json!({ "encryptedData": "first", "encryptionIv": "iv" })),
                idempotent_item_headers(&session.token, 2, "mismatch-key"),
            )
            .await;
        assert_eq!(
            precondition_mismatch.status,
            StatusCode::UNPROCESSABLE_ENTITY
        );
        assert_eq!(
            precondition_mismatch.body["code"],
            json!("IDEMPOTENCY_KEY_REUSED")
        );
    })
    .await;
}

#[tokio::test]
async fn completed_item_idempotency_records_expire_after_twenty_four_hours() {
    with_api_test_app(
        "completed_item_idempotency_expiry",
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            let session = app.issue_session(&fixture.owner_user_id).await;
            let uri = format!("/api/v1/items/{}", fixture.active_item_id);
            let first = app
                .api_json(
                    Method::PATCH,
                    &uri,
                    Some(json!({ "encryptedData": "first", "encryptionIv": "iv" })),
                    idempotent_item_headers(&session.token, 1, "expiry-key"),
                )
                .await;
            assert_eq!(first.status, StatusCode::OK);
            query("UPDATE idempotency_record SET expires_at = NOW() - INTERVAL '1 second' WHERE idempotency_key = $1")
                .bind("expiry-key")
                .execute(&app.pool)
                .await
                .expect("idempotency record should expire");

            let after_expiry = app
                .api_json(
                    Method::PATCH,
                    &uri,
                    Some(json!({ "encryptedData": "second", "encryptionIv": "iv-2" })),
                    idempotent_item_headers(&session.token, 2, "expiry-key"),
                )
                .await;
            assert_eq!(after_expiry.status, StatusCode::OK);
            let version: i32 = query_scalar("SELECT version FROM item WHERE id = $1")
                .bind(&fixture.active_item_id)
                .fetch_one(&app.pool)
                .await
                .expect("item version should load");
            assert_eq!(version, 3);
        },
    )
    .await;
}

#[tokio::test]
async fn restore_move_and_favorite_commands_replay_idempotently() {
    with_api_test_app("restore_move_favorite_idempotency", |app| async move {
        let fixture = build_vault_router_fixture(&app.pool).await;
        let session = app.issue_session(&fixture.owner_user_id).await;

        let restore_uri = format!("/api/v1/items/{}/restore", fixture.deleted_item_id);
        for _ in 0..2 {
            let response = app
                .api_json(
                    Method::POST,
                    &restore_uri,
                    None,
                    idempotent_item_headers(&session.token, 1, "restore-command-key"),
                )
                .await;
            assert_eq!(response.status, StatusCode::OK);
        }

        let favorite_uri = format!("/api/v1/items/{}/favorite", fixture.active_item_id);
        for _ in 0..2 {
            let response = app
                .api_json(
                    Method::PATCH,
                    &favorite_uri,
                    Some(json!({ "favorite": true })),
                    idempotent_item_headers(&session.token, 1, "favorite-command-key"),
                )
                .await;
            assert_eq!(response.status, StatusCode::OK);
        }

        let move_uri = format!("/api/v1/items/{}/moves", fixture.movable_item_id);
        let move_body = json!({
            "sourceVaultId": fixture.main_vault_id,
            "targetVaultId": fixture.target_vault_id,
            "encryptedData": "moved-idempotently",
            "encryptionIv": "moved-iv"
        });
        for _ in 0..2 {
            let response = app
                .api_json(
                    Method::POST,
                    &move_uri,
                    Some(move_body.clone()),
                    idempotent_item_headers(&session.token, 1, "move-command-key"),
                )
                .await;
            assert_eq!(response.status, StatusCode::OK);
        }

        for item_id in [
            fixture.deleted_item_id,
            fixture.active_item_id,
            fixture.movable_item_id,
        ] {
            let version: i32 = query_scalar("SELECT version FROM item WHERE id = $1")
                .bind(item_id)
                .fetch_one(&app.pool)
                .await
                .expect("item version should load");
            assert_eq!(version, 2);
        }
    })
    .await;
}

#[tokio::test]
async fn vault_item_mutation_handlers_reject_invalid_state_and_access() {
    with_api_test_app(
        "vault_item_mutation_handlers_reject_invalid_state_and_access",
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            let owner_session = app.issue_session(&fixture.owner_user_id).await;
            let readonly_session = app.issue_session(&fixture.readonly_user_id).await;
            let owner_headers = authenticated_json_headers(&owner_session.token);
            let readonly_headers = authenticated_json_headers(&readonly_session.token);

            let readonly_create_response = app
                .api_json(Method::PUT, &format!("/api/v1/vaults/{}/items/{}", fixture.main_vault_id, "item_explicit_request"), Some(json!({ "category": "login", "encryptedData": "enc", "encryptionIv": "iv" })), readonly_headers.clone())
                .await;
            readonly_create_response.assert_contract_status();
            assert_handler_error(
                &readonly_create_response.body,
                "FORBIDDEN",
                "Read-only access cannot create items",
            );

            let readonly_update_response = app
                .api_json(Method::PATCH, &format!("/api/v1/items/{}", fixture.active_item_id), Some(json!({ "encryptedData": "enc" })), with_if_match(readonly_headers, 1))
                .await;
            readonly_update_response.assert_contract_status();
            assert_handler_error(&readonly_update_response.body, "FORBIDDEN", "Access denied");

            let duplicate_import_response = app
                .api_json(Method::POST, &format!("/api/v1/vaults/{}/item-imports", fixture.owner_personal_vault_id), Some(json!({ "items": [
                            {
                                "itemId": "duplicate_item",
                                "category": "login",
                                "encryptedData": "duplicate-a",
                                "encryptionIv": "duplicate-a-iv"
                            },
                            {
                                "itemId": "duplicate_item",
                                "category": "login",
                                "encryptedData": "duplicate-b",
                                "encryptionIv": "duplicate-b-iv"
                            }
                        ] })), owner_headers.clone())
                .await;
            duplicate_import_response.assert_contract_status();
            assert_handler_error(
                &duplicate_import_response.body,
                "BAD_REQUEST",
                "Duplicate item IDs in import payload",
            );

            let stale_update_response = app
                .api_json(Method::PATCH, &format!("/api/v1/items/{}", fixture.active_item_id), Some(json!({ "encryptedData": "stale-update" })), with_if_match(owner_headers.clone(), 99))
                .await;
            stale_update_response.assert_contract_status();
            assert_handler_error(
                &stale_update_response.body,
                "VERSION_CONFLICT",
                "Item has been modified by another client",
            );

            let restore_active_response = app
                .api_json(Method::POST, &format!("/api/v1/items/{}/restore", fixture.active_item_id), None, with_if_match(owner_headers.clone(), 1))
                .await;
            restore_active_response.assert_contract_status();
            assert_handler_error(
                &restore_active_response.body,
                "BAD_REQUEST",
                "Item is not deleted",
            );

            let wrong_source_response = app
                .api_json(Method::POST, &format!("/api/v1/items/{}/moves", fixture.movable_item_id), Some(json!({ "sourceVaultId": fixture.target_vault_id, "targetVaultId": fixture.main_vault_id, "encryptedData": "enc", "encryptionIv": "iv" })), with_if_match(owner_headers.clone(), 1))
                .await;
            wrong_source_response.assert_contract_status();
            assert_handler_error(
                &wrong_source_response.body,
                "BAD_REQUEST",
                "Item does not belong to the source vault",
            );

            let permanent_delete_active_response = app
                .api_json(Method::DELETE, &format!("/api/v1/items/{}/permanent", fixture.active_item_id), None, with_if_match(owner_headers, 1))
                .await;
            permanent_delete_active_response.assert_contract_status();
            assert_handler_error(
                &permanent_delete_active_response.body,
                "BAD_REQUEST",
                "Can only permanently delete items in trash",
            );
        },
    )
    .await;
}

#[tokio::test]
async fn vault_management_handlers_manage_vault_lifecycle() {
    with_api_test_app(
            "vault_management_handlers_manage_vault_lifecycle",
            |app| async move {
                let fixture = build_vault_router_fixture(&app.pool).await;
                let owner_session = app.issue_session(&fixture.owner_user_id).await;
                let admin_session = app.issue_session(&fixture.admin_user_id).await;
                let solo_session = app.issue_session(&fixture.solo_user_id).await;
                let owner_headers = authenticated_json_headers(&owner_session.token);
                let admin_headers = authenticated_json_headers(&admin_session.token);
                let solo_headers = authenticated_json_headers(&solo_session.token);
                let created_personal_vault_id = "vault_created_personal";
                let created_team_vault_id = "vault_created_team";

                let create_personal_response = app
                    .api_json(Method::PUT, &format!("/api/v1/vaults/{}", created_personal_vault_id), Some(json!({ "name": "Created Personal Vault", "vaultType": "personal", "encryptedVaultKey": "created-personal-key" })), solo_headers.clone())
                    .await;
                create_personal_response.assert_contract_status();
                let created_personal_type: String =
                    query_scalar("SELECT type::text FROM vault WHERE id = $1")
                        .bind(created_personal_vault_id)
                        .fetch_one(&app.pool)
                        .await
                        .expect("created personal vault type should load");
                let created_personal_team_id: Option<String> =
                    query_scalar("SELECT team_id FROM vault WHERE id = $1")
                        .bind(created_personal_vault_id)
                        .fetch_one(&app.pool)
                        .await
                        .expect("created personal team id should load");
                assert_eq!(created_personal_type, "personal");
                assert!(created_personal_team_id.is_none());

                let create_team_response = app
                    .api_json(Method::PUT, &format!("/api/v1/vaults/{}", created_team_vault_id), Some(json!({ "name": "Created Team Vault", "vaultType": "team", "encryptedVaultKey": "created-team-key" })), owner_headers.clone())
                    .await;
                create_team_response.assert_contract_status();
                let created_team_type: String =
                    query_scalar("SELECT type::text FROM vault WHERE id = $1")
                        .bind(created_team_vault_id)
                        .fetch_one(&app.pool)
                        .await
                        .expect("created team vault type should load");
                let created_team_team_id: Option<String> =
                    query_scalar("SELECT team_id FROM vault WHERE id = $1")
                        .bind(created_team_vault_id)
                        .fetch_one(&app.pool)
                        .await
                        .expect("created team vault team id should load");
                assert_eq!(created_team_type, "team");
                assert_eq!(
                    created_team_team_id.as_deref(),
                    Some(fixture.paid_team_id.as_str())
                );

                let update_response = app
                    .api_json(Method::PATCH, &format!("/api/v1/vaults/{}", fixture.main_vault_id), Some(json!({ "name": "Updated Main Vault", "icon": "briefcase" })), admin_headers)
                    .await;
                update_response.assert_contract_status();
                assert_eq!(
                    update_response.body["name"],
                    json!("Updated Main Vault")
                );
                let updated_name: String = query_scalar("SELECT name FROM vault WHERE id = $1")
                    .bind(&fixture.main_vault_id)
                    .fetch_one(&app.pool)
                    .await
                    .expect("updated vault name should load");
                let updated_icon: Option<String> =
                    query_scalar("SELECT icon FROM vault WHERE id = $1")
                        .bind(&fixture.main_vault_id)
                        .fetch_one(&app.pool)
                        .await
                        .expect("updated vault icon should load");
                assert_eq!(updated_name, "Updated Main Vault");
                assert_eq!(updated_icon.as_deref(), Some("briefcase"));

                let convert_to_team_response = app
                    .api_json(Method::POST, &format!("/api/v1/vaults/{}/type-conversions", fixture.owner_personal_vault_id), Some(json!({ "targetType": "team" })), owner_headers.clone())
                    .await;
                convert_to_team_response.assert_contract_status();
                assert_eq!(
                    convert_to_team_response.body["previousType"],
                    json!("personal")
                );
                let converted_personal_type: String =
                    query_scalar("SELECT type::text FROM vault WHERE id = $1")
                        .bind(&fixture.owner_personal_vault_id)
                        .fetch_one(&app.pool)
                        .await
                        .expect("converted personal vault type should load");
                let converted_personal_team_id: Option<String> =
                    query_scalar("SELECT team_id FROM vault WHERE id = $1")
                        .bind(&fixture.owner_personal_vault_id)
                        .fetch_one(&app.pool)
                        .await
                        .expect("converted personal vault team id should load");
                assert_eq!(converted_personal_type, "team");
                assert_eq!(
                    converted_personal_team_id.as_deref(),
                    Some(fixture.paid_team_id.as_str())
                );

                let convert_to_personal_response = app
                    .api_json(Method::POST, &format!("/api/v1/vaults/{}/type-conversions", fixture.target_vault_id), Some(json!({ "targetType": "personal", "personalEncryptedVaultKey": "target-personal-key" })), owner_headers.clone())
                    .await;
                convert_to_personal_response.assert_contract_status();
                assert_eq!(
                    convert_to_personal_response.body["newType"],
                    json!("personal")
                );
                let converted_target_type: String =
                    query_scalar("SELECT type::text FROM vault WHERE id = $1")
                        .bind(&fixture.target_vault_id)
                        .fetch_one(&app.pool)
                        .await
                        .expect("converted target vault type should load");
                let converted_target_team_id: Option<String> =
                    query_scalar("SELECT team_id FROM vault WHERE id = $1")
                        .bind(&fixture.target_vault_id)
                        .fetch_one(&app.pool)
                        .await
                        .expect("converted target vault team id should load");
                let converted_target_key: String = query_scalar(
				"SELECT encrypted_vault_key FROM vault_key WHERE vault_id = $1 AND user_id = $2",
			)
			.bind(&fixture.target_vault_id)
			.bind(&fixture.owner_user_id)
			.fetch_one(&app.pool)
			.await
			.expect("converted target key should load");
                assert_eq!(converted_target_type, "personal");
                assert!(converted_target_team_id.is_none());
                assert_eq!(converted_target_key, "target-personal-key");

                let delete_response = app
                    .api_json(Method::DELETE, &format!("/api/v1/vaults/{}", created_personal_vault_id), None, solo_headers)
                    .await;
                delete_response.assert_contract_status();
                let remaining_rows: i64 =
                    query_scalar("SELECT COUNT(*)::bigint FROM vault WHERE id = $1")
                        .bind(created_personal_vault_id)
                        .fetch_one(&app.pool)
                        .await
                        .expect("remaining vault rows should load");
                assert_eq!(remaining_rows, 0);
            },
        )
        .await;
}

#[tokio::test]
async fn vault_management_handlers_enforce_access_and_validation() {
    with_api_test_app("vault_management_handlers_enforce_access_and_validation", |app| async move {
			let fixture = build_vault_router_fixture(&app.pool).await;
			let owner_session = app.issue_session(&fixture.owner_user_id).await;
			let admin_session = app.issue_session(&fixture.admin_user_id).await;
			let member_session = app.issue_session(&fixture.member_user_id).await;
			let solo_session = app.issue_session(&fixture.solo_user_id).await;
			let owner_headers = authenticated_json_headers(&owner_session.token);
			let admin_headers = authenticated_json_headers(&admin_session.token);
			let member_headers = authenticated_json_headers(&member_session.token);
			let solo_headers = authenticated_json_headers(&solo_session.token);

			let solo_team_create_response = app
				.api_json(Method::PUT, &format!("/api/v1/vaults/{}", "vault_explicit_request"), Some(json!({ "name": "No Team Vault", "vaultType": "team", "encryptedVaultKey": "wrapped" })), solo_headers)
				.await;
			solo_team_create_response.assert_contract_status();
			assert_handler_error(
				&solo_team_create_response.body,
				"BAD_REQUEST",
				"You must belong to a team to create a team vault",
			);

			let blank_update_response = app
				.api_json(Method::PATCH, &format!("/api/v1/vaults/{}", fixture.main_vault_id), Some(json!({ "name": "   " })), owner_headers.clone())
				.await;
			blank_update_response.assert_contract_status();
			assert_handler_error(&blank_update_response.body, "BAD_REQUEST", "Invalid params");

			let member_update_response = app
				.api_json(Method::PATCH, &format!("/api/v1/vaults/{}", fixture.main_vault_id), Some(json!({ "name": "Blocked Update" })), member_headers.clone())
				.await;
			member_update_response.assert_contract_status();
			assert_handler_error(&member_update_response.body, "FORBIDDEN", "Access denied");

			let admin_convert_response = app
				.api_json(Method::POST, &format!("/api/v1/vaults/{}/type-conversions", fixture.main_vault_id), Some(json!({ "targetType": "personal" })), admin_headers)
				.await;
			admin_convert_response.assert_contract_status();
			assert_handler_error(
				&admin_convert_response.body,
				"FORBIDDEN",
				"Only the vault owner can convert vault type",
			);

			let same_type_response = app
				.api_json(Method::POST, &format!("/api/v1/vaults/{}/type-conversions", fixture.main_vault_id), Some(json!({ "targetType": "team" })), owner_headers.clone())
				.await;
			same_type_response.assert_contract_status();
			assert_handler_error(
				&same_type_response.body,
				"BAD_REQUEST",
				"Vault is already the requested type",
			);

			let member_delete_response = app
				.api_json(Method::DELETE, &format!("/api/v1/vaults/{}", fixture.main_vault_id), None, member_headers)
				.await;
			member_delete_response.assert_contract_status();
			assert_handler_error(
				&member_delete_response.body,
				"FORBIDDEN",
				"Only the vault owner can delete the vault",
			);

			set_team_billing(&app.pool, &fixture.paid_team_id, "free", "active").await;
			let plan_forbidden_create_response = with_bittery_mode_async(
				Some("cloud"),
				app.api_json(Method::PUT, &format!("/api/v1/vaults/{}", "vault_explicit_request"), Some(json!({ "name": "Blocked Team Vault", "vaultType": "team", "encryptedVaultKey": "blocked-key" })), owner_headers),
			)
			.await;
			plan_forbidden_create_response.assert_contract_status();
			assert_handler_error(
				&plan_forbidden_create_response.body,
				"FORBIDDEN",
				"Shared vaults are only available on Family or Team plans with active billing.",
			);
		})
		.await;
}

#[tokio::test]
async fn vault_key_write_routes_reject_oversized_keys() {
    with_api_test_app("vault_key_write_limits", |app| async move {
        let fixture = build_vault_router_fixture(&app.pool).await;
        let session = app.issue_session(&fixture.owner_user_id).await;
        let headers = authenticated_json_headers(&session.token);
        let oversized =
            "k".repeat(crate::services::vault_key::ENCRYPTED_VAULT_KEY_MAX_BYTES + 1);
        let requests = [
            (
                Method::PUT,
                "/api/v1/vaults/vault_oversized_key".to_string(),
                json!({ "name": "Oversized", "vaultType": "personal", "encryptedVaultKey": oversized.clone() }),
            ),
            (
                Method::PUT,
                format!(
                    "/api/v1/vaults/{}/members/{}",
                    fixture.main_vault_id, fixture.addable_user_id
                ),
                json!({ "role": "member", "encryptedVaultKey": oversized.clone() }),
            ),
            (
                Method::POST,
                format!(
                    "/api/v1/vaults/{}/type-conversions",
                    fixture.main_vault_id
                ),
                json!({ "targetType": "personal", "personalEncryptedVaultKey": oversized.clone() }),
            ),
            (
                Method::DELETE,
                format!(
                    "/api/v1/vaults/{}/members/{}",
                    fixture.main_vault_id, fixture.member_user_id
                ),
                json!({ "keyRotation": {
                    "memberKeys": [{ "userId": fixture.owner_user_id, "encryptedVaultKey": oversized }],
                    "reEncryptedItems": []
                } }),
            ),
        ];
        for (method, path, body) in requests {
            let response = app
                .api_json(method, &path, Some(body), headers.clone())
                .await;
            assert_eq!(response.status, axum::http::StatusCode::BAD_REQUEST);
            assert_eq!(response.body["code"], json!("BAD_REQUEST"));
        }
    })
    .await;
}

#[tokio::test]
async fn vault_attachment_handlers_cover_presign_and_access_paths() {
    with_storage_env_async(async {
			with_api_test_app("vault_attachment_handlers_cover_presign_and_access_paths", |app| async move {
				let fixture = build_vault_router_fixture(&app.pool).await;
				let owner_session = app.issue_session(&fixture.owner_user_id).await;
				let readonly_session = app.issue_session(&fixture.readonly_user_id).await;
				let member_session = app.issue_session(&fixture.member_user_id).await;
				let owner_headers = authenticated_json_headers(&owner_session.token);
				let readonly_headers = authenticated_json_headers(&readonly_session.token);
				let member_headers = authenticated_json_headers(&member_session.token);

				let image_upload_response = app
					.api_json(Method::POST, &format!("/api/v1/vaults/{}/image-uploads", fixture.main_vault_id), Some(json!({ "fileName": "cover.png", "contentType": "image/png" })), owner_headers.clone())
					.await;
				image_upload_response.assert_contract_status();
				let image_key = image_upload_response.body["key"]
					.as_str()
					.expect("image upload key should exist");
				assert!(image_key.starts_with(&format!(
					"vaults/{}/{}/",
					fixture.owner_user_id, fixture.main_vault_id
				)));
				let image_public_url = image_upload_response.body["publicUrl"]
					.as_str()
					.expect("image public url should exist");
				assert!(image_public_url.contains("cdn.example.invalid/assets/vaults/"));

				let blocked_image_upload_response = app
					.api_json(Method::POST, &format!("/api/v1/vaults/{}/image-uploads", fixture.main_vault_id), Some(json!({ "fileName": "blocked.png", "contentType": "image/png" })), readonly_headers)
					.await;
				blocked_image_upload_response.assert_contract_status();
				assert_handler_error(&blocked_image_upload_response.body, "FORBIDDEN", "Access denied");

				let invalid_attachment_upload_response = app
					.api_json(Method::POST, &format!("/api/v1/items/{}/attachment-uploads", fixture.active_item_id), Some(json!({ "fileName": "   ", "contentType": "application/octet-stream", "fileSize": 4 })), owner_headers.clone())
					.await;
				invalid_attachment_upload_response.assert_contract_status();
				assert_handler_error(
					&invalid_attachment_upload_response.body,
					"BAD_REQUEST",
					"Invalid attachment upload request",
				);

				let attachment_upload_response = app
					.api_json(Method::POST, &format!("/api/v1/items/{}/attachment-uploads", fixture.active_item_id), Some(json!({ "fileName": "attachment.bin", "contentType": "application/octet-stream", "fileSize": 4 })), owner_headers.clone())
					.await;
				attachment_upload_response.assert_contract_status();
				let attachment_upload_key = attachment_upload_response.body["key"]
					.as_str()
					.expect("attachment upload key should exist");
				assert!(attachment_upload_key.starts_with(&format!(
					"attachments/{}/{}/",
					fixture.owner_user_id, fixture.active_item_id
				)));
				assert_eq!(attachment_upload_response.body["publicUrl"], Value::Null);
				let pending_storage_size: i32 = query_scalar(
					"SELECT storage_size FROM pending_attachment_upload WHERE item_id = $1 AND created_by = $2 ORDER BY created_at DESC LIMIT 1",
				)
				.bind(&fixture.active_item_id)
				.bind(&fixture.owner_user_id)
				.fetch_one(&app.pool)
				.await
				.expect("pending attachment storage size should load");
				assert_eq!(pending_storage_size, 102);

				let create_attachment_response = app
					.api_json(Method::POST, &format!("/api/v1/items/{}/attachments", fixture.active_item_id), Some(json!({ "storageKey": "invalid-key", "encryptedName": "encrypted-name", "encryptedContentType": "encrypted-content-type", "encryptionIv": "attachment-iv", "encryptedContentTypeIv": "content-type-iv", "fileSize": 4 })), owner_headers.clone())
					.await;
				create_attachment_response.assert_contract_status();
				assert_handler_error(
					&create_attachment_response.body,
					"BAD_REQUEST",
					"Invalid or expired attachment upload key",
				);

				let list_attachments_response = app
					.api_json(Method::GET, &format!("/api/v1/items/{}/attachments", fixture.active_item_id), None, owner_headers.clone())
					.await;
				list_attachments_response.assert_contract_status();
				let attachments = list_attachments_response.body
					.get("items")
					.and_then(Value::as_array)
					.expect("attachments should be returned");
				assert_eq!(attachments.len(), 1);
				assert_eq!(attachments[0]["id"], json!(fixture.attachment_id));

				let download_response = app
					.api_json(Method::POST, &format!("/api/v1/attachments/{}/download-urls", fixture.attachment_id), None, owner_headers.clone())
					.await;
				download_response.assert_contract_status();
				let download_url = download_response.body["downloadUrl"]
					.as_str()
					.expect("download url should exist");
				assert!(download_url.contains("storage.example.invalid"));
				assert_eq!(download_response.body["fileSize"], json!(128));

				let update_attachment_response = app
					.api_json(Method::PATCH, &format!("/api/v1/attachments/{}", fixture.attachment_id), Some(json!({ "encryptedName": "updated-encrypted-name", "encryptionIv": "updated-attachment-iv" })), owner_headers.clone())
					.await;
				update_attachment_response.assert_contract_status();
				let updated_attachment_name: String =
					query_scalar("SELECT encrypted_name FROM item_attachment WHERE id = $1")
						.bind(&fixture.attachment_id)
						.fetch_one(&app.pool)
						.await
						.expect("updated attachment name should load");
				let updated_attachment_iv: String =
					query_scalar("SELECT encryption_iv FROM item_attachment WHERE id = $1")
						.bind(&fixture.attachment_id)
						.fetch_one(&app.pool)
						.await
						.expect("updated attachment iv should load");
				assert_eq!(updated_attachment_name, "updated-encrypted-name");
				assert_eq!(updated_attachment_iv, "updated-attachment-iv");

				let blocked_delete_response = app
					.api_json(Method::DELETE, &format!("/api/v1/attachments/{}", fixture.attachment_id), None, member_headers)
					.await;
				blocked_delete_response.assert_contract_status();
				assert_handler_error(
					&blocked_delete_response.body,
					"FORBIDDEN",
					"You can only delete your own attachments",
				);
			})
			.await;
		})
		.await;
}

#[tokio::test]
async fn vault_member_handlers_manage_members_and_rotation() {
    with_api_test_app(
        "vault_member_handlers_manage_members_and_rotation",
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            let owner_session = app.issue_session(&fixture.owner_user_id).await;
            let owner_headers = authenticated_json_headers(&owner_session.token);
            let starting_key_version: i32 =
                query_scalar("SELECT key_version FROM vault WHERE id = $1")
                    .bind(&fixture.main_vault_id)
                    .fetch_one(&app.pool)
                    .await
                    .expect("starting key version should load");

            let members_response = app
                .api_json(
                    Method::GET,
                    &format!("/api/v1/vaults/{}/members", fixture.main_vault_id),
                    None,
                    owner_headers.clone(),
                )
                .await;
            members_response.assert_contract_status();
            let members = members_response
                .body
                .get("items")
                .and_then(Value::as_array)
                .expect("members should be returned");
            assert_eq!(members.len(), 4);
            assert!(members
                .iter()
                .any(|member| member["userId"] == json!(fixture.readonly_user_id)));

            let available_members_response = app
                .api_json(
                    Method::GET,
                    &format!(
                        "/api/v1/vaults/{}/available-team-members",
                        fixture.main_vault_id
                    ),
                    None,
                    owner_headers.clone(),
                )
                .await;
            available_members_response.assert_contract_status();
            let available_members = available_members_response
                .body
                .get("items")
                .and_then(Value::as_array)
                .expect("available members should be returned");
            assert!(available_members
                .iter()
                .any(|member| member["userId"] == json!(fixture.addable_user_id)));
            assert!(!available_members
                .iter()
                .any(|member| member["userId"] == json!(fixture.member_user_id)));

            let update_role_response = app
                .api_json(
                    Method::PATCH,
                    &format!(
                        "/api/v1/vaults/{}/members/{}",
                        fixture.main_vault_id, fixture.readonly_user_id
                    ),
                    Some(json!({ "role": "member" })),
                    owner_headers.clone(),
                )
                .await;
            update_role_response.assert_contract_status();
            let updated_role: String = query_scalar(
                "SELECT role::text FROM vault_key WHERE vault_id = $1 AND user_id = $2",
            )
            .bind(&fixture.main_vault_id)
            .bind(&fixture.readonly_user_id)
            .fetch_one(&app.pool)
            .await
            .expect("updated vault role should load");
            assert_eq!(updated_role, "member");

            let add_member_response = app
                .api_json(
                    Method::PUT,
                    &format!(
                        "/api/v1/vaults/{}/members/{}",
                        fixture.main_vault_id, fixture.addable_user_id
                    ),
                    Some(json!({ "role": "member", "encryptedVaultKey": "addable-member-key" })),
                    owner_headers.clone(),
                )
                .await;
            add_member_response.assert_contract_status();
            let added_member_count: i64 = query_scalar(
                "SELECT COUNT(*)::bigint FROM vault_key WHERE vault_id = $1 AND user_id = $2",
            )
            .bind(&fixture.main_vault_id)
            .bind(&fixture.addable_user_id)
            .fetch_one(&app.pool)
            .await
            .expect("added member count should load");
            assert_eq!(added_member_count, 1);

            let rotation_data_response = app
                .api_json(
                    Method::GET,
                    &format!(
                        "/api/v1/vaults/{}/members/{}/removal-rotation-data",
                        fixture.main_vault_id, fixture.member_user_id
                    ),
                    None,
                    owner_headers.clone(),
                )
                .await;
            rotation_data_response.assert_contract_status();
            assert_eq!(
                rotation_data_response.body["keyVersion"],
                json!(starting_key_version)
            );
            let rotation_members = rotation_data_response.body["members"]
                .as_array()
                .expect("rotation members should be returned");
            assert!(!rotation_members
                .iter()
                .any(|member| member["userId"] == json!(fixture.member_user_id)));
            let rotation_items = rotation_data_response.body["items"]
                .as_array()
                .expect("rotation items should be returned");
            assert!(rotation_items
                .iter()
                .any(|item| item["id"] == json!(fixture.active_item_id)));

            let remove_member_response = app
                .api_json(
                    Method::DELETE,
                    &format!(
                        "/api/v1/vaults/{}/members/{}",
                        fixture.main_vault_id, fixture.addable_user_id
                    ),
                    Some(json!({ "keyRotation": {
                            "memberKeys": [],
                            "reEncryptedItems": []
                        } })),
                    owner_headers,
                )
                .await;
            remove_member_response.assert_contract_status();
            assert_eq!(
                remove_member_response.body["keyRotation"]["newKeyVersion"],
                json!(starting_key_version + 1)
            );
            let removed_member_count: i64 = query_scalar(
                "SELECT COUNT(*)::bigint FROM vault_key WHERE vault_id = $1 AND user_id = $2",
            )
            .bind(&fixture.main_vault_id)
            .bind(&fixture.addable_user_id)
            .fetch_one(&app.pool)
            .await
            .expect("removed member count should load");
            let ending_key_version: i32 =
                query_scalar("SELECT key_version FROM vault WHERE id = $1")
                    .bind(&fixture.main_vault_id)
                    .fetch_one(&app.pool)
                    .await
                    .expect("ending key version should load");
            assert_eq!(removed_member_count, 0);
            assert_eq!(ending_key_version, starting_key_version + 1);
        },
    )
    .await;
}

#[tokio::test]
async fn vault_member_handlers_reject_invalid_and_forbidden_requests() {
    with_api_test_app(
        "vault_member_handlers_reject_invalid_and_forbidden_requests",
        |app| async move {
            let fixture = build_vault_router_fixture(&app.pool).await;
            let owner_session = app.issue_session(&fixture.owner_user_id).await;
            let admin_session = app.issue_session(&fixture.admin_user_id).await;
            let member_session = app.issue_session(&fixture.member_user_id).await;
            let owner_headers = authenticated_json_headers(&owner_session.token);
            let admin_headers = authenticated_json_headers(&admin_session.token);
            let member_headers = authenticated_json_headers(&member_session.token);

            let blocked_available_response = app
                .api_json(
                    Method::GET,
                    &format!(
                        "/api/v1/vaults/{}/available-team-members",
                        fixture.main_vault_id
                    ),
                    None,
                    member_headers.clone(),
                )
                .await;
            blocked_available_response.assert_contract_status();
            assert_handler_error(
                &blocked_available_response.body,
                "FORBIDDEN",
                "Only vault owner or admin can manage members",
            );

            let self_role_response = app
                .api_json(
                    Method::PATCH,
                    &format!(
                        "/api/v1/vaults/{}/members/{}",
                        fixture.main_vault_id, fixture.owner_user_id
                    ),
                    Some(json!({ "role": "member" })),
                    owner_headers.clone(),
                )
                .await;
            self_role_response.assert_contract_status();
            assert_handler_error(
                &self_role_response.body,
                "BAD_REQUEST",
                "Cannot change your own role",
            );

            let owner_role_response = app
                .api_json(
                    Method::PATCH,
                    &format!(
                        "/api/v1/vaults/{}/members/{}",
                        fixture.main_vault_id, fixture.owner_user_id
                    ),
                    Some(json!({ "role": "member" })),
                    admin_headers,
                )
                .await;
            owner_role_response.assert_contract_status();
            assert_handler_error(
                &owner_role_response.body,
                "FORBIDDEN",
                "Cannot change vault owner's role",
            );

            let missing_member_response = app
                .api_json(
                    Method::PATCH,
                    &format!(
                        "/api/v1/vaults/{}/members/{}",
                        fixture.main_vault_id, "missing_member_user"
                    ),
                    Some(json!({ "role": "member" })),
                    owner_headers.clone(),
                )
                .await;
            missing_member_response.assert_contract_status();
            assert_handler_error(
                &missing_member_response.body,
                "NOT_FOUND",
                "Member not found",
            );

            let wrong_team_add_response = app
                .api_json(
                    Method::PUT,
                    &format!(
                        "/api/v1/vaults/{}/members/{}",
                        fixture.main_vault_id, fixture.outsider_user_id
                    ),
                    Some(json!({ "role": "member", "encryptedVaultKey": "outsider-key" })),
                    owner_headers.clone(),
                )
                .await;
            wrong_team_add_response.assert_contract_status();
            assert_handler_error(
                &wrong_team_add_response.body,
                "BAD_REQUEST",
                "User must belong to the same team as this vault",
            );

            let blocked_rotation_response = app
                .api_json(
                    Method::GET,
                    &format!(
                        "/api/v1/vaults/{}/members/{}/removal-rotation-data",
                        fixture.main_vault_id, fixture.member_user_id
                    ),
                    None,
                    member_headers,
                )
                .await;
            blocked_rotation_response.assert_contract_status();
            assert_handler_error(
                &blocked_rotation_response.body,
                "FORBIDDEN",
                "Only vault owner or admin can manage members",
            );

            let self_remove_response = app
                .api_json(
                    Method::DELETE,
                    &format!(
                        "/api/v1/vaults/{}/members/{}",
                        fixture.main_vault_id, fixture.owner_user_id
                    ),
                    Some(json!({ "keyRotation": {
                            "memberKeys": [],
                            "reEncryptedItems": []
                        } })),
                    owner_headers,
                )
                .await;
            self_remove_response.assert_contract_status();
            assert_handler_error(
                &self_remove_response.body,
                "BAD_REQUEST",
                "Cannot remove yourself",
            );
        },
    )
    .await;
}
