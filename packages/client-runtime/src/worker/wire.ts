import type { AttachmentUploadSourceAnswer } from "../../generated/transfer-control/contract";
import { validateAttachmentUploadSourceAnswer } from "../../generated/transfer-control/validator";
import {
	copyUint8ArrayIntrinsic,
	inspectUint8ArrayIntrinsic,
	isFullOwnedUint8Array,
	wipeBinaryIntrinsic,
} from "../binary-intrinsics";

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

export function isAttachmentUploadSourceWorkerRequest(value: unknown): boolean {
	if (!isRecord(value)) return false;
	return (
		exactOwnDataFields(value, [
			"controlRequestJson",
			"runtimeIncarnation",
			"type",
		]) &&
		value.type === "attachmentUploadSource" &&
		typeof value.runtimeIncarnation === "string" &&
		typeof value.controlRequestJson === "string"
	);
}

function wipeBinaryValue(value: unknown): void {
	wipeBinaryIntrinsic(value);
}

export function wipeAttachmentUploadSourceResponseBinary(value: unknown): void {
	if (!isRecord(value)) return;
	wipeBinaryValue(Object.getOwnPropertyDescriptor(value, "binaryChunk")?.value);
}

/** Wipe a binary reachable through a malformed wire envelope without invoking accessors. */
export function wipeWorkerEnvelopeBinary(value: unknown): void {
	if (!isRecord(value)) return;
	for (const field of ["payload", "value"] as const) {
		const nested = Object.getOwnPropertyDescriptor(value, field)?.value;
		wipeAttachmentUploadSourceResponseBinary(nested);
	}
}

function exactOwnDataFields(
	value: Record<string, unknown>,
	expected: string[],
): boolean {
	const keys = Reflect.ownKeys(value);
	if (
		keys.length !== expected.length ||
		keys.some((key) => typeof key !== "string") ||
		keys.map(String).sort().join("\0") !== expected.slice().sort().join("\0")
	)
		return false;
	return keys.every((key) => {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		return (
			descriptor?.enumerable === true &&
			descriptor.get === undefined &&
			descriptor.set === undefined
		);
	});
}

function ownDataValue(value: Record<string, unknown>, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	return descriptor?.get === undefined && descriptor?.set === undefined
		? descriptor?.value
		: undefined;
}

function attachmentUploadSourceAnswerType(
	value: unknown,
): AttachmentUploadSourceAnswer["type"] | undefined {
	if (typeof value !== "string") return undefined;
	try {
		const answer: unknown = JSON.parse(value);
		if (!validateAttachmentUploadSourceAnswer(answer)) return undefined;
		return answer.type;
	} catch {
		return undefined;
	}
}

function isBinaryAttachmentUploadSourceResponse(
	value: unknown,
): value is { controlResponseJson: string; binaryChunk: Uint8Array } {
	if (!isRecord(value)) return false;
	const binary = ownDataValue(value, "binaryChunk");
	if (inspectUint8ArrayIntrinsic(binary) === undefined) return false;
	return (
		exactOwnDataFields(value, ["controlResponseJson", "binaryChunk"]) &&
		typeof ownDataValue(value, "controlResponseJson") === "string"
	);
}

export function prepareHostResponseValueForPost(
	value: unknown,
	expectAttachmentUploadSource = false,
): PreparedWorkerValue {
	if (!expectAttachmentUploadSource)
		return { value: copyWorkerValue(value), transfer: [] };
	const binary = isRecord(value)
		? Object.getOwnPropertyDescriptor(value, "binaryChunk")?.value
		: undefined;
	const hasBinary = binary !== undefined;
	const exactShape =
		isRecord(value) &&
		exactOwnDataFields(
			value,
			hasBinary
				? ["binaryChunk", "controlResponseJson"]
				: ["controlResponseJson"],
		);
	const answer = isRecord(value)
		? attachmentUploadSourceAnswerType(
				Object.getOwnPropertyDescriptor(value, "controlResponseJson")?.value,
			)
		: undefined;
	if (
		!exactShape ||
		answer === undefined ||
		(answer === "chunk") !== hasBinary ||
		(hasBinary && !isBinaryAttachmentUploadSourceResponse(value))
	) {
		wipeAttachmentUploadSourceResponseBinary(value);
		throw new WorkerRpcError(
			"invalid-input",
			"Attachment Upload source returned an invalid answer and binary pairing.",
		);
	}
	if (!hasBinary) return { value: copyWorkerValue(value), transfer: [] };
	if (!isBinaryAttachmentUploadSourceResponse(value))
		throw new Error("unreachable");
	const source = value.binaryChunk;
	const view = inspectUint8ArrayIntrinsic(source);
	if (
		view === undefined ||
		!view.hasOnlyIndexedOwnData ||
		!isFullOwnedUint8Array(view)
	) {
		wipeBinaryIntrinsic(source);
		throw new WorkerRpcError(
			"invalid-input",
			"Attachment Upload plaintext requires a full owned ArrayBuffer view.",
		);
	}
	return { value, transfer: [view.arrayBuffer as ArrayBuffer] };
}

