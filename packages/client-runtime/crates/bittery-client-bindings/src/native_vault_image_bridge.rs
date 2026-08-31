use crate::{
    vault_image_control::{
        VaultImageChunkWriteControl, VaultImageControlRequest, VaultImageControlResponse,
        VaultImageMetadataControl, VaultImagePublicationControl, VaultImageScopeControl,
        VaultImageSourceControlRequest, VaultImageSourceControlResponse,
    },
    BindingError, ClientRuntime, PreparedVaultImage, SensitiveVaultImageChunk,
    VaultImageArtifactExecutor, VaultImagePortAnswer, VaultImagePreparationRequest,
    VaultImageSourceExecutor,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use bittery_client_core as core;
use std::{collections::HashSet, sync::Arc};
use zeroize::Zeroizing;

struct NativeArtifactPort(Arc<dyn VaultImageArtifactExecutor>);
struct NativeSourcePort(Arc<dyn VaultImageSourceExecutor>);
struct NativePortAnswer {
    control_response_json: String,
    binary_chunk: Option<Zeroizing<Vec<u8>>>,
}

fn lift_answer(answer: Arc<dyn VaultImagePortAnswer>) -> Result<NativePortAnswer, ()> {
    let control_response_json = answer.control_response_json();
    let encoded = answer.take_binary_chunk_base64();
    let binary_chunk = if encoded.0.is_empty() {
        None
    } else {
        if encoded.0.len() > 349_528 {
            return Err(());
        }
        let decoded = Zeroizing::new(BASE64.decode(encoded.0.as_bytes()).map_err(|_| ())?);
        if decoded.len() > 262_144 || BASE64.encode(&*decoded) != encoded.0.as_str() {
            return Err(());
        }
        Some(decoded)
    };
    Ok(NativePortAnswer {
        control_response_json,
        binary_chunk,
    })
}

#[uniffi::export]
pub fn new_client_runtime_with_vault_image_ports(
    runtime_incarnation: String,
    artifacts: Arc<dyn VaultImageArtifactExecutor>,
    sources: Arc<dyn VaultImageSourceExecutor>,
) -> Result<Arc<ClientRuntime>, BindingError> {
    let runtime = ClientRuntime::headless();
    let facade = core::VaultImageIngressFacade::new(
        runtime_incarnation,
        Arc::new(NativeSourcePort(sources)),
        Arc::new(NativeArtifactPort(artifacts)),
    )?;
    runtime.inner.install_vault_image_ingress(facade);
    Ok(runtime)
}

#[uniffi::export(async_runtime = "tokio")]
pub async fn prepare_vault_image(
    runtime: Arc<ClientRuntime>,
    request: VaultImagePreparationRequest,
) -> Result<PreparedVaultImage, BindingError> {
    let prepared = runtime
        .inner
        .prepare_vault_image(
            core::VaultImageSourceGrant {
                runtime_incarnation: request.runtime_incarnation,
                account_id: request.account_id.into(),
                operation_id: request.operation_id,
                vault_id: request.vault_id,
                capability_id: request.capability_id,
                content_type: request.content_type,
                byte_length: request.byte_length,
            },
            core::RequestCancellation::new(),
        )
        .await?;
    let metadata = prepared.metadata();
    Ok(PreparedVaultImage {
        account_id: metadata.account_id().as_str().into(),
        operation_id: metadata.operation_id().into(),
        vault_id: metadata.vault_id().into(),
        content_type: metadata.content_type().into(),
        byte_length: metadata.byte_length(),
        sha256: metadata.sha256().into(),
    })
}

#[uniffi::export(async_runtime = "tokio")]
pub async fn begin_vault_image_acceptance(
    runtime: Arc<ClientRuntime>,
    account_id: String,
    operation_id: String,
) -> Result<(), BindingError> {
    runtime
        .inner
        .begin_vault_image_acceptance(&account_id.into(), &operation_id)
        .await?;
    Ok(())
}

#[uniffi::export(async_runtime = "tokio")]
pub async fn end_vault_image_acceptance(
    runtime: Arc<ClientRuntime>,
    account_id: String,
    operation_id: String,
) -> Result<(), BindingError> {
    runtime
        .inner
        .end_vault_image_acceptance(&account_id.into(), &operation_id)
        .await?;
    Ok(())
}

impl NativeArtifactPort {
    fn invoke(
        &self,
        request: VaultImageControlRequest,
        binary: Option<Vec<u8>>,
    ) -> Result<NativePortAnswer, core::RuntimeError> {
        let binary = binary
            .map(|bytes| {
                let bytes = Zeroizing::new(bytes);
                SensitiveVaultImageChunk(Zeroizing::new(BASE64.encode(&*bytes)))
            })
            .unwrap_or_else(|| SensitiveVaultImageChunk(Zeroizing::new(String::new())));
        self.0
            .invoke(
                serde_json::to_string(&request).map_err(|_| invariant())?,
                binary,
            )
            .and_then(|answer| {
                lift_answer(answer).map_err(|_| BindingError::Runtime {
                    code: crate::RuntimeErrorCode::InvariantViolation,
                    message: "Vault image native answer is invalid".into(),
                })
            })
            .map_err(|_| invariant())
    }
}

#[async_trait::async_trait]
impl core::VaultImageArtifactPort for NativeArtifactPort {
    async fn begin(&self, scope: &core::VaultImageArtifactScope) -> Result<(), core::RuntimeError> {
        expect_artifact(
            self.invoke(
                VaultImageControlRequest::Begin {
                    scope: scope.into(),
                },
                None,
            )?,
            VaultImageControlResponse::Begun,
        )
    }
    async fn write_chunk(
        &self,
        scope: &core::VaultImageArtifactScope,
        chunk_index: u32,
        bytes: &[u8],
    ) -> Result<core::VaultImageChunkWrite, core::RuntimeError> {
        let bytes = Zeroizing::new(bytes.to_vec());
        let mut bytes = bytes;
        let answer = self.invoke(
            VaultImageControlRequest::WriteChunk {
                scope: scope.into(),
                chunk_index,
            },
            Some(std::mem::take(&mut *bytes)),
        )?;
        if answer.binary_chunk.is_some() {
            return Err(invariant());
        }
        match parse_artifact(&answer)? {
            VaultImageControlResponse::ChunkWritten { result } => Ok(match result {
                VaultImageChunkWriteControl::Stored => core::VaultImageChunkWrite::Stored,
                VaultImageChunkWriteControl::AlreadyStored => {
                    core::VaultImageChunkWrite::AlreadyStored
                }
            }),
            _ => Err(invariant()),
        }
    }
    async fn publish(
        &self,
        metadata: &core::VaultImageArtifactMetadata,
    ) -> Result<core::VaultImagePublication, core::RuntimeError> {
        let answer = self.invoke(
            VaultImageControlRequest::Publish {
                metadata: metadata.into(),
            },
            None,
        )?;
        if answer.binary_chunk.is_some() {
            return Err(invariant());
        }
        match parse_artifact(&answer)? {
            VaultImageControlResponse::Published { result } => Ok(match result {
                VaultImagePublicationControl::Published => core::VaultImagePublication::Published,
                VaultImagePublicationControl::AlreadyPublished => {
                    core::VaultImagePublication::AlreadyPublished
                }
            }),
            _ => Err(invariant()),
        }
    }
    async fn read_chunk(
        &self,
        metadata: &core::VaultImageArtifactMetadata,
        chunk_index: u32,
    ) -> Result<Option<Vec<u8>>, core::RuntimeError> {
        let mut answer = self.invoke(
            VaultImageControlRequest::ReadChunk {
                metadata: metadata.into(),
                chunk_index,
            },
            None,
        )?;
        let binary = answer.binary_chunk.take();
        let response = parse_artifact(&answer)?;
        match (response, binary) {
            (VaultImageControlResponse::Chunk, Some(mut bytes)) => {
                Ok(Some(std::mem::take(&mut *bytes)))
            }
            (VaultImageControlResponse::Missing, None) => Ok(None),
            _ => Err(invariant()),
        }
    }
    async fn delete(
        &self,
        scope: &core::VaultImageArtifactScope,
    ) -> Result<(), core::RuntimeError> {
        expect_artifact(
            self.invoke(
                VaultImageControlRequest::Delete {
                    scope: scope.into(),
                },
                None,
            )?,
            VaultImageControlResponse::Deleted,
        )
    }
    async fn delete_account(&self, account_id: &core::AccountId) -> Result<(), core::RuntimeError> {
        expect_artifact(
            self.invoke(
                VaultImageControlRequest::DeleteAccount {
                    account_id: account_id.as_str().into(),
                },
                None,
            )?,
            VaultImageControlResponse::AccountDeleted,
        )
    }
    async fn wipe(&self) -> Result<(), core::RuntimeError> {
        expect_artifact(
            self.invoke(VaultImageControlRequest::Wipe, None)?,
            VaultImageControlResponse::Wiped,
        )
    }
    async fn sweep_orphans(
        &self,
        account_id: &core::AccountId,
        referenced_operations: &HashSet<String>,
    ) -> Result<(), core::RuntimeError> {
        let mut referenced_operation_ids =
            referenced_operations.iter().cloned().collect::<Vec<_>>();
        referenced_operation_ids.sort();
        expect_artifact(
            self.invoke(
                VaultImageControlRequest::StartupSweep {
                    account_id: account_id.as_str().into(),
                    referenced_operation_ids,
                },
                None,
            )?,
            VaultImageControlResponse::Swept,
        )
    }
}

struct NativeSource {
    port: Arc<dyn VaultImageSourceExecutor>,
    capability_id: String,
}
impl NativeSourcePort {
    fn invoke(
        &self,
        request: VaultImageSourceControlRequest,
    ) -> Result<NativePortAnswer, core::VaultImageSourceError> {
        self.0
            .invoke(
                serde_json::to_string(&request)
                    .map_err(|_| core::VaultImageSourceError::Invariant)?,
            )
            .and_then(|answer| {
                lift_answer(answer).map_err(|_| BindingError::Runtime {
                    code: crate::RuntimeErrorCode::InvariantViolation,
                    message: "Vault image native answer is invalid".into(),
                })
            })
            .map_err(|_| core::VaultImageSourceError::Source)
    }
}
#[async_trait::async_trait]
impl core::VaultImageSource for NativeSource {
    async fn next_chunk(
        &mut self,
        max_bytes: usize,
    ) -> Result<Option<Vec<u8>>, core::VaultImageSourceError> {
        let request = VaultImageSourceControlRequest::Read {
            capability_id: self.capability_id.clone(),
            max_bytes: u32::try_from(max_bytes)
                .map_err(|_| core::VaultImageSourceError::Invariant)?,
        };
        let mut answer = self
            .port
            .invoke(
                serde_json::to_string(&request)
                    .map_err(|_| core::VaultImageSourceError::Invariant)?,
            )
            .and_then(|answer| {
                lift_answer(answer).map_err(|_| BindingError::Runtime {
                    code: crate::RuntimeErrorCode::InvariantViolation,
                    message: "Vault image native answer is invalid".into(),
                })
            })
            .map_err(|_| core::VaultImageSourceError::Source)?;
        let binary = answer.binary_chunk.take();
        let response = parse_source(&answer)?;
        match (response, binary) {
            (VaultImageSourceControlResponse::Chunk, Some(mut bytes)) => {
                Ok(Some(std::mem::take(&mut *bytes)))
            }
            (VaultImageSourceControlResponse::End, None) => Ok(None),
            (VaultImageSourceControlResponse::Cancelled, None) => {
                Err(core::VaultImageSourceError::Cancelled)
            }
            _ => Err(core::VaultImageSourceError::Invariant),
        }
    }
    async fn close(&mut self) -> Result<(), core::VaultImageSourceError> {
        let answer = self
            .port
            .invoke(
                serde_json::to_string(&VaultImageSourceControlRequest::Close {
                    capability_id: self.capability_id.clone(),
                })
                .map_err(|_| core::VaultImageSourceError::Invariant)?,
            )
            .and_then(|answer| {
                lift_answer(answer).map_err(|_| BindingError::Runtime {
                    code: crate::RuntimeErrorCode::InvariantViolation,
                    message: "Vault image native answer is invalid".into(),
                })
            })
            .map_err(|_| core::VaultImageSourceError::Source)?;
        expect_source_answer(answer, VaultImageSourceControlResponse::Closed)
    }
}
#[async_trait::async_trait]
impl core::VaultImageSourcePort for NativeSourcePort {
    async fn claim(
        &self,
        grant: &core::VaultImageSourceGrant,
    ) -> Result<Box<dyn core::VaultImageSource>, core::VaultImageSourceError> {
        let answer = self.invoke(VaultImageSourceControlRequest::Claim {
            capability_id: grant.capability_id.clone(),
            account_id: grant.account_id.as_str().into(),
            operation_id: grant.operation_id.clone(),
            vault_id: grant.vault_id.clone(),
            content_type: grant.content_type.clone(),
            byte_length: grant.byte_length.to_string(),
        })?;
        expect_source_answer(answer, VaultImageSourceControlResponse::Claimed)?;
        Ok(Box::new(NativeSource {
            port: Arc::clone(&self.0),
            capability_id: grant.capability_id.clone(),
        }))
    }
    async fn retire_account(
        &self,
        _runtime_incarnation: &str,
        account_id: &core::AccountId,
    ) -> Result<(), core::VaultImageSourceError> {
        let answer = self.invoke(VaultImageSourceControlRequest::RetireAccount {
            account_id: account_id.as_str().into(),
        })?;
        expect_source_answer(answer, VaultImageSourceControlResponse::Retired)
    }
    async fn complete_account_retirement(
        &self,
        _runtime_incarnation: &str,
        account_id: &core::AccountId,
    ) -> Result<(), core::VaultImageSourceError> {
        let answer = self.invoke(VaultImageSourceControlRequest::CompleteAccountRetirement {
            account_id: account_id.as_str().into(),
        })?;
        expect_source_answer(answer, VaultImageSourceControlResponse::Retired)
    }
    async fn begin_acceptance(
        &self,
        _runtime_incarnation: &str,
        account_id: &core::AccountId,
        operation_id: &str,
    ) -> Result<(), core::VaultImageSourceError> {
        let answer = self.invoke(VaultImageSourceControlRequest::BeginAcceptance {
            account_id: account_id.as_str().into(),
            operation_id: operation_id.into(),
        })?;
        expect_source_answer(answer, VaultImageSourceControlResponse::AcceptanceBegun)
    }
    async fn end_acceptance(
        &self,
        _runtime_incarnation: &str,
        account_id: &core::AccountId,
        operation_id: &str,
    ) -> Result<(), core::VaultImageSourceError> {
        let answer = self.invoke(VaultImageSourceControlRequest::EndAcceptance {
            account_id: account_id.as_str().into(),
            operation_id: operation_id.into(),
        })?;
        expect_source_answer(answer, VaultImageSourceControlResponse::AcceptanceEnded)
    }
    async fn retire_runtime(
        &self,
        _runtime_incarnation: &str,
    ) -> Result<(), core::VaultImageSourceError> {
        let answer = self.invoke(VaultImageSourceControlRequest::RetireRuntime)?;
        expect_source_answer(answer, VaultImageSourceControlResponse::Retired)
    }
}

impl From<&core::VaultImageArtifactScope> for VaultImageScopeControl {
    fn from(value: &core::VaultImageArtifactScope) -> Self {
        Self {
            account_id: value.account_id().as_str().into(),
            operation_id: value.operation_id().into(),
        }
    }
}
impl From<&core::VaultImageArtifactMetadata> for VaultImageMetadataControl {
    fn from(value: &core::VaultImageArtifactMetadata) -> Self {
        Self {
            scope: value.scope().into(),
            vault_id: value.vault_id().into(),
            byte_length: value.byte_length().to_string(),
            content_type: value.content_type().into(),
            sha256: value.sha256().into(),
        }
    }
}
fn parse_artifact(
    answer: &NativePortAnswer,
) -> Result<VaultImageControlResponse, core::RuntimeError> {
    serde_json::from_str(&answer.control_response_json).map_err(|_| invariant())
}
fn expect_artifact(
    answer: NativePortAnswer,
    expected: VaultImageControlResponse,
) -> Result<(), core::RuntimeError> {
    if answer.binary_chunk.is_some() || parse_artifact(&answer)? != expected {
        Err(invariant())
    } else {
        Ok(())
    }
}
fn parse_source(
    answer: &NativePortAnswer,
) -> Result<VaultImageSourceControlResponse, core::VaultImageSourceError> {
    serde_json::from_str(&answer.control_response_json)
        .map_err(|_| core::VaultImageSourceError::Invariant)
}
fn expect_source_answer(
    answer: NativePortAnswer,
    expected: VaultImageSourceControlResponse,
) -> Result<(), core::VaultImageSourceError> {
    if answer.binary_chunk.is_some() {
        return Err(core::VaultImageSourceError::Invariant);
    }
    let actual = parse_source(&answer)?;
    if actual == expected {
        Ok(())
    } else if actual == VaultImageSourceControlResponse::SourceFailure {
        Err(core::VaultImageSourceError::Source)
    } else {
        Err(core::VaultImageSourceError::Invariant)
    }
}
fn invariant() -> core::RuntimeError {
    core::RuntimeError {
        code: core::RuntimeErrorCode::InvariantViolation,
        message: "Vault image native invocation failed".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct Answer {
        control: String,
        encoded: Mutex<Option<String>>,
    }

    impl VaultImagePortAnswer for Answer {
        fn control_response_json(&self) -> String {
            self.control.clone()
        }

        fn take_binary_chunk_base64(&self) -> SensitiveVaultImageChunk {
            SensitiveVaultImageChunk(Zeroizing::new(
                self.encoded.lock().unwrap().take().unwrap_or_default(),
            ))
        }
    }

    struct ArtifactExecutor {
        received: Arc<Mutex<Vec<String>>>,
    }

    impl VaultImageArtifactExecutor for ArtifactExecutor {
        fn invoke(
            &self,
            _control_request_json: String,
            binary_chunk_base64: SensitiveVaultImageChunk,
        ) -> Result<Arc<dyn VaultImagePortAnswer>, BindingError> {
            self.received
                .lock()
                .unwrap()
                .push(binary_chunk_base64.0.to_string());
            Ok(Arc::new(Answer {
                control: r#"{"type":"begun"}"#.into(),
                encoded: Mutex::new(Some("YWJj".into())),
            }))
        }
    }

    #[test]
    fn native_answer_handle_transfers_base64_directly_and_decodes_into_rust_owned_bytes() {
        let answer = lift_answer(Arc::new(Answer {
            control: r#"{"type":"chunk"}"#.into(),
            encoded: Mutex::new(Some("YWJj".into())),
        }))
        .expect("valid canonical payload");
        assert_eq!(answer.control_response_json, r#"{"type":"chunk"}"#);
        assert_eq!(
            answer.binary_chunk.as_deref().map(Vec::as_slice),
            Some(b"abc".as_slice())
        );

        assert!(lift_answer(Arc::new(Answer {
            control: "{}".into(),
            encoded: Mutex::new(Some("not base64".into())),
        }))
        .is_err());
    }

    #[test]
    fn native_artifact_port_encodes_plaintext_before_crossing_the_callback_boundary() {
        let received = Arc::new(Mutex::new(Vec::new()));
        let port = NativeArtifactPort(Arc::new(ArtifactExecutor {
            received: Arc::clone(&received),
        }));
        let answer = port
            .invoke(
                VaultImageControlRequest::Begin {
                    scope: VaultImageScopeControl {
                        account_id: "account-a".into(),
                        operation_id: "operation-a".into(),
                    },
                },
                Some(b"abc".to_vec()),
            )
            .expect("native invocation");

        assert_eq!(&*received.lock().unwrap(), &["YWJj"]);
        assert_eq!(
            answer.binary_chunk.as_deref().map(Vec::as_slice),
            Some(b"abc".as_slice())
        );
    }
}
