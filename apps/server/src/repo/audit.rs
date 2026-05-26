use sqlx::{query_as, PgPool};
use time::OffsetDateTime;

use crate::error::AppError;

#[derive(Debug, sqlx::FromRow)]
pub struct AuditActorRow {
    pub team_id: Option<String>,
    pub role: String,
    pub billing_plan: Option<String>,
    pub billing_status: Option<String>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct TeamMemberRow {
    pub id: String,
    pub name: Option<String>,
    pub email: Option<String>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct AuditEventRow {
    pub id: String,
    pub user_id: String,
    pub action: String,
    pub entity_type: Option<String>,
    pub entity_id: Option<String>,
    pub ip_address: Option<String>,
    pub user_agent: Option<String>,
    pub metadata: Option<String>,
    pub created_at: OffsetDateTime,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ShareAccessEventRow {
    pub id: String,
    pub share_link_id: String,
    pub created_by_id: String,
    pub accessed_by_email: Option<String>,
    pub ip_address: Option<String>,
    pub user_agent: Option<String>,
    pub success: bool,
    pub failure_reason: Option<String>,
    pub accessed_at: OffsetDateTime,
}

/// Flat filter for audit/share-access event queries.
pub struct AuditEventFilter<'a> {
    pub member_ids: &'a [String],
    pub actor_user_id: Option<&'a str>,
    pub from: Option<OffsetDateTime>,
    pub to: Option<OffsetDateTime>,
    pub search_pattern: Option<&'a str>,
    pub scan_limit: i64,
}

pub async fn load_actor(pool: &PgPool, user_id: &str) -> Result<AuditActorRow, AppError> {
    query_as::<_, AuditActorRow>(
		"SELECT u.team_id, u.role::text AS role, t.billing_plan::text AS billing_plan, t.billing_status::text AS billing_status FROM \"user\" u LEFT JOIN team t ON u.team_id = t.id WHERE u.id = $1 LIMIT 1",
	)
	.bind(user_id)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load team actor"); AppError::internal("Failed to load team actor") })?
	.ok_or_else(|| AppError::not_found("Team not found"))
}

pub async fn load_team_members(
    pool: &PgPool,
    team_id: &str,
) -> Result<Vec<TeamMemberRow>, AppError> {
    query_as::<_, TeamMemberRow>("SELECT id, name, email FROM \"user\" WHERE team_id = $1")
        .bind(team_id)
        .fetch_all(pool)
        .await
        .map_err(|_| AppError::internal("Failed to load team members"))
}

pub async fn load_audit_events(
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
	.map_err(|_| AppError::internal("Failed to load audit events"))
}

pub async fn load_share_access_events(
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
	.map_err(|_| AppError::internal("Failed to load share access events"))
}
