import contractSchema from "../generated/platform-storage/contract.schema.json";
import type {
	PlatformStorageArea,
	PlatformStorageRequest,
	PlatformStorageResponse,
} from "../generated/platform-storage/contract.ts";
import {
	validatePlatformStorageRequest,
	validatePlatformStorageResponse,
} from "../generated/platform-storage/validator.js";

const inventorySchema = contractSchema.$defs.PlatformStorageResponse.oneOf.find(
	(variant) => variant.properties.type.const === "keysPage",
)?.properties.keys;
if (inventorySchema === undefined) {
	throw new Error("generated platform storage inventory schema is missing");
}
const MAX_KEY_BYTES = inventorySchema.items.maxLength;
const MAX_PAGE_KEYS = inventorySchema.maxItems;
const cursorSchema =
	contractSchema.$defs.PlatformStorageInventoryContinuation.oneOf.find(
		(variant) => variant.properties.type.const === "more",
	)?.properties.cursor;
if (cursorSchema === undefined) {
	throw new Error("generated platform storage cursor schema is missing");
}
const MAX_CURSOR_BYTES = cursorSchema.maxLength;
// The existing serialized-control ceiling also covers JSON escaping and envelope bytes.
const MAX_CONTROL_BYTES = 262_144;
const encoder = new TextEncoder();
type KeysPage = Extract<PlatformStorageResponse, { type: "keysPage" }>;
type ListKeysRequest = Extract<PlatformStorageRequest, { type: "listKeys" }>;
interface InventoryCursor {
	version: 1;
	owner: string;
	area: PlatformStorageArea;
	prefix: string;
	after: string;
}

export interface WebPlatformStorageHostDeps {
	device: Storage;
	session: Storage;
}

/** Executes Rust-authored primitive storage envelopes without interpreting their keys or values. */
export class WebPlatformStorageHost {
	private readonly inventoryOwner = crypto.randomUUID();

	constructor(private readonly deps?: WebPlatformStorageHostDeps) {}

	async invoke(requestJson: unknown): Promise<string> {
		const request = parseRequest(requestJson);
		let response: PlatformStorageResponse;
		try {
			const storage = this.storage(request.area);
			switch (request.type) {
				case "listKeys":
					response = this.listKeys(storage, request);
					break;
				case "get":
					response = { type: "value", value: storage.getItem(request.key) };
					break;
				case "set":
					storage.setItem(request.key, request.value);
					response = { type: "done" };
					break;
				case "delete":
					storage.removeItem(request.key);
					response = { type: "done" };
					break;
				case "deleteIfUnchanged": {
					const actual = storage.getItem(request.key);
					if (actual === null) {
						response = { type: "deleteResult", result: "alreadyAbsent" };
					} else if (actual !== request.expectedValue) {
						response = { type: "deleteResult", result: "conflict" };
					} else {
						storage.removeItem(request.key);
						response = { type: "deleteResult", result: "deleted" };
					}
					break;
				}
				case "deletePrefix": {
					const keys: string[] = [];
					for (let index = 0; index < storage.length; index += 1) {
						const key = storage.key(index);
						if (
							key?.startsWith(request.prefix) &&
							key !== request.preserveKey
						) {
							keys.push(key);
						}
					}
					for (const key of keys) storage.removeItem(key);
					response = { type: "done" };
					break;
				}
			}
		} catch {
			throw new PlatformStorageHostError();
		}
		if (!validatePlatformStorageResponse(response)) {
			throw new Error(
				"platform storage response does not match the generated contract",
			);
		}
		const serialized = JSON.stringify(response);
		if (
			request.type === "listKeys" &&
			encoder.encode(serialized).byteLength > MAX_CONTROL_BYTES
		) {
			throw new PlatformStorageHostError();
		}
		return serialized;
	}

