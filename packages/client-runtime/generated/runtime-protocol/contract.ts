/* eslint-disable */
/* This file is generated. Do not edit. */

export type ObservationRequest = ({
accountId: string
type: "items"
} | {
accountId: string
type: "pendingShareResults"
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
access: AccountAccessState
accountId: string
type: "accessChanged"
} | {
accountId: string
outcome: ServerAccountDeletionOutcome
requestId: string
type: "serverAccountDeletion"
} | {
itemId: string
operationId: string
replicaRevision: string
type: "accepted"
} | {
accountId: string
operationId: string
type: "shareResultAcknowledged"
} | {
accountId: string
attachmentId: string
type: "attachmentRenamed"
} | {
accountId: string
attachmentId: string
type: "attachmentDeleted"
} | {
accountId: string
attachmentId: string
type: "attachmentDownloaded"
} | {
attachmentId: string
replicaRevision: string
type: "attachmentUploaded"
} | {
/**
 * @maxItems 4
 */
failures?: []|[TeardownPhase]|[TeardownPhase, TeardownPhase]|[TeardownPhase, TeardownPhase, TeardownPhase]|[TeardownPhase, TeardownPhase, TeardownPhase, TeardownPhase]
scope: TeardownScope
status: TeardownStatus
type: "teardown"
})
export type AccountAccessState = ("signedOut" | "locked" | "unlocked")
export type ServerAccountDeletionOutcome = ("deleted" | "confirmationEmailMismatch" | "blocked")
/**
 * Closed, bounded failure vocabulary. It deliberately carries no host detail or identity.
 */
export type TeardownPhase = ("attachmentArtifacts" | "hostCleanup" | "platformStorage" | "replica")
export type TeardownScope = ({
accountId: string
type: "account"
} | {
type: "device"
})
export type TeardownStatus = ("complete" | "incomplete")
export type RuntimeErrorCode = ("RUNTIME_CLOSED" | "CANCELLED" | "ACCOUNT_MISSING" | "ACCOUNT_ALREADY_INSTALLED" | "ACCOUNT_FAILED" | "AUTHENTICATION_REQUIRED" | "AUTHENTICATION_UNAVAILABLE" | "RETRYABLE_TRANSPORT" | "AUTHORITY_MISSING" | "ACCESS_DENIED" | "READ_ONLY" | "QUOTA_EXCEEDED" | "SIZE_REJECTED" | "SOURCE_FAILURE" | "SINK_FAILURE" | "INVARIANT_VIOLATION")
export type RuntimeProjection = ({
type: "items"
value: ItemsProjection
} | {
type: "pendingShareResults"
value: PendingShareResultsProjection
} | {
type: "runtimeStatus"
value: RuntimeStatusProjection
})
export type ItemDraft = ({
category: "login"
data: LoginItemData
} | {
category: "secure-note"
data: SecureNoteItemData
} | {
category: "credit-card"
data: CreditCardItemData
} | {
category: "identity"
data: IdentityItemData
} | {
category: "authenticator"
data: AuthenticatorItemData
})
export type CustomFieldKind = ("text" | "password" | "email" | "url")
export type PasskeyStatus = ("active" | "suspect")
export type PasskeyStatusReason = ("manual" | "unknown-credential" | "signing-error" | "other")
export type TotpAlgorithm = ("SHA1" | "SHA256" | "SHA512")
export type TotpDigits = (6 | 7 | 8)
export type ItemProjectionStatus = ("pending" | "authoritative" | "failed")
export type VaultProjectionType = ("personal" | "team")
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
type: "lock"
} | {
accountId: string
type: "signOut"
} | {
accountId: string
type: "removeAccount"
} | {
accountId: string
confirmEmail: string
requestId: string
type: "deleteServerAccount"
} | {
type: "wipe"
} | {
accountId: string
draft: ItemDraft
type: "createItem"
vaultId: string
} | {
accountId: string
draft: ItemDraft
itemId: string
type: "updateItem"
} | {
accountId: string
favorite: boolean
itemId: string
type: "setItemFavorite"
} | {
accountId: string
itemId: string
type: "trashItem"
} | {
accountId: string
itemId: string
type: "restoreItem"
} | {
accountId: string
itemId: string
targetVaultId: string
type: "moveItem"
} | {
accountId: string
itemId: string
type: "permanentlyDeleteItem"
} | {
accountId: string
draft: CreateShareDraft
itemId: string
type: "createShare"
} | {
accountId: string
operationId: string
type: "acknowledgeShareResult"
} | {
accountId: string
attachmentId: string
name: string
type: "renameAttachment"
} | {
accountId: string
attachmentId: string
type: "deleteAttachment"
} | {
accountId: string
attachmentId: string
sinkCapabilityId: string
type: "downloadAttachment"
} | {
accountId: string
contentType: string
fileSize: string
itemId: string
name: string
sourceCapabilityId: string
type: "uploadAttachment"
})
export type ShareAccessMode = ("anyone" | "email-restricted")
export type ShareExpiration = ("1hour" | "1day" | "7days" | "14days" | "30days")

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
items: ItemProjection[]
replicaRevision: string
/**
 * The Vaults these Items live in, so a host can name one and can tell a reader from a
 * writer without asking a second source. Present for the first slice's create affordance;
 * full Vault metadata still belongs to the read path that owns it.
 */
