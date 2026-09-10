import { expect, test } from "bun:test";
import { validateTransferControlRequest } from "../generated/transfer-control/validator.js";
import { OpfsUploadSpoolRoot } from "./opfs-upload-spool-internal.ts";
import {
	type BinaryTransferFetch,
	ConfigurableWebBinaryTransferExecutor,
} from "./web-binary-transfer-executor-internal.ts";

const digest123 =
	"039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
const uploadScope = {
	accountId: "account-a",
	operationId: "operation-a",
	attachmentId: "attachment-a",
	artifactId: "artifact-a",
	generation: "generation-a",
};

const memorySpoolRoot = () => ({
	async withUploadFile(
		_scope: typeof uploadScope,
		expectedByteLength: number,
		_maximumChunkByteLength: number,
		chunks: AsyncIterable<Uint8Array>,
		consume: (file: File) => Promise<void>,
	) {
		const parts: ArrayBuffer[] = [];
		let actualByteLength = 0;
		for await (const chunk of chunks) {
			parts.push(chunk.slice().buffer);
			actualByteLength += chunk.byteLength;
		}
		if (actualByteLength !== expectedByteLength)
			throw new Error("wrong length");
		await consume(new File(parts, "opaque.ciphertext"));
	},
	async cleanup(_scope: typeof uploadScope) {},
	async deleteAccount(_accountId: string) {},
	async wipeDevice() {},
});

const control = async (
	executor: ConfigurableWebBinaryTransferExecutor,
	request: object,
	bytes?: Uint8Array,
) => {
	const result = await executor.invoke(JSON.stringify(request), bytes);
	return { ...result, response: JSON.parse(result.controlResponseJson) };
};

function hostileBinary(values: number[]) {
	const bytes = new Uint8Array(values);
	let getterCalls = 0;
	for (const key of [
		"buffer",
		"byteOffset",
		"byteLength",
		"length",
		Symbol.iterator,
		"custom",
	] as const) {
		Object.defineProperty(bytes, key, {
			configurable: true,
			get: () => {
				getterCalls += 1;
				throw new Error("hostile binary accessor");
			},
		});
	}
	return { bytes, getterCalls: () => getterCalls };
}

test("streams a bounded download through binary side channels", async () => {
	const fetch: BinaryTransferFetch = async () =>
		new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(Uint8Array.from([1, 2, 3, 4, 5]));
					controller.close();
				},
			}),
			{ status: 200, headers: { "content-length": "5" } },
		);
	const executor = new ConfigurableWebBinaryTransferExecutor({ fetch });

	expect(
		await executor.invoke(
			JSON.stringify({
				type: "openDownload",
				transferId: "download-1",
				url: "https://objects.example/source?secret=opaque",
				headers: [{ name: "x-signed-header", value: "signed" }],
				maxResponseBytes: "5",
				maxChunkBytes: 3,
			}),
		),
	).toEqual({ controlResponseJson: '{"type":"downloadOpened"}' });

	const first = await executor.invoke(
		JSON.stringify({ type: "readDownloadChunk", transferId: "download-1" }),
	);
	expect(JSON.parse(first.controlResponseJson)).toEqual({
		type: "downloadChunk",
		byteLength: 3,
		chunkSha256:
			"039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
	});
	expect(first.bytes).toBeInstanceOf(ArrayBuffer);
	if (first.bytes === undefined)
		throw new Error("download chunk bytes are missing");
	expect([...new Uint8Array(first.bytes)]).toEqual([1, 2, 3]);

	const second = await executor.invoke(
		JSON.stringify({ type: "readDownloadChunk", transferId: "download-1" }),
	);
	expect(JSON.parse(second.controlResponseJson)).toMatchObject({
		type: "downloadChunk",
		byteLength: 2,
	});
	expect(second.bytes).toBeInstanceOf(ArrayBuffer);
	if (second.bytes === undefined)
		throw new Error("download chunk bytes are missing");
	expect([...new Uint8Array(second.bytes)]).toEqual([4, 5]);
	expect(
		await executor.invoke(
			JSON.stringify({ type: "readDownloadChunk", transferId: "download-1" }),
		),
	).toEqual({ controlResponseJson: '{"type":"downloadFinished"}' });
});

test("foreground Attachment Upload uses the Account-scoped production PUT and Rust digest", async () => {
	let observedScope: typeof uploadScope | undefined;
	let observedRequest: Request | undefined;
	const executor = new ConfigurableWebBinaryTransferExecutor({
		spoolRoot: {
			...memorySpoolRoot(),
			async withUploadFile(scope, expected, maximum, chunks, consume) {
				observedScope = scope;
				await memorySpoolRoot().withUploadFile(
					scope,
					expected,
					maximum,
					chunks,
					consume,
				);
			},
		},
		fetch: async (request, init) => {
			observedRequest =
				request instanceof Request ? request : new Request(request, init);
			return new Response(null, { status: 204 });
		},
	});
	const transferId = executor.beginForegroundUpload(
		"account-a",
		"attachment-a",
		"https://objects.example/upload",
		3,
	);
	await executor.writeForegroundUpload(transferId, new Uint8Array([1, 2, 3]));
	expect(await executor.finishForegroundUpload(transferId, digest123)).toEqual({
		type: "uploaded",
		ciphertextSha256: digest123,
	});
	expect(observedScope?.accountId).toBe("account-a");
	expect(observedScope?.attachmentId).toBe("attachment-a");
	const request = observedRequest;
	if (request === undefined) throw new Error("foreground PUT was not observed");
	expect(request.headers.get("x-amz-content-sha256")).toBe(digest123);
	expect(Array.from(new Uint8Array(await request.arrayBuffer()))).toEqual([
		1, 2, 3,
	]);
});

