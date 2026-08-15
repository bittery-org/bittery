use sqlx::{query_as, FromRow, PgPool};

use crate::{db::models::*, error::AppError};

const BOOTSTRAP_QUERY_BYTES: i64 = 4 * 1024 * 1024 - 16 * 1024;

// Deleting a vault nulls sync_event.vault_id, so its owner-targeted tombstone stays user-scoped.
// Access revocations are already user-scoped for the same reason.

pub struct BoundedBootstrapRows {
    pub rows: Vec<DbBootstrapItemRow>,
    pub has_more: bool,
}

pub struct BoundedSyncEventRows {
    pub rows: Vec<DbSyncEventRow>,
    pub has_more: bool,
}

#[derive(FromRow)]
struct BootstrapPageWeight {
    id: String,
    position: i64,
    candidate_count: i64,
    cumulative_bytes: i64,
}

#[derive(FromRow)]
struct SyncEventPageWeight {
    id: String,
    position: i64,
    candidate_count: i64,
    cumulative_bytes: i64,
}

pub async fn fetch_user_vault_ids(pool: &PgPool, user_id: &str) -> Result<Vec<String>, AppError> {
    let user_vaults =
        query_as::<_, DbVaultAccessRow>("SELECT vault_id FROM vault_key WHERE user_id = $1")
            .bind(user_id)
            .fetch_all(pool)
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "Failed to load vault access");
                AppError::internal("Failed to load vault access")
            })?;

    Ok(user_vaults
        .into_iter()
        .map(|record| record.vault_id)
        .collect())
}

pub async fn fetch_visible_cursor_event(
    pool: &PgPool,
    user_id: &str,
    target_vault_ids: &[String],
    since_id: &str,
) -> Result<Option<DbSyncEventCursorRow>, AppError> {
    if target_vault_ids.is_empty() {
        return query_as::<_, DbSyncEventCursorRow>(
			"SELECT id, seq FROM sync_event WHERE id = $1 AND user_id = $2 AND event_type IN ('vault_deleted'::sync_event_type, 'vault_access_revoked'::sync_event_type, 'travel_mode_updated'::sync_event_type) LIMIT 1",
		)
		.bind(since_id)
		.bind(user_id)
		.fetch_optional(pool)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to load sync cursor event"); AppError::internal("Failed to load sync cursor event") });
    }

    query_as::<_, DbSyncEventCursorRow>(
		"SELECT id, seq FROM sync_event WHERE id = $1 AND ((vault_id = ANY($2) AND event_type NOT IN ('vault_deleted'::sync_event_type, 'vault_access_revoked'::sync_event_type, 'travel_mode_updated'::sync_event_type)) OR (user_id = $3 AND event_type IN ('vault_deleted'::sync_event_type, 'vault_access_revoked'::sync_event_type, 'travel_mode_updated'::sync_event_type))) LIMIT 1",
	)
	.bind(since_id)
	.bind(target_vault_ids)
	.bind(user_id)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load sync cursor event"); AppError::internal("Failed to load sync cursor event") })
}

pub async fn fetch_latest_visible_event_id(
    pool: &PgPool,
    user_id: &str,
    target_vault_ids: &[String],
) -> Result<Option<String>, AppError> {
    if target_vault_ids.is_empty() {
        return query_as::<_, DbSyncEventIdRow>(
			"SELECT id FROM sync_event WHERE user_id = $1 AND event_type IN ('vault_deleted'::sync_event_type, 'vault_access_revoked'::sync_event_type, 'travel_mode_updated'::sync_event_type) ORDER BY seq DESC LIMIT 1",
		)
		.bind(user_id)
		.fetch_optional(pool)
		.await
		.map(|row| row.map(|row| row.id))
		.map_err(|e| { tracing::error!(error = %e, "Failed to load latest visible event"); AppError::internal("Failed to load latest visible event") });
    }

    query_as::<_, DbSyncEventIdRow>(
		"SELECT id FROM sync_event WHERE (vault_id = ANY($1) AND event_type NOT IN ('vault_deleted'::sync_event_type, 'vault_access_revoked'::sync_event_type, 'travel_mode_updated'::sync_event_type)) OR (user_id = $2 AND event_type IN ('vault_deleted'::sync_event_type, 'vault_access_revoked'::sync_event_type, 'travel_mode_updated'::sync_event_type)) ORDER BY seq DESC LIMIT 1",
	)
	.bind(target_vault_ids)
	.bind(user_id)
	.fetch_optional(pool)
	.await
	.map(|row| row.map(|row| row.id))
	.map_err(|e| { tracing::error!(error = %e, "Failed to load latest visible event"); AppError::internal("Failed to load latest visible event") })
}

