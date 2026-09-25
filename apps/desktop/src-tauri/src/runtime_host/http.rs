//! Native execution of Core's closed HTTP capability. Core retains all network policy.

use async_trait::async_trait;
use bittery_client_core::{
    HttpHeader, HttpMethod, HttpRequest, HttpResponse, HttpStreamCommand, HttpStreamResponse,
    RequestCancellation, RuntimeError, RuntimeErrorCode, SerializedHttpExecutor,
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use zeroize::Zeroizing;

pub struct NativeHttpExecutor {
    client: reqwest::Client,
    active: Mutex<HashMap<String, Arc<Dispatch>>>,
}

struct Dispatch {
    cancellation: RequestCancellation,
    stream: Mutex<Option<reqwest::Response>>,
    max_chunk_bytes: u32,
}

/// Dropping an invocation cancels its socket and frees its correlation identity.
struct DispatchLease<'a> {
    executor: &'a NativeHttpExecutor,
    id: String,
    dispatch: Arc<Dispatch>,
    retained: bool,
}

impl Drop for DispatchLease<'_> {
    fn drop(&mut self) {
        if self.retained {
            return;
        }
        let mut active = self
            .executor
            .active
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if active
            .get(&self.id)
            .is_some_and(|entry| Arc::ptr_eq(entry, &self.dispatch))
        {
            active.remove(&self.id);
        }
        self.dispatch.cancellation.cancel();
    }
}

impl NativeHttpExecutor {
    pub fn new() -> Result<Self, RuntimeError> {
        Ok(Self {
            client: exact_http_client()?,
            active: Mutex::new(HashMap::new()),
        })
    }

    fn register(&self, id: &str, max_chunk_bytes: u32) -> Result<DispatchLease<'_>, RuntimeError> {
        let mut active = self
            .active
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if active.contains_key(id) {
            return Err(invocation_error());
        }
        let dispatch = Arc::new(Dispatch {
            cancellation: RequestCancellation::new(),
            stream: Mutex::new(None),
            max_chunk_bytes,
        });
        active.insert(id.into(), dispatch.clone());
        Ok(DispatchLease {
            executor: self,
            id: id.into(),
            dispatch,
            retained: false,
        })
    }

    fn prepare(&self, request: &mut HttpRequest) -> Result<reqwest::Request, RuntimeError> {
        request.validate()?;
        let method = match request.method {
            HttpMethod::Get => reqwest::Method::GET,
            HttpMethod::Head => reqwest::Method::HEAD,
            HttpMethod::Post => reqwest::Method::POST,
            HttpMethod::Put => reqwest::Method::PUT,
            HttpMethod::Patch => reqwest::Method::PATCH,
            HttpMethod::Delete => reqwest::Method::DELETE,
        };
        let url = exact_http_url(&request.url)?;
        // The existing reusable reqwest body owns this one upload allocation. Its last Bytes
        // clone wipes the buffer; TLS/socket/library copies are outside this ownership boundary.
        let body = bytes::Bytes::from_owner(Zeroizing::new(std::mem::take(&mut request.body)));
        let mut builder = self.client.request(method, url).body(body);
        for header in &request.headers {
            builder = builder.header(&header.name, &header.value);
        }
        builder.build().map_err(|_| invocation_error())
    }

    async fn execute(&self, mut request: HttpRequest) -> Result<HttpResponse, RuntimeError> {
        let prepared = self.prepare(&mut request)?;
        let lease = self.register(&request.dispatch_id, 0)?;
        tokio::select! {
            biased;
            () = lease.dispatch.cancellation.cancelled() => Ok(HttpResponse::Cancelled),
            response = self.read_response(prepared, request.max_response_bytes) => response,
        }
    }

    async fn read_response(
        &self,
        prepared: reqwest::Request,
        max_response_bytes: u32,
    ) -> Result<HttpResponse, RuntimeError> {
        let Ok(mut response) = self.client.execute(prepared).await else {
            return Ok(HttpResponse::NetworkFailure);
        };
        let status = response.status().as_u16();
        let headers = response_headers(&response)?;
        if response
            .content_length()
            .is_some_and(|length| length > u64::from(max_response_bytes))
        {
            return Ok(HttpResponse::ResponseTooLarge);
        }
        let mut body = Vec::new();
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) => {
                    if chunk.len() > max_response_bytes as usize - body.len() {
                        return Ok(HttpResponse::ResponseTooLarge);
                    }
                    body.extend_from_slice(&chunk);
                }
                Ok(None) => break,
                Err(_) => return Ok(HttpResponse::NetworkFailure),
            }
        }
        Ok(HttpResponse::Completed {
            status,
            headers,
            body,
        })
    }

    async fn open_stream(
        &self,
        mut request: HttpRequest,
    ) -> Result<HttpStreamResponse, RuntimeError> {
        let prepared = self.prepare(&mut request)?;
        if request.max_response_bytes == 0 {
            return Err(invocation_error());
        }
        let mut lease = self.register(&request.dispatch_id, request.max_response_bytes)?;
        let response = tokio::select! {
            biased;
            () = lease.dispatch.cancellation.cancelled() => return Ok(HttpStreamResponse::Cancelled),
            response = self.client.execute(prepared) => response,
        };
        let Ok(response) = response else {
            return Ok(HttpStreamResponse::NetworkFailure);
        };
        let result = HttpStreamResponse::Opened {
            status: response.status().as_u16(),
            headers: response_headers(&response)?,
        };
        *lease
            .dispatch
            .stream
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(response);
        lease.retained = true;
        Ok(result)
    }

    async fn read_stream(&self, id: String) -> Result<HttpStreamResponse, RuntimeError> {
        if id.is_empty() {
            return Err(invocation_error());
        }
        let Some(dispatch) = self
            .active
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(&id)
            .cloned()
        else {
            return Ok(HttpStreamResponse::Cancelled);
        };
        // Taking the response permits one pull at a time and holds no mutex across network I/O.
        let mut response = dispatch
            .stream
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take()
            .ok_or_else(invocation_error)?;
        let mut lease = DispatchLease {
            executor: self,
            id,
            dispatch,
            retained: false,
        };
        let chunk = tokio::select! {
            biased;
            () = lease.dispatch.cancellation.cancelled() => return Ok(HttpStreamResponse::Cancelled),
            chunk = response.chunk() => chunk,
        };
        match chunk {
            Ok(Some(bytes)) => {
                if bytes.is_empty() || bytes.len() > lease.dispatch.max_chunk_bytes as usize {
                    return Ok(HttpStreamResponse::ResponseTooLarge);
                }
                *lease
                    .dispatch
                    .stream
                    .lock()
                    .unwrap_or_else(|error| error.into_inner()) = Some(response);
                lease.retained = true;
                Ok(HttpStreamResponse::Chunk {
                    bytes: bytes.to_vec(),
                })
            }
            Ok(None) => Ok(HttpStreamResponse::Ended),
            Err(_) => Ok(HttpStreamResponse::NetworkFailure),
        }
    }
}

