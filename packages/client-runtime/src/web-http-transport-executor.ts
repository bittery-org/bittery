import type {
	HttpRequest,
	HttpResponse,
	HttpStreamCommand,
	HttpStreamResponse,
} from "../generated/http-transport/contract";
import {
	validateHttpRequestJson,
	validateHttpResponseJson,
	validateHttpStreamCommandJson,
	validateHttpStreamResponseJson,
} from "../generated/http-transport/validator.js";

type Fetch = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

interface StreamState {
	controller: AbortController;
	reader?: ReadableStreamDefaultReader<Uint8Array>;
	reading: boolean;
	maxChunkBytes: number;
}

/** Browser adapter for the closed, Rust-owned HTTP dispatch contract. */
export class WebHttpTransportExecutor {
	readonly #active = new Map<string, AbortController>();
	readonly #streams = new Map<string, StreamState>();

	constructor(
		private readonly fetch: Fetch = globalThis.fetch.bind(globalThis),
	) {}

	async invoke(requestJson: string): Promise<string> {
		const request = parseRequest(requestJson);
		try {
			return await this.#invoke(request);
		} finally {
			if (!("type" in request)) request.body.fill(0);
			else if (request.type === "openStream") request.request.body.fill(0);
		}
	}

	async #invoke(request: HttpRequest | HttpStreamCommand): Promise<string> {
		if ("type" in request) {
			return serializeStream(
				request.type === "openStream"
					? await this.#openStream(request.request)
					: await this.#readStream(request.dispatchId),
			);
		}
		if (this.#active.has(request.dispatchId)) {
			throw new HttpTransportInvocationError();
		}
		const controller = new AbortController();
		controller.signal.addEventListener("abort", () => request.body.fill(0), {
			once: true,
		});
		this.#active.set(request.dispatchId, controller);
		let result: HttpResponse;
		try {
			assertBodySupported(request);
			assertUniqueHeaderNames(request.headers);
			const browserHeaders = await browserOwnedHeaders(
				request,
				controller.signal,
			);
			const browserRequest = prepareRequest(
				request,
				browserHeaders,
				controller.signal,
			);
			if (controller.signal.aborted) return serialize({ type: "cancelled" });
			const response = await this.fetch(browserRequest);
			result = await readResponse(
				response,
				request.maxResponseBytes,
				controller.signal,
			);
		} catch (error) {
			if (error instanceof HttpTransportInvocationError) throw error;
			result = {
				type: controller.signal.aborted ? "cancelled" : "networkFailure",
			};
		} finally {
			if (this.#active.get(request.dispatchId) === controller) {
				this.#active.delete(request.dispatchId);
			}
		}
		return serialize(result);
	}

	async #openStream(request: HttpRequest): Promise<HttpStreamResponse> {
		if (
			this.#active.has(request.dispatchId) ||
			request.maxResponseBytes === 0
		) {
			throw new HttpTransportInvocationError();
		}
		const state: StreamState = {
			controller: new AbortController(),
			reading: true,
			maxChunkBytes: request.maxResponseBytes,
		};
		state.controller.signal.addEventListener(
			"abort",
			() => request.body.fill(0),
			{ once: true },
		);
		this.#active.set(request.dispatchId, state.controller);
		this.#streams.set(request.dispatchId, state);
		try {
			assertBodySupported(request);
			assertUniqueHeaderNames(request.headers);
			const browserHeaders = await browserOwnedHeaders(
				request,
				state.controller.signal,
			);
			const requestObject = prepareRequest(
				request,
				browserHeaders,
				state.controller.signal,
			);
			if (state.controller.signal.aborted) return { type: "cancelled" };
			const response = await this.fetch(requestObject);
			if (state.controller.signal.aborted) {
				void response.body?.cancel().catch(() => undefined);
				return { type: "cancelled" };
			}
			state.reader = response.body?.getReader();
			state.reading = false;
			return {
				type: "opened",
				status: response.status,
				headers: [...response.headers.entries()].map(([name, value]) => ({
					name,
					value,
				})),
			};
		} catch (error) {
			const cancelled = state.controller.signal.aborted;
			this.#retireStream(request.dispatchId, state);
			if (error instanceof HttpTransportInvocationError) throw error;
			return { type: cancelled ? "cancelled" : "networkFailure" };
		}
	}

	async #readStream(dispatchId: string): Promise<HttpStreamResponse> {
		const state = this.#streams.get(dispatchId);
		if (!state || state.controller.signal.aborted) return { type: "cancelled" };
		if (state.reading) throw new HttpTransportInvocationError();
		state.reading = true;
		try {
			// Pull once at a time; no queued chunks, SSE parsing, or reconnect policy.
			const chunk = await state.reader?.read();
			if (state.controller.signal.aborted) return { type: "cancelled" };
			if (!chunk || chunk.done) {
				this.#retireStream(dispatchId, state);
				return { type: "ended" };
			}
			if (
				chunk.value.byteLength === 0 ||
				chunk.value.byteLength > state.maxChunkBytes
			) {
				this.#retireStream(dispatchId, state);
				return { type: "responseTooLarge" };
			}
			// The byte-length guard above proves the generated nonempty wire shape.
			return {
				type: "chunk",
				bytes: [...chunk.value] as [number, ...number[]],
			};
		} catch {
			const cancelled = state.controller.signal.aborted;
			this.#retireStream(dispatchId, state);
			return { type: cancelled ? "cancelled" : "networkFailure" };
		} finally {
			state.reading = false;
		}
	}

	#retireStream(dispatchId: string, state: StreamState): void {
		if (this.#streams.get(dispatchId) === state) this.cancel(dispatchId);
	}

	cancel(dispatchId: string): void {
		const controller = this.#active.get(dispatchId);
		if (controller === undefined) return;
		this.#active.delete(dispatchId);
		const stream = this.#streams.get(dispatchId);
		this.#streams.delete(dispatchId);
		controller.abort();
		void stream?.reader?.cancel().catch(() => undefined);
	}
}

