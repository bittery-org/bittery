/* eslint-disable */
/* This file is generated. Do not edit. */

export type ReplicaPersistenceRequest = ({
accountId: string
type: "load"
} | {
prepared: PreparedReplicaCommit
type: "commit"
})
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
result: PlanResult
type: "committed"
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
export interface ReplicaHead {
accountId: string
failure: (string | null)
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
