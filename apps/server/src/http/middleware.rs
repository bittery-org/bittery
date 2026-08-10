use std::{any::Any, env, time::Duration};

use axum::{
    body::Body,
    extract::State,
    http::{
        header::{
            HeaderName, HeaderValue, ACCESS_CONTROL_ALLOW_HEADERS, ACCESS_CONTROL_ALLOW_METHODS,
            ACCESS_CONTROL_ALLOW_ORIGIN, ACCESS_CONTROL_EXPOSE_HEADERS, CACHE_CONTROL, EXPIRES,
            ORIGIN, PRAGMA, VARY,
        },
        Method, Request, StatusCode,
    },
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use tower_http::{catch_panic::CatchPanicLayer, trace::TraceLayer};
use tracing::Span;
use url::Url;

type HttpTraceClassifier =
    tower_http::classify::SharedClassifier<tower_http::classify::ServerErrorsAsFailures>;

type HttpTraceLayer = TraceLayer<
    HttpTraceClassifier,
    fn(&Request<Body>) -> Span,
    fn(&Request<Body>, &Span),
    fn(&Response<Body>, Duration, &Span),
>;

pub fn http_trace_layer() -> HttpTraceLayer {
    TraceLayer::new_for_http()
        .make_span_with(make_http_trace_span as fn(&Request<Body>) -> Span)
        .on_request(on_http_trace_request as fn(&Request<Body>, &Span))
        .on_response(on_http_trace_response as fn(&Response<Body>, Duration, &Span))
}

type PanicHandler = fn(Box<dyn Any + Send + 'static>) -> Response;

/// Turn a panic anywhere below this layer into a `500` for that one request.
///
/// Without it, a panic in a handler unwinds out of the axum service and kills
/// the whole hyper connection task: the client gets a dropped connection with
/// no response, and every other keep-alive request already in flight on that
/// connection dies with it. Tokio keeps the process alive (the panic is
/// contained to the connection task, and no `panic = "abort"` profile is set),
/// so this is a per-connection liveness problem rather than a crash.
///
/// One panic source is not obvious from reading the handlers: `rand` 0.10 made
/// `ThreadRng` reseed failure fatal (`panic!("could not reseed ThreadRng")`)
/// where 0.8 logged a warning and carried on. `ThreadRng` reseeds from the OS
/// every 64 kB of output, so any `rand::rng()` caller — share-link tokens,
/// team invite codes, auth verification codes, sync event IDs — can panic if
/// the OS entropy source becomes unavailable. Failing closed is correct; this
/// layer is what keeps it from taking connections down with it.
pub fn catch_panic_layer() -> CatchPanicLayer<PanicHandler> {
    CatchPanicLayer::custom(response_for_panic as PanicHandler)
}

fn response_for_panic(panic: Box<dyn Any + Send + 'static>) -> Response {
    let details = panic
        .downcast_ref::<String>()
        .map(String::as_str)
        .or_else(|| panic.downcast_ref::<&str>().copied())
        .unwrap_or("<non-string panic payload>");
    tracing::error!(panic = %details, "request handler panicked");

    // The panic message stays server-side: it can carry internal state, and the
    // client has no use for it.
    json_error(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error")
}

fn make_http_trace_span(request: &Request<Body>) -> Span {
    tracing::debug_span!(
        "request",
        method = %request.method(),
        uri = %request.uri(),
        version = ?request.version(),
    )
}

fn on_http_trace_request(request: &Request<Body>, _span: &Span) {
    tracing::debug!(method = %request.method(), "started processing request");
}

fn on_http_trace_response(response: &Response<Body>, latency: Duration, _span: &Span) {
    tracing::debug!(
        latency = latency.as_millis(),
        status = %response.status(),
        "finished processing request"
    );
}

const LOCALHOST_HOSTS: [&str; 4] = ["localhost", "127.0.0.1", "::1", "[::1]"];
const ALLOW_METHODS: &str = "GET, POST, OPTIONS";
const ALLOW_HEADERS: &str = "Content-Type, Authorization, X-Client-Id, X-App-Platform, Bittery-Client-Id, Bittery-Client-Platform, Bittery-Client-Version, Idempotency-Key, Traceparent, Tracestate, If-Match, If-None-Match";
const EXPOSE_HEADERS: &str = "X-Session-Expires, Bittery-Request-Id, Bittery-Api-Version, Bittery-Session-Expires, ETag, Retry-After";
const PERMISSIONS_POLICY: &str = "accelerometer=(), autoplay=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()";
const SECURITY_HEADERS: [(HeaderName, HeaderValue); 6] = [
    (
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    ),
    (
        HeaderName::from_static("x-frame-options"),
        HeaderValue::from_static("DENY"),
    ),
    (
        HeaderName::from_static("referrer-policy"),
        HeaderValue::from_static("no-referrer"),
    ),
    (
        HeaderName::from_static("permissions-policy"),
        HeaderValue::from_static(PERMISSIONS_POLICY),
    ),
    (
        HeaderName::from_static("x-xss-protection"),
        HeaderValue::from_static("0"),
    ),
    (
        HeaderName::from_static("x-permitted-cross-domain-policies"),
        HeaderValue::from_static("none"),
    ),
];

#[derive(Clone, Debug, Default)]
pub struct EdgeHttpConfig {
    allowed_origins: Vec<String>,
}

pub fn load_edge_http_config() -> Result<EdgeHttpConfig, String> {
    Ok(EdgeHttpConfig {
        allowed_origins: parse_cors_origins(env::var("CORS_ORIGIN").ok().as_deref())?,
    })
}

pub async fn edge_http_middleware(
    State(config): State<EdgeHttpConfig>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let path = request.uri().path().to_string();
    let origin = request
        .headers()
        .get(ORIGIN)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let is_preflight = request.method() == Method::OPTIONS;

    let mut response = if is_preflight {
        StatusCode::NO_CONTENT.into_response()
    } else {
        next.run(request).await
    };

    apply_security_headers(&path, &mut response);
    apply_cors_headers(&config, origin.as_deref(), &mut response);
    apply_public_asset_cors(&path, &mut response);
    response
}

fn json_error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

fn apply_security_headers(path: &str, response: &mut Response) {
    if is_cdn_path(path) {
        return;
    }

    for (name, value) in SECURITY_HEADERS {
        response.headers_mut().insert(name, value);
    }

    if is_sensitive_path(path) {
        response.headers_mut().insert(
            CACHE_CONTROL,
            HeaderValue::from_static("no-store, max-age=0"),
        );
        response
            .headers_mut()
            .insert(PRAGMA, HeaderValue::from_static("no-cache"));
        response
            .headers_mut()
            .insert(EXPIRES, HeaderValue::from_static("0"));
    }
}

fn apply_cors_headers(config: &EdgeHttpConfig, origin: Option<&str>, response: &mut Response) {
    let Some(origin) = origin else {
        return;
    };

    if !config
        .allowed_origins
        .iter()
        .any(|allowed| allowed == origin)
    {
        return;
    }

    let Ok(origin_value) = HeaderValue::from_str(origin) else {
        return;
    };

    response
        .headers_mut()
        .insert(ACCESS_CONTROL_ALLOW_ORIGIN, origin_value);
    response
        .headers_mut()
        .append(VARY, HeaderValue::from_static("Origin"));
    response.headers_mut().insert(
        ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static(ALLOW_METHODS),
    );
    response.headers_mut().insert(
        ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static(ALLOW_HEADERS),
    );
    response.headers_mut().insert(
        ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static(EXPOSE_HEADERS),
    );
}

// Favicons are public, unauthenticated images; clients (including origins
// that can never be allowlisted, like the desktop webview's tauri://localhost
// or browser extensions) need CORS-readable responses to inspect icon pixels
// on a canvas. An allowlisted origin set by apply_cors_headers wins.
fn apply_public_asset_cors(path: &str, response: &mut Response) {
    if !is_public_asset_path(path) {
        return;
    }
    if response.headers().contains_key(ACCESS_CONTROL_ALLOW_ORIGIN) {
        return;
    }
    response
        .headers_mut()
        .insert(ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
}

fn is_public_asset_path(path: &str) -> bool {
    path.starts_with("/favicon/")
}

fn is_sensitive_path(path: &str) -> bool {
    path == "/"
        || path == "/healthz"
        || path == "/api/v1"
        || path.starts_with("/api/v1/")
        || path == "/sync"
        || path.starts_with("/sync/")
        || path == "/webhooks"
        || path.starts_with("/webhooks/")
}

fn is_cdn_path(path: &str) -> bool {
    path.starts_with("/cdn/")
}

fn parse_cors_origins(raw_value: Option<&str>) -> Result<Vec<String>, String> {
    let Some(raw_value) = raw_value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(Vec::new());
    };

    let mut seen = std::collections::HashSet::new();
    let mut parsed_origins = Vec::new();

    for origin in raw_value
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let parsed_origin = assert_valid_origin(origin)?;
        if !seen.insert(parsed_origin.clone()) {
            return Err(format!(
                "CORS_ORIGIN contains a duplicate origin: {parsed_origin}"
            ));
        }
        parsed_origins.push(parsed_origin);
    }

    Ok(parsed_origins)
}

fn assert_valid_origin(value: &str) -> Result<String, String> {
    if value == "*" {
        return Err("CORS_ORIGIN must not contain '*'".to_string());
    }

    let parsed = Url::parse(value)
        .map_err(|_| format!("CORS_ORIGIN contains an invalid origin: {value}"))?;

    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(format!("CORS_ORIGIN must not include credentials: {value}"));
    }

    if parsed.path() != "/" || parsed.query().is_some() || parsed.fragment().is_some() {
        return Err(format!(
            "CORS_ORIGIN must be a bare origin without path, query, or hash: {value}"
        ));
    }

    match parsed.scheme() {
        "http" | "https" => {}
        _ => return Err(format!("CORS_ORIGIN must use http or https: {value}")),
    }

    if parsed.scheme() == "http" {
        let Some(host) = parsed.host_str() else {
            return Err(format!("CORS_ORIGIN contains an invalid origin: {value}"));
        };
        if !LOCALHOST_HOSTS.contains(&host) {
            return Err(format!(
                "CORS_ORIGIN must use https outside localhost development: {value}"
            ));
        }
    }

    Ok(parsed.origin().ascii_serialization())
}

#[cfg(test)]
mod tests {
    use axum::{
        body::{to_bytes, Body},
        http::{header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue, Request, StatusCode},
        response::Response,
        routing::get,
        Router,
    };
    use tower::util::ServiceExt;

    use super::{apply_public_asset_cors, catch_panic_layer, parse_cors_origins};

    #[test]
    fn adds_wildcard_cors_for_favicon_responses() {
        let mut response = Response::new(Body::empty());
        apply_public_asset_cors("/favicon/github.com", &mut response);
        assert_eq!(
            response
                .headers()
                .get(ACCESS_CONTROL_ALLOW_ORIGIN)
                .expect("favicon responses should be CORS-readable"),
            "*"
        );
    }

    #[test]
    fn keeps_allowlisted_origin_over_wildcard() {
        let mut response = Response::new(Body::empty());
        response.headers_mut().insert(
            ACCESS_CONTROL_ALLOW_ORIGIN,
            HeaderValue::from_static("https://app.example.com"),
        );
        apply_public_asset_cors("/favicon/github.com", &mut response);
        assert_eq!(
            response
                .headers()
                .get(ACCESS_CONTROL_ALLOW_ORIGIN)
                .expect("existing origin header should be preserved"),
            "https://app.example.com"
        );
    }

    #[test]
    fn does_not_add_wildcard_cors_for_other_paths() {
        for path in ["/rpc", "/sync", "/cdn/teams/1/avatar.png", "/waitlist"] {
            let mut response = Response::new(Body::empty());
            apply_public_asset_cors(path, &mut response);
            assert!(
                response
                    .headers()
                    .get(ACCESS_CONTROL_ALLOW_ORIGIN)
                    .is_none(),
                "unexpected wildcard CORS on {path}"
            );
        }
    }

    #[test]
    fn accepts_localhost_http_origins() {
        assert_eq!(
            parse_cors_origins(Some("http://localhost:3001,https://app.example.com"))
                .expect("localhost and https origins should be accepted"),
            vec![
                "http://localhost:3001".to_string(),
                "https://app.example.com".to_string(),
            ]
        );
    }

    #[test]
    fn rejects_paths_and_wildcards() {
        assert!(parse_cors_origins(Some("*")).is_err());
        assert!(parse_cors_origins(Some("https://app.example.com/path")).is_err());
    }

    /// A panicking handler — e.g. `rand` 0.10's `ThreadRng` failing to reseed —
    /// must answer the request with a `500` instead of unwinding out of the
    /// service and taking the connection with it.
    #[tokio::test]
    async fn panicking_handler_becomes_internal_server_error() {
        async fn panicking_handler() -> StatusCode {
            panic!("could not reseed ThreadRng")
        }

        let router = Router::new()
            .route("/boom", get(panicking_handler))
            .layer(catch_panic_layer());

        let response = router
            .oneshot(
                Request::builder()
                    .uri("/boom")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("catch-panic layer should answer instead of unwinding");

        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);

        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("error body should read");
        let body = String::from_utf8(body.to_vec()).expect("error body should be utf-8");
        assert!(body.contains("Internal Server Error"));
        // The panic message stays in the logs, not in the response.
        assert!(!body.contains("ThreadRng"));
    }
}
