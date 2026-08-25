use crate::web_attachment_artifact_control::{
    ArtifactChunkWriteControl, ArtifactControlRequest, ArtifactControlResponse,
    ArtifactDeletionControl, ArtifactOwnerControl, ArtifactPublicationControl,
    ArtifactPublicationStateControl, ProvisionalArtifactScopeControl,
    ProvisionalArtifactTokenControl, ProvisionalPublicationStateControl,
};
use crate::web_attachment_artifact_policy::{
    copy_validated_chunk, validate_chunk_digest, validate_chunk_index, validate_complete_artifact,
};
use bittery_client_core::{
    AccountId, AttachmentArtifactOwner, ProvisionalAttachmentArtifactRecovery,
    ProvisionalAttachmentArtifactScope, ProvisionalAttachmentArtifactWriter, ARTIFACT_CHUNK_BYTES,
};
use js_sys::{Array, Function, Promise, Reflect, Uint8Array};
use sha2::{Digest, Sha256};
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;

fn construct_core_artifact_port(
    executor: JsValue,
) -> Result<std::sync::Arc<dyn bittery_client_core::AttachmentArtifactStore>, JsValue> {
    Ok(std::sync::Arc::new(JsAttachmentArtifactStore::new(
        executor,
    )?))
}
const _: fn(
    JsValue,
) -> Result<std::sync::Arc<dyn bittery_client_core::AttachmentArtifactStore>, JsValue> =
    construct_core_artifact_port;

fn construct_core_provisional_artifact_port(
    executor: JsValue,
) -> Result<std::sync::Arc<dyn bittery_client_core::ProvisionalAttachmentArtifactStore>, JsValue> {
    Ok(std::sync::Arc::new(JsAttachmentArtifactStore::new(
        executor,
    )?))
}
const _: fn(
    JsValue,
) -> Result<
    std::sync::Arc<dyn bittery_client_core::ProvisionalAttachmentArtifactStore>,
    JsValue,
> = construct_core_provisional_artifact_port;

pub(crate) struct JsAttachmentArtifactStore {
    executor: JsValue,
}

impl JsAttachmentArtifactStore {
    pub(crate) fn new(executor: JsValue) -> Result<Self, JsValue> {
        function(&executor, "invoke")?;
        Ok(Self { executor })
    }

    async fn write_chunk(
        &self,
        owner: &AttachmentArtifactOwner,
        chunk_index: u32,
        bytes: &[u8],
    ) -> Result<ArtifactChunkWriteControl, JsValue> {
        let shape = shape(owner)?;
        if bytes.len() != shape.chunk_length(chunk_index)? {
            return Err(error("Attachment artifact chunk length is invalid"));
        }
        let digest = hex(bytes);
        let response = control(
            &self.executor,
            ArtifactControlRequest::WriteChunk {
                owner: owner_control(owner, shape.chunk_count),
                chunk_index,
                chunk_sha256: digest,
            },
            Some(bytes),
        )
        .await?;
        match response.response {
            ArtifactControlResponse::ChunkWritten { result } => Ok(result),
            _ => Err(error(
                "IndexedDB artifact chunk write returned an invalid result",
            )),
        }
    }

    async fn begin_provisional(
        &self,
        writer: &ProvisionalAttachmentArtifactWriter,
    ) -> Result<ArtifactControlResponse, JsValue> {
        Ok(control(
            &self.executor,
            ArtifactControlRequest::BeginProvisional {
                writer: writer_control(writer),
            },
            None,
        )
        .await?
        .response)
    }

    async fn write_provisional_chunk(
        &self,
        writer: &ProvisionalAttachmentArtifactWriter,
        chunk_index: u32,
        bytes: &[u8],
    ) -> Result<ArtifactChunkWriteControl, JsValue> {
        if bytes.is_empty() || bytes.len() > ARTIFACT_CHUNK_BYTES {
            return Err(error(
                "Provisional Attachment artifact chunk length is invalid",
            ));
        }
        let response = control(
            &self.executor,
            ArtifactControlRequest::WriteProvisionalChunk {
                writer: writer_control(writer),
                chunk_index,
                chunk_sha256: hex(bytes),
            },
            Some(bytes),
        )
        .await?;
        match response.response {
            ArtifactControlResponse::ChunkWritten { result } => Ok(result),
            _ => Err(error(
                "IndexedDB provisional chunk write returned an invalid result",
            )),
        }
    }

