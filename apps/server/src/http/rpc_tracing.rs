use std::{env, time::Instant};

use async_stream::stream;
use axum::{
    body::{to_bytes, Body, Bytes},
    http::{Request, StatusCode},
    middleware::Next,
    response::Response,
    Error,
};
use serde_json::Value;
use tracing::{info, warn, Instrument, Span};

use crate::services::session::{RequestMetadata, VerifiedSession};

const RPC_BODY_LIMIT_BYTES: usize = 16 * 1024 * 1024;
const DEFAULT_SLOW_RPC_MS: u64 = 500;

#[derive(Debug, Clone, PartialEq, Eq)]
struct RpcCallRef {
    id: Option<Value>,
    method: String,
}

fn slow_rpc_threshold_ms() -> u64 {
    env::var("BITTERY_RPC_SLOW_MS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(DEFAULT_SLOW_RPC_MS)
}

fn parse_single_call(value: &Value) -> Option<RpcCallRef> {
    let method = value.get("method")?.as_str()?.to_string();
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

fn error_label(error: &Value) -> String {
    if let Some(code) = error
        .get("data")
        .and_then(|data| data.get("code"))
        .and_then(Value::as_str)
    {
        return code.to_string();
    }

    error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("UNKNOWN")
        .to_string()
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

    let mut errors = Vec::new();

    for call in calls {
        let Some(id) = &call.id else {
            continue;
        };

        for response in &responses {
            if response.get("id") == Some(id) {
                if let Some(error) = response.get("error") {
                    errors.push(format!("{}: {}", call.method, error_label(error)));
                }
                break;
            }
        }
    }

    if errors.is_empty() && calls.len() == 1 {
        if let Some(error) = value.get("error") {
            return format!("{}: {}", calls[0].method, error_label(error));
        }
    }

    if errors.is_empty() {
        "none".to_string()
    } else {
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
    latency_ms: u64,
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
                        let remaining = (RPC_BODY_LIMIT_BYTES + 1).saturating_sub(response_bytes.len());
                        let bytes_to_copy = bytes.len().min(remaining);
                        response_bytes.extend_from_slice(&bytes[..bytes_to_copy]);
                        response_too_large = response_bytes.len() > RPC_BODY_LIMIT_BYTES;
                    }

                    yield Ok::<Bytes, Error>(bytes);
                }
                Err(error) => {
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
        let _span_guard = span.enter();
        log_rpc_completion(latency_ms, threshold_ms, &rpc_errors);
    })
}

pub async fn rpc_tracing_middleware(request: Request<Body>, next: Next) -> Response {
    let (parts, body) = request.into_parts();
    let bytes = match to_bytes(body, RPC_BODY_LIMIT_BYTES + 1).await {
        Ok(bytes) => bytes,
        Err(error) => {
            warn!(error = %error, "failed to read rpc request body");
            let mut response = Response::new(Body::from("failed to read request body"));
            *response.status_mut() = StatusCode::INTERNAL_SERVER_ERROR;
            return response;
        }
    };

    let calls = parse_rpc_calls(&bytes);
    let methods = if calls.is_empty() {
        "unknown".to_string()
    } else {
        calls
            .iter()
            .map(|call| call.method.as_str())
            .collect::<Vec<_>>()
            .join(",")
    };
    let batch = calls.len();

    let user_id = parts
        .extensions
        .get::<VerifiedSession>()
        .map(|session| session.user_id.as_str())
        .unwrap_or("anonymous");
    let session_id = parts
        .extensions
        .get::<VerifiedSession>()
        .map(|session| session.session_id.as_str())
        .unwrap_or("-");
    let client_id = parts
        .extensions
        .get::<RequestMetadata>()
        .and_then(|metadata| metadata.client_id.as_deref())
        .unwrap_or("-");
    let platform = parts
        .extensions
        .get::<RequestMetadata>()
        .and_then(|metadata| metadata.app_platform.as_deref())
        .unwrap_or("-");

    let span = tracing::info_span!(
        "rpc",
        methods = %methods,
        batch = batch,
        user_id = user_id,
        session_id = session_id,
        client_id = client_id,
        platform = platform,
    );
    let response_span = span.clone();

    let request = Request::from_parts(parts, Body::from(bytes));
    let start = Instant::now();

    async move {
        let response = next.run(request).await;
        let latency_ms = start.elapsed().as_millis() as u64;
        let threshold_ms = slow_rpc_threshold_ms();

        let (parts, body) = response.into_parts();
        Response::from_parts(
            parts,
            traced_response_body(body, calls, latency_ms, threshold_ms, response_span),
        )
    }
    .instrument(span)
    .await
}

#[cfg(test)]
mod tests {
    use super::{parse_rpc_calls, summarize_rpc_errors, RpcCallRef};
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
