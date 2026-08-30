import { describe, expect, test } from "bun:test";
import vm from "node:vm";
import {
	copyWorkerValue,
	isWorkerReply,
	isWorkerRequest,
	prepareWorkerValueForPost,
} from "./wire";

const workerRequests = [
	{ type: "request", channel: "runtime", id: 0, payload: { command: true } },
	{ type: "cancel", channel: "crypto", id: 1 },
	{ type: "close", id: 2 },
	{ type: "host-response", id: 3, ok: true, value: { answer: true } },
	{
		type: "host-response",
		id: 4,
		ok: false,
		code: "closed",
		message: "closed",
	},
] as const;

const workerReplies = [
	{ type: "host-request", id: 0, payload: { request: true } },
	{ type: "notification", channel: "runtime", value: { changed: true } },
	{
		type: "response",
		channel: "crypto",
		id: 1,
		ok: true,
		value: { answer: true },
	},
	{
		type: "response",
		channel: "runtime",
		id: 2,
		ok: false,
		code: "invalid-input",
		message: "invalid",
	},
	{ type: "close-ack", id: 3, ok: true },
	{
		type: "close-ack",
		id: 4,
		ok: false,
		code: "backend-failure",
		message: "failed",
	},
] as const;

function malformedShapes(valid: Record<string, unknown>): unknown[] {
	const accessor = { ...valid };
	Object.defineProperty(accessor, "type", {
		get: () => valid.type,
		enumerable: true,
	});
	const nonEnumerable = { ...valid };
	Object.defineProperty(nonEnumerable, "type", {
		value: valid.type,
		enumerable: false,
	});
	return [{ ...valid, extra: true }, accessor, nonEnumerable];
}

describe("worker wire envelopes", () => {
	test("binary brand validation does not traverse a hostile Proxy prototype", () => {
		const backing = new Uint8Array([9, 8, 7]);
		let prototypeTrapCalls = 0;
		const hostile = new Proxy(backing, {
			getPrototypeOf: () => {
				prototypeTrapCalls += 1;
				throw new Error("prototype trap must not run");
			},
		});

		expect(() =>
			prepareWorkerValueForPost({
				type: "attachmentDownloadSink",
				runtimeIncarnation: "runtime-one",
				controlRequestJson: '{"type":"write"}',
				binaryChunk: hostile,
			}),
		).toThrow("exact host-request shape");
		expect(prototypeTrapCalls).toBe(0);
	});

	test("accepts a cross-realm Uint8Array through captured internal-slot checks", () => {
		const foreign = vm.runInNewContext(
			"new Uint8Array([1, 2, 3])",
		) as Uint8Array;
		const prepared = prepareWorkerValueForPost({
			type: "attachmentDownloadSink",
			runtimeIncarnation: "runtime-one",
			controlRequestJson: '{"type":"write"}',
			binaryChunk: foreign,
		});
		expect(prepared.transfer).toHaveLength(1);
		expect(
			Uint8Array.prototype.slice.call(
				(prepared.value as { binaryChunk: Uint8Array }).binaryChunk,
			),
		).toEqual(new Uint8Array([1, 2, 3]));
	});
	test("wipes hostile binary objects without invoking their own accessors", () => {
		for (const binary of [
			new Uint8Array([1, 2, 3]),
			new ArrayBuffer(3),
			new DataView(new Uint8Array([1, 2, 3]).buffer),
		]) {
			if (binary instanceof ArrayBuffer) new Uint8Array(binary).set([1, 2, 3]);
			let getterCalls = 0;
			for (const key of ["buffer", "byteOffset", "byteLength", "length"])
				Object.defineProperty(binary, key, {
					configurable: true,
					get: () => {
						getterCalls += 1;
						throw new Error("hostile binary accessor");
					},
				});
			expect(() => copyWorkerValue(binary)).toThrow();
			expect(getterCalls).toBe(0);
			const backing =
				binary instanceof Uint8Array
					? Uint8Array.prototype.slice.call(binary)
					: binary instanceof ArrayBuffer
						? new Uint8Array(binary)
						: new Uint8Array(
								Object.getOwnPropertyDescriptor(
									DataView.prototype,
									"buffer",
								)?.get?.call(binary),
							);
			expect(backing).toEqual(new Uint8Array(3));
		}
	});

	test("accepts every exact WorkerRequest variant after structured clone", () => {
		for (const request of workerRequests) {
			expect(isWorkerRequest(structuredClone(request))).toBe(true);
		}
	});

	test("rejects extra, accessor, and non-enumerable WorkerRequest fields", () => {
		for (const request of workerRequests) {
			for (const malformed of malformedShapes({ ...request })) {
				expect(isWorkerRequest(malformed)).toBe(false);
			}
		}
	});

	test("accepts every exact WorkerReply variant after structured clone", () => {
		for (const reply of workerReplies) {
			expect(isWorkerReply(structuredClone(reply))).toBe(true);
		}
	});

	test("rejects extra, accessor, and non-enumerable WorkerReply fields", () => {
		for (const reply of workerReplies) {
			for (const malformed of malformedShapes({ ...reply })) {
				expect(isWorkerReply(malformed)).toBe(false);
			}
		}
	});
});
