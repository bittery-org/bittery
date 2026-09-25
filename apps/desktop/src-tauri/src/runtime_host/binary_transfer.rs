//! Native streamed ciphertext transport for Core's attachment capabilities.

use super::{
    files::NativeFiles,
    http::{exact_http_client, exact_http_url},
};
use async_trait::async_trait;
use bittery_client_core::{
    AccountId, AttachmentArtifactOwner, AttachmentMoveDownload, AttachmentMoveDownloadRequest,
    AttachmentMoveTransferError as TransferError, AttachmentMoveTransferPort, AttachmentMoveUpload,
    AttachmentMoveUploadGrant, AttachmentUploadBinary, AttachmentUploadBinaryOutcome,
    AttachmentUploadIntegrity, AttachmentUploadTransferPort, RequestCancellation, RuntimeError,
    ARTIFACT_CHUNK_BYTES,
};
use std::sync::Arc;
use tokio::io::{AsyncSeekExt, AsyncWriteExt};

pub struct NativeBinaryTransfer {
    client: reqwest::Client,
    files: Arc<NativeFiles>,
}

impl NativeBinaryTransfer {
    pub(super) fn new(files: Arc<NativeFiles>) -> Result<Self, RuntimeError> {
        Ok(Self {
            client: exact_http_client()?,
            files,
        })
    }

    fn upload(
        &self,
        account_id: &AccountId,
        url: &str,
        expected_bytes: u64,
        signed_headers: Vec<(String, String)>,
    ) -> Result<Upload, TransferError> {
        if expected_bytes == 0 {
            return Err(TransferError::Invariant);
        }
        let url = exact_http_url(url).map_err(|_| TransferError::Invariant)?;
        let mut headers = reqwest::header::HeaderMap::new();
        for (name, value) in signed_headers {
            let name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| TransferError::Invariant)?;
            let value = reqwest::header::HeaderValue::from_str(&value)
                .map_err(|_| TransferError::Invariant)?;
            if headers.insert(name, value).is_some() {
                return Err(TransferError::Invariant);
            }
        }
        let file = self
            .files
            .allocate_ciphertext_spool(account_id)
            .map_err(|_| TransferError::Transient)?;
        // This is an unnamed/delete-on-close OS file. The same handle moves into the HTTP body;
        // no pathname or cleanup retry owner can outlive a dropped transfer.
        let file = tokio::fs::File::from_std(file);
        Ok(Upload {
            state: Some(UploadState {
                client: self.client.clone(),
                url,
                file: Some(file),
                integrity: AttachmentUploadIntegrity::for_length(expected_bytes),
                expected_bytes,
                headers,
            }),
        })
    }
}

struct Upload {
    state: Option<UploadState>,
}

struct UploadState {
    client: reqwest::Client,
    url: reqwest::Url,
    file: Option<tokio::fs::File>,
    integrity: AttachmentUploadIntegrity,
    expected_bytes: u64,
    headers: reqwest::header::HeaderMap,
}

struct MoveUpload {
    upload: Upload,
    ciphertext_sha256: String,
}

#[async_trait]
impl AttachmentMoveUpload for MoveUpload {
    async fn write_chunk(&mut self, bytes: &[u8]) -> Result<(), TransferError> {
        self.upload.write(bytes, RequestCancellation::new()).await
    }

    async fn finish(mut self: Box<Self>) -> Result<(), TransferError> {
        match self
            .upload
            .finish(&self.ciphertext_sha256, RequestCancellation::new())
            .await?
        {
            AttachmentUploadBinaryOutcome::Uploaded { .. } => Ok(()),
            _ => Err(TransferError::Transient),
        }
    }
}

