use std::{collections::HashMap, env, sync::OnceLock, time::Instant};

use async_stream::stream;
use axum::{
    body::{Body, Bytes},
    http::Request,
    middleware::Next,
    response::Response,
    Error,
};
use serde_json::Value;
use tracing::{info, warn, Instrument, Span};

use crate::services::session::VerifiedSession;

const RPC_TRACE_PARSE_LIMIT_BYTES: usize = 256 * 1024;
const DEFAULT_SLOW_RPC_MS: u64 = 500;
const MAX_LABEL_CHARS: usize = 128;
const MAX_METHODS_IN_LABEL: usize = 16;
const MAX_RPC_ERRORS_IN_LABEL: usize = 16;

#[derive(Debug, Clone, PartialEq, Eq)]
struct RpcCallRef {
    id: Option<Value>,
    method: String,
}

#[derive(Debug, Clone)]
pub(crate) struct RpcTraceRequest {
    calls: Vec<RpcCallRef>,
    methods: String,
    batch: usize,
}

impl RpcTraceRequest {
    pub(crate) fn from_body(body: &[u8]) -> Self {
        if body.len() > RPC_TRACE_PARSE_LIMIT_BYTES {
            return Self::from_calls(vec![RpcCallRef {
                id: None,
                method: "body_too_large".to_string(),
            }]);
        }

        Self::from_calls(parse_rpc_calls(body))
    }

    fn unknown() -> Self {
        Self::from_calls(vec![RpcCallRef {
            id: None,
            method: "unknown".to_string(),
        }])
    }

    fn from_calls(calls: Vec<RpcCallRef>) -> Self {
        let methods = summarize_methods(&calls);
        let batch = calls.len();
        Self {
            calls,
            methods,
            batch,
        }
    }
}

fn slow_rpc_threshold_ms() -> u64 {
    static THRESHOLD_MS: OnceLock<u64> = OnceLock::new();
    *THRESHOLD_MS.get_or_init(|| {
        env::var("BITTERY_RPC_SLOW_MS")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(DEFAULT_SLOW_RPC_MS)
    })
}

fn sanitize_label(value: &str) -> String {
    let mut label = String::new();

    for character in value.chars().take(MAX_LABEL_CHARS) {
        if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-' | '/' | ':') {
            label.push(character);
        } else {
            label.push('_');
        }
    }

    if label.is_empty() {
        "unknown".to_string()
    } else {
        label
    }
}

fn parse_single_call(value: &Value) -> Option<RpcCallRef> {
    let method = sanitize_label(value.get("method")?.as_str()?);
    let id = value.get("id").cloned();
    Some(RpcCallRef { id, method })
}

fn parse_rpc_calls(body: &[u8]) -> Vec<RpcCallRef> {
    let Ok(value) = serde_json::from_slice::<Value>(body) else {
        return vec![RpcCallRef {
            id: None,
            method: "unknown".to_string(),
        }];
    };

    if let Some(entries) = value.as_array() {
        return entries.iter().filter_map(parse_single_call).collect();
    }

    parse_single_call(&value).into_iter().collect()
}

fn summarize_methods(calls: &[RpcCallRef]) -> String {
    if calls.is_empty() {
        return "unknown".to_string();
    }

    let mut methods = calls
        .iter()
        .take(MAX_METHODS_IN_LABEL)
        .map(|call| call.method.as_str())
        .collect::<Vec<_>>()
        .join(",");

    if calls.len() > MAX_METHODS_IN_LABEL {
        methods.push_str(",truncated");
    }

    methods
}

fn error_label(error: &Value) -> String {
    if let Some(code) = error
        .get("data")
        .and_then(|data| data.get("code"))
        .and_then(Value::as_str)
    {
        return sanitize_label(code);
    }

    error
        .get("code")
        .and_then(Value::as_i64)
        .map(|code| format!("JSON_RPC_{code}"))
        .unwrap_or_else(|| "UNKNOWN".to_string())
}

