export const WORKER_CHANNELS = ["crypto", "runtime"] as const;

export type WorkerChannelName = (typeof WORKER_CHANNELS)[number];

export type WorkerRequest =
	| {
			type: "request";
			channel: WorkerChannelName;
			id: number;
			payload: unknown;
	  }
	| { type: "cancel"; channel: WorkerChannelName; id: number }
	| { type: "close"; id: number }
	| {
			type: "host-response";
			id: number;
			ok: true;
			value: unknown;
	  }
	| {
			type: "host-response";
			id: number;
			ok: false;
			code: string;
			message: string;
	  };

export type WorkerReply =
	| { type: "host-request"; id: number; payload: unknown }
	| {
			type: "notification";
			channel: WorkerChannelName;
			value: unknown;
	  }
	| {
			type: "response";
			channel: WorkerChannelName;
			id: number;
			ok: true;
			value: unknown;
	  }
	| {
			type: "response";
			channel: WorkerChannelName;
			id: number;
			ok: false;
			code: string;
			message: string;
	  }
	| { type: "close-ack"; id: number; ok: true }
	| { type: "close-ack"; id: number; ok: false; code: string; message: string };

export class WorkerRpcError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "WorkerRpcError";
	}
}

type PreparedWorkerValue = { value: unknown; transfer: Transferable[] };

function isBinaryAttachmentDownloadSinkRequest(value: unknown): value is {
	type: "attachmentDownloadSink";
	runtimeIncarnation: string;
	controlRequestJson: string;
	binaryChunk: Uint8Array;
} {
	if (!isRecord(value)) return false;
	return (
		Object.keys(value).sort().join("\0") ===
			["binaryChunk", "controlRequestJson", "runtimeIncarnation", "type"]
				.sort()
				.join("\0") &&
		value.type === "attachmentDownloadSink" &&
		typeof value.runtimeIncarnation === "string" &&
		typeof value.controlRequestJson === "string" &&
		value.binaryChunk instanceof Uint8Array
	);
}

/** Transfer ownership for the one audited plaintext reverse-RPC shape; copy everything else. */
export function prepareWorkerValueForPost(value: unknown): PreparedWorkerValue {
	if (!isBinaryAttachmentDownloadSinkRequest(value)) {
		return { value: copyWorkerValue(value), transfer: [] };
	}
	const source = value.binaryChunk;
	if (!(source.buffer instanceof ArrayBuffer)) {
		try {
			new Uint8Array(source.buffer).fill(0);
		} catch {
			// Keep the rejection deterministic even if the backing store became unusable.
		}
		throw new WorkerRpcError(
			"invalid-input",
			"Attachment Download plaintext requires an owned ArrayBuffer.",
		);
	}
	return {
		value: {
			type: value.type,
			runtimeIncarnation: value.runtimeIncarnation,
			controlRequestJson: value.controlRequestJson,
			binaryChunk: source,
		},
		transfer: [source.buffer],
	};
}

/** Preserve transferred ownership for the audited plaintext shape; validate/copy all others. */
export function receiveWorkerValue(value: unknown): unknown {
	if (!isBinaryAttachmentDownloadSinkRequest(value))
		return copyWorkerValue(value);
	const source = value.binaryChunk;
	if (
		!(source.buffer instanceof ArrayBuffer) ||
		source.byteOffset !== 0 ||
		source.byteLength !== source.buffer.byteLength
	) {
		try {
			new Uint8Array(source.buffer).fill(0);
		} catch {
			// Keep the rejection deterministic even if the backing store became unusable.
		}
		throw new WorkerRpcError(
			"invalid-input",
			"Attachment Download plaintext requires a full owned ArrayBuffer view.",
		);
	}
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isRequestId(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isWorkerChannelName(
	value: unknown,
): value is WorkerChannelName {
	return WORKER_CHANNELS.some((channel) => channel === value);
}

export function isWorkerRequest(value: unknown): value is WorkerRequest {
	if (!isRecord(value) || !isRequestId(value.id)) return false;
	if (value.type === "close") return true;
	if (value.type === "host-response") {
		return (
			(value.ok === true && Object.hasOwn(value, "value")) ||
			(value.ok === false &&
				typeof value.code === "string" &&
				typeof value.message === "string")
		);
	}
	if (!isWorkerChannelName(value.channel)) return false;
	if (value.type === "cancel") return true;
	return value.type === "request" && Object.hasOwn(value, "payload");
}

export function isWorkerReply(value: unknown): value is WorkerReply {
	if (!isRecord(value)) return false;
	if (value.type === "host-request") {
		return isRequestId(value.id) && Object.hasOwn(value, "payload");
	}
	if (value.type === "notification") {
		return isWorkerChannelName(value.channel) && Object.hasOwn(value, "value");
	}
	if (!isRequestId(value.id)) return false;
	if (value.type === "close-ack") {
		return (
			value.ok === true ||
			(value.ok === false &&
				typeof value.code === "string" &&
				typeof value.message === "string")
		);
	}
	if (value.type !== "response" || !isWorkerChannelName(value.channel)) {
		return false;
	}
	return (
		(value.ok === true && Object.hasOwn(value, "value")) ||
		(value.ok === false &&
			typeof value.code === "string" &&
			typeof value.message === "string")
	);
}

/** Validate the deliberately small worker wire vocabulary and copy every byte buffer. */
export function copyWorkerValue(
	value: unknown,
	seen: Set<object> = new Set(),
): unknown {
	if (
		value === undefined ||
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean" ||
		typeof value === "bigint"
	) {
		return value;
	}
	if (typeof value !== "object") {
		throw new WorkerRpcError(
			"invalid-input",
			"The worker boundary accepts only plain data and byte arrays.",
		);
	}
	if (value instanceof Uint8Array) return new Uint8Array(value);
	if (seen.has(value)) {
		throw new WorkerRpcError(
			"invalid-input",
			"Cyclic worker values are forbidden.",
		);
	}
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			return value.map((member) => copyWorkerValue(member, seen));
		}
		const prototype = Object.getPrototypeOf(value) as object | null;
		if (prototype !== Object.prototype && prototype !== null) {
			throw new WorkerRpcError(
				"invalid-input",
				"The worker boundary accepts only plain data and byte arrays.",
			);
		}
		if (Object.getOwnPropertySymbols(value).length > 0) {
			throw new WorkerRpcError(
				"invalid-input",
				"Symbol properties are forbidden at the worker boundary.",
			);
		}
		const copy: Record<string, unknown> = {};
		for (const [name, descriptor] of Object.entries(
			Object.getOwnPropertyDescriptors(value),
		)) {
			if (descriptor.get !== undefined || descriptor.set !== undefined) {
				throw new WorkerRpcError(
					"invalid-input",
					"Accessor properties are forbidden at the worker boundary.",
				);
			}
			copy[name] = copyWorkerValue(descriptor.value, seen);
		}
		return copy;
	} finally {
		seen.delete(value);
	}
}