    async fn verify_and_finish_provisional(
        &self,
        token: ProvisionalArtifactTokenControl,
        owner: AttachmentArtifactOwner,
        state: ProvisionalPublicationStateControl,
    ) -> Result<AttachmentArtifactOwner, JsValue> {
        ensure_token_owner(&token, &owner)?;
        let shape = shape(&owner)?;
        if state == ProvisionalPublicationStateControl::Published {
            return Ok(owner);
        }
        let owner_control = owner_control(&owner, shape.chunk_count);
        let mut hasher = Sha256::new();
        let mut total = 0_u64;
        for chunk_index in 0..shape.chunk_count {
            let response = control(
                &self.executor,
                ArtifactControlRequest::ReadSealedProvisionalChunk {
                    token: token.clone(),
                    owner: owner_control.clone(),
                    chunk_index,
                },
                None,
            )
            .await?;
            let bytes = control_chunk(response, shape.chunk_length(chunk_index)?)?;
            total = total
                .checked_add(bytes.len() as u64)
                .ok_or_else(|| error("Attachment artifact byte length overflowed"))?;
            hasher.update(bytes);
        }
        validate_complete_artifact(
            total,
            owner.byte_length(),
            &format!("{:x}", hasher.finalize()),
            owner.ciphertext_sha256(),
        )
        .map_err(error)?;
        let response = control(
            &self.executor,
            ArtifactControlRequest::FinishProvisional {
                token,
                owner: owner_control,
            },
            None,
        )
        .await?;
        match response.response {
            ArtifactControlResponse::ProvisionalFinished => Ok(owner),
            _ => Err(error(
                "IndexedDB provisional publication returned an invalid result",
            )),
        }
    }

    async fn resume_provisional(
        &self,
        request: ArtifactControlRequest,
        expected_token: ProvisionalArtifactTokenControl,
    ) -> Result<AttachmentArtifactOwner, JsValue> {
        let response = control(&self.executor, request, None).await?;
        let ArtifactControlResponse::ProvisionalBinding { owner, state } = response.response else {
            return Err(error(
                "IndexedDB provisional recovery returned an invalid result",
            ));
        };
        let owner = owner_from_control(&owner)?;
        if expected_token != token_for_owner(&expected_token.generation, &owner) {
            return Err(error(
                "IndexedDB provisional recovery returned the wrong scope",
            ));
        }
        self.verify_and_finish_provisional(expected_token, owner, state)
            .await
    }

    async fn publish(
        &self,
        owner: &AttachmentArtifactOwner,
    ) -> Result<ArtifactPublicationControl, JsValue> {
        let shape = shape(owner)?;
        let owner_control = owner_control(owner, shape.chunk_count);
        let start = control(
            &self.executor,
            ArtifactControlRequest::BeginPublish {
                owner: owner_control.clone(),
            },
            None,
        )
        .await?;
        match start.response {
            ArtifactControlResponse::PublicationStarted {
                state: ArtifactPublicationStateControl::Published,
            } => return Ok(ArtifactPublicationControl::AlreadyPublished),
            ArtifactControlResponse::PublicationStarted {
                state: ArtifactPublicationStateControl::Verifying,
            } => {}
            _ => {
                return Err(error(
                    "IndexedDB artifact publication returned an invalid state",
                ))
            }
        }

        // The durable `verifying` state freezes chunks. Hash outside transactions, one bounded
        // read per await, so MV3 termination resumes without an exposed incomplete artifact.
        let mut hasher = Sha256::new();
        let mut total = 0_u64;
        for index in 0..shape.chunk_count {
            let response = control(
                &self.executor,
                ArtifactControlRequest::ReadVerifyingChunk {
                    owner: owner_control.clone(),
                    chunk_index: index,
                },
                None,
            )
            .await?;
            let bytes = control_chunk(response, shape.chunk_length(index)?)?;
            total = total
                .checked_add(bytes.len() as u64)
                .ok_or_else(|| error("Attachment artifact byte length overflowed"))?;
            hasher.update(&bytes);
        }
        validate_complete_artifact(
            total,
            owner.byte_length(),
            &format!("{:x}", hasher.finalize()),
            owner.ciphertext_sha256(),
        )
        .map_err(error)?;
        let finish = control(
            &self.executor,
            ArtifactControlRequest::FinishPublish {
                owner: owner_control,
            },
            None,
        )
        .await?;
        match finish.response {
            ArtifactControlResponse::PublicationFinished { result } => Ok(result),
            _ => Err(error(
                "IndexedDB artifact publication returned an invalid result",
            )),
        }
    }

