use super::{error::ApiError, error_code::ErrorCode};
use axum::http::HeaderMap;

pub(crate) fn reject_one_time_secret(headers: &HeaderMap) -> Result<(), ApiError> {
    if headers.contains_key("idempotency-key") {
        Err(ApiError::unprocessable(
            ErrorCode::IdempotencyNotAllowed,
            "Idempotency keys are not accepted for operations that return one-time secrets.",
        ))
    } else {
        Ok(())
    }
}