function prepareRequest(
	request: HttpRequest,
	browserHeaders: HttpRequest["headers"],
	signal: AbortSignal,
): Request {
	const body =
		request.body.length === 0 ? undefined : Uint8Array.from(request.body);
	try {
		const browserRequest = new Request(request.url, {
			method: request.method,
			headers: browserHeaders.map(({ name, value }): [string, string] => [
				name,
				value,
			]),
			body,
			signal,
			redirect: "manual",
			credentials: "omit",
			cache: "no-store",
			referrerPolicy: "no-referrer",
			mode: "cors",
		});
		assertHeadersPreserved(browserHeaders, browserRequest.headers);
		return browserRequest;
	} catch {
		throw new HttpTransportInvocationError();
	} finally {
		// Request copies BufferSource bytes. Erase only our mutable handoff; Fetch/JS-engine
		// managed copies and immutable JSON strings cannot be forensically wiped here.
		body?.fill(0);
		request.body.fill(0);
	}
}

/**
 * A presigned object-store PUT binds Content-Length, but Fetch forbids script from setting it.
 * Validate the complete byte authority here, then omit only that header so the browser emits the
 * same value from its known-size body. Every other signed header remains byte-for-byte explicit.
 */
async function browserOwnedHeaders(
	request: HttpRequest,
	signal: AbortSignal,
): Promise<HttpRequest["headers"]> {
	if (request.method !== "PUT") return request.headers;
	const byName = new Map(
		request.headers.map((header) => [header.name.toLowerCase(), header]),
	);
	const isSignedBinaryPut = [
		"content-length",
		"x-amz-content-sha256",
		"x-amz-checksum-sha256",
	].some((name) => byName.has(name));
	if (!isSignedBinaryPut) return request.headers;
	const contentLength = byName.get("content-length")?.value;
	const contentType = byName.get("content-type")?.value;
	const hexadecimalDigest = byName.get("x-amz-content-sha256")?.value;
	const base64Digest = byName.get("x-amz-checksum-sha256")?.value;
	if (
		contentLength !== String(request.body.length) ||
		contentType === undefined ||
		contentType.length === 0 ||
		hexadecimalDigest === undefined ||
		base64Digest === undefined
	) {
		throw new HttpTransportInvocationError();
	}
	signal.throwIfAborted();
	const digestInput = Uint8Array.from(request.body);
	const wipe = () => digestInput.fill(0);
	signal.addEventListener("abort", wipe, { once: true });
	let digest: Uint8Array;
	try {
		digest = new Uint8Array(
			await globalThis.crypto.subtle.digest("SHA-256", digestInput),
		);
	} finally {
		wipe();
		signal.removeEventListener("abort", wipe);
	}
	signal.throwIfAborted();
	const actualHex = [...digest]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
	let binary = "";
	for (const byte of digest) binary += String.fromCharCode(byte);
	if (hexadecimalDigest !== actualHex || base64Digest !== btoa(binary)) {
		throw new HttpTransportInvocationError();
	}
	return request.headers.filter(
		({ name }) => name.toLowerCase() !== "content-length",
	);
}