test("foreground WASM boundary wipes hostile actual Uint8Array input without invoking accessors", async () => {
	const executor = new ConfigurableWebBinaryTransferExecutor({
		spoolRoot: memorySpoolRoot(),
		fetch: async () => new Response(null, { status: 204 }),
	});
	const transferId = executor.beginForegroundUpload(
		"account-a",
		"attachment-a",
		"https://objects.example/upload",
		3,
	);
	const hostile = hostileBinary([1, 2, 3]);
	await expect(
		executor.writeForegroundUpload(transferId, hostile.bytes),
	).rejects.toThrow("Binary transfer invocation failed");
	expect(hostile.getterCalls()).toBe(0);
	expect(Uint8Array.prototype.slice.call(hostile.bytes)).toEqual(
		new Uint8Array(3),
	);
	await executor.abortForegroundUpload(transferId);
});

test("foreground Attachment Upload reports malformed request construction before dispatch", async () => {
	let fetchCalls = 0;
	const executor = new ConfigurableWebBinaryTransferExecutor({
		spoolRoot: memorySpoolRoot(),
		fetch: async () => {
			fetchCalls += 1;
			return new Response(null, { status: 204 });
		},
	});
	const transferId = executor.beginForegroundUpload(
		"account-a",
		"attachment-a",
		"not a URL",
		3,
	);
	await executor.writeForegroundUpload(transferId, new Uint8Array([1, 2, 3]));
	expect(await executor.finishForegroundUpload(transferId, digest123)).toEqual({
		type: "notDispatched",
	});
	expect(fetchCalls).toBe(0);
});

test("foreground Attachment Upload reports an explicit object-store rejection", async () => {
	const executor = new ConfigurableWebBinaryTransferExecutor({
		spoolRoot: memorySpoolRoot(),
		fetch: async () => new Response(null, { status: 403 }),
	});
	const transferId = executor.beginForegroundUpload(
		"account-a",
		"attachment-a",
		"https://objects.example/upload",
		3,
	);
	await executor.writeForegroundUpload(transferId, new Uint8Array([1, 2, 3]));
	expect(await executor.finishForegroundUpload(transferId, digest123)).toEqual({
		type: "rejected",
		status: 403,
	});
});

test("foreground Attachment Upload never emits a rejected outcome for spoofed informational, successful, or out-of-range statuses", async () => {
	for (const status of [100, 204, 299, 600]) {
		const executor = new ConfigurableWebBinaryTransferExecutor({
			spoolRoot: memorySpoolRoot(),
			fetch: async () =>
				({ ok: false, status, body: null }) as unknown as Response,
		});
		const transferId = executor.beginForegroundUpload(
			"account-a",
			"attachment-a",
			"https://objects.example/upload",
			3,
		);
		await executor.writeForegroundUpload(transferId, new Uint8Array([1, 2, 3]));
		expect(
			await executor.finishForegroundUpload(transferId, digest123),
		).toEqual({ type: "ambiguous" });
	}
});

test("foreground Attachment Upload reports post-dispatch network and opaque responses as ambiguous", async () => {
	for (const fetch of [
		async () => {
			throw new TypeError("connection reset after PUT dispatch");
		},
		async () => Response.error(),
	] satisfies BinaryTransferFetch[]) {
		const executor = new ConfigurableWebBinaryTransferExecutor({
			spoolRoot: memorySpoolRoot(),
			fetch,
		});
		const transferId = executor.beginForegroundUpload(
			"account-a",
			"attachment-a",
			"https://objects.example/upload",
			3,
		);
		await executor.writeForegroundUpload(transferId, new Uint8Array([1, 2, 3]));
		expect(
			await executor.finishForegroundUpload(transferId, digest123),
		).toEqual({ type: "ambiguous" });
	}
});

test("foreground abort waits for spool cleanup and retries it without double cleanup", async () => {
	let cleanupCalls = 0;
	let releaseCleanup!: () => void;
	const cleanupHeld = new Promise<void>((resolve) => {
		releaseCleanup = resolve;
	});
	const spool = {
		...memorySpoolRoot(),
		async cleanup() {
			cleanupCalls += 1;
			if (cleanupCalls === 1) throw new Error("injected cleanup failure");
			await cleanupHeld;
		},
	};
	const executor = new ConfigurableWebBinaryTransferExecutor({
		spoolRoot: spool,
	});
	const transferId = executor.beginForegroundUpload(
		"account-a",
		"attachment-a",
		"https://objects.example/upload",
		3,
	);

	await expect(
		executor.abortForegroundUpload(transferId),
	).rejects.toBeDefined();
	let settled = false;
	const retry = executor.abortForegroundUpload(transferId).then(() => {
		settled = true;
	});
	while (cleanupCalls < 2)
		await new Promise((resolve) => setTimeout(resolve, 0));
	expect(cleanupCalls).toBe(2);
	expect(settled).toBe(false);
	releaseCleanup();
	await retry;
	await executor.abortForegroundUpload(transferId);
	expect(cleanupCalls).toBe(2);
});

