#![cfg(target_arch = "wasm32")]

use crate::vault_image_control::{
    VaultImageChunkWriteControl, VaultImageControlRequest, VaultImageControlResponse,
    VaultImageMetadataControl, VaultImagePublicationControl, VaultImageScopeControl,
    VaultImageSourceControlRequest, VaultImageSourceControlResponse,
};
use bittery_client_core as core;
use js_sys::{ArrayBuffer, Function, Promise, Reflect, Uint8Array};
use std::sync::Arc;
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;
use zeroize::Zeroizing;

pub(crate) struct JsVaultImagePorts {
    pub(crate) facade: core::VaultImageIngressFacade,
}

impl JsVaultImagePorts {
    pub(crate) fn new(
        runtime_incarnation: String,
        artifact_executor: JsValue,
        source_executor: JsValue,
        take_binary: Function,
    ) -> Result<Self, JsValue> {
        let artifacts: Arc<dyn core::VaultImageArtifactPort> = Arc::new(
            JsVaultImageArtifactPort::new(artifact_executor, take_binary.clone())?,
        );
        let sources: Arc<dyn core::VaultImageSourcePort> =
            Arc::new(JsVaultImageSourcePort::new(source_executor, take_binary)?);
        let facade = core::VaultImageIngressFacade::new(runtime_incarnation, sources, artifacts)
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        Ok(Self { facade })
    }
}

struct JsVaultImageArtifactPort {
    executor: JsValue,
    take_binary: Function,
}
impl JsVaultImageArtifactPort {
    fn new(executor: JsValue, take_binary: Function) -> Result<Self, JsValue> {
        exact_executor(&executor)?;
        Ok(Self {
            executor,
            take_binary,
        })
    }
    async fn invoke(
        &self,
        request: VaultImageControlRequest,
        binary: Option<&[u8]>,
    ) -> Result<(VaultImageControlResponse, Option<Zeroizing<Vec<u8>>>), core::RuntimeError> {
        let json = serde_json::to_string(&request).map_err(|_| invariant())?;
        let function = invoke_function(&self.executor).map_err(|_| invariant())?;
        let value = match binary {
            Some(bytes) => {
                let array = Uint8Array::from(bytes);
                function.call2(&self.executor, &JsValue::from_str(&json), &array)
            }
            None => function.call1(&self.executor, &JsValue::from_str(&json)),
        }
        .map_err(|_| invariant())?
        .dyn_into::<Promise>()
        .map_err(|_| invariant())?;
        let value = JsFuture::from(value).await.map_err(|_| invariant())?;
        let response_json = Reflect::get(&value, &JsValue::from_str("controlResponseJson"))
            .map_err(|_| invariant())?
            .as_string()
            .ok_or_else(invariant)?;
        let response: VaultImageControlResponse =
            serde_json::from_str(&response_json).map_err(|_| invariant())?;
        let bytes = take_optional_binary(&value, &self.take_binary).map_err(|_| invariant())?;
        if matches!(response, VaultImageControlResponse::Chunk) != bytes.is_some() {
            return Err(invariant());
        }
        Ok((response, bytes))
    }
}

#[async_trait::async_trait(?Send)]
impl core::VaultImageArtifactPort for JsVaultImageArtifactPort {
    async fn begin(&self, scope: &core::VaultImageArtifactScope) -> Result<(), core::RuntimeError> {
        match self
            .invoke(
                VaultImageControlRequest::Begin {
                    scope: scope.into(),
                },
                None,
            )
            .await?
            .0
        {
            VaultImageControlResponse::Begun => Ok(()),
            _ => Err(invariant()),
        }
    }
    async fn write_chunk(
        &self,
        scope: &core::VaultImageArtifactScope,
        chunk_index: u32,
        bytes: &[u8],
    ) -> Result<core::VaultImageChunkWrite, core::RuntimeError> {
        match self
            .invoke(
                VaultImageControlRequest::WriteChunk {
                    scope: scope.into(),
                    chunk_index,
                },
                Some(bytes),
            )
            .await?
            .0
        {
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
        match self
            .invoke(
                VaultImageControlRequest::Publish {
                    metadata: metadata.into(),
                },
                None,
            )
            .await?
            .0
        {
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
        let (response, bytes) = self
            .invoke(
                VaultImageControlRequest::ReadChunk {
                    metadata: metadata.into(),
                    chunk_index,
                },
                None,
            )
            .await?;
        match (response, bytes) {
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
            )
            .await?
            .0,
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
            )
            .await?
            .0,
            VaultImageControlResponse::AccountDeleted,
        )
    }
    async fn wipe(&self) -> Result<(), core::RuntimeError> {
        expect_artifact(
            self.invoke(VaultImageControlRequest::Wipe, None).await?.0,
            VaultImageControlResponse::Wiped,
        )
    }
    async fn sweep_orphans(
        &self,
        account_id: &core::AccountId,
        referenced_operations: &std::collections::HashSet<String>,
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
            )
            .await?
            .0,
            VaultImageControlResponse::Swept,
        )
    }
}

