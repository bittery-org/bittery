use std::{any::Any, time::Duration};

#[cfg(test)]
use std::env;

use axum::{
    body::Body,
    extract::{MatchedPath, State},
    http::{
        header::{
            HeaderName, HeaderValue, ACCESS_CONTROL_ALLOW_HEADERS, ACCESS_CONTROL_ALLOW_METHODS,
            ACCESS_CONTROL_ALLOW_ORIGIN, ACCESS_CONTROL_EXPOSE_HEADERS, CACHE_CONTROL, EXPIRES,
            ORIGIN, PRAGMA, VARY,
        },
        HeaderMap, Method, Request, StatusCode,
    },
    middleware::Next,
    response::{IntoResponse, Response},
};
use tower_http::{catch_panic::CatchPanicLayer, trace::TraceLayer};
use tracing::Span;
use url::Url;

use super::api::error::ApiError;

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

    ApiError::internal().into_response()
}

fn make_http_trace_span(request: &Request<Body>) -> Span {
    let trace_context = trace_context(request.headers());
    tracing::debug_span!(
        "request",
        method = %request.method(),
        path = %trace_path_label(request),
        version = ?request.version(),
        trace_id = %trace_context.trace_id,
        parent_span_id = %trace_context.parent_span_id,
        trace_flags = %trace_context.trace_flags,
        trace_source = trace_context.source,
        tracestate_members = trace_context.tracestate_members,
        request_id = tracing::field::Empty,
    )
}

fn trace_path_label(request: &Request<Body>) -> &str {
    request
        .extensions()
        .get::<MatchedPath>()
        .map(MatchedPath::as_str)
        .unwrap_or("<unmatched>")
}

fn on_http_trace_request(request: &Request<Body>, _span: &Span) {
    tracing::debug!(method = %request.method(), "started processing request");
}

fn on_http_trace_response(response: &Response<Body>, latency: Duration, span: &Span) {
    if let Some(request_id) = response
        .headers()
        .get("bittery-request-id")
        .and_then(|value| value.to_str().ok())
    {
        span.record("request_id", request_id);
    }
    tracing::debug!(
        latency = latency.as_millis(),
        status = %response.status(),
        "finished processing request"
    );
}

#[derive(Debug, PartialEq, Eq)]
struct TraceContext {
    trace_id: String,
    parent_span_id: String,
    trace_flags: String,
    source: &'static str,
    tracestate_members: usize,
}

fn trace_context(headers: &HeaderMap) -> TraceContext {
    parse_remote_trace_context(headers).unwrap_or_else(|| TraceContext {
        trace_id: uuid::Uuid::new_v4().simple().to_string(),
        parent_span_id: String::new(),
        trace_flags: "00".to_string(),
        source: "generated",
        tracestate_members: 0,
    })
}

fn parse_remote_trace_context(headers: &HeaderMap) -> Option<TraceContext> {
    let traceparent = headers.get("traceparent")?.to_str().ok()?;
    let mut parts = traceparent.split('-');
    let version = parts.next()?;
    let trace_id = parts.next()?;
    let parent_span_id = parts.next()?;
    let trace_flags = parts.next()?;
    if parts.next().is_some()
        || version.len() != 2
        || version.eq_ignore_ascii_case("ff")
        || !is_lower_hex(version)
        || trace_id.len() != 32
        || !is_lower_hex(trace_id)
        || trace_id.bytes().all(|byte| byte == b'0')
        || parent_span_id.len() != 16
        || !is_lower_hex(parent_span_id)
        || parent_span_id.bytes().all(|byte| byte == b'0')
        || trace_flags.len() != 2
        || !is_lower_hex(trace_flags)
    {
        return None;
    }

    let tracestate_members = match headers.get("tracestate") {
        Some(value) => parse_tracestate_member_count(value.to_str().ok()?)?,
        None => 0,
    };

    Some(TraceContext {
        trace_id: trace_id.to_string(),
        parent_span_id: parent_span_id.to_string(),
        trace_flags: trace_flags.to_string(),
        source: "remote",
        tracestate_members,
    })
}

fn is_lower_hex(value: &str) -> bool {
    value
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn parse_tracestate_member_count(value: &str) -> Option<usize> {
    if value.is_empty() || value.len() > 512 {
        return None;
    }
    let members = value.split(',').collect::<Vec<_>>();
    if members.len() > 32 {
        return None;
    }
    for member in &members {
        let member = member.trim();
        let (key, value) = member.split_once('=')?;
        if key.is_empty()
            || value.is_empty()
            || !key.bytes().all(|byte| {
                byte.is_ascii_lowercase()
                    || byte.is_ascii_digit()
                    || matches!(byte, b'_' | b'-' | b'*' | b'/' | b'@')
            })
            || value
                .bytes()
                .any(|byte| !(0x20..=0x7e).contains(&byte) || matches!(byte, b',' | b'='))
        {
            return None;
        }
    }
    Some(members.len())
}

const LOCALHOST_HOSTS: [&str; 4] = ["localhost", "127.0.0.1", "::1", "[::1]"];
const ALLOW_METHODS: &str = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
const ALLOW_HEADERS: &str = "Content-Type, Authorization, Bittery-Client-Id, Bittery-Client-Platform, Bittery-Client-Version, Idempotency-Key, Traceparent, Tracestate, If-Match, If-None-Match";
const EXPOSE_HEADERS: &str = "Bittery-Request-Id, Bittery-Api-Version, Bittery-Session-Expires, ETag, Retry-After, Idempotency-Replayed";
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

const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Debug)]
pub struct EdgeHttpConfig {
    allowed_origins: Vec<String>,
    request_timeout: Duration,
}

