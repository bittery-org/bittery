use crate::error::AppError;

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
