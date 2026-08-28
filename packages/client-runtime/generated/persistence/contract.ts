/* eslint-disable */
/* This file is generated. Do not edit. */

export type ReplicaPersistenceRequest = ({
accountId: string
type: "load"
} | {
prepared: PreparedReplicaInstall
type: "install"
} | {
prepared: PreparedReplicaCommit
type: "commit"
} | {
prepared: PreparedLockEpochAdvance
type: "advanceLockEpoch"
} | {
accountId: string
type: "deleteAccount"
} | {
type: "wipeDevice"
})
export type ExpectedReplicaInstall = ({
accountId: string
type: "missing"
} | {
accountId: string
incarnation: string
lockEpoch: string
replicaRevision: string
type: "present"
userId: string
})
export type RuntimeErrorCode = ("RUNTIME_CLOSED" | "CANCELLED" | "ACCOUNT_MISSING" | "ACCOUNT_ALREADY_INSTALLED" | "ACCOUNT_FAILED" | "AUTHENTICATION_REQUIRED" | "AUTHENTICATION_UNAVAILABLE" | "RETRYABLE_TRANSPORT" | "AUTHORITY_MISSING" | "ACCESS_DENIED" | "READ_ONLY" | "QUOTA_EXCEEDED" | "SIZE_REJECTED" | "SOURCE_FAILURE" | "SINK_FAILURE" | "INVARIANT_VIOLATION")
export type PreparedReplicaWrite = ({
row: StoredReplicaRow
type: "put"
} | {
key: ReplicaRowKey
store: ReplicaStore
type: "delete"
})
export type ReplicaStore = ("optimisticItems" | "operations" | "attachmentMovePreparations" | "shareCapabilities" | "operationReceipts" | "replicaMetadata" | "bootstrapGenerations" | "bootstrapPages" | "authorityVaults" | "authorityItems")
export type ReplicaPersistenceResponse = ({
head: (ReplicaHead | null)
rows: StoredReplicaRow[]
type: "loaded"
} | {
result: ReplicaInstallResult
type: "installed"
} | {
result: PlanResult
type: "committed"
} | {
result: LockEpochAdvanceResult
type: "lockEpochAdvanced"
} | {
type: "accountDeleted"
} | {
type: "deviceWiped"
})
export type ReplicaInstallResult = ({
type: "applied"
} | {
type: "stale"
})
export type PlanResult = ({
replicaRevision: string
type: "applied"
} | {
actualRevision: string
type: "stale"
} | {
type: "missing"
})
export type LockEpochAdvanceResult = ({
lockEpoch: string
type: "applied"
} | {
type: "stale"
} | {
type: "missing"
})

export interface ReplicaPersistenceContract {
request: ReplicaPersistenceRequest
response: ReplicaPersistenceResponse
}
export interface PreparedReplicaInstall {
expected: ExpectedReplicaInstall
nextHead: ReplicaHead
writes: PreparedReplicaWrite[]
}
export interface ReplicaHead {
accountId: string
failure: (RuntimeErrorCode | null)
incarnation: string
lockEpoch: string
replicaRevision: string
userId: string
}
export interface StoredReplicaRow {
key: ReplicaRowKey
payloadJson: string
store: ReplicaStore
}
export interface ReplicaRowKey {
accountId: string
recordId: string
}
export interface PreparedReplicaCommit {
expected: ExpectedReplicaHead
nextHead: ReplicaHead
writes: PreparedReplicaWrite[]
}
export interface ExpectedReplicaHead {
accountId: string
incarnation: string
lockEpoch: string
replicaRevision: string
userId: string
}
export interface PreparedLockEpochAdvance {
expected: ExpectedReplicaHead
nextHead: ReplicaHead
}
