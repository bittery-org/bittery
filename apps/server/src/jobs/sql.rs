use std::collections::HashMap;

use rand::RngCore;
use sqlx::{query, query_as, query_scalar, PgPool};
use time::{Duration, OffsetDateTime};
use tracing::{error, info};

use crate::{
    db::models::{DbPendingAttachmentUploadRow, DbTombstoneCandidate, DbVaultOwnerRow},
    integrations::storage,
};

const EXPIRED_SESSION_BATCH_SIZE: i64 = 1000;
const PENDING_ATTACHMENT_UPLOAD_BATCH_SIZE: i64 = 100;
const SYNC_EVENT_RETENTION_DAYS: i64 = 30;
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

pub async fn cleanup_pending_attachment_uploads(
    pool: &PgPool,
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
            if let Err(error) = storage::delete_object(&reservation.storage_key).await {
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

        let fallback_vault_ids: Vec<String> = candidates
            .iter()
            .filter(|candidate| candidate.last_modified_by.is_none())
            .map(|candidate| candidate.vault_id.clone())
            .collect();

        let fallback_users = if fallback_vault_ids.is_empty() {
            Vec::new()
        } else {
            query_as::<_, DbVaultOwnerRow>("SELECT id, created_by_id FROM vault WHERE id = ANY($1)")
                .bind(&fallback_vault_ids)
                .fetch_all(pool)
                .await?
        };

        let fallback_user_by_vault_id = HashMap::<String, String>::from_iter(
            fallback_users
                .into_iter()
                .map(|entry| (entry.id, entry.created_by_id)),
        );

        let candidate_ids: Vec<String> = candidates
            .iter()
            .map(|candidate| candidate.id.clone())
            .collect();

        let event_rows: Vec<(String, String, String, String, i32, String)> = candidates
            .iter()
            .filter_map(|candidate| {
                let event_user_id = candidate
                    .last_modified_by
                    .clone()
                    .or_else(|| fallback_user_by_vault_id.get(&candidate.vault_id).cloned())?;

                Some((
                    generate_sync_event_id(),
                    candidate.id.clone(),
                    candidate.vault_id.clone(),
                    event_user_id,
                    candidate.version.unwrap_or(1),
                    "{\"reason\":\"tombstone_cleanup\"}".to_string(),
                ))
            })
            .collect();

        let mut transaction = pool.begin().await?;

        if !event_rows.is_empty() {
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
    rand::thread_rng().fill_bytes(&mut bytes);
    format!("syncevt_{}", hex::encode(bytes))
}
