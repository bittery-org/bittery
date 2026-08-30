import type {
	ForegroundUploadOutcome,
	TransferControlRequest,
	TransferControlResponse,
} from "../generated/transfer-control/contract";
import {
	validateTransferControlRequest,
	validateTransferControlResponse,
} from "../generated/transfer-control/validator.js";
import {
	copyUint8ArrayIntrinsic,
	inspectUint8ArrayIntrinsic,
	wipeBinaryIntrinsic,
} from "./binary-intrinsics";
import { OpfsUploadSpoolRoot } from "./opfs-upload-spool-internal";

export type BinaryTransferFetch = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

/**
 * The spool operations this executor drives. Teardown lives here, not beside the upload path,
 * because this executor is the one production owner of the OPFS spool root.
 */
type UploadSpool = Pick<
	OpfsUploadSpoolRoot,
	"withUploadFile" | "cleanup" | "deleteAccount" | "wipeDevice"
>;

export interface WebBinaryTransferExecutorOptions {
	readonly fetch?: BinaryTransferFetch;
	readonly spoolRoot?: UploadSpool;
}

interface DownloadSession {
	readonly controller: AbortController;
	reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	readonly maxChunkBytes: number;
	readonly maxResponseBytes: bigint;
	receivedBytes: bigint;
	pending: Uint8Array | undefined;
}

interface UploadSession {
	readonly controller: AbortController;
	readonly chunks: UploadChunkQueue;
	readonly result: Promise<TransferControlResponse>;
	readonly maxChunkBytes: number;
	readonly expectedBytes: bigint;
	writtenBytes: bigint;
}

export type { ForegroundUploadOutcome } from "../generated/transfer-control/contract";

interface ForegroundUploadSession {
	readonly controller: AbortController;
	readonly chunks: UploadChunkQueue;
	readonly result: Promise<UploadAttemptOutcome>;
	readonly maxChunkBytes: number;
	readonly expectedBytes: bigint;
	writtenBytes: bigint;
	readonly request: Extract<TransferControlRequest, { type: "beginUpload" }>;
	abortTask?: Promise<void>;
}

type UploadAttemptOutcome =
	| { readonly type: "uploaded" }
	| { readonly type: "notDispatched" }
	| { readonly type: "rejected"; readonly status: number }
	| { readonly type: "ambiguous" }
	| { readonly type: "cancelled" };

export interface BinaryTransferInvocationResult {
	readonly controlResponseJson: string;
	readonly bytes?: ArrayBuffer;
}

export class ConfigurableWebBinaryTransferExecutor {
	readonly #fetch: BinaryTransferFetch;
	#spoolRoot: Promise<UploadSpool> | undefined;
	readonly #downloads = new Map<string, DownloadSession>();
	readonly #uploads = new Map<string, UploadSession>();
	readonly #foregroundUploads = new Map<string, ForegroundUploadSession>();
	#closed = false;

	constructor(options: WebBinaryTransferExecutorOptions = {}) {
		this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
		this.#spoolRoot =
			options.spoolRoot === undefined
				? undefined
				: Promise.resolve(options.spoolRoot);
	}

