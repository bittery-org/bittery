import type {
	HttpRequest,
	HttpResponse,
} from "../generated/http-transport/contract";
import {
	validateHttpRequestJson,
	validateHttpResponseJson,
} from "../generated/http-transport/validator.js";

type Fetch = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

/** Browser adapter for the closed, Rust-owned HTTP dispatch contract. */
export class WebHttpTransportExecutor {
	readonly #active = new Map<string, AbortController>();

	constructor(
		private readonly fetch: Fetch = globalThis.fetch.bind(globalThis),
	) {}

	async invoke(requestJson: string): Promise<string> {
		const request = parseRequest(requestJson);
		if (this.#active.has(request.dispatchId)) {
			throw new HttpTransportInvocationError();
		}
		assertBodySupported(request);
		assertUniqueHeaderNames(request.headers);
		const browserHeaders = await browserOwnedHeaders(request);

		const controller = new AbortController();
		let browserRequest: Request;
		try {
			browserRequest = new Request(request.url, {
				method: request.method,
				headers: browserHeaders.map(({ name, value }): [string, string] => [
					name,
					value,
				]),
				body:
					request.body.length === 0 ? undefined : Uint8Array.from(request.body),
				signal: controller.signal,
				redirect: "manual",
				credentials: "omit",
				cache: "no-store",
				referrerPolicy: "no-referrer",
				mode: "cors",
			});
			assertHeadersPreserved(browserHeaders, browserRequest.headers);
		} catch {
			throw new HttpTransportInvocationError();
		}

		this.#active.set(request.dispatchId, controller);
		let result: HttpResponse;
		try {
			const response = await this.fetch(browserRequest);
			result = await readResponse(
				response,
				request.maxResponseBytes,
				controller.signal,
			);
		} catch {
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

	cancel(dispatchId: string): void {
		const controller = this.#active.get(dispatchId);
		if (controller === undefined) return;
		this.#active.delete(dispatchId);
		controller.abort();
	}
}

/**
 * A presigned object-store PUT binds Content-Length, but Fetch forbids script from setting it.
 * Validate the complete byte authority here, then omit only that header so the browser emits the
 * same value from its known-size body. Every other signed header remains byte-for-byte explicit.
 */
async function browserOwnedHeaders(
	request: HttpRequest,
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
	const digest = new Uint8Array(
		await globalThis.crypto.subtle.digest(
			"SHA-256",
			Uint8Array.from(request.body),
		),
	);
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

function parseRequest(requestJson: unknown): HttpRequest {
	let value: unknown;
	try {
		value = JSON.parse(String(requestJson));
	} catch {
		throw new HttpTransportInvocationError();
	}
	if (!validateHttpRequestJson(value)) {
		throw new HttpTransportInvocationError();
	}
	return value;
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
