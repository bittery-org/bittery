/* eslint-disable */
/* This file is generated. Do not edit. */

export type VaultImageControlRequest = ({
scope: VaultImageScopeControl
type: "begin"
} | {
chunkIndex: number
scope: VaultImageScopeControl
type: "writeChunk"
} | {
metadata: VaultImageMetadataControl
type: "publish"
} | {
chunkIndex: number
metadata: VaultImageMetadataControl
type: "readChunk"
} | {
scope: VaultImageScopeControl
type: "delete"
} | {
accountId: string
type: "deleteAccount"
} | {
type: "wipe"
} | {
accountId: string
referencedOperationIds: string[]
type: "startupSweep"
})
export type VaultImageControlResponse = ({
type: "begun"
} | {
result: VaultImageChunkWriteControl
type: "chunkWritten"
} | {
result: VaultImagePublicationControl
type: "published"
} | {
type: "chunk"
} | {
type: "missing"
} | {
type: "deleted"
} | {
type: "accountDeleted"
} | {
type: "wiped"
} | {
type: "swept"
})
export type VaultImageChunkWriteControl = ("stored" | "alreadyStored")
export type VaultImagePublicationControl = ("published" | "alreadyPublished")
export type VaultImageSourceControlRequest = ({
accountId: string
byteLength: string
capabilityId: string
contentType: string
operationId: string
type: "claim"
vaultId: string
} | {
capabilityId: string
maxBytes: number
type: "read"
} | {
capabilityId: string
type: "close"
} | {
accountId: string
type: "retireAccount"
} | {
accountId: string
type: "completeAccountRetirement"
} | {
accountId: string
operationId: string
type: "beginAcceptance"
} | {
accountId: string
operationId: string
type: "endAcceptance"
} | {
type: "retireRuntime"
})
export type VaultImageSourceControlResponse = ({
type: "claimed"
} | {
type: "chunk"
} | {
type: "end"
} | {
type: "closed"
} | {
type: "retired"
} | {
type: "acceptanceBegun"
} | {
type: "acceptanceEnded"
} | {
type: "sourceFailure"
} | {
type: "cancelled"
} | {
type: "invariantViolation"
})

export interface VaultImageControlContract {
request: VaultImageControlRequest
response: VaultImageControlResponse
sourceRequest: VaultImageSourceControlRequest
sourceResponse: VaultImageSourceControlResponse
}
export interface VaultImageScopeControl {
accountId: string
operationId: string
}
export interface VaultImageMetadataControl {
accountId: string
byteLength: string
contentType: string
operationId: string
sha256: string
vaultId: string
}
