/* eslint-disable */
/* This file is generated. Do not edit. */

export type RecoveryControlRequest = ({
recoveryId: string
type: "enterMaintenance"
} | {
recoveryId: string
type: "leaveMaintenance"
} | {
cursor?: (string | null)
recoveryId: string
type: "listAccounts"
} | {
accountId: string
cursor?: (string | null)
recoveryId: string
type: "readEntry"
} | {
accountId: string
record: RecoveryRecord
recoveryId: string
type: "addArtifactEntry"
} | {
accountId: string
recoveryId: string
type: "beginRepairStage"
} | {
accountId: string
recoveryId: string
row: RecoveryExpectedRow
type: "stageExpectedRow"
} | {
accountId: string
payloadByteLength: number
recordId: string
recoveryId: string
store: ReplicaStore
type: "stageRowStart"
} | {
accountId: string
recoveryId: string
type: "stageRowChunk"
} | {
accountId: string
recoveryId: string
type: "stageRowEnd"
} | {
accountId: string
expectedHeadJson: string
expectedRowCount: number
nextHead: ReplicaHead
recoveryId: string
stagedRowCount: number
type: "commitRepair"
} | {
accountId: string
recoveryId: string
type: "discardRepairStage"
} | {
accountId: string
capabilityId: string
maxBytes: number
recoveryId: string
type: "sourceRead"
} | {
accountId: string
capabilityId: string
recoveryId: string
type: "sourceRewind"
} | {
accountId: string
capabilityId: string
recoveryId: string
type: "sourceClose"
} | {
accountId: string
capabilityId: string
recoveryId: string
type: "sinkWrite"
} | {
accountId: string
capabilityId: string
recoveryId: string
type: "sinkCommit"
} | {
accountId: string
capabilityId: string
recoveryId: string
type: "sinkDiscard"
})
export type RecoveryRecord = ({
accountId: string
payloadJson: string
type: "rawReplicaHead"
} | {
accountId: string
payloadJson: string
recordId: string
store: ReplicaStore
type: "rawReplicaRow"
} | {
accountId: string
artifactId: string
metadataJson: string
type: "artifactMetadata"
} | {
accountId: string
artifactId: string
chunkIndex: number
chunkSha256: string
type: "artifactChunk"
} | {
accountId: string
attachmentId: string
generation: string
metadataJson: string
operationId: string
type: "provisionalMetadata"
} | {
accountId: string
attachmentId: string
chunkIndex: number
chunkSha256: string
generation: string
operationId: string
type: "provisionalChunk"
} | {
accountId: string
metadataJson: string
operationId: string
type: "vaultImageMetadata"
} | {
accountId: string
chunkIndex: number
operationId: string
type: "vaultImageChunk"
} | {
accountId: string
metadataJson: string
operationId: string
publicationId: string
type: "protectedVaultImageMetadata"
} | {
accountId: string
chunkIndex: number
operationId: string
publicationId: string
type: "protectedVaultImageChunk"
})
export type ReplicaStore = ("optimisticItems" | "operations" | "crossAccountMoves" | "attachmentMovePreparations" | "shareCapabilities" | "operationReceipts" | "rotationAttempts" | "replicaMetadata" | "bootstrapGenerations" | "bootstrapPages" | "authorityVaults" | "authorityItems")
export type RuntimeErrorCode = ("RECIPIENT_KEY_UNVERIFIED" | "RECIPIENT_KEY_CHANGED" | "RECIPIENT_FINGERPRINT_MISMATCH" | "RUNTIME_CLOSED" | "CANCELLED" | "ACCOUNT_MISSING" | "ACCOUNT_ALREADY_INSTALLED" | "ACCOUNT_FAILED" | "AUTHENTICATION_REQUIRED" | "AUTHENTICATION_UNAVAILABLE" | "CREDENTIAL_UNAVAILABLE" | "STORAGE_UNAVAILABLE" | "RETRYABLE_TRANSPORT" | "VERSION_EVIDENCE_UNAVAILABLE" | "AUTHORITY_MISSING" | "ACCESS_DENIED" | "READ_ONLY" | "QUOTA_EXCEEDED" | "SIZE_REJECTED" | "SOURCE_FAILURE" | "SINK_FAILURE" | "INVARIANT_VIOLATION")
export type RecoveryControlResponse = ({
physicalSchemas: RecoveryPhysicalSchemas
type: "maintenanceEntered"
} | {
type: "maintenanceLeft"
} | {
accountId: string
cursor: string
nextCursor?: (string | null)
type: "accountEntry"
} | {
cursor: string
nextCursor?: (string | null)
record: RecoveryRecord
type: "entry"
} | {
type: "end"
} | {
type: "artifactAdded"
} | {
type: "repairStageBegun"
} | {
type: "expectedRowStaged"
} | {
type: "rowStarted"
} | {
type: "rowChunkStaged"
} | {
type: "rowEnded"
} | {
type: "repairStageDiscarded"
} | {
type: "repaired"
} | {
type: "stale"
} | {
type: "sourceChunk"
} | {
type: "sourceEnded"
} | {
type: "sourceRewound"
} | {
type: "sourceClosed"
} | {
type: "sinkWritten"
} | {
type: "sinkCommitted"
} | {
type: "sinkDiscarded"
} | {
bound: RecoveryBound
type: "limitExceeded"
} | {
reason: RecoveryUnavailableReason
type: "unavailable"
})
/**
 * Closed recovery implementation guards; these are not Account capacity limits.
 */
export type RecoveryBound = ("recordBytes" | "archiveBytes" | "recordCount" | "artifactCount" | "reportBytes" | "summaryBytes" | "controlBytes" | "cursorBytes" | "chunkBytes")
export type RecoveryUnavailableReason = ("unsupportedSchema" | "unsupported" | "busy" | "storageUnavailable" | "corrupt" | "quota" | "cancelled")

export interface RecoveryContract {
request: RecoveryControlRequest
response: RecoveryControlResponse
}
export interface RecoveryExpectedRow {
payloadSha256: string
recordId: string
store: ReplicaStore
}
export interface ReplicaHead {
accountId: string
failure?: (RuntimeErrorCode | null)
incarnation: string
lockEpoch: string
replicaRevision: string
userId: string
}
export interface RecoveryPhysicalSchemas {
attachmentArtifactsVersion: number
replicaVersion: number
vaultImagesVersion: number
}
