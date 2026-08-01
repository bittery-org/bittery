import { createAppRpcClient } from "./rpc-client";
import { createSessionRefreshingRpcClient } from "./rpc-session-refresh";
import { buildRpcUrl, normalizeServerUrl } from "./server-url";
import type { SessionSnapshot } from "./session-refresh";

/**
 * The slice of `AccountStore` this module needs, declared structurally because
 * `@bittery/storage` depends on `@bittery/shared` and not the other way round.
 *
 * Every member is required: `AccountStore` is a total interface, so an optional
 * member here would only re-create feature detection.
 */
interface AccountStoreLike {
	getUnlockedAccounts(): Promise<string[]>;
	getAuthToken(email: string): Promise<string | null>;
	getServerUrl(email: string): Promise<string | null>;
}

export function getDefaultServerUrl(): string {
	return (
		normalizeServerUrl(import.meta.env?.VITE_SERVER_URL) ??
		normalizeServerUrl(
			typeof process !== "undefined" ? process.env.VITE_SERVER_URL : null,
		) ??
		(typeof window !== "undefined"
			? normalizeServerUrl(window.location.origin)
			: null) ??
		"http://localhost:3000"
	);
}

function resolveServerUrl(serverUrl?: string | null): string {
	return normalizeServerUrl(serverUrl) ?? getDefaultServerUrl();
}

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
	appPlatform?: string;
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
	serverUrl?: string | null,
	clientId?: string,
	sessionRefresh?: AccountSessionRefreshOptions,
): AppRpcClient {
	const normalizedUrl = resolveServerUrl(serverUrl);
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
				appPlatform: sessionRefresh.appPlatform,
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
	serverUrl?: string | null,
	clientId?: string,
) {
	const normalizedUrl = resolveServerUrl(serverUrl);
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
	const normalizedUrl = resolveServerUrl(serverUrl);
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
	storage: AccountStoreLike,
	clientId?: string,
): Promise<Map<string, ReturnType<typeof createAccountRpcClient>>> {
	const unlockedAccountIds = await storage.getUnlockedAccounts();

	if (unlockedAccountIds.length === 0) {
		return new Map();
	}

	const clients = new Map<string, ReturnType<typeof createAccountRpcClient>>();

	for (const accountId of unlockedAccountIds) {
		const authToken = await storage.getAuthToken(accountId);
		if (!authToken) {
			console.warn(
				`[rpc-client-factory] No auth token found for account: ${accountId}`,
			);
			continue;
		}

		const serverUrl = await storage.getServerUrl(accountId);
		const client = createAccountRpcClient(authToken, serverUrl, clientId);

		clients.set(accountId, client);
	}

	return clients;
}
