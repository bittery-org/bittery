use sqlx::{query_as, PgPool};

use crate::{
    db::models::*,
    error::AppError,
};

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
			"SELECT id, seq FROM sync_event WHERE id = $1 AND user_id = $2 AND event_type = 'vault_access_revoked'::sync_event_type LIMIT 1",
		)
		.bind(since_id)
		.bind(user_id)
		.fetch_optional(pool)
		.await
		.map_err(|_| AppError::internal("Failed to load sync cursor event"));
    }

    query_as::<_, DbSyncEventCursorRow>(
		"SELECT id, seq FROM sync_event WHERE id = $1 AND (vault_id = ANY($2) OR (user_id = $3 AND event_type = 'vault_access_revoked'::sync_event_type)) LIMIT 1",
	)
	.bind(since_id)
	.bind(target_vault_ids)
	.bind(user_id)
	.fetch_optional(pool)
	.await
	.map_err(|_| AppError::internal("Failed to load sync cursor event"))
}

pub async fn fetch_latest_visible_event_id(
    pool: &PgPool,
    user_id: &str,
    target_vault_ids: &[String],
) -> Result<Option<String>, AppError> {
    if target_vault_ids.is_empty() {
        return query_as::<_, DbSyncEventIdRow>(
			"SELECT id FROM sync_event WHERE user_id = $1 AND event_type = 'vault_access_revoked'::sync_event_type ORDER BY seq DESC LIMIT 1",
		)
		.bind(user_id)
		.fetch_optional(pool)
		.await
		.map(|row| row.map(|row| row.id))
		.map_err(|_| AppError::internal("Failed to load latest visible event"));
    }

    query_as::<_, DbSyncEventIdRow>(
		"SELECT id FROM sync_event WHERE vault_id = ANY($1) OR (user_id = $2 AND event_type = 'vault_access_revoked'::sync_event_type) ORDER BY seq DESC LIMIT 1",
	)
	.bind(target_vault_ids)
	.bind(user_id)
	.fetch_optional(pool)
	.await
	.map(|row| row.map(|row| row.id))
	.map_err(|_| AppError::internal("Failed to load latest visible event"))
}

pub async fn fetch_latest_visible_event_seq(
    pool: &PgPool,
    user_id: &str,
    target_vault_ids: &[String],
) -> Result<i64, AppError> {
    let Some(latest_event_id) =
        fetch_latest_visible_event_id(pool, user_id, target_vault_ids).await?
    else {
        return Ok(0);
    };
    let Some(cursor_event) =
        fetch_visible_cursor_event(pool, user_id, target_vault_ids, &latest_event_id).await?
    else {
        return Ok(0);
    };

    Ok(cursor_event.seq)
}

pub async fn fetch_visible_events_since(
    pool: &PgPool,
    user_id: &str,
    target_vault_ids: &[String],
    cursor_seq: i64,
    limit: i32,
) -> Result<Vec<DbSyncEventRow>, AppError> {
    if target_vault_ids.is_empty() {
        return query_as::<_, DbSyncEventRow>(
			"SELECT id, seq, event_type::text AS event_type, entity_id, entity_type::text AS entity_type, vault_id, version, client_id, user_id, metadata, created_at FROM sync_event WHERE user_id = $1 AND event_type = 'vault_access_revoked'::sync_event_type AND seq > $2 ORDER BY seq ASC LIMIT $3",
		)
		.bind(user_id)
		.bind(cursor_seq)
		.bind(limit + 1)
		.fetch_all(pool)
		.await
		.map_err(|_| AppError::internal("Failed to load sync events"));
    }

    query_as::<_, DbSyncEventRow>(
		"SELECT id, seq, event_type::text AS event_type, entity_id, entity_type::text AS entity_type, vault_id, version, client_id, user_id, metadata, created_at FROM sync_event WHERE (vault_id = ANY($1) OR (user_id = $2 AND event_type = 'vault_access_revoked'::sync_event_type)) AND seq > $3 ORDER BY seq ASC LIMIT $4",
	)
	.bind(target_vault_ids)
	.bind(user_id)
	.bind(cursor_seq)
	.bind(limit + 1)
	.fetch_all(pool)
	.await
	.map_err(|_| AppError::internal("Failed to load sync events"))
}

pub async fn fetch_bootstrap_items(
    pool: &PgPool,
    vault_ids: &[String],
    cursor: Option<&str>,
    limit: i32,
) -> Result<Vec<DbBootstrapItemRow>, AppError> {
    match cursor {
		Some(cursor) => query_as::<_, DbBootstrapItemRow>(
			"SELECT id, vault_id, category::text AS category, favorite, encrypted_data, encryption_iv, encryption_algorithm, version, last_modified_by, created_at, updated_at, deleted_at FROM item WHERE vault_id = ANY($1) AND id > $2 ORDER BY id ASC LIMIT $3",
		)
		.bind(vault_ids)
		.bind(cursor)
		.bind(limit + 1)
		.fetch_all(pool)
		.await
		.map_err(|_| AppError::internal("Failed to load bootstrap items")),
		None => query_as::<_, DbBootstrapItemRow>(
			"SELECT id, vault_id, category::text AS category, favorite, encrypted_data, encryption_iv, encryption_algorithm, version, last_modified_by, created_at, updated_at, deleted_at FROM item WHERE vault_id = ANY($1) ORDER BY id ASC LIMIT $2",
		)
		.bind(vault_ids)
		.bind(limit + 1)
		.fetch_all(pool)
		.await
		.map_err(|_| AppError::internal("Failed to load bootstrap items")),
	}
}

pub async fn load_bootstrap_attachment_rows(
    pool: &PgPool,
    item_ids: &[String],
) -> Result<Vec<DbBootstrapAttachmentRow>, AppError> {
    query_as::<_, DbBootstrapAttachmentRow>(
		"SELECT id, item_id, vault_id, storage_key, encrypted_name, encrypted_content_type, encryption_iv, encrypted_content_type_iv, encryption_algorithm, file_size, uploaded_by, created_at FROM item_attachment WHERE item_id = ANY($1) ORDER BY created_at ASC",
	)
	.bind(item_ids)
	.fetch_all(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load bootstrap attachments"); AppError::internal("Failed to load bootstrap attachments") })
}
