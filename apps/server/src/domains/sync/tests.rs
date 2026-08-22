use std::{future::Future, sync::Arc};

use axum::{
    body::{to_bytes, Body},
    http::{header::CONTENT_TYPE, HeaderMap, HeaderValue, Method, Request, StatusCode},
    Router as HttpRouter,
};
use rand::random;
use serde_json::{json, Value};
use sqlx::{query, query_scalar, PgPool};
use time::{macros::datetime, OffsetDateTime};
use tower::util::ServiceExt;

use super::*;
use crate::db::enums::{SyncEntityType, SyncEventType};
use crate::error::AppErrorCode;
use crate::{
    config::DeploymentMode,
    domains::sessions::control::record_session_revocations,
    test_support::{
        authenticated_json_headers, seed_item, seed_user, seed_vault, seed_vault_key,
        with_api_test_app, with_api_test_app_state, ApiTestApp,
    },
    AppState,
};

#[test]
fn sync_notification_session_revoked_serializes_correctly() {
    use crate::domains::sync::pubsub::SyncNotification;

    let notification = SyncNotification::SessionRevoked {
        session_id: "session-1".to_string(),
        reason: Some("device_revoked".to_string()),
    };

    let json = serde_json::to_value(&notification).expect("should serialize");
    assert_eq!(json["type"], "session_revoked");
    assert_eq!(json["session_id"], "session-1");
    assert_eq!(json["reason"], "device_revoked");
}

#[test]
fn validate_resource_id_accepts_uuid_and_slug_variants() {
    assert!(validate_resource_id("550e8400-e29b-41d4-a716-446655440000").is_ok());
    assert!(validate_resource_id("resource_01").is_ok());
    assert!(validate_resource_id("short").is_err());
    assert!(validate_resource_id("resource.with.dot").is_err());
    assert!(validate_resource_id(&"a".repeat(65)).is_err());
}

