/* eslint-disable */
/* This file is generated. Do not edit. */

export type ProfileAdmissionRequest = ({
expectedScope: (ProfileLegacyResetScope | null)
format: LegacyProfileFormat
type: "prepareLegacyProfileReset"
wipeId: string
} | {
family: ProfileSourceFamily
resetHandle: string
type: "resetLegacySourceFamily"
wipeId: string
} | {
format: LegacyProfileFormat
type: "beginSourceSnapshot"
} | {
cursor: (string | null)
family: ProfileSourceFamily
selector: ProfileSourceSelector
snapshotHandle: string
type: "readSourcePage"
} | {
selector: ProfileSnapshotCloseSelector
type: "closeSourceSnapshot"
} | {
step: ProfileSourceReopenStep
type: "reopenSourceSnapshot"
} | {
step: ProfileSourceVerifyStep
type: "verifySourceSnapshot"
} | {
step: ProfileSourceCleanupReopenStep
type: "reopenSourceForCleanup"
} | {
admissionId: string
expectedEntry: ProfileSourceManifestEntry
index: string
snapshotHandle: string
type: "deleteCapturedSource"
})
export type ProfileSourceFamily = ("desktopStore" | "desktopSyncStore" | "desktopCredentials" | "extensionLocal" | "extensionSession" | "extensionRecords")
export type ProfileResetFileBinding = ({
type: "absent"
} | {
fileIdentity: string
type: "present"
} | {
type: "notFile"
})
export type LegacyProfileFormat = ("desktopLegacyV1" | "extensionLegacyV1")
export type ProfileSourceSelector = ({
type: "wholeFile"
} | {
field: ProfileGlobalCredentialField
type: "globalCredential"
} | {
accountId: string
field: ProfileAccountCredentialField
type: "accountCredential"
})
export type ProfileGlobalCredentialField = "deviceKey"
export type ProfileAccountCredentialField = ("secretKey" | "sessionData" | "jwtToken" | "vaultKeys" | "encryptedPrivateKey")
export type ProfileSnapshotCloseSelector = ({
handle: string
type: "exact"
} | {
type: "currentCapability"
})
export type ProfileSourceReopenStep = ({
header: ProfileSourceManifestHeader
type: "start"
verificationAttemptId: string
} | {
expectedEntry: ProfileSourceManifestEntry
index: string
type: "entry"
verificationCursor: string
} | {
type: "finish"
verificationCursor: string
})
export type ProfileSourceObservation = ({
type: "missing"
} | {
length: string
type: "fileBytes"
} | {
encoding: ProfileSourceStringEncoding
length: string
type: "storedString"
} | {
type: "presentUnsupported"
valueKind: ProfileSourceValueKind
})
export type ProfileSourceStringEncoding = ("utf8" | "utf16Le")
export type ProfileSourceValueKind = ("null" | "boolean" | "number" | "array" | "object" | "otherUnsupported")
export type ProfileSourceVerifyStep = ({
header: ProfileSourceManifestHeader
snapshotHandle: string
type: "start"
verificationAttemptId: string
} | {
expectedEntry: ProfileSourceManifestEntry
index: string
type: "entry"
verificationCursor: string
} | {
type: "finish"
verificationCursor: string
})
export type ProfileSourceCleanupReopenStep = ({
admissionId: string
header: ProfileSourceManifestHeader
type: "start"
verificationAttemptId: string
} | {
expectedEntry: ProfileSourceManifestEntry
index: string
type: "entry"
verificationCursor: string
} | {
type: "finish"
verificationCursor: string
})
export type ProfileAdmissionResponse = ({
result: ProfileResetPreparedResult
type: "profileResetPrepared"
} | {
family: ProfileSourceFamily
resetHandle: string
result: ProfileResetResult
type: "profileResetFamilyResult"
wipeId: string
} | {
snapshot: ProfileSourceSnapshot
type: "sourceSnapshot"
} | {
byteLength: string
continuation: ProfileSourceContinuation
family: ProfileSourceFamily
observation: ProfileSourceObservation
offset: string
selector: ProfileSourceSelector
snapshotHandle: string
type: "sourcePage"
} | {
result: ProfileSourceVerificationResult
type: "sourceSnapshotVerification"
} | {
result: ProfileSourceCleanupReopenResult
type: "sourceCleanupReopen"
} | {
admissionId: string
index: string
result: ProfileSourceDeleteResult
snapshotHandle: string
type: "sourceCleanupResult"
} | {
type: "sourceSnapshotClosed"
})
export type ProfileResetPreparedResult = ({
snapshot: ProfileResetSnapshot
type: "prepared"
} | {
type: "changed"
} | {
type: "unavailable"
})
export type ProfileResetResult = ({
type: "reset"
} | {
type: "alreadyAbsent"
} | {
type: "changed"
} | {
type: "unavailable"
})
export type ProfileSourcePresence = ("missing" | "present")
export type ProfileSourceContinuation = ({
cursor: string
type: "more"
} | {
type: "end"
})
export type ProfileSourceVerificationResult = ({
nextIndex: string
type: "started"
verificationCursor: string
} | {
nextIndex: string
type: "matched"
verificationCursor: string
} | {
type: "changed"
} | {
type: "unavailable"
} | {
snapshot: ProfileSourceSnapshot
type: "reopened"
} | {
snapshotHandle: string
type: "unchanged"
})
export type ProfileSourceCleanupReopenResult = ({
nextIndex: string
type: "started"
verificationCursor: string
} | {
nextIndex: string
type: "accepted"
verificationCursor: string
} | {
snapshot: ProfileSourceCleanupSnapshot
type: "reopened"
} | {
type: "unavailable"
})
export type ProfileSourceDeleteResult = ({
type: "deleted"
} | {
type: "alreadyAbsent"
} | {
type: "changed"
} | {
type: "unavailable"
})

export interface ProfileAdmissionContract {
request: ProfileAdmissionRequest
response: ProfileAdmissionResponse
}
export interface ProfileLegacyResetScope {
/**
 * @minItems 3
 * @maxItems 3
 */
families: [ProfileResetFamilyScope, ProfileResetFamilyScope, ProfileResetFamilyScope]
format: LegacyProfileFormat
profileIdentity: string
version: 1
}
export interface ProfileResetFamilyScope {
family: ProfileSourceFamily
file: ProfileResetFileBinding
namespaceIdentity: string
selectorPlanVersion: 1
}
export interface ProfileSourceManifestHeader {
entriesSha256: string
entryCount: string
format: LegacyProfileFormat
profileIdentity: string
recordedCaptureId: string
version: 1
}
export interface ProfileSourceManifestEntry {
evidenceSha256: string
family: ProfileSourceFamily
fileIdentity: (string | null)
observation: ProfileSourceObservation
selector: ProfileSourceSelector
version: 1
}
export interface ProfileResetSnapshot {
resetHandle: string
scope: ProfileLegacyResetScope
wipeId: string
}
export interface ProfileSourceSnapshot {
captureId: string
/**
 * @minItems 3
 * @maxItems 3
 */
families: [ProfileSourceFamilyInventory, ProfileSourceFamilyInventory, ProfileSourceFamilyInventory]
format: LegacyProfileFormat
profileIdentity: string
sessionInstance?: (string | null)
snapshotHandle: string
}
export interface ProfileSourceFamilyInventory {
family: ProfileSourceFamily
fileIdentity?: (string | null)
presence: ProfileSourcePresence
}
export interface ProfileSourceCleanupSnapshot {
admissionId: string
captureId: string
format: LegacyProfileFormat
profileIdentity: string
snapshotHandle: string
}
