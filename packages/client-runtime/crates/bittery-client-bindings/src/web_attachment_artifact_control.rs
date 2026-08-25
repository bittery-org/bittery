use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "artifact-control-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ArtifactOwnerControl {
    pub(crate) account_id: String,
    pub(crate) artifact_id: String,
    pub(crate) operation_id: String,
    pub(crate) attachment_id: String,
    pub(crate) ciphertext_sha256: String,
    pub(crate) byte_length: String,
    #[cfg_attr(
        feature = "artifact-control-contract-schema",
        schemars(range(min = 0, max = 4_294_967_295_u32))
    )]
    pub(crate) chunk_count: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "artifact-control-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum ArtifactControlRequest {
    WriteChunk {
        owner: ArtifactOwnerControl,
        #[cfg_attr(
            feature = "artifact-control-contract-schema",
            schemars(range(min = 0, max = 4_294_967_295_u32))
        )]
        chunk_index: u32,
        chunk_sha256: String,
    },
    BeginPublish {
        owner: ArtifactOwnerControl,
    },
    ReadVerifyingChunk {
        owner: ArtifactOwnerControl,
        #[cfg_attr(
            feature = "artifact-control-contract-schema",
            schemars(range(min = 0, max = 4_294_967_295_u32))
        )]
        chunk_index: u32,
    },
    FinishPublish {
        owner: ArtifactOwnerControl,
    },
    ReadPublishedChunk {
        owner: ArtifactOwnerControl,
        #[cfg_attr(
            feature = "artifact-control-contract-schema",
            schemars(range(min = 0, max = 4_294_967_295_u32))
        )]
        chunk_index: u32,
    },
    DeleteAccount {
        account_id: String,
    },
    ListArtifactIds {
        account_id: String,
    },
    DeleteArtifact {
        account_id: String,
        artifact_id: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "artifact-control-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ArtifactChunkWriteControl {
    Stored,
    AlreadyStored,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "artifact-control-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ArtifactPublicationStateControl {
    Verifying,
    Published,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "artifact-control-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ArtifactPublicationControl {
    Published,
    AlreadyPublished,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "artifact-control-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ArtifactDeletionControl {
    Progress,
    Deleted,
    Missing,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "artifact-control-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum ArtifactControlResponse {
    ChunkWritten {
        result: ArtifactChunkWriteControl,
    },
    PublicationStarted {
        state: ArtifactPublicationStateControl,
    },
    ChunkRead {
        chunk_sha256: String,
    },
    PublicationFinished {
        result: ArtifactPublicationControl,
    },
    AccountDeleted,
    ArtifactIds {
        artifact_ids: Vec<String>,
    },
    ArtifactDeleted {
        result: ArtifactDeletionControl,
    },
}

#[cfg(feature = "artifact-control-contract-schema")]
#[derive(schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct ArtifactControlContract {
    request: ArtifactControlRequest,
    response: ArtifactControlResponse,
}

#[cfg(feature = "artifact-control-contract-schema")]
pub fn artifact_control_contract_schema() -> schemars::Schema {
    schemars::schema_for!(ArtifactControlContract)
}

#[cfg(feature = "artifact-control-contract-schema")]
pub fn artifact_control_contract_fixture() -> serde_json::Value {
    let digest = "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
    let owner = ArtifactOwnerControl {
        account_id: "account-1".into(),
        artifact_id: "artifact-1".into(),
        operation_id: "operation-1".into(),
        attachment_id: "attachment-1".into(),
        ciphertext_sha256: digest.into(),
        byte_length: "3".into(),
        chunk_count: 1,
    };
    serde_json::json!({
        "steps": [
            {
                "request": ArtifactControlRequest::WriteChunk {
                    owner: owner.clone(),
                    chunk_index: 0,
                    chunk_sha256: digest.into(),
                },
                "response": ArtifactControlResponse::ChunkWritten {
                    result: ArtifactChunkWriteControl::Stored,
                },
            },
            {
                "request": ArtifactControlRequest::BeginPublish {
                    owner: owner.clone(),
                },
                "response": ArtifactControlResponse::PublicationStarted {
                    state: ArtifactPublicationStateControl::Verifying,
                },
            },
            {
                "request": ArtifactControlRequest::FinishPublish {
                    owner: owner.clone(),
                },
                "response": ArtifactControlResponse::PublicationFinished {
                    result: ArtifactPublicationControl::Published,
                },
            },
            {
                "request": ArtifactControlRequest::ReadPublishedChunk {
                    owner,
                    chunk_index: 0,
                },
                "response": ArtifactControlResponse::ChunkRead {
                    chunk_sha256: digest.into(),
                },
            },
        ],
    })
}
