use crate::{RequestCancellation, RuntimeError, RuntimeErrorCode};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "http-transport-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "UPPERCASE")]
pub(crate) enum HttpMethod {
    Get,
    Head,
    Post,
    Put,
    Patch,
    Delete,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "http-transport-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HttpHeader {
    pub(crate) name: String,
    pub(crate) value: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "http-transport-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HttpRequest {
    #[cfg_attr(feature = "http-transport-contract-schema", schemars(length(min = 1)))]
    dispatch_id: String,
    method: HttpMethod,
    url: String,
    headers: Vec<HttpHeader>,
    body: Vec<u8>,
    max_response_bytes: u32,
}

/// Caller-facing request intent; adapter correlation remains owned by the transport module.
pub(crate) struct HttpDispatch {
    method: HttpMethod,
    url: String,
    headers: Vec<HttpHeader>,
    body: Vec<u8>,
    max_response_bytes: u32,
}

impl HttpDispatch {
    pub(crate) fn new(
        method: HttpMethod,
        url: String,
        headers: Vec<HttpHeader>,
        body: Vec<u8>,
        max_response_bytes: u32,
    ) -> Self {
        Self {
            method,
            url,
            headers,
            body,
            max_response_bytes,
        }
    }

    fn into_request(self, dispatch_id: String) -> HttpRequest {
        HttpRequest {
            dispatch_id,
            method: self.method,
            url: self.url,
            headers: self.headers,
            body: self.body,
            max_response_bytes: self.max_response_bytes,
        }
    }
}

impl HttpRequest {
    fn validate(&self) -> Result<(), RuntimeError> {
        if self.dispatch_id.is_empty() {
            return Err(transport_invariant("HTTP dispatch identity is empty"));
        }
        if !is_absolute_url(&self.url) {
            return Err(transport_invariant("HTTP request URL is not absolute"));
        }
        Ok(())
    }
}

fn is_absolute_url(value: &str) -> bool {
    let Some((scheme, remainder)) = value.split_once("://") else {
        return false;
    };
    !scheme.is_empty()
        && scheme.bytes().enumerate().all(|(index, byte)| match byte {
            b'a'..=b'z' | b'A'..=b'Z' => true,
            b'0'..=b'9' | b'+' | b'-' | b'.' => index > 0,
            _ => false,
        })
        && !remainder.is_empty()
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "http-transport-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum HttpResponse {
    Completed {
        #[cfg_attr(feature = "http-transport-contract-schema", schemars(range(max = 599)))]
        status: u16,
        headers: Vec<HttpHeader>,
        body: Vec<u8>,
    },
    NetworkFailure,
    ResponseTooLarge,
    Cancelled,
}

impl HttpResponse {
    fn validate(&self, max_response_bytes: u32) -> Result<(), RuntimeError> {
        if let Self::Completed { status, body, .. } = self {
            if *status != 0 && !(100..=599).contains(status) {
                return Err(transport_invariant(
                    "HTTP executor returned an invalid response status",
                ));
            }
            if u64::try_from(body.len()).unwrap_or(u64::MAX) > u64::from(max_response_bytes) {
                return Err(transport_invariant(
                    "HTTP executor returned a body beyond the requested maximum",
                ));
            }
        }
        Ok(())
    }
}

#[cfg(feature = "http-transport-contract-schema")]
#[derive(schemars::JsonSchema)]
#[allow(dead_code)]
struct HttpTransportContract {
    request: HttpRequest,
    response: HttpResponse,
}

#[cfg(feature = "http-transport-contract-schema")]
#[doc(hidden)]
pub fn http_transport_contract_schema() -> schemars::Schema {
    let mut settings = schemars::generate::SchemaSettings::draft2020_12();
    settings.contract = schemars::generate::Contract::Serialize;
    settings
        .into_generator()
        .into_root_schema_for::<HttpTransportContract>()
}

#[cfg(not(target_arch = "wasm32"))]
#[async_trait]
pub trait SerializedHttpExecutor: Send + Sync {
    async fn invoke(&self, request_json: String) -> Result<String, RuntimeError>;
    fn cancel(&self, dispatch_id: &str);
}

