/* eslint-disable */
/* This file is generated. Do not edit. */

export type ArtifactControlRequest = ({
chunkIndex: number
chunkSha256: string
owner: ArtifactOwnerControl
type: "writeChunk"
} | {
owner: ArtifactOwnerControl
type: "beginPublish"
} | {
chunkIndex: number
owner: ArtifactOwnerControl
type: "readVerifyingChunk"
} | {
owner: ArtifactOwnerControl
type: "finishPublish"
} | {
chunkIndex: number
owner: ArtifactOwnerControl
type: "readPublishedChunk"
} | {
accountId: string
type: "deleteAccount"
} | {
accountId: string
type: "listArtifactIds"
} | {
accountId: string
artifactId: string
type: "deleteArtifact"
})
export type ArtifactControlResponse = ({
result: ArtifactChunkWriteControl
type: "chunkWritten"
} | {
state: ArtifactPublicationStateControl
type: "publicationStarted"
} | {
chunkSha256: string
type: "chunkRead"
} | {
result: ArtifactPublicationControl
type: "publicationFinished"
} | {
type: "accountDeleted"
} | {
artifactIds: string[]
type: "artifactIds"
} | {
result: ArtifactDeletionControl
type: "artifactDeleted"
})
export type ArtifactChunkWriteControl = ("stored" | "alreadyStored")
export type ArtifactPublicationStateControl = ("verifying" | "published")
export type ArtifactPublicationControl = ("published" | "alreadyPublished")
export type ArtifactDeletionControl = ("progress" | "deleted" | "missing")

export interface ArtifactControlContract {
request: ArtifactControlRequest
response: ArtifactControlResponse
}
export interface ArtifactOwnerControl {
accountId: string
artifactId: string
attachmentId: string
byteLength: string
chunkCount: number
ciphertextSha256: string
operationId: string
}
