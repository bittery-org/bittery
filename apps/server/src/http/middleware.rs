use std::{cell::Cell, env, time::Duration};

use axum::{
    body::{to_bytes, Body},
    extract::State,
    http::{
        header::{
            HeaderName, HeaderValue, ACCESS_CONTROL_ALLOW_HEADERS, ACCESS_CONTROL_ALLOW_METHODS,
            ACCESS_CONTROL_ALLOW_ORIGIN, ACCESS_CONTROL_EXPOSE_HEADERS, CACHE_CONTROL,
            CONTENT_TYPE, EXPIRES, ORIGIN, PRAGMA, VARY,
        },
        Method, Request, StatusCode,
    },
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use tower_http::trace::TraceLayer;
use tracing::Span;
use url::Url;

thread_local! {
    static SKIP_HTTP_TRACE: Cell<bool> = const { Cell::new(false) };
}

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

fn make_http_trace_span(request: &Request<Body>) -> Span {
    if request.uri().path() == "/rpc" {
        tracing::trace_span!("http")
    } else {
        tracing::debug_span!(
            "request",
            method = %request.method(),
            uri = %request.uri(),
            version = ?request.version(),
        )
    }
}

fn on_http_trace_request(request: &Request<Body>, _span: &Span) {
    let skip = request.uri().path() == "/rpc";
    SKIP_HTTP_TRACE.set(skip);
    if !skip {
        tracing::debug!("started processing request");
    }
}

fn on_http_trace_response(response: &Response<Body>, latency: Duration, _span: &Span) {
    if !SKIP_HTTP_TRACE.get() {
        tracing::debug!(
            latency = latency.as_millis(),
            status = %response.status(),
            "finished processing request"
        );
    }
}

const LOCALHOST_HOSTS: [&str; 4] = ["localhost", "127.0.0.1", "::1", "[::1]"];
const RPC_JSON_BODY_LIMIT_BYTES: usize = 16 * 1024 * 1024;
const ALLOW_METHODS: &str = "GET, POST, OPTIONS";
const ALLOW_HEADERS: &str = "Content-Type, Authorization, X-Client-Id, X-App-Platform";
const EXPOSE_HEADERS: &str = "X-Session-Expires";
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
    response
}

pub async fn rpc_request_guard_middleware(request: Request<Body>, next: Next) -> Response {
    if matches!(
        request.method(),
        &Method::GET | &Method::HEAD | &Method::OPTIONS
    ) {
        return next.run(request).await;
    }

    if !is_json_content_type(
        request
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok()),
    ) {
        return json_error(StatusCode::UNSUPPORTED_MEDIA_TYPE, "Unsupported Media Type");
    }

    if let Some(content_length) = request
        .headers()
        .get(axum::http::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
    {
        if content_length > RPC_JSON_BODY_LIMIT_BYTES {
            return json_error(StatusCode::PAYLOAD_TOO_LARGE, "Payload Too Large");
        }
    }

    let (parts, body) = request.into_parts();
    let bytes = match to_bytes(body, RPC_JSON_BODY_LIMIT_BYTES + 1).await {
        Ok(bytes) => bytes,
        Err(_) => return json_error(StatusCode::PAYLOAD_TOO_LARGE, "Payload Too Large"),
    };

    if bytes.len() > RPC_JSON_BODY_LIMIT_BYTES {
        return json_error(StatusCode::PAYLOAD_TOO_LARGE, "Payload Too Large");
    }

    let request = Request::from_parts(parts, Body::from(bytes));
    next.run(request).await
}

fn json_error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

fn is_json_content_type(content_type: Option<&str>) -> bool {
    content_type
        .map(|value| value.to_ascii_lowercase().starts_with("application/json"))
        .unwrap_or(false)
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

fn is_sensitive_path(path: &str) -> bool {
    path == "/"
        || path == "/healthz"
        || path == "/rpc"
        || path.starts_with("/rpc/")
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
    use super::parse_cors_origins;

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
}
