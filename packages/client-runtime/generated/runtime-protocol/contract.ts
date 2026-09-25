/* eslint-disable */
/* This file is generated. Do not edit. */

export type ObservationRequest = ({
accountId: string
type: "vaultExport"
vaultIds: string[]
} | {
accountId: string
type: "travelMode"
} | {
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
 * Nonplaintext terminal controls bypass revoked plaintext delivery tokens.
 */
export type ObservationControl = {
reason: VaultExportRetirementReason
type: "vaultExportRetired"
}
export type VaultExportRetirementReason = ("scopeRetired" | "runtimeClosed" | "connectionClosed")
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
members: AvailableVaultMember[]
type: "availableVaultMembers"
} | {
members: CurrentVaultMember[]
type: "vaultMembers"
} | {
type: "vaultMemberAdded"
userId: string
vaultId: string
} | {
currentRole: (VaultRole | null)
type: "vaultMemberAddUncertain"
userId: string
vaultId: string
} | {
selection: RotationSelection
type: "rotationPrepared"
} | {
startOperationId: string
type: "rotationStartPending"
} | {
attempts: TeamLeaveAttempt[]
type: "teamLeaveAttempts"
} | {
type: "teamLeaveAttemptAcknowledged"
} | {
code: RotationStartRejectionCode
type: "rotationStartRejected"
} | {
plans: RotationPlanSelection[]
startOperationId: string
type: "rotationPreparationRequiresCrypto"
} | {
startOperationId: string
type: "rotationAttemptConsumed"
} | {
finalizeOperationId: string
type: "rotationFinalizePending"
} | {
finalizeOperationId: string
outcome: RotationTerminalOutcome
type: "rotationRefreshRequired"
} | {
personalTeamId: string
type: "rotationCompleted"
} | {
code: RotationFinalizeRejectionCode
type: "rotationRejected"
} | {
invitations: MyTeamInvitation[]
type: "myTeamInvitations"
} | {
teamId: string
teamName: string
type: "myTeamInvitationAccepted"
} | {
teamId: string
teamName: string
type: "myTeamInvitationAcceptRefreshRequired"
} | {
type: "myTeamInvitationDeclined"
} | {
action: MyInvitationAction
currentTeamId: (string | null)
invitationId: string
pending: (boolean | null)
type: "myTeamInvitationUncertain"
} | {
composer: InvitationComposerData
type: "invitationComposer"
} | {
candidate: (InvitationCandidate | null)
continuationId: (string | null)
invitationId: string
token: string
type: "teamInvitationCreated"
} | {
invitationId: string
token: string
type: "teamInvitationProvisioned"
} | {
invitationId: string
type: "teamInvitationProvisioningNotRequired"
} | {
originalInvitationId: (string | null)
phase: InvitationUncertainPhase
type: "teamInvitationUncertain"
} | {
type: "invitationContinuationReleased"
} | {
invitationId: string
type: "teamInvitationCancelled"
} | {
invitationId: string
token: string
type: "teamInvitationResent"
} | {
action: InvitationAdminAction
invitationId: string
pending: (boolean | null)
type: "teamInvitationAdminUncertain"
} | {
page: TeamPageData
type: "teamPage"
} | {
admissionId: string
type: "profileAdmissionAborted"
} | {
state: ProfileAdmissionInspectionState
type: "profileAdmissionInspection"
} | {
guard: CrossAccountMoveResumeGuard
type: "crossAccountMoveResumePrepared"
} | {
scope: string
type: "recipientKeyScope"
} | {
fingerprint: string
type: "ownKeyFingerprint"
userId: string
} | {
type: "recipientKeyVerified"
} | {
publicKey: string
type: "verifiedRecipientKey"
} | {
accountId: string
result: TravelModeCommandResult
type: "travelMode"
} | {
type: "activityRecorded"
} | {
accountId: string
inactivityTimeoutMs: string
masterPasswordReentryPeriodMs: string
type: "localSecuritySettings"
} | {
disclosure: DeviceSetupDisclosure
type: "deviceSetup"
} | {
accounts: AccountUnlockResult[]
type: "accountsUnlocked"
} | {
accounts: BiometricAccountAvailability[]
hardware: BiometricHardware
masterPasswordReentryPeriodMs: string
type: "biometricAvailability"
} | {
accountId: string
enabled: boolean
type: "biometricEnabled"
} | {
accounts: BiometricAccountUnlock[]
type: "biometricUnlock"
} | {
periodMs: string
type: "masterPasswordReentryPeriod"
} | {
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
type: "vaultDeletionAccepted"
vaultId: string
} | {
operationId: string
replicaRevision: string
type: "vaultUpdateAccepted"
vaultId: string
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
export type VaultRole = ("owner" | "admin" | "member" | "read-only")
export type RotationIntent = ({
type: "vaultMemberRemoval"
userId: string
vaultId: string
} | {
teamId: string
type: "teamLeave"
} | {
teamId: string
type: "teamMemberRemoval"
userId: string
})
export type RotationStartRejectionCode = ("team_member_not_found" | "personal_team_departure_forbidden" | "team_owner_leave_forbidden")
export type RotationTerminalOutcome = ({
personalTeamId: string
type: "applied"
} | {
code: RotationFinalizeRejectionCode
type: "rejected"
})
export type RotationFinalizeRejectionCode = ("team_membership_changed" | "personal_team_departure_forbidden" | "team_owner_leave_forbidden" | "rotation_plan_unavailable" | "rotation_plan_mismatch" | "rotation_plan_incomplete" | "rotation_plan_stale" | "rotation_plan_set_mismatch")
export type TeamRole = ("owner" | "admin" | "member")
export type MyInvitationAction = ("accept" | "decline")
export type InvitationUncertainPhase = ("firstSend" | "cancelOriginal" | "replacementSend")
export type InvitationAdminAction = ("cancel" | "resend")
export type TeamPageRole = ("owner" | "admin" | "member")
export type InvitationStatus = ("pending" | "accepted" | "declined" | "expired")
export type ProfileAdmissionInspectionState = ({
type: "notStarted"
} | {
admissionId: string
phase: ProfileAdmissionImportPhase
type: "import"
} | {
phase: ProfileAdmissionResetPhase
type: "reset"
wipeId: string
})
export type ProfileAdmissionImportPhase = ("preparing" | "aborting" | "aborted" | "committed" | "complete")
export type ProfileAdmissionResetPhase = ("wiping" | "wiped")
export type TravelModeCommandResult = ({
enforcement: TravelModeEnforcement
policy: TravelModePolicy
type: "confirmed"
} | {
policy: TravelModePolicy
type: "retryRequired"
} | {
lastVerifiedPolicy: (TravelModePolicy | null)
type: "uncertain"
})
export type TravelModeEnforcement = ("unverified" | "retiring" | "ready" | "refreshing")
export type RuntimeErrorCode = ("RECIPIENT_KEY_UNVERIFIED" | "RECIPIENT_KEY_CHANGED" | "RECIPIENT_FINGERPRINT_MISMATCH" | "RUNTIME_CLOSED" | "CANCELLED" | "ACCOUNT_MISSING" | "ACCOUNT_ALREADY_INSTALLED" | "ACCOUNT_FAILED" | "AUTHENTICATION_REQUIRED" | "AUTHENTICATION_UNAVAILABLE" | "CREDENTIAL_UNAVAILABLE" | "STORAGE_UNAVAILABLE" | "RETRYABLE_TRANSPORT" | "VERSION_EVIDENCE_UNAVAILABLE" | "AUTHORITY_MISSING" | "ACCESS_DENIED" | "READ_ONLY" | "QUOTA_EXCEEDED" | "SIZE_REJECTED" | "SOURCE_FAILURE" | "SINK_FAILURE" | "INVARIANT_VIOLATION")
export type BiometricFailure = ("unavailable" | "notEnrolled" | "notEnabled" | "passwordRequired" | "cancelled" | "failed" | "lockedOut" | "accountChanged" | "travelUnverified" | "storageUnavailable")
export type BiometricKind = ("touchId" | "faceId" | "windowsHello" | "fingerprint" | "face" | "other")
export type RecoveryStorageState = ("ready" | "corrupt" | "missing" | "unknown" | "unreadable")
export type RecoveryDeviceStatus = ("freshOrUnknown" | "knownAccounts" | "storageUnavailable")
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
export type ErrorCode = ("INTERNAL_ERROR" | "BAD_REQUEST" | "NOT_FOUND" | "FORBIDDEN" | "UNAUTHORIZED" | "CONFLICT" | "RATE_LIMITED" | "PAYLOAD_TOO_LARGE" | "INVALID_REQUEST" | "UNSUPPORTED_MEDIA_TYPE" | "PRECONDITION_REQUIRED" | "VERSION_CONFLICT" | "API_ROUTE_NOT_FOUND" | "METHOD_NOT_ALLOWED" | "SERVICE_UNAVAILABLE" | "INVALID_QUERY" | "INVALID_PAGE_LIMIT" | "INVALID_LIMIT" | "INVALID_CURSOR" | "INVALID_IF_MATCH" | "INVALID_VERSION" | "INVALID_ITEM_STATE" | "INVALID_EMAIL" | "ACCOUNT_DELETION_CONFIRMATION_MISMATCH" | "ACCOUNT_DELETION_BLOCKED" | "FIELD_CANNOT_BE_CLEARED" | "SEARCH_TOO_LONG" | "TOO_MANY_HIDDEN_VAULTS" | "INVALID_IDEMPOTENCY_KEY" | "IDEMPOTENCY_NOT_ALLOWED" | "INVALID_OPERATION_ID" | "OPERATION_ID_REUSED" | "OPERATION_OUTCOME_NOT_FOUND" | "ATTACHMENT_STAGING_INCOMPLETE" | "ATTACHMENT_STAGING_MISMATCH" | "ATTACHMENT_STAGING_BUSY" | "ATTACHMENT_AUTHORITY_STALE" | "ATTACHMENT_QUOTA_EXCEEDED" | "ROTATION_STALE_VAULT_VERSION" | "ROTATION_STALE_MEMBER_SET" | "ROTATION_STALE_ITEM_STATE" | "ROTATION_STALE_ATTACHMENT_STATE")
export type RuntimeProjection = ({
type: "vaultExport"
value: VaultExportProjection
} | {
type: "travelMode"
value: TravelModeProjection
} | {
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
/**
 * One Account's membership in one Vault.
 *
 * The values are the Server's own closed `VaultRole` set, spelled the way the Server spells
 * them, so a host that already renders a role does not need a second vocabulary and a
 * translation table between the two.
 */
export type VaultProjectionRole = ("owner" | "admin" | "member" | "read-only")
/**
 * The ordinary Item surface. Credential metadata is visible, but signing material is not.
 */
export type PublicItemDraft = ({
category: "login"
data: PublicLoginItemData
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
export type DuplicateSourceGuard = ({
itemVersion: number
type: "authoritative"
} | {
operationId: string
type: "acceptedOverlay"
})
export type CrossAccountMoveDisposition = ({
type: "ready"
} | {
type: "legacyHeld"
} | {
reason: CrossAccountMoveWaitingReason
type: "waiting"
} | {
reason: CrossAccountMoveBlockedReason
type: "blocked"
} | {
code: string
type: "rejected"
})
export type CrossAccountMoveWaitingReason = ("accountLocked" | "offline" | "policyVerificationPending" | "accessUnavailable" | "attachmentAccessDenied" | "attachmentQuotaExceeded" | "attachmentSizeRejected")
export type CrossAccountMoveBlockedReason = ("destinationRetired" | "missingSourceEvidence" | "sourceChanged" | "targetChanged" | "missingProof" | "missingArtifact")
export type CrossAccountMovePhase = ({
type: "targetCreate"
} | {
nextIndex: number
type: "attachments"
} | {
type: "sourceTrash"
} | {
type: "sourceDelete"
} | {
type: "completed"
} | {
type: "rejected"
})
export type OperationProjectionKind = ("createVault" | "updateVault" | "deleteVault" | "createItem" | "updateItem" | "setItemFavorite" | "trashItem" | "restoreItem" | "moveItem" | "permanentlyDeleteItem" | "createShare" | "importItems" | "createVaultMemberRemovalRotationPlans" | "finalizeVaultMemberRemovalRotationPlans" | "createTeamLeaveRotationPlans" | "finalizeTeamLeaveRotationPlans" | "createTeamMemberRemovalRotationPlans" | "finalizeTeamMemberRemovalRotationPlans")
export type OperationResolution = ("pending" | "applied" | "rejected" | "legacyFailed" | "legacyConflicted")
export type AccountWaitingReason = "reauthenticationRequired"
export type ProfileAdmissionCleanupStatus = {
pendingObligations: string
state: "pending"
}
export type RuntimeRequest = ({
accountId: string
type: "listAvailableVaultMembers"
vaultId: string
} | {
accountId: string
type: "listVaultMembers"
vaultId: string
} | {
accountId: string
role: VaultRole
type: "addVaultMember"
userId: string
vaultId: string
} | {
accountId: string
intent: RotationIntent
startOperationId?: (string | null)
type: "prepareRotation"
} | {
accountId: string
selection: RotationSelection
type: "completeRotation"
} | {
accountId: string
startOperationId: string
type: "inspectRotation"
} | {
accountId: string
type: "listTeamLeaveAttempts"
} | {
accountId: string
startOperationId: string
type: "acknowledgeTeamLeaveAttempt"
} | {
accountId: string
type: "listMyTeamInvitations"
} | {
accountId: string
invitationId: string
type: "acceptMyTeamInvitation"
} | {
accountId: string
invitationId: string
type: "declineMyTeamInvitation"
} | {
accountId: string
teamId: string
type: "readInvitationComposer"
} | {
accountId: string
email: string
role: TeamRole
teamId: string
type: "createTeamInvitation"
} | {
accountId: string
continuationId: string
type: "provisionTeamInvitation"
} | {
accountId: string
continuationId: string
type: "releaseInvitationContinuation"
} | {
accountId: string
invitationId: string
teamId: string
type: "cancelTeamInvitation"
} | {
accountId: string
invitationId: string
teamId: string
type: "resendTeamInvitation"
} | {
accountId: string
type: "readTeamPage"
} | {
type: "inspectProfileAdmission"
} | {
admissionId: string
type: "abortProfileAdmission"
} | {
accountId: string
type: "recipientKeyScope"
} | {
accountId: string
type: "ownKeyFingerprint"
} | {
accountId: string
expectedFingerprint: string
publicKey: string
recipientUserId: string
scope: string
type: "verifyRecipientKey"
} | {
accountId: string
publicKey: string
recipientUserId: string
scope: string
type: "verifiedRecipientKey"
} | {
accountId: string
masterPassword: string
type: "disableTravelMode"
} | {
accountId: string
hiddenVaultIds: string[]
type: "enableTravelMode"
} | {
accountId: string
hiddenVaultIds: string[]
type: "setTravelModeHiddenVaults"
} | {
accountId: string
type: "refreshTravelMode"
} | {
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
accountIds: string[]
type: "biometricAvailability"
} | {
accountId: string
enabled: boolean
type: "setBiometricEnabled"
} | {
accountId: string
promptMessage: string
type: "biometricUnlock"
} | {
accountIds: string[]
promptMessage: string
type: "biometricUnlockAccounts"
} | {
periodMs: string
type: "setMasterPasswordReentryPeriod"
} | {
accountId: string
type: "localSecuritySettings"
} | {
accountId: string
timeoutMs: string
type: "setInactivityTimeout"
} | {
accountId: string
kind: ActivityKind
type: "recordActivity"
} | {
accountId: string
type: "deviceSetup"
} | {
accountIds: string[]
masterPassword: string
type: "quickUnlockAccounts"
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
type: "deleteVault"
vaultId: string
} | {
accountId: string
icon: VaultIconPatch
image: VaultImageChange
name: (string | null)
type: "updateVault"
vaultId: string
} | {
accountId: string
icon: string
imageSource?: (VaultImageSourceInput | null)
name: string
type: "createVault"
vaultType: CreateVaultType
} | {
accountId: string
draft: EditableItemDraft
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
draft: EditableItemDraft
guard: ItemEditGuard
itemId: string
type: "updateItem"
} | {
accountId: string
credentialId: string
guard: ItemEditGuard
itemId: string
publicKeyFingerprint: string
rpId: string
type: "removePasskey"
} | {
accountId: string
sourceGuard: ItemDuplicateGuard
sourceItemId: string
title: string
type: "duplicateItem"
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
targetAccountId?: (string | null)
targetVaultId: string
type: "moveItem"
} | {
accountId: string
expectedBindingRevision: string
operationId: string
targetAccountId: string
type: "prepareCrossAccountMoveResume"
} | {
guard: CrossAccountMoveResumeGuard
type: "resumeCrossAccountMove"
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
itemId: string
linkId: string
type: "listShareAccessLogs"
} | {
accountId: string
itemId: string
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
export type ActivityKind = ("interaction" | "focus" | "blur")
export type VaultIconPatch = ({
type: "unchanged"
} | {
type: "clear"
} | {
type: "set"
value: string
})
export type VaultImageChange = ({
type: "unchanged"
} | {
type: "remove"
} | {
source: VaultImageSourceInput
type: "source"
})
export type CreateVaultType = ("personal" | "shared")
/**
 * A normal Create or Update cannot submit a credential, even if the caller forges JSON.
 */
export type EditableItemDraft = ({
category: "login"
data: EditableLoginItemData
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
export type ShareExpiration = ("1hour" | "1day" | "7days" | "14days" | "30days")

export interface RuntimeProtocolContract {
observation: ObservationRequest
observation_control: ObservationControl
outcome: RuntimeOutcome
projection: RuntimeProjection
request: RuntimeRequest
}
export interface AvailableVaultMember {
email: string
name: string
publicKey: string
userId: string
}
export interface CurrentVaultMember {
email: string
name: string
role: VaultRole
userId: string
}
export interface RotationSelection {
accountId: string
authorityGenerationId: string
candidates: RotationCandidate[]
incarnationId: string
intent: RotationIntent
lockEpoch: string
plans: RotationPlanSelection[]
startOperationId: string
}
export interface RotationCandidate {
fingerprint: string
publicKey: string
userId: string
}
export interface RotationPlanSelection {
expectedKeyVersion: number
planId: string
vaultId: string
}
/**
 * A nonterminal Team-leave attempt already owned by this Account's Replica journal.
 */
export interface TeamLeaveAttempt {
startOperationId: string
teamId: string
}
/**
 * Only authenticated pending Invitations addressed to this User are projected.
 */
export interface MyTeamInvitation {
expiresAt: string
id: string
invitedBy: string
role: TeamRole
teamId: string
teamName: string
}
export interface InvitationComposerData {
billingEnabled: boolean
seatPreview: (InvitationSeatPreview | null)
teamId: string
teamPlanActive: boolean
vaults: InvitationComposerVault[]
}
export interface InvitationSeatPreview {
currency: string
currentQuantity: string
estimatedNextPaymentCents: string
lines: InvitationSeatPreviewLine[]
nextQuantity: string
totalLineItemsCents: string
}
export interface InvitationSeatPreviewLine {
amountCents: string
currency: string
description: string
id: string
isProration: boolean
periodEnd: string
periodStart: string
quantity: (string | null)
unitAmountCents: (string | null)
}
export interface InvitationComposerVault {
id: string
name: string
}
export interface InvitationCandidate {
fingerprint: string
publicKey: string
recipientUserId: string
}
export interface TeamPageData {
invitations: TeamPageInvitation[]
members: TeamPageMember[]
team: (TeamPageDetails | null)
teamManagementEnabled: boolean
user: TeamPageUser
}
export interface TeamPageInvitation {
createdAt: string
email: string
expiresAt: string
id: string
invitedBy: string
role: TeamPageRole
status: InvitationStatus
}
export interface TeamPageMember {
email: string
joinedAt: string
name: string
role: TeamPageRole
userId: string
}
export interface TeamPageDetails {
createdAt: string
id: string
imageUrl: (string | null)
memberCount: string
memberLimit: (number | null)
name: string
ownerId: string
ownerName: string
updatedAt: string
userRole: TeamPageRole
}
export interface TeamPageUser {
email: string
id: string
name: string
}
/**
 * Stateless stale-input evidence. Both Accounts and current Server authority are still checked.
 */
export interface CrossAccountMoveResumeGuard {
accountId: string
bindingRevision: string
operationId: string
ownerIncarnation: string
sourceIncarnation: string
sourceLockEpoch: string
sourceReplicaRevision: string
targetAccountId: string
targetIncarnation: string
targetLockEpoch: string
}
/**
 * Presentation of verified durable metadata; timestamps retain decimal millisecond wire values.
 */
export interface TravelModePolicy {
enabled: boolean
hiddenVaultIds: string[]
serverEnabledAtMs: (string | null)
serverUpdatedAtMs: (string | null)
verifiedAtMs: (string | null)
}
/**
 * Transient setup disclosure: never part of an observation or persisted projection.
 */
export interface DeviceSetupDisclosure {
accountId: string
email: string
incarnation: string
lockEpoch: string
secretKey: string
serverUrl: string
teamName: (string | null)
}
export interface AccountUnlockResult {
accountId: string
failure: (RuntimeErrorCode | null)
}
export interface BiometricAccountAvailability {
accountId: string
enabled: boolean
failure: (BiometricFailure | null)
}
export interface BiometricHardware {
hasHardware: boolean
isEnrolled: boolean
kind: (BiometricKind | null)
}
export interface BiometricAccountUnlock {
accountId: string
/**
 * None means the explicitly requested Account unlocked successfully.
 */
failure: (BiometricFailure | null)
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
teamPageProblem?: (TeamPageProblem | null)
}
export interface TeamPageProblem {
code: ErrorCode
fieldErrors: TeamPageFieldError[]
message: string
requestId: string
retryAfterSeconds: (number | null)
retryable: boolean
status: number
}
export interface TeamPageFieldError {
code: string
pointer: string
}
/**
 * Plaintext only the foreground, scoped Export loan can deliver.
 */
export interface VaultExportProjection {
accountId: string
items: VaultExportItem[]
replicaRevision: string
vaults: VaultProjection[]
}
export interface VaultExportItem {
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
export interface TravelModeProjection {
accountId: string
enforcement: TravelModeEnforcement
lastVerifiedPolicy: (TravelModePolicy | null)
revision: string
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
data: PublicItemDraft
deletedAt?: (string | null)
duplicateSourceGuard?: (ItemDuplicateGuard | null)
editGuard?: (ItemEditGuard | null)
favorite: boolean
itemId: string
status: ItemProjectionStatus
updatedAt: string
vaultId: string
}
/**
 * Ordinary callers can edit the Login fields shown in the UI, never its credential array.
 */
export interface PublicLoginItemData {
customFields?: CustomField[]
note?: (string | null)
notes?: (string | null)
passkeys?: PublicPasskey[]
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
export interface PublicPasskey {
algorithm: number
createdAt: string
credentialId: string
lastUsedAt?: (string | null)
publicKey: string
/**
 * Stale-selection evidence over the exact persisted public-key String, not a trust root.
 */
publicKeyFingerprint: string
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
/**
 * Selection evidence for same-Vault Duplicate. This names either one confirmed Item version
 * or one exact locally accepted encrypted overlay, never a synthetic confirmed authority row.
 */
export interface ItemDuplicateGuard {
accountId: string
incarnationId: string
lockEpoch: string
replicaRevision: string
source: DuplicateSourceGuard
sourceItemId: string
vaultId: string
}
/**
 * Stateless evidence of the authoritative Item version the caller actually edited.
 */
export interface ItemEditGuard {
accountId: string
incarnation: string
itemId: string
itemVersion: number
lockEpoch: string
vaultId: string
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
crossAccountMove?: (CrossAccountMoveProjection | null)
importedCount: (number | null)
kind: OperationProjectionKind
nextAttemptAtMs: (string | null)
operationId: string
rejectionCode: (string | null)
resolution: OperationResolution
}
export interface CrossAccountMoveProjection {
destinationServerUrl: string
destinationUserId: string
destinationVaultId: string
disposition: CrossAccountMoveDisposition
phase: CrossAccountMovePhase
sourceVisible: boolean
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
profileAdmissionCleanup?: (ProfileAdmissionCleanupStatus | null)
revision: string
}
export interface AccountStatus {
access: AccountAccessState
accountId: string
displayIdentity?: (AccountDisplayIdentity | null)
failure: (RuntimeErrorCode | null)
replicaRevision: string
unlockCapabilities: AccountUnlockCapabilities
waitingReason?: (AccountWaitingReason | null)
}
/**
 * The non-secret identity a host may render for one installed Account.
 */
export interface AccountDisplayIdentity {
email: string
name: string
secretKeyHint: string
serverUrl: string
teamAvatarUrl: (string | null)
teamName: (string | null)
}
/**
 * Core-supported Account unlock actions. Biometric eligibility retains its dedicated projection.
 * Desktop authorization may require opening or reconnecting Desktop before its explicit ceremony.
 */
export interface AccountUnlockCapabilities {
desktop: boolean
password: boolean
signIn: boolean
}
export interface VaultImageSourceInput {
byteLength: string
capabilityId: string
contentType: string
}
/**
 * Ordinary callers can edit the Login fields shown in the UI, never its credential array.
 */
export interface EditableLoginItemData {
customFields?: CustomField[]
note?: (string | null)
notes?: (string | null)
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