test("foreground finish failure retains cleanup ownership until OPFS removal retries successfully", async () => {
	let cleanupCalls = 0;
	let releaseCleanup!: () => void;
	const cleanupHeld = new Promise<void>((resolve) => {
		releaseCleanup = resolve;
	});
	const executor = new ConfigurableWebBinaryTransferExecutor({
		spoolRoot: {
			...memorySpoolRoot(),
			async cleanup() {
				cleanupCalls += 1;
				if (cleanupCalls === 1)
					throw new Error("injected OPFS removal failure");
				await cleanupHeld;
			},
		},
		fetch: async (request) => {
			await (request as Request).arrayBuffer();
			throw new TypeError("connection reset after PUT");
		},
	});
	const transferId = executor.beginForegroundUpload(
		"account-a",
		"attachment-a",
		"https://objects.example/upload",
		3,
	);
	await executor.writeForegroundUpload(transferId, new Uint8Array([1, 2, 3]));
	expect(await executor.finishForegroundUpload(transferId, digest123)).toEqual({
		type: "ambiguous",
	});
	await expect(
		executor.abortForegroundUpload(transferId),
	).rejects.toBeDefined();
	let settled = false;
	const retry = executor.abortForegroundUpload(transferId).then(() => {
		settled = true;
	});
	while (cleanupCalls < 2)
		await new Promise((resolve) => setTimeout(resolve, 0));
	expect(settled).toBe(false);
	releaseCleanup();
	await retry;
	expect(cleanupCalls).toBe(2);
});

test("executor close waits for foreground upload and spool cleanup convergence", async () => {
	let releaseCleanup!: () => void;
	let cleanupCalls = 0;
	const cleanupHeld = new Promise<void>((resolve) => {
		releaseCleanup = resolve;
	});
	const executor = new ConfigurableWebBinaryTransferExecutor({
		spoolRoot: {
			...memorySpoolRoot(),
			async cleanup() {
				cleanupCalls += 1;
				await cleanupHeld;
			},
		},
	});
	executor.beginForegroundUpload(
		"account-a",
		"attachment-a",
		"https://objects.example/upload",
		3,
	);
	let closed = false;
	const closing = executor.close().then(() => {
		closed = true;
	});
	while (cleanupCalls < 1)
		await new Promise((resolve) => setTimeout(resolve, 0));
	expect(cleanupCalls).toBe(1);
	expect(closed).toBe(false);
	releaseCleanup();
	await closing;
	expect(closed).toBe(true);
});

test("preserves signed download headers and CORS request policy without returning credentials", async () => {
	let seen: Request | undefined;
	let seenPolicy: RequestInit | undefined;
	const secretUrl =
		"https://objects.example/source?X-Amz-Signature=NEVER_RETURN";
	const executor = new ConfigurableWebBinaryTransferExecutor({
		fetch: async (input, init) => {
			seen = input as Request;
			seenPolicy = init;
			return new Response(Uint8Array.from([1]), { status: 200 });
		},
	});
	const result = await control(executor, {
		type: "openDownload",
		transferId: "download-policy",
		url: secretUrl,
		headers: [
			{ name: "x-amz-checksum-sha256", value: "opaque" },
			{ name: "x-provider-header", value: "preserve-me" },
		],
		maxResponseBytes: "1",
		maxChunkBytes: 1,
	});
	expect(result.response).toEqual({ type: "downloadOpened" });
	expect(result.controlResponseJson).not.toContain("NEVER_RETURN");
	expect(seen?.mode).toBe("cors");
	expect(seenPolicy?.credentials).toBe("omit");
	expect(seenPolicy?.redirect).toBe("manual");
	expect(seen?.headers.get("x-provider-header")).toBe("preserve-me");
	executor.close();
});

test("rejects declared and streamed download overflow without releasing bytes", async () => {
	for (const response of [
		new Response(Uint8Array.from([1]), {
			status: 200,
			headers: { "content-length": "4" },
		}),
		new Response(Uint8Array.from([1, 2, 3, 4]), { status: 200 }),
	]) {
		const executor = new ConfigurableWebBinaryTransferExecutor({
			fetch: async () => response,
		});
		const opened = await control(executor, {
			type: "openDownload",
			transferId: "bounded",
			url: "https://objects.example/source",
			headers: [],
			maxResponseBytes: "3",
			maxChunkBytes: 3,
		});
		if (opened.response.type === "downloadOpened") {
			const read = await control(executor, {
				type: "readDownloadChunk",
				transferId: "bounded",
			});
			expect(read.response).toEqual({ type: "responseTooLarge" });
			expect(read.bytes).toBeUndefined();
		} else {
			expect(opened.response).toEqual({ type: "responseTooLarge" });
		}
	}
});

test("cancellation and executor termination abort held streams and fence reuse", async () => {
	let cancelled = 0;
	const fetch: BinaryTransferFetch = async () =>
		new Response(
			new ReadableStream<Uint8Array>({
				cancel() {
					cancelled += 1;
				},
			}),
			{ status: 200 },
		);
	const executor = new ConfigurableWebBinaryTransferExecutor({ fetch });
	await control(executor, {
		type: "openDownload",
		transferId: "held",
		url: "https://objects.example/held",
		headers: [],
		maxResponseBytes: "10",
		maxChunkBytes: 3,
	});
	expect(
		(await control(executor, { type: "cancelTransfer", transferId: "held" }))
			.response,
	).toEqual({ type: "cancelled" });
	await Promise.resolve();
	expect(cancelled).toBe(1);
	executor.close();
	expect(
		executor.invoke(
			JSON.stringify({ type: "readDownloadChunk", transferId: "held" }),
		),
	).rejects.toThrow("Binary transfer invocation failed");
});

