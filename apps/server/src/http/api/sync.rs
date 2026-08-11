use axum::{
    extract::{FromRequestParts, State},
    http::request::Parts,
    response::Response,
    Extension, Json,
};
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::{config::db_pool, http::sync_sse, services::sync, AppState};

use super::{
    dto::{DecimalString, ProblemDetails, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE},
    error::ApiError,
    extract::{ApiQuery, AuthenticatedRequest},
    pagination::{truncate_serialized, RESPONSE_PAGE_ITEMS_BYTES},
};

#[derive(Debug, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[into_params(parameter_in = Query, rename_all = "camelCase")]
struct BootstrapQuery {
    cursor: Option<String>,
    sync_cursor: Option<String>,
    #[serde(default)]
    sync_cursor_captured: bool,
    #[serde(default = "default_bootstrap_limit")]
    #[schema(minimum = 1, maximum = 500, default = 500)]
    limit: u16,
}

fn default_bootstrap_limit() -> u16 {
    MAX_PAGE_SIZE
}

impl From<BootstrapQuery> for sync::BootstrapItemsInput {
    fn from(value: BootstrapQuery) -> Self {
        Self {
            cursor: value.cursor,
            sync_cursor: value.sync_cursor,
            sync_cursor_captured: value.sync_cursor_captured,
            limit: Some(i32::from(value.limit)),
        }
    }
}

#[derive(Debug)]
struct BootstrapApiQuery(BootstrapQuery);

impl<S> FromRequestParts<S> for BootstrapApiQuery
where
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let ApiQuery(query) = ApiQuery::<BootstrapQuery>::from_request_parts(parts, state).await?;
        validate_page_limit(query.limit)?;
        Ok(Self(query))
    }
}

#[derive(Debug, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[into_params(parameter_in = Query, rename_all = "camelCase")]
struct ChangesQuery {
    since_id: Option<String>,
    /// Repeat `vaultIds` for each filter value.
    #[param(style = Form, explode)]
    #[schema(max_items = 200)]
    vault_ids: Option<Vec<String>>,
    #[serde(default = "default_changes_limit")]
    #[schema(minimum = 1, maximum = 500, default = 100)]
    limit: u16,
}

#[derive(Debug)]
struct ChangesApiQuery(ChangesQuery);

impl<S> FromRequestParts<S> for ChangesApiQuery
where
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        let mut since_id = None;
        let mut vault_ids = Vec::new();
        let mut limit = None;

        for (name, value) in
            url::form_urlencoded::parse(parts.uri.query().unwrap_or_default().as_bytes())
        {
            match name.as_ref() {
                "sinceId" if since_id.is_none() => since_id = Some(value.into_owned()),
                "vaultIds" => vault_ids.push(value.into_owned()),
                "limit" if limit.is_none() => {
                    limit = Some(value.parse::<u16>().map_err(|_| {
                        ApiError::bad_request("INVALID_QUERY", "limit must be an integer")
                    })?);
                }
                "sinceId" | "limit" => {
                    return Err(ApiError::bad_request(
                        "INVALID_QUERY",
                        format!("{name} must not be repeated"),
                    ));
                }
                _ => {
                    return Err(ApiError::bad_request(
                        "INVALID_QUERY",
                        format!("unknown query field: {name}"),
                    ));
                }
            }
        }

        if vault_ids.len() > 200 {
            return Err(ApiError::bad_request(
                "INVALID_QUERY",
                "vaultIds must contain at most 200 values",
            ));
        }

        let limit = limit.unwrap_or_else(default_changes_limit);
        validate_page_limit(limit)?;

        Ok(Self(ChangesQuery {
            since_id,
            vault_ids: (!vault_ids.is_empty()).then_some(vault_ids),
            limit,
        }))
    }
}

fn default_changes_limit() -> u16 {
    DEFAULT_PAGE_SIZE
}

fn validate_page_limit(limit: u16) -> Result<(), ApiError> {
    if limit == 0 {
        return Err(ApiError::bad_request("BAD_REQUEST", "Invalid params"));
    }
    if limit <= MAX_PAGE_SIZE {
        return Ok(());
    }

    Err(ApiError::bad_request(
        "INVALID_PAGE_LIMIT",
        format!("limit must be between 1 and {MAX_PAGE_SIZE}"),
    ))
}