fn summarize_rpc_errors(calls: &[RpcCallRef], response_body: &[u8]) -> String {
    let Ok(value) = serde_json::from_slice::<Value>(response_body) else {
        return "unparseable".to_string();
    };

    let responses: Vec<&Value> = if let Some(entries) = value.as_array() {
        entries.iter().collect()
    } else {
        vec![&value]
    };

    let calls_by_id = calls
        .iter()
        .filter_map(|call| {
            call.id
                .as_ref()
                .map(|id| (id.to_string(), call.method.as_str()))
        })
        .collect::<HashMap<_, _>>();

    let mut errors = responses
        .iter()
        .filter_map(|response| {
            let error = response.get("error")?;
            let id = response.get("id")?;
            let method = calls_by_id.get(&id.to_string())?;
            Some(format!("{}: {}", method, error_label(error)))
        })
        .take(MAX_RPC_ERRORS_IN_LABEL + 1)
        .collect::<Vec<_>>();

    if errors.is_empty() && calls.len() == 1 {
        if let Some(error) = value.get("error") {
            return format!("{}: {}", calls[0].method, error_label(error));
        }
    }

    if errors.is_empty() {
        "none".to_string()
    } else {
        if errors.len() > MAX_RPC_ERRORS_IN_LABEL {
            errors.truncate(MAX_RPC_ERRORS_IN_LABEL);
            errors.push("truncated".to_string());
        }
        errors.join(", ")
    }
}

fn log_rpc_completion(latency_ms: u64, threshold_ms: u64, rpc_errors: &str) {
    if latency_ms > threshold_ms {
        warn!(
            latency_ms,
            threshold_ms,
            rpc_errors = %rpc_errors,
            "slow rpc request"
        );
    } else {
        info!(
            latency_ms,
            rpc_errors = %rpc_errors,
            "rpc request completed"
        );
    }
}

fn log_rpc_body_read_failed(latency_ms: u64, threshold_ms: u64, error: &impl std::fmt::Display) {
    if latency_ms > threshold_ms {
        warn!(
            latency_ms,
            threshold_ms,
            rpc_errors = "body_read_failed",
            error = %error,
            "slow rpc request"
        );
    } else {
        warn!(
            latency_ms,
            rpc_errors = "body_read_failed",
            error = %error,
            "rpc response body read failed"
        );
    }
}

fn traced_response_body(
    body: Body,
    calls: Vec<RpcCallRef>,
    start: Instant,
    threshold_ms: u64,
    span: Span,
) -> Body {
    Body::from_stream(stream! {
        let mut response_bytes = Vec::new();
        let mut response_too_large = false;

        for await chunk in body.into_data_stream() {
            match chunk {
                Ok(bytes) => {
                    if !response_too_large {
                        let remaining = (RPC_TRACE_PARSE_LIMIT_BYTES + 1).saturating_sub(response_bytes.len());
                        let bytes_to_copy = bytes.len().min(remaining);
                        response_bytes.extend_from_slice(&bytes[..bytes_to_copy]);
                        response_too_large = response_bytes.len() > RPC_TRACE_PARSE_LIMIT_BYTES;
                    }

                    yield Ok::<Bytes, Error>(bytes);
                }
                Err(error) => {
                    let latency_ms = start.elapsed().as_millis() as u64;
                    let _span_guard = span.enter();
                    log_rpc_body_read_failed(latency_ms, threshold_ms, &error);
                    yield Err::<Bytes, Error>(error);
                    return;
                }
            }
        }

        let rpc_errors = if response_too_large {
            "body_too_large".to_string()
        } else {
            summarize_rpc_errors(&calls, &response_bytes)
        };
        let latency_ms = start.elapsed().as_millis() as u64;
        let _span_guard = span.enter();
        log_rpc_completion(latency_ms, threshold_ms, &rpc_errors);
    })
}

pub async fn rpc_tracing_middleware(request: Request<Body>, next: Next) -> Response {
    let trace_request = request
        .extensions()
        .get::<RpcTraceRequest>()
        .cloned()
        .unwrap_or_else(RpcTraceRequest::unknown);
    let authenticated = request.extensions().get::<VerifiedSession>().is_some();

    let span = tracing::info_span!(
        "rpc",
        methods = %trace_request.methods,
        batch = trace_request.batch,
        authenticated = authenticated,
    );
    let response_span = span.clone();

    let start = Instant::now();
    let threshold_ms = slow_rpc_threshold_ms();

    async move {
        let response = next.run(request).await;

        let (parts, body) = response.into_parts();
        Response::from_parts(
            parts,
            traced_response_body(
                body,
                trace_request.calls,
                start,
                threshold_ms,
                response_span,
            ),
        )
    }
    .instrument(span)
    .await
}

#[cfg(test)]
mod tests {
    use super::{parse_rpc_calls, summarize_rpc_errors, RpcCallRef, RpcTraceRequest};
    use serde_json::json;

