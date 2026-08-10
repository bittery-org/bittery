use axum::{
    extract::{FromRequestParts, Query, State},
    http::request::Parts,
    response::Response,
    Extension, Json,
};
use serde::Deserialize;
use utoipa::{IntoParams, ToSchema};
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::{
    config::db_pool,
    http::sync_sse,
    services::sync::{self, BootstrapItemsInput, BootstrapItemsResponse, GetEventsSinceInput},
    AppState,
};

use super::{
    dto::{DecimalString, ProblemDetails, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE},
    error::ApiError,
    extract::AuthenticatedRequest,
};

struct ApiQuery<T>(T);

impl<S, T> FromRequestParts<S> for ApiQuery<T>
where
    S: Send + Sync,
    T: for<'de> Deserialize<'de>,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        Query::<T>::from_request_parts(parts, state)
            .await
            .map(|Query(value)| Self(value))
            .map_err(|error| ApiError::bad_request("INVALID_QUERY", error.body_text()))
    }
}

#[derive(Debug, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[into_params(parameter_in = Query, rename_all = "camelCase")]
struct BootstrapQuery {
    cursor: Option<String>,
    #[serde(default = "default_bootstrap_limit")]
    #[schema(minimum = 1, maximum = 500, default = 500)]
    limit: u16,
}

fn default_bootstrap_limit() -> u16 {
    MAX_PAGE_SIZE
}

#[derive(Debug, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[into_params(parameter_in = Query, rename_all = "camelCase")]
struct ChangesQuery {
    since_id: Option<String>,
    #[schema(max_items = 200)]
    vault_ids: Option<Vec<String>>,
    #[serde(default = "default_changes_limit")]
    #[schema(minimum = 1, maximum = 500, default = 100)]
    limit: u16,
}

fn default_changes_limit() -> u16 {
    DEFAULT_PAGE_SIZE
}

#[derive(Debug, serde::Serialize, ToSchema)]
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

#[derive(Debug, serde::Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct SyncCursorResponse {
    id: String,
}

#[derive(Debug, serde::Serialize, ToSchema)]
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
    ApiQuery(query): ApiQuery<BootstrapQuery>,
) -> Result<Json<BootstrapItemsResponse>, ApiError> {
    let pool = db_pool(&state)?;
    Ok(Json(
        sync::bootstrap_items(
            pool,
            &auth.session.user_id,
            BootstrapItemsInput {
                cursor: query.cursor,
                limit: Some(i32::from(query.limit)),
            },
        )
        .await?,
    ))
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
    ApiQuery(query): ApiQuery<ChangesQuery>,
) -> Result<Json<SyncChangesResponse>, ApiError> {
    let pool = db_pool(&state)?;
    Ok(Json(
        sync::get_events_since(
            pool,
            &auth.session.user_id,
            GetEventsSinceInput {
                since_id: query.since_id,
                vault_ids: query.vault_ids,
                limit: Some(i32::from(query.limit)),
            },
        )
        .await?
        .into(),
    ))
}

#[utoipa::path(
    get,
    path = "/sync/events",
    operation_id = "streamSyncEvents",
    tag = "sync",
    responses(
        (status = 200, description = "Authenticated sync hint stream", content_type = "text/event-stream"),
        (status = 401, description = "Authentication required", body = ProblemDetails, content_type = "application/problem+json"),
        (status = 503, description = "Sync unavailable", body = ProblemDetails, content_type = "application/problem+json")
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
    use serde_json::json;

    use super::{router, SyncChangesResponse};
    use crate::services::sync::{GetEventsSinceResponse, SyncCursorResponse, SyncEventDto};

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
            cursor: Some(SyncCursorResponse {
                id: "sync_event_test".to_string(),
            }),
            has_more: false,
            requires_full_refresh: false,
        }
        .into();

        let json = serde_json::to_value(response).expect("response should serialize");
        assert_eq!(json["events"][0]["timestamp"], json!(i64::MAX.to_string()));
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
