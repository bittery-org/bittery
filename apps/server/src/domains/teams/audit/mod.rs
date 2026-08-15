use std::collections::HashMap;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{query_as, PgPool};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

use crate::{
    config::DeploymentMode,
    db::enums::{BillingPlan, BillingStatus, TeamRole},
    error::AppError,
};

use super::admin::authorize_team_admin;

pub(crate) mod routes;

#[derive(Debug, sqlx::FromRow)]
pub(super) struct AuditActorRow {
    pub(super) team_id: Option<String>,
    pub(super) role: TeamRole,
    pub(super) billing_plan: Option<BillingPlan>,
    pub(super) billing_status: Option<BillingStatus>,
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

/// Flat filter for audit/share-access event queries.
struct AuditEventFilter<'a> {
    member_ids: &'a [String],
    actor_user_id: Option<&'a str>,
    from: Option<OffsetDateTime>,
    to: Option<OffsetDateTime>,
    search_pattern: Option<&'a str>,
    scan_limit: i64,
}

pub(super) async fn load_actor(pool: &PgPool, user_id: &str) -> Result<AuditActorRow, AppError> {
    query_as::<_, AuditActorRow>(
		"SELECT u.team_id, u.role::text AS role, t.billing_plan::text AS billing_plan, t.billing_status::text AS billing_status FROM \"user\" u LEFT JOIN team t ON u.team_id = t.id WHERE u.id = $1 LIMIT 1",
	)
	.bind(user_id)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load team actor"); AppError::internal("Failed to load team actor") })?
	.ok_or_else(|| AppError::not_found("Team not found"))
}

async fn load_team_members(pool: &PgPool, team_id: &str) -> Result<Vec<TeamMemberRow>, AppError> {
    query_as::<_, TeamMemberRow>("SELECT id, name, email FROM \"user\" WHERE team_id = $1")
        .bind(team_id)
        .fetch_all(pool)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to load team members");
            AppError::internal("Failed to load team members")
        })
}

async fn load_audit_events(
    pool: &PgPool,
    filter: &AuditEventFilter<'_>,
    action_group: &str,
    auth_actions: &[&str],
) -> Result<Vec<AuditEventRow>, AppError> {
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
	.bind(filter.member_ids)
	.bind(filter.actor_user_id)
	.bind(filter.from)
	.bind(filter.to)
	.bind(filter.search_pattern)
	.bind(action_group)
	.bind(auth_actions)
	.bind(filter.scan_limit)
	.fetch_all(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load audit events"); AppError::internal("Failed to load audit events") })
}

async fn load_share_access_events(
    pool: &PgPool,
    filter: &AuditEventFilter<'_>,
    result_filter: &str,
) -> Result<Vec<ShareAccessEventRow>, AppError> {
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
	.bind(filter.member_ids)
	.bind(filter.actor_user_id)
	.bind(filter.from)
	.bind(filter.to)
	.bind(filter.search_pattern)
	.bind(result_filter)
	.bind(filter.scan_limit)
	.fetch_all(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load share access events"); AppError::internal("Failed to load share access events") })
}

pub(crate) const DEFAULT_LIMIT: u32 = 50;
pub(crate) const MAX_LIMIT: u32 = 100;
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

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AuditResultFilter {
    Success,
    Failure,
    All,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EventSource {
    AuditLog,
    ShareAccessLog,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AuditActionGroup {
    Auth,
    Team,
    Vault,
    Item,
    Share,
    Other,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TeamEventResult {
    Success,
    Failure,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamEventActor {
    pub user_id: Option<String>,
    pub name: Option<String>,
    pub email: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamEventEntity {
    pub r#type: Option<String>,
    pub id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamEventNetwork {
    pub masked_ip: Option<String>,
    pub masked_user_agent: Option<String>,
    pub full_ip: Option<String>,
    pub full_user_agent: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamEventsResponse {
    pub events: Vec<TeamEvent>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct CursorPayload {
    timestamp: String,
    source: EventSource,
    id: String,
}

pub(crate) async fn get_team_events(
    pool: &sqlx::PgPool,
    user_id: &str,
    deployment_mode: DeploymentMode,
    input: TeamEventsInput,
) -> Result<TeamEventsResponse, AppError> {
    let team_id = authorize_team_admin(pool, user_id, deployment_mode)
        .await?
        .team_id;

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
    let filter = AuditEventFilter {
        member_ids: &member_ids,
        actor_user_id: normalized.actor_user_id.as_deref(),
        from: normalized.from,
        to: normalized.to,
        search_pattern: normalized.search_pattern.as_deref(),
        scan_limit: MAX_SCAN_ROWS,
    };
    let include_audit = normalized.action_group != AuditActionGroupFilter::Share
        && normalized.result != AuditResultFilter::Failure;
    let include_share = matches!(
        normalized.action_group,
        AuditActionGroupFilter::All | AuditActionGroupFilter::Share
    );

    let audit_rows = if include_audit {
        load_audit_events(
            pool,
            &filter,
            normalized.action_group.as_str(),
            AUTH_ACTIONS,
        )
        .await?
    } else {
        Vec::new()
    };

    let share_rows = if include_share {
        load_share_access_events(pool, &filter, normalized.result.as_str()).await?
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

fn normalize_input(input: &TeamEventsInput) -> Result<NormalizedInput, AppError> {
    let limit = input.limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT);
    let action_group = input.action_group.unwrap_or(AuditActionGroupFilter::All);
    let result = input.result.unwrap_or(AuditResultFilter::All);
    let from = input.from.as_deref().map(parse_timestamp).transpose()?;
    let to = input.to.as_deref().map(parse_timestamp).transpose()?;
    if let (Some(from), Some(to)) = (from, to) {
        if from > to {
            return Err(AppError::bad_request(
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

fn parse_timestamp(value: &str) -> Result<OffsetDateTime, AppError> {
    OffsetDateTime::parse(value, &Rfc3339)
        .map_err(|_| AppError::bad_request("Invalid RFC3339 timestamp"))
}

fn decode_cursor(raw: &str) -> Result<CursorPayload, AppError> {
    let decoded = URL_SAFE_NO_PAD
        .decode(raw)
        .map_err(|_| AppError::bad_request("Invalid pagination cursor"))?;
    let cursor = serde_json::from_slice::<CursorPayload>(&decoded)
        .map_err(|_| AppError::bad_request("Invalid pagination cursor"))?;
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
        .filter(|value| value.is_object())
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

pub(crate) fn mask_ip(ip_address: Option<&str>) -> Option<String> {
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
#[path = "audit_tests.rs"]
mod tests;
