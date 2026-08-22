use sqlx::{query_as, Postgres};

use crate::{
    db::events::insert_sync_event,
    db::{
        enums::{SyncEntityType, SyncEventType, VaultRole},
        models::{DbBootstrapItemRow, BOOTSTRAP_ITEM_COLUMNS},
    },
    error::AppError,
    shared::transaction::database_error,
};

#[derive(Debug, sqlx::FromRow)]
pub(super) struct VaultAccess {
    pub(super) role: VaultRole,
}

pub(super) async fn load_vault_access<'e>(
    executor: impl sqlx::Executor<'e, Database = Postgres>,
    vault_id: &str,
    user_id: &str,
) -> Result<VaultAccess, AppError> {
    query_vault_access(executor, vault_id, user_id)
        .await
        .map_err(|error| database_error(error, "Failed to verify vault access"))?
        .ok_or_else(|| AppError::forbidden("Access denied to this vault"))
}

pub(super) async fn find_vault_access<'e>(
    executor: impl sqlx::Executor<'e, Database = Postgres>,
    vault_id: &str,
    user_id: &str,
) -> Result<Option<VaultAccess>, AppError> {
    query_vault_access(executor, vault_id, user_id)
        .await
        .map_err(|error| database_error(error, "Failed to verify vault access"))
}

pub(super) async fn assert_item_read_access<'e>(
    executor: impl sqlx::Executor<'e, Database = Postgres>,
    vault_id: &str,
    user_id: &str,
) -> Result<(), AppError> {
    query_vault_access(executor, vault_id, user_id)
        .await
        .map_err(|error| database_error(error, "Failed to verify item access"))?
        .map(|_| ())
        .ok_or_else(|| AppError::forbidden("Access denied"))
}

async fn query_vault_access<'e>(
    executor: impl sqlx::Executor<'e, Database = Postgres>,
    vault_id: &str,
    user_id: &str,
) -> Result<Option<VaultAccess>, sqlx::Error> {
    query_as::<_, VaultAccess>(
        "SELECT role::text AS role FROM vault_key WHERE vault_id = $1 AND user_id = $2 LIMIT 1",
    )
    .bind(vault_id)
    .bind(user_id)
    .fetch_optional(executor)
    .await
}

pub(super) fn assert_item_write_access(role: VaultRole, message: &str) -> Result<(), AppError> {
    if role.can_write() {
        Ok(())
    } else {
        Err(AppError::forbidden(message))
    }
}

pub(super) async fn load_item_row<'e>(
    executor: impl sqlx::Executor<'e, Database = Postgres>,
    item_id: &str,
) -> Result<DbBootstrapItemRow, AppError> {
    query_as::<_, DbBootstrapItemRow>(&format!(
        "SELECT {BOOTSTRAP_ITEM_COLUMNS} FROM item WHERE id = $1 LIMIT 1"
    ))
    .bind(item_id)
    .fetch_optional(executor)
    .await
    .map_err(|error| database_error(error, "Failed to load item"))?
    .ok_or_else(|| AppError::not_found("Item not found"))
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn insert_item_sync_event<'e>(
    executor: impl sqlx::Executor<'e, Database = Postgres>,
    event_type: SyncEventType,
    item_id: &str,
    vault_id: &str,
    user_id: &str,
    client_id: Option<&str>,
    version: i32,
) -> Result<(), AppError> {
    insert_sync_event(
        executor,
        event_type,
        item_id,
        SyncEntityType::Item,
        vault_id,
        user_id,
        version,
        client_id,
        None,
    )
    .await
}