test("a fire-and-forget generated cancel synchronously abandons a download before its first await", async () => {
	let cancelled = 0;
	const executor = new ConfigurableWebBinaryTransferExecutor({
		fetch: async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					cancel() {
						cancelled += 1;
					},
				}),
				{ status: 200 },
			),
	});
	const open = {
		type: "openDownload",
		transferId: "abandoned-download",
		url: "https://objects.example/held",
		headers: [],
		maxResponseBytes: "3",
		maxChunkBytes: 3,
	};
	await control(executor, open);

	const cancellation = executor.invoke(
		JSON.stringify({
			type: "cancelTransfer",
			transferId: "abandoned-download",
		}),
	);
	// A Rust Drop cannot await. Reuse before awaiting proves invoke synchronously reached #abort.
	expect((await control(executor, open)).response).toEqual({
		type: "downloadOpened",
	});
	expect(JSON.parse((await cancellation).controlResponseJson)).toEqual({
		type: "cancelled",
	});
	await Promise.resolve();
	expect(cancelled).toBe(1);
	executor.close();
});

test("generated cancel releases an unawaited held download open before replacement", async () => {
	let fetchCount = 0;
	let aborted = 0;
	const executor = new ConfigurableWebBinaryTransferExecutor({
		fetch: async (_input, init) => {
			fetchCount += 1;
			if (fetchCount === 1) {
				return new Promise<Response>((_resolve, reject) =>
					init?.signal?.addEventListener(
						"abort",
						() => {
							aborted += 1;
							reject(new DOMException("aborted", "AbortError"));
						},
						{ once: true },
					),
				);
			}
			return new Response(Uint8Array.from([7]), { status: 200 });
		},
	});
	const open = {
		type: "openDownload",
		transferId: "unawaited-download-open",
		url: "https://objects.example/held",
		headers: [],
		maxResponseBytes: "1",
		maxChunkBytes: 1,
	};
	const abandonedOpen = executor.invoke(JSON.stringify(open));
	const cancellation = executor.invoke(
		JSON.stringify({
			type: "cancelTransfer",
			transferId: "unawaited-download-open",
		}),
	);
	const replacementOpen = executor.invoke(JSON.stringify(open));
	expect(JSON.parse((await abandonedOpen).controlResponseJson)).toEqual({
		type: "cancelled",
	});
	expect(JSON.parse((await cancellation).controlResponseJson)).toEqual({
		type: "cancelled",
	});
	expect(JSON.parse((await replacementOpen).controlResponseJson)).toEqual({
		type: "downloadOpened",
	});
	expect(aborted).toBe(1);
	const replacementRead = await control(executor, {
		type: "readDownloadChunk",
		transferId: "unawaited-download-open",
	});
	expect(replacementRead.response).toMatchObject({
		type: "downloadChunk",
		byteLength: 1,
	});
	expect([
		...new Uint8Array(replacementRead.bytes ?? new ArrayBuffer(0)),
	]).toEqual([7]);
	executor.close();
});

test("an abandoned held read cannot delete a same-id replacement download", async () => {
	let settleOldRead:
		| ((value: ReadableStreamReadResult<Uint8Array>) => void)
		| undefined;
	let fetchCount = 0;
	const executor = new ConfigurableWebBinaryTransferExecutor({
		fetch: async () => {
			fetchCount += 1;
			if (fetchCount === 1) {
				return {
					ok: true,
					status: 200,
					headers: new Headers(),
					body: {
						getReader: () => ({
							read: () =>
								new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
									settleOldRead = resolve;
								}),
							cancel: async () => undefined,
						}),
						cancel: async () => undefined,
					},
				} as unknown as Response;
			}
			return new Response(Uint8Array.from([9]), { status: 200 });
		},
	});
	const open = {
		type: "openDownload",
		transferId: "replacement-download",
		url: "https://objects.example/held",
		headers: [],
		maxResponseBytes: "3",
		maxChunkBytes: 3,
	};
	await control(executor, open);
	const oldRead = control(executor, {
		type: "readDownloadChunk",
		transferId: "replacement-download",
	});
	await Promise.resolve();
	if (settleOldRead === undefined) throw new Error("old read did not start");
	const cancellation = executor.invoke(
		JSON.stringify({
			type: "cancelTransfer",
			transferId: "replacement-download",
		}),
	);
	expect((await control(executor, open)).response).toEqual({
		type: "downloadOpened",
	});
	settleOldRead({ done: true, value: undefined });
	expect((await oldRead).response).toEqual({ type: "cancelled" });
	expect(JSON.parse((await cancellation).controlResponseJson)).toEqual({
		type: "cancelled",
	});
	const replacementRead = await control(executor, {
		type: "readDownloadChunk",
		transferId: "replacement-download",
	});
	expect(replacementRead.response).toMatchObject({
		type: "downloadChunk",
		byteLength: 1,
	});
	expect([
		...new Uint8Array(replacementRead.bytes ?? new ArrayBuffer(0)),
	]).toEqual([9]);
	executor.close();
});