struct JsVaultImageSourcePort {
    executor: JsValue,
    take_binary: Function,
}
impl JsVaultImageSourcePort {
    fn new(executor: JsValue, take_binary: Function) -> Result<Self, JsValue> {
        exact_executor(&executor)?;
        Ok(Self {
            executor,
            take_binary,
        })
    }
    async fn invoke(
        &self,
        request: VaultImageSourceControlRequest,
    ) -> Result<
        (VaultImageSourceControlResponse, Option<Zeroizing<Vec<u8>>>),
        core::VaultImageSourceError,
    > {
        let json =
            serde_json::to_string(&request).map_err(|_| core::VaultImageSourceError::Invariant)?;
        let promise = invoke_function(&self.executor)
            .map_err(|_| core::VaultImageSourceError::Invariant)?
            .call1(&self.executor, &JsValue::from_str(&json))
            .map_err(|_| core::VaultImageSourceError::Source)?
            .dyn_into::<Promise>()
            .map_err(|_| core::VaultImageSourceError::Invariant)?;
        let value = JsFuture::from(promise)
            .await
            .map_err(|_| core::VaultImageSourceError::Source)?;
        let response_json = Reflect::get(&value, &JsValue::from_str("controlResponseJson"))
            .map_err(|_| core::VaultImageSourceError::Invariant)?
            .as_string()
            .ok_or(core::VaultImageSourceError::Invariant)?;
        let response = serde_json::from_str(&response_json)
            .map_err(|_| core::VaultImageSourceError::Invariant)?;
        let bytes = take_optional_binary(&value, &self.take_binary)
            .map_err(|_| core::VaultImageSourceError::Invariant)?;
        Ok((response, bytes))
    }
}
struct JsVaultImageSource {
    port: Arc<JsVaultImageSourcePort>,
    capability_id: String,
}
#[async_trait::async_trait(?Send)]
impl core::VaultImageSource for JsVaultImageSource {
    async fn next_chunk(
        &mut self,
        max_bytes: usize,
    ) -> Result<Option<Vec<u8>>, core::VaultImageSourceError> {
        let max_bytes =
            u32::try_from(max_bytes).map_err(|_| core::VaultImageSourceError::Invariant)?;
        let (response, bytes) = self
            .port
            .invoke(VaultImageSourceControlRequest::Read {
                capability_id: self.capability_id.clone(),
                max_bytes,
            })
            .await?;
        match (response, bytes) {
            (VaultImageSourceControlResponse::Chunk, Some(mut bytes)) => {
                Ok(Some(std::mem::take(&mut *bytes)))
            }
            (VaultImageSourceControlResponse::End, None) => Ok(None),
            (VaultImageSourceControlResponse::Cancelled, None) => {
                Err(core::VaultImageSourceError::Cancelled)
            }
            (VaultImageSourceControlResponse::SourceFailure, None) => {
                Err(core::VaultImageSourceError::Source)
            }
            _ => Err(core::VaultImageSourceError::Invariant),
        }
    }
    async fn close(&mut self) -> Result<(), core::VaultImageSourceError> {
        match self
            .port
            .invoke(VaultImageSourceControlRequest::Close {
                capability_id: self.capability_id.clone(),
            })
            .await?
            .0
        {
            VaultImageSourceControlResponse::Closed => Ok(()),
            _ => Err(core::VaultImageSourceError::Invariant),
        }
    }
}
#[async_trait::async_trait(?Send)]
impl core::VaultImageSourcePort for JsVaultImageSourcePort {
    async fn claim(
        &self,
        grant: &core::VaultImageSourceGrant,
    ) -> Result<Box<dyn core::VaultImageSource>, core::VaultImageSourceError> {
        match self
            .invoke(VaultImageSourceControlRequest::Claim {
                capability_id: grant.capability_id.clone(),
                account_id: grant.account_id.as_str().into(),
                operation_id: grant.operation_id.clone(),
                vault_id: grant.vault_id.clone(),
                content_type: grant.content_type.clone(),
                byte_length: grant.byte_length.to_string(),
            })
            .await?
            .0
        {
            VaultImageSourceControlResponse::Claimed => Ok(Box::new(JsVaultImageSource {
                port: Arc::new(Self {
                    executor: self.executor.clone(),
                    take_binary: self.take_binary.clone(),
                }),
                capability_id: grant.capability_id.clone(),
            })),
            _ => Err(core::VaultImageSourceError::Invariant),
        }
    }
    async fn retire_account(
        &self,
        _runtime_incarnation: &str,
        account_id: &core::AccountId,
    ) -> Result<(), core::VaultImageSourceError> {
        expect_source_retired(
            self.invoke(VaultImageSourceControlRequest::RetireAccount {
                account_id: account_id.as_str().into(),
            })
            .await?
            .0,
        )
    }
    async fn complete_account_retirement(
        &self,
        _runtime_incarnation: &str,
        account_id: &core::AccountId,
    ) -> Result<(), core::VaultImageSourceError> {
        expect_source_retired(
            self.invoke(VaultImageSourceControlRequest::CompleteAccountRetirement {
                account_id: account_id.as_str().into(),
            })
            .await?
            .0,
        )
    }
    async fn begin_acceptance(
        &self,
        _runtime_incarnation: &str,
        account_id: &core::AccountId,
        operation_id: &str,
    ) -> Result<(), core::VaultImageSourceError> {
        expect_source(
            self.invoke(VaultImageSourceControlRequest::BeginAcceptance {
                account_id: account_id.as_str().into(),
                operation_id: operation_id.into(),
            })
            .await?
            .0,
            VaultImageSourceControlResponse::AcceptanceBegun,
        )
    }
    async fn end_acceptance(
        &self,
        _runtime_incarnation: &str,
        account_id: &core::AccountId,
        operation_id: &str,
    ) -> Result<(), core::VaultImageSourceError> {
        expect_source(
            self.invoke(VaultImageSourceControlRequest::EndAcceptance {
                account_id: account_id.as_str().into(),
                operation_id: operation_id.into(),
            })
            .await?
            .0,
            VaultImageSourceControlResponse::AcceptanceEnded,
        )
    }
    async fn retire_runtime(
        &self,
        _runtime_incarnation: &str,
    ) -> Result<(), core::VaultImageSourceError> {
        expect_source_retired(
            self.invoke(VaultImageSourceControlRequest::RetireRuntime)
                .await?
                .0,
        )
    }
}