impl UploadState {
    async fn dispatch(
        &mut self,
        digest: &str,
        cancellation: RequestCancellation,
    ) -> AttachmentUploadBinaryOutcome {
        let Some(mut file) = self.file.take() else {
            return AttachmentUploadBinaryOutcome::NotDispatched;
        };
        if file.flush().await.is_err() || file.rewind().await.is_err() {
            return AttachmentUploadBinaryOutcome::NotDispatched;
        }
        let body = reqwest::Body::wrap_stream(tokio_util::io::ReaderStream::with_capacity(
            file,
            ARTIFACT_CHUNK_BYTES,
        ));
        let request = self
            .client
            .put(self.url.clone())
            .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
            .header(reqwest::header::CONTENT_LENGTH, self.expected_bytes)
            .header("x-amz-content-sha256", digest)
            .headers(self.headers.clone())
            .body(body)
            .build();
        let Ok(request) = request else {
            return AttachmentUploadBinaryOutcome::NotDispatched;
        };
        tokio::select! {
            biased;
            () = cancellation.cancelled() => AttachmentUploadBinaryOutcome::Cancelled,
            result = self.client.execute(request) => match result {
                Ok(response) if response.status().is_success() => AttachmentUploadBinaryOutcome::Uploaded { ciphertext_sha256: digest.into() },
                Ok(response) => AttachmentUploadBinaryOutcome::Rejected { status: response.status().as_u16() },
                Err(_) => AttachmentUploadBinaryOutcome::Ambiguous,
            }
        }
    }
}

#[async_trait]
impl AttachmentUploadBinary for Upload {
    async fn write(
        &mut self,
        bytes: &[u8],
        cancellation: RequestCancellation,
    ) -> Result<(), TransferError> {
        let mut state = self.state.take().ok_or(TransferError::Invariant)?;
        let result = tokio::select! {
            biased;
            () = cancellation.cancelled() => Err(TransferError::Transient),
            result = async {
                if bytes.is_empty() { return Err(TransferError::Invariant); }
                // One Core encryptor input can expand beyond a transport chunk in the persisted
                // base64 envelope. Split the byte stream without changing its digest or format.
                for chunk in bytes.chunks(ARTIFACT_CHUNK_BYTES) {
                    state.integrity.push(chunk).map_err(|_| TransferError::Invariant)?;
                    state.file.as_mut().ok_or(TransferError::Invariant)?.write_all(chunk).await.map_err(|_| TransferError::Transient)?;
                }
                Ok(())
            } => result,
        };
        if result.is_ok() {
            self.state = Some(state);
        }
        result
    }

    async fn finish(
        &mut self,
        digest: &str,
        cancellation: RequestCancellation,
    ) -> Result<AttachmentUploadBinaryOutcome, TransferError> {
        let mut state = self.state.take().ok_or(TransferError::Invariant)?;
        state
            .integrity
            .finish_with_sha256(digest)
            .map_err(|_| TransferError::Invariant)?;
        Ok(state.dispatch(digest, cancellation).await)
    }

    async fn abort(&mut self) -> Result<(), TransferError> {
        self.state.take();
        Ok(())
    }
}

#[async_trait]
impl AttachmentUploadTransferPort for NativeBinaryTransfer {
    async fn open(
        &self,
        account_id: &AccountId,
        attachment_id: &str,
        upload_url: &str,
        expected_bytes: u64,
        cancellation: RequestCancellation,
    ) -> Result<Box<dyn AttachmentUploadBinary>, TransferError> {
        if cancellation.is_cancelled() {
            return Err(TransferError::Transient);
        }
        if attachment_id.is_empty() {
            return Err(TransferError::Invariant);
        }
        Ok(Box::new(self.upload(
            account_id,
            upload_url,
            expected_bytes,
            Vec::new(),
        )?))
    }
}

struct Download {
    state: Option<DownloadState>,
}

struct DownloadState {
    response: reqwest::Response,
    pending: Vec<u8>,
    offset: usize,
    remaining: u64,
    max_chunk_bytes: usize,
}

