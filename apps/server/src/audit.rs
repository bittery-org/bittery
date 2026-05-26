use std::collections::HashMap;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use qubit::{
    builder::IntoResponse,
    handler,
    server::{ErrorCode, Router, RpcError},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{query_as, PgPool};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use ts_rs::TS;

use crate::{
    auth::RefreshSessionContext,
    server_support::{bittery_mode, db_pool as load_db_pool},
    team_billing::team_management_enabled as shared_team_management_enabled,
    AppState,
};

const DEFAULT_LIMIT: u32 = 50;
const MAX_LIMIT: u32 = 100;
const MAX_SCAN_ROWS: i64 = 512;

const AUTH_ACTIONS: &[&str] = &[
    "password_reset_via_recovery",
    "logout_all",
    "email_changed",
    "password_changed",
    "secret_key_regenerated",
    "device_revoked",
    "account_deleted",
];

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TeamEventsInput {
    pub cursor: Option<String>,
    pub limit: Option<u32>,
    pub from: Option<String>,
    pub to: Option<String>,
    pub action_group: Option<AuditActionGroupFilter>,
    pub actor_user_id: Option<String>,
    pub result: Option<AuditResultFilter>,
    pub search: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AuditActionGroupFilter {
    Auth,
    Team,
    Vault,
    Item,
    Share,
    Other,
    All,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AuditResultFilter {
    Success,
    Failure,
    All,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EventSource {
    AuditLog,
    ShareAccessLog,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AuditActionGroup {
    Auth,
    Team,
    Vault,
    Item,
    Share,
    Other,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TeamEventResult {
    Success,
    Failure,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TeamEventActor {
    pub user_id: Option<String>,
    pub name: Option<String>,
    pub email: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TeamEventEntity {
    pub r#type: Option<String>,
    pub id: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TeamEventNetwork {
    pub masked_ip: Option<String>,
    pub masked_user_agent: Option<String>,
    pub full_ip: Option<String>,
    pub full_user_agent: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TeamEvent {
    pub id: String,
    pub timestamp: String,
    pub source: EventSource,
    pub action: String,
    pub action_group: AuditActionGroup,
    pub actor: TeamEventActor,
    pub entity: TeamEventEntity,
    pub result: TeamEventResult,
    pub network: TeamEventNetwork,
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TeamEventsResponse {
    pub events: Vec<TeamEvent>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AuditRpcError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct CursorPayload {
    timestamp: String,
    source: EventSource,
    id: String,
}

#[derive(Debug, sqlx::FromRow)]
struct AuditActorRow {
    team_id: Option<String>,
    role: String,
    billing_plan: Option<String>,
    billing_status: Option<String>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct TeamMemberRow {
    id: String,
    name: Option<String>,
    email: Option<String>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct AuditEventRow {
    id: String,
    user_id: String,
    action: String,
    entity_type: Option<String>,
    entity_id: Option<String>,
    ip_address: Option<String>,
    user_agent: Option<String>,
    metadata: Option<String>,
    created_at: OffsetDateTime,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct ShareAccessEventRow {
    id: String,
    share_link_id: String,
    created_by_id: String,
    accessed_by_email: Option<String>,
    ip_address: Option<String>,
    user_agent: Option<String>,
    success: bool,
    failure_reason: Option<String>,
    accessed_at: OffsetDateTime,
}

#[allow(non_snake_case)]
#[handler(query)]
pub async fn teamEvents(
    ctx: RefreshSessionContext,
    input: TeamEventsInput,
) -> Result<TeamEventsResponse, AuditRpcError> {
    let pool = load_db_pool(&ctx.app_state, internal_error)?;

    let actor = load_actor(pool, &ctx.session.user_id).await?;
    let team_id = actor
        .team_id
        .clone()
        .ok_or_else(|| not_found_error("Team not found"))?;

    if actor.role != "owner" && actor.role != "admin" {
        return Err(forbidden_error(
            "Only team owner or admin can access this console",
        ));
    }

    if actor.billing_plan.as_deref() != Some("team") {
        return Err(forbidden_error(
            "This console is only available on Team plans",
        ));
    }

    if !team_management_enabled(actor.billing_status.as_deref()) {
        return Err(forbidden_error(
            "Team management is unavailable until billing is active",
        ));
    }

    let members = load_team_members(pool, &team_id).await?;
    let member_map = HashMap::<String, TeamMemberRow>::from_iter(
        members
            .iter()
            .cloned()
            .map(|member| (member.id.clone(), member)),
    );
    let member_ids: Vec<String> = members.iter().map(|member| member.id.clone()).collect();
    if member_ids.is_empty() {
        return Ok(TeamEventsResponse {
            events: Vec::new(),
            next_cursor: None,
        });
    }

    if let Some(actor_user_id) = input.actor_user_id.as_ref() {
        if !member_map.contains_key(actor_user_id) {
            return Ok(TeamEventsResponse {
                events: Vec::new(),
                next_cursor: None,
            });
        }
    }

    let normalized = normalize_input(&input)?;
    let include_audit = normalized.action_group != AuditActionGroupFilter::Share
        && normalized.result != AuditResultFilter::Failure;
    let include_share = matches!(
        normalized.action_group,
        AuditActionGroupFilter::All | AuditActionGroupFilter::Share
    );

    let audit_rows = if include_audit {
        load_audit_events(pool, &member_ids, &normalized).await?
    } else {
        Vec::new()
    };

    let share_rows = if include_share {
        load_share_access_events(pool, &member_ids, &normalized).await?
    } else {
        Vec::new()
    };

    let mut events = Vec::with_capacity(audit_rows.len() + share_rows.len());
    for row in audit_rows {
        events.push(to_audit_event(row, &member_map));
    }
    for row in share_rows {
        events.push(to_share_access_event(row, &member_map));
    }

    if normalized.action_group == AuditActionGroupFilter::Other {
        events.retain(|event| event.action_group == AuditActionGroup::Other);
    }

    events.sort_by(compare_event_order);
    if let Some(cursor) = normalized.cursor.as_ref() {
        events.retain(|event| event_after_cursor(event, cursor));
    }

    let limit = normalized.limit as usize;
    let has_more = events.len() > limit;
    let page_events = events.into_iter().take(limit).collect::<Vec<_>>();
    let next_cursor = if has_more {
        page_events.last().map(encode_cursor)
    } else {
        None
    };

    Ok(TeamEventsResponse {
        events: page_events,
        next_cursor,
    })
}

pub fn create_audit_router() -> Router<AppState> {
    Router::new().handler(teamEvents)
}

async fn load_actor(pool: &PgPool, user_id: &str) -> Result<AuditActorRow, AuditRpcError> {
    query_as::<_, AuditActorRow>(
		"SELECT u.team_id, u.role::text AS role, t.billing_plan::text AS billing_plan, t.billing_status::text AS billing_status FROM \"user\" u LEFT JOIN team t ON u.team_id = t.id WHERE u.id = $1 LIMIT 1",
	)
	.bind(user_id)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load team actor"); internal_error("Failed to load team actor") })?
	.ok_or_else(|| not_found_error("Team not found"))
}

async fn load_team_members(
    pool: &PgPool,
    team_id: &str,
) -> Result<Vec<TeamMemberRow>, AuditRpcError> {
    query_as::<_, TeamMemberRow>("SELECT id, name, email FROM \"user\" WHERE team_id = $1")
        .bind(team_id)
        .fetch_all(pool)
        .await
        .map_err(|_| internal_error("Failed to load team members"))
}

async fn load_audit_events(
    pool: &PgPool,
    member_ids: &[String],
    input: &NormalizedInput,
) -> Result<Vec<AuditEventRow>, AuditRpcError> {
    query_as::<_, AuditEventRow>(
		"SELECT id, user_id, action, entity_type, entity_id, ip_address, user_agent, metadata, created_at
		 FROM audit_log
		 WHERE user_id = ANY($1)
		   AND ($2::text IS NULL OR user_id = $2)
		   AND ($3::timestamp IS NULL OR created_at >= $3)
		   AND ($4::timestamp IS NULL OR created_at <= $4)
		   AND (
		     $5::text IS NULL
		     OR action ILIKE $5
		     OR COALESCE(entity_type, '') ILIKE $5
		     OR COALESCE(entity_id, '') ILIKE $5
		     OR user_id ILIKE $5
		     OR COALESCE(metadata, '') ILIKE $5
		   )
		   AND (
		     $6::text = 'all'
		     OR $6::text = 'other'
		     OR ($6::text = 'team' AND action ILIKE 'team_%')
		     OR ($6::text = 'vault' AND action ILIKE 'vault_%')
		     OR ($6::text = 'item' AND action ILIKE 'item_%')
		     OR ($6::text = 'share' AND action ILIKE 'share_%')
		     OR ($6::text = 'auth' AND action = ANY($7))
		   )
		 ORDER BY created_at DESC, id DESC
		 LIMIT $8",
	)
	.bind(member_ids)
	.bind(input.actor_user_id.as_deref())
	.bind(input.from)
	.bind(input.to)
	.bind(input.search_pattern.as_deref())
	.bind(input.action_group.as_str())
	.bind(AUTH_ACTIONS)
	.bind(MAX_SCAN_ROWS)
	.fetch_all(pool)
	.await
	.map_err(|_| internal_error("Failed to load audit events"))
}

async fn load_share_access_events(
    pool: &PgPool,
    member_ids: &[String],
    input: &NormalizedInput,
) -> Result<Vec<ShareAccessEventRow>, AuditRpcError> {
    query_as::<_, ShareAccessEventRow>(
		"SELECT sal.id, sal.share_link_id, sl.created_by_id, sal.accessed_by_email, sal.ip_address, sal.user_agent, sal.success, sal.failure_reason, sal.accessed_at
		 FROM share_access_log sal
		 INNER JOIN share_link sl ON sal.share_link_id = sl.id
		 WHERE sl.created_by_id = ANY($1)
		   AND ($2::text IS NULL OR sl.created_by_id = $2)
		   AND ($3::timestamp IS NULL OR sal.accessed_at >= $3)
		   AND ($4::timestamp IS NULL OR sal.accessed_at <= $4)
		   AND (
		     $5::text IS NULL
		     OR sal.share_link_id ILIKE $5
		     OR COALESCE(sal.accessed_by_email, '') ILIKE $5
		     OR COALESCE(sal.failure_reason, '') ILIKE $5
		   )
		   AND (
		     $6::text = 'all'
		     OR ($6::text = 'success' AND sal.success = true)
		     OR ($6::text = 'failure' AND sal.success = false)
		   )
		 ORDER BY sal.accessed_at DESC, sal.id DESC
		 LIMIT $7",
	)
	.bind(member_ids)
	.bind(input.actor_user_id.as_deref())
	.bind(input.from)
	.bind(input.to)
	.bind(input.search_pattern.as_deref())
	.bind(input.result.as_str())
	.bind(MAX_SCAN_ROWS)
	.fetch_all(pool)
	.await
	.map_err(|_| internal_error("Failed to load share access events"))
}

fn normalize_input(input: &TeamEventsInput) -> Result<NormalizedInput, AuditRpcError> {
    let limit = input.limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT);
    let action_group = input.action_group.unwrap_or(AuditActionGroupFilter::All);
    let result = input.result.unwrap_or(AuditResultFilter::All);
    let from = input.from.as_deref().map(parse_timestamp).transpose()?;
    let to = input.to.as_deref().map(parse_timestamp).transpose()?;
    if let (Some(from), Some(to)) = (from, to) {
        if from > to {
            return Err(bad_request_error(
                "The from date must be before the to date",
            ));
        }
    }

    let cursor = input.cursor.as_deref().map(decode_cursor).transpose()?;
    let search_pattern = input.search.as_deref().and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(format!("%{trimmed}%"))
        }
    });

    Ok(NormalizedInput {
        limit,
        from,
        to,
        action_group,
        actor_user_id: input.actor_user_id.clone(),
        result,
        search_pattern,
        cursor,
    })
}

fn parse_timestamp(value: &str) -> Result<OffsetDateTime, AuditRpcError> {
    OffsetDateTime::parse(value, &Rfc3339)
        .map_err(|_| bad_request_error("Invalid RFC3339 timestamp"))
}

fn decode_cursor(raw: &str) -> Result<CursorPayload, AuditRpcError> {
    let decoded = URL_SAFE_NO_PAD
        .decode(raw)
        .map_err(|_| bad_request_error("Invalid pagination cursor"))?;
    let cursor = serde_json::from_slice::<CursorPayload>(&decoded)
        .map_err(|_| bad_request_error("Invalid pagination cursor"))?;
    parse_timestamp(&cursor.timestamp)?;
    Ok(cursor)
}

fn encode_cursor(event: &TeamEvent) -> String {
    let payload = CursorPayload {
        timestamp: event.timestamp.clone(),
        source: event.source,
        id: event.id.clone(),
    };
    URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(&payload).expect("cursor serialization should succeed"))
}

fn to_audit_event(row: AuditEventRow, member_map: &HashMap<String, TeamMemberRow>) -> TeamEvent {
    let actor = member_map.get(&row.user_id);
    TeamEvent {
        id: row.id,
        timestamp: row
            .created_at
            .format(&Rfc3339)
            .expect("timestamp should format"),
        source: EventSource::AuditLog,
        action_group: action_group_for_action(&row.action),
        action: row.action,
        actor: TeamEventActor {
            user_id: Some(row.user_id),
            name: actor.and_then(|entry| entry.name.clone()),
            email: actor.and_then(|entry| entry.email.clone()),
        },
        entity: TeamEventEntity {
            r#type: row.entity_type,
            id: row.entity_id,
        },
        result: TeamEventResult::Success,
        network: TeamEventNetwork {
            masked_ip: mask_ip(row.ip_address.as_deref()),
            masked_user_agent: mask_user_agent(row.user_agent.as_deref()),
            full_ip: row.ip_address,
            full_user_agent: row.user_agent,
        },
        metadata: parse_metadata(row.metadata.as_deref()),
    }
}

fn to_share_access_event(
    row: ShareAccessEventRow,
    member_map: &HashMap<String, TeamMemberRow>,
) -> TeamEvent {
    let created_by = member_map.get(&row.created_by_id);
    TeamEvent {
        id: row.id,
        timestamp: row
            .accessed_at
            .format(&Rfc3339)
            .expect("timestamp should format"),
        source: EventSource::ShareAccessLog,
        action: if row.success {
            "share_access_success".to_string()
        } else {
            "share_access_failed".to_string()
        },
        action_group: AuditActionGroup::Share,
        actor: TeamEventActor {
            user_id: None,
            name: row.accessed_by_email.clone(),
            email: row.accessed_by_email.clone(),
        },
        entity: TeamEventEntity {
            r#type: Some("share_link".to_string()),
            id: Some(row.share_link_id.clone()),
        },
        result: if row.success {
            TeamEventResult::Success
        } else {
            TeamEventResult::Failure
        },
        network: TeamEventNetwork {
            masked_ip: mask_ip(row.ip_address.as_deref()),
            masked_user_agent: mask_user_agent(row.user_agent.as_deref()),
            full_ip: row.ip_address,
            full_user_agent: row.user_agent,
        },
        metadata: Some(json!({
            "failureReason": row.failure_reason,
            "createdByUserId": row.created_by_id,
            "createdByName": created_by.and_then(|entry| entry.name.clone()),
            "createdByEmail": created_by.and_then(|entry| entry.email.clone()),
        })),
    }
}

fn parse_metadata(metadata: Option<&str>) -> Option<Value> {
    metadata
        .and_then(|value| serde_json::from_str::<Value>(value).ok())
        .and_then(|value| if value.is_object() { Some(value) } else { None })
}

fn action_group_for_action(action: &str) -> AuditActionGroup {
    if action.starts_with("team_") {
        AuditActionGroup::Team
    } else if action.starts_with("vault_") {
        AuditActionGroup::Vault
    } else if action.starts_with("item_") {
        AuditActionGroup::Item
    } else if action.starts_with("share_") {
        AuditActionGroup::Share
    } else if AUTH_ACTIONS.contains(&action) {
        AuditActionGroup::Auth
    } else {
        AuditActionGroup::Other
    }
}

fn compare_event_order(left: &TeamEvent, right: &TeamEvent) -> std::cmp::Ordering {
    right
        .timestamp
        .cmp(&left.timestamp)
        .then_with(|| source_rank(right.source).cmp(&source_rank(left.source)))
        .then_with(|| right.id.cmp(&left.id))
}

fn event_after_cursor(event: &TeamEvent, cursor: &CursorPayload) -> bool {
    if event.timestamp < cursor.timestamp {
        return true;
    }
    if event.timestamp > cursor.timestamp {
        return false;
    }

    let event_rank = source_rank(event.source);
    let cursor_rank = source_rank(cursor.source);
    if event_rank < cursor_rank {
        return true;
    }
    if event_rank > cursor_rank {
        return false;
    }

    event.id < cursor.id
}

fn source_rank(source: EventSource) -> u8 {
    match source {
        EventSource::AuditLog => 1,
        EventSource::ShareAccessLog => 0,
    }
}

fn mask_ip(ip_address: Option<&str>) -> Option<String> {
    let ip_address = ip_address?;
    if ip_address.contains('.') {
        let segments = ip_address.split('.').collect::<Vec<_>>();
        if segments.len() == 4 {
            return Some(format!("{}.{}.x.x", segments[0], segments[1]));
        }
    }
    if ip_address.contains(':') {
        let segments = ip_address
            .split(':')
            .filter(|segment| !segment.is_empty())
            .collect::<Vec<_>>();
        if segments.len() >= 2 {
            return Some(format!("{}:xxxx:xxxx::*", segments[..2].join(":")));
        }
    }
    Some("masked".to_string())
}

fn mask_user_agent(user_agent: Option<&str>) -> Option<String> {
    let user_agent = user_agent?;
    if user_agent.contains("Chrome") {
        Some("Chrome".to_string())
    } else if user_agent.contains("Firefox") {
        Some("Firefox".to_string())
    } else if user_agent.contains("Safari") && !user_agent.contains("Chrome") {
        Some("Safari".to_string())
    } else if user_agent.contains("Edge") {
        Some("Edge".to_string())
    } else {
        Some(
            user_agent
                .split(' ')
                .next()
                .unwrap_or("Unknown")
                .to_string(),
        )
    }
}

fn team_management_enabled(billing_status: Option<&str>) -> bool {
    shared_team_management_enabled(bittery_mode(), Some("team"), billing_status)
}

fn bad_request_error(message: &str) -> AuditRpcError {
    AuditRpcError {
        code: "BAD_REQUEST".to_string(),
        message: message.to_string(),
    }
}

fn forbidden_error(message: &str) -> AuditRpcError {
    AuditRpcError {
        code: "FORBIDDEN".to_string(),
        message: message.to_string(),
    }
}

fn not_found_error(message: &str) -> AuditRpcError {
    AuditRpcError {
        code: "NOT_FOUND".to_string(),
        message: message.to_string(),
    }
}

fn internal_error(message: &str) -> AuditRpcError {
    AuditRpcError {
        code: "INTERNAL_SERVER_ERROR".to_string(),
        message: message.to_string(),
    }
}

impl From<AuditRpcError> for RpcError {
    fn from(value: AuditRpcError) -> Self {
        let code = match value.code.as_str() {
            "BAD_REQUEST" => ErrorCode::InvalidParams,
            "FORBIDDEN" => ErrorCode::ServerError(403),
            "NOT_FOUND" => ErrorCode::ServerError(404),
            _ => ErrorCode::InternalError,
        };

        RpcError {
            code,
            message: value.message,
            data: Some(json!({ "code": value.code })),
        }
    }
}

impl IntoResponse for AuditRpcError {
    type Output = <RpcError as IntoResponse>::Output;

    fn into_response(self) -> jsonrpsee::ResponsePayload<'static, Self::Output> {
        RpcError::from(self).into_response()
    }
}

#[derive(Debug, Clone)]
struct NormalizedInput {
    limit: u32,
    from: Option<OffsetDateTime>,
    to: Option<OffsetDateTime>,
    action_group: AuditActionGroupFilter,
    actor_user_id: Option<String>,
    result: AuditResultFilter,
    search_pattern: Option<String>,
    cursor: Option<CursorPayload>,
}

impl AuditActionGroupFilter {
    fn as_str(self) -> &'static str {
        match self {
            Self::Auth => "auth",
            Self::Team => "team",
            Self::Vault => "vault",
            Self::Item => "item",
            Self::Share => "share",
            Self::Other => "other",
            Self::All => "all",
        }
    }
}

impl AuditResultFilter {
    fn as_str(self) -> &'static str {
        match self {
            Self::Success => "success",
            Self::Failure => "failure",
            Self::All => "all",
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, future::Future};

    use axum::http::{header::CONTENT_TYPE, HeaderMap, HeaderValue, StatusCode};
    use serde_json::json;
    use sqlx::{query, PgPool};
    use time::{macros::datetime, OffsetDateTime};

    use super::*;
    use crate::test_support::{
        acquire_env_lock, assign_user_to_team, authenticated_json_headers, seed_item, seed_team,
        seed_user, seed_vault, seed_vault_key, with_rpc_test_app,
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
        let _guard = acquire_env_lock();
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

    fn sample_event(id: &str, timestamp: &str, source: EventSource) -> TeamEvent {
        TeamEvent {
            id: id.to_string(),
            timestamp: timestamp.to_string(),
            source,
            action: "team_member_added".to_string(),
            action_group: AuditActionGroup::Team,
            actor: TeamEventActor {
                user_id: Some("user_1".to_string()),
                name: Some("Alice".to_string()),
                email: Some("alice@example.com".to_string()),
            },
            entity: TeamEventEntity {
                r#type: Some("team".to_string()),
                id: Some("team_1".to_string()),
            },
            result: TeamEventResult::Success,
            network: TeamEventNetwork {
                masked_ip: Some("10.0.x.x".to_string()),
                masked_user_agent: Some("Chrome".to_string()),
                full_ip: Some("10.0.0.1".to_string()),
                full_user_agent: Some("Chrome/123.0".to_string()),
            },
            metadata: None,
        }
    }

    fn sample_member_map() -> HashMap<String, TeamMemberRow> {
        HashMap::from([(
            "user_1".to_string(),
            TeamMemberRow {
                id: "user_1".to_string(),
                name: Some("Alice".to_string()),
                email: Some("alice@example.com".to_string()),
            },
        )])
    }

    #[test]
    fn normalize_input_applies_defaults_and_trims_search() {
        let input = TeamEventsInput {
            cursor: None,
            limit: Some(250),
            from: Some("2025-05-01T00:00:00Z".to_string()),
            to: Some("2025-05-02T00:00:00Z".to_string()),
            action_group: None,
            actor_user_id: Some("user_1".to_string()),
            result: None,
            search: Some("  alice@example.com  ".to_string()),
        };

        let normalized = normalize_input(&input).expect("input should normalize");

        assert_eq!(normalized.limit, MAX_LIMIT);
        assert_eq!(normalized.action_group, AuditActionGroupFilter::All);
        assert_eq!(normalized.result, AuditResultFilter::All);
        assert_eq!(normalized.actor_user_id.as_deref(), Some("user_1"));
        assert_eq!(
            normalized.search_pattern.as_deref(),
            Some("%alice@example.com%")
        );
        assert_eq!(normalized.from, Some(datetime!(2025-05-01 0:00 UTC)));
        assert_eq!(normalized.to, Some(datetime!(2025-05-02 0:00 UTC)));
    }

    #[test]
    fn normalize_input_rejects_invalid_dates_and_cursor() {
        let invalid_dates = TeamEventsInput {
            cursor: None,
            limit: None,
            from: Some("2025-05-03T00:00:00Z".to_string()),
            to: Some("2025-05-02T00:00:00Z".to_string()),
            action_group: None,
            actor_user_id: None,
            result: None,
            search: None,
        };

        let date_error = normalize_input(&invalid_dates).unwrap_err();
        assert_eq!(date_error.code, "BAD_REQUEST");
        assert_eq!(
            date_error.message,
            "The from date must be before the to date"
        );

        let invalid_cursor = TeamEventsInput {
            cursor: Some("not-base64".to_string()),
            limit: None,
            from: None,
            to: None,
            action_group: None,
            actor_user_id: None,
            result: None,
            search: None,
        };

        let cursor_error = normalize_input(&invalid_cursor).unwrap_err();
        assert_eq!(cursor_error.code, "BAD_REQUEST");
        assert_eq!(cursor_error.message, "Invalid pagination cursor");
    }

    #[test]
    fn cursor_round_trip_preserves_timestamp_source_and_id() {
        let event = sample_event("evt_2", "2025-05-02T12:30:00Z", EventSource::ShareAccessLog);

        let encoded = encode_cursor(&event);
        let decoded = decode_cursor(&encoded).expect("cursor should decode");

        assert_eq!(decoded.timestamp, event.timestamp);
        assert_eq!(decoded.source, event.source);
        assert_eq!(decoded.id, event.id);
    }

    #[test]
    fn parse_metadata_only_returns_objects() {
        assert_eq!(
            parse_metadata(Some(r#"{"actor":"alice"}"#)),
            Some(json!({ "actor": "alice" }))
        );
        assert_eq!(parse_metadata(Some(r#"[1,2,3]"#)), None);
        assert_eq!(parse_metadata(Some("not-json")), None);
        assert_eq!(parse_metadata(None), None);
    }

    #[test]
    fn action_group_for_action_classifies_known_prefixes_and_auth_actions() {
        assert_eq!(
            action_group_for_action("team_member_added"),
            AuditActionGroup::Team
        );
        assert_eq!(
            action_group_for_action("vault_rotated"),
            AuditActionGroup::Vault
        );
        assert_eq!(
            action_group_for_action("item_deleted"),
            AuditActionGroup::Item
        );
        assert_eq!(
            action_group_for_action("share_link_created"),
            AuditActionGroup::Share
        );
        assert_eq!(
            action_group_for_action("password_changed"),
            AuditActionGroup::Auth
        );
        assert_eq!(
            action_group_for_action("custom_event"),
            AuditActionGroup::Other
        );
    }

    #[test]
    fn compare_event_order_and_cursor_logic_follow_descending_sort() {
        let newest = sample_event("evt_3", "2025-05-03T00:00:00Z", EventSource::AuditLog);
        let same_time_audit = sample_event("evt_2", "2025-05-02T00:00:00Z", EventSource::AuditLog);
        let same_time_share =
            sample_event("evt_4", "2025-05-02T00:00:00Z", EventSource::ShareAccessLog);
        let same_time_lower_id =
            sample_event("evt_1", "2025-05-02T00:00:00Z", EventSource::ShareAccessLog);
        let oldest = sample_event("evt_0", "2025-05-01T00:00:00Z", EventSource::AuditLog);

        let mut events = vec![
            same_time_share.clone(),
            oldest.clone(),
            newest.clone(),
            same_time_lower_id.clone(),
            same_time_audit.clone(),
        ];
        events.sort_by(compare_event_order);

        assert_eq!(
            events
                .iter()
                .map(|event| event.id.as_str())
                .collect::<Vec<_>>(),
            vec!["evt_3", "evt_2", "evt_4", "evt_1", "evt_0"]
        );

        let cursor = CursorPayload {
            timestamp: "2025-05-02T00:00:00Z".to_string(),
            source: EventSource::ShareAccessLog,
            id: "evt_4".to_string(),
        };

        assert!(!event_after_cursor(&newest, &cursor));
        assert!(!event_after_cursor(&same_time_audit, &cursor));
        assert!(!event_after_cursor(&same_time_share, &cursor));
        assert!(event_after_cursor(&same_time_lower_id, &cursor));
        assert!(event_after_cursor(&oldest, &cursor));
    }

    #[test]
    fn mask_ip_handles_ipv4_ipv6_and_unknown_values() {
        assert_eq!(
            mask_ip(Some("192.168.10.42")),
            Some("192.168.x.x".to_string())
        );
        assert_eq!(
            mask_ip(Some("2001:db8::1")),
            Some("2001:db8:xxxx:xxxx::*".to_string())
        );
        assert_eq!(mask_ip(Some("hostname")), Some("masked".to_string()));
        assert_eq!(mask_ip(None), None);
    }

    #[test]
    fn mask_user_agent_handles_common_browsers_and_fallbacks() {
        assert_eq!(
            mask_user_agent(Some("Mozilla/5.0 Chrome/123.0.0.0 Safari/537.36")),
            Some("Chrome".to_string())
        );
        assert_eq!(
            mask_user_agent(Some("Mozilla/5.0 Version/17.4 Safari/605.1.15")),
            Some("Safari".to_string())
        );
        assert_eq!(
            mask_user_agent(Some("CustomAgent/1.0 SomethingElse")),
            Some("CustomAgent/1.0".to_string())
        );
        assert_eq!(mask_user_agent(None), None);
    }

    #[test]
    fn team_management_enabled_respects_billing_state_and_mode() {
        with_bittery_mode(None, || {
            assert!(!team_management_enabled(None));
            assert!(!team_management_enabled(Some("past_due")));
            assert!(team_management_enabled(Some("active")));
            assert!(team_management_enabled(Some("trialing")));
            assert_eq!(bittery_mode(), "cloud");
        });

        with_bittery_mode(Some("self_hosted"), || {
            assert!(team_management_enabled(None));
            assert_eq!(bittery_mode(), "self-hosted");
        });
    }

    #[test]
    fn to_audit_event_maps_actor_entity_network_and_metadata() {
        let row = AuditEventRow {
            id: "audit_1".to_string(),
            user_id: "user_1".to_string(),
            action: "password_changed".to_string(),
            entity_type: Some("user".to_string()),
            entity_id: Some("user_1".to_string()),
            ip_address: Some("192.168.10.42".to_string()),
            user_agent: Some("Mozilla/5.0 Chrome/123.0.0.0 Safari/537.36".to_string()),
            metadata: Some(r#"{"ipAddress":"sensitive"}"#.to_string()),
            created_at: datetime!(2025-05-02 12:30 UTC),
        };

        let event = to_audit_event(row, &sample_member_map());

        assert_eq!(event.id, "audit_1");
        assert_eq!(event.timestamp, "2025-05-02T12:30:00Z");
        assert_eq!(event.source, EventSource::AuditLog);
        assert_eq!(event.action, "password_changed");
        assert_eq!(event.action_group, AuditActionGroup::Auth);
        assert_eq!(event.result, TeamEventResult::Success);
        assert_eq!(event.actor.user_id.as_deref(), Some("user_1"));
        assert_eq!(event.actor.name.as_deref(), Some("Alice"));
        assert_eq!(event.actor.email.as_deref(), Some("alice@example.com"));
        assert_eq!(event.entity.r#type.as_deref(), Some("user"));
        assert_eq!(event.entity.id.as_deref(), Some("user_1"));
        assert_eq!(event.network.masked_ip.as_deref(), Some("192.168.x.x"));
        assert_eq!(event.network.masked_user_agent.as_deref(), Some("Chrome"));
        assert_eq!(event.metadata, Some(json!({ "ipAddress": "sensitive" })));
    }

    #[test]
    fn to_share_access_event_maps_failure_metadata_and_masks() {
        let row = ShareAccessEventRow {
            id: "share_access_1".to_string(),
            share_link_id: "share_link_1".to_string(),
            created_by_id: "user_1".to_string(),
            accessed_by_email: Some("guest@example.com".to_string()),
            ip_address: Some("2001:db8::1".to_string()),
            user_agent: Some("Mozilla/5.0 Firefox/124.0".to_string()),
            success: false,
            failure_reason: Some("expired".to_string()),
            accessed_at: datetime!(2025-05-02 12:45 UTC),
        };

        let event = to_share_access_event(row, &sample_member_map());

        assert_eq!(event.id, "share_access_1");
        assert_eq!(event.timestamp, "2025-05-02T12:45:00Z");
        assert_eq!(event.source, EventSource::ShareAccessLog);
        assert_eq!(event.action, "share_access_failed");
        assert_eq!(event.action_group, AuditActionGroup::Share);
        assert_eq!(event.result, TeamEventResult::Failure);
        assert_eq!(event.actor.user_id, None);
        assert_eq!(event.actor.name.as_deref(), Some("guest@example.com"));
        assert_eq!(event.entity.r#type.as_deref(), Some("share_link"));
        assert_eq!(event.entity.id.as_deref(), Some("share_link_1"));
        assert_eq!(
            event.network.masked_ip.as_deref(),
            Some("2001:db8:xxxx:xxxx::*")
        );
        assert_eq!(event.network.masked_user_agent.as_deref(), Some("Firefox"));
        assert_eq!(
            event.metadata,
            Some(json!({
                "failureReason": "expired",
                "createdByUserId": "user_1",
                "createdByName": "Alice",
                "createdByEmail": "alice@example.com"
            }))
        );
    }

    #[test]
    fn parse_timestamp_rejects_invalid_rfc3339_values() {
        let error = parse_timestamp("not-a-timestamp").unwrap_err();

        assert_eq!(error.code, "BAD_REQUEST");
        assert_eq!(error.message, "Invalid RFC3339 timestamp");
    }

    #[test]
    fn decode_cursor_rejects_payload_with_invalid_timestamp() {
        let payload = CursorPayload {
            timestamp: "invalid".to_string(),
            source: EventSource::AuditLog,
            id: "evt_1".to_string(),
        };
        let raw =
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).expect("cursor should serialize"));

        let error = decode_cursor(&raw).unwrap_err();

        assert_eq!(error.code, "BAD_REQUEST");
        assert_eq!(error.message, "Invalid RFC3339 timestamp");
    }

    #[test]
    fn normalize_input_ignores_blank_search_terms() {
        let input = TeamEventsInput {
            cursor: None,
            limit: None,
            from: None,
            to: None,
            action_group: Some(AuditActionGroupFilter::Auth),
            actor_user_id: None,
            result: Some(AuditResultFilter::Success),
            search: Some("   ".to_string()),
        };

        let normalized = normalize_input(&input).expect("input should normalize");

        assert_eq!(normalized.limit, DEFAULT_LIMIT);
        assert_eq!(normalized.action_group, AuditActionGroupFilter::Auth);
        assert_eq!(normalized.result, AuditResultFilter::Success);
        assert_eq!(normalized.search_pattern, None);
        assert_eq!(normalized.cursor, None);
    }

    #[test]
    fn source_rank_prioritizes_audit_log_after_share_access_log() {
        assert!(source_rank(EventSource::AuditLog) > source_rank(EventSource::ShareAccessLog));
    }

    #[test]
    fn mask_ip_returns_masked_for_short_ipv6_sequences() {
        assert_eq!(mask_ip(Some("::1")), Some("masked".to_string()));
    }

    #[test]
    fn to_audit_event_drops_non_object_metadata() {
        let row = AuditEventRow {
            id: "audit_2".to_string(),
            user_id: "user_1".to_string(),
            action: "custom_event".to_string(),
            entity_type: None,
            entity_id: None,
            ip_address: None,
            user_agent: None,
            metadata: Some(r#"[1,2,3]"#.to_string()),
            created_at: OffsetDateTime::UNIX_EPOCH,
        };

        let event = to_audit_event(row, &sample_member_map());

        assert_eq!(event.action_group, AuditActionGroup::Other);
        assert_eq!(event.metadata, None);
    }

    #[tokio::test]
    async fn team_events_requires_authentication() {
        with_rpc_test_app(
            "audit_team_events_requires_authentication",
            |app| async move {
                let response = app
                    .rpc_call(
                        "audit.teamEvents",
                        json!([{}]),
                        unauthenticated_json_headers(),
                    )
                    .await;

                assert_eq!(response.status, StatusCode::OK);
                assert_rpc_error(&response.body, "UNAUTHORIZED", "Authentication required");
            },
        )
        .await;
    }

    #[tokio::test]
    async fn team_events_enforce_access_control_and_team_not_found_paths() {
        with_rpc_test_app("audit_team_events_access_control", |app| async move {
            let fixture = build_audit_router_fixture(&app.pool).await;

            let member_session = app.issue_session(&fixture.member_user_id).await;
            let member_response = app
                .rpc_call(
                    "audit.teamEvents",
                    json!([{}]),
                    authenticated_json_headers(&member_session.token),
                )
                .await;
            assert_eq!(member_response.status, StatusCode::OK);
            assert_handler_error(
                &member_response.body,
                "FORBIDDEN",
                "Only team owner or admin can access this console",
            );

            let personal_session = app.issue_session(&fixture.personal_owner_user_id).await;
            let personal_response = app
                .rpc_call(
                    "audit.teamEvents",
                    json!([{}]),
                    authenticated_json_headers(&personal_session.token),
                )
                .await;
            assert_eq!(personal_response.status, StatusCode::OK);
            assert_handler_error(
                &personal_response.body,
                "FORBIDDEN",
                "This console is only available on Team plans",
            );

            let inactive_session = app.issue_session(&fixture.inactive_owner_user_id).await;
            let inactive_response = with_bittery_mode_async(
                Some("cloud"),
                app.rpc_call(
                    "audit.teamEvents",
                    json!([{}]),
                    authenticated_json_headers(&inactive_session.token),
                ),
            )
            .await;
            assert_eq!(inactive_response.status, StatusCode::OK);
            assert_handler_error(
                &inactive_response.body,
                "FORBIDDEN",
                "Team management is unavailable until billing is active",
            );

            let no_team_session = app.issue_session(&fixture.no_team_user_id).await;
            let no_team_response = app
                .rpc_call(
                    "audit.teamEvents",
                    json!([{}]),
                    authenticated_json_headers(&no_team_session.token),
                )
                .await;
            assert_eq!(no_team_response.status, StatusCode::OK);
            assert_handler_error(&no_team_response.body, "NOT_FOUND", "Team not found");
        })
        .await;
    }

    #[tokio::test]
    async fn team_events_reject_malformed_request_input() {
        with_rpc_test_app("audit_team_events_malformed_request", |app| async move {
            let fixture = build_audit_router_fixture(&app.pool).await;
            let session = app.issue_session(&fixture.owner_user_id).await;
            let headers = authenticated_json_headers(&session.token);

            let date_response = app
                .rpc_call(
                    "audit.teamEvents",
                    json!([{
                        "from": "2025-05-03T00:00:00Z",
                        "to": "2025-05-02T00:00:00Z"
                    }]),
                    headers.clone(),
                )
                .await;
            assert_eq!(date_response.status, StatusCode::OK);
            assert_handler_error(
                &date_response.body,
                "BAD_REQUEST",
                "The from date must be before the to date",
            );

            let cursor_response = app
                .rpc_call(
                    "audit.teamEvents",
                    json!([{ "cursor": "not-base64" }]),
                    headers,
                )
                .await;
            assert_eq!(cursor_response.status, StatusCode::OK);
            assert_handler_error(
                &cursor_response.body,
                "BAD_REQUEST",
                "Invalid pagination cursor",
            );
        })
        .await;
    }

    #[tokio::test]
    async fn team_events_return_paginated_merged_results_with_cursor() {
        with_rpc_test_app("audit_team_events_success_pagination", |app| async move {
            let fixture = build_audit_router_fixture(&app.pool).await;
            seed_audit_event(
                &app.pool,
                "audit_newest",
                &fixture.owner_user_id,
                "team_member_added",
                Some("team"),
                Some(&fixture.team_id),
                Some(r#"{"scope":"team"}"#),
                Some("10.20.30.40"),
                Some("Mozilla/5.0 Chrome/123.0.0.0 Safari/537.36"),
                datetime!(2025-05-03 09:00 UTC),
            )
            .await;
            seed_audit_event(
                &app.pool,
                "audit_same_time",
                &fixture.owner_user_id,
                "password_changed",
                Some("user"),
                Some(&fixture.owner_user_id),
                Some(r#"{"reason":"rotation"}"#),
                Some("192.168.10.42"),
                Some("Mozilla/5.0 Chrome/123.0.0.0 Safari/537.36"),
                datetime!(2025-05-02 12:00 UTC),
            )
            .await;
            seed_share_access_event(
                &app.pool,
                "share_success",
                &fixture.share_link_id,
                Some("guest@example.com"),
                Some("2001:db8::1"),
                Some("Mozilla/5.0 Firefox/124.0"),
                true,
                None,
                datetime!(2025-05-02 12:00 UTC),
            )
            .await;

            let session = app.issue_session(&fixture.owner_user_id).await;
            let first_page = app
                .rpc_call(
                    "audit.teamEvents",
                    json!([{ "limit": 2 }]),
                    authenticated_json_headers(&session.token),
                )
                .await;

            assert_eq!(first_page.status, StatusCode::OK);
            assert_eq!(
                first_page.body["result"]["Ok"]["events"]
                    .as_array()
                    .expect("events should be an array")
                    .len(),
                2
            );
            assert_eq!(
                first_page.body["result"]["Ok"]["events"][0]["id"],
                json!("audit_newest")
            );
            assert_eq!(
                first_page.body["result"]["Ok"]["events"][1]["id"],
                json!("audit_same_time")
            );
            assert_eq!(
                first_page.body["result"]["Ok"]["events"][0]["network"]["maskedIp"],
                json!("10.20.x.x")
            );
            assert_eq!(
                first_page.body["result"]["Ok"]["events"][1]["actionGroup"],
                json!("auth")
            );
            let next_cursor = first_page.body["result"]["Ok"]["nextCursor"]
                .as_str()
                .expect("next cursor should be present")
                .to_string();

            let second_page = app
                .rpc_call(
                    "audit.teamEvents",
                    json!([{ "cursor": next_cursor }]),
                    authenticated_json_headers(&session.token),
                )
                .await;

            assert_eq!(second_page.status, StatusCode::OK);
            assert_eq!(
                second_page.body["result"]["Ok"]["events"]
                    .as_array()
                    .expect("events should be an array")
                    .len(),
                1
            );
            assert_eq!(
                second_page.body["result"]["Ok"]["events"][0]["id"],
                json!("share_success")
            );
            assert_eq!(
                second_page.body["result"]["Ok"]["events"][0]["source"],
                json!("share_access_log")
            );
            assert_eq!(
                second_page.body["result"]["Ok"]["nextCursor"],
                serde_json::Value::Null
            );
        })
        .await;
    }

    #[tokio::test]
    async fn team_events_apply_share_other_and_actor_filters() {
        with_rpc_test_app("audit_team_events_filtering", |app| async move {
            let fixture = build_audit_router_fixture(&app.pool).await;
            seed_audit_event(
                &app.pool,
                "audit_other",
                &fixture.owner_user_id,
                "custom_audit_event",
                Some("team"),
                Some(&fixture.team_id),
                None,
                None,
                None,
                datetime!(2025-05-02 08:00 UTC),
            )
            .await;
            seed_audit_event(
                &app.pool,
                "audit_team",
                &fixture.owner_user_id,
                "team_member_removed",
                Some("team"),
                Some(&fixture.team_id),
                None,
                None,
                None,
                datetime!(2025-05-02 07:00 UTC),
            )
            .await;
            seed_share_access_event(
                &app.pool,
                "share_failed",
                &fixture.share_link_id,
                Some("failed@example.com"),
                None,
                None,
                false,
                Some("expired"),
                datetime!(2025-05-02 06:00 UTC),
            )
            .await;
            seed_share_access_event(
                &app.pool,
                "share_success_other",
                &fixture.share_link_id,
                Some("ok@example.com"),
                None,
                None,
                true,
                None,
                datetime!(2025-05-02 05:00 UTC),
            )
            .await;

            let session = app.issue_session(&fixture.owner_user_id).await;
            let headers = authenticated_json_headers(&session.token);

            let share_failure_response = app
                .rpc_call(
                    "audit.teamEvents",
                    json!([{ "actionGroup": "share", "result": "failure" }]),
                    headers.clone(),
                )
                .await;
            assert_eq!(share_failure_response.status, StatusCode::OK);
            assert_eq!(
                share_failure_response.body["result"]["Ok"]["events"]
                    .as_array()
                    .expect("events should be an array")
                    .len(),
                1
            );
            assert_eq!(
                share_failure_response.body["result"]["Ok"]["events"][0]["id"],
                json!("share_failed")
            );
            assert_eq!(
                share_failure_response.body["result"]["Ok"]["events"][0]["result"],
                json!("failure")
            );

            let other_response = app
                .rpc_call(
                    "audit.teamEvents",
                    json!([{ "actionGroup": "other" }]),
                    headers.clone(),
                )
                .await;
            assert_eq!(other_response.status, StatusCode::OK);
            assert_eq!(
                other_response.body["result"]["Ok"]["events"]
                    .as_array()
                    .expect("events should be an array")
                    .len(),
                1
            );
            assert_eq!(
                other_response.body["result"]["Ok"]["events"][0]["id"],
                json!("audit_other")
            );
            assert_eq!(
                other_response.body["result"]["Ok"]["events"][0]["actionGroup"],
                json!("other")
            );

            let unknown_actor_response = app
                .rpc_call(
                    "audit.teamEvents",
                    json!([{ "actorUserId": "missing_member" }]),
                    headers,
                )
                .await;
            assert_eq!(unknown_actor_response.status, StatusCode::OK);
            assert_eq!(
                unknown_actor_response.body["result"]["Ok"]["events"]
                    .as_array()
                    .expect("events should be an array")
                    .len(),
                0
            );
            assert_eq!(
                unknown_actor_response.body["result"]["Ok"]["nextCursor"],
                serde_json::Value::Null
            );
        })
        .await;
    }

    struct AuditRouterFixture {
        owner_user_id: String,
        member_user_id: String,
        personal_owner_user_id: String,
        inactive_owner_user_id: String,
        no_team_user_id: String,
        team_id: String,
        share_link_id: String,
    }

    fn unauthenticated_json_headers() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        headers.insert("x-app-platform", HeaderValue::from_static("desktop"));
        headers.insert("x-client-id", HeaderValue::from_static("integration-test"));
        headers
    }

    fn assert_handler_error(body: &serde_json::Value, code: &str, message: &str) {
        assert_eq!(body["jsonrpc"], json!("2.0"));
        assert_eq!(body["result"]["Err"]["code"], json!(code));
        assert_eq!(body["result"]["Err"]["message"], json!(message));
    }

    fn assert_rpc_error(body: &serde_json::Value, code: &str, message: &str) {
        assert_eq!(body["jsonrpc"], json!("2.0"));
        assert_eq!(body["error"]["message"], json!(message));
        assert_eq!(body["error"]["data"]["code"], json!(code));
    }

    async fn build_audit_router_fixture(pool: &PgPool) -> AuditRouterFixture {
        let owner_user_id = "audit_owner_user".to_string();
        let member_user_id = "audit_member_user".to_string();
        let personal_owner_user_id = "audit_personal_owner".to_string();
        let inactive_owner_user_id = "audit_inactive_owner".to_string();
        let no_team_user_id = "audit_no_team_user".to_string();
        let team_id = "audit_team_main".to_string();
        let share_link_id = "audit_share_link".to_string();

        seed_user(
            pool,
            &owner_user_id,
            "Audit Owner",
            "audit-owner@example.com",
        )
        .await;
        seed_user(
            pool,
            &member_user_id,
            "Audit Member",
            "audit-member@example.com",
        )
        .await;
        seed_user(
            pool,
            &personal_owner_user_id,
            "Personal Owner",
            "personal-owner@example.com",
        )
        .await;
        seed_user(
            pool,
            &inactive_owner_user_id,
            "Inactive Owner",
            "inactive-owner@example.com",
        )
        .await;
        seed_user(pool, &no_team_user_id, "No Team", "no-team@example.com").await;

        seed_team(
            pool,
            &team_id,
            "Audit Team",
            &owner_user_id,
            "organization",
            "team",
            "active",
        )
        .await;
        assign_user_to_team(pool, &owner_user_id, &team_id, "owner").await;
        assign_user_to_team(pool, &member_user_id, &team_id, "member").await;

        seed_team(
            pool,
            "audit_team_personal",
            "Personal Team",
            &personal_owner_user_id,
            "organization",
            "personal",
            "active",
        )
        .await;
        assign_user_to_team(
            pool,
            &personal_owner_user_id,
            "audit_team_personal",
            "owner",
        )
        .await;

        seed_team(
            pool,
            "audit_team_inactive",
            "Inactive Team",
            &inactive_owner_user_id,
            "organization",
            "team",
            "past_due",
        )
        .await;
        assign_user_to_team(
            pool,
            &inactive_owner_user_id,
            "audit_team_inactive",
            "owner",
        )
        .await;

        let vault_id = "audit_vault".to_string();
        let item_id = "audit_item".to_string();
        seed_vault(
            pool,
            &vault_id,
            "Audit Vault",
            "personal",
            &owner_user_id,
            Some(&team_id),
        )
        .await;
        seed_vault_key(
            pool,
            "audit_vault_key",
            &vault_id,
            &owner_user_id,
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
            &owner_user_id,
        )
        .await;
        seed_share_link(pool, &share_link_id, &item_id, &owner_user_id).await;

        AuditRouterFixture {
            owner_user_id,
            member_user_id,
            personal_owner_user_id,
            inactive_owner_user_id,
            no_team_user_id,
            team_id,
            share_link_id,
        }
    }

    async fn seed_share_link(pool: &PgPool, share_link_id: &str, item_id: &str, user_id: &str) {
        query(
			"INSERT INTO share_link (id, item_id, created_by_id, token, access_mode, is_one_time_use, encrypted_item_data, encryption_iv, encrypted_share_key, share_key_iv, max_access_count, expires_at) VALUES ($1, $2, $3, $4, 'anyone', false, $5, $6, $7, $8, NULL, $9)",
		)
		.bind(share_link_id)
		.bind(item_id)
		.bind(user_id)
		.bind("audit-share-token")
		.bind("encrypted-item-data")
		.bind("item-iv")
		.bind("encrypted-share-key")
		.bind("share-key-iv")
		.bind(datetime!(2030-01-01 0:00 UTC))
		.execute(pool)
		.await
		.expect("share link should seed");
    }

    async fn seed_audit_event(
        pool: &PgPool,
        event_id: &str,
        user_id: &str,
        action: &str,
        entity_type: Option<&str>,
        entity_id: Option<&str>,
        metadata: Option<&str>,
        ip_address: Option<&str>,
        user_agent: Option<&str>,
        created_at: OffsetDateTime,
    ) {
        query(
			"INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, ip_address, user_agent, metadata, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
		)
		.bind(event_id)
		.bind(user_id)
		.bind(action)
		.bind(entity_type)
		.bind(entity_id)
		.bind(ip_address)
		.bind(user_agent)
		.bind(metadata)
		.bind(created_at)
		.execute(pool)
		.await
		.expect("audit event should seed");
    }

    async fn seed_share_access_event(
        pool: &PgPool,
        event_id: &str,
        share_link_id: &str,
        accessed_by_email: Option<&str>,
        ip_address: Option<&str>,
        user_agent: Option<&str>,
        success: bool,
        failure_reason: Option<&str>,
        accessed_at: OffsetDateTime,
    ) {
        query(
			"INSERT INTO share_access_log (id, share_link_id, accessed_by_email, ip_address, user_agent, success, failure_reason, accessed_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
		)
		.bind(event_id)
		.bind(share_link_id)
		.bind(accessed_by_email)
		.bind(ip_address)
		.bind(user_agent)
		.bind(success)
		.bind(failure_reason)
		.bind(accessed_at)
		.execute(pool)
		.await
		.expect("share access event should seed");
    }
}
