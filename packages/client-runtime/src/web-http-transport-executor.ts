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

		const controller = new AbortController();
		let browserRequest: Request;
		try {
			browserRequest = new Request(request.url, {
				method: request.method,
				headers: request.headers.map(({ name, value }): [string, string] => [
					name,
					value,
				]),
				body:
					request.method === "GET" || request.method === "HEAD"
						? undefined
						: Uint8Array.from(request.body),
				signal: controller.signal,
				redirect: "manual",
				credentials: "omit",
				cache: "no-store",
				referrerPolicy: "no-referrer",
				mode: "cors",
			});
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
