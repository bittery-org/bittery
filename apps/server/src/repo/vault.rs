use sqlx::{query_as, PgPool};

use crate::db::models::{DbBootstrapItemRow, DbBootstrapVaultAccessRow, DbItemVaultAccessRow};
use crate::error::AppError;

pub async fn load_item_row(pool: &PgPool, item_id: &str) -> Result<DbBootstrapItemRow, AppError> {
    query_as::<_, DbBootstrapItemRow>(
		"SELECT id, vault_id, category::text AS category, favorite, encrypted_data, encryption_iv, encryption_algorithm, version, last_modified_by, created_at, updated_at, deleted_at FROM item WHERE id = $1 LIMIT 1",
	)
	.bind(item_id)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load item"); AppError::internal("Failed to load item") })?
	.ok_or_else(|| AppError::not_found("Item not found"))
}

pub async fn load_vault_access(
    pool: &PgPool,
    vault_id: &str,
    user_id: &str,
) -> Result<DbItemVaultAccessRow, AppError> {
    query_as::<_, DbItemVaultAccessRow>(
        "SELECT role::text AS role FROM vault_key WHERE vault_id = $1 AND user_id = $2 LIMIT 1",
    )
    .bind(vault_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to verify vault access");
        AppError::internal("Failed to verify vault access")
    })?
    .ok_or_else(|| AppError::forbidden("Access denied to this vault"))
}

pub async fn load_user_vault_summaries(
    pool: &PgPool,
    user_id: &str,
) -> Result<Vec<DbBootstrapVaultAccessRow>, AppError> {
    query_as::<_, DbBootstrapVaultAccessRow>(
		"SELECT vk.vault_id, v.name AS vault_name, v.type::text AS vault_type, v.icon AS vault_icon, v.image_key AS vault_image_key, vk.encrypted_vault_key, vk.role::text AS role FROM vault_key vk INNER JOIN vault v ON vk.vault_id = v.id WHERE vk.user_id = $1 ORDER BY vk.created_at ASC",
	)
	.bind(user_id)
	.fetch_all(pool)
	.await
	.map_err(|_| AppError::internal("Failed to load user vaults"))
}