#[cfg(target_arch = "wasm32")]
#[async_trait(?Send)]
pub trait SerializedHttpExecutor {
    async fn invoke(&self, request_json: String) -> Result<String, RuntimeError>;
    fn cancel(&self, dispatch_id: &str);
}

/// Owns response validation and cancellation policy behind the primitive host seam.
pub(crate) struct HttpTransport {
    executor: Arc<dyn SerializedHttpExecutor>,
}

struct UnavailableHttpExecutor;

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
impl SerializedHttpExecutor for UnavailableHttpExecutor {
    async fn invoke(&self, _request_json: String) -> Result<String, RuntimeError> {
        Err(transport_invariant(
            "this Runtime has no production HTTP executor",
        ))
    }

    fn cancel(&self, _dispatch_id: &str) {}
}

impl HttpTransport {
    pub(crate) fn new(executor: Arc<dyn SerializedHttpExecutor>) -> Self {
        Self { executor }
    }

    pub(crate) fn unavailable() -> Self {
        Self::new(Arc::new(UnavailableHttpExecutor))
    }

    pub(crate) async fn execute(
        &self,
        dispatch: HttpDispatch,
        cancellation: RequestCancellation,
    ) -> Result<HttpResponse, RuntimeError> {
        self.execute_with_dispatch_id(dispatch, cancellation, bittery_crypto_core::generate_uuid())
            .await
    }

    async fn execute_with_dispatch_id(
        &self,
        dispatch: HttpDispatch,
        cancellation: RequestCancellation,
        dispatch_id: String,
    ) -> Result<HttpResponse, RuntimeError> {
        let request = dispatch.into_request(dispatch_id);
        request.validate()?;
        if cancellation.is_cancelled() {
            return Ok(HttpResponse::Cancelled);
        }

        let request_json = serde_json::to_string(&request)
            .map_err(|_| transport_invariant("HTTP request could not be serialized"))?;
        let dispatch_id = request.dispatch_id.clone();
        let max_response_bytes = request.max_response_bytes;
        let invocation_started = Arc::new(AtomicBool::new(false));
        let started = invocation_started.clone();
        let executor = self.executor.clone();
        let invocation = async move {
            started.store(true, Ordering::SeqCst);
            executor.invoke(request_json).await
        };
        tokio::pin!(invocation);

        tokio::select! {
            biased;
            () = cancellation.cancelled() => {
                if invocation_started.load(Ordering::SeqCst) {
                    self.executor.cancel(&dispatch_id);
                }
                Ok(HttpResponse::Cancelled)
            }
            result = &mut invocation => {
                let response_json = result.map_err(|_| {
                    transport_invariant("HTTP executor invocation failed")
                })?;
                let response: HttpResponse = serde_json::from_str(&response_json)
                    .map_err(|_| transport_invariant("HTTP executor response is invalid"))?;
                response.validate(max_response_bytes)?;
                Ok(response)
            }
        }
    }
}