	private listKeys(storage: Storage, request: ListKeysRequest): KeysPage {
		const after = this.inventoryAfter(request);
		const keys: string[] = [];
		const length = storage.length;
		for (let index = 0; index < length; index += 1) {
			const key = storage.key(index);
			if (key === null || !isInventoryKey(key)) {
				throw new PlatformStorageHostError();
			}
			if (
				!key.startsWith(request.prefix) ||
				(after !== null && compareUtf8(key, after) <= 0)
			)
				continue;
			let position = 0;
			while (position < keys.length) {
				const retained = keys[position];
				if (retained === undefined) throw new PlatformStorageHostError();
				const order = compareUtf8(key, retained);
				if (order === 0) throw new PlatformStorageHostError();
				if (order < 0) break;
				position += 1;
			}
			if (position <= MAX_PAGE_KEYS) {
				keys.splice(position, 0, key);
				if (keys.length > MAX_PAGE_KEYS + 1) keys.pop();
			}
		}
		const backingAreas: PlatformStorageArea[] = [
			"devicePlain",
			"deviceSecret",
			"sessionSecret",
		];
		const aliases = backingAreas.filter(
			(area) => this.storage(area) === storage,
		);
		if (aliases.length === 0) throw new PlatformStorageHostError();
		let page: KeysPage = {
			type: "keysPage",
			version: 1,
			family: "platformStorage",
			backingAreas: aliases as KeysPage["backingAreas"],
			keys: [],
			continuation: { type: "end" },
		};
		for (const [index, key] of keys.entries()) {
			if (page.keys.length === MAX_PAGE_KEYS) break;
			const candidate: KeysPage = {
				...page,
				keys: [...page.keys, key],
				continuation:
					index + 1 < keys.length
						? {
								type: "more",
								cursor: encodeCursor({
									version: 1,
									owner: this.inventoryOwner,
									area: request.area,
									prefix: request.prefix,
									after: key,
								}),
							}
						: { type: "end" },
			};
			if (
				encoder.encode(JSON.stringify(candidate)).byteLength > MAX_CONTROL_BYTES
			)
				break;
			page = candidate;
		}
		if (keys.length > 0 && page.keys.length === 0)
			throw new PlatformStorageHostError();
		return page;
	}

	private inventoryAfter(request: ListKeysRequest): string | null {
		if (request.cursor === null) return null;
		const bytes = Uint8Array.from(
			atob(request.cursor.replace(/-/g, "+").replace(/_/g, "/")),
			(character) => character.charCodeAt(0),
		);
		const value: unknown = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(bytes),
		);
		if (typeof value !== "object" || value === null || Array.isArray(value))
			throw new PlatformStorageHostError();
		const cursor = value as Record<string, unknown>;
		if (
			cursor.version !== 1 ||
			cursor.owner !== this.inventoryOwner ||
			cursor.area !== request.area ||
			cursor.prefix !== request.prefix ||
			typeof cursor.after !== "string" ||
			!cursor.after.startsWith(request.prefix) ||
			!isInventoryKey(cursor.after)
		)
			throw new PlatformStorageHostError();
		// Exact re-encoding rejects unknown/duplicate fields and noncanonical cursor encodings.
		if (
			encodeCursor({
				version: 1,
				owner: this.inventoryOwner,
				area: request.area,
				prefix: request.prefix,
				after: cursor.after,
			}) !== request.cursor
		)
			throw new PlatformStorageHostError();
		return cursor.after;
	}

	private storage(area: PlatformStorageArea): Storage {
		if (area === "sessionSecret") {
			return this.deps?.session ?? requireStorage(globalThis.sessionStorage);
		}
		return this.deps?.device ?? requireStorage(globalThis.localStorage);
	}
}

function encodeCursor(cursor: InventoryCursor): string {
	const encoded = btoa(
		Array.from(encoder.encode(JSON.stringify(cursor)), (byte) =>
			String.fromCharCode(byte),
		).join(""),
	)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
	if (encoded.length > MAX_CURSOR_BYTES) throw new PlatformStorageHostError();
	return encoded;
}

function compareUtf8(left: string, right: string): number {
	const leftBytes = encoder.encode(left);
	const rightBytes = encoder.encode(right);
	for (
		let index = 0;
		index < Math.min(leftBytes.length, rightBytes.length);
		index++
	) {
		const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return leftBytes.length - rightBytes.length;
}

function isInventoryKey(key: string): boolean {
	if (key.length === 0) return false;
	for (let index = 0; index < key.length; index += 1) {
		const unit = key.charCodeAt(index);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = key.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
			index += 1;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) {
			return false;
		}
	}
	return encoder.encode(key).byteLength <= MAX_KEY_BYTES;
}

class PlatformStorageHostError extends Error {
	readonly code = "platform-storage-failure";

	constructor() {
		super("Browser platform storage operation failed.");
		this.name = "PlatformStorageHostError";
	}
}

function parseRequest(requestJson: unknown): PlatformStorageRequest {
	if (typeof requestJson !== "string") {
		throw new Error("platform storage request must be a JSON string");
	}
	let value: unknown;
	try {
		value = JSON.parse(requestJson);
	} catch {
		throw new Error("platform storage request must be valid JSON");
	}
	if (!validatePlatformStorageRequest(value)) {
		throw new Error(
			"platform storage request does not match the generated contract",
		);
	}
	if (
		value.type === "listKeys" &&
		(encoder.encode(requestJson).byteLength > MAX_CONTROL_BYTES ||
			!isInventoryKey(value.prefix) ||
			(value.cursor !== null &&
				encoder.encode(value.cursor).byteLength > MAX_CURSOR_BYTES))
	) {
		throw new Error(
			"platform storage inventory request exceeds its control bound",
		);
	}
	return value;
}

function requireStorage(storage: Storage | undefined): Storage {
	if (storage === undefined) {
		throw new Error("browser platform storage is unavailable");
	}
	return storage;
}
