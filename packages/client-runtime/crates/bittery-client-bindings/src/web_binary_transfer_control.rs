use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "transfer-control-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TransferHeaderControl {
    #[cfg_attr(
        feature = "transfer-control-contract-schema",
        schemars(length(min = 1, max = 256))
    )]
    pub(crate) name: String,
    #[cfg_attr(
        feature = "transfer-control-contract-schema",
        schemars(length(max = 4096))
    )]
    pub(crate) value: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "transfer-control-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum TransferControlRequest {
    OpenDownload {
        #[cfg_attr(
            feature = "transfer-control-contract-schema",
            schemars(length(min = 1, max = 128))
        )]
        transfer_id: String,
        #[cfg_attr(
            feature = "transfer-control-contract-schema",
            schemars(length(min = 1, max = 8192))
        )]
        url: String,
        #[cfg_attr(
            feature = "transfer-control-contract-schema",
            schemars(length(max = 64))
        )]
        headers: Vec<TransferHeaderControl>,
        #[cfg_attr(
            feature = "transfer-control-contract-schema",
            schemars(regex(pattern = "^(0|[1-9][0-9]{0,19})$"))
        )]
        max_response_bytes: String,
        #[cfg_attr(
            feature = "transfer-control-contract-schema",
            schemars(range(min = 1, max = 262_144_u32))
        )]
        max_chunk_bytes: u32,
    },
    ReadDownloadChunk {
        #[cfg_attr(
            feature = "transfer-control-contract-schema",
            schemars(length(min = 1, max = 128))
        )]
        transfer_id: String,
    },
    BeginUpload {
        #[cfg_attr(
            feature = "transfer-control-contract-schema",
            schemars(length(min = 1, max = 128))
        )]
        transfer_id: String,
        #[cfg_attr(
            feature = "transfer-control-contract-schema",
            schemars(length(min = 1, max = 256))
        )]
        account_id: String,
        #[cfg_attr(
            feature = "transfer-control-contract-schema",
            schemars(length(min = 1, max = 256))
        )]
        operation_id: String,
        #[cfg_attr(
            feature = "transfer-control-contract-schema",
            schemars(length(min = 1, max = 256))
        )]
        attachment_id: String,
        #[cfg_attr(
            feature = "transfer-control-contract-schema",
            schemars(length(min = 1, max = 256))
        )]
        artifact_id: String,
        #[cfg_attr(
            feature = "transfer-control-contract-schema",
            schemars(length(min = 1, max = 256))
        )]
        generation: String,
        #[cfg_attr(
            feature = "transfer-control-contract-schema",
            schemars(length(min = 1, max = 8192))
        )]
        url: String,
        #[cfg_attr(
            feature = "transfer-control-contract-schema",
            schemars(length(max = 64))
        )]
        headers: Vec<TransferHeaderControl>,
        #[cfg_attr(
            feature = "transfer-control-contract-schema",
            schemars(regex(pattern = "^[0-9a-f]{64}$"))
        )]
        ciphertext_sha256: String,
        #[cfg_attr(
            feature = "transfer-control-contract-schema",
            schemars(regex(pattern = "^(0|[1-9][0-9]{0,19})$"))
        )]
        byte_length: String,
        #[cfg_attr(
            feature = "transfer-control-contract-schema",
            schemars(range(min = 1, max = 262_144_u32))
        )]
        max_chunk_bytes: u32,
    },
    WriteUploadChunk {
        #[cfg_attr(
            feature = "transfer-control-contract-schema",
            schemars(length(min = 1, max = 128))
        )]
        transfer_id: String,
        #[cfg_attr(
            feature = "transfer-control-contract-schema",
            schemars(range(min = 1, max = 262_144_u32))
        )]
        byte_length: u32,
        #[cfg_attr(
            feature = "transfer-control-contract-schema",
            schemars(regex(pattern = "^[0-9a-f]{64}$"))
        )]
        chunk_sha256: String,
    },
    FinishUpload {
        #[cfg_attr(
            feature = "transfer-control-contract-schema",
            schemars(length(min = 1, max = 128))
        )]
        transfer_id: String,
    },
    CancelTransfer {
        #[cfg_attr(
            feature = "transfer-control-contract-schema",
            schemars(length(min = 1, max = 128))
        )]
        transfer_id: String,
    },
    /// Destroys one named Account's ciphertext spool. The identity is opaque to the host, so the
    /// only constraint is that it names something.
    DeleteAccount {
        #[cfg_attr(
            feature = "transfer-control-contract-schema",
            schemars(regex(pattern = "^[\\s\\S]+$"))
        )]
        account_id: String,
    },
    /// Destroys every Account's ciphertext spool on this Device.
    WipeDevice,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "transfer-control-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum TransferControlResponse {
    DownloadOpened,
    DownloadChunk {
        #[cfg_attr(
            feature = "transfer-control-contract-schema",
            schemars(range(min = 1, max = 262_144_u32))
        )]
        byte_length: u32,
        #[cfg_attr(
            feature = "transfer-control-contract-schema",
            schemars(regex(pattern = "^[0-9a-f]{64}$"))
        )]
        chunk_sha256: String,
    },
    DownloadFinished,
    UploadBegun,
    UploadChunkAccepted,
    UploadFinished,
    AccountDeleted,
    DeviceWiped,
    Cancelled,
    NetworkFailure,
    ResponseTooLarge,
    HttpFailure {
        #[cfg_attr(
            feature = "transfer-control-contract-schema",
            schemars(range(min = 0, max = 599_u16))
        )]
        status: u16,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "transfer-control-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[cfg(feature = "transfer-control-contract-schema")]