test("a fire-and-forget generated cancel abandons an upload after begin or one chunk", async () => {
	for (const writeOneChunk of [false, true]) {
		const transferId = writeOneChunk
			? "abandoned-after-chunk"
			: "abandoned-after-begin";
		const executor = new ConfigurableWebBinaryTransferExecutor({
			spoolRoot: memorySpoolRoot(),
			fetch: async () => new Response(null, { status: 204 }),
		});
		const begin = {
			type: "beginUpload",
			transferId,
			...uploadScope,
			url: "https://objects.example/upload?opaque=credential",
			headers: [
				{ name: "content-type", value: "application/octet-stream" },
				{ name: "x-amz-content-sha256", value: digest123 },
			],
			ciphertextSha256: digest123,
			byteLength: "3",
			maxChunkBytes: 3,
		};
		await control(executor, begin);
		if (writeOneChunk) {
			await control(
				executor,
				{
					type: "writeUploadChunk",
					transferId,
					byteLength: 3,
					chunkSha256: digest123,
				},
				Uint8Array.from([1, 2, 3]),
			);
		}

		const cancellation = executor.invoke(
			JSON.stringify({ type: "cancelTransfer", transferId }),
		);
		// This immediate reuse is the observable contract required by non-awaiting Rust Drop.
		expect((await control(executor, begin)).response).toEqual({
			type: "uploadBegun",
		});
		expect(JSON.parse((await cancellation).controlResponseJson)).toEqual({
			type: "cancelled",
		});
		expect(
			(await control(executor, { type: "cancelTransfer", transferId }))
				.response,
		).toEqual({ type: "cancelled" });
		executor.close();
	}
});

test("generated cancel releases an unawaited upload open before replacement", async () => {
	const executor = new ConfigurableWebBinaryTransferExecutor({
		spoolRoot: memorySpoolRoot(),
		fetch: async () => new Response(null, { status: 204 }),
	});
	const begin = {
		type: "beginUpload",
		transferId: "unawaited-upload-open",
		...uploadScope,
		url: "https://objects.example/upload?opaque=credential",
		headers: [
			{ name: "content-type", value: "application/octet-stream" },
			{ name: "x-amz-content-sha256", value: digest123 },
		],
		ciphertextSha256: digest123,
		byteLength: "3",
		maxChunkBytes: 3,
	};
	const abandonedOpen = executor.invoke(JSON.stringify(begin));
	const cancellation = executor.invoke(
		JSON.stringify({
			type: "cancelTransfer",
			transferId: "unawaited-upload-open",
		}),
	);
	const replacementOpen = executor.invoke(JSON.stringify(begin));
	expect(JSON.parse((await abandonedOpen).controlResponseJson)).toEqual({
		type: "uploadBegun",
	});
	expect(JSON.parse((await cancellation).controlResponseJson)).toEqual({
		type: "cancelled",
	});
	expect(JSON.parse((await replacementOpen).controlResponseJson)).toEqual({
		type: "uploadBegun",
	});
	expect(
		(
			await control(
				executor,
				{
					type: "writeUploadChunk",
					transferId: "unawaited-upload-open",
					byteLength: 3,
					chunkSha256: digest123,
				},
				Uint8Array.from([1, 2, 3]),
			)
		).response,
	).toEqual({ type: "uploadChunkAccepted" });
	expect(
		(
			await control(executor, {
				type: "finishUpload",
				transferId: "unawaited-upload-open",
			})
		).response,
	).toEqual({ type: "uploadFinished" });
	executor.close();
});

test("an abandoned held File PUT cannot delete a same-id replacement upload", async () => {
	let fetchCount = 0;
	const executor = new ConfigurableWebBinaryTransferExecutor({
		spoolRoot: memorySpoolRoot(),
		fetch: async (_input, init) => {
			fetchCount += 1;
			if (fetchCount === 1) {
				return new Promise<Response>((_resolve, reject) =>
					init?.signal?.addEventListener(
						"abort",
						() => reject(new DOMException("aborted", "AbortError")),
						{ once: true },
					),
				);
			}
			return new Response(null, { status: 204 });
		},
	});
	const begin = {
		type: "beginUpload",
		transferId: "replacement-upload",
		...uploadScope,
		url: "https://objects.example/upload?opaque=credential",
		headers: [
			{ name: "content-type", value: "application/octet-stream" },
			{ name: "x-amz-content-sha256", value: digest123 },
		],
		ciphertextSha256: digest123,
		byteLength: "3",
		maxChunkBytes: 3,
	};
	const chunk = {
		type: "writeUploadChunk",
		transferId: "replacement-upload",
		byteLength: 3,
		chunkSha256: digest123,
	};
	await control(executor, begin);
	await control(executor, chunk, Uint8Array.from([1, 2, 3]));
	const oldFinish = control(executor, {
		type: "finishUpload",
		transferId: "replacement-upload",
	});
	while (fetchCount === 0) await Promise.resolve();
	const cancellation = executor.invoke(
		JSON.stringify({
			type: "cancelTransfer",
			transferId: "replacement-upload",
		}),
	);
	expect((await control(executor, begin)).response).toEqual({
		type: "uploadBegun",
	});
	expect((await oldFinish).response).toEqual({ type: "cancelled" });
	expect(JSON.parse((await cancellation).controlResponseJson)).toEqual({
		type: "cancelled",
	});
	expect(
		(await control(executor, chunk, Uint8Array.from([1, 2, 3]))).response,
	).toEqual({
		type: "uploadChunkAccepted",
	});
	expect(
		(
			await control(executor, {
				type: "finishUpload",
				transferId: "replacement-upload",
			})
		).response,
	).toEqual({ type: "uploadFinished" });
	executor.close();
});

