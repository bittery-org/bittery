/* eslint-disable */
/* This file is generated. Do not edit. */

export type PlatformStorageRequest = ({
area: PlatformStorageArea
key: string
type: "get"
} | {
area: PlatformStorageArea
key: string
type: "set"
value: string
} | {
area: PlatformStorageArea
key: string
type: "delete"
} | {
area: PlatformStorageArea
prefix: string
type: "deletePrefix"
})
export type PlatformStorageArea = ("devicePlain" | "deviceSecret" | "sessionSecret")
export type PlatformStorageResponse = ({
type: "value"
value: (string | null)
} | {
type: "done"
})

export interface PlatformStorageContract {
request: PlatformStorageRequest
response: PlatformStorageResponse
}