pub async fn fetch_visible_events_since(
    pool: &PgPool,
    user_id: &str,
    target_vault_ids: &[String],
    cursor_seq: i64,
    limit: i32,
) -> Result<BoundedSyncEventRows, AppError> {
    let weights = if target_vault_ids.is_empty() {
        query_as::<_, SyncEventPageWeight>(
            r#"WITH candidates AS (
                SELECT id, ROW_NUMBER() OVER (ORDER BY seq ASC)::bigint AS position,
                       (4096 + octet_length(id) + octet_length(event_type::text)
                        + octet_length(entity_id) + octet_length(entity_type::text)
                        + coalesce(octet_length(vault_id), 0) + coalesce(octet_length(client_id), 0)
                        + octet_length(user_id) + coalesce(octet_length(metadata), 0))::bigint AS estimated_bytes
                FROM sync_event
                WHERE user_id = $1
                  AND event_type IN ('vault_deleted'::sync_event_type, 'vault_access_revoked'::sync_event_type,
                    'travel_mode_updated'::sync_event_type)
                  AND seq > $2 ORDER BY seq ASC LIMIT $3
            ), weighted AS (
                SELECT id, position, count(*) OVER ()::bigint AS candidate_count,
                       sum(estimated_bytes) OVER (ORDER BY position)::bigint AS cumulative_bytes
                FROM candidates
            )
            SELECT id, position, candidate_count, cumulative_bytes FROM weighted
            WHERE cumulative_bytes <= $4 OR position = 1 ORDER BY position"#,
        )
        .bind(user_id)
        .bind(cursor_seq)
        .bind(limit + 1)
        .bind(BOOTSTRAP_QUERY_BYTES)
        .fetch_all(pool)
        .await
    } else {
        query_as::<_, SyncEventPageWeight>(
            r#"WITH candidates AS (
                SELECT id, ROW_NUMBER() OVER (ORDER BY seq ASC)::bigint AS position,
                       (4096 + octet_length(id) + octet_length(event_type::text)
                        + octet_length(entity_id) + octet_length(entity_type::text)
                        + coalesce(octet_length(vault_id), 0) + coalesce(octet_length(client_id), 0)
                        + octet_length(user_id) + coalesce(octet_length(metadata), 0))::bigint AS estimated_bytes
                FROM sync_event
                WHERE ((vault_id = ANY($1) AND event_type NOT IN
                  ('vault_deleted'::sync_event_type, 'vault_access_revoked'::sync_event_type,
                    'travel_mode_updated'::sync_event_type)) OR (user_id = $2 AND event_type IN
                  ('vault_deleted'::sync_event_type, 'vault_access_revoked'::sync_event_type,
                    'travel_mode_updated'::sync_event_type)))
                  AND seq > $3 ORDER BY seq ASC LIMIT $4
            ), weighted AS (
                SELECT id, position, count(*) OVER ()::bigint AS candidate_count,
                       sum(estimated_bytes) OVER (ORDER BY position)::bigint AS cumulative_bytes
                FROM candidates
            )
            SELECT id, position, candidate_count, cumulative_bytes FROM weighted
            WHERE cumulative_bytes <= $5 OR position = 1 ORDER BY position"#,
        )
        .bind(target_vault_ids)
        .bind(user_id)
        .bind(cursor_seq)
        .bind(limit + 1)
        .bind(BOOTSTRAP_QUERY_BYTES)
        .fetch_all(pool)
        .await
    }
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to size sync event page");
        AppError::internal("Failed to load sync events")
    })?;

    let Some(first) = weights.first() else {
        return Ok(BoundedSyncEventRows {
            rows: Vec::new(),
            has_more: false,
        });
    };
    if first.cumulative_bytes > BOOTSTRAP_QUERY_BYTES {
        return Err(AppError::payload_too_large(
            "A single sync event exceeds the response page byte budget.",
        ));
    }
    let has_more = weights
        .last()
        .is_some_and(|last| last.position < last.candidate_count);
    let event_ids: Vec<String> = weights.into_iter().map(|weight| weight.id).collect();
    let rows = query_as::<_, DbSyncEventRow>(
        "SELECT id, seq, event_type::text AS event_type, entity_id, entity_type::text AS entity_type, vault_id, version, client_id, user_id, metadata, created_at FROM sync_event WHERE id = ANY($1) ORDER BY array_position($1::text[], id)",
    )
    .bind(&event_ids)
    .fetch_all(pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to materialize bounded sync event page");
        AppError::internal("Failed to load sync events")
    })?;
    Ok(BoundedSyncEventRows { rows, has_more })
}