test("streams one hash-bound PUT with exact required headers and binary bytes", async () => {
	let seen: Request | undefined;
	let uploaded: number[] = [];
	const executor = new ConfigurableWebBinaryTransferExecutor({
		spoolRoot: memorySpoolRoot(),
		fetch: async (input) => {
			seen = input as Request;
			uploaded = [...new Uint8Array(await seen.arrayBuffer())];
			return new Response(null, { status: 200 });
		},
	});
	const headers = [
		{ name: "content-type", value: "application/octet-stream" },
		{ name: "x-amz-content-sha256", value: digest123 },
		{ name: "x-amz-security-token", value: "preserve-token" },
	];
	expect(
		(
			await control(executor, {
				type: "beginUpload",
				transferId: "upload",
				...uploadScope,
				url: "https://objects.example/upload?X-Amz-Signature=SECRET",
				headers,
				ciphertextSha256: digest123,
				byteLength: "3",
				maxChunkBytes: 3,
			})
		).response,
	).toEqual({ type: "uploadBegun" });
	expect(
		(
			await control(
				executor,
				{
					type: "writeUploadChunk",
					transferId: "upload",
					byteLength: 3,
					chunkSha256: digest123,
				},
				Uint8Array.from([1, 2, 3]),
			)
		).response,
	).toEqual({ type: "uploadChunkAccepted" });
	const finished = await control(executor, {
		type: "finishUpload",
		transferId: "upload",
	});
	expect(finished.response).toEqual({ type: "uploadFinished" });
	expect(finished.controlResponseJson).not.toContain("SECRET");
	expect(uploaded).toEqual([1, 2, 3]);
	expect(seen?.headers.get("content-length")).toBeNull();
	expect(seen?.headers.get("content-type")).toBe("application/octet-stream");
	expect(seen?.headers.get("x-amz-content-sha256")).toBe(digest123);
	expect(seen?.headers.get("x-amz-security-token")).toBe("preserve-token");
	expect(seen?.mode).toBe("cors");
});

test("rejects malformed upload headers and same-length chunk corruption before acceptance", async () => {
	let fetches = 0;
	const executor = new ConfigurableWebBinaryTransferExecutor({
		spoolRoot: memorySpoolRoot(),
		fetch: async () => {
			fetches += 1;
			return new Response(null, { status: 200 });
		},
	});
	await expect(
		control(executor, {
			type: "beginUpload",
			transferId: "bad-headers",
			...uploadScope,
			url: "https://objects.example/upload",
			headers: [
				{ name: "content-type", value: "text/plain" },
				{ name: "x-amz-content-sha256", value: digest123 },
			],
			ciphertextSha256: digest123,
			byteLength: "3",
			maxChunkBytes: 3,
		}),
	).rejects.toThrow("Binary transfer invocation failed");
	expect(fetches).toBe(0);
	await expect(
		control(executor, {
			type: "beginUpload",
			transferId: "forbidden-length",
			...uploadScope,
			url: "https://objects.example/upload",
			headers: [
				{ name: "content-length", value: "3" },
				{ name: "content-type", value: "application/octet-stream" },
				{ name: "x-amz-content-sha256", value: digest123 },
			],
			ciphertextSha256: digest123,
			byteLength: "3",
			maxChunkBytes: 3,
		}),
	).rejects.toThrow("Binary transfer invocation failed");
	expect(fetches).toBe(0);

	await control(executor, {
		type: "beginUpload",
		transferId: "bad-chunk",
		...uploadScope,
		url: "https://objects.example/upload",
		headers: [
			{ name: "content-type", value: "application/octet-stream" },
			{ name: "x-amz-content-sha256", value: digest123 },
		],
		ciphertextSha256: digest123,
		byteLength: "3",
		maxChunkBytes: 3,
	});
	await expect(
		control(
			executor,
			{
				type: "writeUploadChunk",
				transferId: "bad-chunk",
				byteLength: 3,
				chunkSha256: digest123,
			},
			Uint8Array.from([1, 2, 4]),
		),
	).rejects.toThrow("Binary transfer invocation failed");
});

test("classifies non-2xx and network failures as retryable closed transport results", async () => {
	for (const [fetch, expected] of [
		[
			async () => new Response(null, { status: 403 }),
			{ type: "httpFailure", status: 403 },
		],
		[
			async () => Promise.reject(new TypeError("credential expired")),
			{ type: "networkFailure" },
		],
		[
			async () => ({ ok: false, status: 0, body: null }) as unknown as Response,
			{ type: "httpFailure", status: 0 },
		],
	] as const) {
		const executor = new ConfigurableWebBinaryTransferExecutor({ fetch });
		const result = await control(executor, {
			type: "openDownload",
			transferId: "classification",
			url: "https://objects.example/source?credential=NEVER_LEAK",
			headers: [],
			maxResponseBytes: "3",
			maxChunkBytes: 3,
		});
		expect(result.response).toEqual(expected);
		expect(result.controlResponseJson).not.toContain("credential");
	}
});