function assertBodySupported(request: HttpRequest): void {
	if (
		request.body.length > 0 &&
		(request.method === "GET" || request.method === "HEAD")
	) {
		throw new HttpTransportInvocationError();
	}
}

function assertUniqueHeaderNames(headers: HttpRequest["headers"]): void {
	const names = new Set<string>();
	for (const { name } of headers) {
		const canonicalName = name.toLowerCase();
		if (names.has(canonicalName)) throw new HttpTransportInvocationError();
		names.add(canonicalName);
	}
}

function assertHeadersPreserved(
	expected: HttpRequest["headers"],
	actual: Headers,
): void {
	const actualEntries = [...actual.entries()];
	if (actualEntries.length !== expected.length) {
		throw new HttpTransportInvocationError();
	}
	const expectedValues = new Map(
		expected.map(({ name, value }) => [name.toLowerCase(), value]),
	);
	for (const [name, value] of actualEntries) {
		if (expectedValues.get(name.toLowerCase()) !== value) {
			throw new HttpTransportInvocationError();
		}
	}
}

async function readResponse(
	response: Response,
	maxResponseBytes: number,
	signal: AbortSignal,
): Promise<HttpResponse> {
	if (signal.aborted) return { type: "cancelled" };
	const contentLength = response.headers.get("content-length");
	if (
		contentLength !== null &&
		/^(0|[1-9][0-9]*)$/.test(contentLength) &&
		Number(contentLength) > maxResponseBytes
	) {
		await response.body?.cancel().catch(() => undefined);
		return { type: "responseTooLarge" };
	}

	const body: number[] = [];
	const reader = response.body?.getReader();
	if (reader !== undefined) {
		while (true) {
			if (signal.aborted) {
				await reader.cancel().catch(() => undefined);
				return { type: "cancelled" };
			}
			const chunk = await reader.read();
			if (chunk.done) break;
			if (body.length + chunk.value.byteLength > maxResponseBytes) {
				await reader.cancel().catch(() => undefined);
				return { type: "responseTooLarge" };
			}
			for (const byte of chunk.value) body.push(byte);
		}
	}

	if (signal.aborted) return { type: "cancelled" };
	return {
		type: "completed",
		status: response.status,
		headers: [...response.headers.entries()].map(([name, value]) => ({
			name,
			value,
		})),
		body,
	};
}

function parseRequest(requestJson: unknown): HttpRequest | HttpStreamCommand {
	let value: unknown;
	try {
		value = JSON.parse(String(requestJson));
	} catch {
		throw new HttpTransportInvocationError();
	}
	if (
		!validateHttpRequestJson(value) &&
		!validateHttpStreamCommandJson(value)
	) {
		throw new HttpTransportInvocationError();
	}
	return value;
}

function serializeStream(response: HttpStreamResponse): string {
	if (!validateHttpStreamResponseJson(response))
		throw new HttpTransportInvocationError();
	return JSON.stringify(response);
}

function serialize(response: HttpResponse): string {
	if (!validateHttpResponseJson(response)) {
		throw new HttpTransportInvocationError();
	}
	return JSON.stringify(response);
}

class HttpTransportInvocationError extends Error {
	constructor() {
		super("HTTP transport invocation failed");
		this.name = "HttpTransportInvocationError";
	}
}
