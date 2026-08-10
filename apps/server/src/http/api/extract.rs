use axum::{
    extract::{rejection::JsonRejection, FromRequest, FromRequestParts, Request},
    http::{header::CONTENT_TYPE, request::Parts, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::de::DeserializeOwned;

use crate::services::session::{RequestMetadata, VerifiedSession};

use super::{dto::ProblemDetails, error::ApiError};

#[derive(Debug)]
pub(crate) struct ApiJson<T>(pub(crate) T);

impl<S, T> FromRequest<S> for ApiJson<T>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = Response;

    async fn from_request(request: Request, state: &S) -> Result<Self, Self::Rejection> {
        Json::<T>::from_request(request, state)
            .await
            .map(|Json(value)| Self(value))
            .map_err(json_rejection_response)
    }
}

#[derive(Debug)]
pub(crate) struct ApiMergePatch<T>(pub(crate) T);

impl<S, T> FromRequest<S> for ApiMergePatch<T>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = Response;

    async fn from_request(request: Request, state: &S) -> Result<Self, Self::Rejection> {
        let content_type = request
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(';').next())
            .map(str::trim);
        if content_type != Some("application/merge-patch+json") {
            return Err(
                ApiError::unsupported_media_type("Expected application/merge-patch+json.")
                    .into_response(),
            );
        }
        Json::<T>::from_request(request, state)
            .await
            .map(|Json(value)| Self(value))
            .map_err(json_rejection_response)
    }
}

fn json_rejection_response(error: JsonRejection) -> Response {
    let status = error.status();
    let (code, title) = match status {
        StatusCode::UNSUPPORTED_MEDIA_TYPE => ("UNSUPPORTED_MEDIA_TYPE", "Unsupported media type"),
        StatusCode::PAYLOAD_TOO_LARGE => ("PAYLOAD_TOO_LARGE", "Payload too large"),
        _ => ("INVALID_REQUEST", "Invalid request"),
    };
    let request_id = uuid::Uuid::new_v4().to_string();
    let problem = ProblemDetails {
        problem_type: format!(
            "https://bittery.com/problems/{}",
            code.to_ascii_lowercase().replace('_', "-")
        ),
        title: title.to_string(),
        status: status.as_u16(),
        code: code.to_string(),
        detail: error.body_text(),
        instance: format!("urn:bittery:request:{request_id}"),
        request_id: request_id.clone(),
        retryable: false,
        errors: Vec::new(),
    };
    let mut response = (status, Json(problem)).into_response();
    response.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/problem+json"),
    );
    if let Ok(value) = HeaderValue::from_str(&request_id) {
        response.headers_mut().insert("bittery-request-id", value);
    }
    response
}

#[derive(Debug)]
pub(crate) struct AuthenticatedRequest {
    pub(crate) session: VerifiedSession,
    pub(crate) metadata: RequestMetadata,
}

#[derive(Debug)]
pub(crate) struct PublicRequest {
    pub(crate) metadata: RequestMetadata,
}

impl<S> FromRequestParts<S> for PublicRequest
where
    S: Send + Sync,
{
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        Ok(Self {
            metadata: parts
                .extensions
                .get::<RequestMetadata>()
                .cloned()
                .unwrap_or_default(),
        })
    }
}

impl<S> FromRequestParts<S> for AuthenticatedRequest
where
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        let session = parts
            .extensions
            .get::<VerifiedSession>()
            .cloned()
            .ok_or_else(|| ApiError::unauthorized("A valid bearer session is required."))?;
        let metadata = parts
            .extensions
            .get::<RequestMetadata>()
            .cloned()
            .unwrap_or_default();

        Ok(Self { session, metadata })
    }
}

#[cfg(test)]
mod tests {
    use axum::{
        body::{to_bytes, Body},
        extract::FromRequest,
        http::{header::CONTENT_TYPE, Request, StatusCode},
    };
    use serde::Deserialize;
    use serde_json::Value;

    use super::{ApiJson, ApiMergePatch};

    #[derive(Debug, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct TestBody {
        _value: String,
    }

    async fn assert_problem_response(
        response: axum::response::Response,
        expected_status: StatusCode,
        expected_code: &str,
    ) {
        assert_eq!(response.status(), expected_status);
        assert_eq!(
            response.headers().get(CONTENT_TYPE).unwrap(),
            "application/problem+json"
        );
        let request_id = response
            .headers()
            .get("bittery-request-id")
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        let body: Value = serde_json::from_slice(
            &to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("problem body should be readable"),
        )
        .expect("problem body should be JSON");
        assert_eq!(body["status"], expected_status.as_u16());
        assert_eq!(body["code"], expected_code);
        assert_eq!(body["requestId"], request_id);
    }

    #[tokio::test]
    async fn api_json_preserves_unsupported_media_type_status() {
        let request = Request::builder()
            .header(CONTENT_TYPE, "text/plain")
            .body(Body::from(r#"{"_value":"ok"}"#))
            .unwrap();

        let response = ApiJson::<TestBody>::from_request(request, &())
            .await
            .expect_err("plain text must not be accepted as JSON");

        assert_problem_response(
            response,
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "UNSUPPORTED_MEDIA_TYPE",
        )
        .await;
    }

    #[tokio::test]
    async fn api_json_keeps_malformed_json_as_bad_request() {
        let request = Request::builder()
            .header(CONTENT_TYPE, "application/json")
            .body(Body::from("{"))
            .unwrap();

        let response = ApiJson::<TestBody>::from_request(request, &())
            .await
            .expect_err("malformed JSON must be rejected");

        assert_problem_response(response, StatusCode::BAD_REQUEST, "INVALID_REQUEST").await;
    }

    #[tokio::test]
    async fn merge_patch_preserves_unsupported_media_type_status() {
        let request = Request::builder()
            .header(CONTENT_TYPE, "text/plain")
            .body(Body::from(r#"{"_value":"ok"}"#))
            .unwrap();

        let response = ApiMergePatch::<TestBody>::from_request(request, &())
            .await
            .expect_err("plain text must not be accepted as merge patch JSON");

        assert_problem_response(
            response,
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "UNSUPPORTED_MEDIA_TYPE",
        )
        .await;
    }

    #[tokio::test]
    async fn merge_patch_rejects_application_json() {
        let request = Request::builder()
            .header(CONTENT_TYPE, "application/json")
            .body(Body::from(r#"{"_value":"ok"}"#))
            .unwrap();

        let response = ApiMergePatch::<TestBody>::from_request(request, &())
            .await
            .expect_err("PATCH must require the merge-patch media type");

        assert_problem_response(
            response,
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "UNSUPPORTED_MEDIA_TYPE",
        )
        .await;
    }

    #[tokio::test]
    async fn merge_patch_accepts_the_merge_patch_media_type() {
        let request = Request::builder()
            .header(CONTENT_TYPE, "application/merge-patch+json; charset=utf-8")
            .body(Body::from(r#"{"_value":"ok"}"#))
            .unwrap();

        ApiMergePatch::<TestBody>::from_request(request, &())
            .await
            .expect("merge patch JSON should be accepted");
    }
}
