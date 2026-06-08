import { createAppRpcClient } from "./rpc-client";
import { buildRpcUrl } from "./server-url";
import type { RefreshResult, SessionSnapshot } from "./session-refresh";
import { createSessionRefreshingFetch } from "./session-refresh-fetch";

export interface SessionRefreshingRpcClientOptions {
	defaultServerUrl: string;
	getServerUrl: () => Promise<string>;
	getSessionSnapshot: () => Promise<SessionSnapshot>;
	getRefreshToken: () => Promise<string | null>;
	storeRefreshedSession: (session: {
		token: string;
		sessionId: string;
		expiresAt: string | Date;
	}) => Promise<void>;
	getClientId?: () => Promise<string | null>;
	thresholdRatio?: number;
	appPlatform?: string;
}

function getRequestUrl(input: RequestInfo | URL): string {
	if (typeof input === "string") {
		return input;
	}
	if (input instanceof URL) {
		return input.toString();
	}
	return input.url;
}

function toHeaderRecord(headers?: HeadersInit): Record<string, string> {
	if (!headers) {
		return {};
	}

	const normalized: Record<string, string> = {};
	for (const [key, value] of new Headers(headers).entries()) {
		normalized[key] = value;
	}
	return normalized;
}

async function createAuthHeaders(options: {
	baseHeaders?: HeadersInit;
	token: string | null;
	clientId: string | null;
	appPlatform?: string;
}): Promise<Record<string, string>> {
	const headers = toHeaderRecord(options.baseHeaders);

	if (options.token) {
		headers.Authorization = `Bearer ${options.token}`;
	}

	if (options.clientId) {
		headers["X-Client-Id"] = options.clientId;
	}

	if (options.appPlatform) {
		headers["X-App-Platform"] = options.appPlatform;
	}

	return headers;
}

export function createSessionRefreshingRpcFetch(
	options: SessionRefreshingRpcClientOptions,
): (url: RequestInfo | URL, requestOptions?: RequestInit) => Promise<Response> {
	const refreshClient = createAppRpcClient({
		serverUrl: options.defaultServerUrl,
		async fetch(url, requestOptions) {
			const [serverUrl, refreshToken, clientId] = await Promise.all([
				options.getServerUrl(),
				options.getRefreshToken(),
				options.getClientId?.() ?? Promise.resolve(null),
			]);

			const resolvedUrl = buildRpcUrl(serverUrl, getRequestUrl(url));
			const headers = await createAuthHeaders({
				baseHeaders: requestOptions?.headers,
				token: refreshToken,
				clientId,
				appPlatform: options.appPlatform,
			});

			return fetch(resolvedUrl, {
				...requestOptions,
				headers,
			});
		},
	});

	return createSessionRefreshingFetch({
		getSessionSnapshot: options.getSessionSnapshot,
		refreshSession: async (): Promise<RefreshResult> => {
			const result = await refreshClient.auth.refreshSession.mutate();
			return result as RefreshResult;
		},
		onRefreshSuccess: async (result) => {
			await options.storeRefreshedSession(result);
		},
		resolveUrl: async (url) => {
			const serverUrl = await options.getServerUrl();
			const requestUrl =
				typeof url === "string"
					? url
					: url instanceof URL
						? url.toString()
						: url.url;
			return buildRpcUrl(serverUrl, requestUrl);
		},
		getClientId: options.getClientId,
		thresholdRatio: options.thresholdRatio,
		appPlatform: options.appPlatform,
	});
}

export function createSessionRefreshingRpcClient(
	options: SessionRefreshingRpcClientOptions,
) {
	const sessionRefreshingFetch = createSessionRefreshingRpcFetch(options);

	return createAppRpcClient({
		serverUrl: options.defaultServerUrl,
		fetch: sessionRefreshingFetch,
	});
}