    #[test]
    fn parse_rpc_calls_single_request() {
        let body = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "vault.list",
            "params": []
        });

        assert_eq!(
            parse_rpc_calls(body.to_string().as_bytes()),
            vec![RpcCallRef {
                id: Some(json!(1)),
                method: "vault.list".to_string(),
            }]
        );
    }

    #[test]
    fn parse_rpc_calls_batch_request() {
        let body = json!([
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "vault.list",
                "params": []
            },
            {
                "jsonrpc": "2.0",
                "id": "abc",
                "method": "sync.getState",
                "params": []
            }
        ]);

        assert_eq!(
            parse_rpc_calls(body.to_string().as_bytes()),
            vec![
                RpcCallRef {
                    id: Some(json!(1)),
                    method: "vault.list".to_string(),
                },
                RpcCallRef {
                    id: Some(json!("abc")),
                    method: "sync.getState".to_string(),
                }
            ]
        );
    }

    #[test]
    fn parse_rpc_calls_notification_has_no_id() {
        let body = json!({
            "jsonrpc": "2.0",
            "method": "sync.notify",
            "params": []
        });

        assert_eq!(
            parse_rpc_calls(body.to_string().as_bytes()),
            vec![RpcCallRef {
                id: None,
                method: "sync.notify".to_string(),
            }]
        );
    }

    #[test]
    fn parse_rpc_calls_malformed_body() {
        assert_eq!(
            parse_rpc_calls(b"not-json"),
            vec![RpcCallRef {
                id: None,
                method: "unknown".to_string(),
            }]
        );
    }

    #[test]
    fn trace_request_does_not_parse_large_body() {
        let body = vec![b' '; super::RPC_TRACE_PARSE_LIMIT_BYTES + 1];
        let trace_request = RpcTraceRequest::from_body(&body);

        assert_eq!(trace_request.methods, "body_too_large");
        assert_eq!(trace_request.batch, 1);
    }

    #[test]
    fn parse_rpc_calls_sanitizes_method_labels() {
        let body = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "vault.get\nsecret",
            "params": []
        });

        assert_eq!(
            parse_rpc_calls(body.to_string().as_bytes()),
            vec![RpcCallRef {
                id: Some(json!(1)),
                method: "vault.get_secret".to_string(),
            }]
        );
    }

    #[test]
    fn summarize_rpc_errors_single_success() {
        let calls = vec![RpcCallRef {
            id: Some(json!(1)),
            method: "vault.list".to_string(),
        }];
        let response = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": []
        });

        assert_eq!(
            summarize_rpc_errors(&calls, response.to_string().as_bytes()),
            "none"
        );
    }

    #[test]
    fn summarize_rpc_errors_single_error_with_app_code() {
        let calls = vec![RpcCallRef {
            id: Some(json!(1)),
            method: "vault.get".to_string(),
        }];
        let response = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "error": {
                "code": -32000,
                "message": "Forbidden",
                "data": { "code": "FORBIDDEN" }
            }
        });

        assert_eq!(
            summarize_rpc_errors(&calls, response.to_string().as_bytes()),
            "vault.get: FORBIDDEN"
        );
    }

    #[test]
    fn summarize_rpc_errors_does_not_log_raw_error_message() {
        let calls = vec![RpcCallRef {
            id: Some(json!(1)),
            method: "vault.get".to_string(),
        }];
        let response = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "error": {
                "code": -32000,
                "message": "contains user supplied details"
            }
        });

        assert_eq!(
            summarize_rpc_errors(&calls, response.to_string().as_bytes()),
            "vault.get: JSON_RPC_-32000"
        );
    }

    #[test]
    fn summarize_rpc_errors_batch_mixed_results() {
        let calls = vec![
            RpcCallRef {
                id: Some(json!(1)),
                method: "vault.list".to_string(),
            },
            RpcCallRef {
                id: Some(json!(2)),
                method: "vault.get".to_string(),
            },
        ];
        let response = json!([
            {
                "jsonrpc": "2.0",
                "id": 1,
                "result": []
            },
            {
                "jsonrpc": "2.0",
                "id": 2,
                "error": {
                    "code": -32000,
                    "message": "Not found",
                    "data": { "code": "NOT_FOUND" }
                }
            }
        ]);

        assert_eq!(
            summarize_rpc_errors(&calls, response.to_string().as_bytes()),
            "vault.get: NOT_FOUND"
        );
    }
}
