use sqlx::{query, query_as, query_scalar, PgPool};

use crate::db::models::{
    DbPublicShareLinkRow, DbShareAccessLogRow, DbShareLinkAllowedEmailRow, DbShareLinkRow,
};
use crate::error::AppError;
use crate::repo::common::{generate_resource_id, hash_token};

pub async fn load_share_links_for_item(
    pool: &PgPool,
    item_id: &str,
) -> Result<Vec<DbShareLinkRow>, AppError> {
    query_as::<_, DbShareLinkRow>(
		"SELECT sl.id, sl.item_id, sl.created_by_id, sl.status::text AS status, sl.access_mode::text AS access_mode, sl.is_one_time_use, sl.access_count, sl.max_access_count, sl.expires_at, sl.created_at, sl.last_accessed_at, i.vault_id FROM share_link sl INNER JOIN item i ON i.id = sl.item_id WHERE sl.item_id = $1 ORDER BY sl.created_at DESC",
	)
	.bind(item_id)
	.fetch_all(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load share links"); AppError::internal("Failed to load share links") })
}

/// `token` is the caller-supplied plaintext; only its digest is ever compared,
/// because `share_link.token_hash` never holds the token itself.
pub async fn load_public_share_link_by_token(
    pool: &PgPool,
    token: &str,
) -> Result<Option<DbPublicShareLinkRow>, AppError> {
    query_as::<_, DbPublicShareLinkRow>(
		"SELECT id, created_by_id, status::text AS status, access_mode::text AS access_mode, is_one_time_use, encrypted_item_data, encryption_iv, encrypted_share_key, share_key_iv, access_count, max_access_count, expires_at FROM share_link WHERE token_hash = $1 LIMIT 1",
	)
	.bind(hash_token(token))
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load public share link"); AppError::internal("Failed to load public share link") })
}

pub async fn load_allowed_emails_for_links(
    pool: &PgPool,
    link_ids: &[String],
) -> Result<std::collections::HashMap<String, Vec<DbShareLinkAllowedEmailRow>>, AppError> {
    if link_ids.is_empty() {
        return Ok(std::collections::HashMap::new());
    }

    let rows = query_as::<_, DbShareLinkAllowedEmailRow>(
		"SELECT id, share_link_id, email, verified, verified_at, created_at FROM share_link_allowed_email WHERE share_link_id = ANY($1) ORDER BY created_at ASC",
	)
	.bind(link_ids)
	.fetch_all(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load share link allowed emails"); AppError::internal("Failed to load share link allowed emails") })?;

    let mut grouped = std::collections::HashMap::new();
    for row in rows {
        grouped
            .entry(row.share_link_id.clone())
            .or_insert_with(Vec::new)
            .push(row);
    }

    Ok(grouped)
}

pub async fn log_share_access(
    pool: &PgPool,
    share_link_id: &str,
    email: Option<&str>,
    success: bool,
    failure_reason: Option<&str>,
) -> Result<(), AppError> {
    query(
		"INSERT INTO share_access_log (id, share_link_id, accessed_by_email, ip_address, user_agent, success, failure_reason, accessed_at) VALUES ($1, $2, $3, NULL, NULL, $4, $5, $6)",
	)
	.bind(generate_resource_id("share_access"))
	.bind(share_link_id)
	.bind(email)
	.bind(success)
	.bind(failure_reason)
	.bind(time::OffsetDateTime::now_utc())
	.execute(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to record share access log"); AppError::internal("Failed to record share access log") })?;

    Ok(())
}

pub async fn consume_share_link_access(
    pool: &PgPool,
    share_link_id: &str,
    now: time::OffsetDateTime,
) -> Result<bool, AppError> {
    let updated_rows = query(
		"UPDATE share_link SET access_count = access_count + 1, last_accessed_at = $2, status = CASE WHEN max_access_count IS NOT NULL AND access_count + 1 >= max_access_count THEN 'exhausted'::share_link_status ELSE status END WHERE id = $1 AND status = 'active' AND expires_at > $2 AND (max_access_count IS NULL OR access_count < max_access_count)",
	)
	.bind(share_link_id)
	.bind(now)
	.execute(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to consume share link access"); AppError::internal("Failed to consume share link access") })?
	.rows_affected();

    Ok(updated_rows > 0)
}

pub async fn count_active_share_links(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    team_id: Option<&str>,
    user_id: &str,
    now: time::OffsetDateTime,
) -> Result<i64, AppError> {
    let count = match team_id {
		Some(team_id) => query_scalar::<_, i64>(
			"SELECT COUNT(*)::bigint FROM share_link sl INNER JOIN \"user\" u ON sl.created_by_id = u.id WHERE u.team_id = $1 AND sl.status = 'active' AND sl.expires_at > $2 AND (sl.max_access_count IS NULL OR sl.access_count < sl.max_access_count)",
		)
		.bind(team_id)
		.bind(now)
		.fetch_one(&mut **transaction)
		.await,
		None => query_scalar::<_, i64>(
			"SELECT COUNT(*)::bigint FROM share_link WHERE created_by_id = $1 AND status = 'active' AND expires_at > $2 AND (max_access_count IS NULL OR access_count < max_access_count)",
		)
		.bind(user_id)
		.bind(now)
		.fetch_one(&mut **transaction)
		.await,
	}
	.map_err(|e| { tracing::error!(error = %e, "Failed to count active share links"); AppError::internal("Failed to count active share links") })?;

    Ok(count)
}

pub async fn load_share_access_logs(
    pool: &PgPool,
    share_link_id: &str,
    cursor: Option<(time::OffsetDateTime, String)>,
    limit: i64,
) -> Result<Vec<DbShareAccessLogRow>, AppError> {
    let cursor_timestamp = cursor.as_ref().map(|(timestamp, _)| *timestamp);
    let cursor_id = cursor.as_ref().map(|(_, id)| id.as_str());
    query_as::<_, DbShareAccessLogRow>(
		"SELECT id, accessed_by_email, ip_address, user_agent, success, failure_reason, accessed_at FROM share_access_log WHERE share_link_id = $1 AND ($2::timestamptz IS NULL OR (accessed_at, id) < ($2, $3)) ORDER BY accessed_at DESC, id DESC LIMIT $4",
	)
	.bind(share_link_id)
	.bind(cursor_timestamp)
	.bind(cursor_id)
	.bind(limit)
	.fetch_all(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load share access logs"); AppError::internal("Failed to load share access logs") })
}
