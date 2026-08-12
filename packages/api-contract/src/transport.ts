import createClient from "openapi-fetch";
import { normalizeApiError } from "./errors.ts";
import type { paths } from "./generated/schema.ts";

export type ApiClientPlatform = "web" | "desktop" | "mobile" | "extension";
export type ApiHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface InsecureTransportPolicy {
	operatorEnabled: boolean;
	accountConfirmed: boolean;
}

export interface HttpServerUrlClassification {
	url: URL;
	isLoopback: boolean;
	isRemoteHttp: boolean;
	shouldInferHttp: boolean;
}

export interface ApiClientMetadata {
	id: string;
	platform: ApiClientPlatform;
	version: string;
}

export type ApiRequestOrigin =
	| {
			kind: "persistedAccount";
			accountId: string;
			serverUrl: string;
	  }
	| {
			kind: "authCeremony";
			serverUrl: string;
			insecureTransportConfirmed: boolean;
	  };

export type ApiFetch = (
	request: Request,
	requestOrigin?: ApiRequestOrigin,
) => Promise<Response>;

export type ApiAccessTokenProvider = () =>
	| string
	| null
	| Promise<string | null>;
export type ApiClientMetadataProvider = () =>
	| ApiClientMetadata
	| Promise<ApiClientMetadata>;
export type InsecureTransportAuthorizer = (
	serverUrl: string,
) => Promise<InsecureTransportPolicy | undefined>;

export interface ApiTransportOptions {
	baseUrl: string;
	insecureTransport?: InsecureTransportPolicy;
	authorizeInsecureTransport?: InsecureTransportAuthorizer;
	fetch?: ApiFetch;
	getAccessToken?: ApiAccessTokenProvider;
	getClientMetadata: ApiClientMetadataProvider;
	onSessionExpires?: (expiresAt: string) => void | Promise<void>;
	/** Invoked after an authenticated request is rejected, so the owner may refresh session state. */
	onSessionRefreshRequired?: () => void | Promise<void>;
}

const LOCAL_REQUEST_ORIGIN_HEADER = "Bittery-Local-Request-Origin";

/**
 * A request that never reached the API: a name that does not resolve, a refused or
 * reset connection, a socket that timed out.
 *
 * There is no response and so no problem document to read, and `fetch` rejects with
 * an engine-specific string ("Failed to fetch" in Chromium, "Load failed" in WebKit)
 * that must never reach a user. The original rejection is kept as `cause`.
 */
export class ApiTransportError extends Error {
	// Declared rather than only assigned: the class adds no other member, so
	// without a literal `name` it is structurally an `Error` and a type predicate
	// cannot tell the two apart.
	readonly name = "ApiTransportError";

	constructor(cause: unknown) {
		super("The server could not be reached.", { cause });
	}
}

export function isApiTransportError(
	error: unknown,
): error is ApiTransportError {
	return error instanceof ApiTransportError;
}

function errorName(error: unknown): string | undefined {
	return typeof error === "object" &&
		error !== null &&
		typeof (error as { name?: unknown }).name === "string"
		? (error as { name: string }).name
		: undefined;
}

/**
 * Whether a rejection is a failed request rather than a refusal to make one.
 *
 * `fetch` rejects with a `TypeError` when a request does not complete, and with
 * nothing else - so anything a caller's own fetch raises on purpose (a denied
 * transport policy, a cancelled stream) is left alone rather than dressed up as a
 * network failure. The name is checked too because a `TypeError` from another
 * realm fails `instanceof`.
 */
function isFailedRequest(error: unknown, signal: AbortSignal | null): boolean {
	if (signal?.aborted === true || errorName(error) === "AbortError") {
		return false;
	}
	return error instanceof TypeError || errorName(error) === "TypeError";
}

export function requestOriginHeaders(origin: ApiRequestOrigin): Headers {
	return new Headers({
		[LOCAL_REQUEST_ORIGIN_HEADER]: encodeURIComponent(JSON.stringify(origin)),
	});
}

function takeRequestOrigin(request: Request): {
	request: Request;
	origin?: ApiRequestOrigin;
} {
	const serialized = request.headers.get(LOCAL_REQUEST_ORIGIN_HEADER);
	if (!serialized) return { request };

	let candidate: unknown;
	try {
		candidate = JSON.parse(decodeURIComponent(serialized));
	} catch {
		throw new TypeError("Local request origin is invalid.");
	}
	if (!candidate || typeof candidate !== "object") {
		throw new TypeError("Local request origin is invalid.");
	}
	const origin = candidate as Partial<ApiRequestOrigin>;
	const hasServerUrl =
		typeof origin.serverUrl === "string" && origin.serverUrl.length > 0;
	if (
		(origin.kind === "persistedAccount" &&
			typeof origin.accountId === "string" &&
			origin.accountId.length > 0 &&
			hasServerUrl) ||
		(origin.kind === "authCeremony" &&
			typeof origin.insecureTransportConfirmed === "boolean" &&
			hasServerUrl)
	) {
		// Mutated in place: `new Request(request, ...)` turns the body into a
		// stream, and WebKit cannot upload a streamed request body.
		request.headers.delete(LOCAL_REQUEST_ORIGIN_HEADER);
		return {
			request,
			origin: origin as ApiRequestOrigin,
		};
	}
	throw new TypeError("Local request origin is invalid.");
}

export interface ApiTransportRequest {
	params?: {
		path?: Record<string, string>;
		query?: object;
	};
	body?: unknown;
	headers?: HeadersInit;
}

export interface ApiTransportResponse<T> {
	data: T;
	response: Response;
	etag: string | null;
	requestId: string | null;
}

