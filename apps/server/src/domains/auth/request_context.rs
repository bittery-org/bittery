use super::format_rfc3339;
use axum::{
    extract::{ConnectInfo, State},
    http::{header::HeaderName, HeaderValue, Request},
    middleware::Next,
    response::{IntoResponse, Response},
};
use std::net::SocketAddr;

use crate::{
    config::TrustProxyMode, domains::sessions::service::RequestMetadata, http::error::ApiError,
    AppState,
};

const AUTHORIZATION_HEADER: &str = "authorization";
const CLIENT_ID_HEADER: &str = "bittery-client-id";
const CLIENT_PLATFORM_HEADER: &str = "bittery-client-platform";
const SESSION_EXPIRY_HEADER: &str = "bittery-session-expires";
pub async fn request_context_middleware(
    State(state): State<AppState>,
    mut request: Request<axum::body::Body>,
    next: Next,
) -> Response {
    let metadata = RequestMetadata {
        auth_token: parse_bearer_token(&request),
        client_id: header_value(&request, CLIENT_ID_HEADER),
        app_platform: header_value(&request, CLIENT_PLATFORM_HEADER),
        user_agent: header_value(&request, "user-agent"),
        ip_address: client_ip_address(state.config.server.trust_proxy_mode, &request),
    };

    let auth_token = metadata.auth_token.clone();
    let verified_session = auth_token
        .as_deref()
        .map(|token| state.sessions.verify_token(token));

    let verified_session = match verified_session {
        Some(future) => future.await,
        None => Ok(None),
    };
    let verified_session = match verified_session {
        Ok(session) => session,
        Err(error) => return ApiError::from(error).into_response(),
    };

    request.extensions_mut().insert(metadata);
    if let Some(session) = verified_session.clone() {
        request.extensions_mut().insert(session);
    }

    let mut response = next.run(request).await;
    if let Some(session) = verified_session {
        if let Ok(value) = HeaderValue::from_str(&format_rfc3339(session.expires_at)) {
            response
                .headers_mut()
                .insert(session_expiry_header_name(), value);
        }
    }

    response
}
pub(super) fn parse_bearer_token(request: &Request<axum::body::Body>) -> Option<String> {
    header_value(request, AUTHORIZATION_HEADER).and_then(|value| {
        value
            .strip_prefix("Bearer ")
            .or_else(|| value.strip_prefix("bearer "))
            .map(ToOwned::to_owned)
    })
}

pub(super) fn header_value(request: &Request<axum::body::Body>, name: &str) -> Option<String> {
    request
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

/// Resolves the client address the per-IP rate limits key on.
///
/// The forwarded-for headers are only consulted when `TRUST_PROXY_MODE` says the
/// server sits behind a proxy that overwrites them; otherwise they are
/// caller-controlled and a spoofed value would hand out a fresh limiter budget
/// per request. Without that opt-in we use the TCP peer address, which the
/// caller cannot forge.
fn client_ip_address(mode: TrustProxyMode, request: &Request<axum::body::Body>) -> Option<String> {
    if mode == TrustProxyMode::Cloudflare {
        if let Some(connecting_ip) = header_value(request, "cf-connecting-ip") {
            return Some(connecting_ip);
        }
    }

    if mode != TrustProxyMode::None {
        if let Some(forwarded) = header_value(request, "x-forwarded-for")
            .map(|v| v.split(',').next().unwrap_or("").trim().to_owned())
            .filter(|v| !v.is_empty())
            .or_else(|| header_value(request, "x-real-ip"))
        {
            return Some(forwarded);
        }
    }

    request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ConnectInfo(addr)| addr.ip().to_string())
}

fn session_expiry_header_name() -> HeaderName {
    HeaderName::from_static(SESSION_EXPIRY_HEADER)
}

#[cfg(test)]
mod tests {
    use axum::{
        body::{to_bytes, Body},
        http::{Request, StatusCode},
        middleware,
        routing::get,
        Router,
    };
    use serde_json::Value;
    use sqlx::postgres::PgPoolOptions;
    use tower::ServiceExt;

    use crate::AppState;

    use super::request_context_middleware;

    #[tokio::test]
    async fn session_store_failure_returns_internal_error_instead_of_unauthorized() {
        let pool = PgPoolOptions::new()
            .connect_lazy("postgres://test:test@127.0.0.1:1/bittery_auth_context_failure")
            .expect("fixed unavailable database URL should parse");
        let state = AppState::from_pool(pool.clone());
        pool.close().await;
        let app = Router::new()
            .route("/", get(|| async { StatusCode::NO_CONTENT }))
            .layer(middleware::from_fn_with_state(
                state,
                request_context_middleware,
            ));

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/")
                    .header("authorization", "Bearer token")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("middleware should respond");

        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let body: Value = serde_json::from_slice(
            &to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("problem body should be readable"),
        )
        .expect("problem body should be JSON");
        assert_eq!(body["code"], "INTERNAL_ERROR");
    }
}
