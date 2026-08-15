use axum::{
    body::to_bytes,
    extract::{
        rejection::{JsonRejection, QueryRejection},
        FromRequest, FromRequestParts, Query, Request,
    },
    http::{header::CONTENT_TYPE, request::Parts, StatusCode},
    Json,
};
use serde::{de::DeserializeOwned, Deserialize};

use crate::domains::sessions::service::{RequestMetadata, VerifiedSession};

use super::{error::ApiError, error_code::ErrorCode};

#[derive(Debug)]
pub(crate) struct ApiJson<T>(pub(crate) T);

#[derive(Debug)]
pub(crate) struct ApiQuery<T>(pub(crate) T);

impl<S, T> FromRequestParts<S> for ApiQuery<T>
where
    S: Send + Sync,
    T: for<'de> Deserialize<'de>,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        Query::<T>::from_request_parts(parts, state)
            .await
            .map(|Query(value)| Self(value))
            .map_err(|error: QueryRejection| {
                ApiError::bad_request(ErrorCode::InvalidQuery, error.body_text())
            })
    }
}

impl<S, T> FromRequest<S> for ApiJson<T>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = ApiError;

    async fn from_request(request: Request, state: &S) -> Result<Self, Self::Rejection> {
        Json::<T>::from_request(request, state)
            .await
            .map(|Json(value)| Self(value))
            .map_err(json_rejection_error)
    }
}

#[derive(Debug)]
pub(crate) struct ApiMergePatch<T>(pub(crate) T);

impl<S, T> FromRequest<S> for ApiMergePatch<T>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = ApiError;

    async fn from_request(request: Request, state: &S) -> Result<Self, Self::Rejection> {
        require_merge_patch_content_type(&request)?;
        Json::<T>::from_request(request, state)
            .await
            .map(|Json(value)| Self(value))
            .map_err(json_rejection_error)
    }
}

#[derive(Debug)]
pub(crate) struct ApiJsonBytes<T, const MAX_BYTES: usize> {
    pub(crate) value: T,
    pub(crate) bytes: Vec<u8>,
}

impl<S, T, const MAX_BYTES: usize> FromRequest<S> for ApiJsonBytes<T, MAX_BYTES>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = ApiError;

    async fn from_request(request: Request, _state: &S) -> Result<Self, Self::Rejection> {
        require_json_content_type(&request)?;
        let (value, bytes) = parse_json_bytes(request, MAX_BYTES).await?;
        Ok(Self { value, bytes })
    }
}

#[derive(Debug)]
pub(crate) struct ApiMergePatchBytes<T, const MAX_BYTES: usize> {
    pub(crate) value: T,
    pub(crate) bytes: Vec<u8>,
}

impl<S, T, const MAX_BYTES: usize> FromRequest<S> for ApiMergePatchBytes<T, MAX_BYTES>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = ApiError;

    async fn from_request(request: Request, _state: &S) -> Result<Self, Self::Rejection> {
        require_merge_patch_content_type(&request)?;
        let (value, bytes) = parse_json_bytes(request, MAX_BYTES).await?;
        Ok(Self { value, bytes })
    }
}

fn json_rejection_error(error: JsonRejection) -> ApiError {
    match error.status() {
        StatusCode::UNSUPPORTED_MEDIA_TYPE => ApiError::unsupported_media_type(error.body_text()),
        StatusCode::PAYLOAD_TOO_LARGE => {
            ApiError::payload_too_large("The request body exceeds this route's byte limit.")
        }
        _ => ApiError::invalid_request(error.status(), error.body_text()),
    }
}

fn json_content_type(request: &Request) -> Option<&str> {
    request
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::trim)
}

fn require_json_content_type(request: &Request) -> Result<(), ApiError> {
    if matches!(json_content_type(request), Some("application/json"))
        || json_content_type(request).is_some_and(|value| value.ends_with("+json"))
    {
        return Ok(());
    }

    Err(ApiError::unsupported_media_type(
        "Expected a JSON request content type.",
    ))
}

fn require_merge_patch_content_type(request: &Request) -> Result<(), ApiError> {
    if json_content_type(request) == Some("application/merge-patch+json") {
        return Ok(());
    }

    Err(ApiError::unsupported_media_type(
        "Expected application/merge-patch+json.",
    ))
}

async fn parse_json_bytes<T>(request: Request, max_bytes: usize) -> Result<(T, Vec<u8>), ApiError>
where
    T: DeserializeOwned,
{
    let bytes = to_bytes(request.into_body(), max_bytes)
        .await
        .map_err(|_| {
            ApiError::payload_too_large("The request body exceeds this route's byte limit.")
        })?;
    let Json(value) = Json::<T>::from_bytes(&bytes).map_err(json_rejection_error)?;
    Ok((value, bytes.to_vec()))
}

#[derive(Debug)]
pub(crate) struct AuthenticatedRequest {
    pub(crate) session: VerifiedSession,
    pub(crate) metadata: RequestMetadata,
}

impl AuthenticatedRequest {
    pub(crate) fn effective_client_id(&self) -> Option<String> {
        self.metadata
            .client_id
            .clone()
            .or_else(|| self.session.client_id.clone())
    }
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
        response::IntoResponse,
    };
    use serde::Deserialize;
    use serde_json::Value;

    use super::{ApiJson, ApiJsonBytes, ApiMergePatch, ApiMergePatchBytes};

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
            response.into_response(),
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

        assert_problem_response(
            response.into_response(),
            StatusCode::BAD_REQUEST,
            "INVALID_REQUEST",
        )
        .await;
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
            response.into_response(),
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
            response.into_response(),
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

    #[tokio::test]
    async fn every_json_extractor_uses_the_invalid_request_code() {
        let json_request = || {
            Request::builder()
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"_value":"ok","extra":true}"#))
                .unwrap()
        };
        let merge_patch_request = || {
            Request::builder()
                .header(CONTENT_TYPE, "application/merge-patch+json")
                .body(Body::from(r#"{"_value":"ok","extra":true}"#))
                .unwrap()
        };

        for response in [
            ApiJson::<TestBody>::from_request(json_request(), &())
                .await
                .expect_err("unknown JSON fields must be rejected")
                .into_response(),
            ApiMergePatch::<TestBody>::from_request(merge_patch_request(), &())
                .await
                .expect_err("unknown merge patch JSON fields must be rejected")
                .into_response(),
            ApiJsonBytes::<TestBody, 1024>::from_request(json_request(), &())
                .await
                .expect_err("unknown captured JSON fields must be rejected")
                .into_response(),
            ApiMergePatchBytes::<TestBody, 1024>::from_request(merge_patch_request(), &())
                .await
                .expect_err("unknown captured merge patch JSON fields must be rejected")
                .into_response(),
        ] {
            assert_problem_response(
                response,
                StatusCode::UNPROCESSABLE_ENTITY,
                "INVALID_REQUEST",
            )
            .await;
        }
    }

    #[tokio::test]
    async fn captured_json_respects_its_configured_body_limit() {
        let request = Request::builder()
            .header(CONTENT_TYPE, "application/json")
            .body(Body::from(r#"{"_value":"too long"}"#))
            .unwrap();

        let response = ApiJsonBytes::<TestBody, 8>::from_request(request, &())
            .await
            .expect_err("captured JSON must respect its byte limit")
            .into_response();

        assert_problem_response(response, StatusCode::PAYLOAD_TOO_LARGE, "PAYLOAD_TOO_LARGE").await;
    }
}