export function receiveHostResponseValue(
	value: unknown,
	expectAttachmentUploadSource = false,
): unknown {
	if (!expectAttachmentUploadSource) return copyWorkerValue(value);
	const binary = isRecord(value)
		? Object.getOwnPropertyDescriptor(value, "binaryChunk")?.value
		: undefined;
	const hasBinary = binary !== undefined;
	const exactShape =
		isRecord(value) &&
		exactOwnDataFields(
			value,
			hasBinary
				? ["binaryChunk", "controlResponseJson"]
				: ["controlResponseJson"],
		);
	const answer = isRecord(value)
		? attachmentUploadSourceAnswerType(
				Object.getOwnPropertyDescriptor(value, "controlResponseJson")?.value,
			)
		: undefined;
	if (
		!exactShape ||
		answer === undefined ||
		(answer === "chunk") !== hasBinary ||
		(hasBinary && !isBinaryAttachmentUploadSourceResponse(value))
	) {
		wipeAttachmentUploadSourceResponseBinary(value);
		throw new WorkerRpcError(
			"invalid-input",
			"Attachment Upload source returned an invalid answer and binary pairing.",
		);
	}
	if (!hasBinary) return copyWorkerValue(value);
	if (!isBinaryAttachmentUploadSourceResponse(value))
		throw new Error("unreachable");
	const source = value.binaryChunk;
	const view = inspectUint8ArrayIntrinsic(source);
	if (
		view === undefined ||
		!view.hasOnlyIndexedOwnData ||
		!isFullOwnedUint8Array(view)
	) {
		wipeBinaryIntrinsic(source);
		throw new WorkerRpcError(
			"invalid-input",
			"Attachment Upload plaintext requires transferred ownership.",
		);
	}
	return value;
}

function isBinaryAttachmentDownloadSinkRequest(value: unknown): value is {
	type: "attachmentDownloadSink";
	runtimeIncarnation: string;
	controlRequestJson: string;
	binaryChunk: Uint8Array;
} {
	if (!isRecord(value)) return false;
	const binary = ownDataValue(value, "binaryChunk");
	if (inspectUint8ArrayIntrinsic(binary) === undefined) return false;
	return (
		exactOwnDataFields(value, [
			"binaryChunk",
			"controlRequestJson",
			"runtimeIncarnation",
			"type",
		]) &&
		ownDataValue(value, "type") === "attachmentDownloadSink" &&
		typeof ownDataValue(value, "runtimeIncarnation") === "string" &&
		typeof ownDataValue(value, "controlRequestJson") === "string"
	);
}

/** Transfer ownership for the one audited plaintext reverse-RPC shape; copy everything else. */
export function prepareWorkerValueForPost(value: unknown): PreparedWorkerValue {
	if (!isBinaryAttachmentDownloadSinkRequest(value)) {
		if (
			isRecord(value) &&
			ownDataValue(value, "type") === "attachmentDownloadSink" &&
			Object.hasOwn(value, "binaryChunk")
		) {
			wipeAttachmentUploadSourceResponseBinary(value);
			throw new WorkerRpcError(
				"invalid-input",
				"Attachment Download plaintext requires an exact host-request shape.",
			);
		}
		try {
			return { value: copyWorkerValue(value), transfer: [] };
		} catch (error) {
			wipeAttachmentUploadSourceResponseBinary(value);
			throw error;
		}
	}
	const source = value.binaryChunk;
	const view = inspectUint8ArrayIntrinsic(source);
	if (
		view === undefined ||
		!view.hasOnlyIndexedOwnData ||
		!isFullOwnedUint8Array(view)
	) {
		wipeBinaryIntrinsic(source);
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
		transfer: [view.arrayBuffer as ArrayBuffer],
	};
}