impl From<ChangesQuery> for sync::GetEventsSinceInput {
    fn from(value: ChangesQuery) -> Self {
        Self {
            since_id: value.since_id,
            vault_ids: value.vault_ids,
            limit: Some(i32::from(value.limit)),
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct BootstrapVaultSummary {
    id: String,
    name: String,
    vault_type: String,
    icon: Option<String>,
    image_url: Option<String>,
    encrypted_vault_key: String,
    role: String,
}

impl From<sync::BootstrapVaultSummary> for BootstrapVaultSummary {
    fn from(value: sync::BootstrapVaultSummary) -> Self {
        Self {
            id: value.id,
            name: value.name,
            vault_type: value.vault_type,
            icon: value.icon,
            image_url: value.image_url,
            encrypted_vault_key: value.encrypted_vault_key,
            role: value.role,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct BootstrapAttachmentResponse {
    id: String,
    item_id: String,
    vault_id: String,
    storage_key: String,
    encrypted_name: String,
    encrypted_content_type: String,
    encryption_iv: String,
    encrypted_content_type_iv: String,
    encryption_algorithm: String,
    file_size: i32,
    uploaded_by: String,
    created_at: String,
}

impl From<sync::BootstrapAttachmentResponse> for BootstrapAttachmentResponse {
    fn from(value: sync::BootstrapAttachmentResponse) -> Self {
        Self {
            id: value.id,
            item_id: value.item_id,
            vault_id: value.vault_id,
            storage_key: value.storage_key,
            encrypted_name: value.encrypted_name,
            encrypted_content_type: value.encrypted_content_type,
            encryption_iv: value.encryption_iv,
            encrypted_content_type_iv: value.encrypted_content_type_iv,
            encryption_algorithm: value.encryption_algorithm,
            file_size: value.file_size,
            uploaded_by: value.uploaded_by,
            created_at: value.created_at,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct BootstrapItemResponse {
    id: String,
    vault_id: String,
    category: String,
    favorite: bool,
    encrypted_data: String,
    encryption_iv: String,
    encryption_algorithm: String,
    version: i32,
    encryption_version: i32,
    encrypted_by_user_id: String,
    last_modified_by: String,
    created_at: String,
    updated_at: String,
    deleted_at: Option<String>,
    attachments: Vec<BootstrapAttachmentResponse>,
    vault: Option<BootstrapVaultSummary>,
}

impl From<sync::BootstrapItemResponse> for BootstrapItemResponse {
    fn from(value: sync::BootstrapItemResponse) -> Self {
        Self {
            id: value.id,
            vault_id: value.vault_id,
            category: value.category,
            favorite: value.favorite,
            encrypted_data: value.encrypted_data,
            encryption_iv: value.encryption_iv,
            encryption_algorithm: value.encryption_algorithm,
            version: value.version,
            encryption_version: value.encryption_version,
            encrypted_by_user_id: value.encrypted_by_user_id,
            last_modified_by: value.last_modified_by,
            created_at: value.created_at,
            updated_at: value.updated_at,
            deleted_at: value.deleted_at,
            attachments: value.attachments.into_iter().map(Into::into).collect(),
            vault: value.vault.map(Into::into),
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct BootstrapItemsResponse {
    items: Vec<BootstrapItemResponse>,
    next_cursor: Option<String>,
    sync_cursor: Option<SyncCursorResponse>,
    has_more: bool,
}

impl From<sync::BootstrapItemsResponse> for BootstrapItemsResponse {
    fn from(value: sync::BootstrapItemsResponse) -> Self {
        Self {
            items: value.items.into_iter().map(Into::into).collect(),
            next_cursor: value.next_cursor,
            sync_cursor: value
                .sync_cursor
                .map(|cursor| SyncCursorResponse { id: cursor.id }),
            has_more: value.has_more,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct SyncEventResponse {
    id: String,
    #[serde(rename = "type")]
    event_type: String,
    entity_id: String,
    entity_type: String,
    vault_id: Option<String>,
    version: i32,
    client_id: Option<String>,
    user_id: String,
    metadata: Option<serde_json::Value>,
    timestamp: DecimalString,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct SyncCursorResponse {
    id: String,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct SyncChangesResponse {
    #[schema(max_items = 500)]
    events: Vec<SyncEventResponse>,
    cursor: Option<SyncCursorResponse>,
    has_more: bool,
    requires_full_refresh: bool,
}

impl From<sync::GetEventsSinceResponse> for SyncChangesResponse {
    fn from(value: sync::GetEventsSinceResponse) -> Self {
        Self {
            events: value
                .events
                .into_iter()
                .map(|event| SyncEventResponse {
                    id: event.id,
                    event_type: event.event_type,
                    entity_id: event.entity_id,
                    entity_type: event.entity_type,
                    vault_id: event.vault_id,
                    version: event.version,
                    client_id: event.client_id,
                    user_id: event.user_id,
                    metadata: event.metadata,
                    timestamp: event.timestamp.into(),
                })
                .collect(),
            cursor: value
                .cursor
                .map(|cursor| SyncCursorResponse { id: cursor.id }),
            has_more: value.has_more,
            requires_full_refresh: value.requires_full_refresh,
        }
    }
}

#[utoipa::path(
    get,
    path = "/sync/bootstrap",
    operation_id = "bootstrapSync",
    tag = "sync",
    params(BootstrapQuery),
    responses(
        (status = 200, description = "A bounded bootstrap page", body = BootstrapItemsResponse),
        (status = 400, description = "Invalid cursor or limit", body = ProblemDetails, content_type = "application/problem+json"),
        (status = 401, description = "Authentication required", body = ProblemDetails, content_type = "application/problem+json"),
        (status = 500, description = "Internal error", body = ProblemDetails, content_type = "application/problem+json")
    )
)]
async fn bootstrap(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    BootstrapApiQuery(query): BootstrapApiQuery,
) -> Result<Json<BootstrapItemsResponse>, ApiError> {
    let pool = db_pool(&state)?;
    let mut response: BootstrapItemsResponse =
        sync::bootstrap_items(pool, &auth.session.user_id, query.into())
            .await?
            .into();
    if truncate_serialized(&mut response.items, RESPONSE_PAGE_ITEMS_BYTES)? {
        response.has_more = true;
        response.next_cursor = response.items.last().map(|item| item.id.clone());
    }
    Ok(Json(response))
}

#[utoipa::path(
    get,
    path = "/sync/changes",
    operation_id = "getSyncChanges",
    tag = "sync",
    params(ChangesQuery),
    responses(
        (status = 200, description = "A bounded sync event page", body = SyncChangesResponse),
        (status = 400, description = "Invalid cursor, vault filter or limit", body = ProblemDetails, content_type = "application/problem+json"),
        (status = 401, description = "Authentication required", body = ProblemDetails, content_type = "application/problem+json"),
        (status = 500, description = "Internal error", body = ProblemDetails, content_type = "application/problem+json")
    )
)]
async fn changes(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    ChangesApiQuery(query): ChangesApiQuery,
) -> Result<Json<SyncChangesResponse>, ApiError> {
    let pool = db_pool(&state)?;
    let mut response: SyncChangesResponse =
        sync::get_events_since(pool, &auth.session.user_id, query.into())
            .await?
            .into();
    if truncate_serialized(&mut response.events, RESPONSE_PAGE_ITEMS_BYTES)? {
        response.has_more = true;
        response.cursor = response.events.last().map(|event| SyncCursorResponse {
            id: event.id.clone(),
        });
    }
    Ok(Json(response))
}

#[utoipa::path(
    get,
    path = "/sync/events",
    operation_id = "streamSyncEvents",
    tag = "sync",
    responses(
        (status = 200, description = "Authenticated sync hint stream", content_type = "text/event-stream"),
        (status = 401, description = "Authentication required", body = ProblemDetails, content_type = "application/problem+json"),
        (status = 503, description = "Sync unavailable", body = ProblemDetails, content_type = "application/problem+json", headers(("Retry-After" = String, description = "Seconds before retrying")))
    )
)]
async fn events(State(state): State<AppState>, auth: AuthenticatedRequest) -> Response {
    sync_sse::sync_events(State(state), Some(Extension(auth.session))).await
}

pub(crate) fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(bootstrap))
        .routes(routes!(changes))
        .routes(routes!(events))
}

#[cfg(test)]
mod tests {
    use axum::{extract::FromRequestParts, http::Request};
    use serde_json::json;

    use super::{
        router, BootstrapApiQuery, BootstrapItemsResponse, BootstrapQuery, ChangesApiQuery,
        ChangesQuery, SyncChangesResponse,
    };
    use crate::http::api::dto::MAX_PAGE_SIZE;
    use crate::services::sync::{
        BootstrapAttachmentResponse as ServiceBootstrapAttachmentResponse,
        BootstrapItemResponse as ServiceBootstrapItemResponse,
        BootstrapItemsResponse as ServiceBootstrapItemsResponse,
        BootstrapVaultSummary as ServiceBootstrapVaultSummary, GetEventsSinceResponse,
        SyncCursorResponse as ServiceSyncCursorResponse, SyncEventDto,
    };

    #[test]
    fn bootstrap_wire_mapping_preserves_camel_case_and_nullable_fields() {
        let response: BootstrapItemsResponse = ServiceBootstrapItemsResponse {
            items: vec![ServiceBootstrapItemResponse {
                id: "item_test".to_string(),
                vault_id: "vault_test".to_string(),
                category: "login".to_string(),
                favorite: true,
                encrypted_data: "ciphertext".to_string(),
                encryption_iv: "item-iv".to_string(),
                encryption_algorithm: "aes-256-gcm".to_string(),
                version: 3,
                encryption_version: 3,
                encrypted_by_user_id: "user_test".to_string(),
                last_modified_by: "user_test".to_string(),
                created_at: "2026-08-10T10:00:00Z".to_string(),
                updated_at: "2026-08-10T11:00:00Z".to_string(),
                deleted_at: None,
                attachments: vec![ServiceBootstrapAttachmentResponse {
                    id: "attachment_test".to_string(),
                    item_id: "item_test".to_string(),
                    vault_id: "vault_test".to_string(),
                    storage_key: "attachments/test".to_string(),
                    encrypted_name: "encrypted-name".to_string(),
                    encrypted_content_type: "encrypted-type".to_string(),
                    encryption_iv: "attachment-iv".to_string(),
                    encrypted_content_type_iv: "content-type-iv".to_string(),
                    encryption_algorithm: "aes-256-gcm".to_string(),
                    file_size: 42,
                    uploaded_by: "user_test".to_string(),
                    created_at: "2026-08-10T10:30:00Z".to_string(),
                }],
                vault: Some(ServiceBootstrapVaultSummary {
                    id: "vault_test".to_string(),
                    name: "encrypted-vault-name".to_string(),
                    vault_type: "personal".to_string(),
                    icon: None,
                    image_url: None,
                    encrypted_vault_key: "wrapped-key".to_string(),
                    role: "owner".to_string(),
                }),
            }],
            next_cursor: Some("item_test".to_string()),
            sync_cursor: Some(ServiceSyncCursorResponse {
                id: "event_test".to_string(),
            }),
            has_more: true,
        }
        .into();

        let json = serde_json::to_value(response).expect("bootstrap response should serialize");
        assert_eq!(json["nextCursor"], json!("item_test"));
        assert_eq!(json["syncCursor"]["id"], json!("event_test"));
        assert_eq!(json["items"][0]["lastModifiedBy"], json!("user_test"));
        assert_eq!(json["items"][0]["attachments"][0]["fileSize"], json!(42));
        assert_eq!(
            json["items"][0]["attachments"][0]["encryptedContentTypeIv"],
            json!("content-type-iv")
        );
        assert_eq!(json["items"][0]["vault"]["vaultType"], json!("personal"));
    }

    #[test]
    fn sync_query_dtos_reject_unknown_fields() {
        assert!(serde_json::from_value::<BootstrapQuery>(json!({
            "limit": 100,
            "unknown": true
        }))
        .is_err());
        assert!(serde_json::from_value::<ChangesQuery>(json!({
            "limit": 100,
            "unknown": true
        }))
        .is_err());
    }

    #[test]
    fn sync_timestamps_are_decimal_strings() {
        let response: SyncChangesResponse = GetEventsSinceResponse {
            events: vec![SyncEventDto {
                id: "sync_event_test".to_string(),
                event_type: "item_updated".to_string(),
                entity_id: "item_test".to_string(),
                entity_type: "item".to_string(),
                vault_id: Some("vault_test".to_string()),
                version: 2,
                client_id: None,
                user_id: "user_test".to_string(),
                metadata: None,
                timestamp: i64::MAX,
            }],
            cursor: Some(ServiceSyncCursorResponse {
                id: "sync_event_test".to_string(),
            }),
            has_more: false,
            requires_full_refresh: false,
        }
        .into();

        let json = serde_json::to_value(response).expect("response should serialize");
        assert_eq!(json["events"][0]["timestamp"], json!(i64::MAX.to_string()));
    }

    #[tokio::test]
    async fn changes_query_accepts_openapi_exploded_vault_filters() {
        let (mut parts, _) = Request::builder()
            .uri("/sync/changes?vaultIds=vault_a&vaultIds=vault_b&limit=25")
            .body(())
            .unwrap()
            .into_parts();

        let ChangesApiQuery(query) = ChangesApiQuery::from_request_parts(&mut parts, &())
            .await
            .expect("OpenAPI form+explode arrays should deserialize");
        assert_eq!(
            query.vault_ids,
            Some(vec!["vault_a".into(), "vault_b".into()])
        );
        assert_eq!(query.limit, 25);
    }

    #[tokio::test]
    async fn changes_query_rejects_unknown_fields() {
        let (mut parts, _) = Request::builder()
            .uri("/sync/changes?unknown=true")
            .body(())
            .unwrap()
            .into_parts();

        let rejection = ChangesApiQuery::from_request_parts(&mut parts, &())
            .await
            .expect_err("unknown query fields should be rejected");
        assert_eq!(rejection.code(), "INVALID_QUERY");
    }

    #[tokio::test]
    async fn sync_query_limits_match_the_published_page_bound() {
        for (limit, expected_code) in [
            (0, "BAD_REQUEST"),
            (MAX_PAGE_SIZE + 1, "INVALID_PAGE_LIMIT"),
        ] {
            let (mut bootstrap_parts, _) = Request::builder()
                .uri(format!("/sync/bootstrap?limit={limit}"))
                .body(())
                .unwrap()
                .into_parts();
            let rejection = BootstrapApiQuery::from_request_parts(&mut bootstrap_parts, &())
                .await
                .expect_err("bootstrap limit outside the published bound must be rejected");
            assert_eq!(rejection.code(), expected_code);

            let (mut changes_parts, _) = Request::builder()
                .uri(format!("/sync/changes?limit={limit}"))
                .body(())
                .unwrap()
                .into_parts();
            let rejection = ChangesApiQuery::from_request_parts(&mut changes_parts, &())
                .await
                .expect_err("changes limit outside the published bound must be rejected");
            assert_eq!(rejection.code(), expected_code);
        }

        for limit in [1, MAX_PAGE_SIZE] {
            let (mut bootstrap_parts, _) = Request::builder()
                .uri(format!("/sync/bootstrap?limit={limit}"))
                .body(())
                .unwrap()
                .into_parts();
            let BootstrapApiQuery(bootstrap_query) =
                BootstrapApiQuery::from_request_parts(&mut bootstrap_parts, &())
                    .await
                    .expect("bootstrap limit at the published bound must be accepted");
            assert_eq!(bootstrap_query.limit, limit);

            let (mut changes_parts, _) = Request::builder()
                .uri(format!("/sync/changes?limit={limit}"))
                .body(())
                .unwrap()
                .into_parts();
            let ChangesApiQuery(changes_query) =
                ChangesApiQuery::from_request_parts(&mut changes_parts, &())
                    .await
                    .expect("changes limit at the published bound must be accepted");
            assert_eq!(changes_query.limit, limit);
        }
    }

    #[test]
    fn sync_openapi_uses_transport_owned_bootstrap_schemas() {
        let openapi = serde_json::to_value(router().split_for_parts().1).unwrap();
        assert_eq!(
            openapi["paths"]["/sync/bootstrap"]["get"]["responses"]["200"]["content"]
                ["application/json"]["schema"]["$ref"],
            "#/components/schemas/BootstrapItemsResponse"
        );
        assert_eq!(
            openapi["components"]["schemas"]["BootstrapAttachmentResponse"]["properties"]
                ["fileSize"]["format"],
            "int32"
        );
        assert!(
            !openapi["components"]["schemas"]["BootstrapItemResponse"]["required"]
                .as_array()
                .unwrap()
                .contains(&json!("lastModifiedBy"))
        );
    }

    #[test]
    fn router_registers_only_bootstrap_changes_and_sse() {
        let openapi = serde_json::to_value(router().split_for_parts().1).unwrap();
        let rendered = openapi.to_string();
        assert_eq!(rendered.matches("operationId").count(), 3);
        for unused in [
            "checkConflict",
            "acknowledgeEvents",
            "getLastAcknowledged",
            "getSyncState",
        ] {
            assert!(!rendered.contains(unused));
        }
    }
}
