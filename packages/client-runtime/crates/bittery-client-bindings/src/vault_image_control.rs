use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "vault-image-control-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct VaultImageScopeControl {
    pub(crate) account_id: String,
    pub(crate) operation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) publication_id: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "vault-image-control-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct VaultImageMetadataControl {
    #[serde(flatten)]
    pub(crate) scope: VaultImageScopeControl,
    pub(crate) vault_id: String,
    pub(crate) byte_length: String,
    pub(crate) content_type: String,
    pub(crate) sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) protection: Option<bittery_client_core::ProtectedImageMetadata>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "vault-image-control-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct VaultImageGenerationControl {
    pub(crate) scope: VaultImageScopeControl,
    pub(crate) metadata: Option<VaultImageMetadataControl>,
}
impl VaultImageGenerationControl {
    pub(crate) fn into_core(
        self,
        family: &bittery_client_core::VaultImageArtifactScope,
        after: Option<&str>,
    ) -> Result<bittery_client_core::VaultImageArtifactGeneration, bittery_client_core::RuntimeError>
    {
        use bittery_client_core as core;
        let invalid = || core::RuntimeError {
            code: core::RuntimeErrorCode::InvariantViolation,
            message: "Vault image generation is invalid".into(),
            recovery_bound: None,
            team_page_problem: None,
        };
        let scope = self.scope.into_core()?;
        if scope.account_id() != family.account_id()
            || scope.operation_id() != family.operation_id()
            || after.is_some_and(|after| scope.publication_id().unwrap_or("") <= after)
        {
            return Err(invalid());
        }
        let metadata = self
            .metadata
            .map(|value| {
                let declared_scope = value.scope.into_core()?;
                let length = value.byte_length.parse::<u64>().map_err(|_| invalid())?;
                if length.to_string() != value.byte_length {
                    return Err(invalid());
                }
                let raw = core::VaultImageArtifactMetadata::new(
                    core::VaultImageArtifactScope::new(
                        declared_scope.account_id().clone(),
                        declared_scope.operation_id(),
                    )?,
                    value.vault_id,
                    length,
                    value.content_type,
                    value.sha256,
                )?;
                let metadata = match value.protection {
                    Some(protection) => raw.with_protection(protection)?,
                    None => raw,
                };
                if metadata.scope() != &declared_scope || metadata.scope() != &scope {
                    return Err(invalid());
                }
                Ok(metadata)
            })
            .transpose()?;
        Ok(core::VaultImageArtifactGeneration { scope, metadata })
    }
}
impl VaultImageScopeControl {
    fn into_core(
        self,
    ) -> Result<bittery_client_core::VaultImageArtifactScope, bittery_client_core::RuntimeError>
    {
        let raw = bittery_client_core::VaultImageArtifactScope::new(
            self.account_id.into(),
            self.operation_id,
        )?;
        self.publication_id
            .map(|publication| raw.for_publication(&publication))
            .unwrap_or(Ok(raw))
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "vault-image-control-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum VaultImageControlRequest {
    Begin {
        scope: VaultImageScopeControl,
    },
    WriteChunk {
        scope: VaultImageScopeControl,
        #[cfg_attr(
            feature = "vault-image-control-contract-schema",
            schemars(range(min = 0, max = 4_294_967_295_u32))
        )]
        chunk_index: u32,
    },
    Publish {
        metadata: VaultImageMetadataControl,
    },
    ReadChunk {
        metadata: VaultImageMetadataControl,
        #[cfg_attr(
            feature = "vault-image-control-contract-schema",
            schemars(range(min = 0, max = 4_294_967_295_u32))
        )]
        chunk_index: u32,
    },
    ReadGeneration {
        scope: VaultImageScopeControl,
        after_publication_id: Option<String>,
    },
    DeleteGeneration {
        scope: VaultImageScopeControl,
    },
    Delete {
        scope: VaultImageScopeControl,
    },
    DeleteAccount {
        account_id: String,
    },
    Wipe,
    StartupSweep {
        account_id: String,
        referenced_operation_ids: Vec<String>,
    },
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "vault-image-control-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub(crate) enum VaultImageChunkWriteControl {
    Stored,
    AlreadyStored,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "vault-image-control-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub(crate) enum VaultImagePublicationControl {
    Published,
    AlreadyPublished,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "vault-image-control-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum VaultImageControlResponse {
    Begun,
    ChunkWritten {
        result: VaultImageChunkWriteControl,
    },
    Published {
        result: VaultImagePublicationControl,
    },
    Chunk,
    Generation {
        generation: Box<VaultImageGenerationControl>,
    },
    Missing,
    Deleted,
    AccountDeleted,
    Wiped,
    Swept,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "vault-image-control-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum VaultImageSourceControlRequest {
    Claim {
        capability_id: String,
        account_id: String,
        operation_id: String,
        vault_id: String,
        content_type: String,
        byte_length: String,
    },
    Read {
        capability_id: String,
        #[cfg_attr(
            feature = "vault-image-control-contract-schema",
            schemars(range(min = 1, max = 262_144_u32))
        )]
        max_bytes: u32,
    },
    Close {
        capability_id: String,
    },
    RetireAccount {
        account_id: String,
    },
    CompleteAccountRetirement {
        account_id: String,
    },
    RetireVaults {
        account_id: String,
        vault_ids: Vec<String>,
    },
    CompleteVaultRetirement {
        account_id: String,
        vault_ids: Vec<String>,
    },
    ForgetAccountVaultRetirements {
        account_id: String,
    },
    BeginAcceptance {
        account_id: String,
        operation_id: String,
    },
    EndAcceptance {
        account_id: String,
        operation_id: String,
    },
    RetireRuntime,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "vault-image-control-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum VaultImageSourceControlResponse {
    Claimed,
    Chunk,
    End,
    Closed,
    Retired,
    AcceptanceBegun,
    AcceptanceEnded,
    SourceFailure,
    Cancelled,
    InvariantViolation,
}
#[cfg(feature = "vault-image-control-contract-schema")]
#[derive(schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct VaultImageControlContract {
    request: VaultImageControlRequest,
    response: VaultImageControlResponse,
    source_request: VaultImageSourceControlRequest,
    source_response: VaultImageSourceControlResponse,
}
#[cfg(feature = "vault-image-control-contract-schema")]
pub fn vault_image_control_contract_schema() -> schemars::Schema {
    schemars::schema_for!(VaultImageControlContract)
}
#[cfg(feature = "vault-image-control-contract-schema")]
pub fn vault_image_control_contract_fixture() -> serde_json::Value {
    let scope = VaultImageScopeControl {
        account_id: "account-1".into(),
        operation_id: "operation-1".into(),
        publication_id: None,
    };
    let metadata = VaultImageMetadataControl {
        scope: scope.clone(),
        vault_id: "vault-1".into(),
        byte_length: "3".into(),
        content_type: "image/png".into(),
        protection: None,
        sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad".into(),
    };
    serde_json::json!({"steps":[{"request":VaultImageControlRequest::Begin{scope:scope.clone()},"response":VaultImageControlResponse::Begun},{"request":VaultImageControlRequest::WriteChunk{scope:scope.clone(),chunk_index:0},"response":VaultImageControlResponse::ChunkWritten{result:VaultImageChunkWriteControl::Stored}},{"request":VaultImageControlRequest::Publish{metadata:metadata.clone()},"response":VaultImageControlResponse::Published{result:VaultImagePublicationControl::Published}},{"request":VaultImageControlRequest::ReadChunk{metadata,chunk_index:0},"response":VaultImageControlResponse::Chunk}],"sourceSteps":[{"request":VaultImageSourceControlRequest::Claim{capability_id:"capability-1".into(),account_id:"account-1".into(),operation_id:"operation-1".into(),vault_id:"vault-1".into(),content_type:"image/png".into(),byte_length:"3".into()},"response":VaultImageSourceControlResponse::Claimed},{"request":VaultImageSourceControlRequest::Read{capability_id:"capability-1".into(),max_bytes:262_144},"response":VaultImageSourceControlResponse::Chunk},{"request":VaultImageSourceControlRequest::Close{capability_id:"capability-1".into()},"response":VaultImageSourceControlResponse::Closed}]})
}