impl From<&core::VaultImageArtifactScope> for VaultImageScopeControl {
    fn from(scope: &core::VaultImageArtifactScope) -> Self {
        Self {
            account_id: scope.account_id().as_str().into(),
            operation_id: scope.operation_id().into(),
        }
    }
}
impl From<&core::VaultImageArtifactMetadata> for VaultImageMetadataControl {
    fn from(metadata: &core::VaultImageArtifactMetadata) -> Self {
        Self {
            scope: metadata.scope().into(),
            vault_id: metadata.vault_id().into(),
            byte_length: metadata.byte_length().to_string(),
            content_type: metadata.content_type().into(),
            sha256: metadata.sha256().into(),
        }
    }
}
fn exact_executor(value: &JsValue) -> Result<(), JsValue> {
    let object = value.clone().dyn_into::<js_sys::Object>()?;
    let keys = js_sys::Object::keys(&object);
    if keys.length() != 1 || keys.get(0).as_string().as_deref() != Some("invoke") {
        return Err(JsValue::from_str("Vault image executor surface is invalid"));
    }
    invoke_function(value).map(|_| ())
}
fn invoke_function(value: &JsValue) -> Result<Function, JsValue> {
    Reflect::get(value, &JsValue::from_str("invoke"))?.dyn_into::<Function>()
}
fn take_optional_binary(
    value: &JsValue,
    take_binary: &Function,
) -> Result<Option<Zeroizing<Vec<u8>>>, JsValue> {
    let binary = Reflect::get(value, &JsValue::from_str("binaryChunk"))?;
    if binary.is_undefined() {
        return Ok(None);
    }
    let backing = take_binary
        .call1(&JsValue::UNDEFINED, &binary)?
        .dyn_into::<ArrayBuffer>()?;
    let view = Uint8Array::new(&backing);
    let owned = Zeroizing::new(view.to_vec());
    view.fill(0, 0, view.length());
    Ok(Some(owned))
}
fn expect_artifact(
    actual: VaultImageControlResponse,
    expected: VaultImageControlResponse,
) -> Result<(), core::RuntimeError> {
    if actual == expected {
        Ok(())
    } else {
        Err(invariant())
    }
}
fn expect_source_retired(
    response: VaultImageSourceControlResponse,
) -> Result<(), core::VaultImageSourceError> {
    match response {
        VaultImageSourceControlResponse::Retired => Ok(()),
        VaultImageSourceControlResponse::SourceFailure => Err(core::VaultImageSourceError::Source),
        _ => Err(core::VaultImageSourceError::Invariant),
    }
}
fn expect_source(
    actual: VaultImageSourceControlResponse,
    expected: VaultImageSourceControlResponse,
) -> Result<(), core::VaultImageSourceError> {
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
        message: "Vault image host invocation failed".into(),
    }
}