impl Default for EdgeHttpConfig {
    fn default() -> Self {
        Self {
            allowed_origins: Vec::new(),
            request_timeout: DEFAULT_REQUEST_TIMEOUT,
        }
    }
}

impl EdgeHttpConfig {
    pub(crate) fn from_server_config(config: &crate::config::ServerConfig) -> Result<Self, String> {
        Ok(Self {
            allowed_origins: parse_cors_origins(config.cors_origin.as_deref())?,
            request_timeout: config.request_timeout,
        })
    }

    pub(crate) fn request_timeout(&self) -> Duration {
        self.request_timeout
    }

    #[cfg(test)]
    pub(crate) fn with_request_timeout(mut self, request_timeout: Duration) -> Self {
        self.request_timeout = request_timeout;
        self
    }

    #[cfg(test)]
    pub(crate) fn with_allowed_origin(mut self, allowed_origin: &str) -> Self {
        self.allowed_origins.push(allowed_origin.to_string());
        self
    }
}

#[cfg(test)]
pub fn load_edge_http_config() -> Result<EdgeHttpConfig, String> {
    Ok(EdgeHttpConfig {
        allowed_origins: parse_cors_origins(env::var("CORS_ORIGIN").ok().as_deref())?,
        request_timeout: request_timeout_from_value(
            env::var("REQUEST_TIMEOUT_SECONDS").ok().as_deref(),
        )?,
    })
}