#[async_trait]
impl AttachmentMoveDownload for Download {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, TransferError> {
        // The future owns the socket while pulling. Dropping a pending caller cannot leave a
        // detached read or an uncertain response position available to another pull.
        let mut state = self.state.take().ok_or(TransferError::Invariant)?;
        while state.offset == state.pending.len() {
            let chunk = state
                .response
                .chunk()
                .await
                .map_err(|_| TransferError::Transient)?;
            let Some(chunk) = chunk else { return Ok(None) };
            if chunk.is_empty() {
                continue;
            }
            state.remaining = state
                .remaining
                .checked_sub(chunk.len() as u64)
                .ok_or(TransferError::Transient)?;
            state.pending = chunk.to_vec();
            state.offset = 0;
        }
        let end = state
            .pending
            .len()
            .min(state.offset + state.max_chunk_bytes);
        let bytes = state.pending[state.offset..end].to_vec();
        state.offset = end;
        self.state = Some(state);
        Ok(Some(bytes))
    }
}

#[async_trait]
impl AttachmentMoveTransferPort for NativeBinaryTransfer {
    async fn open_source(
        &self,
        request: AttachmentMoveDownloadRequest,
    ) -> Result<Box<dyn AttachmentMoveDownload>, TransferError> {
        if request.max_chunk_bytes == 0 || request.max_chunk_bytes as usize > ARTIFACT_CHUNK_BYTES {
            return Err(TransferError::Invariant);
        }
        let url = exact_http_url(&request.download_url).map_err(|_| TransferError::Invariant)?;
        let mut headers = reqwest::header::HeaderMap::new();
        for (name, value) in request.headers {
            let name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| TransferError::Invariant)?;
            if value.starts_with([' ', '\t']) || value.ends_with([' ', '\t']) {
                return Err(TransferError::Invariant);
            }
            let value = reqwest::header::HeaderValue::from_str(&value)
                .map_err(|_| TransferError::Invariant)?;
            if headers.insert(name, value).is_some() {
                return Err(TransferError::Invariant);
            }
        }
        let response = self
            .client
            .get(url)
            .headers(headers)
            .send()
            .await
            .map_err(|_| TransferError::Transient)?;
        if !response.status().is_success()
            || response
                .content_length()
                .is_some_and(|length| length > request.max_response_bytes)
        {
            return Err(TransferError::Transient);
        }
        Ok(Box::new(Download {
            state: Some(DownloadState {
                response,
                pending: Vec::new(),
                offset: 0,
                remaining: request.max_response_bytes,
                max_chunk_bytes: request.max_chunk_bytes as usize,
            }),
        }))
    }

    async fn open_upload(
        &self,
        account_id: &AccountId,
        operation_id: &str,
        grant: &AttachmentMoveUploadGrant,
        owner: &AttachmentArtifactOwner,
    ) -> Result<Box<dyn AttachmentMoveUpload>, TransferError> {
        if owner.account_id() != account_id
            || owner.operation_id() != operation_id
            || owner.attachment_id() != grant.attachment_id
        {
            return Err(TransferError::Invariant);
        }
        Ok(Box::new(MoveUpload {
            upload: self.upload(
                account_id,
                &grant.upload_url,
                owner.byte_length(),
                grant.validated_headers(owner)?,
            )?,
            ciphertext_sha256: owner.ciphertext_sha256().into(),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bittery_client_core::{AttachmentMoveDownloadRequest, AttachmentMoveTransferPort};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    async fn request_headers(socket: &mut tokio::net::TcpStream) -> String {
        let mut headers = Vec::new();
        while !headers.ends_with(b"\r\n\r\n") {
            headers.push(socket.read_u8().await.unwrap());
            assert!(headers.len() < 16_384);
        }
        String::from_utf8(headers).unwrap()
    }

    #[tokio::test]
    async fn download_preserves_signed_headers_and_returns_bounded_ciphertext() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "http://{}/ciphertext?signature=opaque",
            listener.local_addr().unwrap()
        );
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let headers = request_headers(&mut socket).await;
            assert!(headers.starts_with("GET /ciphertext?signature=opaque HTTP/1.1\r\n"));
            assert!(headers.contains("x-signed: exact-value\r\n"));
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\n\x00\x01\x02\xff\x04\x05\x06").await.unwrap();
        });
        let directory = tempfile::tempdir().unwrap();
        let transfer =
            NativeBinaryTransfer::new(Arc::new(NativeFiles::open(directory.path()).unwrap()))
                .unwrap();
        let mut download = transfer
            .open_source(AttachmentMoveDownloadRequest {
                download_url: url,
                headers: vec![("x-signed".into(), "exact-value".into())],
                max_response_bytes: 7,
                max_chunk_bytes: 3,
            })
            .await
            .unwrap();
        let mut bytes = Vec::new();
        while let Some(chunk) = download.next_chunk().await.unwrap() {
            assert!(!chunk.is_empty() && chunk.len() <= 3);
            bytes.extend(chunk);
        }
        assert_eq!(bytes, [0, 1, 2, 255, 4, 5, 6]);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn download_rejects_declared_and_streamed_overflow_and_does_not_follow_redirects() {
        for response in [
            &b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nmore"[..],
            &b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nmore\r\n0\r\n\r\n"[..],
            &b"HTTP/1.1 307 Temporary Redirect\r\nLocation: /must-not-follow\r\nContent-Length: 0\r\n\r\n"[..],
        ] {
            let directory = tempfile::tempdir().unwrap();
            let transfer = NativeBinaryTransfer::new(Arc::new(NativeFiles::open(directory.path()).unwrap())).unwrap();
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}/ciphertext", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                request_headers(&mut socket).await;
                socket.write_all(response).await.unwrap();
                let mut byte = [0];
                // A fully consumed response can leave an idle pooled socket. It must never carry
                // a redirected request, whether the client closes it or keeps it idle.
                if let Ok(read) = tokio::time::timeout(std::time::Duration::from_millis(20), socket.read(&mut byte)).await {
                    assert_eq!(read.unwrap(), 0);
                }
                assert!(tokio::time::timeout(std::time::Duration::from_millis(20), listener.accept()).await.is_err());
            });
            let result = transfer.open_source(AttachmentMoveDownloadRequest {
                download_url: url, headers: vec![], max_response_bytes: 3, max_chunk_bytes: 3,
            }).await;
            match result {
                Err(error) => assert_eq!(error, TransferError::Transient),
                Ok(mut download) => assert_eq!(download.next_chunk().await, Err(TransferError::Transient)),
            }
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn dropping_pending_download_read_closes_socket_and_retires_handle() {
        let directory = tempfile::tempdir().unwrap();
        let transfer =
            NativeBinaryTransfer::new(Arc::new(NativeFiles::open(directory.path()).unwrap()))
                .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/pending", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            request_headers(&mut socket).await;
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 7\r\n\r\n")
                .await
                .unwrap();
            let mut byte = [0];
            assert_eq!(
                tokio::time::timeout(std::time::Duration::from_secs(2), socket.read(&mut byte))
                    .await
                    .unwrap()
                    .unwrap(),
                0
            );
        });
        let mut download = transfer
            .open_source(AttachmentMoveDownloadRequest {
                download_url: url,
                headers: vec![],
                max_response_bytes: 7,
                max_chunk_bytes: 3,
            })
            .await
            .unwrap();
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), download.next_chunk())
                .await
                .is_err()
        );
        assert_eq!(download.next_chunk().await, Err(TransferError::Invariant));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn foreground_upload_streams_exact_ciphertext_and_verified_digest_then_removes_spool() {
        use bittery_client_core::{
            AttachmentUploadBinaryOutcome, AttachmentUploadTransferPort, RequestCancellation,
        };
        let directory = tempfile::tempdir().unwrap();
        let transfer =
            NativeBinaryTransfer::new(Arc::new(NativeFiles::open(directory.path()).unwrap()))
                .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "http://{}/upload?signed=opaque",
            listener.local_addr().unwrap()
        );
        let digest = "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let headers = request_headers(&mut socket).await;
            assert!(headers.starts_with("PUT /upload?signed=opaque HTTP/1.1\r\n"));
            assert!(headers.contains("content-length: 3\r\n"));
            assert!(headers.contains("content-type: application/octet-stream\r\n"));
            assert!(headers.contains(&format!("x-amz-content-sha256: {digest}\r\n")));
            let mut bytes = [0; 3];
            socket.read_exact(&mut bytes).await.unwrap();
            assert_eq!(bytes, [1, 2, 3]);
            // A successful response does not require buffering or consuming its body.
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1000000000\r\n\r\n")
                .await
                .unwrap();
        });
        let mut upload = transfer
            .open(
                &AccountId::from("account"),
                "attachment",
                &url,
                3,
                RequestCancellation::new(),
            )
            .await
            .unwrap();
        upload
            .write(&[1, 2], RequestCancellation::new())
            .await
            .unwrap();
        upload
            .write(&[3], RequestCancellation::new())
            .await
            .unwrap();
        assert_eq!(
            upload
                .finish(digest, RequestCancellation::new())
                .await
                .unwrap(),
            AttachmentUploadBinaryOutcome::Uploaded {
                ciphertext_sha256: digest.into()
            }
        );
        upload.abort().await.unwrap();
        assert_eq!(
            std::fs::read_dir(directory.path())
                .unwrap()
                .flat_map(|account| std::fs::read_dir(account.unwrap().path()).unwrap())
                .count(),
            0
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn foreground_upload_accepts_actual_encryptor_output_larger_than_transport_chunks() {
        use bittery_crypto_core::attachment_move::{
            AttachmentBlobEncryptor, AttachmentBlobScope, MAX_ATTACHMENT_ENVELOPE_INPUT_CHUNK,
        };
        let mut encryptor = AttachmentBlobEncryptor::new(
            [7; 32],
            AttachmentBlobScope::new("vault".into(), "attachment".into(), "user".into()),
        )
        .unwrap();
        let encrypted = encryptor
            .push(&vec![0x59; MAX_ATTACHMENT_ENVELOPE_INPUT_CHUNK])
            .unwrap();
        assert!(encrypted.len() > ARTIFACT_CHUNK_BYTES);
        let finish = encryptor.finish().unwrap();
        let mut expected = encrypted.clone();
        expected.extend_from_slice(&finish.final_chunk);
        let directory = tempfile::tempdir().unwrap();
        let transfer =
            NativeBinaryTransfer::new(Arc::new(NativeFiles::open(directory.path()).unwrap()))
                .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/actual-envelope", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let headers = request_headers(&mut socket).await;
            assert!(headers.contains(&format!("content-length: {}\r\n", expected.len())));
            let mut actual = vec![0; expected.len()];
            socket.read_exact(&mut actual).await.unwrap();
            assert_eq!(actual, expected);
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .await
                .unwrap();
        });
        let mut upload = transfer
            .open(
                &AccountId::from("account"),
                "attachment",
                &url,
                finish.byte_length,
                RequestCancellation::new(),
            )
            .await
            .unwrap();
        upload
            .write(&encrypted, RequestCancellation::new())
            .await
            .unwrap();
        upload
            .write(&finish.final_chunk, RequestCancellation::new())
            .await
            .unwrap();
        assert_eq!(
            upload
                .finish(&finish.ciphertext_sha256, RequestCancellation::new())
                .await
                .unwrap(),
            AttachmentUploadBinaryOutcome::Uploaded {
                ciphertext_sha256: finish.ciphertext_sha256
            }
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn move_upload_enforces_owner_scope_and_uses_same_verified_stream() {
        let directory = tempfile::tempdir().unwrap();
        let transfer =
            NativeBinaryTransfer::new(Arc::new(NativeFiles::open(directory.path()).unwrap()))
                .unwrap();
        let account = AccountId::from("account");
        let digest = "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
        let owner = AttachmentArtifactOwner::from_reference_parts(
            account.clone(),
            "operation",
            "attachment",
            "d8945c7a54a128ce16e3fd3f3a516627e6438920f9d035e24233cae505c357cb",
            digest,
            3,
        )
        .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let grant = AttachmentMoveUploadGrant {
            attachment_id: "attachment".into(),
            storage_key: "opaque-storage-key".into(),
            upload_url: format!("http://{}/move", listener.local_addr().unwrap()),
            headers: vec![
                ("Content-Length".into(), "3".into()),
                ("Content-Type".into(), "application/octet-stream".into()),
                ("x-amz-content-sha256".into(), digest.into()),
                (
                    "x-amz-checksum-sha256".into(),
                    "A5BYxvLAy0ksUzsKTRTvd8wPeKvMztUofYShogEc+4E=".into(),
                ),
            ],
        };
        for (account_id, operation) in [
            (&account, "wrong-operation"),
            (&AccountId::from("other"), "operation"),
        ] {
            assert!(matches!(
                transfer
                    .open_upload(account_id, operation, &grant, &owner)
                    .await,
                Err(TransferError::Invariant)
            ));
        }
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let headers = request_headers(&mut socket).await;
            assert!(headers.contains(&format!("x-amz-content-sha256: {digest}\r\n")));
            assert!(headers.contains("content-length: 3\r\n"));
            assert!(headers.contains("content-type: application/octet-stream\r\n"));
            assert!(headers.contains(
                "x-amz-checksum-sha256: A5BYxvLAy0ksUzsKTRTvd8wPeKvMztUofYShogEc+4E=\r\n"
            ));
            let mut bytes = [0; 3];
            socket.read_exact(&mut bytes).await.unwrap();
            assert_eq!(bytes, [1, 2, 3]);
            socket
                .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
                .await
                .unwrap();
        });
        let mut upload = transfer
            .open_upload(&account, "operation", &grant, &owner)
            .await
            .unwrap();
        upload.write_chunk(&[1, 2, 3]).await.unwrap();
        upload.finish().await.unwrap();
        server.await.unwrap();
    }

    fn spool_file_count(directory: &std::path::Path) -> usize {
        std::fs::read_dir(directory)
            .unwrap()
            .flat_map(|account| std::fs::read_dir(account.unwrap().path()).unwrap())
            .count()
    }

    #[cfg(target_os = "linux")]
    async fn assert_spool_handles_closed(directory: &std::path::Path) {
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let still_open = std::fs::read_dir("/proc/self/fd")
                    .unwrap()
                    .filter_map(|entry| std::fs::read_link(entry.ok()?.path()).ok())
                    .any(|path| path.starts_with(directory));
                if !still_open {
                    return;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("A transfer retained its anonymous ciphertext file handle");
    }

    #[tokio::test]
    async fn invalid_upload_chunks_lengths_and_digest_never_dispatch_and_cleanup_is_idempotent() {
        let directory = tempfile::tempdir().unwrap();
        let transfer =
            NativeBinaryTransfer::new(Arc::new(NativeFiles::open(directory.path()).unwrap()))
                .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/unused", listener.local_addr().unwrap());
        for bytes in [vec![], vec![1, 2, 3, 4], vec![0; ARTIFACT_CHUNK_BYTES + 1]] {
            let mut upload = transfer
                .open(
                    &AccountId::from("account"),
                    "attachment",
                    &url,
                    3,
                    RequestCancellation::new(),
                )
                .await
                .unwrap();
            assert_eq!(
                upload.write(&bytes, RequestCancellation::new()).await,
                Err(TransferError::Invariant)
            );
            upload.abort().await.unwrap();
            assert_eq!(spool_file_count(directory.path()), 0);
        }
        for (bytes, digest) in [
            (&[1, 2, 3][..], "0".repeat(64)),
            (
                &[1, 2][..],
                "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81".into(),
            ),
        ] {
            let mut upload = transfer
                .open(
                    &AccountId::from("account"),
                    "attachment",
                    &url,
                    3,
                    RequestCancellation::new(),
                )
                .await
                .unwrap();
            upload
                .write(bytes, RequestCancellation::new())
                .await
                .unwrap();
            assert_eq!(
                upload.finish(&digest, RequestCancellation::new()).await,
                Err(TransferError::Invariant)
            );
            upload.abort().await.unwrap();
            upload.abort().await.unwrap();
            assert_eq!(spool_file_count(directory.path()), 0);
        }
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), listener.accept())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn cancelled_or_dropped_upload_finish_closes_pending_socket_and_removes_ciphertext() {
        for cancel_explicitly in [true, false] {
            let directory = tempfile::tempdir().unwrap();
            let transfer =
                NativeBinaryTransfer::new(Arc::new(NativeFiles::open(directory.path()).unwrap()))
                    .unwrap();
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}/pending", listener.local_addr().unwrap());
            let cancellation = RequestCancellation::new();
            let server_cancellation = cancellation.clone();
            let (received, body_received) = tokio::sync::oneshot::channel();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                request_headers(&mut socket).await;
                let mut bytes = [0; 3];
                socket.read_exact(&mut bytes).await.unwrap();
                received.send(()).unwrap();
                if cancel_explicitly {
                    server_cancellation.cancel();
                }
                let mut byte = [0];
                assert_eq!(
                    tokio::time::timeout(std::time::Duration::from_secs(2), socket.read(&mut byte))
                        .await
                        .unwrap()
                        .unwrap(),
                    0
                );
            });
            let mut upload = transfer
                .open(
                    &AccountId::from("account"),
                    "attachment",
                    &url,
                    3,
                    RequestCancellation::new(),
                )
                .await
                .unwrap();
            upload
                .write(&[1, 2, 3], RequestCancellation::new())
                .await
                .unwrap();
            let digest = "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
            if cancel_explicitly {
                assert_eq!(
                    upload.finish(digest, cancellation).await.unwrap(),
                    AttachmentUploadBinaryOutcome::Cancelled
                );
            } else {
                let finish = upload.finish(digest, cancellation);
                tokio::pin!(finish);
                tokio::select! {
                    biased;
                    _ = body_received => {},
                    _ = &mut finish => panic!("Server has not replied"),
                }
            }
            upload.abort().await.unwrap();
            assert_eq!(spool_file_count(directory.path()), 0);
            server.await.unwrap();
            #[cfg(target_os = "linux")]
            assert_spool_handles_closed(directory.path()).await;
        }
    }

    #[tokio::test]
    async fn upload_distinguishes_http_rejection_from_ambiguous_transport_and_never_redirects() {
        for response in [Some(&b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"[..]), Some(&b"HTTP/1.1 307 Temporary Redirect\r\nLocation: /must-not-follow\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"[..]), None] {
            let directory = tempfile::tempdir().unwrap();
            let transfer = NativeBinaryTransfer::new(Arc::new(NativeFiles::open(directory.path()).unwrap())).unwrap();
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}/upload", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                request_headers(&mut socket).await;
                let mut bytes = [0; 3]; socket.read_exact(&mut bytes).await.unwrap();
                if let Some(response) = response { socket.write_all(response).await.unwrap(); }
                drop(socket);
                assert!(tokio::time::timeout(std::time::Duration::from_millis(20), listener.accept()).await.is_err());
            });
            let mut upload = transfer.open(&AccountId::from("account"), "attachment", &url, 3, RequestCancellation::new()).await.unwrap();
            upload.write(&[1, 2, 3], RequestCancellation::new()).await.unwrap();
            let outcome = upload.finish("039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81", RequestCancellation::new()).await.unwrap();
            assert_eq!(outcome, match response {
                Some(bytes) if bytes.starts_with(b"HTTP/1.1 403") => AttachmentUploadBinaryOutcome::Rejected { status: 403 },
                Some(_) => AttachmentUploadBinaryOutcome::Rejected { status: 307 },
                None => AttachmentUploadBinaryOutcome::Ambiguous,
            });
            upload.abort().await.unwrap();
            assert_eq!(spool_file_count(directory.path()), 0);
            server.await.unwrap();
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn ephemeral_ciphertext_is_unnamed_and_dropping_upload_needs_no_path_cleanup() {
        let directory = tempfile::tempdir().unwrap();
        let transfer =
            NativeBinaryTransfer::new(Arc::new(NativeFiles::open(directory.path()).unwrap()))
                .unwrap();
        let mut upload = transfer
            .open(
                &AccountId::from("account"),
                "attachment",
                "http://127.0.0.1:1/unused",
                3,
                RequestCancellation::new(),
            )
            .await
            .unwrap();
        upload
            .write(&[1, 2, 3], RequestCancellation::new())
            .await
            .unwrap();
        assert_eq!(spool_file_count(directory.path()), 0);
        drop(upload);
        assert_eq!(spool_file_count(directory.path()), 0);
        #[cfg(target_os = "linux")]
        assert_spool_handles_closed(directory.path()).await;
    }

    #[tokio::test]
    async fn upload_streams_multiple_maximum_chunks_from_disk_with_exact_length() {
        let directory = tempfile::tempdir().unwrap();
        let transfer =
            NativeBinaryTransfer::new(Arc::new(NativeFiles::open(directory.path()).unwrap()))
                .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/large", listener.local_addr().unwrap());
        let length = ARTIFACT_CHUNK_BYTES * 2 + 7;
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let headers = request_headers(&mut socket).await;
            assert!(headers.contains(&format!("content-length: {length}\r\n")));
            assert!(!headers.contains("transfer-encoding:"));
            let mut received = 0;
            let mut buffer = [0; 8192];
            while received < length {
                let count = socket.read(&mut buffer).await.unwrap();
                assert!(count > 0);
                assert!(buffer[..count].iter().all(|byte| *byte == 0x5a));
                received += count;
            }
            assert_eq!(received, length);
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .await
                .unwrap();
        });
        let mut upload = transfer
            .open(
                &AccountId::from("account"),
                "attachment",
                &url,
                length as u64,
                RequestCancellation::new(),
            )
            .await
            .unwrap();
        let maximum = vec![0x5a; ARTIFACT_CHUNK_BYTES];
        upload
            .write(&maximum, RequestCancellation::new())
            .await
            .unwrap();
        upload
            .write(&maximum, RequestCancellation::new())
            .await
            .unwrap();
        upload
            .write(&[0x5a; 7], RequestCancellation::new())
            .await
            .unwrap();
        let digest = "96fd9aa94b090e3480ffb031ee454ef5fcdada5f0f15dff7f0c345c1b15bcdbf";
        assert_eq!(
            upload
                .finish(digest, RequestCancellation::new())
                .await
                .unwrap(),
            AttachmentUploadBinaryOutcome::Uploaded {
                ciphertext_sha256: digest.into()
            }
        );
        server.await.unwrap();
        #[cfg(target_os = "linux")]
        assert_spool_handles_closed(directory.path()).await;
    }

    #[tokio::test]
    async fn dropping_consumed_move_finish_releases_socket_and_ephemeral_ciphertext() {
        let directory = tempfile::tempdir().unwrap();
        let transfer =
            NativeBinaryTransfer::new(Arc::new(NativeFiles::open(directory.path()).unwrap()))
                .unwrap();
        let account = AccountId::from("account");
        let owner = AttachmentArtifactOwner::from_reference_parts(
            account.clone(),
            "operation",
            "attachment",
            "d8945c7a54a128ce16e3fd3f3a516627e6438920f9d035e24233cae505c357cb",
            "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
            3,
        )
        .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let grant = AttachmentMoveUploadGrant {
            attachment_id: "attachment".into(),
            storage_key: "opaque".into(),
            upload_url: format!("http://{}/pending-move", listener.local_addr().unwrap()),
            headers: Vec::new(),
        };
        let (received, body_received) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            request_headers(&mut socket).await;
            let mut bytes = [0; 3];
            socket.read_exact(&mut bytes).await.unwrap();
            received.send(()).unwrap();
            let mut byte = [0];
            assert_eq!(
                tokio::time::timeout(std::time::Duration::from_secs(2), socket.read(&mut byte))
                    .await
                    .unwrap()
                    .unwrap(),
                0
            );
        });
        let mut upload = transfer
            .open_upload(&account, "operation", &grant, &owner)
            .await
            .unwrap();
        upload.write_chunk(&[1, 2, 3]).await.unwrap();
        {
            let finish = upload.finish();
            tokio::pin!(finish);
            tokio::select! {
                biased;
                _ = body_received => {},
                _ = &mut finish => panic!("Server has not replied"),
            }
        }
        server.await.unwrap();
        #[cfg(target_os = "linux")]
        assert_spool_handles_closed(directory.path()).await;
        assert_eq!(spool_file_count(directory.path()), 0);
    }
}