vaults: VaultProjection[]
}
export interface ItemProjection {
accountId: string
attachments?: AttachmentProjection[]
createdAt: string
data: ItemDraft
deletedAt?: (string | null)
favorite: boolean
itemId: string
status: ItemProjectionStatus
updatedAt: string
vaultId: string
}
export interface AttachmentProjection {
accountId: string
attachmentId: string
contentType: string
createdAt: string
fileSize: number
itemId: string
name: string
uploadedBy: string
vaultId: string
}
export interface LoginItemData {
customFields?: CustomField[]
note?: (string | null)
notes?: (string | null)
passkeys?: Passkey[]
password?: (string | null)
passwordHistory?: PasswordHistoryEntry[]
tags?: string[]
title: string
totpAccountName?: (string | null)
totpAlgorithm?: (TotpAlgorithm | null)
totpDigits?: (TotpDigits | null)
totpIssuer?: (string | null)
totpPeriod?: (number | null)
totpSecret?: (string | null)
url?: (string | null)
urls?: string[]
username?: (string | null)
}
export interface CustomField {
id: string
label: string
type: CustomFieldKind
value: string
}
export interface Passkey {
algorithm: number
createdAt: string
credentialId: string
lastUsedAt?: (string | null)
privateKey: string
publicKey: string
rpId: string
rpName: string
signCount: number
status?: (PasskeyStatus | null)
statusReason?: (PasskeyStatusReason | null)
statusUpdatedAt?: (string | null)
transports: string[]
userDisplayName: string
userHandle: string
userName: string
}
export interface PasswordHistoryEntry {
changedAt: string
password: string
}
export interface SecureNoteItemData {
customFields?: CustomField[]
note: string
notes?: (string | null)
tags?: string[]
title: string
}
export interface CreditCardItemData {
billingAddress?: (string | null)
cardNumber?: (string | null)
cardholderName?: (string | null)
customFields?: CustomField[]
cvv?: (string | null)
expiryDate?: (string | null)
notes?: (string | null)
tags?: string[]
title: string
totpAccountName?: (string | null)
totpAlgorithm?: (TotpAlgorithm | null)
totpDigits?: (TotpDigits | null)
totpIssuer?: (string | null)
totpPeriod?: (number | null)
totpSecret?: (string | null)
}
export interface IdentityItemData {
addresses?: Address[]
customFields?: CustomField[]
dateOfBirth?: (string | null)
driversLicense?: (string | null)
email?: (string | null)
firstName?: (string | null)
lastName?: (string | null)
middleName?: (string | null)
notes?: (string | null)
passportNumber?: (string | null)
phoneNumbers?: PhoneNumber[]
ssn?: (string | null)
tags?: string[]
title: string
totpAccountName?: (string | null)
totpAlgorithm?: (TotpAlgorithm | null)
totpDigits?: (TotpDigits | null)
totpIssuer?: (string | null)
totpPeriod?: (number | null)
totpSecret?: (string | null)
}
export interface Address {
city: string
country: string
id: string
state: string
street: string
zip: string
}
export interface PhoneNumber {
id: string
label: string
number: string
}
export interface AuthenticatorItemData {
customFields?: CustomField[]
linkedItemId?: (string | null)
notes?: (string | null)
tags?: string[]
title: string
totpAccountName?: (string | null)
totpAlgorithm?: (TotpAlgorithm | null)
totpDigits?: (TotpDigits | null)
totpIssuer?: (string | null)
totpPeriod?: (number | null)
totpSecret: string
}
/**
 * One Vault as an Items reader needs it: enough to label it and to know what may be written.
 */
export interface VaultProjection {
icon?: (string | null)
imageUrl?: (string | null)
name: string
/**
 * This Account's membership in the Vault. A host derives "may I write an Item here"
 * from it (anything but `ReadOnly`), and the manage affordances an Owner or Admin has
 * and a Member does not. The first slice's narrower create rule filters on the Vault
 * type as well.
 */
role: ("owner" | "admin" | "member" | "read-only")
vaultId: string
vaultType: VaultProjectionType
}
export interface PendingShareResultsProjection {
accountId: string
replicaRevision: string
results: PendingShareResult[]
}
export interface PendingShareResult {
expiresAt: string
itemId: string
operationId: string
shareLinkId: string
shareUrl: string
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
displayIdentity?: (AccountDisplayIdentity | null)
failure: (RuntimeErrorCode | null)
replicaRevision: string
waitingReason?: (AccountWaitingReason | null)
}
/**
 * The non-secret identity a host may render for one installed Account.
 */
export interface AccountDisplayIdentity {
email: string
}
export interface CreateShareDraft {
accessMode: ShareAccessMode
allowedEmails?: string[]
expiresIn: ShareExpiration
isOneTimeUse: boolean
}
