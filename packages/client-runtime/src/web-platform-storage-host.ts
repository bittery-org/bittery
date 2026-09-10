import type {
	PlatformStorageArea,
	PlatformStorageRequest,
	PlatformStorageResponse,
} from "../generated/platform-storage/contract.ts";
import {
	validatePlatformStorageRequest,
	validatePlatformStorageResponse,
} from "../generated/platform-storage/validator.js";

export interface WebPlatformStorageHostDeps {
	device: Storage;
	session: Storage;
}

/** Executes Rust-authored primitive storage envelopes without interpreting their keys or values. */
export class WebPlatformStorageHost {
	constructor(private readonly deps?: WebPlatformStorageHostDeps) {}

	async invoke(requestJson: unknown): Promise<string> {
		const request = parseRequest(requestJson);
		let response: PlatformStorageResponse;
		try {
			const storage = this.storage(request.area);
			switch (request.type) {
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
				case "deletePrefix": {
					const keys: string[] = [];
					for (let index = 0; index < storage.length; index += 1) {
						const key = storage.key(index);
						if (key?.startsWith(request.prefix)) keys.push(key);
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
		return JSON.stringify(response);
	}

	private storage(area: PlatformStorageArea): Storage {
		if (area === "sessionSecret") {
			return this.deps?.session ?? requireStorage(globalThis.sessionStorage);
		}
		return this.deps?.device ?? requireStorage(globalThis.localStorage);
	}
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
	return value;
}

function requireStorage(storage: Storage | undefined): Storage {
	if (storage === undefined) {
		throw new Error("browser platform storage is unavailable");
	}
	return storage;
}
