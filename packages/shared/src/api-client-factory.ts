import type { ApiClientPlatform } from "@bittery/api-contract";
import { type AppApiClient, createAppApiClient } from "./api-client";
import { createSessionRefreshingApiClient } from "./api-session-refresh";
import { resolveInsecureTransportPolicy } from "./server-transport-policy";
import { normalizeServerUrl } from "./server-url";
import type { RefreshResult, SessionSnapshot } from "./session-refresh";

interface AccountStoreLike {
	getUnlockedAccounts(): Promise<string[]>;
	getAuthToken(accountId: string): Promise<string | null>;
	getServerUrl(accountId: string): Promise<string | null>;
	getAccountMetadata(accountId: string): Promise<{
		insecureTransportConfirmed?: boolean;
	} | null>;
}

export interface AccountApiClientMetadataOptions {
	clientPlatform?: string;
	clientVersion?: string;
	insecureTransportConfirmed?: boolean;
}

export interface AccountSessionRefreshOptions {
	accountId?: string;
	getSessionSnapshot: () => Promise<SessionSnapshot>;
	storeRefreshedSession: (session: RefreshResult) => Promise<void>;
	thresholdRatio?: number;
	appPlatform?: string;
	getInsecureTransportConfirmed?: () => Promise<boolean>;
}

function getRuntimeClientId(): string | undefined {
	const globalClientId = (globalThis as { __BITTERY_SYNC_CLIENT_ID__?: string })
		.__BITTERY_SYNC_CLIENT_ID__;
	if (globalClientId) return globalClientId;
	if (typeof window === "undefined") return undefined;

	try {
		return window.sessionStorage.getItem("bittery_sync_client_id") ?? undefined;
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
			window.sessionStorage.setItem("bittery_sync_client_id", resolved);
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
	const configuredServerUrl = import.meta.env?.VITE_SERVER_URL;
	if (configuredServerUrl?.trim()) {
		return resolveServerUrl(configuredServerUrl);
	}
	const processServerUrl =
		typeof process !== "undefined" ? process.env.VITE_SERVER_URL : null;
	if (processServerUrl?.trim()) {
		return resolveServerUrl(processServerUrl);
	}
	const windowOrigin =
		typeof window !== "undefined" ? window.location?.origin : null;
	if (windowOrigin?.trim()) {
		return resolveServerUrl(windowOrigin);
	}
	return normalizeServerUrl("http://localhost:3000") ?? "http://localhost:3000";
}

function resolveServerUrl(serverUrl?: string | null): string {
	if (!serverUrl) return getDefaultServerUrl();
	const normalized = normalizeServerUrl(serverUrl, {
		operatorEnabled: true,
		accountConfirmed: true,
	});
	if (!normalized) {
		throw new TypeError(
			"Server URL is invalid or remote HTTP transport is not authorized.",
		);
	}
	return normalized;
}

export function createAccountApiClient(
	authToken: string,
	serverUrl?: string | null,
	clientId?: string,
	sessionRefresh?: AccountSessionRefreshOptions,
	metadata?: AccountApiClientMetadataOptions,
): AppApiClient {
	const insecureTransportConfirmed =
		metadata?.insecureTransportConfirmed === true;
	const resolvedServerUrl = resolveServerUrl(serverUrl);
	const resolvedClientId = resolveClientId(clientId);
	const clientPlatform = normalizePlatform(
		metadata?.clientPlatform ?? sessionRefresh?.appPlatform,
	);
	const clientVersion = getClientVersion(metadata?.clientVersion);
	return sessionRefresh
		? createSessionRefreshingApiClient({
				defaultServerUrl: resolvedServerUrl,
				getAccountSnapshot: async (originAccountId) => {
					if (originAccountId && originAccountId !== sessionRefresh.accountId) {
						return null;
					}
					return {
						...(await sessionRefresh.getSessionSnapshot()),
						accountId:
							sessionRefresh.accountId ?? `${resolvedServerUrl}:${authToken}`,
						serverUrl: resolvedServerUrl,
						insecureTransportConfirmed:
							(await sessionRefresh.getInsecureTransportConfirmed?.()) ??
							insecureTransportConfirmed,
					};
				},
				storeRefreshedSession: (_snapshot, session) =>
					sessionRefresh.storeRefreshedSession(session),
				getClientId: async () => resolvedClientId,
				clientPlatform,
				clientVersion,
			})
		: createAppApiClient({
				serverUrl: resolvedServerUrl,
				authorizeInsecureTransport: () =>
					resolveInsecureTransportPolicy({
						serverUrl: resolvedServerUrl,
						accountConfirmed: insecureTransportConfirmed,
					}),
				supportedApiMajors: [1],
				getAccessToken: () => authToken,
				getClientMetadata: () => ({
					id: resolvedClientId,
					platform: clientPlatform,
					version: clientVersion,
				}),
			});
}

export function createApiClientForServer(
	serverUrl: string,
	clientId?: string,
	metadata?: AccountApiClientMetadataOptions,
): AppApiClient {
	const insecureTransportConfirmed =
		metadata?.insecureTransportConfirmed === true;
	const resolvedServerUrl = resolveServerUrl(serverUrl);
	const resolvedClientId = resolveClientId(clientId);
	return createAppApiClient({
		serverUrl: resolvedServerUrl,
		authorizeInsecureTransport: () =>
			resolveInsecureTransportPolicy({
				serverUrl: resolvedServerUrl,
				accountConfirmed: insecureTransportConfirmed,
			}),
		supportedApiMajors: [1],
		getClientMetadata: () => ({
			id: resolvedClientId,
			platform: normalizePlatform(metadata?.clientPlatform),
			version: getClientVersion(metadata?.clientVersion),
		}),
	});
}

export async function createAllAccountApiClients(
	storage: AccountStoreLike,
	clientId?: string,
): Promise<Map<string, AppApiClient>> {
	const accountIds = await storage.getUnlockedAccounts();
	const clients = new Map<string, AppApiClient>();

	for (const accountId of accountIds) {
		const [authToken, account] = await Promise.all([
			storage.getAuthToken(accountId),
			storage.getAccountMetadata(accountId),
		]);
		if (!authToken) continue;
		clients.set(
			accountId,
			createAccountApiClient(
				authToken,
				await storage.getServerUrl(accountId),
				clientId,
				undefined,
				{
					insecureTransportConfirmed:
						account?.insecureTransportConfirmed === true,
				},
			),
		);
	}

	return clients;
}
