//! Pull-based response bytes. Session, SSE framing, and reconnect policy remain above this seam.

use super::*;

#[derive(Debug, Serialize, Deserialize)]
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
pub enum HttpStreamCommand {
    // maxResponseBytes bounds each pulled chunk, never the connection's lifetime.
    OpenStream {
        request: HttpRequest,
    },
    ReadStream {
        #[cfg_attr(feature = "http-transport-contract-schema", schemars(length(min = 1)))]
        dispatch_id: String,
    },
}

#[derive(Debug, Serialize, Deserialize)]
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
pub enum HttpStreamResponse {
    Opened {
        #[cfg_attr(feature = "http-transport-contract-schema", schemars(range(max = 599)))]
        status: u16,
        headers: Vec<HttpHeader>,
    },
    Chunk {
        #[cfg_attr(feature = "http-transport-contract-schema", schemars(length(min = 1)))]
        bytes: Vec<u8>,
    },
    Ended,
    NetworkFailure,
    ResponseTooLarge,
    Cancelled,
}

pub(crate) enum HttpStreamOpening {
    Opened {
        status: u16,
        headers: Vec<HttpHeader>,
        stream: HttpByteStream,
    },
    Unavailable,
    Cancelled,
}

pub(crate) struct HttpByteStream {
    lease: Option<HttpDispatchLease>,
    max_chunk_bytes: u32,
}

impl HttpTransport {
    pub(crate) async fn open_stream(
        &self,
        dispatch: HttpDispatch,
        cancellation: RequestCancellation,
    ) -> Result<HttpStreamOpening, RuntimeError> {
        let request = dispatch.into_request(bittery_crypto_core::generate_uuid());
        request.validate()?;
        if request.max_response_bytes == 0 {
            return Err(transport_invariant("HTTP stream chunk limit is zero"));
        }
        if cancellation.is_cancelled() {
            return Ok(HttpStreamOpening::Cancelled);
        }
        let lease = HttpDispatchLease::new(self.executor.clone(), request.dispatch_id.clone());
        let max_chunk_bytes = request.max_response_bytes;
        let response = invoke_stream(
            &lease,
            HttpStreamCommand::OpenStream { request },
            cancellation,
        )
        .await?;
        match response {
            HttpStreamResponse::Opened { status, headers } => {
                if status != 0 && !(100..=599).contains(&status) {
                    return Err(transport_invariant(
                        "HTTP stream returned an invalid status",
                    ));
                }
                Ok(HttpStreamOpening::Opened {
                    status,
                    headers,
                    stream: HttpByteStream {
                        lease: Some(lease),
                        max_chunk_bytes,
                    },
                })
            }
            HttpStreamResponse::NetworkFailure | HttpStreamResponse::ResponseTooLarge => {
                Ok(HttpStreamOpening::Unavailable)
            }
            HttpStreamResponse::Cancelled => Ok(HttpStreamOpening::Cancelled),
            _ => Err(transport_invariant(
                "HTTP stream opening returned an invalid response",
            )),
        }
    }
}

impl HttpByteStream {
    /// Mutable access permits only one outstanding read. EOF/errors permanently retire the lease.
    pub(crate) async fn next_chunk(
        &mut self,
        cancellation: RequestCancellation,
    ) -> Result<Option<Vec<u8>>, RuntimeError> {
        let Some(lease) = self.lease.take() else {
            return Ok(None);
        };
        let command = HttpStreamCommand::ReadStream {
            dispatch_id: lease.dispatch_id.clone(),
        };
        match invoke_stream(&lease, command, cancellation).await? {
            HttpStreamResponse::Chunk { bytes } => {
                if bytes.is_empty() || bytes.len() as u64 > u64::from(self.max_chunk_bytes) {
                    return Err(transport_invariant(
                        "HTTP stream chunk is empty or exceeds its limit",
                    ));
                }
                self.lease = Some(lease);
                Ok(Some(bytes))
            }
            HttpStreamResponse::Ended => Ok(None),
            HttpStreamResponse::Cancelled => Err(RuntimeError::new(
                RuntimeErrorCode::Cancelled,
                "HTTP stream read was cancelled",
            )),
            HttpStreamResponse::NetworkFailure | HttpStreamResponse::ResponseTooLarge => {
                Err(RuntimeError::new(
                    RuntimeErrorCode::RetryableTransport,
                    "HTTP stream transport failed",
                ))
            }
            _ => Err(transport_invariant(
                "HTTP stream read returned an invalid response",
            )),
        }
    }
}

