use crate::web_binary_transfer_abandonment::{invoke_armed, AbandonmentGuard, ControlStarter};
use crate::web_binary_transfer_control::{
    TransferControlRequest, TransferControlResponse, TransferHeaderControl,
};
use crate::web_binary_transfer_policy::{
    copy_validated_download_chunk, validate_sha256, UploadIntegrity, MAX_TRANSFER_CHUNK_BYTES,
};
use js_sys::{Function, Promise, Reflect, Uint8Array};
use sha2::{Digest, Sha256};
use std::rc::Rc;
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;

pub(crate) enum BinaryTransferFailure {
    Transient,
    Cancelled,
    Invariant,
}

pub(crate) struct JsBinaryTransferExecutor {
    executor: JsValue,
}

impl JsBinaryTransferExecutor {
    pub(crate) fn new(executor: JsValue) -> Result<Self, JsValue> {
        function(&executor, "invoke")?;
        function(&executor, "close")?;
        Ok(Self { executor })
    }

    pub(crate) async fn open_download(
        &self,
        transfer_id: String,
        url: String,
        headers: Vec<(String, String)>,
        max_response_bytes: u64,
        max_chunk_bytes: usize,
    ) -> Result<JsSourceDownload, BinaryTransferFailure> {
        validate_max_chunk(max_chunk_bytes)?;
        let executor = self.executor.clone();
        let starter = Rc::new(JsControlStarter(self.executor.clone()));
        let invoked_transfer_id = transfer_id.clone();
        let (mut abandonment, response) =
            invoke_armed(starter, transfer_id.clone(), move || async move {
                invoke(
                    &executor,
                    TransferControlRequest::OpenDownload {
                        transfer_id: invoked_transfer_id,
                        url,
                        headers: controls(headers),
                        max_response_bytes: max_response_bytes.to_string(),
                        max_chunk_bytes: max_chunk_bytes as u32,
                    },
                    None,
                )
                .await
            })
            .await;
        let response = response?;
        let has_bytes = response.bytes.is_some();
        match response.response {
            TransferControlResponse::DownloadOpened if !has_bytes => Ok(JsSourceDownload {
                executor: self.executor.clone(),
                abandonment,
                transfer_id,
                max_chunk_bytes,
            }),
            other => {
                let failure = if has_bytes {
                    BinaryTransferFailure::Invariant
                } else {
                    classify(other)
                };
                if !matches!(failure, BinaryTransferFailure::Invariant) {
                    abandonment.complete();
                }
                Err(failure)
            }
        }
    }

    pub(crate) async fn open_upload(
        &self,
        transfer_id: String,
        account_id: String,
        operation_id: String,
        attachment_id: String,
        artifact_id: String,
        generation: String,
        url: String,
        mut headers: Vec<(String, String)>,
        ciphertext_sha256: String,
        byte_length: u64,
        max_chunk_bytes: usize,
    ) -> Result<JsStagingUpload, BinaryTransferFailure> {
        validate_max_chunk(max_chunk_bytes)?;
        // These values are ciphertext authority, not host choices. Duplicates are rejected by the
        // generated browser adapter before Fetch begins.
        headers.push(("content-type".into(), "application/octet-stream".into()));
        headers.push(("x-amz-content-sha256".into(), ciphertext_sha256.clone()));
        let integrity = UploadIntegrity::new(byte_length, ciphertext_sha256.clone())
            .map_err(|_| BinaryTransferFailure::Invariant)?;
        let executor = self.executor.clone();
        let starter = Rc::new(JsControlStarter(self.executor.clone()));
        let invoked_transfer_id = transfer_id.clone();
        let (mut abandonment, response) =
            invoke_armed(starter, transfer_id.clone(), move || async move {
                invoke(
                    &executor,
                    TransferControlRequest::BeginUpload {
                        transfer_id: invoked_transfer_id,
                        account_id,
                        operation_id,
                        attachment_id,
                        artifact_id,
                        generation,
                        url,
                        headers: controls(headers),
                        ciphertext_sha256,
                        byte_length: byte_length.to_string(),
                        max_chunk_bytes: max_chunk_bytes as u32,
                    },
                    None,
                )
                .await
            })
            .await;
        let response = response?;
        let has_bytes = response.bytes.is_some();
        match response.response {
            TransferControlResponse::UploadBegun if !has_bytes => Ok(JsStagingUpload {
                executor: self.executor.clone(),
                abandonment,
                transfer_id,
                integrity,
            }),
            other => {
                let failure = if has_bytes {
                    BinaryTransferFailure::Invariant
                } else {
                    classify(other)
                };
                if !matches!(failure, BinaryTransferFailure::Invariant) {
                    abandonment.complete();
                }
                Err(failure)
            }
        }
    }

