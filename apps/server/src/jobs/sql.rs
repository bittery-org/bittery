use rand::Rng;
use sqlx::{query, query_as, query_scalar, PgPool};
use time::{Duration, OffsetDateTime};
use tracing::{error, info};

use crate::{
    db::events::{begin_sync_event_transaction, lock_sync_event_order},
    db::models::{DbPendingAttachmentUploadRow, DbTombstoneCandidate},
    integrations::storage,
    shared::transaction::acquire_operation_lock,
};

const EXPIRED_SESSION_BATCH_SIZE: i64 = 1000;
const PENDING_ATTACHMENT_UPLOAD_BATCH_SIZE: i64 = 100;
const SYNC_EVENT_RETENTION_DAYS: i64 = 30;
/// Comfortably longer than the longest limiter window (the 24h share-link
/// counter) and the 24h Redis attempt retention it mirrors, so pruning can never
/// reset a window that is still in force.
const RATE_LIMIT_STATE_RETENTION_DAYS: i64 = 2;
const TOMBSTONE_RETENTION_DAYS: i64 = 90;
const TOMBSTONE_BATCH_SIZE: i64 = 200;

pub async fn cleanup_expired_sessions(pool: &PgPool) -> Result<u64, sqlx::Error> {
    let mut total_deleted = 0;

    loop {
        let now = OffsetDateTime::now_utc();
        let expired_session_ids = query_scalar::<_, String>(
            "SELECT id FROM session WHERE expires_at < $1 ORDER BY expires_at ASC, id ASC LIMIT $2",
        )
        .bind(now)
        .bind(EXPIRED_SESSION_BATCH_SIZE)
        .fetch_all(pool)
        .await?;

        if expired_session_ids.is_empty() {
            break;
        }

        query("DELETE FROM session WHERE id = ANY($1)")
            .bind(&expired_session_ids)
            .execute(pool)
            .await?;

        total_deleted += expired_session_ids.len() as u64;
    }

    if total_deleted > 0 {
        info!(deleted = total_deleted, "expired-session-cleanup completed");
    }

    Ok(total_deleted)
}

pub async fn prune_sync_events(pool: &PgPool) -> Result<u64, sqlx::Error> {
    let cutoff = OffsetDateTime::now_utc() - Duration::days(SYNC_EVENT_RETENTION_DAYS);
    let deleted = query("DELETE FROM sync_event WHERE created_at < $1")
        .bind(cutoff)
        .execute(pool)
        .await?;

    let deleted = deleted.rows_affected();
    if deleted > 0 {
        info!(
            deleted,
            retention_days = SYNC_EVENT_RETENTION_DAYS,
            "sync-event-pruning completed"
        );
    }

    Ok(deleted)
}

/// Rate-limit keys are attacker-influenced (IPs, email hashes), so every new
/// scope/key pair inserts a row that nothing else ever deletes. Evict rows that
/// have been idle past the retention window, but never one that is still locked
/// out — dropping a live `locked_until` would hand the caller a fresh budget.
pub async fn prune_rate_limit_state(pool: &PgPool) -> Result<u64, sqlx::Error> {
    let now = OffsetDateTime::now_utc();
    let cutoff = now - Duration::days(RATE_LIMIT_STATE_RETENTION_DAYS);
    let deleted = query(
        "DELETE FROM rate_limit_state WHERE updated_at < $1 AND (locked_until IS NULL OR locked_until < $2)",
    )
    .bind(cutoff)
    .bind(now)
    .execute(pool)
    .await?;

    let deleted = deleted.rows_affected();
    if deleted > 0 {
        info!(
            deleted,
            retention_days = RATE_LIMIT_STATE_RETENTION_DAYS,
            "rate-limit-state-pruning completed"
        );
    }

    Ok(deleted)
}

pub async fn cleanup_pending_attachment_uploads(
    pool: &PgPool,
    object_storage: &dyn storage::ObjectStorage,
) -> Result<u64, Box<dyn std::error::Error + Send + Sync>> {
    let mut total_deleted = 0;

    loop {
        let now = OffsetDateTime::now_utc();
        let expired_reservations = query_as::<_, DbPendingAttachmentUploadRow>(
			"SELECT id, storage_key FROM pending_attachment_upload WHERE consumed_at IS NULL AND expires_at < $1 LIMIT $2",
		)
		.bind(now)
		.bind(PENDING_ATTACHMENT_UPLOAD_BATCH_SIZE)
		.fetch_all(pool)
		.await?;

        if expired_reservations.is_empty() {
            break;
        }

        for reservation in &expired_reservations {
            if let Err(error) = object_storage.delete(&reservation.storage_key).await {
                error!(
                    storage_key = %reservation.storage_key,
                    error = %error,
                    "pending-attachment-upload-cleanup failed to delete object"
                );
            }
        }

        let expired_ids: Vec<String> = expired_reservations.iter().map(|r| r.id.clone()).collect();

        query("DELETE FROM pending_attachment_upload WHERE id = ANY($1)")
            .bind(&expired_ids)
            .execute(pool)
            .await?;

        total_deleted += expired_reservations.len() as u64;

        if expired_reservations.len() < PENDING_ATTACHMENT_UPLOAD_BATCH_SIZE as usize {
            break;
        }
    }

    if total_deleted > 0 {
        info!(
            deleted = total_deleted,
            "pending-attachment-upload-cleanup completed"
        );
    }

    Ok(total_deleted)
}