test("classifies a provider rejection of different same-length upload bytes without treating the fake as enforcement proof", async () => {
	const mutatedDigest =
		"d4b29a968c40173638ded8d174c86957afa211be479cee020dba5dfe127d91ca";
	const executor = new ConfigurableWebBinaryTransferExecutor({
		spoolRoot: memorySpoolRoot(),
		fetch: async (input) => {
			const request = input as Request;
			const bytes = new Uint8Array(await request.arrayBuffer());
			// This records adapter classification only. Real provider hash binding remains the
			// deployment release gate recorded in Ticket 28.
			return new Response(null, {
				status:
					request.headers.get("x-amz-content-sha256") === digest123 &&
					bytes[2] === 3
						? 200
						: 403,
			});
		},
	});
	await control(executor, {
		type: "beginUpload",
		transferId: "provider-rejects",
		...uploadScope,
		url: "https://objects.example/hash-bound",
		headers: [
			{ name: "content-type", value: "application/octet-stream" },
			{ name: "x-amz-content-sha256", value: digest123 },
		],
		ciphertextSha256: digest123,
		byteLength: "3",
		maxChunkBytes: 3,
	});
	await control(
		executor,
		{
			type: "writeUploadChunk",
			transferId: "provider-rejects",
			byteLength: 3,
			chunkSha256: mutatedDigest,
		},
		Uint8Array.from([1, 2, 4]),
	);
	expect(
		(
			await control(executor, {
				type: "finishUpload",
				transferId: "provider-rejects",
			})
		).response,
	).toEqual({ type: "httpFailure", status: 403 });
});

test("classifies an upload network loss after the File PUT as retryable", async () => {
	const executor = new ConfigurableWebBinaryTransferExecutor({
		spoolRoot: memorySpoolRoot(),
		fetch: async (input) => {
			await (input as Request).arrayBuffer();
			throw new TypeError("connection reset");
		},
	});
	await control(executor, {
		type: "beginUpload",
		transferId: "upload-network",
		...uploadScope,
		url: "https://objects.example/upload",
		headers: [
			{ name: "content-type", value: "application/octet-stream" },
			{ name: "x-amz-content-sha256", value: digest123 },
		],
		ciphertextSha256: digest123,
		byteLength: "3",
		maxChunkBytes: 3,
	});
	await control(
		executor,
		{
			type: "writeUploadChunk",
			transferId: "upload-network",
			byteLength: 3,
			chunkSha256: digest123,
		},
		Uint8Array.from([1, 2, 3]),
	);
	expect(
		(
			await control(executor, {
				type: "finishUpload",
				transferId: "upload-network",
			})
		).response,
	).toEqual({ type: "networkFailure" });
});

test("termination aborts a held File PUT and a fresh executor can retry the same durable scope", async () => {
	let markStarted = () => {};
	const started = new Promise<void>((resolve) => {
		markStarted = resolve;
	});
	const first = new ConfigurableWebBinaryTransferExecutor({
		spoolRoot: memorySpoolRoot(),
		fetch: async (_input, init) => {
			markStarted();
			return new Promise<Response>((_resolve, reject) =>
				init?.signal?.addEventListener(
					"abort",
					() => reject(new DOMException("aborted", "AbortError")),
					{ once: true },
				),
			);
		},
	});
	const begin = {
		type: "beginUpload",
		transferId: "restartable",
		...uploadScope,
		url: "https://objects.example/upload",
		headers: [
			{ name: "content-type", value: "application/octet-stream" },
			{ name: "x-amz-content-sha256", value: digest123 },
		],
		ciphertextSha256: digest123,
		byteLength: "3",
		maxChunkBytes: 3,
	};
	await control(first, begin);
	await control(
		first,
		{
			type: "writeUploadChunk",
			transferId: "restartable",
			byteLength: 3,
			chunkSha256: digest123,
		},
		Uint8Array.from([1, 2, 3]),
	);
	const held = control(first, {
		type: "finishUpload",
		transferId: "restartable",
	});
	await started;
	first.close();
	expect((await held).response).toEqual({ type: "cancelled" });

	const restarted = new ConfigurableWebBinaryTransferExecutor({
		spoolRoot: memorySpoolRoot(),
		fetch: async () => new Response(null, { status: 204 }),
	});
	await control(restarted, begin);
	await control(
		restarted,
		{
			type: "writeUploadChunk",
			transferId: "restartable",
			byteLength: 3,
			chunkSha256: digest123,
		},
		Uint8Array.from([1, 2, 3]),
	);
	expect(
		(
			await control(restarted, {
				type: "finishUpload",
				transferId: "restartable",
			})
		).response,
	).toEqual({ type: "uploadFinished" });
});

test("generated control rejects ciphertext in JSON and out-of-bound chunk controls", () => {
	expect(
		validateTransferControlRequest({
			type: "writeUploadChunk",
			transferId: "upload",
			byteLength: 3,
			chunkSha256: digest123,
			bytes: "AQID",
		}),
	).toBe(false);
	expect(
		validateTransferControlRequest({
			type: "writeUploadChunk",
			transferId: "upload",
			byteLength: 262_145,
			chunkSha256: digest123,
		}),
	).toBe(false);
});

test("Rust fixture drives the real closed executor without ciphertext in control JSON", async () => {
	const fixture = await Bun.file(
		new URL("../generated/transfer-control/fixture.json", import.meta.url),
	).json();
	const executor = new ConfigurableWebBinaryTransferExecutor({
		spoolRoot: memorySpoolRoot(),
		fetch: async (input) =>
			(input as Request).method === "GET"
				? new Response(Uint8Array.from([1, 2, 3]), { status: 200 })
				: new Response(null, { status: 204 }),
	});
	for (const step of fixture.steps) {
		const bytes =
			step.request.type === "writeUploadChunk"
				? Uint8Array.from([1, 2, 3])
				: undefined;
		const result = await control(executor, step.request, bytes);
		expect(result.response).toEqual(step.response);
		expect(result.controlResponseJson).not.toContain("bytes");
	}
});

