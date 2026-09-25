//! The reservation retains both scheduled cleanup duty and uncertainty about an issued DELETE.
use super::*;

pub(crate) async fn cleanup_durable_attachment_uploads(
    pool: &PgPool,
    object_storage: &dyn storage::ObjectStorage,
    batch_size: i64,
) -> Result<u64, AppError> {
    let mut selection = begin_cleanup(pool).await?;
    let candidates = query_scalar::<_, String>(
        "SELECT p.attachment_id FROM pending_attachment_upload p
         WHERE p.durable_request_fingerprint IS NOT NULL AND p.next_cleanup_at <= $1
         AND (p.expires_at <= $1 OR p.consumed_at IS NOT NULL OR p.created_by IS NULL
              OR p.item_id IS NULL OR p.vault_id IS NULL OR p.team_id IS NULL)
         AND NOT EXISTS (SELECT 1 FROM item_attachment a WHERE a.storage_key=p.storage_key)
         ORDER BY p.next_cleanup_at,p.id LIMIT $2",
    )
    .bind(OffsetDateTime::now_utc())
    .bind(batch_size)
    .fetch_all(&mut *selection)
    .await
    .map_err(|e| database_error(e, "Failed to select durable Attachment cleanup"))?;
    selection
        .commit()
        .await
        .map_err(|e| database_error(e, "Failed to finish durable Attachment cleanup selection"))?;
    let mut deleted = 0;
    // Visit this bounded selection once. Rescheduling advances later invocations past failures.
    for attachment_id in candidates {
        let Some(attempt) = prepare_cleanup(pool, &attachment_id).await? else {
            continue;
        };
        #[cfg(test)]
        crate::test_support::pause_durable_attachment_cleanup_after_fence(&attachment_id).await;
        deleted += u64::from(finish_cleanup(pool, object_storage, &attachment_id, attempt).await?);
    }
    Ok(deleted)
}

// Invocation-local evidence only. The existing row owns the durable token and cleanup duty.
struct CleanupAttempt {
    token: String,
    was_unfenced: bool,
}

async fn begin_cleanup(pool: &PgPool) -> Result<Transaction<'_, Postgres>, AppError> {
    // Cleanup never acquires Sync/authority/quota locks after the reservation lock.
    let mut transaction = pool
        .begin()
        .await
        .map_err(|e| database_error(e, "Failed to begin durable Attachment cleanup"))?;
    query("SET LOCAL statement_timeout = '30s'")
        .execute(&mut *transaction)
        .await
        .map_err(|e| database_error(e, "Failed to bound durable Attachment cleanup"))?;
    Ok(transaction)
}

fn reclaimable(row: &Reservation, now: OffsetDateTime) -> bool {
    row.durable_request_fingerprint.is_some()
        && (row.expires_at <= now
            || row.consumed_at.is_some()
            || row.created_by.is_none()
            || row.item_id.is_none()
            || row.vault_id.is_none()
            || row.team_id.is_none())
}

async fn referenced(
    transaction: &mut Transaction<'_, Postgres>,
    key: &str,
) -> Result<bool, AppError> {
    query_scalar("SELECT EXISTS(SELECT 1 FROM item_attachment WHERE storage_key=$1)")
        .bind(key)
        .fetch_one(&mut **transaction)
        .await
        .map_err(|e| database_error(e, "Failed to inspect durable Attachment object reference"))
}

async fn prepare_cleanup(
    pool: &PgPool,
    attachment_id: &str,
) -> Result<Option<CleanupAttempt>, AppError> {
    let mut transaction = begin_cleanup(pool).await?;
    lock_identity(&mut transaction, attachment_id).await?;
    let Some(row) = load(&mut transaction, attachment_id).await? else {
        return Ok(None);
    };
    let now = OffsetDateTime::now_utc();
    if !row.next_cleanup_at.is_some_and(|due| due <= now)
        || !reclaimable(&row, now)
        || referenced(&mut transaction, &row.storage_key).await?
    {
        return Ok(None);
    }
    let attempt = CleanupAttempt {
        token: uuid::Uuid::new_v4().to_string(),
        was_unfenced: row.cleanup_attempt_id.is_none(),
    };
    // Persist before any external DELETE. A lost commit answer stops this invocation before I/O.
    // Rotating an inherited token also prevents a paused old actor from rehabilitating this row.
    query(
        "UPDATE pending_attachment_upload SET cleanup_attempt_id=$1,next_cleanup_at=$2 WHERE id=$3",
    )
    .bind(&attempt.token)
    .bind(now + time::Duration::minutes(15))
    .bind(&row.id)
    .execute(&mut *transaction)
    .await
    .map_err(|e| database_error(e, "Failed to fence durable Attachment cleanup"))?;
    transaction
        .commit()
        .await
        .map_err(|e| database_error(e, "Failed to commit durable Attachment cleanup fence"))?;
    Ok(Some(attempt))
}

async fn finish_cleanup(
    pool: &PgPool,
    object_storage: &dyn storage::ObjectStorage,
    attachment_id: &str,
    attempt: CleanupAttempt,
) -> Result<bool, AppError> {
    let mut transaction = begin_cleanup(pool).await?;
    lock_identity(&mut transaction, attachment_id).await?;
    let Some(row) = load(&mut transaction, attachment_id).await? else {
        return Ok(false);
    };
    if row.cleanup_attempt_id.as_deref() != Some(attempt.token.as_str())
        || !reclaimable(&row, OffsetDateTime::now_utc())
        || referenced(&mut transaction, &row.storage_key).await?
    {
        return Ok(false);
    }
    let deletion = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        object_storage.delete(&row.storage_key),
    )
    .await;
    let succeeded = matches!(deletion, Ok(Ok(())));
    let interval = if succeeded {
        time::Duration::hours(24)
    } else {
        time::Duration::minutes(15)
    };
    // Only this originally unfenced invocation can prove its sole DELETE completed. A successful
    // retry cannot prove any older ambiguous DELETE drained, so inherited fences never clear.
    query("UPDATE pending_attachment_upload SET next_cleanup_at=$1,cleanup_attempt_id=CASE WHEN $2 THEN NULL ELSE cleanup_attempt_id END WHERE id=$3 AND cleanup_attempt_id=$4")
        .bind(OffsetDateTime::now_utc() + interval)
        .bind(succeeded && attempt.was_unfenced)
        .bind(&row.id)
        .bind(&attempt.token)
        .execute(&mut *transaction)
        .await
        .map_err(|e| database_error(e, "Failed to reschedule durable Attachment cleanup"))?;
    transaction
        .commit()
        .await
        .map_err(|e| database_error(e, "Failed to commit durable Attachment cleanup completion"))?;
    if !succeeded {
        return Err(AppError::retryable_conflict(
            "Durable Attachment object cleanup failed; identity remains fenced and retry is scheduled",
        ));
    }
    Ok(true)
}
