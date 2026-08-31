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
    };
    let metadata = VaultImageMetadataControl {
        scope: scope.clone(),
        vault_id: "vault-1".into(),
        byte_length: "3".into(),
        content_type: "image/png".into(),
        sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad".into(),
    };
    serde_json::json!({"steps":[{"request":VaultImageControlRequest::Begin{scope:scope.clone()},"response":VaultImageControlResponse::Begun},{"request":VaultImageControlRequest::WriteChunk{scope:scope.clone(),chunk_index:0},"response":VaultImageControlResponse::ChunkWritten{result:VaultImageChunkWriteControl::Stored}},{"request":VaultImageControlRequest::Publish{metadata:metadata.clone()},"response":VaultImageControlResponse::Published{result:VaultImagePublicationControl::Published}},{"request":VaultImageControlRequest::ReadChunk{metadata,chunk_index:0},"response":VaultImageControlResponse::Chunk}],"sourceSteps":[{"request":VaultImageSourceControlRequest::Claim{capability_id:"capability-1".into(),account_id:"account-1".into(),operation_id:"operation-1".into(),vault_id:"vault-1".into(),content_type:"image/png".into(),byte_length:"3".into()},"response":VaultImageSourceControlResponse::Claimed},{"request":VaultImageSourceControlRequest::Read{capability_id:"capability-1".into(),max_bytes:262_144},"response":VaultImageSourceControlResponse::Chunk},{"request":VaultImageSourceControlRequest::Close{capability_id:"capability-1".into()},"response":VaultImageSourceControlResponse::Closed}]})
}
