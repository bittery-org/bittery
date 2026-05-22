use rand::random;
use serde_json::Value;
use sqlx::{query, query_as, query_scalar, PgPool};
use time::OffsetDateTime;

const SESSION_REVOKED_AUDIT_ACTION: &str = "session_revoked";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionRevocationRecord {
    pub timestamp: i64,
    pub reason: Option<String>,
}

#[derive(sqlx::FromRow)]
struct DbSessionRevocationAuditRow {
    metadata: Option<String>,
    created_at: OffsetDateTime,
}

pub async fn load_user_session_ids(
    pool: &PgPool,
    user_id: &str,
) -> Result<Vec<String>, sqlx::Error> {
    query_scalar::<_, String>("SELECT id FROM session WHERE user_id = $1")
        .bind(user_id)
        .fetch_all(pool)
        .await
}

pub async fn record_session_revocations(
    pool: &PgPool,
    user_id: &str,
    session_ids: &[String],
    reason: &str,
) -> Result<(), sqlx::Error> {
    if session_ids.is_empty() {
        return Ok(());
    }

    let created_at = OffsetDateTime::now_utc();
    let metadata = serde_json::json!({ "reason": reason }).to_string();

    for session_id in session_ids {
        query(
			"INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, metadata, created_at) VALUES ($1, $2, $3, 'session', $4, $5, $6)",
		)
		.bind(format!("audit_{:016x}", random::<u64>()))
		.bind(user_id)
		.bind(SESSION_REVOKED_AUDIT_ACTION)
		.bind(session_id)
		.bind(&metadata)
		.bind(created_at)
		.execute(pool)
		.await?;
    }

    Ok(())
}

pub async fn load_session_revocation(
    pool: &PgPool,
    user_id: &str,
    session_id: &str,
) -> Result<Option<SessionRevocationRecord>, sqlx::Error> {
    let row = query_as::<_, DbSessionRevocationAuditRow>(
		"SELECT metadata, created_at FROM audit_log WHERE user_id = $1 AND action = $2 AND entity_type = 'session' AND entity_id = $3 ORDER BY created_at DESC LIMIT 1",
	)
	.bind(user_id)
	.bind(SESSION_REVOKED_AUDIT_ACTION)
	.bind(session_id)
	.fetch_optional(pool)
	.await?;

    Ok(row.map(|row| SessionRevocationRecord {
        timestamp: timestamp_millis(row.created_at),
        reason: reason_from_metadata(row.metadata.as_deref()),
    }))
}

fn reason_from_metadata(metadata: Option<&str>) -> Option<String> {
    metadata
        .and_then(|value| serde_json::from_str::<Value>(value).ok())
        .and_then(|value| {
            value
                .get("reason")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
}

fn timestamp_millis(value: OffsetDateTime) -> i64 {
    (value.unix_timestamp_nanos() / 1_000_000) as i64
}

#[cfg(test)]
mod tests {
    use super::reason_from_metadata;

    #[test]
    fn extracts_reason_from_metadata_json() {
        assert_eq!(
            reason_from_metadata(Some(r#"{"reason":"device_revoked"}"#)),
            Some("device_revoked".to_string())
        );
    }

    #[test]
    fn ignores_invalid_metadata_json() {
        assert_eq!(reason_from_metadata(Some("not-json")), None);
        assert_eq!(reason_from_metadata(None), None);
    }
}