pub async fn cleanup_attachment_move_staging(
    pool: &PgPool,
    object_storage: &dyn storage::ObjectStorage,
) -> Result<u64, Box<dyn std::error::Error + Send + Sync>> {
    let now = OffsetDateTime::now_utc();
    let expired = query_as::<_, (String, String)>(
        "SELECT user_id, operation_id FROM attachment_move_manifest WHERE expires_at <= $1 ORDER BY expires_at, user_id, operation_id LIMIT 100",
    )
    .bind(now)
    .fetch_all(pool)
    .await?;
    for (user_id, operation_id) in &expired {
        let mut transaction = pool.begin().await?;
        acquire_operation_lock(
            &mut *transaction,
            user_id,
            operation_id,
            "Failed to lock expired Attachment Move",
        )
        .await?;
        let still_expired = query_scalar::<_, String>(
            "SELECT operation_id FROM attachment_move_manifest WHERE user_id = $1 AND operation_id = $2 AND expires_at <= $3 FOR UPDATE",
        )
        .bind(user_id)
        .bind(operation_id)
        .bind(now)
        .fetch_optional(&mut *transaction)
        .await?;
        if still_expired.is_none() {
            transaction.rollback().await?;
            continue;
        }
        query("INSERT INTO attachment_move_cleanup (user_id, operation_id, storage_key) SELECT user_id, operation_id, storage_key FROM attachment_move_staging WHERE user_id = $1 AND operation_id = $2 ON CONFLICT DO NOTHING")
            .bind(user_id)
            .bind(operation_id)
            .execute(&mut *transaction)
            .await?;
        query("DELETE FROM attachment_move_manifest WHERE user_id = $1 AND operation_id = $2")
            .bind(user_id)
            .bind(operation_id)
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
    }

    let queued = query_as::<_, (i64, String, String, String)>(
        "SELECT id, user_id, operation_id, storage_key FROM (SELECT id, user_id, operation_id, storage_key FROM attachment_move_cleanup WHERE claim_token IS NULL UNION ALL SELECT id, user_id, operation_id, storage_key FROM attachment_move_cleanup WHERE claim_token IS NOT NULL AND claimed_at <= NOW() - INTERVAL '5 minutes') eligible ORDER BY id LIMIT 100",
    )
    .fetch_all(pool)
    .await?;
    let mut deleted = 0;
    for (id, user_id, operation_id, storage_key) in queued {
        let mut transaction = pool.begin().await?;
        acquire_operation_lock(
            &mut *transaction,
            &user_id,
            &operation_id,
            "Failed to lock Attachment Move cleanup",
        )
        .await?;
        let live = query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM attachment_move_staging s INNER JOIN attachment_move_manifest m USING (user_id, operation_id) WHERE s.user_id = $1 AND s.operation_id = $2 AND s.storage_key = $3 AND m.expires_at > $4)",
        )
        .bind(&user_id)
        .bind(&operation_id)
        .bind(&storage_key)
        .bind(OffsetDateTime::now_utc())
        .fetch_one(&mut *transaction)
        .await?;
        if live {
            query("DELETE FROM attachment_move_cleanup WHERE id = $1")
                .bind(id)
                .execute(&mut *transaction)
                .await?;
            transaction.commit().await?;
            continue;
        }
        let claim_token = format!("{:032x}", rand::random::<u128>());
        let claimed = query_scalar::<_, i64>(
            "UPDATE attachment_move_cleanup SET claim_token = $1, claimed_at = NOW() WHERE id = $2 AND (claim_token IS NULL OR claimed_at <= NOW() - INTERVAL '5 minutes') RETURNING id",
        )
        .bind(&claim_token)
        .bind(id)
        .fetch_optional(&mut *transaction)
        .await?;
        if claimed.is_none() {
            transaction.rollback().await?;
            continue;
        }
        transaction.commit().await?;

        if let Err(error) = object_storage.delete(&storage_key).await {
            let mut release = pool.begin().await?;
            acquire_operation_lock(
                &mut *release,
                &user_id,
                &operation_id,
                "Failed to lock failed Attachment Move cleanup",
            )
            .await?;
            query("UPDATE attachment_move_cleanup SET claim_token = NULL, claimed_at = NULL WHERE id = $1 AND claim_token = $2")
                .bind(id)
                .bind(&claim_token)
                .execute(&mut *release)
                .await?;
            release.commit().await?;
            error!(%error, "attachment-move-cleanup will retry object deletion");
            continue;
        }

        let mut finalize = pool.begin().await?;
        acquire_operation_lock(
            &mut *finalize,
            &user_id,
            &operation_id,
            "Failed to lock completed Attachment Move cleanup",
        )
        .await?;
        let finalized =
            query("DELETE FROM attachment_move_cleanup WHERE id = $1 AND claim_token = $2")
                .bind(id)
                .bind(&claim_token)
                .execute(&mut *finalize)
                .await;
        match finalized {
            Ok(result) => {
                finalize.commit().await?;
                deleted += result.rows_affected();
            }
            Err(error) => {
                finalize.rollback().await?;
                let mut release = pool.begin().await?;
                acquire_operation_lock(
                    &mut *release,
                    &user_id,
                    &operation_id,
                    "Failed to unlock incomplete Attachment Move cleanup",
                )
                .await?;
                query("UPDATE attachment_move_cleanup SET claim_token = NULL, claimed_at = NULL WHERE id = $1 AND claim_token = $2")
                    .bind(id)
                    .bind(&claim_token)
                    .execute(&mut *release)
                    .await?;
                release.commit().await?;
                return Err(error.into());
            }
        }
    }
    Ok(deleted)
}

