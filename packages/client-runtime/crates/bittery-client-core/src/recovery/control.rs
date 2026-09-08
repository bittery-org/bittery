use crate::replica::persistence_contract::{ReplicaHead, ReplicaStore};
use crate::RuntimeError;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[cfg_attr(feature = "recovery-contract-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum RecoveryRecord {
    RawReplicaHead {
        account_id: String,
        payload_json: String,
    },
    RawReplicaRow {
        account_id: String,
        store: ReplicaStore,
        record_id: String,
        payload_json: String,
    },
    ArtifactMetadata {
        account_id: String,
        artifact_id: String,
        metadata_json: String,
    },
    ArtifactChunk {
        account_id: String,
        artifact_id: String,
        #[cfg_attr(
            feature = "recovery-contract-schema",
            schemars(schema_with = "plain_u32_schema")
        )]
        chunk_index: u32,
        chunk_sha256: String,
    },
    ProvisionalMetadata {
        account_id: String,
        operation_id: String,
        attachment_id: String,
        generation: String,
        metadata_json: String,
    },
    ProvisionalChunk {
        account_id: String,
        operation_id: String,
        attachment_id: String,
        generation: String,
        #[cfg_attr(
            feature = "recovery-contract-schema",
            schemars(schema_with = "plain_u32_schema")
        )]
        chunk_index: u32,
        chunk_sha256: String,
    },
    VaultImageMetadata {
        account_id: String,
        operation_id: String,
        metadata_json: String,
    },
    VaultImageChunk {
        account_id: String,
        operation_id: String,
        #[cfg_attr(
            feature = "recovery-contract-schema",
            schemars(schema_with = "plain_u32_schema")
        )]
        chunk_index: u32,
    },
}
impl RecoveryRecord {
    pub(crate) fn account_id(&self) -> &str {
        match self {
            Self::RawReplicaHead { account_id, .. }
            | Self::RawReplicaRow { account_id, .. }
            | Self::ArtifactMetadata { account_id, .. }
            | Self::ArtifactChunk { account_id, .. }
            | Self::ProvisionalMetadata { account_id, .. }
            | Self::ProvisionalChunk { account_id, .. }
            | Self::VaultImageMetadata { account_id, .. }
            | Self::VaultImageChunk { account_id, .. } => account_id,
        }
    }
    pub(crate) fn has_binary(&self) -> bool {
        matches!(
            self,
            Self::ArtifactChunk { .. }
                | Self::ProvisionalChunk { .. }
                | Self::VaultImageChunk { .. }
        )
    }
}
#[cfg_attr(feature = "recovery-contract-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecoveryExpectedRow {
    pub store: ReplicaStore,
    pub record_id: String,
    pub payload_sha256: String,
}
#[cfg_attr(feature = "recovery-contract-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum RecoveryControlRequest {
    EnterMaintenance {
        recovery_id: String,
    },
    LeaveMaintenance {
        recovery_id: String,
    },
    ListAccounts {
        recovery_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cursor: Option<String>,
    },
    ReadEntry {
        recovery_id: String,
        account_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cursor: Option<String>,
    },
    AddArtifactEntry {
        recovery_id: String,
        account_id: String,
        record: RecoveryRecord,
    },
    BeginRepairStage {
        recovery_id: String,
        account_id: String,
    },
    StageExpectedRow {
        recovery_id: String,
        account_id: String,
        row: RecoveryExpectedRow,
    },
    StageRowStart {
        recovery_id: String,
        account_id: String,
        store: ReplicaStore,
        record_id: String,
        #[cfg_attr(
            feature = "recovery-contract-schema",
            schemars(schema_with = "plain_u32_schema")
        )]
        payload_byte_length: u32,
    },
    StageRowChunk {
        recovery_id: String,
        account_id: String,
    },
    StageRowEnd {
        recovery_id: String,
        account_id: String,
    },
    CommitRepair {
        recovery_id: String,
        account_id: String,
        expected_head_json: String,
        next_head: ReplicaHead,
        #[cfg_attr(
            feature = "recovery-contract-schema",
            schemars(schema_with = "plain_u32_schema")
        )]
        staged_row_count: u32,
        #[cfg_attr(
            feature = "recovery-contract-schema",
            schemars(schema_with = "plain_u32_schema")
        )]
        expected_row_count: u32,
    },
    DiscardRepairStage {
        recovery_id: String,
        account_id: String,
    },
    SourceRead {
        recovery_id: String,
        account_id: String,
        capability_id: String,
        #[cfg_attr(
            feature = "recovery-contract-schema",
            schemars(schema_with = "plain_u32_schema")
        )]
        max_bytes: u32,
    },
    SourceRewind {
        recovery_id: String,
        account_id: String,
        capability_id: String,
    },
    SourceClose {
        recovery_id: String,
        account_id: String,
        capability_id: String,
    },
    SinkWrite {
        recovery_id: String,
        account_id: String,
        capability_id: String,
    },
    SinkCommit {
        recovery_id: String,
        account_id: String,
        capability_id: String,
    },
    SinkDiscard {
        recovery_id: String,
        account_id: String,
        capability_id: String,
    },
}
#[cfg_attr(feature = "recovery-contract-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RecoveryUnavailableReason {
    UnsupportedSchema,
    Unsupported,
    Busy,
    StorageUnavailable,
    Corrupt,
    Quota,
    Cancelled,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "recovery-contract-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecoveryPhysicalSchemas {
    #[cfg_attr(
        feature = "recovery-contract-schema",
        schemars(schema_with = "plain_u32_schema")
    )]
    pub replica_version: u32,
    #[cfg_attr(
        feature = "recovery-contract-schema",
        schemars(schema_with = "plain_u32_schema")
    )]
    pub attachment_artifacts_version: u32,
    #[cfg_attr(
        feature = "recovery-contract-schema",
        schemars(schema_with = "plain_u32_schema")
    )]
    pub vault_images_version: u32,
}
#[cfg(test)]
pub(crate) const TEST_PHYSICAL_SCHEMAS: RecoveryPhysicalSchemas = RecoveryPhysicalSchemas {
    replica_version: 8,
    attachment_artifacts_version: 3,
    vault_images_version: 2,
};