pub(crate) enum ForegroundUploadOutcome {
    Uploaded {
        #[cfg_attr(
            feature = "transfer-control-contract-schema",
            schemars(regex(pattern = "^[0-9a-f]{64}$"))
        )]
        ciphertext_sha256: String,
    },
    NotDispatched,
    Rejected {
        #[cfg_attr(
            feature = "transfer-control-contract-schema",
            schemars(range(min = 300, max = 599_u16))
        )]
        status: u16,
    },
    Ambiguous,
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "transfer-control-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum AttachmentUploadSourceControl {
    Claim {
        account_id: String,
        item_id: String,
        name: String,
        content_type: String,
        capability_id: String,
        #[cfg_attr(
            feature = "transfer-control-contract-schema",
            schemars(regex(pattern = "^(0|[1-9][0-9]{0,19})$"))
        )]
        expected_bytes: String,
    },
    Read {
        capability_id: String,
        #[cfg_attr(
            feature = "transfer-control-contract-schema",
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
    RetireRuntime,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "transfer-control-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum AttachmentUploadSourceAnswer {
    Claimed,
    Chunk,
    End,
    Closed,
    Retired,
    RetirementCompleted,
    SourceFailure,
    Cancelled,
    InvariantViolation,
}

#[cfg(feature = "transfer-control-contract-schema")]
#[derive(schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct TransferControlContract {
    request: TransferControlRequest,
    response: TransferControlResponse,
    foreground_upload_outcome: ForegroundUploadOutcome,
    attachment_upload_source_control: AttachmentUploadSourceControl,
    attachment_upload_source_answer: AttachmentUploadSourceAnswer,
}

#[cfg(feature = "transfer-control-contract-schema")]
pub fn transfer_control_contract_schema() -> schemars::Schema {
    schemars::schema_for!(TransferControlContract)
}

#[cfg(feature = "transfer-control-contract-schema")]
pub fn transfer_control_contract_fixture() -> serde_json::Value {
    serde_json::json!({
        "steps": [
            {
                "request": {
                    "type": "openDownload",
                    "transferId": "download-1",
                    "url": "https://objects.example/source?opaque=credential",
                    "headers": [{ "name": "x-signed", "value": "signed" }],
                    "maxResponseBytes": "524288",
                    "maxChunkBytes": 262144
                },
                "response": { "type": "downloadOpened" }
            },
            {
                "request": { "type": "readDownloadChunk", "transferId": "download-1" },
                "response": {
                    "type": "downloadChunk",
                    "byteLength": 3,
                    "chunkSha256": "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81"
                }
            },
            {
                "request": {
                    "type": "beginUpload",
                    "transferId": "upload-1",
                    "accountId": "account-1",
                    "operationId": "operation-1",
                    "attachmentId": "attachment-1",
                    "artifactId": "artifact-1",
                    "generation": "generation-1",
                    "url": "https://objects.example/target?opaque=credential",
                    "headers": [
                        { "name": "content-type", "value": "application/octet-stream" },
                        { "name": "x-amz-content-sha256", "value": "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81" }
                    ],
                    "ciphertextSha256": "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
                    "byteLength": "3",
                    "maxChunkBytes": 262144
                },
                "response": { "type": "uploadBegun" }
            },
            {
                "request": {
                    "type": "writeUploadChunk",
                    "transferId": "upload-1",
                    "byteLength": 3,
                    "chunkSha256": "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81"
                },
                "response": { "type": "uploadChunkAccepted" }
            },
            {
                "request": { "type": "finishUpload", "transferId": "upload-1" },
                "response": { "type": "uploadFinished" }
            },
            {
                "request": { "type": "deleteAccount", "accountId": "account-1" },
                "response": { "type": "accountDeleted" }
            },
            {
                "request": { "type": "wipeDevice" },
                "response": { "type": "deviceWiped" }
            }
        ],
        "attachmentUploadSourceControls": [
            {
                "type": "claim",
                "accountId": "account-1",
                "itemId": "item-1",
                "name": "secret.txt",
                "contentType": "text/plain",
                "capabilityId": "source-1",
                "expectedBytes": "3"
            },
            { "type": "read", "capabilityId": "source-1", "maxBytes": 262144 },
            { "type": "close", "capabilityId": "source-1" },
            { "type": "retireAccount", "accountId": "account-1" },
            { "type": "completeAccountRetirement", "accountId": "account-1" },
            { "type": "retireRuntime" }
        ],
        "attachmentUploadSourceAnswers": [
            { "type": "claimed" },
            { "type": "chunk" },
            { "type": "end" },
            { "type": "closed" },
            { "type": "retired" },
            { "type": "retirementCompleted" },
            { "type": "sourceFailure" },
            { "type": "cancelled" },
            { "type": "invariantViolation" }
        ]
    })
}
