/* eslint-disable */
/* This file is generated. Do not edit. */

export type ReplicaPersistenceRequest = ({
accountId: string
type: "load"
} | {
head: ReplicaHead
type: "install"
} | {
prepared: PreparedReplicaCommit
type: "commit"
})
export type RuntimeErrorCode = ("RUNTIME_CLOSED" | "CANCELLED" | "ACCOUNT_MISSING" | "ACCOUNT_ALREADY_INSTALLED" | "ACCOUNT_FAILED" | "AUTHENTICATION_REQUIRED" | "AUTHENTICATION_UNAVAILABLE" | "INVARIANT_VIOLATION")
export type PreparedReplicaWrite = ({
row: StoredReplicaRow
type: "put"
} | {
key: ReplicaRowKey
store: ReplicaStore
type: "delete"
})
export type ReplicaStore = ("optimisticItems" | "operations")
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
})
export type ReplicaInstallResult = ({
type: "created"
} | {
previousIncarnation: string
type: "replaced"
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

export interface ReplicaPersistenceContract {
request: ReplicaPersistenceRequest
response: ReplicaPersistenceResponse
}
export interface ReplicaHead {
accountId: string
failure: (RuntimeErrorCode | null)
incarnation: string
replicaRevision: string
userId: string
}
export interface PreparedReplicaCommit {
expected: ExpectedReplicaHead
nextHead: ReplicaHead
writes: PreparedReplicaWrite[]
}
export interface ExpectedReplicaHead {
accountId: string
incarnation: string
replicaRevision: string
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