pub(super) fn exact_http_client() -> Result<reqwest::Client, RuntimeError> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .referer(false)
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .build()
        .map_err(|_| invocation_error())
}

pub(super) fn exact_http_url(value: &str) -> Result<reqwest::Url, RuntimeError> {
    let url = reqwest::Url::parse(value).map_err(|_| invocation_error())?;
    // URL credentials would make reqwest synthesize authentication outside Core's headers.
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(invocation_error());
    }
    Ok(url)
}

fn invocation_error() -> RuntimeError {
    RuntimeError {
        code: RuntimeErrorCode::InvariantViolation,
        message: "native HTTP capability invocation failed".into(),
        recovery_bound: None,
        team_page_problem: None,
    }
}

fn response_headers(response: &reqwest::Response) -> Result<Vec<HttpHeader>, RuntimeError> {
    response
        .headers()
        .iter()
        .map(|(name, value)| {
            Ok(HttpHeader {
                name: name.as_str().into(),
                value: value.to_str().map_err(|_| invocation_error())?.into(),
            })
        })
        .collect()
}

#[async_trait]
impl SerializedHttpExecutor for NativeHttpExecutor {
    async fn invoke(
        &self,
        request_json: zeroize::Zeroizing<String>,
    ) -> Result<String, RuntimeError> {
        // Read only a borrowed discriminator before typed decoding. A serde Value would retain
        // another unprotected body array beside the zeroizing wire and typed request.
        #[derive(serde::Deserialize)]
        struct Discriminator<'a> {
            #[serde(rename = "type", borrow)]
            kind: Option<&'a str>,
        }
        let discriminator: Discriminator<'_> =
            serde_json::from_str(&request_json).map_err(|_| invocation_error())?;
        if discriminator.kind.is_some() {
            let command = serde_json::from_str(&request_json).map_err(|_| invocation_error())?;
            drop(request_json);
            let response = match command {
                HttpStreamCommand::OpenStream { request } => self.open_stream(request).await?,
                HttpStreamCommand::ReadStream { dispatch_id } => {
                    self.read_stream(dispatch_id).await?
                }
            };
            serde_json::to_string(&response).map_err(|_| invocation_error())
        } else {
            let request = serde_json::from_str(&request_json).map_err(|_| invocation_error())?;
            drop(request_json);
            serde_json::to_string(&self.execute(request).await?).map_err(|_| invocation_error())
        }
    }

    fn cancel(&self, dispatch_id: &str) {
        if let Some(dispatch) = self
            .active
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(dispatch_id)
        {
            dispatch.cancellation.cancel();
            dispatch
                .stream
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .take();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bittery_client_core::{
        HttpHeader, HttpMethod, HttpRequest, HttpResponse, HttpStreamCommand, HttpStreamResponse,
    };
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::{TcpListener, TcpStream},
    };

    fn request(url: String, max_response_bytes: u32) -> HttpRequest {
        HttpRequest {
            dispatch_id: "dispatch-1".into(),
            method: HttpMethod::Post,
            url,
            headers: vec![HttpHeader {
                name: "x-exact".into(),
                value: "a;b=2".into(),
            }],
            body: vec![0, 1, 255],
            max_response_bytes,
        }
    }

    #[test]
    fn native_request_hands_off_its_body_without_retaining_an_upload_copy() {
        let executor = NativeHttpExecutor::new().unwrap();
        let mut request = request("https://example.test/upload".into(), 0);
        let prepared = executor.prepare(&mut request).unwrap();
        assert!(
            request.body.is_empty(),
            "the native request retained an upload copy"
        );
        assert_eq!(prepared.body().unwrap().as_bytes().unwrap(), &[0, 1, 255]);
    }

    /// Every fixture sends the three-byte body above; do not assume one TCP read contains it.
    async fn read_fixture_request(stream: &mut TcpStream) -> Vec<u8> {
        let mut received = Vec::new();
        let mut bytes = [0; 4096];
        loop {
            let count = stream.read(&mut bytes).await.unwrap();
            assert_ne!(count, 0, "request ended before its complete body");
            received.extend_from_slice(&bytes[..count]);
            if let Some(end) = received.windows(4).position(|window| window == b"\r\n\r\n") {
                if received.len() >= end + 4 + 3 {
                    return received;
                }
            }
        }
    }

    async fn respond_once(response: &'static [u8]) -> (String, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_fixture_request(&mut stream).await;
            stream.write_all(response).await.unwrap();
        });
        (url, server)
    }

    async fn invoke(executor: &NativeHttpExecutor, request: HttpRequest) -> HttpResponse {
        serde_json::from_str(
            &executor
                .invoke(serde_json::to_string(&request).unwrap().into())
                .await
                .unwrap(),
        )
        .unwrap()
    }

    #[tokio::test]
    async fn rejects_oversized_bodies_with_and_without_content_length() {
        for response in [
            b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\n1234".as_slice(),
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n2\r\n12\r\n2\r\n34\r\n0\r\n\r\n".as_slice(),
        ] {
            let (url, server) = respond_once(response).await;
            assert_eq!(invoke(&NativeHttpExecutor::new().unwrap(), request(url, 3)).await, HttpResponse::ResponseTooLarge);
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn cancellation_wakes_a_pending_http_request_and_releases_its_identity() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let executor = NativeHttpExecutor::new().unwrap();
        let request_json = serde_json::to_string(&request(url, 3)).unwrap();
        let invocation = executor.invoke(request_json.into());
        tokio::pin!(invocation);
        let (mut socket, _) = tokio::select! {
            result = listener.accept() => result.unwrap(),
            _ = &mut invocation => panic!("request completed before server accepted"),
        };
        executor.cancel("dispatch-1");
        let response = tokio::time::timeout(std::time::Duration::from_secs(1), &mut invocation)
            .await
            .expect("cancel must wake HTTP without a server response")
            .unwrap();
        assert_eq!(
            serde_json::from_str::<HttpResponse>(&response).unwrap(),
            HttpResponse::Cancelled
        );
        // Read the request, then observe connection retirement at the real TCP peer.
        let mut bytes = Vec::new();
        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            socket.read_to_end(&mut bytes),
        )
        .await
        .unwrap()
        .unwrap();
        let (url, server) =
            respond_once(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n").await;
        assert!(matches!(
            invoke(&executor, request(url, 0)).await,
            HttpResponse::Completed { status: 204, .. }
        ));
        server.await.unwrap();
    }

    async fn stream_invoke(
        executor: &NativeHttpExecutor,
        command: HttpStreamCommand,
    ) -> HttpStreamResponse {
        serde_json::from_str(
            &executor
                .invoke(serde_json::to_string(&command).unwrap().into())
                .await
                .unwrap(),
        )
        .unwrap()
    }

    #[tokio::test]
    async fn opens_sse_before_body_and_pulls_exact_bytes_until_end() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let (send_body, wait_for_read) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            read_fixture_request(&mut socket).await;
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n").await.unwrap();
            wait_for_read.await.unwrap();
            socket
                .write_all(b"a\r\ndata: hi\n\n\r\n0\r\n\r\n")
                .await
                .unwrap();
        });
        let executor = NativeHttpExecutor::new().unwrap();
        let opening = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            stream_invoke(
                &executor,
                HttpStreamCommand::OpenStream {
                    request: request(url, 32),
                },
            ),
        )
        .await
        .expect("opening only waits for headers");
        let HttpStreamResponse::Opened { status, headers } = opening else {
            panic!("stream did not open")
        };
        assert_eq!(status, 200);
        assert!(headers
            .iter()
            .any(|h| h.name == "content-type" && h.value == "text/event-stream"));
        send_body.send(()).unwrap();
        let mut received = Vec::new();
        loop {
            match stream_invoke(
                &executor,
                HttpStreamCommand::ReadStream {
                    dispatch_id: "dispatch-1".into(),
                },
            )
            .await
            {
                HttpStreamResponse::Chunk { bytes } => received.extend_from_slice(&bytes),
                HttpStreamResponse::Ended => break,
                other => panic!("unexpected stream result: {other:?}"),
            }
        }
        assert_eq!(received, b"data: hi\n\n");
        assert!(matches!(
            stream_invoke(
                &executor,
                HttpStreamCommand::ReadStream {
                    dispatch_id: "dispatch-1".into()
                }
            )
            .await,
            HttpStreamResponse::Cancelled
        ));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn cancellation_retires_idle_and_pending_streams_without_waiting_for_sse() {
        for pending_read in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}/", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                read_fixture_request(&mut socket).await;
                socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n").await.unwrap();
                let mut remaining = Vec::new();
                tokio::time::timeout(
                    std::time::Duration::from_secs(1),
                    socket.read_to_end(&mut remaining),
                )
                .await
                .expect("cancel must close the stream socket")
                .unwrap();
            });
            let executor = NativeHttpExecutor::new().unwrap();
            assert!(matches!(
                stream_invoke(
                    &executor,
                    HttpStreamCommand::OpenStream {
                        request: request(url, 32)
                    }
                )
                .await,
                HttpStreamResponse::Opened { .. }
            ));
            if pending_read {
                let mut read = Box::pin(stream_invoke(
                    &executor,
                    HttpStreamCommand::ReadStream {
                        dispatch_id: "dispatch-1".into(),
                    },
                ));
                assert!(
                    tokio::time::timeout(std::time::Duration::from_millis(10), &mut read)
                        .await
                        .is_err()
                );
                let concurrent = executor
                    .invoke(
                        serde_json::to_string(&HttpStreamCommand::ReadStream {
                            dispatch_id: "dispatch-1".into(),
                        })
                        .unwrap()
                        .into(),
                    )
                    .await;
                assert_eq!(
                    concurrent.unwrap_err().code,
                    RuntimeErrorCode::InvariantViolation
                );
                executor.cancel("dispatch-1");
                assert!(matches!(
                    tokio::time::timeout(std::time::Duration::from_secs(1), read)
                        .await
                        .unwrap(),
                    HttpStreamResponse::Cancelled
                ));
            } else {
                executor.cancel("dispatch-1");
            }
            assert!(matches!(
                stream_invoke(
                    &executor,
                    HttpStreamCommand::ReadStream {
                        dispatch_id: "dispatch-1".into()
                    }
                )
                .await,
                HttpStreamResponse::Cancelled
            ));
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn oversized_stream_chunks_and_transport_failures_retire_the_dispatch() {
        let executor = NativeHttpExecutor::new().unwrap();
        for (response, oversized) in [
            (b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n4\r\n1234\r\n0\r\n\r\n".as_slice(), true),
            (b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n".as_slice(), false),
        ] {
            let (url, server) = respond_once(response).await;
            assert!(matches!(stream_invoke(&executor, HttpStreamCommand::OpenStream { request: request(url, 3) }).await, HttpStreamResponse::Opened { .. }));
            let response = stream_invoke(&executor, HttpStreamCommand::ReadStream { dispatch_id: "dispatch-1".into() }).await;
            assert!(if oversized { matches!(response, HttpStreamResponse::ResponseTooLarge) } else { matches!(response, HttpStreamResponse::NetworkFailure) });
            assert!(matches!(stream_invoke(&executor, HttpStreamCommand::ReadStream { dispatch_id: "dispatch-1".into() }).await, HttpStreamResponse::Cancelled));
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn does_not_follow_redirects_or_expose_transport_error_details() {
        let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let redirect = format!("HTTP/1.1 307 Temporary Redirect\r\nLocation: http://{}/forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", target.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            read_fixture_request(&mut socket).await;
            socket.write_all(redirect.as_bytes()).await.unwrap();
        });
        let executor = NativeHttpExecutor::new().unwrap();
        let mut dispatch = request(url, 0);
        dispatch.headers.push(HttpHeader {
            name: "authorization".into(),
            value: "Bearer loopback-only-secret".into(),
        });
        assert!(matches!(
            invoke(&executor, dispatch).await,
            HttpResponse::Completed { status: 307, .. }
        ));
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), target.accept())
                .await
                .is_err()
        );
        server.await.unwrap();
        let (url, server) = respond_once(b"invalid HTTP response\r\n").await;
        let answer = executor
            .invoke(serde_json::to_string(&request(url, 0)).unwrap().into())
            .await
            .unwrap();
        assert_eq!(answer, r#"{"type":"networkFailure"}"#);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn dropped_invocation_releases_identity_and_duplicate_calls_do_not_replace_it() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let executor = NativeHttpExecutor::new().unwrap();
        let payload = serde_json::to_string(&request(url, 3)).unwrap();
        let mut first = Box::pin(executor.invoke(payload.clone().into()));
        let (_socket, _) = tokio::select! {
            result = listener.accept() => result.unwrap(),
            _ = &mut first => panic!("request completed before server accepted"),
        };
        assert_eq!(
            executor.invoke(payload.into()).await.unwrap_err().code,
            RuntimeErrorCode::InvariantViolation
        );
        drop(first);
        let (url, server) =
            respond_once(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n").await;
        assert!(matches!(
            invoke(&executor, request(url, 0)).await,
            HttpResponse::Completed { status: 204, .. }
        ));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn rejects_malformed_capabilities_without_synthesizing_authentication() {
        let executor = NativeHttpExecutor::new().unwrap();
        for payload in [
            r#"{"type":"readStream","dispatchId":""}"#,
            r#"{"type":"readStream","dispatchId":"known","extra":true}"#,
            r#"{"type":"futureCommand"}"#,
            "not JSON",
        ] {
            assert_eq!(
                executor
                    .invoke(payload.to_owned().into())
                    .await
                    .unwrap_err()
                    .code,
                RuntimeErrorCode::InvariantViolation
            );
        }
        let mut dispatch = request("http://user:secret@127.0.0.1/".into(), 0);
        assert_eq!(
            executor
                .invoke(serde_json::to_string(&dispatch).unwrap().into())
                .await
                .unwrap_err()
                .code,
            RuntimeErrorCode::InvariantViolation
        );
        dispatch.url = "http://127.0.0.1/".into();
        dispatch.headers.push(HttpHeader {
            name: "X-EXACT".into(),
            value: "duplicate".into(),
        });
        assert_eq!(
            executor
                .invoke(serde_json::to_string(&dispatch).unwrap().into())
                .await
                .unwrap_err()
                .code,
            RuntimeErrorCode::InvariantViolation
        );
    }

    #[tokio::test]
    async fn executes_exact_body_headers_and_preserves_http_rejection() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/literal?part=one", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let received = read_fixture_request(&mut stream).await;
            assert!(received.starts_with(b"POST /literal?part=one HTTP/1.1\r\n"));
            assert!(received
                .windows(b"x-exact: a;b=2\r\n".len())
                .any(|w| w == b"x-exact: a;b=2\r\n"));
            assert!(received.ends_with(&[0, 1, 255]));
            stream.write_all(b"HTTP/1.1 409 Conflict\r\nContent-Length: 3\r\nX-Outcome: rejected\r\nSet-Cookie: one\r\nSet-Cookie: two\r\nConnection: close\r\n\r\n\x09\x08\xff").await.unwrap();
        });
        let response: HttpResponse = serde_json::from_str(
            &NativeHttpExecutor::new()
                .unwrap()
                .invoke(serde_json::to_string(&request(url, 3)).unwrap().into())
                .await
                .unwrap(),
        )
        .unwrap();
        let HttpResponse::Completed {
            status,
            headers,
            body,
        } = response
        else {
            panic!("HTTP status must remain a completed transport response")
        };
        assert_eq!(status, 409);
        assert_eq!(body, vec![9, 8, 255]);
        assert_eq!(
            headers
                .iter()
                .filter(|h| h.name == "set-cookie")
                .map(|h| h.value.as_str())
                .collect::<Vec<_>>(),
            vec!["one", "two"]
        );
        server.await.unwrap();
    }
}
