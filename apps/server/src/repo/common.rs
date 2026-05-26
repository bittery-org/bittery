use rand::random;
use serde_json::Value;
use sqlx::{query, query_as, PgPool, Postgres};
use time::OffsetDateTime;

use crate::{db::models::DbScopedItemAccessRow, error::AppError};

/// Generate a prefixed random ID (e.g. `audit_0a1b2c3d4e5f6789`).
pub fn generate_resource_id(prefix: &str) -> String {
    format!("{prefix}_{:016x}", random::<u64>())
}

/// Insert an audit log entry.
///
/// The `metadata` field is optional — when `None`, the column is omitted from the insert.
pub async fn insert_audit_event<'e>(
    executor: impl sqlx::Executor<'e, Database = Postgres>,
    id: &str,
    user_id: &str,
    action: &str,
    entity_type: &str,
    entity_id: &str,
    metadata: Option<Value>,
) -> Result<(), AppError> {
    match metadata {
        Some(metadata) => {
            query(
                "INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, metadata, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
            )
            .bind(id)
            .bind(user_id)
            .bind(action)
            .bind(entity_type)
            .bind(entity_id)
            .bind(metadata)
            .bind(OffsetDateTime::now_utc())
            .execute(executor)
            .await
        }
        None => {
            query(
                "INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
            )
            .bind(id)
            .bind(user_id)
            .bind(action)
            .bind(entity_type)
            .bind(entity_id)
            .bind(OffsetDateTime::now_utc())
            .execute(executor)
            .await
        }
    }
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to record audit event");
        AppError::internal("Failed to record audit event")
    })?;
    Ok(())
}

/// Insert a sync event.
///
/// The `metadata` field is optional — when `None`, the column is omitted from the insert.
pub async fn insert_sync_event<'e>(
    executor: impl sqlx::Executor<'e, Database = Postgres>,
    event_type: &str,
    entity_id: &str,
    entity_type: &str,
    vault_id: &str,
    user_id: &str,
    version: i32,
    client_id: Option<&str>,
    metadata: Option<&str>,
) -> Result<(), AppError> {
    let id = generate_resource_id("sync");
    match metadata {
        Some(metadata) => {
            query(
                "INSERT INTO sync_event (id, event_type, entity_id, entity_type, vault_id, user_id, version, client_id, metadata, created_at) VALUES ($1, $2::sync_event_type, $3, $4::sync_entity_type, $5, $6, $7, $8, $9, $10)",
            )
            .bind(&id)
            .bind(event_type)
            .bind(entity_id)
            .bind(entity_type)
            .bind(vault_id)
            .bind(user_id)
            .bind(version)
            .bind(client_id)
            .bind(metadata)
            .bind(OffsetDateTime::now_utc())
            .execute(executor)
            .await
        }
        None => {
            query(
                "INSERT INTO sync_event (id, event_type, entity_id, entity_type, vault_id, user_id, version, client_id, created_at) VALUES ($1, $2::sync_event_type, $3, $4::sync_entity_type, $5, $6, $7, $8, $9)",
            )
            .bind(&id)
            .bind(event_type)
            .bind(entity_id)
            .bind(entity_type)
            .bind(vault_id)
            .bind(user_id)
            .bind(version)
            .bind(client_id)
            .bind(OffsetDateTime::now_utc())
            .execute(executor)
            .await
        }
    }
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to create sync event");
        AppError::internal("Failed to create sync event")
    })?;
    Ok(())
}

/// Load a user's scoped access to a vault item (returns the item's vault_id and the user's role).
pub async fn load_scoped_item_access(
    pool: &PgPool,
    actor_user_id: &str,
    item_id: &str,
) -> Result<Option<DbScopedItemAccessRow>, AppError> {
    query_as::<_, DbScopedItemAccessRow>(
        "SELECT i.id AS item_id, i.vault_id, vk.role::text AS role FROM item i INNER JOIN vault_key vk ON vk.vault_id = i.vault_id AND vk.user_id = $1 WHERE i.id = $2 LIMIT 1",
    )
    .bind(actor_user_id)
    .bind(item_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to load scoped item access");
        AppError::internal("Failed to load scoped item access")
    })
}