export interface ApiTransport {
	getApiMetadata(): Promise<ApiTransportResponse<unknown>>;
	request<T>(
		method: ApiHttpMethod,
		path: string,
		request?: ApiTransportRequest,
	): Promise<ApiTransportResponse<T>>;
	openSyncEvents(signal?: AbortSignal): Promise<Response>;
}

function nonEmptyHeaderValue(value: string, name: string): string {
	if (value.trim().length === 0) {
		throw new TypeError(`${name} must not be empty.`);
	}

	return value;
}

function isLoopbackHostname(hostname: string): boolean {
	const normalized = hostname.toLowerCase();
	return (
		normalized === "localhost" ||
		normalized === "::1" ||
		normalized === "[::1]" ||
		/^127(?:\.\d{1,3}){3}$/.test(normalized)
	);
}

export function classifyHttpServerUrl(
	value: string,
): HttpServerUrlClassification {
	const url = new URL(value);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new TypeError("Server URL must use HTTP or HTTPS.");
	}

	const isLoopback = isLoopbackHostname(url.hostname);
	return {
		url,
		isLoopback,
		isRemoteHttp: url.protocol === "http:" && !isLoopback,
		shouldInferHttp: isLoopback || url.hostname === "0.0.0.0",
	};
}

function normalizeBaseUrl(
	value: string,
	insecureTransport?: InsecureTransportPolicy,
): string {
	const { url, isRemoteHttp } = classifyHttpServerUrl(value);
	if (url.search || url.hash) {
		throw new TypeError("API base URL must not include a query or fragment.");
	}
	if (
		isRemoteHttp &&
		!(insecureTransport?.operatorEnabled && insecureTransport.accountConfirmed)
	) {
		throw new TypeError(
			"Remote HTTP requires operator enablement and per-account confirmation.",
		);
	}

	return url.toString().replace(/\/$/, "");
}

export function createApiTransport(options: ApiTransportOptions): ApiTransport {
	const baseUrl = normalizeBaseUrl(
		options.baseUrl,
		options.authorizeInsecureTransport
			? { operatorEnabled: true, accountConfirmed: true }
			: options.insecureTransport,
	);
	const rawFetch =
		options.fetch ?? ((request: Request) => globalThis.fetch(request));
	const fetchImplementation = async (request: Request): Promise<Response> => {
		const localRequest = takeRequestOrigin(request);
		if (options.authorizeInsecureTransport) {
			const policy = await options.authorizeInsecureTransport(baseUrl);
			normalizeBaseUrl(baseUrl, policy);
		}
		try {
			return await rawFetch(localRequest.request, localRequest.origin);
		} catch (error) {
			if (!isFailedRequest(error, localRequest.request.signal)) throw error;
			throw new ApiTransportError(error);
		}
	};
	const client = createClient<paths>({
		baseUrl,
		fetch: fetchImplementation,
	});

	async function applyRequestHeaders(headers: Headers): Promise<void> {
		const [accessToken, metadata] = await Promise.all([
			options.getAccessToken?.() ?? null,
			options.getClientMetadata(),
		]);
		if (accessToken && !headers.has("Authorization")) {
			headers.set(
				"Authorization",
				`Bearer ${nonEmptyHeaderValue(accessToken, "Access token")}`,
			);
		}
		headers.set(
			"Bittery-Client-Id",
			nonEmptyHeaderValue(metadata.id, "Client ID"),
		);
		headers.set(
			"Bittery-Client-Platform",
			nonEmptyHeaderValue(metadata.platform, "Client platform"),
		);
		headers.set(
			"Bittery-Client-Version",
			nonEmptyHeaderValue(metadata.version, "Client version"),
		);
	}

	client.use({
		async onRequest({ request }) {
			// Headers are set in place: `new Request(request, ...)` turns the body
			// into a stream, and WebKit cannot upload a streamed request body.
			await applyRequestHeaders(request.headers);
			return request;
		},
		async onResponse({ response }) {
			const sessionExpires = response.headers.get("Bittery-Session-Expires");
			if (sessionExpires) {
				await options.onSessionExpires?.(sessionExpires);
			}
		},
	});

	async function request<T>(
		method: ApiHttpMethod,
		path: string,
		requestOptions: ApiTransportRequest = {},
	): Promise<ApiTransportResponse<T>> {
		const headers = new Headers(requestOptions.headers);
		if (method === "PATCH") {
			headers.set("Content-Type", "application/merge-patch+json");
		}
		const request = { ...requestOptions, headers } as never;
		const dispatch = () =>
			method === "GET"
				? client.GET(path as never, request)
				: method === "POST"
					? client.POST(path as never, request)
					: method === "PUT"
						? client.PUT(path as never, request)
						: method === "PATCH"
							? client.PATCH(path as never, request)
							: client.DELETE(path as never, request);
		let result = await dispatch();
		if (
			result.response.status === 401 &&
			path !== "/api/v1/sessions/current/refresh" &&
			options.getAccessToken &&
			options.onSessionRefreshRequired
		) {
			await options.onSessionRefreshRequired();
			result = await dispatch();
		}

		if (!result.response.ok) {
			throw await normalizeApiError(result.response, Date.now(), result.error);
		}

		return {
			data: result.data as T,
			response: result.response,
			etag: result.response.headers.get("ETag"),
			requestId: result.response.headers.get("Bittery-Request-Id"),
		};
	}

	return {
		getApiMetadata: () => request("GET", "/api/meta"),
		request,
		async openSyncEvents(signal) {
			const headers = new Headers({ Accept: "text/event-stream" });
			await applyRequestHeaders(headers);
			const response = await fetchImplementation(
				new Request(new URL("api/v1/sync/events", `${baseUrl}/`), {
					headers,
					signal,
				}),
			);
			if (!response.ok) {
				throw await normalizeApiError(response);
			}
			return response;
		},
	};
}