#[test]
fn sync_event_dto_parses_metadata_and_rejects_invalid_json() {
    let payload = sync_event_dto(DbSyncEventRow {
        id: "event-1".to_string(),
        seq: 1,
        event_type: SyncEventType::ItemUpdated,
        entity_id: "item-1".to_string(),
        entity_type: SyncEntityType::Item,
        vault_id: Some("vault-1".to_string()),
        version: 2,
        client_id: Some("client-1".to_string()),
        user_id: "user-1".to_string(),
        metadata: Some(r#"{"reason":"bulk_import"}"#.to_string()),
        created_at: OffsetDateTime::now_utc(),
    })
    .expect("sync event dto should parse metadata");

    let metadata = payload.metadata.expect("metadata should be present");
    assert_eq!(metadata["reason"], "bulk_import");

    let error = sync_event_dto(DbSyncEventRow {
        id: "event-2".to_string(),
        seq: 2,
        event_type: SyncEventType::ItemUpdated,
        entity_id: "item-1".to_string(),
        entity_type: SyncEntityType::Item,
        vault_id: Some("vault-1".to_string()),
        version: 3,
        client_id: None,
        user_id: "user-1".to_string(),
        metadata: Some("not-json".to_string()),
        created_at: OffsetDateTime::now_utc(),
    })
    .expect_err("invalid metadata json should error");

    assert_eq!(error.code, AppErrorCode::InternalServerError);
    assert_eq!(error.message, "Failed to parse sync event metadata");
}

#[tokio::test]
async fn sync_pubsub_broadcasts_sync_notifications() {
    use crate::domains::sync::pubsub::SyncPubSub;

    let pubsub = SyncPubSub::new();
    let (mut sync_rx, _control_rx) = pubsub.subscribe("user-1").await;

    pubsub.notify_sync();

    let result = sync_rx.recv().await;
    assert!(result.is_ok(), "sync notification should be received");
}

#[tokio::test]
async fn sync_pubsub_broadcasts_session_revocation() {
    use crate::domains::sync::pubsub::{SyncNotification, SyncPubSub};

    let pubsub = SyncPubSub::new();
    let (_sync_rx, mut control_rx) = pubsub.subscribe("user-1").await;

    pubsub.notify_session_revoked("user-1", "session-1", "device_revoked");

    let notification = tokio::time::timeout(std::time::Duration::from_secs(1), control_rx.recv())
        .await
        .expect("control notification should arrive before the timeout")
        .expect("control notification channel should remain open");
    match notification {
        SyncNotification::SessionRevoked { session_id, reason } => {
            assert_eq!(session_id, "session-1");
            assert_eq!(reason.as_deref(), Some("device_revoked"));
        }
        _ => panic!("expected SessionRevoked notification"),
    }
}

#[derive(Clone)]
struct SyncHttpTestApp {
    router: HttpRouter,
}

struct SyncHttpTestResponse {
    status: StatusCode,
    headers: HeaderMap,
    body: String,
}

impl SyncHttpTestApp {
    fn new(state: AppState) -> Self {
        let router = crate::test_support::create_test_router(state);

        Self { router }
    }

    async fn get(&self, path: &str, headers: HeaderMap) -> SyncHttpTestResponse {
        let mut builder = Request::builder().method("GET").uri(path);
        for (name, value) in &headers {
            builder = builder.header(name, value);
        }

        let response = self
            .router
            .clone()
            .oneshot(
                builder
                    .body(Body::empty())
                    .expect("sync HTTP request should build"),
            )
            .await
            .expect("sync HTTP request should resolve");

        let status = response.status();
        let headers = response.headers().clone();
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("sync HTTP response body should be readable");

        SyncHttpTestResponse {
            status,
            headers,
            body: String::from_utf8_lossy(&bytes).into_owned(),
        }
    }
}

struct SyncRouterFixture {
    owner_user_id: String,
    _outsider_user_id: String,
    primary_vault_id: String,
    secondary_vault_id: String,
    hidden_vault_id: String,
    primary_item_id: String,
    secondary_item_id: String,
    old_primary_event_id: String,
    latest_primary_event_id: String,
    secondary_event_id: String,
    hidden_event_id: String,
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

async fn with_sync_test_app<T, F, Fut>(test_name: &str, test_fn: F) -> T
where
    F: FnOnce(ApiTestApp) -> Fut,
    Fut: Future<Output = T>,
{
    let unique_name = format!("{test_name}_{:016x}", random::<u64>());
    with_api_test_app(&unique_name, test_fn).await
}

async fn with_self_hosted_sync_test_app<T, F, Fut>(test_name: &str, test_fn: F) -> T
where
    F: FnOnce(ApiTestApp) -> Fut,
    Fut: Future<Output = T>,
{
    let unique_name = format!("{test_name}_{:016x}", random::<u64>());
    with_api_test_app_state(
        &unique_name,
        |mut state| {
            Arc::make_mut(&mut state.config).server.mode = DeploymentMode::SelfHosted;
            state
        },
        test_fn,
    )
    .await
}

async fn build_sync_router_fixture(pool: &PgPool) -> SyncRouterFixture {
    let owner_user_id = "user_sync_owner".to_string();
    let outsider_user_id = "user_sync_outsider".to_string();
    let primary_vault_id = "vault_sync_primary".to_string();
    let secondary_vault_id = "vault_sync_secondary".to_string();
    let hidden_vault_id = "vault_sync_hidden".to_string();
    let primary_item_id = "item_sync_01".to_string();
    let secondary_item_id = "item_sync_02".to_string();
    let hidden_item_id = "item_sync_hidden".to_string();
    let old_primary_event_id = "event_sync_01".to_string();
    let hidden_event_id = "event_sync_hidden".to_string();
    let latest_primary_event_id = "event_sync_02".to_string();
    let secondary_event_id = "event_sync_03".to_string();

    seed_user(pool, &owner_user_id, "Sync Owner", "sync-owner@example.com").await;
    seed_user(
        pool,
        &outsider_user_id,
        "Sync Outsider",
        "sync-outsider@example.com",
    )
    .await;

    seed_vault(
        pool,
        &primary_vault_id,
        "Primary Vault",
        "personal",
        &owner_user_id,
        None,
    )
    .await;
    seed_vault(
        pool,
        &secondary_vault_id,
        "Secondary Vault",
        "personal",
        &owner_user_id,
        None,
    )
    .await;
    seed_vault(
        pool,
        &hidden_vault_id,
        "Hidden Vault",
        "personal",
        &outsider_user_id,
        None,
    )
    .await;

    seed_vault_key(
        pool,
        "vault_key_sync_primary_owner",
        &primary_vault_id,
        &owner_user_id,
        "encrypted-vault-key-primary",
        "owner",
    )
    .await;
    seed_vault_key(
        pool,
        "vault_key_sync_secondary_owner",
        &secondary_vault_id,
        &owner_user_id,
        "encrypted-vault-key-secondary",
        "owner",
    )
    .await;
    seed_vault_key(
        pool,
        "vault_key_sync_hidden_outsider",
        &hidden_vault_id,
        &outsider_user_id,
        "encrypted-vault-key-hidden",
        "owner",
    )
    .await;

    seed_item(
        pool,
        &primary_item_id,
        &primary_vault_id,
        "login",
        "encrypted-primary-item",
        "iv-primary-item",
        &owner_user_id,
    )
    .await;
    seed_item(
        pool,
        &secondary_item_id,
        &secondary_vault_id,
        "login",
        "encrypted-secondary-item",
        "iv-secondary-item",
        &owner_user_id,
    )
    .await;
    seed_item(
        pool,
        &hidden_item_id,
        &hidden_vault_id,
        "login",
        "encrypted-hidden-item",
        "iv-hidden-item",
        &outsider_user_id,
    )
    .await;

    seed_sync_event(
        pool,
        &old_primary_event_id,
        "item_updated",
        &primary_item_id,
        "item",
        Some(&primary_vault_id),
        &owner_user_id,
        2,
        Some("client-sync-1"),
        Some(r#"{"reason":"import"}"#),
        datetime!(2025-05-01 10:00 UTC),
    )
    .await;
    seed_sync_event(
        pool,
        &hidden_event_id,
        "item_updated",
        &hidden_item_id,
        "item",
        Some(&hidden_vault_id),
        &outsider_user_id,
        1,
        Some("client-hidden"),
        None,
        datetime!(2025-05-01 11:00 UTC),
    )
    .await;
    seed_sync_event(
        pool,
        &latest_primary_event_id,
        "item_updated",
        &primary_item_id,
        "item",
        Some(&primary_vault_id),
        &owner_user_id,
        3,
        Some("client-sync-2"),
        Some(r#"{"reason":"rotation"}"#),
        datetime!(2025-05-01 12:00 UTC),
    )
    .await;
    // Targeted events can name a vault for cache cleanup, but they are visible
    // only to their user. Other members of that vault must not process someone
    // else's access revocation and delete their own local copy.
    seed_sync_event(
        pool,
        "event_sync_outsider_revoked",
        "vault_access_revoked",
        &primary_vault_id,
        "vault_member",
        Some(&primary_vault_id),
        &outsider_user_id,
        4,
        None,
        None,
        datetime!(2025-05-01 12:30 UTC),
    )
    .await;
    seed_sync_event(
        pool,
        &secondary_event_id,
        "item_updated",
        &secondary_item_id,
        "item",
        Some(&secondary_vault_id),
        &owner_user_id,
        1,
        Some("client-sync-3"),
        None,
        datetime!(2025-05-01 13:00 UTC),
    )
    .await;
    seed_attachment(
        pool,
        "attachment_sync_01",
        &primary_item_id,
        &primary_vault_id,
        &owner_user_id,
        datetime!(2025-05-01 14:00 UTC),
    )
    .await;

    SyncRouterFixture {
        owner_user_id,
        _outsider_user_id: outsider_user_id,
        primary_vault_id,
        secondary_vault_id,
        hidden_vault_id,
        primary_item_id,
        secondary_item_id,
        old_primary_event_id,
        latest_primary_event_id,
        secondary_event_id,
        hidden_event_id,
    }
}

#[allow(clippy::too_many_arguments)]
async fn seed_sync_event(
    pool: &PgPool,
    event_id: &str,
    event_type: &str,
    entity_id: &str,
    entity_type: &str,
    vault_id: Option<&str>,
    user_id: &str,
    version: i32,
    client_id: Option<&str>,
    metadata: Option<&str>,
    created_at: OffsetDateTime,
) {
    query(
			"INSERT INTO sync_event (id, event_type, entity_id, entity_type, vault_id, user_id, version, client_id, metadata, created_at) VALUES ($1, $2::sync_event_type, $3, $4::sync_entity_type, $5, $6, $7, $8, $9, $10)",
		)
		.bind(event_id)
		.bind(event_type)
		.bind(entity_id)
		.bind(entity_type)
		.bind(vault_id)
		.bind(user_id)
		.bind(version)
		.bind(client_id)
		.bind(metadata)
		.bind(created_at)
		.execute(pool)
		.await
		.expect("sync event should seed");
}

async fn seed_attachment(
    pool: &PgPool,
    attachment_id: &str,
    item_id: &str,
    vault_id: &str,
    uploaded_by: &str,
    created_at: OffsetDateTime,
) {
    query(
			"INSERT INTO item_attachment (id, item_id, vault_id, storage_key, encrypted_attachment_key, attachment_key_iv, attachment_key_algorithm, envelope_version, encrypted_name, encrypted_content_type, encryption_iv, encrypted_content_type_iv, encryption_algorithm, file_size, storage_size, uploaded_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)",
		)
		.bind(attachment_id)
		.bind(item_id)
		.bind(vault_id)
		.bind(format!("attachments/{attachment_id}"))
		.bind("encrypted-attachment-key")
		.bind("attachment-key-iv")
		.bind("AES-GCM-AAD-V1")
		.bind(1_i32)
		.bind("encrypted-attachment-name")
		.bind("encrypted-content-type")
		.bind("attachment-iv")
		.bind(Some("attachment-content-type-iv"))
		.bind("AES-GCM-AAD-V1")
		.bind(128_i32)
		.bind(128_i32)
		.bind(uploaded_by)
		.bind(created_at)
		.execute(pool)
		.await
		.expect("attachment should seed");
}

#[tokio::test]
async fn sync_handlers_require_authentication() {
    with_sync_test_app("sync_handlers_require_authentication", |app| async move {
        let protected_calls = ["/api/v1/sync/bootstrap", "/api/v1/sync/changes"];

        for path in protected_calls {
            let response = app
                .api_json(Method::GET, path, None, unauthenticated_json_headers())
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
async fn sync_handlers_reject_malformed_request_input() {
    with_sync_test_app(
        "sync_handlers_reject_malformed_request_input",
        |app| async move {
            let fixture = build_sync_router_fixture(&app.pool).await;
            let session = app.issue_session(&fixture.owner_user_id).await;
            let headers = authenticated_json_headers(&session.token);

            let cases = [
                (
                    "/api/v1/sync/bootstrap?limit=0",
                    "BAD_REQUEST",
                    "Invalid params",
                ),
                (
                    "/api/v1/sync/changes?sinceId=bad!",
                    "BAD_REQUEST",
                    "Invalid resource ID",
                ),
            ];

            for (path, code, message) in cases {
                let response = app.api_json(Method::GET, path, None, headers.clone()).await;
                response.assert_contract_status();
                assert_handler_error(&response.body, code, message);
            }
        },
    )
    .await;
}

#[tokio::test]
async fn get_events_since_paginates_filters_and_requires_full_refresh() {
    with_sync_test_app("sync_get_events_since_paths", |app| async move {
        let fixture = build_sync_router_fixture(&app.pool).await;
        let session = app.issue_session(&fixture.owner_user_id).await;
        let headers = authenticated_json_headers(&session.token);

        let first_page = app
            .api_json(
                Method::GET,
                "/api/v1/sync/changes?limit=1",
                None,
                headers.clone(),
            )
            .await;
        first_page.assert_contract_status();
        assert_eq!(
            first_page.body["events"]
                .as_array()
                .expect("events should be an array")
                .len(),
            1
        );
        assert_eq!(
            first_page.body["events"][0]["id"],
            json!(fixture.old_primary_event_id)
        );
        assert_eq!(
            first_page.body["events"][0]["metadata"]["reason"],
            json!("import")
        );
        assert_eq!(first_page.body["hasMore"], json!(true));
        assert_eq!(
            first_page.body["cursor"]["id"],
            json!(fixture.old_primary_event_id)
        );

        let filtered_path = format!(
            "/api/v1/sync/changes?vaultIds={}&vaultIds={}",
            fixture.secondary_vault_id, fixture.hidden_vault_id
        );
        let filtered = app
            .api_json(Method::GET, &filtered_path, None, headers.clone())
            .await;
        filtered.assert_contract_status();
        assert_eq!(
            filtered.body["events"]
                .as_array()
                .expect("events should be an array")
                .len(),
            1
        );
        assert_eq!(
            filtered.body["events"][0]["id"],
            json!(fixture.secondary_event_id)
        );

        let next_page_path = format!(
            "/api/v1/sync/changes?sinceId={}",
            fixture.old_primary_event_id
        );
        let next_page = app
            .api_json(Method::GET, &next_page_path, None, headers.clone())
            .await;
        next_page.assert_contract_status();
        assert_eq!(
            next_page.body["events"]
                .as_array()
                .expect("events should be an array")
                .len(),
            2
        );
        assert_eq!(
            next_page.body["events"][0]["id"],
            json!(fixture.latest_primary_event_id)
        );
        assert_eq!(
            next_page.body["events"][1]["id"],
            json!(fixture.secondary_event_id)
        );
        assert_eq!(next_page.body["hasMore"], json!(false));

        let full_refresh_path = format!("/api/v1/sync/changes?sinceId={}", fixture.hidden_event_id);
        let full_refresh = app
            .api_json(Method::GET, &full_refresh_path, None, headers)
            .await;
        full_refresh.assert_contract_status();
        assert_eq!(full_refresh.body["events"], json!([]));
        assert_eq!(full_refresh.body["requiresFullRefresh"], json!(true));
        assert_eq!(
            full_refresh.body["cursor"]["id"],
            json!(fixture.secondary_event_id)
        );
    })
    .await;
}

#[tokio::test]
async fn vault_deleted_event_remains_visible_after_its_vault_is_deleted() {
    with_sync_test_app("sync_deleted_vault_cursor", |app| async move {
        let owner_user_id = "user_sync_delete_owner";
        let outsider_user_id = "user_sync_delete_outsider";
        let retained_vault_id = "vault_sync_delete_retained";
        let deleted_vault_id = "vault_sync_delete_target";
        let baseline_event_id = "event_sync_delete_baseline";
        let deleted_vault_prior_event_id = "event_sync_delete_target_prior";

        seed_user(
            &app.pool,
            owner_user_id,
            "Sync Delete Owner",
            "sync-delete-owner@example.com",
        )
        .await;
        seed_user(
            &app.pool,
            outsider_user_id,
            "Sync Delete Outsider",
            "sync-delete-outsider@example.com",
        )
        .await;
        seed_vault(
            &app.pool,
            retained_vault_id,
            "Retained Vault",
            "personal",
            owner_user_id,
            None,
        )
        .await;
        seed_vault(
            &app.pool,
            deleted_vault_id,
            "Deleted Vault",
            "personal",
            owner_user_id,
            None,
        )
        .await;
        seed_vault_key(
            &app.pool,
            "vault_key_sync_delete_retained",
            retained_vault_id,
            owner_user_id,
            "encrypted-retained-key",
            "owner",
        )
        .await;
        seed_vault_key(
            &app.pool,
            "vault_key_sync_delete_target",
            deleted_vault_id,
            owner_user_id,
            "encrypted-deleted-key",
            "owner",
        )
        .await;
        seed_sync_event(
            &app.pool,
            baseline_event_id,
            "vault_updated",
            retained_vault_id,
            "vault",
            Some(retained_vault_id),
            owner_user_id,
            1,
            Some("offline-client"),
            None,
            datetime!(2025-05-01 10:00 UTC),
        )
        .await;
        seed_sync_event(
            &app.pool,
            deleted_vault_prior_event_id,
            "vault_updated",
            deleted_vault_id,
            "vault",
            Some(deleted_vault_id),
            owner_user_id,
            1,
            Some("offline-client"),
            None,
            datetime!(2025-05-01 11:00 UTC),
        )
        .await;

        let owner_session = app.issue_session(owner_user_id).await;
        let owner_headers = authenticated_json_headers(&owner_session.token);
        let delete_response = app
            .api_json(
                Method::DELETE,
                &format!("/api/v1/vaults/{deleted_vault_id}"),
                None,
                owner_headers.clone(),
            )
            .await;
        delete_response.assert_contract_status();
        assert_eq!(delete_response.body["success"], json!(true));

        let (deleted_event_id, deleted_event_vault_id) =
            query_as::<_, (String, Option<String>)>(
                "SELECT id, vault_id FROM sync_event WHERE user_id = $1 AND event_type = 'vault_deleted'::sync_event_type ORDER BY seq DESC LIMIT 1",
            )
            .bind(owner_user_id)
            .fetch_one(&app.pool)
            .await
            .expect("vault deletion event should survive the vault deletion");
        assert_eq!(deleted_event_vault_id, None);

        let offline_catch_up = app
            .api_json(
                Method::GET,
                &format!("/api/v1/sync/changes?sinceId={baseline_event_id}"),
                None,
                owner_headers.clone(),
            )
            .await;
        offline_catch_up.assert_contract_status();
        assert_eq!(offline_catch_up.body["requiresFullRefresh"], json!(false));
        assert_eq!(offline_catch_up.body["events"].as_array().map(Vec::len), Some(1));
        assert_eq!(offline_catch_up.body["events"][0]["id"], json!(deleted_event_id));
        assert_eq!(offline_catch_up.body["events"][0]["type"], json!("vault_deleted"));
        assert_eq!(
            offline_catch_up.body["events"][0]["entityId"],
            json!(deleted_vault_id)
        );
        assert_eq!(offline_catch_up.body["events"][0]["vaultId"], Value::Null);
        assert_eq!(
            offline_catch_up.body["cursor"]["id"],
            json!(deleted_event_id)
        );

        let already_caught_up = app
            .api_json(
                Method::GET,
                &format!("/api/v1/sync/changes?sinceId={deleted_event_id}"),
                None,
                owner_headers.clone(),
            )
            .await;
        already_caught_up.assert_contract_status();
        assert_eq!(already_caught_up.body["events"], json!([]));
        assert_eq!(already_caught_up.body["requiresFullRefresh"], json!(false));

        let offline_cursor_from_deleted_vault = app
            .api_json(
                Method::GET,
                &format!("/api/v1/sync/changes?sinceId={deleted_vault_prior_event_id}"),
                None,
                owner_headers.clone(),
            )
            .await;
        offline_cursor_from_deleted_vault.assert_contract_status();
        assert_eq!(offline_cursor_from_deleted_vault.body["events"], json!([]));
        assert_eq!(
            offline_cursor_from_deleted_vault.body["requiresFullRefresh"],
            json!(true)
        );

        let delete_last_vault = app
            .api_json(
                Method::DELETE,
                &format!("/api/v1/vaults/{retained_vault_id}"),
                None,
                owner_headers.clone(),
            )
            .await;
        delete_last_vault.assert_contract_status();
        let last_vault_deleted_event_id = query_scalar::<_, String>(
            "SELECT id FROM sync_event WHERE user_id = $1 AND event_type = 'vault_deleted'::sync_event_type AND entity_id = $2 ORDER BY seq DESC LIMIT 1",
        )
        .bind(owner_user_id)
        .bind(retained_vault_id)
        .fetch_one(&app.pool)
        .await
        .expect("last-vault deletion event should survive the vault deletion");
        let no_remaining_vaults = app
            .api_json(
                Method::GET,
                &format!("/api/v1/sync/changes?sinceId={last_vault_deleted_event_id}"),
                None,
                owner_headers,
            )
            .await;
        no_remaining_vaults.assert_contract_status();
        assert_eq!(no_remaining_vaults.body["events"], json!([]));
        assert_eq!(no_remaining_vaults.body["requiresFullRefresh"], json!(false));

        let outsider_session = app.issue_session(outsider_user_id).await;
        let outsider_probe = app
            .api_json(
                Method::GET,
                &format!("/api/v1/sync/changes?sinceId={deleted_event_id}"),
                None,
                authenticated_json_headers(&outsider_session.token),
            )
            .await;
        outsider_probe.assert_contract_status();
        assert_eq!(outsider_probe.body["events"], json!([]));
        assert_eq!(outsider_probe.body["requiresFullRefresh"], json!(true));
    })
    .await;
}

#[tokio::test]
async fn operation_resolved_continues_through_count_bounded_sync_pages() {
    with_sync_test_app("sync_operation_count_pages", |app| async move {
        let fixture = build_sync_router_fixture(&app.pool).await;
        let session = app.issue_session(&fixture.owner_user_id).await;
        let headers = authenticated_json_headers(&session.token);
        seed_sync_event(
            &app.pool,
            "sync_operation_count_event",
            "operation_resolved",
            "operation_count_1",
            "operation",
            None,
            &fixture.owner_user_id,
            1,
            Some("operation-client"),
            None,
            datetime!(2025-05-02 10:00 UTC),
        )
        .await;
        seed_sync_event(
            &app.pool,
            "sync_item_after_operation",
            "item_updated",
            &fixture.primary_item_id,
            "item",
            Some(&fixture.primary_vault_id),
            &fixture.owner_user_id,
            10,
            Some("operation-client"),
            None,
            datetime!(2025-05-02 10:01 UTC),
        )
        .await;

        let first = app
            .api_json(
                Method::GET,
                &format!(
                    "/api/v1/sync/changes?limit=1&sinceId={}",
                    fixture.secondary_event_id
                ),
                None,
                headers.clone(),
            )
            .await;
        first.assert_contract_status();
        assert_eq!(first.body["events"].as_array().map(Vec::len), Some(1));
        assert_eq!(first.body["events"][0]["type"], "operation_resolved");
        assert_eq!(first.body["events"][0]["entityId"], "operation_count_1");
        assert_eq!(first.body["hasMore"], json!(true));

        let second = app
            .api_json(
                Method::GET,
                &format!(
                    "/api/v1/sync/changes?limit=1&sinceId={}",
                    first.body["cursor"]["id"]
                        .as_str()
                        .expect("count-bounded page should continue")
                ),
                None,
                headers,
            )
            .await;
        second.assert_contract_status();
        assert_eq!(second.body["events"].as_array().map(Vec::len), Some(1));
        assert_eq!(second.body["events"][0]["id"], "sync_item_after_operation");
        assert_eq!(second.body["hasMore"], json!(false));
    })
    .await;
}

#[tokio::test]
async fn large_sync_event_pages_stay_byte_bounded_and_continue() {
    with_sync_test_app("sync_changes_byte_budget", |app| async move {
        let fixture = build_sync_router_fixture(&app.pool).await;
        let session = app.issue_session(&fixture.owner_user_id).await;
        let headers = authenticated_json_headers(&session.token);
        let metadata = format!(r#"{{"payload":"{}"}}"#, "x".repeat(1_048_000));
        let expected_ids: Vec<String> = (0..6)
            .map(|index| format!("sync_budget_event_{index}"))
            .collect();
        for (index, event_id) in expected_ids.iter().enumerate() {
            let is_operation = index % 2 == 0;
            seed_sync_event(
                &app.pool,
                event_id,
                if is_operation {
                    "operation_resolved"
                } else {
                    "item_updated"
                },
                if is_operation {
                    event_id
                } else {
                    &fixture.primary_item_id
                },
                if is_operation { "operation" } else { "item" },
                if is_operation {
                    None
                } else {
                    Some(&fixture.primary_vault_id)
                },
                &fixture.owner_user_id,
                index as i32 + 10,
                Some("budget-client"),
                Some(&metadata),
                datetime!(2025-05-02 10:00 UTC),
            )
            .await;
        }

        let mut since_id = fixture.secondary_event_id.clone();
        let mut seen_ids = Vec::new();
        for _ in 0..3 {
            let response = app
                .api_json(
                    Method::GET,
                    &format!("/api/v1/sync/changes?limit=500&sinceId={since_id}"),
                    None,
                    headers.clone(),
                )
                .await;
            response.assert_contract_status();
            assert!(
                response.body_bytes <= crate::http::pagination::RESPONSE_PAGE_BYTES,
                "serialized sync page was {} bytes",
                response.body_bytes
            );
            let events = response.body["events"]
                .as_array()
                .expect("bounded sync page should contain events");
            assert!(
                events.len() <= 3,
                "pre-budget query materialized too many maximum-size events"
            );
            seen_ids.extend(
                events
                    .iter()
                    .filter_map(|event| event["id"].as_str().map(str::to_string)),
            );
            if response.body["hasMore"] == json!(false) {
                break;
            }
            since_id = response.body["cursor"]["id"]
                .as_str()
                .expect("continued sync page should have a cursor")
                .to_string();
        }

        for event_id in expected_ids {
            assert_eq!(
                seen_ids.iter().filter(|seen| **seen == event_id).count(),
                1,
                "sync event {event_id} should occur exactly once"
            );
        }
    })
    .await;
}

#[tokio::test]
async fn bootstrap_items_returns_paginated_items_with_vault_details_and_attachments() {
    with_self_hosted_sync_test_app("sync_bootstrap_items_success", |app| async move {
        let fixture = build_sync_router_fixture(&app.pool).await;
        let session = app.issue_session(&fixture.owner_user_id).await;
        let headers = authenticated_json_headers(&session.token);

        let first_page = app
            .api_json(
                Method::GET,
                "/api/v1/sync/bootstrap?limit=1",
                None,
                headers.clone(),
            )
            .await;
        first_page.assert_contract_status();
        assert_eq!(
            first_page.body["items"]
                .as_array()
                .expect("items should be an array")
                .len(),
            1
        );
        assert_eq!(
            first_page.body["items"][0]["id"],
            json!(fixture.primary_item_id)
        );
        assert_eq!(
            first_page.body["items"][0]["attachments"]
                .as_array()
                .expect("attachments should be an array")
                .len(),
            1
        );
        assert_eq!(
            first_page.body["items"][0]["vault"]["encryptedVaultKey"],
            json!("encrypted-vault-key-primary")
        );
        assert_eq!(first_page.body["hasMore"], json!(true));
        assert_eq!(
            first_page.body["nextCursor"],
            json!(fixture.primary_item_id)
        );
        assert_eq!(
            first_page.body["syncCursor"]["id"],
            json!(fixture.secondary_event_id)
        );

        let later_event_id = "event_sync_after_bootstrap_page_1";
        seed_sync_event(
            &app.pool,
            later_event_id,
            "item_updated",
            &fixture.secondary_item_id,
            "item",
            Some(&fixture.secondary_vault_id),
            &fixture.owner_user_id,
            2,
            Some("client-sync-after-page-1"),
            None,
            datetime!(2025-05-01 15:00 UTC),
        )
        .await;

        let second_page_path = format!(
            "/api/v1/sync/bootstrap?cursor={}&syncCursor={}",
            fixture.primary_item_id, fixture.secondary_event_id
        );
        let second_page = app
            .api_json(Method::GET, &second_page_path, None, headers)
            .await;
        second_page.assert_contract_status();
        assert_eq!(
            second_page.body["items"]
                .as_array()
                .expect("items should be an array")
                .len(),
            1
        );
        assert_eq!(
            second_page.body["items"][0]["id"],
            json!(fixture.secondary_item_id)
        );
        assert_eq!(second_page.body["hasMore"], json!(false));
        assert_eq!(second_page.body["nextCursor"], Value::Null);
        assert_eq!(
            second_page.body["syncCursor"]["id"],
            json!(fixture.secondary_event_id)
        );
        assert_ne!(second_page.body["syncCursor"]["id"], json!(later_event_id));
    })
    .await;
}

#[tokio::test]
async fn bootstrap_rejects_invalid_or_inaccessible_sync_cursors() {
    with_self_hosted_sync_test_app("sync_bootstrap_cursor_visibility", |app| async move {
        let fixture = build_sync_router_fixture(&app.pool).await;
        let session = app.issue_session(&fixture.owner_user_id).await;
        let headers = authenticated_json_headers(&session.token);

        for (sync_cursor, expected_detail) in [
            ("bad!", "Invalid resource ID"),
            (fixture.hidden_event_id.as_str(), "Invalid params"),
        ] {
            let response = app
                .api_json(
                    Method::GET,
                    &format!("/api/v1/sync/bootstrap?syncCursor={sync_cursor}"),
                    None,
                    headers.clone(),
                )
                .await;

            assert_eq!(response.status, StatusCode::BAD_REQUEST);
            assert_handler_error(&response.body, "BAD_REQUEST", expected_detail);
        }
    })
    .await;
}

#[tokio::test]
async fn bootstrap_captures_sync_cursor_before_fetching_the_first_item_page() {
    with_self_hosted_sync_test_app("sync_bootstrap_capture_order", |app| async move {
            let fixture = build_sync_router_fixture(&app.pool).await;
            let session = app.issue_session(&fixture.owner_user_id).await;
            let headers = authenticated_json_headers(&session.token);

            let mut item_lock = app.pool.begin().await.expect("item lock should begin");
            query("LOCK TABLE item IN ACCESS EXCLUSIVE MODE")
                .execute(&mut *item_lock)
                .await
                .expect("item reads should be held until the watermark is captured");

            let request_app = app.clone();
            let response_task = tokio::spawn(async move {
                request_app
                    .api_json(
                        Method::GET,
                        "/api/v1/sync/bootstrap?limit=1",
                        None,
                        headers,
                    )
                    .await
            });

            tokio::time::timeout(std::time::Duration::from_secs(5), async {
                loop {
                    let item_fetch_is_waiting = query_scalar::<_, bool>(
                        "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%WITH candidates AS (%')",
                    )
                    .fetch_one(&app.pool)
                    .await
                    .expect("blocked bootstrap query should be observable");
                    if item_fetch_is_waiting {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("bootstrap should reach the blocked item fetch");

            let later_event_id = "event_sync_during_first_bootstrap_page";
            seed_sync_event(
                &app.pool,
                later_event_id,
                "item_updated",
                &fixture.primary_item_id,
                "item",
                Some(&fixture.primary_vault_id),
                &fixture.owner_user_id,
                4,
                Some("client-sync-during-bootstrap"),
                None,
                datetime!(2025-05-01 15:00 UTC),
            )
            .await;
            item_lock.commit().await.expect("item fetch should resume");

            let response = response_task.await.expect("bootstrap task should finish");
            response.assert_contract_status();
            assert_eq!(
                response.body["syncCursor"]["id"],
                json!(fixture.secondary_event_id)
            );
            assert_ne!(response.body["syncCursor"]["id"], json!(later_event_id));
    })
    .await;
}

#[tokio::test]
async fn bootstrap_pins_an_empty_sync_cursor_across_item_pages() {
    with_self_hosted_sync_test_app("sync_bootstrap_empty_cursor", |app| async move {
        let fixture = build_sync_router_fixture(&app.pool).await;
        query("DELETE FROM sync_event")
            .execute(&app.pool)
            .await
            .expect("fixture events should be removable");
        let session = app.issue_session(&fixture.owner_user_id).await;
        let headers = authenticated_json_headers(&session.token);

        let first_page = app
            .api_json(
                Method::GET,
                "/api/v1/sync/bootstrap?limit=1",
                None,
                headers.clone(),
            )
            .await;
        first_page.assert_contract_status();
        assert_eq!(first_page.status, StatusCode::OK);
        assert_eq!(first_page.body["syncCursor"], Value::Null);
        let next_cursor = first_page.body["nextCursor"]
            .as_str()
            .expect("first page should continue");

        seed_sync_event(
            &app.pool,
            "event_sync_after_empty_bootstrap_cursor",
            "item_updated",
            &fixture.secondary_item_id,
            "item",
            Some(&fixture.secondary_vault_id),
            &fixture.owner_user_id,
            2,
            Some("client-sync-after-empty-cursor"),
            None,
            datetime!(2025-05-01 15:00 UTC),
        )
        .await;

        let second_page = app
            .api_json(
                Method::GET,
                &format!(
                    "/api/v1/sync/bootstrap?cursor={}&limit=1&syncCursorCaptured=true",
                    next_cursor
                ),
                None,
                headers,
            )
            .await;
        second_page.assert_contract_status();
        assert_eq!(second_page.status, StatusCode::OK);
        assert_eq!(second_page.body["syncCursor"], Value::Null);
        assert_eq!(second_page.body["items"].as_array().map(Vec::len), Some(1));
    })
    .await;
}

#[tokio::test]
async fn max_ciphertext_bootstrap_pages_stay_byte_bounded_and_continue() {
    with_self_hosted_sync_test_app("sync_bootstrap_byte_budget", |app| async move {
        let fixture = build_sync_router_fixture(&app.pool).await;
        let session = app.issue_session(&fixture.owner_user_id).await;
        let headers = authenticated_json_headers(&session.token);
        let ciphertext = "x".repeat(1_048_576);
        let expected_ids: Vec<String> = (0..6)
            .map(|index| format!("zz_sync_budget_{index}"))
            .collect();
        for item_id in &expected_ids {
            seed_item(
                &app.pool,
                item_id,
                &fixture.primary_vault_id,
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
                    &format!("/api/v1/sync/bootstrap?{query}"),
                    None,
                    headers.clone(),
                )
                .await;
            response.assert_contract_status();
            assert!(
                response.body_bytes <= crate::http::pagination::RESPONSE_PAGE_BYTES,
                "serialized bootstrap page was {} bytes",
                response.body_bytes
            );
            let items = response.body["items"]
                .as_array()
                .expect("bounded bootstrap page should contain items");
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
                    .expect("continued bootstrap page should have a cursor")
                    .to_string(),
            );
        }

        for item_id in expected_ids {
            assert_eq!(
                seen_ids.iter().filter(|seen| **seen == item_id).count(),
                1,
                "bootstrap item {item_id} should occur exactly once"
            );
        }
    })
    .await;
}

#[tokio::test]
async fn large_vault_metadata_bootstrap_pages_stay_bounded_and_continue() {
    with_self_hosted_sync_test_app("sync_bootstrap_vault_metadata_budget", |app| async move {
        let fixture = build_sync_router_fixture(&app.pool).await;
        let session = app.issue_session(&fixture.owner_user_id).await;
        let headers = authenticated_json_headers(&session.token);
        let large_name = "n".repeat(crate::domains::vaults::VAULT_NAME_MAX_CHARS);
        let large_key = "k".repeat(crate::domains::vaults::key::ENCRYPTED_VAULT_KEY_MAX_BYTES);
        let expected_ids: Vec<String> = (0..70)
            .map(|index| format!("sync_metadata_item_{index:03}"))
            .collect();
        for (index, item_id) in expected_ids.iter().enumerate() {
            let vault_id = format!("sync_metadata_vault_{index:03}");
            seed_vault(
                &app.pool,
                &vault_id,
                &large_name,
                "personal",
                &fixture.owner_user_id,
                None,
            )
            .await;
            seed_vault_key(
                &app.pool,
                &format!("sync_metadata_key_{index:03}"),
                &vault_id,
                &fixture.owner_user_id,
                &large_key,
                "owner",
            )
            .await;
            seed_item(
                &app.pool,
                item_id,
                &vault_id,
                "login",
                "ciphertext",
                "iv",
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
                    &format!("/api/v1/sync/bootstrap?{query}"),
                    None,
                    headers.clone(),
                )
                .await;
            response.assert_contract_status();
            assert!(response.body_bytes <= crate::http::pagination::RESPONSE_PAGE_BYTES);
            seen_ids.extend(
                response.body["items"]
                    .as_array()
                    .expect("bootstrap page should contain items")
                    .iter()
                    .filter_map(|item| item["id"].as_str().map(str::to_string)),
            );
            if response.body["hasMore"] == json!(false) {
                break;
            }
            cursor = Some(
                response.body["nextCursor"]
                    .as_str()
                    .expect("continued bootstrap page should have a cursor")
                    .to_string(),
            );
        }
        for item_id in expected_ids {
            assert_eq!(seen_ids.iter().filter(|seen| **seen == item_id).count(), 1);
        }
    })
    .await;
}

#[tokio::test]
async fn sync_sse_route_covers_auth_and_revocation_paths() {
    with_sync_test_app("sync_http_routes_paths", |app| async move {
        let fixture = build_sync_router_fixture(&app.pool).await;
        let http_app = SyncHttpTestApp::new(app.state.clone());

        let unauthorized = http_app.get(SSE_EVENTS_PATH, HeaderMap::new()).await;
        assert_eq!(unauthorized.status, StatusCode::UNAUTHORIZED);
        assert!(unauthorized.body.contains(r#""code":"UNAUTHORIZED""#));

        let session = app.issue_session(&fixture.owner_user_id).await;
        record_session_revocations(
            &app.pool,
            &fixture.owner_user_id,
            std::slice::from_ref(&session.session_id),
            "device_revoked",
        )
        .await
        .expect("session revocation should seed");

        let stream = http_app
            .get(SSE_EVENTS_PATH, authenticated_json_headers(&session.token))
            .await;
        assert_eq!(stream.status, StatusCode::OK);
        assert_eq!(
            stream
                .headers
                .get(CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .expect("content type should be present"),
            "text/event-stream"
        );
    })
    .await;
}
