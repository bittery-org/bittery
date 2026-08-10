use axum::{
    http::{header::CONTENT_TYPE, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};

use crate::error::{AppError, AppErrorCode};

use super::dto::ProblemDetails;

#[derive(Debug)]
pub(crate) struct ApiError {
    status: StatusCode,
    problem: ProblemDetails,
}

impl ApiError {
    pub(crate) fn internal() -> Self {
        AppError::internal("API contract processing failed").into()
    }

    #[cfg(test)]
    pub(crate) fn code(&self) -> &str {
        &self.problem.code
    }
    pub(crate) fn invalid_request(detail: impl Into<String>) -> Self {
        Self::new(
            StatusCode::BAD_REQUEST,
            "INVALID_REQUEST",
            "Invalid request",
            detail,
            false,
        )
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

    pub(crate) fn service_unavailable(code: &str, detail: impl Into<String>) -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            code,
            "Service unavailable",
            detail,
            true,
        )
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
        };

        Self::new(status, code, title, detail, retryable)
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
        if self.status == StatusCode::SERVICE_UNAVAILABLE {
            response
                .headers_mut()
                .insert("retry-after", HeaderValue::from_static("1"));
        }
        response
    }
}

#[cfg(test)]
mod tests {
    use axum::{body::to_bytes, http::header::CONTENT_TYPE, response::IntoResponse};
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
}
