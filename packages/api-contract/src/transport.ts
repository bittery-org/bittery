import createClient from "openapi-fetch";
import { normalizeApiError } from "./errors.ts";
import type { paths } from "./generated/schema.ts";

export type ApiClientPlatform = "web" | "desktop" | "mobile" | "extension";
export type ApiHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface InsecureTransportPolicy {
	operatorEnabled: boolean;
	accountConfirmed: boolean;
}

export interface ApiClientMetadata {
	id: string;
	platform: ApiClientPlatform;
	version: string;
}

export type ApiAccessTokenProvider = () =>
	| string
	| null
	| Promise<string | null>;
export type ApiClientMetadataProvider = () =>
	| ApiClientMetadata
	| Promise<ApiClientMetadata>;

export interface ApiTransportOptions {
	baseUrl: string;
	insecureTransport?: InsecureTransportPolicy;
	fetch?: (request: Request) => Promise<Response>;
	getAccessToken?: ApiAccessTokenProvider;
	getClientMetadata: ApiClientMetadataProvider;
	onSessionExpires?: (expiresAt: string) => void | Promise<void>;
	/** Invoked after an authenticated request is rejected, so the owner may refresh session state. */
	onSessionRefreshRequired?: () => void | Promise<void>;
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
	openSyncEvents(): Promise<Response>;
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

function normalizeBaseUrl(
	value: string,
	insecureTransport?: InsecureTransportPolicy,
): string {
	const url = new URL(value);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new TypeError("API base URL must use HTTP or HTTPS.");
	}
	if (url.search || url.hash) {
		throw new TypeError("API base URL must not include a query or fragment.");
	}
	if (
		url.protocol === "http:" &&
		!isLoopbackHostname(url.hostname) &&
		!(insecureTransport?.operatorEnabled && insecureTransport.accountConfirmed)
	) {
		throw new TypeError(
			"Remote HTTP requires operator enablement and per-account confirmation.",
		);
	}

	return url.toString().replace(/\/$/, "");
}

export function createApiTransport(options: ApiTransportOptions): ApiTransport {
	const baseUrl = normalizeBaseUrl(options.baseUrl, options.insecureTransport);
	const fetchImplementation =
		options.fetch ?? ((request: Request) => globalThis.fetch(request));
	const client = createClient<paths>({
		baseUrl,
		fetch: fetchImplementation,
	});

	async function requestHeaders(headers?: HeadersInit): Promise<Headers> {
		const [accessToken, metadata] = await Promise.all([
			options.getAccessToken?.() ?? null,
			options.getClientMetadata(),
		]);
		const next = new Headers(headers);
		if (accessToken) {
			next.set(
				"Authorization",
				`Bearer ${nonEmptyHeaderValue(accessToken, "Access token")}`,
			);
		}
		next.set(
			"Bittery-Client-Id",
			nonEmptyHeaderValue(metadata.id, "Client ID"),
		);
		next.set(
			"Bittery-Client-Platform",
			nonEmptyHeaderValue(metadata.platform, "Client platform"),
		);
		next.set(
			"Bittery-Client-Version",
			nonEmptyHeaderValue(metadata.version, "Client version"),
		);
		return next;
	}

	client.use({
		async onRequest({ request }) {
			return new Request(request, {
				headers: await requestHeaders(request.headers),
			});
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
		async openSyncEvents() {
			const response = await fetchImplementation(
				new Request(new URL("/api/v1/sync/events", `${baseUrl}/`), {
					headers: await requestHeaders({ Accept: "text/event-stream" }),
				}),
			);
			if (!response.ok) {
				throw await normalizeApiError(response);
			}
			return response;
		},
	};
}
