use crate::error::AppError;

pub(crate) async fn acquire_advisory_lock<'e>(
    executor: impl sqlx::Executor<'e, Database = sqlx::Postgres>,
    key: &str,
    context: &'static str,
) -> Result<(), AppError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(key)
        .execute(executor)
        .await
        .map_err(|error| database_error(error, context))?;
    Ok(())
}

pub(crate) async fn acquire_operation_lock<'e>(
    executor: impl sqlx::Executor<'e, Database = sqlx::Postgres>,
    user_id: &str,
    operation_id: &str,
    context: &'static str,
) -> Result<(), AppError> {
    acquire_advisory_lock(
        executor,
        &format!(
            "operation:{}:{}:{}{}",
            user_id.len(),
            operation_id.len(),
            user_id,
            operation_id
        ),
        context,
    )
    .await
}

/// Serializes every writer of one Item's Attachment set, including Move finalization.
pub(crate) async fn acquire_item_attachment_writer_lock<'e>(
    executor: impl sqlx::Executor<'e, Database = sqlx::Postgres>,
    item_id: &str,
    context: &'static str,
) -> Result<(), AppError> {
    acquire_advisory_lock(
        executor,
        &format!("item-attachment-writer:{}:{}", item_id.len(), item_id),
        context,
    )
    .await
}

/// Serializes writers that can change one Team's membership or Team-Vault authority.
pub(crate) async fn acquire_team_authority_lock<'e>(
    executor: impl sqlx::Executor<'e, Database = sqlx::Postgres>,
    team_id: &str,
    context: &'static str,
) -> Result<(), AppError> {
    acquire_advisory_lock(
        executor,
        &format!("team-authority:{}:{team_id}", team_id.len()),
        context,
    )
    .await
}

/// Locks one User authority row before a transaction acquires Team authority.
pub(crate) async fn acquire_user_authority_lock(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: &str,
    context: &'static str,
) -> Result<(), AppError> {
    sqlx::query_scalar::<_, String>("SELECT id FROM \"user\" WHERE id = $1 FOR UPDATE")
        .bind(user_id)
        .fetch_optional(&mut **transaction)
        .await
        .map_err(|error| database_error(error, context))?;
    Ok(())
}

pub(crate) fn is_retryable_transaction_error(error: &sqlx::Error) -> bool {
    error
        .as_database_error()
        .and_then(|database_error| database_error.code())
        .is_some_and(|code| is_retryable_sqlstate(code.as_ref()))
}

pub(crate) fn database_error(error: sqlx::Error, context: &'static str) -> AppError {
    if is_retryable_transaction_error(&error) {
        tracing::warn!(%error, %context, "Transaction should be retried");
        return AppError::retryable_conflict(
            "A concurrent update interrupted the operation. Retry the request.",
        );
    }
    tracing::error!(%error, %context, "Database operation failed");
    AppError::internal(context)
}

fn is_retryable_sqlstate(code: &str) -> bool {
    matches!(code, "40001" | "40P01")
}

#[cfg(test)]
mod tests {
    use super::is_retryable_sqlstate;

    #[test]
    fn serialization_and_deadlock_failures_are_retryable() {
        assert!(is_retryable_sqlstate("40001"));
        assert!(is_retryable_sqlstate("40P01"));
        assert!(!is_retryable_sqlstate("23505"));
    }
}
