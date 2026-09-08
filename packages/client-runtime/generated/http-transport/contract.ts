/* eslint-disable */
/* This file is generated. Do not edit. */

export type HttpMethod = ("GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE")
export type HttpResponse = ({
body: number[]
headers: HttpHeader[]
status: number
type: "completed"
} | {
type: "networkFailure"
} | {
type: "responseTooLarge"
} | {
type: "cancelled"
})
export type HttpStreamCommand = ({
request: HttpRequest
type: "openStream"
} | {
dispatchId: string
type: "readStream"
})
export type HttpStreamResponse = ({
headers: HttpHeader[]
status: number
type: "opened"
} | {
/**
 * @minItems 1
 */
bytes: [number, ...(number)[]]
type: "chunk"
} | {
type: "ended"
} | {
type: "networkFailure"
} | {
type: "responseTooLarge"
} | {
type: "cancelled"
})

export interface HttpTransportContract {
request: HttpRequest
response: HttpResponse
stream_command: HttpStreamCommand
stream_response: HttpStreamResponse
}
export interface HttpRequest {
body: number[]
dispatchId: string
headers: HttpHeader[]
maxResponseBytes: number
method: HttpMethod
url: string
}
export interface HttpHeader {
name: string
value: string
}
