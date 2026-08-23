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

export interface HttpTransportContract {
request: HttpRequest
response: HttpResponse
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
