use axum::{middleware, routing::get, Json, Router};
use serde_json::json;

use crate::{
    catch_panic_layer, create_public_http_router, create_rpc_router, create_sync_http_router,
    edge_http_middleware, http_trace_layer, rpc_request_context_middleware,
    rpc_request_guard_middleware, rpc_tracing_middleware, AppState, EdgeHttpConfig,
};

pub fn create_app(state: AppState, edge_config: EdgeHttpConfig) -> Router {
    let (qubit_service, _server_handle) = create_rpc_router().as_rpc(state.clone()).into_service();
    let rpc_routes = Router::new()
        .nest_service("/rpc", qubit_service)
        .route_layer(middleware::from_fn(rpc_tracing_middleware))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            rpc_request_context_middleware,
        ))
        .layer(middleware::from_fn(rpc_request_guard_middleware));
    let sync_routes = create_sync_http_router()
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            rpc_request_context_middleware,
        ))
        .with_state(state.clone());
    let public_http_routes = create_public_http_router().with_state(state);

    Router::new()
        .route("/", get(|| async { "OK" }))
        .route(
            "/healthz",
            get(|| async { Json(json!({ "status": "ok" })) }),
        )
        .merge(public_http_routes)
        .nest("/sync", sync_routes)
        .merge(rpc_routes)
        // Catch panics before the edge layer so its 500 receives security/CORS headers
        // and the outer trace layer records the completed response.
        .layer(catch_panic_layer())
        .layer(middleware::from_fn_with_state(
            edge_config,
            edge_http_middleware,
        ))
        .layer(http_trace_layer())
}

#[cfg(test)]
mod tests {
    use std::{sync::Arc, time::Duration};

    use async_trait::async_trait;
    use axum::{
        body::{to_bytes, Body},
        http::{header, HeaderMap, Request, StatusCode},
    };
    use serde_json::json;
    use sqlx::postgres::PgPoolOptions;
    use tower::util::ServiceExt;

    use super::create_app;
    use crate::{
        error::AppError,
        services::rate_limit::{RateLimitOutcome, RateLimiter},
        test_support::{acquire_env_lock_async, create_test_router, EnvVarGuard},
        AppState, EdgeHttpConfig,
    };

    #[derive(Debug, PartialEq, Eq)]
    struct ResponseSignature {
        status: StatusCode,
        headers: HeaderMap,
        body: Vec<u8>,
    }

    async fn response_signature(
        router: &axum::Router,
        request: Request<Body>,
    ) -> ResponseSignature {
        let response = router
            .clone()
            .oneshot(request)
            .await
            .expect("app request should resolve");
        let status = response.status();
        let headers = response.headers().clone();
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("app response body should read")
            .to_vec();

        ResponseSignature {
            status,
            headers,
            body,
        }
    }

    async fn assert_matching_response(
        production: &axum::Router,
        test_support: &axum::Router,
        request: impl Fn() -> Request<Body>,
    ) -> ResponseSignature {
        let production_response = response_signature(production, request()).await;
        assert_eq!(
            production_response,
            response_signature(test_support, request()).await
        );
        production_response
    }

    #[tokio::test]
    async fn test_support_matches_production_router_shape() {
        let production = create_app(AppState::default(), EdgeHttpConfig::default());
        let test_support = create_test_router(AppState::default());

        let root = assert_matching_response(&production, &test_support, || {
            Request::builder()
                .uri("/")
                .body(Body::empty())
                .expect("root request should build")
        })
        .await;
        assert_eq!(root.status, StatusCode::OK);
        assert_eq!(root.body, b"OK");

        let health = assert_matching_response(&production, &test_support, || {
            Request::builder()
                .uri("/healthz")
                .body(Body::empty())
                .expect("health request should build")
        })
        .await;
        assert_eq!(health.status, StatusCode::OK);
        assert_eq!(health.body, br#"{"status":"ok"}"#);

        let sync = assert_matching_response(&production, &test_support, || {
            Request::builder()
                .uri("/sync/health")
                .body(Body::empty())
                .expect("sync request should build")
        })
        .await;
        assert_eq!(sync.status, StatusCode::OK);

        let public = assert_matching_response(&production, &test_support, || {
            Request::builder()
                .method("POST")
                .uri("/waitlist")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from("{}"))
                .expect("public request should build")
        })
        .await;
        assert_ne!(public.status, StatusCode::NOT_FOUND);

        let rpc_guard = assert_matching_response(&production, &test_support, || {
            Request::builder()
                .method("POST")
                .uri("/rpc")
                .header(header::CONTENT_TYPE, "text/plain")
                .body(Body::from("{}"))
                .expect("rpc guard request should build")
        })
        .await;
        assert_eq!(rpc_guard.status, StatusCode::UNSUPPORTED_MEDIA_TYPE);

        let rpc = assert_matching_response(&production, &test_support, || {
            Request::builder()
                .method("POST")
                .uri("/rpc")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "healthCheck",
                        "params": [],
                    })
                    .to_string(),
                ))
                .expect("rpc request should build")
        })
        .await;
        assert_eq!(rpc.status, StatusCode::OK);
    }

    struct PanickingRateLimiter;

    #[async_trait]
    impl RateLimiter for PanickingRateLimiter {
        async fn check_and_increment(
            &self,
            _scope: &str,
            _key: &str,
            _limit: i64,
            _window: Duration,
        ) -> Result<RateLimitOutcome, AppError> {
            panic!("rate limiter panic")
        }

        async fn record_failure(
            &self,
            _scope: &str,
            _key: &str,
            _max_attempts: i64,
            _lock_duration: Duration,
        ) -> Result<RateLimitOutcome, AppError> {
            unreachable!("the test request only checks a windowed limit")
        }

        async fn is_locked(&self, _scope: &str, _key: &str) -> Result<RateLimitOutcome, AppError> {
            unreachable!("the test request only checks a windowed limit")
        }

        async fn clear(&self, _scope: &str, _key: &str) -> Result<(), AppError> {
            unreachable!("the test request only checks a windowed limit")
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn panic_responses_keep_edge_headers() {
        let _env_lock = acquire_env_lock_async().await;
        let _env = EnvVarGuard::set(&[("CORS_ORIGIN", "https://app.example.com")]);
        let edge_config = crate::load_edge_http_config().expect("CORS config should load");
        let pool = PgPoolOptions::new()
            .connect_lazy("postgres://postgres@localhost/bittery")
            .expect("lazy test pool should build");
        let state = AppState::from_pool(pool).with_rate_limiter(Arc::new(PanickingRateLimiter));
        let router = create_app(state, edge_config);

        let response = router
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/rpc")
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(header::ORIGIN, "https://app.example.com")
                    .body(Body::from(
                        json!({
                            "jsonrpc": "2.0",
                            "id": 1,
                            "method": "auth.startLogin",
                            "params": [{
                                "email": "panic@example.com",
                                "clientPublicKey": "00",
                            }],
                        })
                        .to_string(),
                    ))
                    .expect("panic request should build"),
            )
            .await
            .expect("panic should become an HTTP response");

        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(
            response.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN),
            Some(&header::HeaderValue::from_static("https://app.example.com"))
        );
        assert_eq!(
            response.headers().get("x-content-type-options"),
            Some(&header::HeaderValue::from_static("nosniff"))
        );
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL),
            Some(&header::HeaderValue::from_static("no-store, max-age=0"))
        );

        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("panic response body should read");
        assert!(String::from_utf8_lossy(&body).contains("Internal Server Error"));
        assert!(!String::from_utf8_lossy(&body).contains("rate limiter panic"));
    }
}
