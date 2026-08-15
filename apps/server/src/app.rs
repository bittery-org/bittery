use std::time::Duration;

use axum::{
    body::Body,
    extract::State,
    http::{Request, StatusCode},
    middleware::{self, Next},
    response::Response,
    routing::get,
    Json, Router,
};
use serde_json::json;
use tower::ServiceExt;
use tower_http::timeout::Timeout;

use crate::{
    api_response_headers, catch_panic_layer, create_api_router, create_public_http_router,
    edge_http_middleware, http_trace_layer, request_context_middleware, AppState, EdgeHttpConfig,
};

pub fn create_app(state: AppState, edge_config: EdgeHttpConfig) -> Router {
    let public_http_routes = create_public_http_router().with_state(state.clone());
    let api_routes = create_api_router()
        .route_layer(middleware::from_fn(api_response_headers))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            request_context_middleware,
        ))
        .with_state(state);

    let routes = Router::new()
        .route("/", get(|| async { "OK" }))
        .route(
            "/healthz",
            get(|| async { Json(json!({ "status": "ok" })) }),
        )
        .merge(public_http_routes)
        .merge(api_routes);

    apply_http_layers(routes, edge_config)
}

pub(crate) fn apply_http_layers(routes: Router, edge_config: EdgeHttpConfig) -> Router {
    let request_timeout = edge_config.request_timeout();

    routes
        .layer(middleware::from_fn_with_state(
            request_timeout,
            request_timeout_middleware,
        ))
        // Catch panics before the edge layer so its 500 receives security/CORS headers
        // and the outer trace layer records the completed response.
        .layer(catch_panic_layer())
        .layer(middleware::from_fn_with_state(
            edge_config,
            edge_http_middleware,
        ))
        .layer(http_trace_layer())
}

async fn request_timeout_middleware(
    State(timeout): State<Duration>,
    request: Request<Body>,
    next: Next,
) -> Response {
    if request.uri().path() == "/api/v1/sync/events" {
        return next.run(request).await;
    }

    Timeout::with_status_code(next, StatusCode::REQUEST_TIMEOUT, timeout)
        .oneshot(request)
        .await
        .expect("axum middleware is infallible")
}

#[cfg(test)]
mod tests {
    use std::{sync::Arc, time::Duration};

    use async_trait::async_trait;
    use axum::{
        body::{to_bytes, Body},
        http::{header, HeaderMap, Request, StatusCode},
        routing::get,
        Router,
    };
    use serde_json::json;
    use sqlx::postgres::PgPoolOptions;
    use tower::util::ServiceExt;

    use super::{apply_http_layers, create_app};
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
        let mut headers = response.headers().clone();
        let request_id = headers
            .get("bittery-request-id")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        headers.remove("bittery-request-id");
        let mut body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("app response body should read")
            .to_vec();
        if headers.get(header::CONTENT_TYPE).is_some_and(|value| {
            value
                .to_str()
                .is_ok_and(|value| value.starts_with("application/problem+json"))
        }) {
            let mut problem: serde_json::Value =
                serde_json::from_slice(&body).expect("problem response should be JSON");
            let request_id = request_id.expect("problem response should carry a request ID");
            assert_eq!(problem["requestId"], request_id);
            assert_eq!(
                problem["instance"],
                format!("urn:bittery:request:{request_id}")
            );
            problem["requestId"] = json!("normalized-request-id");
            problem["instance"] = json!("urn:bittery:request:normalized-request-id");
            body = serde_json::to_vec(&problem).expect("normalized problem should serialize");
        }

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
        let _env_lock = acquire_env_lock_async().await;
        let _env = EnvVarGuard::set(&[("BITTERY_MODE", "cloud")]);
        let production = create_app(AppState::database_free_test(), EdgeHttpConfig::default());
        let test_support = create_test_router(AppState::database_free_test());

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

        let api_meta = assert_matching_response(&production, &test_support, || {
            Request::builder()
                .uri("/api/meta")
                .body(Body::empty())
                .expect("API metadata request should build")
        })
        .await;
        assert_eq!(api_meta.status, StatusCode::OK);
        let metadata = serde_json::from_slice::<serde_json::Value>(&api_meta.body)
            .expect("API metadata should be JSON");
        assert_eq!(metadata["serverRelease"], env!("CARGO_PKG_VERSION"));
        assert_eq!(metadata["api"]["supportedMajors"], json!([1]));
        assert_eq!(metadata["api"]["preferredMajor"], json!(1));

        let api_v1 = assert_matching_response(&production, &test_support, || {
            Request::builder()
                .uri("/api/v1")
                .body(Body::empty())
                .expect("API v1 request should build")
        })
        .await;
        assert_eq!(api_v1.status, StatusCode::NOT_FOUND);

        let legacy_sync = assert_matching_response(&production, &test_support, || {
            Request::builder()
                .uri("/sync/health")
                .body(Body::empty())
                .expect("sync request should build")
        })
        .await;
        assert_eq!(legacy_sync.status, StatusCode::NOT_FOUND);

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

        let legacy_rpc = assert_matching_response(&production, &test_support, || {
            Request::builder()
                .method("POST")
                .uri("/rpc")
                .header(header::CONTENT_TYPE, "text/plain")
                .body(Body::from("{}"))
                .expect("legacy route request should build")
        })
        .await;
        assert_eq!(legacy_rpc.status, StatusCode::NOT_FOUND);
    }

    struct PanickingRateLimiter;

    #[tokio::test]
    async fn slow_requests_timeout_and_keep_edge_headers() {
        let edge_config = EdgeHttpConfig::default()
            .with_request_timeout(Duration::from_millis(10))
            .with_allowed_origin("https://app.example.com");
        let router = apply_http_layers(
            Router::new().route(
                "/api/v1/test/slow",
                get(|| async {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    StatusCode::NO_CONTENT
                }),
            ),
            edge_config,
        );

        let response = router
            .oneshot(
                Request::builder()
                    .uri("/api/v1/test/slow")
                    .header(header::ORIGIN, "https://app.example.com")
                    .body(Body::empty())
                    .expect("slow request should build"),
            )
            .await
            .expect("timeout should become an HTTP response");

        assert_eq!(response.status(), StatusCode::REQUEST_TIMEOUT);
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
    }

    #[tokio::test]
    async fn sync_event_stream_is_exempt_from_request_timeout() {
        let router = apply_http_layers(
            Router::new().route(
                "/api/v1/sync/events",
                get(|| async {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    StatusCode::NO_CONTENT
                }),
            ),
            EdgeHttpConfig::default().with_request_timeout(Duration::from_millis(10)),
        );

        let response = router
            .oneshot(
                Request::builder()
                    .uri("/api/v1/sync/events")
                    .body(Body::empty())
                    .expect("SSE request should build"),
            )
            .await
            .expect("SSE route should respond");

        assert_eq!(response.status(), StatusCode::NO_CONTENT);
    }

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
                    .uri("/api/v1/auth/login-attempts")
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(header::ORIGIN, "https://app.example.com")
                    .body(Body::from(
                        json!({
                            "email": "panic@example.com",
                            "clientPublicKey": "00",
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
        let problem: serde_json::Value =
            serde_json::from_slice(&body).expect("panic response should use problem JSON");
        assert_eq!(problem["code"], "INTERNAL_ERROR");
        assert!(!String::from_utf8_lossy(&body).contains("rate limiter panic"));
    }
}