    async fn read_chunk(
        &self,
        owner: &AttachmentArtifactOwner,
        chunk_index: u32,
    ) -> Result<Vec<u8>, JsValue> {
        let shape = shape(owner)?;
        let response = control(
            &self.executor,
            ArtifactControlRequest::ReadPublishedChunk {
                owner: owner_control(owner, shape.chunk_count),
                chunk_index,
            },
            None,
        )
        .await?;
        control_chunk(response, shape.chunk_length(chunk_index)?)
    }

    async fn delete_account(&self, account_id: &AccountId) -> Result<(), JsValue> {
        let response = control(
            &self.executor,
            ArtifactControlRequest::DeleteAccount {
                account_id: account_id.as_str().to_owned(),
            },
            None,
        )
        .await?;
        match response.response {
            ArtifactControlResponse::AccountDeleted => Ok(()),
            _ => Err(error(
                "IndexedDB artifact Account deletion returned an invalid result",
            )),
        }
    }
    /// The Runtime calls this only while holding its exclusive startup boundary. Each deletion is
    /// its own durable transaction, so an interrupted sweep safely resumes at the next startup.
    async fn sweep_orphans_at_exclusive_startup(
        &self,
        account_id: &AccountId,
        live_owners: &[AttachmentArtifactOwner],
    ) -> Result<u32, JsValue> {
        let mut live = std::collections::HashSet::new();
        for owner in live_owners {
            shape(owner)?;
            if owner.account_id() != account_id {
                return Err(error(
                    "Attachment artifact sweep reference has the wrong Account scope",
                ));
            }
            live.insert(owner.artifact_id().to_owned());
        }
        let listed = control(
            &self.executor,
            ArtifactControlRequest::ListArtifactIds {
                account_id: account_id.as_str().to_owned(),
            },
            None,
        )
        .await?;
        let ArtifactControlResponse::ArtifactIds {
            artifact_ids: listed,
            provisional,
        } = listed.response
        else {
            return Err(error(
                "IndexedDB artifact listing returned an invalid result",
            ));
        };
        let mut deleted = 0_u32;
        for artifact_id in listed {
            if live.contains(&artifact_id) {
                continue;
            }
            loop {
                let result = control(
                    &self.executor,
                    ArtifactControlRequest::DeleteArtifact {
                        account_id: account_id.as_str().to_owned(),
                        artifact_id: artifact_id.clone(),
                    },
                    None,
                )
                .await?;
                match result.response {
                    ArtifactControlResponse::ArtifactDeleted {
                        result: ArtifactDeletionControl::Progress,
                    } => continue,
                    ArtifactControlResponse::ArtifactDeleted {
                        result: ArtifactDeletionControl::Deleted,
                    } => break,
                    _ => return Err(error("Attachment artifact sweep lost an orphaned record")),
                }
            }
            deleted = deleted
                .checked_add(1)
                .ok_or_else(|| error("Attachment artifact sweep count overflowed"))?;
        }
        for token in provisional {
            loop {
                let result = control(
                    &self.executor,
                    ArtifactControlRequest::DeleteProvisionalGeneration {
                        token: token.clone(),
                    },
                    None,
                )
                .await?;
                match result.response {
                    ArtifactControlResponse::ArtifactDeleted {
                        result: ArtifactDeletionControl::Progress,
                    } => continue,
                    ArtifactControlResponse::ArtifactDeleted {
                        result: ArtifactDeletionControl::Deleted,
                    } => break,
                    _ => {
                        return Err(error(
                            "Attachment artifact sweep lost a provisional generation",
                        ))
                    }
                }
            }
            deleted = deleted
                .checked_add(1)
                .ok_or_else(|| error("Attachment artifact sweep count overflowed"))?;
        }
        Ok(deleted)
    }
}

