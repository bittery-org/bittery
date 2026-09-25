/* eslint-disable */
/* This file is generated. Do not edit. */

/**
 * This control contract is available only to trusted native compositions.
 */
export type NativeAuthorityRequest = ({
extensionId: string
transportId: string
type: "attachSource"
} | {
channelId: string
type: "sourceSnapshot"
} | {
source: NativeAuthoritySnapshot
transportId: string
type: "attachDesktop"
} | {
channelId: string
insecureTransportConfirmed?: boolean
sourceAccount: string
type: "prepareImportForSource"
} | {
channelId: string
sourceAccount: string
type: "prepareIndependentRevalidation"
} | {
challenge: NativeImportChallenge
type: "revalidateIndependentRestrictions"
} | {
reply: NativeIndependentRevalidationReply
type: "completeIndependentRevalidation"
} | {
challenge: NativeImportChallenge
type: "export"
} | {
challenge: NativeImportChallenge
promptMessage: string
type: "exportWithBiometric"
} | {
reply: NativeTransferReply
type: "completeImport"
} | {
channelId: string
source: NativeAuthoritySnapshot
type: "applyAuthority"
} | {
channelId: string
type: "restrictionAcknowledgement"
} | {
acknowledgement: NativeRestrictionAcknowledgement
type: "acknowledgeRestrictions"
} | {
channelId: string
type: "retireChannel"
})
/**
 * Source verification episodes restrict admission without withdrawing an established grant.
 */
export type NativePolicyVerification = ({
revision: string
type: "pending"
} | {
restrictionFrontier: string
revision: string
type: "verified"
})
export type NativeRestrictionEvidence = ({
policy: NativeTravelEvidence
type: "verifiedPolicy"
} | {
type: "existingRetirement"
})
export type NativeRestrictionDisposition = ({
accountId: string
incarnation: string
type: "journalOwned"
} | {
type: "noTargetAtCapture"
} | {
accountId: string
incarnation: string
type: "targetRemoved"
})
export type NativeAuthorityResponse = ({
snapshot: NativeAuthoritySnapshot
type: "source"
} | {
channelId: string
type: "attached"
} | {
challenge: NativeImportChallenge
type: "prepared"
} | {
reply: NativeTransferReply
type: "exported"
} | {
reply: NativeIndependentRevalidationReply
type: "independentRestrictionsRevalidated"
} | {
failure: BiometricFailure
type: "biometricRefused"
} | {
acknowledgement: NativeRestrictionAcknowledgement
type: "restrictionAcknowledgement"
} | {
type: "applied"
})
export type BiometricFailure = ("unavailable" | "notEnrolled" | "notEnabled" | "passwordRequired" | "cancelled" | "failed" | "lockedOut" | "accountChanged" | "travelUnverified" | "storageUnavailable")

export interface NativeAuthorityContract {
request: NativeAuthorityRequest
response: NativeAuthorityResponse
}
export interface NativeAuthoritySnapshot {
accounts: NativeAccountAuthority[]
channelId: string
extensionId: string
ownerId: string
/**
 * @minItems 32
 * @maxItems 32
 */
restrictionChainDigest: [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number]
restrictionFrontier: string
restrictions: NativeRestrictionBatch[]
sequence: string
transportId: string
version: number
}
export interface NativeAccountAuthority {
/**
 * Derived capability readiness; this does not change Desktop Account lock state.
 */
keyAuthorizationAvailable: boolean
keyGeneration: string
policyVerification?: (NativePolicyVerification | null)
restrictiveContinuity?: (NativeRestrictiveContinuity | null)
scope: NativeAccountScope
unlocked: boolean
}
export interface NativeRestrictiveContinuity {
fromGeneration: string
throughGeneration: string
}
export interface NativeAccountScope {
accountId: string
incarnation: string
lockEpoch: string
serverUrl: string
userId: string
}
export interface NativeRestrictionBatch {
batchId: string
/**
 * @minItems 32
 * @maxItems 32
 */
chainDigest: [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number]
/**
 * @minItems 32
 * @maxItems 32
 */
contentDigest: [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number]
evidence: NativeRestrictionEvidence
fromKeyGeneration: string
/**
 * @minItems 32
 * @maxItems 32
 */
previousDigest: [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number]
source: NativeAccountScope
toKeyGeneration: string
vaultIds: string[]
}
/**
 * Nonsecret source policy evidence accompanies, but does not change, encrypted transfer material.
 */
export interface NativeTravelEvidence {
enabled: boolean
hiddenVaultIds: string[]
serverEnabledAtMs: (string | null)
serverUpdatedAtMs: (string | null)
verifiedAtMs: (string | null)
}
export interface NativeImportChallenge {
challengeId: string
destination: NativeAccountScope
destinationChannel: string
destinationInsecureTransportConfirmed: boolean
destinationOwner: string
destinationTransport: string
extensionId: string
newDestination: boolean
/**
 * One native challenge owner serves credential transfer and independent exclusion restoration.
 */
purpose?: ({
type: "transfer"
} | {
excludedVaultIds: string[]
/**
 * @minItems 32
 * @maxItems 32
 */
restrictionChainDigest: [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number]
restrictionFrontier: string
type: "revalidateIndependentRestrictions"
})
source: NativeAccountScope
sourceChannel: string
sourceKeyGeneration: string
sourceOwner: string
sourceTransport: string
version: number
}
export interface NativeIndependentRevalidationReply {
challenge: NativeImportChallenge
sourceSessionExpiresAtMs: string
visibleVaultIds: string[]
}
export interface NativeTransferReply {
challenge: NativeImportChallenge
material: string
profile: NativeAccountProfile
travelEvidence: NativeTravelEvidence
}
/**
 * Presentation and pinned derivation policy; this carries no new login secret.
 */
export interface NativeAccountProfile {
addedAtMs: string
biometricEnabled: boolean
email: string
lastActiveAtMs: string
name: string
pinnedKdfProfile: KdfProfile
secretKeyHint: string
teamAvatarUrl?: (string | null)
teamName?: (string | null)
}
export interface KdfProfile {
algorithm: string
iterations: number
schemaVersion: number
}
export interface NativeRestrictionAcknowledgement {
adoptions: NativeRestrictionAdoption[]
/**
 * @minItems 32
 * @maxItems 32
 */
chainDigest: [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number]
destinationChannel: string
destinationOwner: string
destinationTransport: string
frontier: string
sourceChannel: string
sourceOwner: string
sourceTransport: string
}
export interface NativeRestrictionAdoption {
batchId: string
/**
 * @minItems 32
 * @maxItems 32
 */
chainDigest: [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number]
/**
 * @minItems 32
 * @maxItems 32
 */
contentDigest: [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number]
disposition: NativeRestrictionDisposition
}