async fn invoke_stream(
    lease: &HttpDispatchLease,
    command: HttpStreamCommand,
    cancellation: RequestCancellation,
) -> Result<HttpStreamResponse, RuntimeError> {
    let request = Zeroizing::new(
        serde_json::to_string(&command)
            .map_err(|_| transport_invariant("HTTP stream command could not be serialized"))?,
    );
    drop(command);
    tokio::select! {
        biased;
        () = cancellation.cancelled() => Ok(HttpStreamResponse::Cancelled),
        result = lease.executor.invoke(request) => {
            let response = result.map_err(|_| transport_invariant("HTTP stream executor invocation failed"))?;
            serde_json::from_str(&response).map_err(|_| transport_invariant("HTTP stream executor response is invalid"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::VecDeque, sync::Mutex};

    struct Executor {
        responses: Mutex<VecDeque<&'static str>>,
        commands: Mutex<Vec<serde_json::Value>>,
        cancelled: Mutex<Vec<String>>,
    }

    #[async_trait]
    impl SerializedHttpExecutor for Executor {
        async fn invoke(
            &self,
            command: zeroize::Zeroizing<String>,
        ) -> Result<String, RuntimeError> {
            self.commands
                .lock()
                .unwrap()
                .push(serde_json::from_str(&command).unwrap());
            let response = self.responses.lock().unwrap().pop_front();
            match response {
                Some(response) => Ok(response.to_owned()),
                None => std::future::pending().await,
            }
        }
        fn cancel(&self, id: &str) {
            self.cancelled.lock().unwrap().push(id.to_owned());
        }
    }

    fn executor(responses: &[&'static str]) -> Arc<Executor> {
        Arc::new(Executor {
            responses: Mutex::new(responses.iter().copied().collect()),
            commands: Mutex::new(Vec::new()),
            cancelled: Mutex::new(Vec::new()),
        })
    }

    fn dispatch() -> HttpDispatch {
        HttpDispatch::new(
            HttpMethod::Get,
            "https://example.test/events".into(),
            vec![HttpHeader {
                name: "Authorization".into(),
                value: "Bearer session".into(),
            }],
            vec![],
            3,
        )
    }

    #[tokio::test]
    async fn stream_preserves_request_identity_and_releases_on_eof() {
        let executor = executor(&[
            r#"{"type":"opened","status":200,"headers":[]}"#,
            r#"{"type":"chunk","bytes":[1,2,3]}"#,
            r#"{"type":"ended"}"#,
        ]);
        let HttpStreamOpening::Opened { mut stream, .. } = HttpTransport::new(executor.clone())
            .open_stream(dispatch(), RequestCancellation::new())
            .await
            .unwrap()
        else {
            panic!("not opened")
        };
        assert_eq!(
            stream.next_chunk(RequestCancellation::new()).await.unwrap(),
            Some(vec![1, 2, 3])
        );
        assert_eq!(
            stream.next_chunk(RequestCancellation::new()).await.unwrap(),
            None
        );
        assert_eq!(
            stream.next_chunk(RequestCancellation::new()).await.unwrap(),
            None
        );
        drop(stream);
        let commands = executor.commands.lock().unwrap();
        assert_eq!(commands.len(), 3);
        let id = commands[0]["request"]["dispatchId"].as_str().unwrap();
        assert_eq!(
            commands[0]["request"]["headers"][0]["value"],
            "Bearer session"
        );
        assert_eq!(commands[1]["dispatchId"], id);
        assert_eq!(commands[2]["dispatchId"], id);
        assert_eq!(*executor.cancelled.lock().unwrap(), vec![id.to_owned()]);
    }

    #[tokio::test]
    async fn stream_refuses_oversized_chunk_and_cancels_lease() {
        let executor = executor(&[
            r#"{"type":"opened","status":200,"headers":[]}"#,
            r#"{"type":"chunk","bytes":[1,2,3,4]}"#,
        ]);
        let HttpStreamOpening::Opened { mut stream, .. } = HttpTransport::new(executor.clone())
            .open_stream(dispatch(), RequestCancellation::new())
            .await
            .unwrap()
        else {
            panic!("not opened")
        };
        assert_eq!(
            stream
                .next_chunk(RequestCancellation::new())
                .await
                .unwrap_err()
                .code,
            RuntimeErrorCode::InvariantViolation
        );
        assert_eq!(executor.cancelled.lock().unwrap().len(), 1);
        assert_eq!(
            stream.next_chunk(RequestCancellation::new()).await.unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn dropping_pending_open_or_read_releases_exact_transport() {
        for opening in [true, false] {
            let executor = executor(if opening {
                &[]
            } else {
                &[r#"{"type":"opened","status":200,"headers":[]}"#]
            });
            let transport = HttpTransport::new(executor.clone());
            if opening {
                assert!(tokio::time::timeout(
                    std::time::Duration::from_millis(1),
                    transport.open_stream(dispatch(), RequestCancellation::new())
                )
                .await
                .is_err());
            } else {
                let HttpStreamOpening::Opened { mut stream, .. } = transport
                    .open_stream(dispatch(), RequestCancellation::new())
                    .await
                    .unwrap()
                else {
                    panic!("not opened")
                };
                assert!(tokio::time::timeout(
                    std::time::Duration::from_millis(1),
                    stream.next_chunk(RequestCancellation::new())
                )
                .await
                .is_err());
                drop(stream);
            }
            let commands = executor.commands.lock().unwrap();
            assert_eq!(
                *executor.cancelled.lock().unwrap(),
                vec![commands[0]["request"]["dispatchId"]
                    .as_str()
                    .unwrap()
                    .to_owned()]
            );
        }
    }

    #[tokio::test]
    async fn cancellation_prevents_open_and_releases_a_held_read_once() {
        let executor = executor(&[r#"{"type":"opened","status":200,"headers":[]}"#]);
        let transport = HttpTransport::new(executor.clone());
        let cancellation = RequestCancellation::new();
        cancellation.cancel();
        assert!(matches!(
            transport
                .open_stream(dispatch(), cancellation)
                .await
                .unwrap(),
            HttpStreamOpening::Cancelled
        ));
        assert!(executor.commands.lock().unwrap().is_empty());
        assert!(executor.cancelled.lock().unwrap().is_empty());

        let HttpStreamOpening::Opened { mut stream, .. } = transport
            .open_stream(dispatch(), RequestCancellation::new())
            .await
            .unwrap()
        else {
            panic!("not opened")
        };
        let cancellation = RequestCancellation::new();
        let mut read = Box::pin(stream.next_chunk(cancellation.clone()));
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(1), &mut read)
                .await
                .is_err()
        );
        cancellation.cancel();
        assert_eq!(read.await.unwrap_err().code, RuntimeErrorCode::Cancelled);
        drop(stream);
        assert_eq!(executor.cancelled.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn opening_failures_and_invalid_read_responses_retire_their_lease() {
        for response in [
            r#"{"type":"opened","status":99,"headers":[]}"#,
            r#"{"type":"networkFailure"}"#,
            r#"{"type":"chunk","bytes":[1]}"#,
            r#"{"type":"future"}"#,
        ] {
            let executor = executor(&[response]);
            let _ = HttpTransport::new(executor.clone())
                .open_stream(dispatch(), RequestCancellation::new())
                .await;
            assert_eq!(executor.cancelled.lock().unwrap().len(), 1);
        }
        for response in [
            r#"{"type":"opened","status":200,"headers":[]}"#,
            r#"{"type":"chunk","bytes":[]}"#,
            r#"{"type":"chunk","bytes":[1],"extra":true}"#,
        ] {
            let executor = executor(&[r#"{"type":"opened","status":200,"headers":[]}"#, response]);
            let HttpStreamOpening::Opened { mut stream, .. } = HttpTransport::new(executor.clone())
                .open_stream(dispatch(), RequestCancellation::new())
                .await
                .unwrap()
            else {
                panic!("not opened")
            };
            assert_eq!(
                stream
                    .next_chunk(RequestCancellation::new())
                    .await
                    .unwrap_err()
                    .code,
                RuntimeErrorCode::InvariantViolation
            );
            assert_eq!(executor.cancelled.lock().unwrap().len(), 1);
        }
    }
}
