/* eslint-disable */
/* This file is generated. Do not edit. */

export type ObservationRequest = ({
accountId: string
type: "items"
} | {
accountId: (string | null)
type: "runtimeStatus"
})
/**
 * The declared envelope every external Runtime request answers with.
 * 
 * Serde would otherwise emit its externally tagged `Result` spelling, an implicit wire shape no
 * contract describes. This adjacent tagging matches `RuntimeProjection`, and it keeps the
 * success payload intact: `RuntimeResponse` is itself internally tagged on `type`, so an
 * internally tagged envelope would collide with it.
 */
export type RuntimeOutcome = ({
type: "succeeded"
value: RuntimeResponse
} | {
type: "failed"
value: RuntimeError
})
export type RuntimeResponse = ({
accountId: string
type: "signedIn"
userId: string
} | {
itemId: string
operationId: string
replicaRevision: string
type: "accepted"
})
export type RuntimeErrorCode = ("RUNTIME_CLOSED" | "CANCELLED" | "ACCOUNT_MISSING" | "ACCOUNT_ALREADY_INSTALLED" | "ACCOUNT_FAILED" | "AUTHENTICATION_REQUIRED" | "AUTHENTICATION_UNAVAILABLE" | "INVARIANT_VIOLATION")
export type RuntimeProjection = ({
type: "items"
value: ItemsProjection
} | {
type: "runtimeStatus"
value: RuntimeStatusProjection
})
export type CustomFieldKind = ("text" | "password" | "email" | "url")
export type ItemProjectionStatus = ("pending" | "authoritative" | "failed")
export type AccountAccessState = ("signedOut" | "locked" | "unlocked")
export type AccountWaitingReason = "reauthenticationRequired"
export type RuntimeRequest = ({
email: string
insecureTransportConfirmed: boolean
masterPassword: string
secretKey: string
serverUrl: string
type: "signIn"
} | {
accountId: string
masterPassword: string
type: "quickUnlock"
} | {
accountId: string
draft: LoginItemDraft
type: "createLoginItem"
vaultId: string
})

export interface RuntimeProtocolContract {
observation: ObservationRequest
outcome: RuntimeOutcome
projection: RuntimeProjection
request: RuntimeRequest
}
export interface RuntimeError {
code: RuntimeErrorCode
message: string
}
export interface ItemsProjection {
accountId: string
items: LoginItemProjection[]
replicaRevision: string
}
export interface LoginItemProjection {
accountId: string
createdAt: string
customFields?: LoginCustomField[]
favorite: boolean
itemId: string
note?: (string | null)
notes?: (string | null)
password?: (string | null)
status: ItemProjectionStatus
tags?: string[]
title: string
updatedAt: string
url?: (string | null)
urls?: string[]
username?: (string | null)
vaultId: string
}
export interface LoginCustomField {
id: string
label: string
type: CustomFieldKind
value: string
}
export interface RuntimeStatusProjection {
accountId: (string | null)
accounts: AccountStatus[]
closed: boolean
revision: string
}
export interface AccountStatus {
access: AccountAccessState
accountId: string
failure: (RuntimeErrorCode | null)
replicaRevision: string
waitingReason?: (AccountWaitingReason | null)
}
export interface LoginItemDraft {
customFields?: LoginCustomField[]
note?: (string | null)
notes?: (string | null)
password?: (string | null)
tags?: string[]
title: string
url?: (string | null)
urls?: string[]
username?: (string | null)
}