pub async fn cleanup_tombstones(pool: &PgPool) -> Result<u64, sqlx::Error> {
    let cutoff = OffsetDateTime::now_utc() - Duration::days(TOMBSTONE_RETENTION_DAYS);
    let mut total_deleted = 0;
    let mut total_events = 0;

    loop {
        let candidates = query_as::<_, DbTombstoneCandidate>(
			"SELECT id, vault_id, last_modified_by, version FROM item WHERE deleted_at IS NOT NULL AND deleted_at < $1 LIMIT $2",
		)
		.bind(cutoff)
		.bind(TOMBSTONE_BATCH_SIZE)
		.fetch_all(pool)
		.await?;

        if candidates.is_empty() {
            break;
        }

        let candidate_ids: Vec<String> = candidates
            .iter()
            .map(|candidate| candidate.id.clone())
            .collect();

        let event_rows: Vec<(String, String, String, String, i32, String)> = candidates
            .iter()
            .map(|candidate| {
                (
                    generate_sync_event_id(),
                    candidate.id.clone(),
                    candidate.vault_id.clone(),
                    candidate.last_modified_by.clone(),
                    candidate.version,
                    "{\"reason\":\"tombstone_cleanup\"}".to_string(),
                )
            })
            .collect();

        let mut transaction = begin_sync_event_transaction(pool).await?;

        if !event_rows.is_empty() {
            lock_sync_event_order(&mut transaction).await?;

            let mut ids = Vec::with_capacity(event_rows.len());
            let mut entity_ids = Vec::with_capacity(event_rows.len());
            let mut vault_ids = Vec::with_capacity(event_rows.len());
            let mut user_ids = Vec::with_capacity(event_rows.len());
            let mut versions = Vec::with_capacity(event_rows.len());
            let mut metadatas = Vec::with_capacity(event_rows.len());
            for (id, entity_id, vault_id, user_id, version, metadata) in &event_rows {
                ids.push(id.as_str());
                entity_ids.push(entity_id.as_str());
                vault_ids.push(vault_id.as_str());
                user_ids.push(user_id.as_str());
                versions.push(*version);
                metadatas.push(metadata.as_str());
            }

            query(
				"INSERT INTO sync_event (id, event_type, entity_id, entity_type, vault_id, user_id, version, metadata) SELECT UNNEST($1::text[]), $2::sync_event_type, UNNEST($3::text[]), $4::sync_entity_type, UNNEST($5::text[]), UNNEST($6::text[]), UNNEST($7::int[]), UNNEST($8::text[])",
			)
			.bind(&ids)
			.bind("item_permanently_deleted")
			.bind(&entity_ids)
			.bind("item")
			.bind(&vault_ids)
			.bind(&user_ids)
			.bind(&versions)
			.bind(&metadatas)
			.execute(transaction.as_mut())
			.await?;
        }

        query("DELETE FROM item WHERE id = ANY($1)")
            .bind(&candidate_ids)
            .execute(transaction.as_mut())
            .await?;

        transaction.commit().await?;

        total_deleted += candidate_ids.len() as u64;
        total_events += event_rows.len() as u64;
    }

    if total_deleted > 0 {
        info!(
            deleted = total_deleted,
            events = total_events,
            retention_days = TOMBSTONE_RETENTION_DAYS,
            "tombstone-cleanup completed"
        );
    }

    Ok(total_deleted)
}

fn generate_sync_event_id() -> String {
    let mut bytes = [0_u8; 16];
    rand::rng().fill_bytes(&mut bytes);
    format!("syncevt_{}", hex::encode(bytes))
}

#[cfg(test)]
#[path = "sql_tests.rs"]
mod tests;