/** Preserve transferred ownership for the audited plaintext shape; validate/copy all others. */
export function receiveWorkerValue(value: unknown): unknown {
	if (!isBinaryAttachmentDownloadSinkRequest(value)) {
		if (
			isRecord(value) &&
			ownDataValue(value, "type") === "attachmentDownloadSink" &&
			Object.hasOwn(value, "binaryChunk")
		) {
			wipeAttachmentUploadSourceResponseBinary(value);
			throw new WorkerRpcError(
				"invalid-input",
				"Attachment Download plaintext requires an exact host-request shape.",
			);
		}
		try {
			return copyWorkerValue(value);
		} catch (error) {
			wipeAttachmentUploadSourceResponseBinary(value);
			throw error;
		}
	}
	const source = value.binaryChunk;
	const view = inspectUint8ArrayIntrinsic(source);
	if (
		view === undefined ||
		!view.hasOnlyIndexedOwnData ||
		!isFullOwnedUint8Array(view)
	) {
		wipeBinaryIntrinsic(source);
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
	if (!isRecord(value)) return false;
	try {
		const type = ownDataValue(value, "type");
		if (type === "close") {
			return exactOwnDataFields(value, ["type", "id"]) && isRequestId(value.id);
		}
		if (type === "host-response") {
			const ok = ownDataValue(value, "ok");
			if (ok === true) {
				return (
					exactOwnDataFields(value, ["type", "id", "ok", "value"]) &&
					isRequestId(value.id)
				);
			}
			return (
				ok === false &&
				exactOwnDataFields(value, ["type", "id", "ok", "code", "message"]) &&
				isRequestId(value.id) &&
				typeof value.code === "string" &&
				typeof value.message === "string"
			);
		}
		if (type === "cancel") {
			return (
				exactOwnDataFields(value, ["type", "channel", "id"]) &&
				isWorkerChannelName(value.channel) &&
				isRequestId(value.id)
			);
		}
		return (
			type === "request" &&
			exactOwnDataFields(value, ["type", "channel", "id", "payload"]) &&
			isWorkerChannelName(value.channel) &&
			isRequestId(value.id)
		);
	} catch {
		return false;
	}
}

export function isWorkerReply(value: unknown): value is WorkerReply {
	if (!isRecord(value)) return false;
	try {
		const type = ownDataValue(value, "type");
		if (type === "host-request") {
			return (
				exactOwnDataFields(value, ["type", "id", "payload"]) &&
				isRequestId(value.id)
			);
		}
		if (type === "notification") {
			return (
				exactOwnDataFields(value, ["type", "channel", "value"]) &&
				isWorkerChannelName(value.channel)
			);
		}
		if (type !== "response" && type !== "close-ack") return false;
		const ok = ownDataValue(value, "ok");
		const common = type === "response" ? ["channel"] : [];
		if (ok === true) {
			const expected =
				type === "response"
					? ["type", "channel", "id", "ok", "value"]
					: ["type", "id", "ok"];
			return (
				exactOwnDataFields(value, expected) &&
				isRequestId(value.id) &&
				(common.length === 0 || isWorkerChannelName(value.channel))
			);
		}
		const expected =
			type === "response"
				? ["type", "channel", "id", "ok", "code", "message"]
				: ["type", "id", "ok", "code", "message"];
		return (
			ok === false &&
			exactOwnDataFields(value, expected) &&
			isRequestId(value.id) &&
			(common.length === 0 || isWorkerChannelName(value.channel)) &&
			typeof value.code === "string" &&
			typeof value.message === "string"
		);
	} catch {
		return false;
	}
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
	const byteView = inspectUint8ArrayIntrinsic(value);
	if (byteView !== undefined) {
		if (!byteView.hasOnlyIndexedOwnData) {
			wipeBinaryIntrinsic(value);
			throw new WorkerRpcError(
				"invalid-input",
				"Worker byte arrays may not carry custom own fields.",
			);
		}
		return copyUint8ArrayIntrinsic(byteView);
	}
	if (seen.has(value)) {
		throw new WorkerRpcError(
			"invalid-input",
			"Cyclic worker values are forbidden.",
		);
	}
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			if (Object.getPrototypeOf(value) !== Array.prototype) {
				throw new WorkerRpcError(
					"invalid-input",
					"The worker boundary accepts only ordinary arrays.",
				);
			}
			const descriptors = Object.getOwnPropertyDescriptors(value);
			const keys = Reflect.ownKeys(descriptors);
			if (
				keys.length !== value.length + 1 ||
				keys.some(
					(key) =>
						typeof key !== "string" ||
						(key !== "length" && !/^(0|[1-9]\d*)$/.test(key)),
				)
			) {
				throw new WorkerRpcError(
					"invalid-input",
					"Worker arrays must be dense and have no extra fields.",
				);
			}
			const copy: unknown[] = [];
			for (let index = 0; index < value.length; index += 1) {
				const descriptor = descriptors[String(index)];
				if (
					descriptor === undefined ||
					!descriptor.enumerable ||
					descriptor.get !== undefined ||
					descriptor.set !== undefined
				) {
					throw new WorkerRpcError(
						"invalid-input",
						"Worker arrays accept only enumerable data elements.",
					);
				}
				copy.push(copyWorkerValue(descriptor.value, seen));
			}
			return copy;
		}
		const prototype = Object.getPrototypeOf(value) as object | null;
		if (prototype !== Object.prototype) {
			wipeBinaryIntrinsic(value);
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
			if (
				!descriptor.enumerable ||
				descriptor.get !== undefined ||
				descriptor.set !== undefined
			) {
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
