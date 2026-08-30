/* eslint-disable */
/* This file is generated. Do not edit. */

export type AttachmentUploadSourceAnswer = ({
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
type: "retirementCompleted"
} | {
type: "sourceFailure"
} | {
type: "cancelled"
} | {
type: "invariantViolation"
})
export type AttachmentUploadSourceControl = ({
accountId: string
capabilityId: string
contentType: string
expectedBytes: string
itemId: string
name: string
type: "claim"
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
type: "retireRuntime"
})
export type ForegroundUploadOutcome = ({
ciphertextSha256: string
type: "uploaded"
} | {
type: "notDispatched"
} | {
status: number
type: "rejected"
} | {
type: "ambiguous"
} | {
type: "cancelled"
})
export type TransferControlRequest = ({
/**
 * @maxItems 64
 */
headers: TransferHeaderControl[]
maxChunkBytes: number
maxResponseBytes: string
transferId: string
type: "openDownload"
url: string
} | {
transferId: string
type: "readDownloadChunk"
} | {
accountId: string
artifactId: string
attachmentId: string
byteLength: string
ciphertextSha256: string
generation: string
/**
 * @maxItems 64
 */
headers: TransferHeaderControl[]
maxChunkBytes: number
operationId: string
transferId: string
type: "beginUpload"
url: string
} | {
byteLength: number
chunkSha256: string
transferId: string
type: "writeUploadChunk"
} | {
transferId: string
type: "finishUpload"
} | {
transferId: string
type: "cancelTransfer"
} | {
accountId: string
type: "deleteAccount"
} | {
type: "wipeDevice"
})
export type TransferControlResponse = ({
type: "downloadOpened"
} | {
byteLength: number
chunkSha256: string
type: "downloadChunk"
} | {
type: "downloadFinished"
} | {
type: "uploadBegun"
} | {
type: "uploadChunkAccepted"
} | {
type: "uploadFinished"
} | {
type: "accountDeleted"
} | {
type: "deviceWiped"
} | {
type: "cancelled"
} | {
type: "networkFailure"
} | {
type: "responseTooLarge"
} | {
status: number
type: "httpFailure"
})

export interface TransferControlContract {
attachmentUploadSourceAnswer: AttachmentUploadSourceAnswer
attachmentUploadSourceControl: AttachmentUploadSourceControl
foregroundUploadOutcome: ForegroundUploadOutcome
request: TransferControlRequest
response: TransferControlResponse
}
export interface TransferHeaderControl {
name: string
value: string
}