	beginForegroundUpload(
		accountId: string,
		attachmentId: string,
		url: string,
		expectedByteLength: number,
	): string {
		if (
			this.#closed ||
			!/^[A-Za-z0-9._~-]{1,128}$/.test(accountId) ||
			!/^[A-Za-z0-9._~-]{1,128}$/.test(attachmentId) ||
			!Number.isSafeInteger(expectedByteLength) ||
			expectedByteLength <= 0
		)
			throw new BinaryTransferInvocationError();
		const transferId = `foreground-${globalThis.crypto.randomUUID()}`;
		const controller = new AbortController();
		const chunks = new UploadChunkQueue();
		const request = {
			type: "beginUpload" as const,
			transferId,
			accountId,
			operationId: transferId,
			attachmentId,
			artifactId: transferId,
			generation: "1",
			url,
			headers: [
				{ name: "content-type", value: "application/octet-stream" },
				{ name: "x-amz-content-sha256", value: "0".repeat(64) },
			],
			ciphertextSha256: "0".repeat(64),
			byteLength: String(expectedByteLength),
			maxChunkBytes: 262_144,
		};
		const result = this.#runUpload(
			request,
			expectedByteLength,
			controller,
			chunks,
		);
		void result.catch((error) => chunks.fail(error));
		this.#foregroundUploads.set(transferId, {
			controller,
			chunks,
			result,
			request,
			maxChunkBytes: 262_144,
			expectedBytes: BigInt(expectedByteLength),
			writtenBytes: 0n,
		});
		return transferId;
	}

	async writeForegroundUpload(
		transferId: string,
		bytes: Uint8Array,
	): Promise<void> {
		const session = this.#foregroundUploads.get(transferId);
		const view = inspectUint8ArrayIntrinsic(bytes);
		if (
			session === undefined ||
			view === undefined ||
			!view.hasOnlyIndexedOwnData ||
			view.byteLength === 0 ||
			view.byteLength > session.maxChunkBytes ||
			session.writtenBytes + BigInt(view.byteLength) > session.expectedBytes
		) {
			wipeBinaryIntrinsic(bytes);
			throw new BinaryTransferInvocationError();
		}
		session.writtenBytes += BigInt(view.byteLength);
		await session.chunks.push(copyUint8ArrayIntrinsic(view));
	}

	async finishForegroundUpload(
		transferId: string,
		ciphertextSha256: string,
	): Promise<ForegroundUploadOutcome> {
		const session = this.#foregroundUploads.get(transferId);
		if (
			session === undefined ||
			session.writtenBytes !== session.expectedBytes ||
			!/^[0-9a-f]{64}$/.test(ciphertextSha256)
		)
			throw new BinaryTransferInvocationError();
		session.request.ciphertextSha256 = ciphertextSha256;
		session.request.headers = session.request.headers.map((header) =>
			header.name === "x-amz-content-sha256"
				? { ...header, value: ciphertextSha256 }
				: header,
		);
		session.chunks.close();
		const result = await session.result;
		if (
			result.type === "uploaded" &&
			this.#foregroundUploads.get(transferId) === session
		)
			this.#foregroundUploads.delete(transferId);
		return result.type === "uploaded"
			? { type: "uploaded", ciphertextSha256 }
			: result;
	}

	async abortForegroundUpload(transferId: string): Promise<void> {
		const session = this.#foregroundUploads.get(transferId);
		if (session === undefined) return;
		if (session.abortTask === undefined) {
			session.controller.abort();
			session.chunks.fail(new BinaryTransferInvocationError());
			session.abortTask = (async () => {
				await session.result.catch(() => undefined);
				await this.#cleanSpool((spool) =>
					spool.cleanup({
						accountId: session.request.accountId,
						operationId: session.request.operationId,
						attachmentId: session.request.attachmentId,
						artifactId: session.request.artifactId,
						generation: session.request.generation,
					}),
				);
				if (this.#foregroundUploads.get(transferId) === session)
					this.#foregroundUploads.delete(transferId);
			})();
		}
		try {
			await session.abortTask;
		} catch (error) {
			session.abortTask = undefined;
			throw error;
		}
	}

	async invoke(
		controlRequestJson: string,
		binaryChunk?: Uint8Array,
	): Promise<BinaryTransferInvocationResult> {
		if (this.#closed) throw new BinaryTransferInvocationError();
		const request = parseRequest(controlRequestJson);
		let response: TransferControlResponse;
		let bytes: ArrayBuffer | undefined;
		switch (request.type) {
			case "openDownload":
				response = await this.#openDownload(request);
				break;
			case "readDownloadChunk": {
				const result = await this.#readDownloadChunk(request.transferId);
				response = result.response;
				bytes = result.bytes;
				break;
			}
			case "beginUpload":
				response = this.#beginUpload(request);
				break;
			case "writeUploadChunk":
				response = await this.#writeUploadChunk(request, binaryChunk);
				break;
			case "finishUpload":
				response = await this.#finishUpload(request.transferId);
				break;
			case "cancelTransfer":
				await this.#cancel(request.transferId);
				response = { type: "cancelled" };
				break;
			case "deleteAccount":
				await this.#cleanSpool((spool) =>
					spool.deleteAccount(request.accountId),
				);
				response = { type: "accountDeleted" };
				break;
			case "wipeDevice":
				await this.#cleanSpool((spool) => spool.wipeDevice());
				response = { type: "deviceWiped" };
				break;
		}
		return {
			controlResponseJson: serialize(response),
			...(bytes === undefined ? {} : { bytes }),
		};
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		const activeUploads = [...this.#uploads.values()];
		for (const transferId of [
			...this.#downloads.keys(),
			...this.#uploads.keys(),
		]) {
			this.#abort(transferId);
		}
		await Promise.all([
			...activeUploads.map((upload) => upload.result.catch(() => undefined)),
			...[...this.#foregroundUploads.keys()].map((transferId) =>
				this.abortForegroundUpload(transferId),
			),
		]);
	}

	async #openDownload(
		request: Extract<TransferControlRequest, { type: "openDownload" }>,
	): Promise<TransferControlResponse> {
		this.#assertUnused(request.transferId);
		const maxResponseBytes = decimal(request.maxResponseBytes);
		const controller = new AbortController();
		const session: DownloadSession = {
			controller,
			reader: undefined,
			maxChunkBytes: request.maxChunkBytes,
			maxResponseBytes,
			receivedBytes: 0n,
			pending: undefined,
		};
		const fetchPolicy: RequestInit = {
			signal: controller.signal,
			mode: "cors",
			credentials: "omit",
			redirect: "manual",
			cache: "no-store",
			referrerPolicy: "no-referrer",
		};
		let browserRequest: Request;
		try {
			browserRequest = new Request(request.url, {
				method: "GET",
				headers: headerEntries(request.headers),
				...fetchPolicy,
			});
			assertHeadersPreserved(request.headers, browserRequest.headers);
		} catch {
			throw new BinaryTransferInvocationError();
		}
		this.#downloads.set(request.transferId, session);
		let response: Response;
		try {
			response = await this.#fetch(browserRequest, fetchPolicy);
		} catch {
			this.#deleteDownload(request.transferId, session);
			return controller.signal.aborted
				? { type: "cancelled" }
				: { type: "networkFailure" };
		}
		if (!response.ok) {
			await response.body?.cancel().catch(() => undefined);
			this.#deleteDownload(request.transferId, session);
			return { type: "httpFailure", status: response.status };
		}
		const contentLength = response.headers.get("content-length");
		let declaredTooLarge: boolean;
		try {
			declaredTooLarge =
				contentLength !== null && decimal(contentLength) > maxResponseBytes;
		} catch {
			await response.body?.cancel().catch(() => undefined);
			this.#deleteDownload(request.transferId, session);
			throw new BinaryTransferInvocationError();
		}
		if (declaredTooLarge) {
			await response.body?.cancel().catch(() => undefined);
			this.#deleteDownload(request.transferId, session);
			return { type: "responseTooLarge" };
		}
		if (this.#downloads.get(request.transferId) !== session) {
			await response.body?.cancel().catch(() => undefined);
			return { type: "cancelled" };
		}
		try {
			session.reader = response.body?.getReader();
		} catch {
			this.#deleteDownload(request.transferId, session);
			throw new BinaryTransferInvocationError();
		}
		return { type: "downloadOpened" };
	}

	async #readDownloadChunk(transferId: string): Promise<{
		response: TransferControlResponse;
		bytes?: ArrayBuffer;
	}> {
		const session = this.#downloads.get(transferId);
		if (session === undefined) throw new BinaryTransferInvocationError();
		if (session.controller.signal.aborted) {
			this.#deleteDownload(transferId, session);
			return { response: { type: "cancelled" } };
		}
		try {
			while (session.pending === undefined) {
				if (session.reader === undefined) {
					this.#deleteDownload(transferId, session);
					return { response: { type: "downloadFinished" } };
				}
				const next = await session.reader.read();
				if (this.#downloads.get(transferId) !== session) {
					return { response: { type: "cancelled" } };
				}
				if (next.done) {
					this.#deleteDownload(transferId, session);
					return { response: { type: "downloadFinished" } };
				}
				if (next.value.byteLength === 0) continue;
				const received = session.receivedBytes + BigInt(next.value.byteLength);
				if (received > session.maxResponseBytes) {
					await session.reader.cancel().catch(() => undefined);
					this.#deleteDownload(transferId, session);
					return { response: { type: "responseTooLarge" } };
				}
				session.receivedBytes = received;
				session.pending = next.value;
			}
			const chunk = session.pending.subarray(0, session.maxChunkBytes);
			session.pending =
				chunk.byteLength === session.pending.byteLength
					? undefined
					: session.pending.subarray(chunk.byteLength);
			const owned = Uint8Array.from(chunk);
			const chunkSha256 = await sha256(owned);
			if (this.#downloads.get(transferId) !== session) {
				return { response: { type: "cancelled" } };
			}
			return {
				response: {
					type: "downloadChunk",
					byteLength: owned.byteLength,
					chunkSha256,
				},
				bytes: owned.buffer,
			};
		} catch {
			this.#deleteDownload(transferId, session);
			return {
				response: session.controller.signal.aborted
					? { type: "cancelled" }
					: { type: "networkFailure" },
			};
		}
	}

	#beginUpload(
		request: Extract<TransferControlRequest, { type: "beginUpload" }>,
	): TransferControlResponse {
		this.#assertUnused(request.transferId);
		const expectedBytes = decimal(request.byteLength);
		const expectedByteLength = safeNumber(expectedBytes);
		assertUploadHeaders(request.headers, request.ciphertextSha256);
		const controller = new AbortController();
		const chunks = new UploadChunkQueue();
		const result = this.#runUpload(
			request,
			expectedByteLength,
			controller,
			chunks,
		).then((outcome): TransferControlResponse => {
			switch (outcome.type) {
				case "uploaded":
					return { type: "uploadFinished" };
				case "rejected":
					return { type: "httpFailure", status: outcome.status };
				case "ambiguous":
					return { type: "networkFailure" };
				case "cancelled":
					return { type: "cancelled" };
				case "notDispatched":
					throw new BinaryTransferInvocationError();
			}
		});
		void result.catch((error) => chunks.fail(error));
		this.#uploads.set(request.transferId, {
			controller,
			chunks,
			result,
			maxChunkBytes: request.maxChunkBytes,
			expectedBytes,
			writtenBytes: 0n,
		});
		return { type: "uploadBegun" };
	}

	async #writeUploadChunk(
		request: Extract<TransferControlRequest, { type: "writeUploadChunk" }>,
		bytes: Uint8Array | undefined,
	): Promise<TransferControlResponse> {
		const session = this.#uploads.get(request.transferId);
		if (session === undefined || !(bytes instanceof Uint8Array))
			throw new BinaryTransferInvocationError();
		if (
			bytes.byteLength !== request.byteLength ||
			bytes.byteLength === 0 ||
			bytes.byteLength > session.maxChunkBytes
		) {
			this.#abort(request.transferId, session);
			throw new BinaryTransferInvocationError();
		}
		const chunkSha256 = await sha256(bytes);
		if (this.#uploads.get(request.transferId) !== session) {
			return { type: "cancelled" };
		}
		if (chunkSha256 !== request.chunkSha256) {
			this.#abort(request.transferId, session);
			throw new BinaryTransferInvocationError();
		}
		const total = session.writtenBytes + BigInt(bytes.byteLength);
		if (total > session.expectedBytes) {
			this.#abort(request.transferId, session);
			throw new BinaryTransferInvocationError();
		}
		session.writtenBytes = total;
		try {
			await session.chunks.push(Uint8Array.from(bytes));
		} catch (error) {
			if (this.#uploads.get(request.transferId) !== session)
				return { type: "cancelled" };
			throw error;
		}
		if (this.#uploads.get(request.transferId) !== session)
			return { type: "cancelled" };
		return { type: "uploadChunkAccepted" };
	}

	async #finishUpload(transferId: string): Promise<TransferControlResponse> {
		const session = this.#uploads.get(transferId);
		if (session === undefined) throw new BinaryTransferInvocationError();
		if (session.writtenBytes !== session.expectedBytes) {
			this.#abort(transferId);
			throw new BinaryTransferInvocationError();
		}
		session.chunks.close();
		try {
			const response = await session.result;
			this.#deleteUpload(transferId, session);
			return response;
		} catch {
			this.#deleteUpload(transferId, session);
			if (session.controller.signal.aborted) return { type: "cancelled" };
			throw new BinaryTransferInvocationError();
		}
	}

	async #runUpload(
		request: Extract<TransferControlRequest, { type: "beginUpload" }>,
		expectedByteLength: number,
		controller: AbortController,
		chunks: UploadChunkQueue,
	): Promise<UploadAttemptOutcome> {
		let dispatchStarted = false;
		let result: UploadAttemptOutcome | undefined;
		try {
			const spoolRoot = await this.#spool();
			await spoolRoot.withUploadFile(
				{
					accountId: request.accountId,
					operationId: request.operationId,
					attachmentId: request.attachmentId,
					artifactId: request.artifactId,
					generation: request.generation,
				},
				expectedByteLength,
				request.maxChunkBytes,
				chunks,
				async (file) => {
					const fetchPolicy: RequestInit = {
						signal: controller.signal,
						mode: "cors",
						credentials: "omit",
						redirect: "manual",
						cache: "no-store",
						referrerPolicy: "no-referrer",
					};
					let browserRequest: Request;
					try {
						browserRequest = new Request(request.url, {
							method: "PUT",
							headers: headerEntries(request.headers),
							body: file,
							...fetchPolicy,
						});
						assertHeadersPreserved(request.headers, browserRequest.headers);
						if (browserRequest.headers.has("content-length"))
							throw new BinaryTransferInvocationError();
					} catch {
						throw new BinaryTransferInvocationError();
					}
					let response: Response;
					try {
						dispatchStarted = true;
						response = await this.#fetch(browserRequest, fetchPolicy);
					} catch {
						result = controller.signal.aborted
							? { type: "cancelled" }
							: { type: "ambiguous" };
						return;
					}
					await response.body?.cancel().catch(() => undefined);
					if (response.ok) result = { type: "uploaded" };
					else if (response.status === 0) result = { type: "ambiguous" };
					else if (
						Number.isInteger(response.status) &&
						response.status >= 300 &&
						response.status <= 599
					)
						result = { type: "rejected", status: response.status };
					else throw new BinaryTransferInvocationError();
				},
			);
			if (result === undefined) throw new BinaryTransferInvocationError();
			return result;
		} catch {
			if (controller.signal.aborted) return { type: "cancelled" };
			if (result?.type === "rejected") return result;
			return dispatchStarted
				? { type: "ambiguous" }
				: { type: "notDispatched" };
		}
	}

	// One lazily opened root per executor. Teardown opens it too: a Device that never uploaded
	// still has a spool directory from an earlier incarnation to destroy.
	//
	// A failed open is forgotten rather than cached. Caching it would make one transient failure
	// permanent for this executor: every later retry would re-await the same rejection, so a
	// teardown could never converge until the worker restarted.
	#spool(): Promise<UploadSpool> {
		if (this.#spoolRoot === undefined) {
			const opening = OpfsUploadSpoolRoot.open();
			this.#spoolRoot = opening;
			opening.catch(() => {
				if (this.#spoolRoot === opening) this.#spoolRoot = undefined;
			});
		}
		return this.#spoolRoot;
	}

	/**
	 * Destruction answers `accountDeleted` or `deviceWiped` only after it converged. Anything
	 * else becomes the opaque invocation error, so the Runtime records the failed phase and no
	 * storage detail escapes.
	 */
	async #cleanSpool(
		destroy: (spool: UploadSpool) => Promise<void>,
	): Promise<void> {
		try {
			await destroy(await this.#spool());
		} catch {
			throw new BinaryTransferInvocationError();
		}
	}

	#assertUnused(transferId: string): void {
		if (this.#downloads.has(transferId) || this.#uploads.has(transferId)) {
			throw new BinaryTransferInvocationError();
		}
	}

	async #cancel(transferId: string): Promise<void> {
		const upload = this.#uploads.get(transferId);
		this.#abort(transferId);
		await upload?.result.catch(() => undefined);
	}

	#abort(transferId: string, expectedUpload?: UploadSession): void {
		const download = this.#downloads.get(transferId);
		if (download !== undefined && expectedUpload === undefined) {
			this.#deleteDownload(transferId, download);
			download.controller.abort();
			void download.reader?.cancel().catch(() => undefined);
		}
		const upload = this.#uploads.get(transferId);
		if (
			upload !== undefined &&
			(expectedUpload === undefined || upload === expectedUpload)
		) {
			this.#deleteUpload(transferId, upload);
			upload.controller.abort();
			upload.chunks.fail(new BinaryTransferInvocationError());
		}
	}

	#deleteDownload(transferId: string, session: DownloadSession): void {
		if (this.#downloads.get(transferId) === session)
			this.#downloads.delete(transferId);
	}

	#deleteUpload(transferId: string, session: UploadSession): void {
		if (this.#uploads.get(transferId) === session)
			this.#uploads.delete(transferId);
	}
}

