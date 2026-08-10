use axum::{
    http::{header::CONTENT_TYPE, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};

use crate::error::{AppError, AppErrorCode};

use super::dto::ProblemDetails;

const RATE_LIMIT_RETRY_AFTER_SECONDS: u32 = 60;
const TEMPORARY_UNAVAILABLE_RETRY_AFTER_SECONDS: u32 = 1;
pub(crate) const MAX_RETRY_AFTER_SECONDS: u32 = 86_400;

#[derive(Clone, Copy, Debug)]
struct RetryAfter {
    seconds: u32,
}

impl RetryAfter {
    fn seconds(seconds: u32) -> Self {
        Self {
            seconds: seconds.clamp(1, MAX_RETRY_AFTER_SECONDS),
        }
    }

    fn header_value(self) -> HeaderValue {
        HeaderValue::from_str(&self.seconds.to_string())
            .expect("bounded retry delay should always be a valid header value")
    }
}

#[derive(Debug)]
pub(crate) struct ApiError {
    status: StatusCode,
    problem: ProblemDetails,
    retry_after: Option<RetryAfter>,
}

impl ApiError {
    pub(crate) fn internal() -> Self {
        AppError::internal("API contract processing failed").into()
    }

    #[cfg(test)]
    pub(crate) fn code(&self) -> &str {
        &self.problem.code
    }
    pub(crate) fn bad_request(code: &str, detail: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code, "Bad request", detail, false)
    }

    pub(crate) fn payload_too_large(detail: impl Into<String>) -> Self {
        Self::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "PAYLOAD_TOO_LARGE",
            "Payload too large",
            detail,
            false,
        )
    }

    pub(crate) fn unsupported_media_type(detail: impl Into<String>) -> Self {
        Self::new(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "UNSUPPORTED_MEDIA_TYPE",
            "Unsupported media type",
            detail,
            false,
        )
    }

    pub(crate) fn precondition_required(detail: impl Into<String>) -> Self {
        Self::new(
            StatusCode::PRECONDITION_REQUIRED,
            "PRECONDITION_REQUIRED",
            "Precondition required",
            detail,
            false,
        )
    }

    pub(crate) fn version_conflict(detail: impl Into<String>) -> Self {
        Self::new(
            StatusCode::PRECONDITION_FAILED,
            "VERSION_CONFLICT",
            "Version conflict",
            detail,
            false,
        )
    }

    pub(crate) fn unprocessable(code: &str, detail: impl Into<String>) -> Self {
        Self::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            code,
            "Unprocessable request",
            detail,
            false,
        )
    }

    pub(crate) fn conflict(code: &str, detail: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, code, "Conflict", detail, false)
    }

    pub(crate) fn service_unavailable(code: &str, detail: impl Into<String>) -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            code,
            "Service unavailable",
            detail,
            true,
        )
        .with_retry_after(RetryAfter::seconds(
            TEMPORARY_UNAVAILABLE_RETRY_AFTER_SECONDS,
        ))
    }

    pub(crate) fn unauthorized(detail: impl Into<String>) -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "UNAUTHORIZED",
            "Authentication required",
            detail,
            false,
        )
    }

    pub(crate) fn api_route_not_found() -> Self {
        Self::new(
            StatusCode::NOT_FOUND,
            "API_ROUTE_NOT_FOUND",
            "API route not found",
            "The requested API route does not exist.",
            false,
        )
    }

    pub(crate) fn method_not_allowed() -> Self {
        Self::new(
            StatusCode::METHOD_NOT_ALLOWED,
            "METHOD_NOT_ALLOWED",
            "Method not allowed",
            "The requested method is not supported for this API route.",
            false,
        )
    }

    fn new(
        status: StatusCode,
        code: &str,
        title: &str,
        detail: impl Into<String>,
        retryable: bool,
    ) -> Self {
        let request_id = uuid::Uuid::new_v4().to_string();
        Self {
            status,
            retry_after: None,
            problem: ProblemDetails {
                problem_type: format!(
                    "https://bittery.com/problems/{}",
                    code.to_ascii_lowercase().replace('_', "-")
                ),
                title: title.to_string(),
                status: status.as_u16(),
                code: code.to_string(),
                detail: detail.into(),
                instance: format!("urn:bittery:request:{request_id}"),
                request_id,
                retryable,
                errors: Vec::new(),
            },
        }
    }

    fn with_retry_after(mut self, retry_after: RetryAfter) -> Self {
        self.retry_after = Some(retry_after);
        self
    }
}