#[cfg(test)]
fn request_timeout_from_value(raw_value: Option<&str>) -> Result<Duration, String> {
    let Some(raw_value) = raw_value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(DEFAULT_REQUEST_TIMEOUT);
    };
    let seconds = raw_value.parse::<u64>().map_err(|_| {
        "REQUEST_TIMEOUT_SECONDS must be a positive integer number of seconds".to_string()
    })?;
    if seconds == 0 {
        return Err(
            "REQUEST_TIMEOUT_SECONDS must be a positive integer number of seconds".to_string(),
        );
    }
    Ok(Duration::from_secs(seconds))
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
        || path == "/api/meta"
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
    use std::time::Duration;

    use axum::{
        body::{to_bytes, Body},
        http::{
            header::{
                ACCESS_CONTROL_ALLOW_HEADERS, ACCESS_CONTROL_ALLOW_METHODS,
                ACCESS_CONTROL_ALLOW_ORIGIN, ACCESS_CONTROL_EXPOSE_HEADERS, CACHE_CONTROL,
                CONTENT_TYPE,
            },
            HeaderMap, HeaderValue, Request, StatusCode,
        },
        middleware::Next,
        response::Response,
        routing::get,
        Router,
    };
    use tower::util::ServiceExt;

    use super::{
        apply_cors_headers, apply_public_asset_cors, apply_security_headers, catch_panic_layer,
        parse_cors_origins, request_timeout_from_value, trace_context, trace_path_label,
        EdgeHttpConfig,
    };

    async fn assert_matched_trace_path(request: Request<Body>, next: Next) -> Response {
        assert_eq!(trace_path_label(&request), "/api/v1/share-links/{token}");
        next.run(request).await
    }

    #[test]
    fn request_timeout_defaults_to_thirty_seconds_and_accepts_an_override() {
        assert_eq!(
            request_timeout_from_value(None).unwrap(),
            Duration::from_secs(30)
        );
        assert_eq!(
            request_timeout_from_value(Some("12")).unwrap(),
            Duration::from_secs(12)
        );
    }

    #[test]
    fn request_timeout_rejects_zero_and_non_numeric_values() {
        for value in ["0", "later"] {
            assert_eq!(
                request_timeout_from_value(Some(value)).unwrap_err(),
                "REQUEST_TIMEOUT_SECONDS must be a positive integer number of seconds"
            );
        }
    }

    #[test]
    fn api_meta_uses_no_store_to_avoid_stale_compatibility_decisions() {
        let mut response = Response::new(Body::empty());

        apply_security_headers("/api/meta", &mut response);

        assert_eq!(
            response.headers().get(CACHE_CONTROL),
            Some(&HeaderValue::from_static("no-store, max-age=0"))
        );
    }

    #[test]
    fn valid_w3c_trace_context_is_bound_without_retaining_tracestate_values() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "traceparent",
            HeaderValue::from_static("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"),
        );
        headers.insert(
            "tracestate",
            HeaderValue::from_static("vendor=opaque,second=value"),
        );

        let context = trace_context(&headers);

        assert_eq!(context.trace_id, "4bf92f3577b34da6a3ce929d0e0e4736");
        assert_eq!(context.parent_span_id, "00f067aa0ba902b7");
        assert_eq!(context.trace_flags, "01");
        assert_eq!(context.source, "remote");
        assert_eq!(context.tracestate_members, 2);
        assert!(!format!("{context:?}").contains("opaque"));
    }

    #[test]
    fn malformed_trace_headers_fall_back_without_retaining_their_contents() {
        let secret = "Bearer-secret-that-must-not-be-logged";
        let mut headers = HeaderMap::new();
        headers.insert(
            "traceparent",
            HeaderValue::from_str(&format!("00-{secret}-bad-01")).unwrap(),
        );
        headers.insert("tracestate", HeaderValue::from_str(secret).unwrap());

        let context = trace_context(&headers);

        assert_eq!(context.source, "generated");
        assert_eq!(context.trace_id.len(), 32);
        assert!(context.parent_span_id.is_empty());
        assert_eq!(context.tracestate_members, 0);
        assert!(!format!("{context:?}").contains(secret));
    }

    #[tokio::test]
    async fn trace_paths_use_templates_and_never_raw_uri_values() {
        let token = "share-token-that-must-not-reach-traces";
        let router = Router::new()
            .route(
                "/api/v1/share-links/{token}",
                get(|| async { StatusCode::NO_CONTENT }),
            )
            .layer(axum::middleware::from_fn(assert_matched_trace_path));

        let response = router
            .oneshot(
                Request::builder()
                    .uri(format!("/api/v1/share-links/{token}"))
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("route should respond");
        assert_eq!(response.status(), StatusCode::NO_CONTENT);

        let request = Request::builder()
            .uri(format!("/not-found/{token}"))
            .body(Body::empty())
            .expect("request should build");
        assert_eq!(trace_path_label(&request), "<unmatched>");
    }

    #[test]
    fn api_cors_preflight_allows_every_supported_method_and_header() {
        let config = EdgeHttpConfig {
            allowed_origins: vec!["https://app.example.com".to_string()],
            ..EdgeHttpConfig::default()
        };
        let mut response = Response::new(Body::empty());

        apply_cors_headers(&config, Some("https://app.example.com"), &mut response);

        assert_eq!(
            response.headers().get(ACCESS_CONTROL_ALLOW_METHODS),
            Some(&HeaderValue::from_static(
                "GET, POST, PUT, PATCH, DELETE, OPTIONS"
            ))
        );
        let allowed_headers = response
            .headers()
            .get(ACCESS_CONTROL_ALLOW_HEADERS)
            .expect("allowlisted API origin should receive request header policy")
            .to_str()
            .expect("header policy should be ASCII");
        for required in [
            "Content-Type",
            "Authorization",
            "Bittery-Client-Id",
            "Bittery-Client-Platform",
            "Bittery-Client-Version",
            "Idempotency-Key",
            "Traceparent",
            "Tracestate",
            "If-Match",
            "If-None-Match",
        ] {
            assert!(
                allowed_headers.split(", ").any(|header| header == required),
                "missing required CORS header {required}"
            );
        }
    }

    #[test]
    fn api_cors_exposes_idempotency_replay_status() {
        let config = EdgeHttpConfig {
            allowed_origins: vec!["https://app.example.com".to_string()],
            ..EdgeHttpConfig::default()
        };
        let mut response = Response::new(Body::empty());

        apply_cors_headers(&config, Some("https://app.example.com"), &mut response);

        let exposed_headers = response
            .headers()
            .get(ACCESS_CONTROL_EXPOSE_HEADERS)
            .expect("allowlisted API origin should receive exposed header policy")
            .to_str()
            .expect("header policy should be ASCII");
        assert!(
            exposed_headers
                .split(", ")
                .any(|header| header == "Idempotency-Replayed"),
            "idempotency replays must be observable to browser clients"
        );
    }

    #[test]
    fn api_cors_does_not_echo_an_origin_outside_the_exact_allowlist() {
        let config = EdgeHttpConfig {
            allowed_origins: vec!["https://app.example.com".to_string()],
            ..EdgeHttpConfig::default()
        };
        let mut response = Response::new(Body::empty());

        apply_cors_headers(
            &config,
            Some("https://app.example.com.evil.test"),
            &mut response,
        );

        assert!(
            response
                .headers()
                .get(ACCESS_CONTROL_ALLOW_ORIGIN)
                .is_none(),
            "CORS allowlisting must compare complete origins"
        );
    }

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

        assert_eq!(
            response.headers().get(CONTENT_TYPE),
            Some(&HeaderValue::from_static("application/problem+json"))
        );
        let request_id = response
            .headers()
            .get("bittery-request-id")
            .expect("panic response should carry a request ID")
            .to_str()
            .unwrap()
            .to_string();

        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("error body should read");
        let body: serde_json::Value =
            serde_json::from_slice(&body).expect("panic problem should be JSON");
        assert_eq!(body["status"], 500);
        assert_eq!(body["code"], "INTERNAL_ERROR");
        assert_eq!(body["requestId"], request_id);
        assert!(!body.to_string().contains("ThreadRng"));
    }
}