#[cfg_attr(feature = "recovery-contract-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum RecoveryControlResponse {
    MaintenanceEntered {
        physical_schemas: RecoveryPhysicalSchemas,
    },
    MaintenanceLeft,
    AccountEntry {
        account_id: String,
        cursor: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        next_cursor: Option<String>,
    },
    Entry {
        cursor: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        next_cursor: Option<String>,
        record: RecoveryRecord,
    },
    End,
    ArtifactAdded,
    RepairStageBegun,
    ExpectedRowStaged,
    RowStarted,
    RowChunkStaged,
    RowEnded,
    RepairStageDiscarded,
    Repaired,
    Stale,
    SourceChunk,
    SourceEnded,
    SourceRewound,
    SourceClosed,
    SinkWritten,
    SinkCommitted,
    SinkDiscarded,
    LimitExceeded {
        bound: crate::RecoveryBound,
    },
    Unavailable {
        reason: RecoveryUnavailableReason,
    },
}

/// One fixed physical recovery family; control is closed Rust-generated vocabulary. Binary chunks
/// remain separately owned and bounded, never numeric-array JSON or host-visible plaintext Items.
#[cfg(not(target_arch = "wasm32"))]
#[async_trait]
pub trait SerializedRecoveryExecutor: Send + Sync {
    fn cancel(&self, _recovery_id: &str) {}
    async fn invoke(
        &self,
        control_json: String,
        binary_chunk: Option<Vec<u8>>,
    ) -> Result<(String, Option<Vec<u8>>), RuntimeError>;
}
#[cfg(target_arch = "wasm32")]
#[async_trait(?Send)]
pub trait SerializedRecoveryExecutor {
    fn cancel(&self, _recovery_id: &str) {}
    async fn invoke(
        &self,
        control_json: String,
        binary_chunk: Option<Vec<u8>>,
    ) -> Result<(String, Option<Vec<u8>>), RuntimeError>;
}
#[cfg(feature = "recovery-contract-schema")]
pub fn recovery_contract_schema() -> schemars::Schema {
    #[derive(schemars::JsonSchema)]
    #[allow(dead_code)]
    struct RecoveryContract {
        request: RecoveryControlRequest,
        response: RecoveryControlResponse,
    }
    let mut settings = schemars::generate::SchemaSettings::draft2020_12();
    settings.inline_subschemas = false;
    settings
        .into_generator()
        .into_root_schema_for::<RecoveryContract>()
}

#[cfg(feature = "recovery-contract-schema")]
fn plain_u32_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({"type":"integer","minimum":0,"maximum":4294967295u64})
}
