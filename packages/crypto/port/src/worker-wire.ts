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
	| { type: "close"; id: number };

export type WorkerReply =
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
	if (!isWorkerChannelName(value.channel)) return false;
	if (value.type === "cancel") return true;
	return value.type === "request" && Object.hasOwn(value, "payload");
}

export function isWorkerReply(value: unknown): value is WorkerReply {
	if (!isRecord(value)) return false;
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
