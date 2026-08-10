use axum::{
    extract::{rejection::JsonRejection, FromRequest, FromRequestParts, Request},
    http::request::Parts,
    Json,
};
use serde::de::DeserializeOwned;

use crate::services::session::{RequestMetadata, VerifiedSession};

use super::error::ApiError;

pub(crate) struct ApiJson<T>(pub(crate) T);

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
            .map_err(|error: JsonRejection| ApiError::invalid_request(error.body_text()))
    }
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
