use std::future::Future;

use axum::{
    body::{to_bytes, Body},
    http::{header::CONTENT_TYPE, HeaderMap, HeaderValue, Method, Request, StatusCode},
    Router as HttpRouter,
};
use rand::random;
use serde_json::{json, Value};
use sqlx::{query, PgPool};
use time::{macros::datetime, OffsetDateTime};
use tower::util::ServiceExt;

use super::*;
use crate::error::AppErrorCode;
use crate::{
    services::session_control::record_session_revocations,
    test_support::{
        acquire_env_lock, acquire_env_lock_async, authenticated_json_headers, seed_item, seed_user,
        seed_vault, seed_vault_key, with_api_test_app, ApiTestApp,
    },
    AppState,
};

fn with_bittery_mode<T>(value: Option<&str>, test_fn: impl FnOnce() -> T) -> T {
    let _guard = acquire_env_lock();
    let previous = std::env::var("BITTERY_MODE").ok();

    match value {
        Some(value) => unsafe { std::env::set_var("BITTERY_MODE", value) },
        None => unsafe { std::env::remove_var("BITTERY_MODE") },
    }

    let result = test_fn();

    match previous.as_deref() {
        Some(value) => unsafe { std::env::set_var("BITTERY_MODE", value) },
        None => unsafe { std::env::remove_var("BITTERY_MODE") },
    }

    result
}

async fn with_bittery_mode_async<T, F>(value: Option<&str>, future: F) -> T
where
    F: Future<Output = T>,
{
    let _guard = acquire_env_lock_async().await;
    let previous = std::env::var("BITTERY_MODE").ok();
    match value {
        Some(value) => unsafe { std::env::set_var("BITTERY_MODE", value) },
        None => unsafe { std::env::remove_var("BITTERY_MODE") },
    }

    let result = future.await;

    match previous.as_deref() {
        Some(value) => unsafe { std::env::set_var("BITTERY_MODE", value) },
        None => unsafe { std::env::remove_var("BITTERY_MODE") },
    }

    result
}

#[test]
fn sync_notification_session_revoked_serializes_correctly() {
    use crate::services::sync_pubsub::SyncNotification;

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
fn validate_client_id_accepts_and_rejects_expected_values() {
    assert!(validate_client_id("client_1-test").is_ok());
    assert!(validate_client_id("").is_err());
    assert!(validate_client_id("contains space").is_err());
    assert!(validate_client_id(&"a".repeat(65)).is_err());
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
fn bittery_mode_normalizes_self_hosted_variants() {
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
    with_bittery_mode(None, || {
        assert_eq!(bittery_mode(), "cloud");
    });
}

#[test]
fn sync_event_dto_parses_metadata_and_rejects_invalid_json() {
    let payload = sync_event_dto(DbSyncEventRow {
        id: "event-1".to_string(),
        seq: 1,
        event_type: "item_updated".to_string(),
        entity_id: "item-1".to_string(),
        entity_type: "item".to_string(),
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
        event_type: "item_updated".to_string(),
        entity_id: "item-1".to_string(),
        entity_type: "item".to_string(),
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
    use crate::services::sync_pubsub::SyncPubSub;

    let pubsub = SyncPubSub::new();
    let (mut sync_rx, _control_rx) = pubsub.subscribe("user-1").await;

    pubsub.notify_sync();

    let result = sync_rx.recv().await;
    assert!(result.is_ok(), "sync notification should be received");
}

#[tokio::test]
async fn sync_pubsub_broadcasts_session_revocation() {
    use crate::services::sync_pubsub::{SyncNotification, SyncPubSub};

    let pubsub = SyncPubSub::new();
    let (_sync_rx, mut control_rx) = pubsub.subscribe("user-1").await;

    pubsub.notify_session_revoked("user-1", "session-1", "device_revoked");

    // Give the spawned task a moment to send
    tokio::time::sleep(std::time::Duration::from_millis(10)).await;

    let notification = control_rx
        .try_recv()
        .expect("control notification should be received");
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
    hidden_item_id: String,
    old_primary_event_id: String,
    latest_primary_event_id: String,
    secondary_event_id: String,
    hidden_event_id: String,
}

fn unauthenticated_json_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert("x-app-platform", HeaderValue::from_static("desktop"));
    headers.insert("x-client-id", HeaderValue::from_static("integration-test"));
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
        hidden_item_id,
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
async fn bootstrap_items_returns_paginated_items_with_vault_details_and_attachments() {
    with_bittery_mode_async(Some("self-hosted"), async {
        with_sync_test_app("sync_bootstrap_items_success", |app| async move {
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

            let second_page_path =
                format!("/api/v1/sync/bootstrap?cursor={}", fixture.primary_item_id);
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
        })
        .await;
    })
    .await;
}

#[tokio::test]
async fn sync_sse_route_covers_auth_and_revocation_paths() {
    with_sync_test_app("sync_http_routes_paths", |app| async move {
        let fixture = build_sync_router_fixture(&app.pool).await;
        let http_app = SyncHttpTestApp::new(app.state.clone());

        let unauthorized = http_app.get("/api/v1/sync/events", HeaderMap::new()).await;
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
            .get(
                "/api/v1/sync/events",
                authenticated_json_headers(&session.token),
            )
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
