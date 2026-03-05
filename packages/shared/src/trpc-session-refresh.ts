import {
	SessionRefreshManager,
	type SessionSnapshot,
} from "./session-refresh";
import { buildTrpcUrl } from "./server-url";
import { createAppTrpcClient } from "./trpc-client";

interface SessionRefreshingFetchOptions {
	defaultServerUrl: string;
	getServerUrl: () => Promise<string>;
	getSessionSnapshot: () => Promise<SessionSnapshot>;
	getRefreshToken: () => Promise<string | null>;
	storeRefreshedToken: (token: string) => Promise<void>;
	getClientId?: () => Promise<string | null>;
	thresholdRatio?: number;
	/** Platform identifier sent as X-App-Platform header (e.g. 'desktop', 'ios', 'android') */
	appPlatform?: string;
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

async function createAuthHeaders(
	options: {
		baseHeaders?: HeadersInit;
		token: string | null;
		clientId: string | null;
		appPlatform?: string;
	},
): Promise<Record<string, string>> {
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

export function createSessionRefreshingTrpcFetch(
	options: SessionRefreshingFetchOptions,
): (url: string | URL, requestOptions?: RequestInit) => Promise<Response> {
	const refreshClient = createAppTrpcClient({
		serverUrl: options.defaultServerUrl,
		async fetch(url, requestOptions) {
			const [serverUrl, refreshToken, clientId] = await Promise.all([
				options.getServerUrl(),
				options.getRefreshToken(),
				options.getClientId?.() ?? Promise.resolve(null),
			]);

			const resolvedUrl = buildTrpcUrl(serverUrl, url as string);
			const headers = await createAuthHeaders({
				baseHeaders: requestOptions?.headers,
				token: refreshToken,
				clientId,
				appPlatform: options.appPlatform,
			});

			return fetch(resolvedUrl, {
				...requestOptions,
				credentials: "include",
				headers,
			});
		},
	});

	const refreshManager = new SessionRefreshManager({
		thresholdRatio: options.thresholdRatio ?? 0.75,
		getSessionSnapshot: options.getSessionSnapshot,
		refreshSession: () => refreshClient.auth.refreshSession.mutate(),
		onRefreshSuccess: async (result) => {
			await options.storeRefreshedToken(result.token);
		},
	});

	return async (url: string | URL, requestOptions?: RequestInit) => {
		const [serverUrl, authToken, clientId] = await Promise.all([
			options.getServerUrl(),
			refreshManager.getToken(),
			options.getClientId?.() ?? Promise.resolve(null),
		]);
		const resolvedUrl = buildTrpcUrl(serverUrl, url as string);
		const headers = await createAuthHeaders({
			baseHeaders: requestOptions?.headers,
			token: authToken,
			clientId,
			appPlatform: options.appPlatform,
		});

		const response = await fetch(resolvedUrl, {
			...requestOptions,
			credentials: "include",
			headers,
		});

		const sessionExpiryHeader = response.headers.get("X-Session-Expires");
		if (sessionExpiryHeader) {
			refreshManager.recordSessionExpiry(sessionExpiryHeader);
		}

		return response;
	};
}

export function createSessionRefreshingTrpcClient(
	options: SessionRefreshingFetchOptions,
) {
	const sessionRefreshingFetch = createSessionRefreshingTrpcFetch(options);

	return createAppTrpcClient({
		serverUrl: options.defaultServerUrl,
		fetch: sessionRefreshingFetch,
	});
}