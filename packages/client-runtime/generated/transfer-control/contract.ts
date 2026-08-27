/* eslint-disable */
/* This file is generated. Do not edit. */

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
request: TransferControlRequest
response: TransferControlResponse
}
export interface TransferHeaderControl {
name: string
value: string
}