    /// Destroys one named Account's spooled ciphertext.
    pub(crate) async fn delete_account(&self, account_id: String) -> Result<(), ()> {
        self.destroy(
            TransferControlRequest::DeleteAccount { account_id },
            TransferControlResponse::AccountDeleted,
        )
        .await
    }

    /// Destroys every Account's spooled ciphertext on this Device.
    pub(crate) async fn wipe_device(&self) -> Result<(), ()> {
        self.destroy(
            TransferControlRequest::WipeDevice,
            TransferControlResponse::DeviceWiped,
        )
        .await
    }

    /// Destruction converges only on the exact expected answer. A transient classification would
    /// be a lie here: the host either destroyed the named scope or it did not.
    async fn destroy(
        &self,
        request: TransferControlRequest,
        expected: TransferControlResponse,
    ) -> Result<(), ()> {
        let result = invoke(&self.executor, request, None)
            .await
            .map_err(|_| ())?;
        if result.response == expected && result.bytes.is_none() {
            Ok(())
        } else {
            Err(())
        }
    }

    pub(crate) fn close(&self) {
        if let Ok(close) = function(&self.executor, "close") {
            let _ = close.call0(&self.executor);
        }
    }
}

pub(crate) struct JsSourceDownload {
    executor: JsValue,
    transfer_id: String,
    max_chunk_bytes: usize,
    abandonment: AbandonmentGuard,
}

impl JsSourceDownload {
    pub(crate) async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, BinaryTransferFailure> {
        if self.abandonment.is_complete() {
            return Ok(None);
        }
        let result = invoke(
            &self.executor,
            TransferControlRequest::ReadDownloadChunk {
                transfer_id: self.transfer_id.clone(),
            },
            None,
        )
        .await?;
        match result.response {
            TransferControlResponse::DownloadChunk {
                byte_length,
                chunk_sha256,
            } => {
                let bytes = result.bytes.ok_or(BinaryTransferFailure::Invariant)?;
                let host_length = Reflect::get(&bytes, &JsValue::from_str("byteLength"))
                    .ok()
                    .and_then(|value| value.as_f64())
                    .filter(|value| value.is_finite() && *value >= 0.0 && value.fract() == 0.0)
                    .map(|value| value as usize)
                    .ok_or(BinaryTransferFailure::Invariant)?;
                copy_validated_download_chunk(
                    byte_length,
                    self.max_chunk_bytes,
                    &chunk_sha256,
                    host_length,
                    || Uint8Array::new(&bytes).to_vec(),
                )
                .map(Some)
                .map_err(|_| BinaryTransferFailure::Invariant)
            }
            TransferControlResponse::DownloadFinished => {
                if result.bytes.is_some() {
                    return Err(BinaryTransferFailure::Invariant);
                }
                self.abandonment.complete();
                Ok(None)
            }
            other => {
                let failure = classify(other);
                if !matches!(failure, BinaryTransferFailure::Invariant) {
                    self.abandonment.complete();
                }
                Err(failure)
            }
        }
    }

    pub(crate) async fn cancel(&mut self) -> Result<(), BinaryTransferFailure> {
        if self.abandonment.is_complete() {
            return Ok(());
        }
        let response = invoke(
            &self.executor,
            TransferControlRequest::CancelTransfer {
                transfer_id: self.transfer_id.clone(),
            },
            None,
        )
        .await?;
        self.abandonment.complete();
        if response.response != TransferControlResponse::Cancelled || response.bytes.is_some() {
            return Err(BinaryTransferFailure::Invariant);
        }
        Ok(())
    }
}

pub(crate) struct JsStagingUpload {
    executor: JsValue,
    transfer_id: String,
    integrity: UploadIntegrity,
    abandonment: AbandonmentGuard,
}

impl JsStagingUpload {
    pub(crate) async fn write_chunk(&mut self, bytes: &[u8]) -> Result<(), BinaryTransferFailure> {
        if self.abandonment.is_complete() {
            return Err(BinaryTransferFailure::Invariant);
        }
        if self.integrity.push(bytes).is_err() {
            self.cancel().await;
            return Err(BinaryTransferFailure::Invariant);
        }
        let chunk_sha256 = format!("{:x}", Sha256::digest(bytes));
        validate_sha256(bytes, &chunk_sha256).map_err(|_| BinaryTransferFailure::Invariant)?;
        let response = match invoke(
            &self.executor,
            TransferControlRequest::WriteUploadChunk {
                transfer_id: self.transfer_id.clone(),
                byte_length: bytes.len() as u32,
                chunk_sha256,
            },
            Some(bytes),
        )
        .await
        {
            Ok(response) => response,
            Err(error) => {
                self.cancel().await;
                return Err(error);
            }
        };
        if response.response != TransferControlResponse::UploadChunkAccepted
            || response.bytes.is_some()
        {
            self.cancel().await;
            return Err(BinaryTransferFailure::Invariant);
        }
        Ok(())
    }

