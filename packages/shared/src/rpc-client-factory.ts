import { buildRpcUrl, normalizeServerUrl } from "./server-url";
import type { SessionSnapshot } from "./session-refresh";
import { createAppRpcClient } from "./rpc-client";
import { createSessionRefreshingRpcClient } from "./rpc-session-refresh";

interface IStorageAdapter {
	getUnlockedAccounts?: () => Promise<string[]>;
	getAuthToken(email: string): Promise<string | null>;
	getServerUrl(email: string): Promise<string | null>;
}

const DEFAULT_SERVER_URL =
	normalizeServerUrl(
		typeof process !== "undefined"
			? process.env.VITE_SERVER_URL
			: import.meta.env?.VITE_SERVER_URL,
	) ?? "http://localhost:3000";

type AppRpcClient = ReturnType<typeof createAppRpcClient>;

const clientCache = new Map<string, AppRpcClient>();

function getRequestUrl(input: RequestInfo | URL): string {
	if (typeof input === "string") {
		return input;
	}
	if (input instanceof URL) {
		return input.toString();
	}
	return input.url;
}

function getCacheKey(
	authToken: string,
	serverUrl: string,
	clientId?: string,
	mode: "static" | "session-refresh" = "static",
): string {
	return `${serverUrl}:${authToken}:${clientId ?? ""}:${mode}`;
}

interface AccountSessionRefreshOptions {
	getSessionSnapshot: () => Promise<SessionSnapshot>;
	getRefreshToken: () => Promise<string | null>;
	storeRefreshedSession: (session: {
		token: string;
		sessionId: string;
		expiresAt: string | Date;
	}) => Promise<void>;
	thresholdRatio?: number;
}

function getRuntimeClientId(): string | undefined {
	const globalClientId = (globalThis as { __BITTERY_SYNC_CLIENT_ID__?: string })
		.__BITTERY_SYNC_CLIENT_ID__;
	if (globalClientId) {
		return globalClientId;
	}

	if (typeof window === "undefined") {
		return undefined;
	}

	try {
		const clientId = window.localStorage.getItem("bittery_sync_client_id");
		return clientId ?? undefined;
	} catch {
		return undefined;
	}
}

export function createAccountRpcClient(
	authToken: string,
	serverUrl: string,
	clientId?: string,
	sessionRefresh?: AccountSessionRefreshOptions,
): AppRpcClient {
	const normalizedUrl = normalizeServerUrl(serverUrl) ?? DEFAULT_SERVER_URL;
	const resolvedClientId = clientId ?? getRuntimeClientId();
	const mode = sessionRefresh ? "session-refresh" : "static";
	const cacheKey = getCacheKey(
		authToken,
		normalizedUrl,
		resolvedClientId,
		mode,
	);

	const cachedClient = clientCache.get(cacheKey);
	if (cachedClient) {
		return cachedClient;
	}

	const client = sessionRefresh
		? createSessionRefreshingRpcClient({
				defaultServerUrl: normalizedUrl,
				getServerUrl: async () => normalizedUrl,
				getSessionSnapshot: sessionRefresh.getSessionSnapshot,
				getRefreshToken: sessionRefresh.getRefreshToken,
				storeRefreshedSession: sessionRefresh.storeRefreshedSession,
				getClientId: resolvedClientId
					? async () => resolvedClientId
					: undefined,
				thresholdRatio: sessionRefresh.thresholdRatio,
			})
		: createAppRpcClient({
				serverUrl: normalizedUrl,
				headers: {
					Authorization: `Bearer ${authToken}`,
					...(resolvedClientId ? { "X-Client-Id": resolvedClientId } : {}),
				},
				fetch: (url, options) => {
					const resolvedUrl = buildRpcUrl(normalizedUrl, getRequestUrl(url));
					return fetch(resolvedUrl, options);
				},
			});

	clientCache.set(cacheKey, client);

	return client;
}

export function clearAccountRpcClient(
	authToken: string,
	serverUrl: string,
	clientId?: string,
) {
	const normalizedUrl = normalizeServerUrl(serverUrl) ?? DEFAULT_SERVER_URL;
	const resolvedClientId = clientId ?? getRuntimeClientId();
	const staticCacheKey = getCacheKey(
		authToken,
		normalizedUrl,
		resolvedClientId,
		"static",
	);
	const refreshCacheKey = getCacheKey(
		authToken,
		normalizedUrl,
		resolvedClientId,
		"session-refresh",
	);
	clientCache.delete(staticCacheKey);
	clientCache.delete(refreshCacheKey);
}

export function clearRpcClientCache() {
	clientCache.clear();
}

export function createRpcClientForServer(serverUrl: string): AppRpcClient {
	const normalizedUrl = normalizeServerUrl(serverUrl) ?? DEFAULT_SERVER_URL;
	const cacheKey = `unauthenticated:${normalizedUrl}`;

	const cachedClient = clientCache.get(cacheKey);
	if (cachedClient) {
		return cachedClient;
	}

	const client = createAppRpcClient({
		serverUrl: normalizedUrl,
		fetch: (url, options) => {
			const resolvedUrl = buildRpcUrl(normalizedUrl, getRequestUrl(url));
			return fetch(resolvedUrl, options);
		},
	});

	clientCache.set(cacheKey, client);
	return client;
}

export async function createAllAccountRpcClients(
	storage: IStorageAdapter,
	clientId?: string,
): Promise<Map<string, ReturnType<typeof createAccountRpcClient>>> {
	const unlockedEmails = await storage.getUnlockedAccounts?.();

	if (!unlockedEmails || unlockedEmails.length === 0) {
		return new Map();
	}

	const clients = new Map();

	for (const email of unlockedEmails) {
		const authToken = await storage.getAuthToken(email);
		if (!authToken) {
			console.warn(
				`[rpc-client-factory] No auth token found for account: ${email}`,
			);
			continue;
		}

		const serverUrl = (await storage.getServerUrl(email)) ?? DEFAULT_SERVER_URL;
		const client = createAccountRpcClient(authToken, serverUrl, clientId);

		clients.set(email, client);
	}

	return clients;
}