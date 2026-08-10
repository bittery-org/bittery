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
			let protected_calls = vec![
				("vault.list", json!([])),
				("vault.get", json!([{ "vaultId": "vault_test" }])),
				(
					"vault.createImageUpload",
					json!([{ "fileName": "vault.png", "contentType": "image/png" }]),
				),
				(
					"vault.createAttachmentUpload",
					json!([{
						"itemId": "item_test",
						"fileName": "attachment.bin",
						"contentType": "application/octet-stream",
						"fileSize": 4
					}]),
				),
				(
					"vault.createAttachment",
					json!([{
						"itemId": "item_test",
						"storageKey": "key",
						"encryptedName": "name",
						"encryptedContentType": "type",
						"encryptionIv": "iv",
						"encryptedContentTypeIv": "type-iv",
						"fileSize": 4
					}]),
				),
				("vault.listAttachments", json!([{ "itemId": "item_test" }])),
				(
					"vault.getAttachmentDownloadUrl",
					json!([{ "attachmentId": "attachment_test" }]),
				),
				(
					"vault.updateAttachment",
					json!([{
						"attachmentId": "attachment_test",
						"encryptedName": "name",
						"encryptionIv": "iv"
					}]),
				),
				("vault.deleteAttachment", json!([{ "attachmentId": "attachment_test" }])),
				(
					"vault.create",
					json!([{ "name": "Vault", "vaultType": "personal", "encryptedVaultKey": "wrapped-key" }]),
				),
				("vault.update", json!([{ "vaultId": "vault_test" }])),
				(
					"vault.convertType",
					json!([{ "vaultId": "vault_test", "targetType": "team" }]),
				),
				("vault.delete", json!([{ "vaultId": "vault_test" }])),
				("vault.listItems", json!([{ "vaultId": "vault_test" }])),
				("vault.listAllItems", json!([])),
				("vault.listAllDeletedItems", json!([])),
				("vault.getItem", json!([{ "itemId": "item_test" }])),
				(
					"vault.createItem",
					json!([{ "vaultId": "vault_test", "category": "login", "encryptedData": "enc", "encryptionIv": "iv" }]),
				),
				(
					"vault.bulkImportItems",
					json!([{ "vaultId": "vault_test", "items": [] }]),
				),
				("vault.updateItem", json!([{ "itemId": "item_test" }])),
				(
					"vault.toggleFavorite",
					json!([{ "itemId": "item_test", "favorite": true }]),
				),
				("vault.deleteItem", json!([{ "itemId": "item_test" }])),
				("vault.listDeletedItems", json!([{ "vaultId": "vault_test" }])),
				("vault.restoreItem", json!([{ "itemId": "item_test" }])),
				(
					"vault.moveItem",
					json!([{
						"itemId": "item_test",
						"sourceVaultId": "vault_source",
						"targetVaultId": "vault_target",
						"encryptedData": "enc",
						"encryptionIv": "iv"
					}]),
				),
				("vault.permanentlyDeleteItem", json!([{ "itemId": "item_test" }])),
				("vault.stats", json!([])),
				("vault.members.list", json!([{ "vaultId": "vault_test" }])),
				(
					"vault.members.availableTeamMembers",
					json!([{ "vaultId": "vault_test" }]),
				),
				(
					"vault.members.updateRole",
					json!([{ "vaultId": "vault_test", "userId": "user_test", "role": "member" }]),
				),
				(
					"vault.members.add",
					json!([{ "vaultId": "vault_test", "userId": "user_test", "role": "member", "encryptedVaultKey": "wrapped-key" }]),
				),
				(
					"vault.members.getRotationData",
					json!([{ "vaultId": "vault_test", "excludeUserId": "user_test" }]),
				),
				(
					"vault.members.remove",
					json!([{ "vaultId": "vault_test", "userId": "user_test", "keyRotation": { "memberKeys": [], "reEncryptedItems": [] } }]),
				),
			];

			for (method, params) in protected_calls {
				let response = app
					.call_operation(method, params, unauthenticated_json_headers())
					.await;

				response.assert_contract_status();
				assert_transport_error(&response.body, "UNAUTHORIZED", "A valid bearer session is required.");
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

            for (method, params) in [
                ("vault.createAttachmentUpload", json!([{}])),
                ("vault.createAttachment", json!([{}])),
                ("vault.createItem", json!([{}])),
                (
                    "vault.members.remove",
                    json!([{ "vaultId": fixture.main_vault_id, "userId": fixture.member_user_id }]),
                ),
            ] {
                let response = app.call_operation(method, params, headers.clone()).await;

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
                .call_operation("vault.list", json!([]), owner_headers.clone())
                .await;
            list_response.assert_contract_status();
            let listed_vaults = list_response
                .body
                .as_array()
                .expect("vault.list should return an array");
            assert_eq!(listed_vaults.len(), 3);
            let main_vault = find_entry_by_id(listed_vaults, &fixture.main_vault_id);
            assert_eq!(main_vault["role"], json!("owner"));
            assert_eq!(main_vault["encryptedVaultKey"], json!("main-owner-key"));
            assert_eq!(main_vault["items"].as_array().unwrap().len(), 3);

            let get_response = app
                .call_operation(
                    "vault.get",
                    json!([{ "vaultId": fixture.main_vault_id }]),
                    owner_headers.clone(),
                )
                .await;
            get_response.assert_contract_status();
            assert_eq!(get_response.body["id"], json!(fixture.main_vault_id));
            assert_eq!(get_response.body["itemCount"], json!("2"));
            assert_eq!(get_response.body["memberCount"], json!("4"));

            let list_items_response = app
                .call_operation(
                    "vault.listItems",
                    json!([{ "vaultId": fixture.main_vault_id }]),
                    owner_headers.clone(),
                )
                .await;
            list_items_response.assert_contract_status();
            let list_items = list_items_response
                .body
                .as_array()
                .expect("vault.listItems should return an array");
            assert_eq!(list_items.len(), 2);
            let active_item = find_entry_by_id(list_items, &fixture.active_item_id);
            assert_eq!(active_item["attachments"].as_array().unwrap().len(), 1);
            assert_eq!(
                active_item["attachments"][0]["id"],
                json!(fixture.attachment_id)
            );

            let list_all_items_response = app
                .call_operation("vault.listAllItems", json!([]), owner_headers.clone())
                .await;
            list_all_items_response.assert_contract_status();
            let all_items = list_all_items_response
                .body
                .as_array()
                .expect("vault.listAllItems should return an array");
            assert_eq!(all_items.len(), 3);
            let personal_item = find_entry_by_id(all_items, &fixture.personal_item_id);
            assert_eq!(
                personal_item["vault"]["id"],
                json!(fixture.owner_personal_vault_id)
            );

            let list_all_deleted_response = app
                .call_operation(
                    "vault.listAllDeletedItems",
                    json!([]),
                    owner_headers.clone(),
                )
                .await;
            list_all_deleted_response.assert_contract_status();
            let all_deleted_items = list_all_deleted_response
                .body
                .as_array()
                .expect("vault.listAllDeletedItems should return an array");
            assert_eq!(all_deleted_items.len(), 1);
            assert_eq!(all_deleted_items[0]["id"], json!(fixture.deleted_item_id));

            let list_deleted_response = app
                .call_operation(
                    "vault.listDeletedItems",
                    json!([{ "vaultId": fixture.main_vault_id }]),
                    owner_headers.clone(),
                )
                .await;
            list_deleted_response.assert_contract_status();
            let deleted_items = list_deleted_response
                .body
                .as_array()
                .expect("vault.listDeletedItems should return an array");
            assert_eq!(deleted_items.len(), 1);
            assert_eq!(deleted_items[0]["id"], json!(fixture.deleted_item_id));

            let get_item_response = app
                .call_operation(
                    "vault.getItem",
                    json!([{ "itemId": fixture.active_item_id }]),
                    owner_headers.clone(),
                )
                .await;
            get_item_response.assert_contract_status();
            assert_eq!(get_item_response.body["id"], json!(fixture.active_item_id));

            let stats_response = app
                .call_operation("vault.stats", json!([]), owner_headers)
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
                .call_operation(
                    "vault.get",
                    json!([{ "vaultId": "vault_missing" }]),
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
                .call_operation(
                    "vault.listItems",
                    json!([{ "vaultId": fixture.main_vault_id }]),
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
                .call_operation(
                    "vault.getItem",
                    json!([{ "itemId": "item_missing" }]),
                    owner_headers.clone(),
                )
                .await;
            missing_item_response.assert_contract_status();
            assert_handler_error(&missing_item_response.body, "NOT_FOUND", "Item not found");

            let outsider_item_response = app
                .call_operation(
                    "vault.getItem",
                    json!([{ "itemId": fixture.active_item_id }]),
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
                .call_operation(
                    "vault.bulkImportItems",
                    json!([{ "vaultId": fixture.owner_personal_vault_id, "items": [] }]),
                    owner_headers.clone(),
                )
                .await;
            empty_import_response.assert_contract_status();
            assert_eq!(empty_import_response.body["importedCount"], json!(0));

            let create_item_response = app
                .call_operation(
                    "vault.createItem",
                    json!([{
                        "itemId": created_item_id,
                        "vaultId": fixture.owner_personal_vault_id,
                        "category": "login",
                        "encryptedData": "created-encrypted-data",
                        "encryptionIv": "created-iv"
                    }]),
                    owner_headers.clone(),
                )
                .await;
            create_item_response.assert_contract_status();
            assert_eq!(create_item_response.body["itemId"], json!(created_item_id));

            let bulk_import_response = app
                .call_operation(
                    "vault.bulkImportItems",
                    json!([{
                        "vaultId": fixture.owner_personal_vault_id,
                        "items": [
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
                        ]
                    }]),
                    owner_headers.clone(),
                )
                .await;
            bulk_import_response.assert_contract_status();
            assert_eq!(bulk_import_response.body["importedCount"], json!(2));

            let current_version: i32 = query_scalar("SELECT version FROM item WHERE id = $1")
                .bind(&fixture.active_item_id)
                .fetch_one(&app.pool)
                .await
                .expect("active item version should load");
            let update_response = app
                .call_operation(
                    "vault.updateItem",
                    json!([{
                        "itemId": fixture.active_item_id,
                        "encryptedData": "active-encrypted-data-updated",
                        "encryptionIv": "active-iv-updated",
                        "expectedVersion": current_version
                    }]),
                    owner_headers.clone(),
                )
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
                .call_operation(
                    "vault.toggleFavorite",
                    json!([{ "itemId": fixture.active_item_id, "favorite": true }]),
                    owner_headers.clone(),
                )
                .await;
            toggle_response.assert_contract_status();
            let favorite: bool = query_scalar("SELECT favorite FROM item WHERE id = $1")
                .bind(&fixture.active_item_id)
                .fetch_one(&app.pool)
                .await
                .expect("favorite flag should load");
            assert!(favorite);

            let delete_response = app
                .call_operation(
                    "vault.deleteItem",
                    json!([{ "itemId": imported_item_a }]),
                    owner_headers.clone(),
                )
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
                .call_operation(
                    "vault.restoreItem",
                    json!([{ "itemId": fixture.deleted_item_id }]),
                    owner_headers.clone(),
                )
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
                .call_operation(
                    "vault.moveItem",
                    json!([{
                        "itemId": fixture.movable_item_id,
                        "sourceVaultId": fixture.main_vault_id,
                        "targetVaultId": fixture.target_vault_id,
                        "encryptedData": "moved-encrypted-data",
                        "encryptionIv": "moved-iv"
                    }]),
                    owner_headers.clone(),
                )
                .await;
            move_response.assert_contract_status();
            let moved_vault_id: String = query_scalar("SELECT vault_id FROM item WHERE id = $1")
                .bind(&fixture.movable_item_id)
                .fetch_one(&app.pool)
                .await
                .expect("moved item vault id should load");
            assert_eq!(moved_vault_id, fixture.target_vault_id);

            let permanent_delete_response = app
                .call_operation(
                    "vault.permanentlyDeleteItem",
                    json!([{ "itemId": imported_item_a }]),
                    owner_headers,
                )
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
                    Method::PUT,
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
                .call_operation(
                    "vault.moveItem",
                    json!([{
                        "itemId": fixture.movable_item_id,
                        "sourceVaultId": fixture.main_vault_id,
                        "targetVaultId": fixture.target_vault_id,
                        "encryptedData": "moved-encrypted-data",
                        "encryptionIv": "moved-iv"
                    }]),
                    authenticated_json_headers(&readonly_session.token),
                )
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
                .call_operation(
                    "vault.createItem",
                    json!([{
                        "vaultId": fixture.main_vault_id,
                        "category": "login",
                        "encryptedData": "enc",
                        "encryptionIv": "iv"
                    }]),
                    readonly_headers.clone(),
                )
                .await;
            readonly_create_response.assert_contract_status();
            assert_handler_error(
                &readonly_create_response.body,
                "FORBIDDEN",
                "Read-only access cannot create items",
            );

            let readonly_update_response = app
                .call_operation(
                    "vault.updateItem",
                    json!([{
                        "itemId": fixture.active_item_id,
                        "encryptedData": "enc",
                        "expectedVersion": 1
                    }]),
                    readonly_headers,
                )
                .await;
            readonly_update_response.assert_contract_status();
            assert_handler_error(&readonly_update_response.body, "FORBIDDEN", "Access denied");

            let duplicate_import_response = app
                .call_operation(
                    "vault.bulkImportItems",
                    json!([{
                        "vaultId": fixture.owner_personal_vault_id,
                        "items": [
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
                        ]
                    }]),
                    owner_headers.clone(),
                )
                .await;
            duplicate_import_response.assert_contract_status();
            assert_handler_error(
                &duplicate_import_response.body,
                "BAD_REQUEST",
                "Duplicate item IDs in import payload",
            );

            let stale_update_response = app
                .call_operation(
                    "vault.updateItem",
                    json!([{
                        "itemId": fixture.active_item_id,
                        "encryptedData": "stale-update",
                        "expectedVersion": 99
                    }]),
                    owner_headers.clone(),
                )
                .await;
            stale_update_response.assert_contract_status();
            assert_handler_error(
                &stale_update_response.body,
                "VERSION_CONFLICT",
                "Item has been modified by another client",
            );

            let restore_active_response = app
                .call_operation(
                    "vault.restoreItem",
                    json!([{ "itemId": fixture.active_item_id }]),
                    owner_headers.clone(),
                )
                .await;
            restore_active_response.assert_contract_status();
            assert_handler_error(
                &restore_active_response.body,
                "BAD_REQUEST",
                "Item is not deleted",
            );

            let wrong_source_response = app
                .call_operation(
                    "vault.moveItem",
                    json!([{
                        "itemId": fixture.movable_item_id,
                        "sourceVaultId": fixture.target_vault_id,
                        "targetVaultId": fixture.main_vault_id,
                        "encryptedData": "enc",
                        "encryptionIv": "iv"
                    }]),
                    owner_headers.clone(),
                )
                .await;
            wrong_source_response.assert_contract_status();
            assert_handler_error(
                &wrong_source_response.body,
                "BAD_REQUEST",
                "Item does not belong to the source vault",
            );

            let permanent_delete_active_response = app
                .call_operation(
                    "vault.permanentlyDeleteItem",
                    json!([{ "itemId": fixture.active_item_id }]),
                    owner_headers,
                )
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
                    .call_operation(
                        "vault.create",
                        json!([{
                            "vaultId": created_personal_vault_id,
                            "name": "Created Personal Vault",
                            "vaultType": "personal",
                            "encryptedVaultKey": "created-personal-key"
                        }]),
                        solo_headers.clone(),
                    )
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
                    .call_operation(
                        "vault.create",
                        json!([{
                            "vaultId": created_team_vault_id,
                            "name": "Created Team Vault",
                            "vaultType": "team",
                            "encryptedVaultKey": "created-team-key"
                        }]),
                        owner_headers.clone(),
                    )
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
                    .call_operation(
                        "vault.update",
                        json!([{
                            "vaultId": fixture.main_vault_id,
                            "name": "Updated Main Vault",
                            "icon": "briefcase"
                        }]),
                        admin_headers,
                    )
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
                    .call_operation(
                        "vault.convertType",
                        json!([{ "vaultId": fixture.owner_personal_vault_id, "targetType": "team" }]),
                        owner_headers.clone(),
                    )
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
                    .call_operation(
                        "vault.convertType",
                        json!([{ "vaultId": fixture.target_vault_id, "targetType": "personal", "personalEncryptedVaultKey": "target-personal-key" }]),
                        owner_headers.clone(),
                    )
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
                    .call_operation(
                        "vault.delete",
                        json!([{ "vaultId": created_personal_vault_id }]),
                        solo_headers,
                    )
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
				.call_operation(
					"vault.create",
					json!([{ "name": "No Team Vault", "vaultType": "team", "encryptedVaultKey": "wrapped" }]),
					solo_headers,
				)
				.await;
			solo_team_create_response.assert_contract_status();
			assert_handler_error(
				&solo_team_create_response.body,
				"BAD_REQUEST",
				"You must belong to a team to create a team vault",
			);

			let blank_update_response = app
				.call_operation(
					"vault.update",
					json!([{ "vaultId": fixture.main_vault_id, "name": "   " }]),
					owner_headers.clone(),
				)
				.await;
			blank_update_response.assert_contract_status();
			assert_handler_error(&blank_update_response.body, "BAD_REQUEST", "Invalid params");

			let member_update_response = app
				.call_operation(
					"vault.update",
					json!([{ "vaultId": fixture.main_vault_id, "name": "Blocked Update" }]),
					member_headers.clone(),
				)
				.await;
			member_update_response.assert_contract_status();
			assert_handler_error(&member_update_response.body, "FORBIDDEN", "Access denied");

			let admin_convert_response = app
				.call_operation(
					"vault.convertType",
					json!([{ "vaultId": fixture.main_vault_id, "targetType": "personal" }]),
					admin_headers,
				)
				.await;
			admin_convert_response.assert_contract_status();
			assert_handler_error(
				&admin_convert_response.body,
				"FORBIDDEN",
				"Only the vault owner can convert vault type",
			);

			let same_type_response = app
				.call_operation(
					"vault.convertType",
					json!([{ "vaultId": fixture.main_vault_id, "targetType": "team" }]),
					owner_headers.clone(),
				)
				.await;
			same_type_response.assert_contract_status();
			assert_handler_error(
				&same_type_response.body,
				"BAD_REQUEST",
				"Vault is already the requested type",
			);

			let member_delete_response = app
				.call_operation(
					"vault.delete",
					json!([{ "vaultId": fixture.main_vault_id }]),
					member_headers,
				)
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
				app.call_operation(
					"vault.create",
					json!([{ "name": "Blocked Team Vault", "vaultType": "team", "encryptedVaultKey": "blocked-key" }]),
					owner_headers,
				),
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
					.call_operation(
						"vault.createImageUpload",
						json!([{
							"vaultId": fixture.main_vault_id,
							"fileName": "cover.png",
							"contentType": "image/png"
						}]),
						owner_headers.clone(),
					)
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
					.call_operation(
						"vault.createImageUpload",
						json!([{
							"vaultId": fixture.main_vault_id,
							"fileName": "blocked.png",
							"contentType": "image/png"
						}]),
						readonly_headers,
					)
					.await;
				blocked_image_upload_response.assert_contract_status();
				assert_handler_error(&blocked_image_upload_response.body, "FORBIDDEN", "Access denied");

				let invalid_attachment_upload_response = app
					.call_operation(
						"vault.createAttachmentUpload",
						json!([{
							"itemId": fixture.active_item_id,
							"fileName": "   ",
							"contentType": "application/octet-stream",
							"fileSize": 4
						}]),
						owner_headers.clone(),
					)
					.await;
				invalid_attachment_upload_response.assert_contract_status();
				assert_handler_error(
					&invalid_attachment_upload_response.body,
					"BAD_REQUEST",
					"Invalid attachment upload request",
				);

				let attachment_upload_response = app
					.call_operation(
						"vault.createAttachmentUpload",
						json!([{
							"itemId": fixture.active_item_id,
							"fileName": "attachment.bin",
							"contentType": "application/octet-stream",
							"fileSize": 4
						}]),
						owner_headers.clone(),
					)
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
					.call_operation(
						"vault.createAttachment",
						json!([{
							"itemId": fixture.active_item_id,
							"storageKey": "invalid-key",
							"encryptedName": "encrypted-name",
							"encryptedContentType": "encrypted-content-type",
							"encryptionIv": "attachment-iv",
							"encryptedContentTypeIv": "content-type-iv",
							"fileSize": 4
						}]),
						owner_headers.clone(),
					)
					.await;
				create_attachment_response.assert_contract_status();
				assert_handler_error(
					&create_attachment_response.body,
					"BAD_REQUEST",
					"Invalid or expired attachment upload key",
				);

				let list_attachments_response = app
					.call_operation(
						"vault.listAttachments",
						json!([{ "itemId": fixture.active_item_id }]),
						owner_headers.clone(),
					)
					.await;
				list_attachments_response.assert_contract_status();
				let attachments = list_attachments_response.body
					.as_array()
					.expect("attachments should be returned");
				assert_eq!(attachments.len(), 1);
				assert_eq!(attachments[0]["id"], json!(fixture.attachment_id));

				let download_response = app
					.call_operation(
						"vault.getAttachmentDownloadUrl",
						json!([{ "attachmentId": fixture.attachment_id }]),
						owner_headers.clone(),
					)
					.await;
				download_response.assert_contract_status();
				let download_url = download_response.body["downloadUrl"]
					.as_str()
					.expect("download url should exist");
				assert!(download_url.contains("storage.example.invalid"));
				assert_eq!(download_response.body["fileSize"], json!(128));

				let update_attachment_response = app
					.call_operation(
						"vault.updateAttachment",
						json!([{
							"attachmentId": fixture.attachment_id,
							"encryptedName": "updated-encrypted-name",
							"encryptionIv": "updated-attachment-iv"
						}]),
						owner_headers.clone(),
					)
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
					.call_operation(
						"vault.deleteAttachment",
						json!([{ "attachmentId": fixture.attachment_id }]),
						member_headers,
					)
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
                .call_operation(
                    "vault.members.list",
                    json!([{ "vaultId": fixture.main_vault_id }]),
                    owner_headers.clone(),
                )
                .await;
            members_response.assert_contract_status();
            let members = members_response
                .body
                .as_array()
                .expect("members should be returned");
            assert_eq!(members.len(), 4);
            assert!(members
                .iter()
                .any(|member| member["userId"] == json!(fixture.readonly_user_id)));

            let available_members_response = app
                .call_operation(
                    "vault.members.availableTeamMembers",
                    json!([{ "vaultId": fixture.main_vault_id }]),
                    owner_headers.clone(),
                )
                .await;
            available_members_response.assert_contract_status();
            let available_members = available_members_response
                .body
                .as_array()
                .expect("available members should be returned");
            assert!(available_members
                .iter()
                .any(|member| member["userId"] == json!(fixture.addable_user_id)));
            assert!(!available_members
                .iter()
                .any(|member| member["userId"] == json!(fixture.member_user_id)));

            let update_role_response = app
                .call_operation(
                    "vault.members.updateRole",
                    json!([{
                        "vaultId": fixture.main_vault_id,
                        "userId": fixture.readonly_user_id,
                        "role": "member"
                    }]),
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
                .call_operation(
                    "vault.members.add",
                    json!([{
                        "vaultId": fixture.main_vault_id,
                        "userId": fixture.addable_user_id,
                        "role": "member",
                        "encryptedVaultKey": "addable-member-key"
                    }]),
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
                .call_operation(
                    "vault.members.getRotationData",
                    json!([{
                        "vaultId": fixture.main_vault_id,
                        "excludeUserId": fixture.member_user_id
                    }]),
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
                .call_operation(
                    "vault.members.remove",
                    json!([{
                        "vaultId": fixture.main_vault_id,
                        "userId": fixture.addable_user_id,
                        "keyRotation": {
                            "memberKeys": [],
                            "reEncryptedItems": []
                        }
                    }]),
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
                .call_operation(
                    "vault.members.availableTeamMembers",
                    json!([{ "vaultId": fixture.main_vault_id }]),
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
                .call_operation(
                    "vault.members.updateRole",
                    json!([{
                        "vaultId": fixture.main_vault_id,
                        "userId": fixture.owner_user_id,
                        "role": "member"
                    }]),
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
                .call_operation(
                    "vault.members.updateRole",
                    json!([{
                        "vaultId": fixture.main_vault_id,
                        "userId": fixture.owner_user_id,
                        "role": "member"
                    }]),
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
                .call_operation(
                    "vault.members.updateRole",
                    json!([{
                        "vaultId": fixture.main_vault_id,
                        "userId": "missing_member_user",
                        "role": "member"
                    }]),
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
                .call_operation(
                    "vault.members.add",
                    json!([{
                        "vaultId": fixture.main_vault_id,
                        "userId": fixture.outsider_user_id,
                        "role": "member",
                        "encryptedVaultKey": "outsider-key"
                    }]),
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
					.call_operation(
						"vault.members.getRotationData",
						json!([{ "vaultId": fixture.main_vault_id, "excludeUserId": fixture.member_user_id }]),
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
                .call_operation(
                    "vault.members.remove",
                    json!([{
                        "vaultId": fixture.main_vault_id,
                        "userId": fixture.owner_user_id,
                        "keyRotation": {
                            "memberKeys": [],
                            "reEncryptedItems": []
                        }
                    }]),
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