pub async fn fetch_bootstrap_items(
    pool: &PgPool,
    user_id: &str,
    cursor: Option<&str>,
    limit: i32,
) -> Result<BoundedBootstrapRows, AppError> {
    let weights = query_as::<_, BootstrapPageWeight>(
        r#"WITH candidates AS (
            SELECT i.id, ROW_NUMBER() OVER (ORDER BY i.id ASC)::bigint AS position,
                   (20480 + octet_length(i.id) + octet_length(i.vault_id) + octet_length(i.category::text)
                    + octet_length(i.encrypted_data) + octet_length(i.encryption_iv)
                    + octet_length(i.encryption_algorithm) + octet_length(i.last_modified_by)
                    + coalesce((SELECT sum(1024 + octet_length(a.id) + octet_length(a.item_id)
                        + octet_length(a.vault_id) + octet_length(a.storage_key) + octet_length(a.encrypted_name)
                        + octet_length(a.encrypted_content_type) + octet_length(a.encryption_iv)
                        + coalesce(octet_length(a.encrypted_content_type_iv), 0)
                        + octet_length(a.encryption_algorithm) + coalesce(octet_length(a.uploaded_by), 0))
                      FROM item_attachment a WHERE a.item_id = i.id), 0)
                    + coalesce((SELECT octet_length(v.name) + octet_length(v.type::text)
                        + coalesce(octet_length(v.icon), 0) + coalesce(octet_length(v.image_key), 0)
                        + octet_length(vk.encrypted_vault_key) + octet_length(vk.role::text)
                      FROM vault v JOIN vault_key vk ON vk.vault_id = v.id
                      WHERE v.id = i.vault_id AND vk.user_id = $1 LIMIT 1), 4096))::bigint AS estimated_bytes
            FROM item i
            WHERE EXISTS (SELECT 1 FROM vault_key access WHERE access.vault_id = i.vault_id AND access.user_id = $1)
              AND ($2::text IS NULL OR i.id > $2)
            ORDER BY i.id ASC LIMIT $3
        ), weighted AS (
            SELECT id, position, count(*) OVER ()::bigint AS candidate_count,
                   sum(estimated_bytes) OVER (ORDER BY position)::bigint AS cumulative_bytes
            FROM candidates
        )
        SELECT id, position, candidate_count, cumulative_bytes FROM weighted
        WHERE cumulative_bytes <= $4 OR position = 1 ORDER BY position"#,
    )
    .bind(user_id)
    .bind(cursor)
    .bind(limit + 1)
    .bind(BOOTSTRAP_QUERY_BYTES)
    .fetch_all(pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to size bootstrap item page");
        AppError::internal("Failed to load bootstrap items")
    })?;
    let Some(first) = weights.first() else {
        return Ok(BoundedBootstrapRows {
            rows: Vec::new(),
            has_more: false,
        });
    };
    if first.cumulative_bytes > BOOTSTRAP_QUERY_BYTES {
        return Err(AppError::payload_too_large(
            "A single bootstrap item exceeds the response page byte budget.",
        ));
    }
    let has_more = weights
        .last()
        .is_some_and(|last| last.position < last.candidate_count);
    let item_ids: Vec<String> = weights.into_iter().map(|weight| weight.id).collect();
    let rows = query_as::<_, DbBootstrapItemRow>(&format!(
        "SELECT {BOOTSTRAP_ITEM_COLUMNS} FROM item WHERE id = ANY($1) ORDER BY array_position($1::text[], id)"
    ))
    .bind(&item_ids)
    .fetch_all(pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to materialize bounded bootstrap item page");
        AppError::internal("Failed to load bootstrap items")
    })?;
    Ok(BoundedBootstrapRows { rows, has_more })
}

pub async fn load_bootstrap_attachment_rows(
    pool: &PgPool,
    item_ids: &[String],
) -> Result<Vec<DbBootstrapAttachmentRow>, AppError> {
    query_as::<_, DbBootstrapAttachmentRow>(
		"SELECT id, item_id, vault_id, storage_key, encrypted_attachment_key, attachment_key_iv, attachment_key_algorithm, envelope_version, encrypted_name, encrypted_content_type, encryption_iv, encrypted_content_type_iv, encryption_algorithm, file_size, uploaded_by, created_at FROM item_attachment WHERE item_id = ANY($1) ORDER BY created_at ASC",
	)
	.bind(item_ids)
	.fetch_all(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load bootstrap attachments"); AppError::internal("Failed to load bootstrap attachments") })
}