class UploadChunkQueue implements AsyncIterable<Uint8Array> {
	#pending:
		| {
				bytes: Uint8Array;
				consumed: () => void;
				rejected: (reason: unknown) => void;
		  }
		| undefined;
	#waiting:
		| {
				resolve: (value: IteratorResult<Uint8Array>) => void;
				reject: (reason: unknown) => void;
		  }
		| undefined;
	#closed = false;
	#failure: unknown;

	async push(bytes: Uint8Array): Promise<void> {
		if (
			this.#closed ||
			this.#failure !== undefined ||
			this.#pending !== undefined
		)
			throw new BinaryTransferInvocationError();
		return new Promise<void>((resolve, reject) => {
			const waiting = this.#waiting;
			if (waiting !== undefined) {
				this.#waiting = undefined;
				waiting.resolve({ done: false, value: bytes });
				resolve();
				return;
			}
			this.#pending = { bytes, consumed: resolve, rejected: reject };
		});
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		if (this.#pending !== undefined) throw new BinaryTransferInvocationError();
		const waiting = this.#waiting;
		this.#waiting = undefined;
		waiting?.resolve({ done: true, value: undefined });
	}

	fail(reason: unknown): void {
		if (this.#failure !== undefined) return;
		this.#failure = reason;
		const pending = this.#pending;
		this.#pending = undefined;
		pending?.rejected(reason);
		const waiting = this.#waiting;
		this.#waiting = undefined;
		waiting?.reject(reason);
	}

	[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
		return {
			next: () => {
				if (this.#failure !== undefined) return Promise.reject(this.#failure);
				const pending = this.#pending;
				if (pending !== undefined) {
					this.#pending = undefined;
					pending.consumed();
					return Promise.resolve({ done: false, value: pending.bytes });
				}
				if (this.#closed)
					return Promise.resolve({ done: true, value: undefined });
				if (this.#waiting !== undefined)
					return Promise.reject(new BinaryTransferInvocationError());
				return new Promise((resolve, reject) => {
					this.#waiting = { resolve, reject };
				});
			},
		};
	}
}

function parseRequest(json: unknown): TransferControlRequest {
	let value: unknown;
	try {
		value = JSON.parse(String(json));
	} catch {
		throw new BinaryTransferInvocationError();
	}
	if (!validateTransferControlRequest(value))
		throw new BinaryTransferInvocationError();
	return value;
}

function serialize(response: TransferControlResponse): string {
	if (!validateTransferControlResponse(response))
		throw new BinaryTransferInvocationError();
	return JSON.stringify(response);
}

function decimal(value: string): bigint {
	if (!/^(0|[1-9][0-9]*)$/.test(value))
		throw new BinaryTransferInvocationError();
	return BigInt(value);
}

function safeNumber(value: bigint): number {
	if (value > BigInt(Number.MAX_SAFE_INTEGER))
		throw new BinaryTransferInvocationError();
	return Number(value);
}

function headerEntries(
	headers: readonly { name: string; value: string }[],
): [string, string][] {
	const names = new Set<string>();
	return headers.map(({ name, value }) => {
		const canonical = name.toLowerCase();
		if (names.has(canonical)) throw new BinaryTransferInvocationError();
		names.add(canonical);
		return [name, value];
	});
}

function assertHeadersPreserved(
	expected: readonly { name: string; value: string }[],
	actual: Headers,
): void {
	const entries = [...actual.entries()];
	if (entries.length !== expected.length)
		throw new BinaryTransferInvocationError();
	const values = new Map(
		expected.map(({ name, value }) => [name.toLowerCase(), value]),
	);
	for (const [name, value] of entries) {
		if (values.get(name.toLowerCase()) !== value)
			throw new BinaryTransferInvocationError();
	}
}

function assertUploadHeaders(
	headers: readonly { name: string; value: string }[],
	digest: string,
): void {
	const values = new Map(
		headers.map(({ name, value }) => [name.toLowerCase(), value]),
	);
	if (
		values.has("content-length") ||
		values.get("content-type") !== "application/octet-stream" ||
		values.get("x-amz-content-sha256") !== digest
	) {
		throw new BinaryTransferInvocationError();
	}
}

async function sha256(bytes: Uint8Array): Promise<string> {
	const digest = new Uint8Array(
		await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)),
	);
	return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

class BinaryTransferInvocationError extends Error {
	constructor() {
		super("Binary transfer invocation failed");
		this.name = "BinaryTransferInvocationError";
	}
}
