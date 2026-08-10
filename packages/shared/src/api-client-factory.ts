import type { ApiClientPlatform } from "@bittery/api-contract";
import { type AppApiClient, createAppApiClient } from "./api-client";
import {
	createSessionRefreshingApiClient,
	type SessionRefreshingApiClientOptions,
} from "./api-session-refresh";
import { normalizeServerUrl } from "./server-url";
import type { SessionSnapshot } from "./session-refresh";

interface AccountStoreLike {
	getUnlockedAccounts(): Promise<string[]>;
	getAuthToken(email: string): Promise<string | null>;
	getServerUrl(email: string): Promise<string | null>;
}

export interface AccountApiClientMetadataOptions {
	clientPlatform?: string;
	clientVersion?: string;
}

export interface AccountSessionRefreshOptions {
	getSessionSnapshot: () => Promise<SessionSnapshot>;
	getRefreshToken: () => Promise<string | null>;
	storeRefreshedSession: SessionRefreshingApiClientOptions["storeRefreshedSession"];
	thresholdRatio?: number;
	appPlatform?: string;
}

const clientCache = new Map<string, AppApiClient>();

function getRuntimeClientId(): string | undefined {
	const globalClientId = (globalThis as { __BITTERY_SYNC_CLIENT_ID__?: string })
		.__BITTERY_SYNC_CLIENT_ID__;
	if (globalClientId) return globalClientId;
	if (typeof window === "undefined") return undefined;

	try {
		return window.localStorage.getItem("bittery_sync_client_id") ?? undefined;
	} catch {
		return undefined;
	}
}

function createClientId(): string {
	if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
	return `00000000-0000-4000-8000-${Date.now().toString(16).padStart(12, "0")}`;
}

function resolveClientId(clientId?: string): string {
	const resolved = clientId ?? getRuntimeClientId() ?? createClientId();
	if (typeof window !== "undefined" && !getRuntimeClientId()) {
		try {
			window.localStorage.setItem("bittery_sync_client_id", resolved);
		} catch {
			// The generated ID remains valid for this process when storage is unavailable.
		}
	}
	return resolved;
}

function normalizePlatform(value?: string): ApiClientPlatform {
	if (value === "desktop" || value === "extension" || value === "web") {
		return value;
	}
	if (value === "mobile" || value === "ios" || value === "android") {
		return "mobile";
	}
	return "web";
}

function getClientVersion(value?: string): string {
	return (
		value ??
		import.meta.env?.VITE_APP_VERSION ??
		(typeof process !== "undefined"
			? process.env.VITE_APP_VERSION
			: undefined) ??
		"0.0.0"
	);
}

export function getDefaultServerUrl(): string {
	return (
		normalizeServerUrl(import.meta.env?.VITE_SERVER_URL) ??
		normalizeServerUrl(
			typeof process !== "undefined" ? process.env.VITE_SERVER_URL : null,
		) ??
		(typeof window !== "undefined"
			? normalizeServerUrl(window.location?.origin)
			: null) ??
		"http://localhost:3000"
	);
}

function resolveServerUrl(serverUrl?: string | null): string {
	return normalizeServerUrl(serverUrl) ?? getDefaultServerUrl();
}

function cacheKey(
	authToken: string | null,
	serverUrl: string,
	clientId: string,
	mode: "static" | "session-refresh",
): string {
	return `${serverUrl}:${authToken ?? ""}:${clientId}:${mode}`;
}

export function createAccountApiClient(
	authToken: string,
	serverUrl?: string | null,
	clientId?: string,
	sessionRefresh?: AccountSessionRefreshOptions,
	metadata?: AccountApiClientMetadataOptions,
): AppApiClient {
	const resolvedServerUrl = resolveServerUrl(serverUrl);
	const resolvedClientId = resolveClientId(clientId);
	const clientPlatform = normalizePlatform(
		metadata?.clientPlatform ?? sessionRefresh?.appPlatform,
	);
	const clientVersion = getClientVersion(metadata?.clientVersion);
	const mode = sessionRefresh ? "session-refresh" : "static";
	const key = cacheKey(authToken, resolvedServerUrl, resolvedClientId, mode);
	const cached = clientCache.get(key);
	if (cached) return cached;

	const client = sessionRefresh
		? createSessionRefreshingApiClient({
				defaultServerUrl: resolvedServerUrl,
				getSessionSnapshot: sessionRefresh.getSessionSnapshot,
				getRefreshToken: sessionRefresh.getRefreshToken,
				storeRefreshedSession: sessionRefresh.storeRefreshedSession,
				getClientId: async () => resolvedClientId,
				clientPlatform,
				clientVersion,
			})
		: createAppApiClient({
				serverUrl: resolvedServerUrl,
				supportedApiMajors: [1],
				getAccessToken: () => authToken,
				getClientMetadata: () => ({
					id: resolvedClientId,
					platform: clientPlatform,
					version: clientVersion,
				}),
			});

	clientCache.set(key, client);
	return client;
}

export function clearAccountApiClient(
	authToken: string,
	serverUrl?: string | null,
	clientId?: string,
) {
	const resolvedServerUrl = resolveServerUrl(serverUrl);
	const resolvedClientId = resolveClientId(clientId);
	clientCache.delete(
		cacheKey(authToken, resolvedServerUrl, resolvedClientId, "static"),
	);
	clientCache.delete(
		cacheKey(authToken, resolvedServerUrl, resolvedClientId, "session-refresh"),
	);
}

export function clearApiClientCache() {
	clientCache.clear();
}

export function createApiClientForServer(
	serverUrl: string,
	clientId?: string,
	metadata?: AccountApiClientMetadataOptions,
): AppApiClient {
	const resolvedServerUrl = resolveServerUrl(serverUrl);
	const resolvedClientId = resolveClientId(clientId);
	const key = cacheKey(null, resolvedServerUrl, resolvedClientId, "static");
	const cached = clientCache.get(key);
	if (cached) return cached;

	const client = createAppApiClient({
		serverUrl: resolvedServerUrl,
		supportedApiMajors: [1],
		getClientMetadata: () => ({
			id: resolvedClientId,
			platform: normalizePlatform(metadata?.clientPlatform),
			version: getClientVersion(metadata?.clientVersion),
		}),
	});
	clientCache.set(key, client);
	return client;
}

export async function createAllAccountApiClients(
	storage: AccountStoreLike,
	clientId?: string,
): Promise<Map<string, AppApiClient>> {
	const accountIds = await storage.getUnlockedAccounts();
	const clients = new Map<string, AppApiClient>();

	for (const accountId of accountIds) {
		const authToken = await storage.getAuthToken(accountId);
		if (!authToken) continue;
		clients.set(
			accountId,
			createAccountApiClient(
				authToken,
				await storage.getServerUrl(accountId),
				clientId,
			),
		);
	}

	return clients;
}
