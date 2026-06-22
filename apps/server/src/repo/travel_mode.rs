use sqlx::{query_as, PgPool};
use time::OffsetDateTime;

use crate::{db::models::*, error::AppError};

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct DbUserTravelModeRow {
    pub user_id: String,
    pub enabled: bool,
    pub hidden_vault_ids: Vec<String>,
    pub enabled_at: Option<OffsetDateTime>,
    pub updated_at: OffsetDateTime,
}

pub async fn fetch_user_travel_mode(
    pool: &PgPool,
    user_id: &str,
) -> Result<Option<DbUserTravelModeRow>, AppError> {
    query_as::<_, DbUserTravelModeRow>(
        "SELECT user_id, enabled, hidden_vault_ids, enabled_at, updated_at FROM user_travel_mode WHERE user_id = $1 LIMIT 1",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to load travel mode config");
        AppError::internal("Failed to load travel mode config")
    })
}

pub async fn upsert_user_travel_mode(
    pool: &PgPool,
    user_id: &str,
    enabled: bool,
    hidden_vault_ids: &[String],
    enabled_at: Option<OffsetDateTime>,
) -> Result<DbUserTravelModeRow, AppError> {
    let now = OffsetDateTime::now_utc();
    query_as::<_, DbUserTravelModeRow>(
        "INSERT INTO user_travel_mode (user_id, enabled, hidden_vault_ids, enabled_at, updated_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (user_id) DO UPDATE SET enabled = EXCLUDED.enabled, hidden_vault_ids = EXCLUDED.hidden_vault_ids, enabled_at = EXCLUDED.enabled_at, updated_at = EXCLUDED.updated_at RETURNING user_id, enabled, hidden_vault_ids, enabled_at, updated_at",
    )
    .bind(user_id)
    .bind(enabled)
    .bind(hidden_vault_ids)
    .bind(enabled_at)
    .bind(now)
    .fetch_one(pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to save travel mode config");
        AppError::internal("Failed to save travel mode config")
    })
}

pub async fn fetch_accessible_vault_ids_for_user(
    pool: &PgPool,
    user_id: &str,
) -> Result<Vec<String>, AppError> {
    let rows = query_as::<_, DbVaultAccessRow>("SELECT vault_id FROM vault_key WHERE user_id = $1")
        .bind(user_id)
        .fetch_all(pool)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to load accessible vault ids");
            AppError::internal("Failed to load accessible vault ids")
        })?;

    Ok(rows.into_iter().map(|row| row.vault_id).collect())
}

pub async fn validate_vault_access(
    pool: &PgPool,
    user_id: &str,
    vault_ids: &[String],
) -> Result<(), AppError> {
    if vault_ids.is_empty() {
        return Ok(());
    }

    let accessible = fetch_accessible_vault_ids_for_user(pool, user_id).await?;
    let accessible_set: std::collections::HashSet<_> = accessible.into_iter().collect();

    for vault_id in vault_ids {
        if !accessible_set.contains(vault_id) {
            return Err(AppError::bad_request(
                "One or more vaults are not accessible",
            ));
        }
    }

    Ok(())
}