    pub(crate) async fn finish(mut self) -> Result<(), BinaryTransferFailure> {
        if self.integrity.finish().is_err() {
            self.cancel().await;
            return Err(BinaryTransferFailure::Invariant);
        }
        let response = match invoke(
            &self.executor,
            TransferControlRequest::FinishUpload {
                transfer_id: self.transfer_id.clone(),
            },
            None,
        )
        .await
        {
            Ok(response) => response,
            Err(error) => {
                self.cancel().await;
                return Err(error);
            }
        };
        match response.response {
            TransferControlResponse::UploadFinished if response.bytes.is_none() => {
                self.abandonment.complete();
                Ok(())
            }
            other => {
                let failure = classify(other);
                if matches!(failure, BinaryTransferFailure::Invariant) {
                    self.cancel().await;
                } else {
                    self.abandonment.complete();
                }
                Err(failure)
            }
        }
    }

    async fn cancel(&mut self) {
        if self.abandonment.is_complete() {
            return;
        }
        let _ = invoke(
            &self.executor,
            TransferControlRequest::CancelTransfer {
                transfer_id: self.transfer_id.clone(),
            },
            None,
        )
        .await;
        self.abandonment.complete();
    }
}

struct JsControlStarter(JsValue);

impl ControlStarter for JsControlStarter {
    fn start(&self, request: TransferControlRequest) {
        let _ = start_invoke(&self.0, request, None);
    }
}

struct ControlResult {
    response: TransferControlResponse,
    bytes: Option<JsValue>,
}

async fn invoke(
    executor: &JsValue,
    request: TransferControlRequest,
    bytes: Option<&[u8]>,
) -> Result<ControlResult, BinaryTransferFailure> {
    let promise = start_invoke(executor, request, bytes)?;
    let result = JsFuture::from(promise)
        .await
        .map_err(|_| BinaryTransferFailure::Invariant)?;
    let response_json = Reflect::get(&result, &JsValue::from_str("controlResponseJson"))
        .ok()
        .and_then(|value| value.as_string())
        .ok_or(BinaryTransferFailure::Invariant)?;
    let response =
        serde_json::from_str(&response_json).map_err(|_| BinaryTransferFailure::Invariant)?;
    let bytes = Reflect::get(&result, &JsValue::from_str("bytes"))
        .ok()
        .filter(|value| !value.is_undefined());
    Ok(ControlResult { response, bytes })
}

fn start_invoke(
    executor: &JsValue,
    request: TransferControlRequest,
    bytes: Option<&[u8]>,
) -> Result<Promise, BinaryTransferFailure> {
    let invoke = function(executor, "invoke").map_err(|_| BinaryTransferFailure::Invariant)?;
    let request = serde_json::to_string(&request).map_err(|_| BinaryTransferFailure::Invariant)?;
    let promise = match bytes {
        Some(bytes) => invoke.call2(
            executor,
            &JsValue::from_str(&request),
            &Uint8Array::from(bytes),
        ),
        None => invoke.call1(executor, &JsValue::from_str(&request)),
    }
    .map_err(|_| BinaryTransferFailure::Invariant)?
    .dyn_into::<Promise>()
    .map_err(|_| BinaryTransferFailure::Invariant)?;
    Ok(promise)
}

fn function(value: &JsValue, name: &str) -> Result<Function, JsValue> {
    Reflect::get(value, &JsValue::from_str(name))?.dyn_into::<Function>()
}

fn controls(headers: Vec<(String, String)>) -> Vec<TransferHeaderControl> {
    headers
        .into_iter()
        .map(|(name, value)| TransferHeaderControl { name, value })
        .collect()
}

fn validate_max_chunk(max_chunk_bytes: usize) -> Result<(), BinaryTransferFailure> {
    if max_chunk_bytes == 0 || max_chunk_bytes > MAX_TRANSFER_CHUNK_BYTES {
        return Err(BinaryTransferFailure::Invariant);
    }
    Ok(())
}

fn classify(response: TransferControlResponse) -> BinaryTransferFailure {
    match response {
        TransferControlResponse::NetworkFailure
        | TransferControlResponse::HttpFailure { .. }
        | TransferControlResponse::ResponseTooLarge => BinaryTransferFailure::Transient,
        TransferControlResponse::Cancelled => BinaryTransferFailure::Cancelled,
        _ => BinaryTransferFailure::Invariant,
    }
}