test("spools canonical chunks and lets the user agent own Content-Length for the File PUT", async () => {
	const scriptHeaderNames: string[] = [];
	let spoolCalls = 0;
	const executor = new ConfigurableWebBinaryTransferExecutor({
		spoolRoot: {
			...memorySpoolRoot(),
			async withUploadFile(
				_scope,
				expectedByteLength,
				_maximumChunkByteLength,
				chunks,
				consume,
			) {
				spoolCalls += 1;
				const parts: Uint8Array[] = [];
				for await (const chunk of chunks) parts.push(chunk);
				await consume(new File(parts, "opaque.ciphertext"));
				expect(expectedByteLength).toBe(3);
			},
		},
		fetch: async (input) => {
			scriptHeaderNames.push(...(input as Request).headers.keys());
			return new Response(null, { status: 204 });
		},
	});
	await control(executor, {
		type: "beginUpload",
		transferId: "opfs-file",
		accountId: "account-a",
		operationId: "operation-a",
		attachmentId: "attachment-a",
		artifactId: "artifact-a",
		generation: "generation-a",
		url: "https://objects.example/upload",
		headers: [
			{ name: "content-type", value: "application/octet-stream" },
			{ name: "x-amz-content-sha256", value: digest123 },
		],
		ciphertextSha256: digest123,
		byteLength: "3",
		maxChunkBytes: 3,
	});
	await control(
		executor,
		{
			type: "writeUploadChunk",
			transferId: "opfs-file",
			byteLength: 3,
			chunkSha256: digest123,
		},
		Uint8Array.from([1, 2, 3]),
	);
	expect(
		(await control(executor, { type: "finishUpload", transferId: "opfs-file" }))
			.response,
	).toEqual({ type: "uploadFinished" });
	expect(spoolCalls).toBe(1);
	expect(scriptHeaderNames.sort()).toEqual([
		"content-type",
		"x-amz-content-sha256",
	]);
});

test("deletes one named Account's ciphertext spool over the closed control seam", async () => {
	const deleted: string[] = [];
	let wipes = 0;
	const executor = new ConfigurableWebBinaryTransferExecutor({
		spoolRoot: {
			...memorySpoolRoot(),
			async deleteAccount(accountId: string) {
				deleted.push(accountId);
			},
			async wipeDevice() {
				wipes += 1;
			},
		},
	});

	expect(
		(await control(executor, { type: "deleteAccount", accountId: "account-a" }))
			.response,
	).toEqual({ type: "accountDeleted" });

	expect(deleted).toEqual(["account-a"]);
	expect(wipes).toBe(0);
});

test("wipes the whole Device ciphertext spool over the closed control seam", async () => {
	const deleted: string[] = [];
	let wipes = 0;
	const executor = new ConfigurableWebBinaryTransferExecutor({
		spoolRoot: {
			...memorySpoolRoot(),
			async deleteAccount(accountId: string) {
				deleted.push(accountId);
			},
			async wipeDevice() {
				wipes += 1;
			},
		},
	});

	expect((await control(executor, { type: "wipeDevice" })).response).toEqual({
		type: "deviceWiped",
	});

	expect(wipes).toBe(1);
	expect(deleted).toEqual([]);
});

test("reports a failed spool cleanup instead of answering that it converged", async () => {
	const executor = new ConfigurableWebBinaryTransferExecutor({
		spoolRoot: {
			...memorySpoolRoot(),
			async deleteAccount() {
				throw new Error("OPFS_QUOTA_DETAIL");
			},
			async wipeDevice() {
				throw new Error("OPFS_QUOTA_DETAIL");
			},
		},
	});

	await expect(
		control(executor, { type: "deleteAccount", accountId: "account-a" }),
	).rejects.toThrow("Binary transfer invocation failed");
	await expect(control(executor, { type: "wipeDevice" })).rejects.toThrow(
		"Binary transfer invocation failed",
	);
});

test("refuses a spool deletion that names no Account", async () => {
	let deletions = 0;
	const executor = new ConfigurableWebBinaryTransferExecutor({
		spoolRoot: {
			...memorySpoolRoot(),
			async deleteAccount() {
				deletions += 1;
			},
		},
	});

	await expect(
		control(executor, { type: "deleteAccount", accountId: "" }),
	).rejects.toThrow("Binary transfer invocation failed");
	expect(deletions).toBe(0);
});

test("re-opens the ciphertext spool after a transient failure so an identical retry converges", async () => {
	// The production path opens the spool root itself, so this test has to reach the static.
	// `open` is a writable property of the one class object both modules share, so replacing it
	// here is what the executor calls. The original goes back in `finally`.
	const originalOpen = OpfsUploadSpoolRoot.open;
	const deleted: string[] = [];
	let opens = 0;
	OpfsUploadSpoolRoot.open = (async () => {
		opens += 1;
		if (opens === 1) throw new Error("OPFS_TRANSIENT_DETAIL");
		return {
			...memorySpoolRoot(),
			async deleteAccount(accountId: string) {
				deleted.push(accountId);
			},
		};
	}) as typeof OpfsUploadSpoolRoot.open;

	try {
		const executor = new ConfigurableWebBinaryTransferExecutor();

		await expect(
			control(executor, { type: "deleteAccount", accountId: "account-a" }),
		).rejects.toThrow("Binary transfer invocation failed");

		expect(
			(
				await control(executor, {
					type: "deleteAccount",
					accountId: "account-a",
				})
			).response,
		).toEqual({ type: "accountDeleted" });
		expect(deleted).toEqual(["account-a"]);
		expect(opens).toBe(2);
	} finally {
		OpfsUploadSpoolRoot.open = originalOpen;
	}
});
