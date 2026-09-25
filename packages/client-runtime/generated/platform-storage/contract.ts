/* eslint-disable */
/* This file is generated. Do not edit. */

export type PlatformStorageRequest = ({
area: PlatformStorageArea
cursor: (null | string)
prefix: string
type: "listKeys"
} | {
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
expectedValue: string
key: string
type: "deleteIfUnchanged"
} | {
area: PlatformStorageArea
prefix: string
preserveKey?: string
type: "deletePrefix"
})
export type PlatformStorageArea = ("devicePlain" | "deviceSecret" | "sessionSecret")
export type PlatformStorageResponse = ({
/**
 * @minItems 1
 * @maxItems 3
 */
backingAreas: [PlatformStorageArea]|[PlatformStorageArea, PlatformStorageArea]|[PlatformStorageArea, PlatformStorageArea, PlatformStorageArea]
continuation: PlatformStorageInventoryContinuation
family: PlatformStorageInventoryFamily
/**
 * @maxItems 128
 */
keys: string[]
type: "keysPage"
version: 1
} | {
type: "value"
value: (string | null)
} | {
result: PlatformStorageDeleteResult
type: "deleteResult"
} | {
type: "done"
})
export type PlatformStorageInventoryContinuation = ({
cursor: string
type: "more"
} | {
type: "end"
})
export type PlatformStorageInventoryFamily = "platformStorage"
export type PlatformStorageDeleteResult = ("deleted" | "alreadyAbsent" | "conflict")

export interface PlatformStorageContract {
request: PlatformStorageRequest
response: PlatformStorageResponse
}