#[async_trait::async_trait(?Send)]
impl bittery_client_core::AttachmentArtifactStore for JsAttachmentArtifactStore {
    async fn invoke(
        &self,
        request: bittery_client_core::AttachmentArtifactStoreRequest,
    ) -> Result<
        bittery_client_core::AttachmentArtifactStoreResponse,
        bittery_client_core::RuntimeError,
    > {
        use bittery_client_core::{
            ArtifactChunkWrite, ArtifactPublication, AttachmentArtifactStoreRequest as Request,
            AttachmentArtifactStoreResponse as Response, PublishedArtifactChunk,
        };
        match request {
            Request::WriteChunk {
                owner,
                chunk_index,
                bytes,
            } => {
                let result = self
                    .write_chunk(&owner, chunk_index, &bytes)
                    .await
                    .map_err(js_error)?;
                Ok(Response::ChunkWritten(match result {
                    ArtifactChunkWriteControl::Stored => ArtifactChunkWrite::Stored,
                    ArtifactChunkWriteControl::AlreadyStored => ArtifactChunkWrite::AlreadyStored,
                }))
            }
            Request::Publish { owner } => {
                let result = self.publish(&owner).await.map_err(js_error)?;
                Ok(Response::Published(match result {
                    ArtifactPublicationControl::Published => ArtifactPublication::Published,
                    ArtifactPublicationControl::AlreadyPublished => {
                        ArtifactPublication::AlreadyPublished
                    }
                }))
            }
            Request::ReadChunk { owner, chunk_index } => {
                let owner_shape = shape(&owner).map_err(js_error)?;
                let is_last = validate_chunk_index(chunk_index, owner_shape.chunk_count)
                    .map_err(runtime_error)?;
                let bytes = self
                    .read_chunk(&owner, chunk_index)
                    .await
                    .map_err(js_error)?;
                Ok(Response::ChunkRead(PublishedArtifactChunk {
                    bytes,
                    is_last,
                }))
            }
            Request::DeleteAccount { account_id } => {
                self.delete_account(&account_id).await.map_err(js_error)?;
                Ok(Response::AccountDeleted)
            }
            Request::SweepOrphans {
                boundary: _,
                account_id,
                live,
            } => {
                let deleted = self
                    .sweep_orphans_at_exclusive_startup(&account_id, &live)
                    .await
                    .map_err(js_error)?;
                Ok(Response::OrphansSwept {
                    deleted: deleted as usize,
                })
            }
        }
    }
}