impl From<AppError> for ApiError {
    fn from(error: AppError) -> Self {
        let (status, code, title, detail, retryable) = match error.code {
            AppErrorCode::InternalServerError => {
                tracing::error!(error = %error, "API request failed internally");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "INTERNAL_ERROR",
                    "Internal server error",
                    "The server could not complete the request.".to_string(),
                    false,
                )
            }
            AppErrorCode::BadRequest => (
                StatusCode::BAD_REQUEST,
                "BAD_REQUEST",
                "Bad request",
                error.message,
                false,
            ),
            AppErrorCode::NotFound => (
                StatusCode::NOT_FOUND,
                "NOT_FOUND",
                "Not found",
                error.message,
                false,
            ),
            AppErrorCode::Forbidden => (
                StatusCode::FORBIDDEN,
                "FORBIDDEN",
                "Forbidden",
                error.message,
                false,
            ),
            AppErrorCode::Unauthorized => (
                StatusCode::UNAUTHORIZED,
                "UNAUTHORIZED",
                "Authentication required",
                error.message,
                false,
            ),
            AppErrorCode::Conflict => (
                StatusCode::CONFLICT,
                "CONFLICT",
                "Conflict",
                error.message,
                false,
            ),
            AppErrorCode::TooManyRequests => (
                StatusCode::TOO_MANY_REQUESTS,
                "RATE_LIMITED",
                "Too many requests",
                error.message,
                true,
            ),
            AppErrorCode::PayloadTooLarge => (
                StatusCode::PAYLOAD_TOO_LARGE,
                "PAYLOAD_TOO_LARGE",
                "Payload too large",
                error.message,
                false,
            ),
        };

        let api_error = Self::new(status, code, title, detail, retryable);
        if status == StatusCode::TOO_MANY_REQUESTS {
            api_error.with_retry_after(RetryAfter::seconds(RATE_LIMIT_RETRY_AFTER_SECONDS))
        } else {
            api_error
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let request_id = self.problem.request_id.clone();
        let mut response = (self.status, Json(self.problem)).into_response();
        response.headers_mut().insert(
            CONTENT_TYPE,
            HeaderValue::from_static("application/problem+json"),
        );
        if let Ok(value) = HeaderValue::from_str(&request_id) {
            response.headers_mut().insert("bittery-request-id", value);
        }
        if let Some(retry_after) = self.retry_after {
            response
                .headers_mut()
                .insert("retry-after", retry_after.header_value());
        }
        response
    }
}

#[cfg(test)]
mod tests {
    use axum::{
        body::to_bytes,
        http::{header::CONTENT_TYPE, StatusCode},
        response::IntoResponse,
    };
    use serde_json::Value;

    use crate::error::AppError;

    #[tokio::test]
    async fn internal_errors_are_redacted_as_problem_json() {
        let response =
            super::ApiError::from(AppError::internal("database password leaked")).into_response();
        assert_eq!(response.status(), 500);
        assert_eq!(
            response.headers().get(CONTENT_TYPE).unwrap(),
            "application/problem+json"
        );
        assert!(response.headers().contains_key("bittery-request-id"));

        let body: Value = serde_json::from_slice(
            &to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("problem body should be readable"),
        )
        .expect("problem body should be JSON");
        assert_eq!(body["code"], "INTERNAL_ERROR");
        assert!(!body.to_string().contains("database password"));
    }

    #[test]
    fn rate_limits_and_temporary_unavailability_have_typed_retry_delays() {
        let rate_limited =
            super::ApiError::from(AppError::too_many_requests("slow down")).into_response();
        assert_eq!(rate_limited.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(
            rate_limited.headers()["retry-after"]
                .to_str()
                .unwrap()
                .parse::<u32>()
                .unwrap(),
            super::RATE_LIMIT_RETRY_AFTER_SECONDS
        );

        let unavailable = super::ApiError::service_unavailable("BUSY", "try again").into_response();
        assert_eq!(unavailable.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            unavailable.headers()["retry-after"]
                .to_str()
                .unwrap()
                .parse::<u32>()
                .unwrap(),
            super::TEMPORARY_UNAVAILABLE_RETRY_AFTER_SECONDS
        );
    }

    #[test]
    fn retry_delays_are_bounded_for_safe_delta_seconds_headers() {
        let minimum = super::RetryAfter::seconds(0);
        let maximum = super::RetryAfter::seconds(u32::MAX);

        assert_eq!(minimum.seconds, 1);
        assert_eq!(maximum.seconds, super::MAX_RETRY_AFTER_SECONDS);
    }
}
