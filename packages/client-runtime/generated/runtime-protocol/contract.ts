/* eslint-disable */
/* This file is generated. Do not edit. */

export type ObservationRequest = ({
type: "writableVaultCatalog"
} | {
accountId: string
type: "items"
} | {
accountId: string
type: "operations"
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
diagnostics: StorageRecoveryDiagnostics
type: "recoveryDiagnosed"
} | {
accountId: string
byteLength: string
classification: RecoveryClassification
type: "recoveryExported"
} | {
accountId: string
replicaRevision: string
type: "recoveryRepaired"
} | {
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
operationId: string
replicaRevision: string
type: "vaultCreationAccepted"
vaultId: string
} | {
itemId: string
operationId: string
replicaRevision: string
type: "accepted"
} | {
itemIds: string[]
operationId: string
replicaRevision: string
type: "importBatchAccepted"
vaultId: string
} | {
accountId: string
operationId: string
type: "shareResultAcknowledged"
} | {
accountId: string
baseShareUrl: string
itemId: string
links: ShareLinkSummary[]
type: "itemShareLinks"
} | {
accountId: string
linkId: string
logs: ShareAccessLog[]
type: "shareAccessLogs"
} | {
accountId: string
linkId: string
type: "shareLinkRevoked"
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
export type RecoveryStorageState = ("ready" | "corrupt" | "missing" | "unknown" | "unreadable")
export type RecoveryDeviceStatus = ("freshOrUnknown" | "knownAccounts" | "storageUnavailable")
export type RuntimeErrorCode = ("RUNTIME_CLOSED" | "CANCELLED" | "ACCOUNT_MISSING" | "ACCOUNT_ALREADY_INSTALLED" | "ACCOUNT_FAILED" | "AUTHENTICATION_REQUIRED" | "AUTHENTICATION_UNAVAILABLE" | "STORAGE_UNAVAILABLE" | "RETRYABLE_TRANSPORT" | "AUTHORITY_MISSING" | "ACCESS_DENIED" | "READ_ONLY" | "QUOTA_EXCEEDED" | "SIZE_REJECTED" | "SOURCE_FAILURE" | "SINK_FAILURE" | "INVARIANT_VIOLATION")
export type RecoveryMaintenanceStatus = ("available" | "unsupported" | "busy" | "unavailable")
export type RecoverySchemaStatus = ("supported" | "unsupported" | "unknown")
export type RecoveryClassification = ("complete" | "partial")
export type AccountAccessState = ("signedOut" | "locked" | "unlocked")
export type ServerAccountDeletionOutcome = ("deleted" | "confirmationEmailMismatch" | "blocked")
export type ShareAccessMode = ("anyone" | "email-restricted")
export type ShareLinkStatus = ("active" | "expired" | "exhausted" | "revoked")
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
/**
 * Closed recovery implementation guards; these are not Account capacity limits.
 */
export type RecoveryBound = ("recordBytes" | "archiveBytes" | "recordCount" | "artifactCount" | "reportBytes" | "summaryBytes" | "controlBytes" | "cursorBytes" | "chunkBytes")
export type RuntimeProjection = ({
type: "writableVaultCatalog"
value: WritableVaultCatalogProjection
} | {
type: "items"
value: ItemsProjection
} | {
type: "operations"
value: OperationsProjection
} | {
type: "pendingShareResults"
value: PendingShareResultsProjection
} | {
type: "runtimeStatus"
value: RuntimeStatusProjection
})
/**
 * One Account's membership in one Vault.
 *
 * The values are the Server's own closed `VaultRole` set, spelled the way the Server spells
 * them, so a host that already renders a role does not need a second vocabulary and a
 * translation table between the two.
 */
export type VaultProjectionRole = ("owner" | "admin" | "member" | "read-only")
export type VaultProjectionType = ("personal" | "team")
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
export type OperationProjectionKind = ("createVault" | "createItem" | "updateItem" | "setItemFavorite" | "trashItem" | "restoreItem" | "moveItem" | "permanentlyDeleteItem" | "createShare" | "importItems")
export type OperationResolution = ("pending" | "applied" | "rejected")
export type AccountWaitingReason = "reauthenticationRequired"
export type RuntimeRequest = ({
accountId: string
type: "rebootstrapAccountRecovery"
} | {
accountId?: (string | null)
type: "inspectRecovery"
} | {
accountId: string
password: string
sinkCapabilityId: string
type: "exportAccountRecovery"
} | {
accountId: string
password: string
sourceCapabilityId: string
type: "repairAccountRecovery"
} | {
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
icon: string
imageSource?: (VaultImageSourceInput | null)
name: string
type: "createVault"
vaultType: CreateVaultType
} | {
accountId: string
draft: ItemDraft
type: "createItem"
vaultId: string
} | {
accountId: string
/**
 * @maxItems 200
 */
items: ImportItemDraft[]
type: "importItems"
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
itemId: string
type: "listItemShareLinks"
} | {
accountId: string
linkId: string
type: "listShareAccessLogs"
} | {
accountId: string
linkId: string
type: "revokeShareLink"
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
export type CreateVaultType = ("personal" | "shared")
export type ShareExpiration = ("1hour" | "1day" | "7days" | "14days" | "30days")

export interface RuntimeProtocolContract {
observation: ObservationRequest
outcome: RuntimeOutcome
projection: RuntimeProjection
request: RuntimeRequest
}
export interface StorageRecoveryDiagnostics {
accounts: StorageRecoveryAccount[]
device: RecoveryDeviceStatus
failure: (RuntimeErrorCode | null)
maintenance: RecoveryMaintenanceStatus
schema: RecoverySchemaStatus
}
export interface StorageRecoveryAccount {
accountId: string
canExport: boolean
canRebootstrap: boolean
canRepair: boolean
email: (string | null)
missingArtifacts: (number | null)
operationCount: (number | null)
receiptCount: (number | null)
serverUrl: (string | null)
state: RecoveryStorageState
userId: (string | null)
}
export interface ShareLinkSummary {
accessCount: number
accessMode: ShareAccessMode
allowedEmails: ShareAllowedEmail[]
createdAt: string
expiresAt: string
id: string
isOneTimeUse: boolean
lastAccessedAt: (string | null)
maxAccessCount: (number | null)
status: ShareLinkStatus
}
export interface ShareAllowedEmail {
email: string
verified: boolean
}
export interface ShareAccessLog {
accessedAt: string
accessedByEmail: (string | null)
failureReason: (string | null)
id: string
ipAddress: (string | null)
success: boolean
userAgent: (string | null)
}
export interface RuntimeError {
code: RuntimeErrorCode
message: string
recoveryBound?: (RecoveryBound | null)
}
export interface WritableVaultCatalogProjection {
revision: string
vaults: WritableVaultProjection[]
}
/**
 * Non-secret authority metadata for every currently unlocked writable Vault on this Device.
 */
export interface WritableVaultProjection {
accountId: string
icon?: (string | null)
imageUrl?: (string | null)
name: string
role: VaultProjectionRole
vaultId: string
vaultType: VaultProjectionType
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
 * One Account's membership in one Vault.
 *
 * The values are the Server's own closed `VaultRole` set, spelled the way the Server spells
 * them, so a host that already renders a role does not need a second vocabulary and a
 * translation table between the two.
 */
role: ("owner" | "admin" | "member" | "read-only")
vaultId: string
vaultType: VaultProjectionType
}
/**
 * Non-secret progress from accepted Operations and their durable terminal receipts.
 */
export interface OperationsProjection {
accountId: string
operations: OperationProjection[]
replicaRevision: string
}
export interface OperationProjection {
/**
 * Terminal receipts do not retain historical scheduling diagnostics.
 */
attemptCount: (string | null)
importedCount: (number | null)
kind: OperationProjectionKind
nextAttemptAtMs: (string | null)
operationId: string
rejectionCode: (string | null)
resolution: OperationResolution
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
export interface VaultImageSourceInput {
byteLength: string
capabilityId: string
contentType: string
}
/**
 * One plaintext Import draft. The host supplies only category data and Favorite; Rust owns the
 * final Item identity, ciphertext, and immutable batch request.
 */
export interface ImportItemDraft {
draft: ItemDraft
favorite: boolean
}
export interface CreateShareDraft {
accessMode: ShareAccessMode
allowedEmails?: string[]
expiresIn: ShareExpiration
isOneTimeUse: boolean
}
