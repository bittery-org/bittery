use sqlx::{query, query_as, PgPool};

use crate::error::AppError;

pub(crate) const RESPONSE_BODY_LIMIT: usize = 2 * 1024 * 1024;

pub(crate) struct RequestScope<'a> {
    pub(crate) principal_id: &'a str,
    pub(crate) method: &'a str,
    pub(crate) route_target: &'a str,
    pub(crate) key: &'a str,
}

pub(crate) struct StoredResponse {
    pub(crate) status: u16,
    pub(crate) content_type: Option<String>,
    pub(crate) body: Vec<u8>,
    pub(crate) etag: Option<String>,
}

pub(crate) enum Claim {
    Execute,
    Replay(StoredResponse),
    FingerprintMismatch,
    InProgress,
    Indeterminate,
}

// Claims commit before domain services run because those services own their transactions.
// An expired claim becomes terminally indeterminate instead of risking a duplicate mutation.
// Operators may delete it only after verifying the domain outcome from audit/resource state.

#[derive(sqlx::FromRow)]
struct IdempotencyRow {
    request_fingerprint: Vec<u8>,
    state: String,
    response_status: Option<i16>,
    response_content_type: Option<String>,
    response_body: Option<Vec<u8>>,
    response_etag: Option<String>,
}

pub(crate) async fn claim(
    pool: &PgPool,
    scope: &RequestScope<'_>,
    fingerprint: &[u8; 32],
) -> Result<Claim, AppError> {
    maintain_records(pool).await?;
    let inserted = query(
        "INSERT INTO idempotency_record (principal_id, method, route_target, idempotency_key, request_fingerprint, claim_expires_at) VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '5 minutes') ON CONFLICT DO NOTHING",
    )
    .bind(scope.principal_id)
    .bind(scope.method)
    .bind(scope.route_target)
    .bind(scope.key)
    .bind(fingerprint.as_slice())
    .execute(pool)
    .await
    .map_err(database_error)?
    .rows_affected()
        == 1;
    if inserted {
        return Ok(Claim::Execute);
    }

    let reclaimed = query(
        "UPDATE idempotency_record SET request_fingerprint = $5, state = 'pending', response_status = NULL, response_content_type = NULL, response_body = NULL, response_etag = NULL, claim_expires_at = NOW() + INTERVAL '5 minutes', terminal_reason = NULL, created_at = NOW(), expires_at = NOW() + INTERVAL '24 hours' WHERE principal_id = $1 AND method = $2 AND route_target = $3 AND idempotency_key = $4 AND state = 'completed' AND expires_at <= NOW()",
    )
    .bind(scope.principal_id)
    .bind(scope.method)
    .bind(scope.route_target)
    .bind(scope.key)
    .bind(fingerprint.as_slice())
    .execute(pool)
    .await
    .map_err(database_error)?
    .rows_affected()
        == 1;
    if reclaimed {
        return Ok(Claim::Execute);
    }

    let row = query_as::<_, IdempotencyRow>(
        "SELECT request_fingerprint, state, response_status, response_content_type, response_body, response_etag FROM idempotency_record WHERE principal_id = $1 AND method = $2 AND route_target = $3 AND idempotency_key = $4",
    )
    .bind(scope.principal_id)
    .bind(scope.method)
    .bind(scope.route_target)
    .bind(scope.key)
    .fetch_one(pool)
    .await
    .map_err(database_error)?;

    if row.request_fingerprint != fingerprint {
        return Ok(Claim::FingerprintMismatch);
    }
    if row.state == "pending" {
        return Ok(Claim::InProgress);
    }
    if row.state == "indeterminate" {
        return Ok(Claim::Indeterminate);
    }

    let status = row
        .response_status
        .and_then(|value| u16::try_from(value).ok())
        .ok_or_else(|| AppError::internal("Stored idempotency response has no status"))?;
    let body = row
        .response_body
        .ok_or_else(|| AppError::internal("Stored idempotency response has no body"))?;
    Ok(Claim::Replay(StoredResponse {
        status,
        content_type: row.response_content_type,
        body,
        etag: row.response_etag,
    }))
}

pub(crate) async fn complete(
    pool: &PgPool,
    scope: &RequestScope<'_>,
    fingerprint: &[u8; 32],
    response: &StoredResponse,
) -> Result<(), AppError> {
    if response.body.len() > RESPONSE_BODY_LIMIT {
        return Err(AppError::internal(
            "Idempotent response exceeded its storage budget",
        ));
    }
    let status = i16::try_from(response.status)
        .map_err(|_| AppError::internal("Invalid idempotent response status"))?;
    let updated = query(
        "UPDATE idempotency_record SET state = 'completed', response_status = $6, response_content_type = $7, response_body = $8, response_etag = $9, claim_expires_at = NULL, expires_at = NOW() + INTERVAL '24 hours' WHERE principal_id = $1 AND method = $2 AND route_target = $3 AND idempotency_key = $4 AND request_fingerprint = $5 AND state = 'pending' AND claim_expires_at > NOW()",
    )
    .bind(scope.principal_id)
    .bind(scope.method)
    .bind(scope.route_target)
    .bind(scope.key)
    .bind(fingerprint.as_slice())
    .bind(status)
    .bind(response.content_type.as_deref())
    .bind(response.body.as_slice())
    .bind(response.etag.as_deref())
    .execute(pool)
    .await
    .map_err(database_error)?
    .rows_affected();
    if updated != 1 {
        return Err(AppError::internal(
            "Idempotency claim was lost before completion",
        ));
    }
    Ok(())
}

async fn maintain_records(pool: &PgPool) -> Result<(), AppError> {
    query(
        "WITH expired AS (SELECT ctid FROM idempotency_record WHERE state = 'completed' AND expires_at <= NOW() ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED) DELETE FROM idempotency_record record USING expired WHERE record.ctid = expired.ctid",
    )
    .execute(pool)
    .await
    .map_err(database_error)?;
    query(
        "WITH stale AS (SELECT ctid FROM idempotency_record WHERE state = 'pending' AND claim_expires_at <= NOW() ORDER BY claim_expires_at LIMIT 100 FOR UPDATE SKIP LOCKED) UPDATE idempotency_record record SET state = 'indeterminate', claim_expires_at = NULL, terminal_reason = 'OUTCOME_UNKNOWN_AFTER_CLAIM_TIMEOUT' FROM stale WHERE record.ctid = stale.ctid",
    )
    .execute(pool)
    .await
    .map_err(database_error)?;
    Ok(())
}

fn database_error(error: sqlx::Error) -> AppError {
    tracing::error!(error = %error, "Idempotency database operation failed");
    AppError::internal("Idempotency database operation failed")
}
