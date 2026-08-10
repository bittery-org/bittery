use axum::{
    extract::{rejection::QueryRejection, FromRequestParts, Query, State},
    http::request::Parts,
    Json,
};
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, IntoResponses, ToSchema};
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::{
    config::db_pool,
    services::audit::{self, TeamEventsInput},
    AppState,
};

use super::{dto::ProblemDetails, error::ApiError, extract::AuthenticatedRequest};

const MAX_AUDIT_EVENTS: u16 = 100;
const MAX_SEARCH_BYTES: usize = 200;

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
            .map_err(|error: QueryRejection| {
                ApiError::bad_request("INVALID_QUERY", error.body_text())
            })
    }
}

#[derive(Debug, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[into_params(parameter_in = Query, rename_all = "camelCase")]
struct AuditEventsQuery {
    cursor: Option<String>,
    #[param(minimum = 1, maximum = 100, default = 50)]
    #[schema(minimum = 1, maximum = 100, default = 50)]
    limit: Option<u16>,
    from: Option<String>,
    to: Option<String>,
    #[param(inline)]
    action_group: Option<AuditActionGroupFilter>,
    actor_user_id: Option<String>,
    #[param(inline)]
    result: Option<AuditResultFilter>,
    #[param(max_length = 200)]
    #[schema(max_length = 200)]
    search: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
enum AuditActionGroupFilter {
    Auth,
    Team,
    Vault,
    Item,
    Share,
    Other,
    All,
}

impl From<AuditActionGroupFilter> for audit::AuditActionGroupFilter {
    fn from(value: AuditActionGroupFilter) -> Self {
        match value {
            AuditActionGroupFilter::Auth => Self::Auth,
            AuditActionGroupFilter::Team => Self::Team,
            AuditActionGroupFilter::Vault => Self::Vault,
            AuditActionGroupFilter::Item => Self::Item,
            AuditActionGroupFilter::Share => Self::Share,
            AuditActionGroupFilter::Other => Self::Other,
            AuditActionGroupFilter::All => Self::All,
        }
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
enum AuditResultFilter {
    Success,
    Failure,
    All,
}

impl From<AuditResultFilter> for audit::AuditResultFilter {
    fn from(value: AuditResultFilter) -> Self {
        match value {
            AuditResultFilter::Success => Self::Success,
            AuditResultFilter::Failure => Self::Failure,
            AuditResultFilter::All => Self::All,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
enum EventSource {
    AuditLog,
    ShareAccessLog,
}

impl From<audit::EventSource> for EventSource {
    fn from(value: audit::EventSource) -> Self {
        match value {
            audit::EventSource::AuditLog => Self::AuditLog,
            audit::EventSource::ShareAccessLog => Self::ShareAccessLog,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "lowercase")]
enum AuditActionGroup {
    Auth,
    Team,
    Vault,
    Item,
    Share,
    Other,
}

impl From<audit::AuditActionGroup> for AuditActionGroup {
    fn from(value: audit::AuditActionGroup) -> Self {
        match value {
            audit::AuditActionGroup::Auth => Self::Auth,
            audit::AuditActionGroup::Team => Self::Team,
            audit::AuditActionGroup::Vault => Self::Vault,
            audit::AuditActionGroup::Item => Self::Item,
            audit::AuditActionGroup::Share => Self::Share,
            audit::AuditActionGroup::Other => Self::Other,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "lowercase")]
enum TeamEventResult {
    Success,
    Failure,
}

impl From<audit::TeamEventResult> for TeamEventResult {
    fn from(value: audit::TeamEventResult) -> Self {
        match value {
            audit::TeamEventResult::Success => Self::Success,
            audit::TeamEventResult::Failure => Self::Failure,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct TeamEventActor {
    #[serde(skip_serializing_if = "Option::is_none")]
    user_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    email: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
struct TeamEventEntity {
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    entity_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct TeamEventNetwork {
    #[serde(skip_serializing_if = "Option::is_none")]
    masked_ip: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    masked_user_agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    full_ip: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    full_user_agent: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct TeamEvent {
    id: String,
    timestamp: String,
    source: EventSource,
    action: String,
    action_group: AuditActionGroup,
    actor: TeamEventActor,
    entity: TeamEventEntity,
    result: TeamEventResult,
    network: TeamEventNetwork,
    #[serde(skip_serializing_if = "Option::is_none")]
    metadata: Option<serde_json::Value>,
}

impl From<audit::TeamEvent> for TeamEvent {
    fn from(value: audit::TeamEvent) -> Self {
        Self {
            id: value.id,
            timestamp: value.timestamp,
            source: value.source.into(),
            action: value.action,
            action_group: value.action_group.into(),
            actor: TeamEventActor {
                user_id: value.actor.user_id,
                name: value.actor.name,
                email: value.actor.email,
            },
            entity: TeamEventEntity {
                entity_type: value.entity.r#type,
                id: value.entity.id,
            },
            result: value.result.into(),
            network: TeamEventNetwork {
                masked_ip: value.network.masked_ip,
                masked_user_agent: value.network.masked_user_agent,
                full_ip: value.network.full_ip,
                full_user_agent: value.network.full_user_agent,
            },
            metadata: value.metadata,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct AuditEventsResponse {
    #[schema(max_items = 100)]
    events: Vec<TeamEvent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_cursor: Option<String>,
}

impl From<audit::TeamEventsResponse> for AuditEventsResponse {
    fn from(value: audit::TeamEventsResponse) -> Self {
        Self {
            events: value.events.into_iter().map(Into::into).collect(),
            next_cursor: value.next_cursor,
        }
    }
}

#[derive(IntoResponses)]
#[allow(dead_code)]
enum AuditErrorResponses {
    #[response(
        status = 400,
        description = "Invalid filters or cursor",
        content_type = "application/problem+json"
    )]
    BadRequest(ProblemDetails),
    #[response(
        status = 401,
        description = "Authentication required",
        content_type = "application/problem+json"
    )]
    Unauthorized(ProblemDetails),
    #[response(
        status = 403,
        description = "Team administrator access required",
        content_type = "application/problem+json"
    )]
    Forbidden(ProblemDetails),
    #[response(
        status = 500,
        description = "Internal error",
        content_type = "application/problem+json"
    )]
    Internal(ProblemDetails),
}

fn validate_query(query: &AuditEventsQuery) -> Result<(), ApiError> {
    if query
        .limit
        .is_some_and(|limit| limit == 0 || limit > MAX_AUDIT_EVENTS)
    {
        return Err(ApiError::bad_request(
            "INVALID_LIMIT",
            format!("The audit event limit must be between 1 and {MAX_AUDIT_EVENTS}."),
        ));
    }
    if query
        .search
        .as_ref()
        .is_some_and(|search| search.len() > MAX_SEARCH_BYTES)
    {
        return Err(ApiError::bad_request(
            "SEARCH_TOO_LONG",
            format!("Audit search text may contain at most {MAX_SEARCH_BYTES} bytes."),
        ));
    }
    Ok(())
}

#[utoipa::path(get, path = "/audit-events", operation_id = "listAuditEvents", tag = "audit", params(AuditEventsQuery), responses((status = 200, body = AuditEventsResponse), AuditErrorResponses))]
async fn list_audit_events(
    State(state): State<AppState>,
    request: AuthenticatedRequest,
    ApiQuery(query): ApiQuery<AuditEventsQuery>,
) -> Result<Json<AuditEventsResponse>, ApiError> {
    validate_query(&query)?;
    Ok(Json(
        audit::get_team_events(
            db_pool(&state)?,
            &request.session.user_id,
            TeamEventsInput {
                cursor: query.cursor,
                limit: query.limit.map(u32::from),
                from: query.from,
                to: query.to,
                action_group: query.action_group.map(Into::into),
                actor_user_id: query.actor_user_id,
                result: query.result.map(Into::into),
                search: query.search,
            },
        )
        .await?
        .into(),
    ))
}

pub(crate) fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new().routes(routes!(list_audit_events))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{router, validate_query, AuditEventsQuery, MAX_AUDIT_EVENTS};

    #[test]
    fn router_registers_the_used_audit_operation() {
        let document = serde_json::to_value(router().split_for_parts().1).unwrap();
        assert_eq!(document.to_string().matches("operationId").count(), 1);
    }

    #[test]
    fn audit_query_enforces_bounds_and_rejects_unknown_fields() {
        let invalid_limit: AuditEventsQuery = serde_json::from_value(json!({
            "limit": MAX_AUDIT_EVENTS + 1
        }))
        .unwrap();
        assert!(validate_query(&invalid_limit).is_err());
        assert!(serde_json::from_value::<AuditEventsQuery>(json!({ "unknown": true })).is_err());
    }
}
