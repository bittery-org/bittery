//! Published-image deletion duties share the existing Vault-image cleanup runner.
//! The exact object lock serializes catalog adoption, staging and physical deletion.
use crate::{
    error::AppError,
    integrations::storage::ObjectStorage,
    shared::transaction::{acquire_advisory_lock, database_error},
};
use sqlx::{query, query_scalar, PgPool, Postgres, Transaction};

pub(crate) async fn lock_objects(
    transaction: &mut Transaction<'_, Postgres>,
    keys: &[&str],
) -> Result<(), AppError> {
    let mut keys = keys.to_vec();
    keys.sort_unstable();
    keys.dedup();
    for key in keys {
        acquire_advisory_lock(
            &mut **transaction,
            &format!("vault-image-object:{}:{key}", key.len()),
            "Failed to lock Vault image object",
        )
        .await?;
    }
    Ok(())
}

/// Called after current User/Team/Vault authority is locked. All keys are acquired in one order.
pub(super) async fn prepare_change(
    transaction: &mut Transaction<'_, Postgres>,
    old: Option<&str>,
    new: Option<&str>,
) -> Result<(), AppError> {
    let keys = old.into_iter().chain(new).collect::<Vec<_>>();
    lock_objects(transaction, &keys).await?;
    if old != new {
        if let Some(old) = old {
            query("INSERT INTO vault_image_cleanup(object_key) VALUES($1) ON CONFLICT(object_key) DO NOTHING")
                .bind(old).execute(&mut **transaction).await.map_err(|error|database_error(error,"Failed to retain obsolete Vault image cleanup"))?;
        }
    }
    if let Some(new) = new {
        query("DELETE FROM vault_image_cleanup WHERE object_key=$1")
            .bind(new)
            .execute(&mut **transaction)
            .await
            .map_err(|error| {
                database_error(error, "Failed to retire re-adopted Vault image cleanup")
            })?;
    }
    Ok(())
}

pub(crate) async fn is_referenced(
    transaction: &mut Transaction<'_, Postgres>,
    key: &str,
) -> Result<bool, AppError> {
    query_scalar("SELECT EXISTS(SELECT 1 FROM vault WHERE image_key=$1)")
        .bind(key)
        .fetch_one(&mut **transaction)
        .await
        .map_err(|error| database_error(error, "Failed to inspect current Vault image references"))
}

/// An immediate post-commit attempt and the scheduled runner use this same durable duty.
/// Failure leaves the row for retry. Re-adoption cancels only the obsolete deletion, not the object.
pub(crate) async fn cleanup_key(
    pool: &PgPool,
    storage: &dyn ObjectStorage,
    key: &str,
) -> Result<u64, AppError> {
    let mut transaction = pool
        .begin()
        .await
        .map_err(|error| database_error(error, "Failed to begin Vault image cleanup"))?;
    lock_objects(&mut transaction, &[key]).await?;
    let pending = query_scalar::<_, String>(
        "SELECT object_key FROM vault_image_cleanup WHERE object_key=$1 FOR UPDATE",
    )
    .bind(key)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|error| database_error(error, "Failed to inspect Vault image cleanup"))?;
    if pending.is_none() {
        return Ok(0);
    }
    let referenced = is_referenced(&mut transaction, key).await?;
    if !referenced {
        let staged = query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM vault_image_staging WHERE object_key=$1)",
        )
        .bind(key)
        .fetch_one(&mut *transaction)
        .await
        .map_err(|error| database_error(error, "Failed to inspect staged Vault image ownership"))?;
        if staged {
            return Ok(0);
        }
        storage.delete(key).await.map_err(|_| {
            AppError::internal("Vault image deletion failed; cleanup remains pending")
        })?;
    }
    let result = query("DELETE FROM vault_image_cleanup WHERE object_key=$1")
        .bind(key)
        .execute(&mut *transaction)
        .await
        .map_err(|error| database_error(error, "Failed to finish Vault image cleanup"))?;
    transaction
        .commit()
        .await
        .map_err(|error| database_error(error, "Failed to commit Vault image cleanup"))?;
    Ok(if referenced {
        0
    } else {
        result.rows_affected()
    })
}

pub(crate) async fn cleanup_pending(
    pool: &PgPool,
    storage: &dyn ObjectStorage,
) -> Result<u64, AppError> {
    let candidates = query_scalar::<_, String>(
        "SELECT object_key FROM vault_image_cleanup ORDER BY last_attempted_at,created_at,object_key LIMIT 100",
    )
    .fetch_all(pool)
    .await
    .map_err(|error| database_error(error, "Failed to select Vault image cleanup"))?;
    let mut deleted = 0;
    for key in candidates {
        match cleanup_key(pool, storage, &key).await {
            Ok(count) => deleted += count,
            Err(_) => {
                tracing::warn!("Vault image deletion remains pending for the next cleanup pass")
            }
        }
        // This is intentionally outside the failed/deferred deletion transaction. A full batch of
        // failed objects must yield to later duties without losing any physical cleanup evidence.
        query("UPDATE vault_image_cleanup SET last_attempted_at=NOW() WHERE object_key=$1")
            .bind(&key)
            .execute(pool)
            .await
            .map_err(|error| {
                database_error(error, "Failed to rotate Vault image cleanup attempts")
            })?;
    }
    Ok(deleted)
}
