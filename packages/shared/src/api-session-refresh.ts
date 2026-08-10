import {
	type ApiClientMetadata,
	type ApiClientPlatform,
	createApiClient,
} from "@bittery/api-contract";
import type { AppApiClient } from "./api-client";
import {
	type RefreshResult,
	SessionRefreshManager,
	type SessionSnapshot,
} from "./session-refresh";

export interface SessionRefreshingApiClientOptions {
	defaultServerUrl: string;
	getServerUrl?: () => Promise<string>;
	getSessionSnapshot: () => Promise<SessionSnapshot>;
	getRefreshToken: () => Promise<string | null>;
	storeRefreshedSession: (session: RefreshResult) => Promise<void>;
	getClientId: () => Promise<string>;
	clientPlatform: ApiClientPlatform;
	clientVersion: string;
	supportedApiMajors?: readonly number[];
}

async function resolveRequestServer(
	request: Request,
	options: SessionRefreshingApiClientOptions,
): Promise<Response> {
	const serverUrl = await options.getServerUrl?.();
	if (!serverUrl) {
		return fetch(request);
	}

	const target = new URL(request.url);
	const server = new URL(serverUrl);
	const serverPath = server.pathname.replace(/\/$/, "");
	target.protocol = server.protocol;
	target.host = server.host;
	target.pathname = `${serverPath}${target.pathname}`;
	return fetch(new Request(target, request));
}

function metadata(options: SessionRefreshingApiClientOptions) {
	return async (): Promise<ApiClientMetadata> => ({
		id: await options.getClientId(),
		platform: options.clientPlatform,
		version: options.clientVersion,
	});
}

export function createSessionRefreshingApiClient(
	options: SessionRefreshingApiClientOptions,
): AppApiClient {
	const supportedApiMajors = options.supportedApiMajors ?? [1];
	const refreshClient = createApiClient({
		serverUrl: options.defaultServerUrl,
		supportedApiMajors,
		getAccessToken: options.getRefreshToken,
		getClientMetadata: metadata(options),
		fetch: (request) => resolveRequestServer(request, options),
	});
	const refreshManager = new SessionRefreshManager({
		getSessionSnapshot: options.getSessionSnapshot,
		refreshSession: async () =>
			(await refreshClient.auth.sessions.refresh()).data,
		onRefreshSuccess: options.storeRefreshedSession,
	});

	return createApiClient({
		serverUrl: options.defaultServerUrl,
		supportedApiMajors,
		getAccessToken: () => refreshManager.getToken(),
		getClientMetadata: metadata(options),
		fetch: (request) => resolveRequestServer(request, options),
		onSessionExpires: (expiresAt) =>
			refreshManager.recordSessionExpiry(expiresAt),
		onSessionRefreshRequired: async () => {
			await refreshManager.refreshNow();
		},
	});
}
