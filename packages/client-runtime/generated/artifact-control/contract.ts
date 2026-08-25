/* eslint-disable */
/* This file is generated. Do not edit. */

export type ArtifactControlRequest = ({
type: "beginProvisional"
writer: ProvisionalArtifactTokenControl
} | {
chunkIndex: number
chunkSha256: string
type: "writeProvisionalChunk"
writer: ProvisionalArtifactTokenControl
} | {
owner: ArtifactOwnerControl
type: "sealProvisional"
writer: ProvisionalArtifactTokenControl
} | {
chunkIndex: number
owner: ArtifactOwnerControl
token: ProvisionalArtifactTokenControl
type: "readSealedProvisionalChunk"
} | {
owner: ArtifactOwnerControl
token: ProvisionalArtifactTokenControl
type: "finishProvisional"
} | {
scope: ProvisionalArtifactScopeControl
type: "recoverProvisional"
} | {
recovery: ProvisionalArtifactTokenControl
type: "resumeRecoveredProvisional"
} | {
type: "resumeProvisionalFinalization"
writer: ProvisionalArtifactTokenControl
} | {
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
} | {
token: ProvisionalArtifactTokenControl
type: "deleteProvisionalGeneration"
})
export type ArtifactControlResponse = ({
type: "provisionalBegun"
} | {
recovery: ProvisionalArtifactTokenControl
type: "provisionalRecoveryAvailable"
} | {
owner: ArtifactOwnerControl
state: ProvisionalPublicationStateControl
type: "provisionalBinding"
} | {
type: "provisionalFinished"
} | {
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
provisional: ProvisionalArtifactTokenControl[]
type: "artifactIds"
} | {
result: ArtifactDeletionControl
type: "artifactDeleted"
})
export type ProvisionalPublicationStateControl = ("sealed" | "published")
export type ArtifactChunkWriteControl = ("stored" | "alreadyStored")
export type ArtifactPublicationStateControl = ("verifying" | "published")
export type ArtifactPublicationControl = ("published" | "alreadyPublished")
export type ArtifactDeletionControl = ("progress" | "deleted" | "missing")

export interface ArtifactControlContract {
request: ArtifactControlRequest
response: ArtifactControlResponse
}
export interface ProvisionalArtifactTokenControl {
accountId: string
attachmentId: string
generation: string
operationId: string
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
export interface ProvisionalArtifactScopeControl {
accountId: string
attachmentId: string
operationId: string
}