#[async_trait::async_trait(?Send)]
impl bittery_client_core::ProvisionalAttachmentArtifactStore for JsAttachmentArtifactStore {
    async fn invoke_provisional(
        &self,
        request: bittery_client_core::ProvisionalAttachmentArtifactStoreRequest,
    ) -> Result<
        bittery_client_core::ProvisionalAttachmentArtifactStoreResponse,
        bittery_client_core::RuntimeError,
    > {
        use bittery_client_core::{
            ArtifactChunkWrite, ProvisionalAttachmentArtifactStoreRequest as Request,
            ProvisionalAttachmentArtifactStoreResponse as Response,
        };
        match request {
            Request::Begin { writer } => {
                match self.begin_provisional(&writer).await.map_err(js_error)? {
                    ArtifactControlResponse::ProvisionalBegun => Ok(Response::Begun(writer)),
                    ArtifactControlResponse::ProvisionalRecoveryAvailable { recovery } => {
                        let recovery = recovery_from_control(recovery).map_err(js_error)?;
                        ensure_same_writer_scope(&writer, &recovery).map_err(js_error)?;
                        Ok(Response::RecoveryAvailable(recovery))
                    }
                    _ => Err(runtime_error(
                        "IndexedDB provisional Begin returned an invalid result",
                    )),
                }
            }
            Request::WriteChunk {
                writer,
                chunk_index,
                bytes,
            } => {
                let result = self
                    .write_provisional_chunk(&writer, chunk_index, &bytes)
                    .await
                    .map_err(js_error)?;
                Ok(Response::ChunkWritten(match result {
                    ArtifactChunkWriteControl::Stored => ArtifactChunkWrite::Stored,
                    ArtifactChunkWriteControl::AlreadyStored => ArtifactChunkWrite::AlreadyStored,
                }))
            }
            Request::Finalize {
                writer,
                publication_proof,
            } => {
                let owner =
                    AttachmentArtifactOwner::from_publication_proof(&writer, publication_proof)?;
                let shape = shape(&owner).map_err(js_error)?;
                let token = writer_control(&writer);
                let response = control(
                    &self.executor,
                    ArtifactControlRequest::SealProvisional {
                        writer: token.clone(),
                        owner: owner_control(&owner, shape.chunk_count),
                    },
                    None,
                )
                .await
                .map_err(js_error)?;
                let ArtifactControlResponse::ProvisionalBinding {
                    owner: returned_owner,
                    state,
                } = response.response
                else {
                    return Err(runtime_error(
                        "IndexedDB provisional seal returned an invalid result",
                    ));
                };
                let returned_owner = owner_from_control(&returned_owner).map_err(js_error)?;
                if returned_owner.artifact_id() != owner.artifact_id()
                    || returned_owner.ciphertext_sha256() != owner.ciphertext_sha256()
                    || returned_owner.byte_length() != owner.byte_length()
                {
                    return Err(runtime_error(
                        "IndexedDB provisional seal changed publication authority",
                    ));
                }
                Ok(Response::Finalized(
                    self.verify_and_finish_provisional(token, owner, state)
                        .await
                        .map_err(js_error)?,
                ))
            }
            Request::Recover { scope } => {
                let response = control(
                    &self.executor,
                    ArtifactControlRequest::RecoverProvisional {
                        scope: scope_control(&scope),
                    },
                    None,
                )
                .await
                .map_err(js_error)?;
                let ArtifactControlResponse::ProvisionalRecoveryAvailable { recovery } =
                    response.response
                else {
                    return Err(runtime_error(
                        "IndexedDB provisional Recover returned an invalid result",
                    ));
                };
                let recovery = recovery_from_control(recovery).map_err(js_error)?;
                if recovery.account_id() != scope.account_id()
                    || recovery.operation_id() != scope.operation_id()
                    || recovery.attachment_id() != scope.attachment_id()
                {
                    return Err(runtime_error(
                        "IndexedDB provisional Recover returned the wrong scope",
                    ));
                }
                Ok(Response::RecoveryAvailable(recovery))
            }
            Request::ResumeRecovered { recovery } => {
                let token = recovery_control(&recovery);
                let owner = self
                    .resume_provisional(
                        ArtifactControlRequest::ResumeRecoveredProvisional {
                            recovery: token.clone(),
                        },
                        token,
                    )
                    .await
                    .map_err(js_error)?;
                Ok(Response::Finalized(owner))
            }
            Request::ResumeFinalization { writer } => {
                let token = writer_control(&writer);
                let owner = self
                    .resume_provisional(
                        ArtifactControlRequest::ResumeProvisionalFinalization {
                            writer: token.clone(),
                        },
                        token,
                    )
                    .await
                    .map_err(js_error)?;
                Ok(Response::Finalized(owner))
            }
        }
    }
}

struct Shape {
    byte_length: u64,
    chunk_count: u32,
}

impl Shape {
    fn chunk_length(&self, index: u32) -> Result<usize, JsValue> {
        let is_last = validate_chunk_index(index, self.chunk_count).map_err(error)?;
        if !is_last {
            return Ok(ARTIFACT_CHUNK_BYTES);
        }
        let preceding = u64::from(index) * ARTIFACT_CHUNK_BYTES as u64;
        usize::try_from(self.byte_length - preceding)
            .map_err(|_| error("Attachment artifact final chunk length is invalid"))
    }
}

