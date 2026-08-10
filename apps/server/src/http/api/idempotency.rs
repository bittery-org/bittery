use std::future::Future;

use axum::{
    body::{to_bytes, Body},
    http::{header::CONTENT_TYPE, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use sha2::{Digest, Sha256};
use sqlx::PgPool;

use crate::services::idempotency::{self, Claim, RequestScope, StoredResponse};

use super::error::ApiError;

const IDEMPOTENCY_KEY: &str = "idempotency-key";
const IDEMPOTENCY_REPLAYED: &str = "idempotency-replayed";

pub(crate) async fn execute<F, Fut>(
    pool: &PgPool,
    headers: &HeaderMap,
    principal_id: &str,
    method: &str,
    route_target: &str,
    request_body: &[u8],
    operation: F,
) -> Result<Response, ApiError>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<Response, ApiError>>,
{
    let Some(key) = idempotency_key(headers)? else {
        return operation().await;
    };
    let fingerprint = request_fingerprint(request_body, headers.get("if-match"));
    let scope = RequestScope {
        principal_id,
        method,
        route_target,
        key: &key,
    };

    match idempotency::claim(pool, &scope, &fingerprint).await? {
        Claim::Replay(stored) => replay(stored),
        Claim::FingerprintMismatch => Err(ApiError::unprocessable(
            "IDEMPOTENCY_KEY_REUSED",
            "The idempotency key was already used for a different request.",
        )),
        Claim::InProgress => Err(ApiError::service_unavailable(
            "IDEMPOTENCY_REQUEST_IN_PROGRESS",
            "A request with this idempotency key is still in progress.",
        )),
        Claim::Execute => {
            let response = operation()
                .await
                .unwrap_or_else(IntoResponse::into_response);
            let (parts, body) = response.into_parts();
            let body = to_bytes(body, idempotency::RESPONSE_BODY_LIMIT)
                .await
                .map_err(|error| {
                    tracing::error!(error = %error, "Failed to buffer idempotent response");
                    ApiError::service_unavailable(
                        "IDEMPOTENCY_RESPONSE_UNAVAILABLE",
                        "The request outcome could not be safely recorded.",
                    )
                })?;
            let stored = StoredResponse {
                status: parts.status.as_u16(),
                content_type: parts
                    .headers
                    .get(CONTENT_TYPE)
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_string),
                body: body.to_vec(),
                etag: parts
                    .headers
                    .get("etag")
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_string),
            };
            idempotency::complete(pool, &scope, &fingerprint, &stored).await?;
            Ok(Response::from_parts(parts, Body::from(body)))
        }
    }
}

pub(crate) fn reject_one_time_secret(headers: &HeaderMap) -> Result<(), ApiError> {
    if headers.contains_key(IDEMPOTENCY_KEY) {
        Err(ApiError::unprocessable(
            "IDEMPOTENCY_NOT_ALLOWED",
            "Idempotency keys are not accepted for operations that return one-time secrets.",
        ))
    } else {
        Ok(())
    }
}

fn idempotency_key(headers: &HeaderMap) -> Result<Option<String>, ApiError> {
    let Some(value) = headers.get(IDEMPOTENCY_KEY) else {
        return Ok(None);
    };
    let value = value.to_str().map_err(|_| {
        ApiError::bad_request(
            "INVALID_IDEMPOTENCY_KEY",
            "The idempotency key must contain visible ASCII characters.",
        )
    })?;
    if value.is_empty()
        || value.len() > 255
        || value.trim() != value
        || !value.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
    {
        return Err(ApiError::bad_request(
            "INVALID_IDEMPOTENCY_KEY",
            "The idempotency key must be 1 to 255 visible ASCII characters.",
        ));
    }
    Ok(Some(value.to_string()))
}

fn request_fingerprint(body: &[u8], if_match: Option<&HeaderValue>) -> [u8; 32] {
    let precondition = if_match.map(HeaderValue::as_bytes).unwrap_or_default();
    let mut digest = Sha256::new();
    digest.update((body.len() as u64).to_be_bytes());
    digest.update(body);
    digest.update((precondition.len() as u64).to_be_bytes());
    digest.update(precondition);
    digest.finalize().into()
}

fn replay(stored: StoredResponse) -> Result<Response, ApiError> {
    let status = StatusCode::from_u16(stored.status).map_err(|_| {
        ApiError::service_unavailable(
            "IDEMPOTENCY_RESPONSE_UNAVAILABLE",
            "The stored request outcome is invalid.",
        )
    })?;
    let mut response = Response::builder().status(status);
    if let Some(content_type) = stored.content_type {
        response = response.header(CONTENT_TYPE, content_type);
    }
    if let Some(etag) = stored.etag {
        response = response.header("etag", etag);
    }
    response = response.header(IDEMPOTENCY_REPLAYED, "true");
    response.body(Body::from(stored.body)).map_err(|_| {
        ApiError::service_unavailable(
            "IDEMPOTENCY_RESPONSE_UNAVAILABLE",
            "The stored request outcome could not be reconstructed.",
        )
    })
}