fn transport_invariant(message: &'static str) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::InvariantViolation, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{atomic::AtomicUsize, Mutex};
    use tokio::sync::{oneshot, Notify};

    struct StubExecutor {
        response: Mutex<Option<Result<String, RuntimeError>>>,
        requests: Mutex<Vec<String>>,
        cancellations: Mutex<Vec<String>>,
    }

    impl StubExecutor {
        fn responding(response: impl Into<String>) -> Self {
            Self {
                response: Mutex::new(Some(Ok(response.into()))),
                requests: Mutex::new(Vec::new()),
                cancellations: Mutex::new(Vec::new()),
            }
        }
    }

    #[async_trait]
    impl SerializedHttpExecutor for StubExecutor {
        async fn invoke(&self, request_json: String) -> Result<String, RuntimeError> {
            self.requests.lock().unwrap().push(request_json);
            self.response.lock().unwrap().take().unwrap()
        }

        fn cancel(&self, dispatch_id: &str) {
            self.cancellations
                .lock()
                .unwrap()
                .push(dispatch_id.to_owned());
        }
    }

    fn request(max_response_bytes: u32) -> HttpDispatch {
        HttpDispatch::new(
            HttpMethod::Post,
            "https://vault.example.test/auth/start".to_owned(),
            vec![
                HttpHeader {
                    name: "x-first".to_owned(),
                    value: "one".to_owned(),
                },
                HttpHeader {
                    name: "x-first".to_owned(),
                    value: "two".to_owned(),
                },
            ],
            vec![0, 1, 255],
            max_response_bytes,
        )
    }

    #[tokio::test]
    async fn serializes_exact_request_bytes_and_preserves_header_order() {
        let executor = Arc::new(StubExecutor::responding(
            r#"{"type":"completed","status":201,"headers":[{"name":"set-cookie","value":"a"},{"name":"set-cookie","value":"b"}],"body":[9,8]}"#,
        ));
        let result = HttpTransport::new(executor.clone())
            .execute_with_dispatch_id(
                request(2),
                RequestCancellation::new(),
                "dispatch-7".to_owned(),
            )
            .await
            .unwrap();

        assert_eq!(
            executor.requests.lock().unwrap().as_slice(),
            [
                r#"{"dispatchId":"dispatch-7","method":"POST","url":"https://vault.example.test/auth/start","headers":[{"name":"x-first","value":"one"},{"name":"x-first","value":"two"}],"body":[0,1,255],"maxResponseBytes":2}"#
            ]
        );
        assert_eq!(
            result,
            HttpResponse::Completed {
                status: 201,
                headers: vec![
                    HttpHeader {
                        name: "set-cookie".to_owned(),
                        value: "a".to_owned()
                    },
                    HttpHeader {
                        name: "set-cookie".to_owned(),
                        value: "b".to_owned()
                    },
                ],
                body: vec![9, 8],
            }
        );
    }

    #[tokio::test]
    async fn returns_opaque_status_zero_to_rust_policy() {
        let executor = Arc::new(StubExecutor::responding(
            r#"{"type":"completed","status":0,"headers":[],"body":[]}"#,
        ));
        let result = HttpTransport::new(executor)
            .execute_with_dispatch_id(
                request(0),
                RequestCancellation::new(),
                "dispatch-7".to_owned(),
            )
            .await
            .unwrap();
        assert_eq!(
            result,
            HttpResponse::Completed {
                status: 0,
                headers: vec![],
                body: vec![],
            }
        );
    }

    #[tokio::test]
    async fn generated_dispatch_identity_is_nonempty_and_request_validation_precedes_host_call() {
        let executor = Arc::new(StubExecutor::responding(r#"{"type":"networkFailure"}"#));
        let result = HttpTransport::new(executor.clone())
            .execute(request(0), RequestCancellation::new())
            .await
            .unwrap();
        assert_eq!(result, HttpResponse::NetworkFailure);
        let request: serde_json::Value =
            serde_json::from_str(&executor.requests.lock().unwrap()[0]).unwrap();
        assert!(!request["dispatchId"].as_str().unwrap().is_empty());

        let invalid = HttpDispatch::new(HttpMethod::Get, "relative/path".into(), vec![], vec![], 0);
        let error = HttpTransport::new(executor.clone())
            .execute_with_dispatch_id(invalid, RequestCancellation::new(), "dispatch-8".to_owned())
            .await
            .unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
        assert_eq!(executor.requests.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn cancellation_wakeup_is_not_missed_before_or_after_waiter_subscription() {
        let before = RequestCancellation::new();
        before.cancel();
        tokio::time::timeout(std::time::Duration::from_millis(50), before.cancelled())
            .await
            .unwrap();

        let after = RequestCancellation::new();
        let waiter = after.cancelled();
        tokio::pin!(waiter);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(1), &mut waiter)
                .await
                .is_err()
        );
        after.cancel();
        tokio::time::timeout(std::time::Duration::from_millis(50), waiter)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn rejects_malformed_unknown_and_oversized_responses() {
        for response in [
            r#"{"type":"completed","status":99,"headers":[],"body":[]}"#,
            r#"{"type":"completed","status":200,"headers":[],"body":[1,2],"extra":true}"#,
            r#"{"type":"newFutureVariant"}"#,
            r#"{"type":"completed","status":200,"headers":[],"body":[1,2,3]}"#,
        ] {
            let error = HttpTransport::new(Arc::new(StubExecutor::responding(response)))
                .execute_with_dispatch_id(
                    request(2),
                    RequestCancellation::new(),
                    "dispatch-7".to_owned(),
                )
                .await
                .unwrap_err();
            assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
        }
    }

    #[tokio::test]
    async fn preserves_executor_contract_errors_as_seam_failures() {
        let executor = Arc::new(StubExecutor {
            response: Mutex::new(Some(Err(RuntimeError::new(
                RuntimeErrorCode::RuntimeClosed,
                "host detail must not cross the seam",
            )))),
            requests: Mutex::new(Vec::new()),
            cancellations: Mutex::new(Vec::new()),
        });
        let error = HttpTransport::new(executor)
            .execute_with_dispatch_id(
                request(4),
                RequestCancellation::new(),
                "dispatch-7".to_owned(),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
        assert_eq!(error.message, "HTTP executor invocation failed");
    }

    struct BlockingExecutor {
        invoked: Notify,
        release: Mutex<Option<oneshot::Receiver<String>>>,
        invoke_count: AtomicUsize,
        cancel_count: AtomicUsize,
    }

    #[async_trait]
    impl SerializedHttpExecutor for BlockingExecutor {
        async fn invoke(&self, _request_json: String) -> Result<String, RuntimeError> {
            self.invoke_count.fetch_add(1, Ordering::SeqCst);
            self.invoked.notify_one();
            let release = self.release.lock().unwrap().take().unwrap();
            release.await.map_err(|_| {
                RuntimeError::new(RuntimeErrorCode::RuntimeClosed, "test response dropped")
            })
        }

        fn cancel(&self, dispatch_id: &str) {
            assert_eq!(dispatch_id, "dispatch-7");
            self.cancel_count.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[tokio::test]
    async fn cancellation_before_invoke_makes_no_host_call() {
        let (release, receiver) = oneshot::channel();
        let executor = Arc::new(BlockingExecutor {
            invoked: Notify::new(),
            release: Mutex::new(Some(receiver)),
            invoke_count: AtomicUsize::new(0),
            cancel_count: AtomicUsize::new(0),
        });
        let cancellation = RequestCancellation::new();
        cancellation.cancel();
        let result = HttpTransport::new(executor.clone())
            .execute_with_dispatch_id(request(1), cancellation, "dispatch-7".to_owned())
            .await
            .unwrap();
        drop(release);
        assert_eq!(result, HttpResponse::Cancelled);
        assert_eq!(executor.invoke_count.load(Ordering::SeqCst), 0);
        assert_eq!(executor.cancel_count.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn cancellation_during_invoke_cancels_once_and_ignores_late_completion() {
        let (release, receiver) = oneshot::channel();
        let executor = Arc::new(BlockingExecutor {
            invoked: Notify::new(),
            release: Mutex::new(Some(receiver)),
            invoke_count: AtomicUsize::new(0),
            cancel_count: AtomicUsize::new(0),
        });
        let cancellation = RequestCancellation::new();
        let transport = HttpTransport::new(executor.clone());
        let execution = transport.execute_with_dispatch_id(
            request(1),
            cancellation.clone(),
            "dispatch-7".to_owned(),
        );
        tokio::pin!(execution);

        tokio::select! {
            _ = executor.invoked.notified() => {}
            result = &mut execution => panic!("invoke completed early: {result:?}"),
        }
        cancellation.cancel();
        cancellation.cancel();
        assert_eq!(execution.await.unwrap(), HttpResponse::Cancelled);
        assert_eq!(executor.cancel_count.load(Ordering::SeqCst), 1);
        assert!(release
            .send(r#"{"type":"completed","status":200,"headers":[],"body":[]}"#.to_owned())
            .is_err());
    }
}
