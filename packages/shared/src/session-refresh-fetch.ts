import {
	type RefreshResult,
	SessionRefreshManager,
	type SessionSnapshot,
} from "./session-refresh";

export interface SessionRefreshingFetchOptions {
	getSessionSnapshot: () => Promise<SessionSnapshot>;
	refreshSession: () => Promise<RefreshResult>;
	onRefreshSuccess?: (result: RefreshResult) => Promise<void> | void;
	resolveUrl?: (url: RequestInfo | URL) => Promise<string> | string;
	getClientId?: () => Promise<string | null>;
	thresholdRatio?: number;
	/** Platform identifier sent as X-App-Platform header (e.g. 'desktop', 'ios', 'android') */
	appPlatform?: string;
	fetchImpl?: typeof fetch;
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

export function createSessionRefreshingFetch(
	options: SessionRefreshingFetchOptions,
): (url: RequestInfo | URL, requestOptions?: RequestInit) => Promise<Response> {
	const refreshManager = new SessionRefreshManager({
		thresholdRatio: options.thresholdRatio ?? 0.75,
		getSessionSnapshot: options.getSessionSnapshot,
		refreshSession: options.refreshSession,
		onRefreshSuccess: options.onRefreshSuccess,
	});
	const fetchImpl = options.fetchImpl ?? fetch;

	return async (url: RequestInfo | URL, requestOptions?: RequestInit) => {
		const [resolvedUrl, authToken, clientId] = await Promise.all([
			options.resolveUrl?.(url) ?? Promise.resolve(getRequestUrl(url)),
			refreshManager.getToken(),
			options.getClientId?.() ?? Promise.resolve(null),
		]);
		const headers = await createAuthHeaders({
			baseHeaders: requestOptions?.headers,
			token: authToken,
			clientId,
			appPlatform: options.appPlatform,
		});

		const response = await fetchImpl(resolvedUrl, {
			...requestOptions,
			headers,
		});

		const sessionExpiryHeader = response.headers.get("X-Session-Expires");
		if (sessionExpiryHeader) {
			refreshManager.recordSessionExpiry(sessionExpiryHeader);
		}

		return response;
	};
}