fn shape(owner: &AttachmentArtifactOwner) -> Result<Shape, JsValue> {
    let chunk_bytes = ARTIFACT_CHUNK_BYTES as u64;
    let count = owner
        .byte_length()
        .checked_add(chunk_bytes - 1)
        .ok_or_else(|| error("Attachment artifact chunk count overflowed"))?
        / chunk_bytes;
    Ok(Shape {
        byte_length: owner.byte_length(),
        chunk_count: u32::try_from(count)
            .map_err(|_| error("Attachment artifact has too many chunks"))?,
    })
}

fn owner_control(owner: &AttachmentArtifactOwner, chunk_count: u32) -> ArtifactOwnerControl {
    ArtifactOwnerControl {
        account_id: owner.account_id().as_str().to_owned(),
        artifact_id: owner.artifact_id().to_owned(),
        operation_id: owner.operation_id().to_owned(),
        attachment_id: owner.attachment_id().to_owned(),
        ciphertext_sha256: owner.ciphertext_sha256().to_owned(),
        byte_length: owner.byte_length().to_string(),
        chunk_count,
    }
}

fn scope_control(scope: &ProvisionalAttachmentArtifactScope) -> ProvisionalArtifactScopeControl {
    ProvisionalArtifactScopeControl {
        account_id: scope.account_id().as_str().to_owned(),
        operation_id: scope.operation_id().to_owned(),
        attachment_id: scope.attachment_id().to_owned(),
    }
}

fn writer_control(writer: &ProvisionalAttachmentArtifactWriter) -> ProvisionalArtifactTokenControl {
    ProvisionalArtifactTokenControl {
        scope: ProvisionalArtifactScopeControl {
            account_id: writer.account_id().as_str().to_owned(),
            operation_id: writer.operation_id().to_owned(),
            attachment_id: writer.attachment_id().to_owned(),
        },
        generation: writer.generation().to_owned(),
    }
}

fn recovery_control(
    recovery: &ProvisionalAttachmentArtifactRecovery,
) -> ProvisionalArtifactTokenControl {
    ProvisionalArtifactTokenControl {
        scope: ProvisionalArtifactScopeControl {
            account_id: recovery.account_id().as_str().to_owned(),
            operation_id: recovery.operation_id().to_owned(),
            attachment_id: recovery.attachment_id().to_owned(),
        },
        generation: recovery.generation().to_owned(),
    }
}

fn recovery_from_control(
    recovery: ProvisionalArtifactTokenControl,
) -> Result<ProvisionalAttachmentArtifactRecovery, JsValue> {
    let scope = ProvisionalAttachmentArtifactScope::new(
        AccountId::from(recovery.scope.account_id),
        recovery.scope.operation_id,
        recovery.scope.attachment_id,
    )
    .map_err(|_| error("IndexedDB provisional recovery scope is invalid"))?;
    ProvisionalAttachmentArtifactRecovery::new(scope, recovery.generation)
        .map_err(|_| error("IndexedDB provisional recovery token is invalid"))
}

fn ensure_same_writer_scope(
    writer: &ProvisionalAttachmentArtifactWriter,
    recovery: &ProvisionalAttachmentArtifactRecovery,
) -> Result<(), JsValue> {
    if writer.account_id() != recovery.account_id()
        || writer.operation_id() != recovery.operation_id()
        || writer.attachment_id() != recovery.attachment_id()
    {
        return Err(error(
            "IndexedDB provisional recovery returned the wrong scope",
        ));
    }
    Ok(())
}

fn token_for_owner(
    generation: &str,
    owner: &AttachmentArtifactOwner,
) -> ProvisionalArtifactTokenControl {
    ProvisionalArtifactTokenControl {
        scope: ProvisionalArtifactScopeControl {
            account_id: owner.account_id().as_str().to_owned(),
            operation_id: owner.operation_id().to_owned(),
            attachment_id: owner.attachment_id().to_owned(),
        },
        generation: generation.to_owned(),
    }
}

fn ensure_token_owner(
    token: &ProvisionalArtifactTokenControl,
    owner: &AttachmentArtifactOwner,
) -> Result<(), JsValue> {
    if token != &token_for_owner(&token.generation, owner) {
        return Err(error(
            "IndexedDB provisional publication has the wrong scope",
        ));
    }
    Ok(())
}

