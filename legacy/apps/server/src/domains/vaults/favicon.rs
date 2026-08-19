use sqlx::{query, query_as, query_scalar, PgPool};
use time::{Duration, OffsetDateTime};

use crate::{
    error::AppError,
    integrations::favicon::{fetch_favicon_document, RemoteDocumentFetcher},
    shared::transaction::database_error,
};

const MAX_FAILURE_BACKOFF_MINUTES: i64 = 7 * 24 * 60;
const MIN_FAILURE_BACKOFF_MINUTES: i64 = 10;

#[derive(Debug, Clone)]
pub(crate) struct FaviconImage {
    pub data: Vec<u8>,
    pub content_type: String,
}

#[derive(Debug, sqlx::FromRow)]
struct DbFaviconRow {
    image_data: Option<Vec<u8>>,
    content_type: Option<String>,
    status: String,
    failed_at: Option<OffsetDateTime>,
    fail_count: i32,
}

pub(crate) async fn get_fetched_favicon(
    pool: &PgPool,
    domain: &str,
) -> Result<Option<FaviconImage>, AppError> {
    let existing = query_as::<_, DbFaviconRow>(
        "SELECT image_data, content_type, status::text AS status, failed_at, fail_count FROM favicon WHERE domain = $1 LIMIT 1",
    )
    .bind(domain)
    .fetch_optional(pool)
    .await
    .map_err(|error| database_error(error, "Failed to load favicon"))?;

    let Some(existing) = existing else {
        return Ok(None);
    };
    if existing.status != "fetched" {
        return Ok(None);
    }
    let Some(data) = existing.image_data else {
        return Ok(None);
    };

    Ok(Some(FaviconImage {
        data,
        content_type: existing
            .content_type
            .unwrap_or_else(|| "image/x-icon".to_string()),
    }))
}

pub(crate) async fn list_domains_to_refresh(
    pool: &PgPool,
    limit: i64,
    stale_before: OffsetDateTime,
) -> Result<Vec<String>, AppError> {
    query_scalar::<_, String>(
        "SELECT domain FROM favicon WHERE (status = 'fetched' AND fetched_at < $1) OR status = 'failed' LIMIT $2",
    )
    .bind(stale_before)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(|error| database_error(error, "Failed to list favicons for refresh"))
}

pub(crate) async fn fetch_and_store_favicon(
    pool: &PgPool,
    fetcher: &dyn RemoteDocumentFetcher,
    domain: &str,
) -> Result<bool, AppError> {
    let existing = query_as::<_, DbFaviconRow>(
        "SELECT image_data, content_type, status::text AS status, failed_at, fail_count FROM favicon WHERE domain = $1 LIMIT 1",
    )
    .bind(domain)
    .fetch_optional(pool)
    .await
    .map_err(|error| database_error(error, "Failed to load favicon refresh state"))?;

    if let Some(existing) = &existing {
        if existing.status == "fetched"
            && existing
                .image_data
                .as_ref()
                .is_some_and(|data| !data.is_empty())
        {
            return Ok(true);
        }

        if existing.status == "failed" {
            if let Some(failed_at) = existing.failed_at {
                let backoff = compute_failure_backoff_minutes(existing.fail_count.max(1));
                if failed_at + Duration::minutes(backoff) > OffsetDateTime::now_utc() {
                    return Ok(false);
                }
            }
        }
    }

    upsert_pending(pool, domain).await?;
    match fetch_favicon_document(fetcher, domain).await {
        Ok(Some(document)) => {
            mark_fetched(pool, domain, &document.data, &document.content_type).await?;
            Ok(true)
        }
        Ok(None) | Err(_) => {
            mark_failed(pool, domain).await?;
            Ok(false)
        }
    }
}

fn compute_failure_backoff_minutes(fail_count: i32) -> i64 {
    let step = (fail_count - 1).max(0) as u32;
    (MIN_FAILURE_BACKOFF_MINUTES * 2_i64.pow(step)).min(MAX_FAILURE_BACKOFF_MINUTES)
}

async fn upsert_pending(pool: &PgPool, domain: &str) -> Result<(), AppError> {
    query(
        "INSERT INTO favicon (domain, status, updated_at) VALUES ($1, 'pending', $2) ON CONFLICT (domain) DO UPDATE SET status = 'pending', updated_at = EXCLUDED.updated_at",
    )
    .bind(domain)
    .bind(OffsetDateTime::now_utc())
    .execute(pool)
    .await
    .map_err(|error| database_error(error, "Failed to mark favicon pending"))?;
    Ok(())
}

async fn mark_fetched(
    pool: &PgPool,
    domain: &str,
    data: &[u8],
    content_type: &str,
) -> Result<(), AppError> {
    let now = OffsetDateTime::now_utc();
    query(
        "UPDATE favicon SET status = 'fetched', image_data = $1, content_type = $2, fetched_at = $3, failed_at = NULL, fail_count = 0, updated_at = $3 WHERE domain = $4",
    )
    .bind(data)
    .bind(content_type)
    .bind(now)
    .bind(domain)
    .execute(pool)
    .await
    .map_err(|error| database_error(error, "Failed to store fetched favicon"))?;
    Ok(())
}

async fn mark_failed(pool: &PgPool, domain: &str) -> Result<(), AppError> {
    let now = OffsetDateTime::now_utc();
    query(
        "INSERT INTO favicon (domain, status, failed_at, fail_count, updated_at) VALUES ($1, 'failed', $2, 1, $2) ON CONFLICT (domain) DO UPDATE SET status = 'failed', failed_at = EXCLUDED.failed_at, fail_count = favicon.fail_count + 1, updated_at = EXCLUDED.updated_at",
    )
    .bind(domain)
    .bind(now)
    .execute(pool)
    .await
    .map_err(|error| database_error(error, "Failed to store favicon fetch failure"))?;
    Ok(())
}