fn owner_from_control(owner: &ArtifactOwnerControl) -> Result<AttachmentArtifactOwner, JsValue> {
    let byte_length = owner
        .byte_length
        .parse::<u64>()
        .map_err(|_| error("IndexedDB provisional byte length is invalid"))?;
    let result = AttachmentArtifactOwner::from_reference_parts(
        AccountId::from(owner.account_id.clone()),
        owner.operation_id.clone(),
        owner.attachment_id.clone(),
        owner.artifact_id.clone(),
        owner.ciphertext_sha256.clone(),
        byte_length,
    )
    .map_err(|_| error("IndexedDB provisional owner is invalid"))?;
    let expected = shape(&result)?;
    if expected.chunk_count != owner.chunk_count {
        return Err(error("IndexedDB provisional owner chunk count is invalid"));
    }
    Ok(result)
}

struct ControlResult {
    response: ArtifactControlResponse,
    bytes: JsValue,
}

fn control_chunk(result: ControlResult, expected_length: usize) -> Result<Vec<u8>, JsValue> {
    let ArtifactControlResponse::ChunkRead { chunk_sha256 } = result.response else {
        return Err(error(
            "IndexedDB artifact chunk read returned an invalid result",
        ));
    };
    let bytes = Uint8Array::new(&result.bytes);
    // IndexedDB necessarily cloned the value before this boundary. Check the cheap view length
    // before `to_vec`; trusted Rust writes cap every durable value beforehand.
    let bytes = copy_validated_chunk(bytes.length() as usize, expected_length, || bytes.to_vec())
        .map_err(error)?;
    validate_chunk_digest(&bytes, &chunk_sha256).map_err(error)?;
    Ok(bytes)
}

async fn control(
    executor: &JsValue,
    request: ArtifactControlRequest,
    bytes: Option<&[u8]>,
) -> Result<ControlResult, JsValue> {
    let request_json = serde_json::to_string(&request)
        .map_err(|_| error("Attachment artifact control request did not serialize"))?;
    let binary = bytes
        .map(|value| Uint8Array::from(value).into())
        .unwrap_or(JsValue::UNDEFINED);
    let value = invoke(
        executor,
        "invoke",
        &[JsValue::from_str(&request_json), binary],
    )
    .await?;
    let response_json = Reflect::get(&value, &JsValue::from_str("controlResponseJson"))?
        .as_string()
        .ok_or_else(|| error("Attachment artifact control response is invalid"))?;
    let response = serde_json::from_str(&response_json)
        .map_err(|_| error("Attachment artifact control response is invalid"))?;
    let bytes = Reflect::get(&value, &JsValue::from_str("bytes"))?;
    Ok(ControlResult { response, bytes })
}

async fn invoke(
    executor: &JsValue,
    method: &str,
    arguments: &[JsValue],
) -> Result<JsValue, JsValue> {
    let args = Array::new();
    for argument in arguments {
        args.push(argument);
    }
    let promise = function(executor, method)?
        .apply(executor, &args)
        .map_err(|_| error("IndexedDB artifact invocation failed"))?
        .dyn_into::<Promise>()
        .map_err(|_| error("IndexedDB artifact invocation did not return a Promise"))?;
    JsFuture::from(promise)
        .await
        .map_err(|_| error("IndexedDB artifact invocation failed"))
}

fn function(executor: &JsValue, method: &str) -> Result<Function, JsValue> {
    Reflect::get(executor, &JsValue::from_str(method))?
        .dyn_into::<Function>()
        .map_err(|_| error("IndexedDB artifact executor is incomplete"))
}

fn hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn error(message: &str) -> JsValue {
    JsValue::from_str(message)
}

fn js_error(value: JsValue) -> bittery_client_core::RuntimeError {
    runtime_error(
        &value
            .as_string()
            .unwrap_or_else(|| "Web Attachment artifact invocation failed".into()),
    )
}

fn runtime_error(message: &str) -> bittery_client_core::RuntimeError {
    bittery_client_core::RuntimeError {
        code: bittery_client_core::RuntimeErrorCode::InvariantViolation,
        message: message.into(),
    }
}
