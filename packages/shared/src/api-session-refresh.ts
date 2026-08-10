import {
	type ApiClientMetadata,
	type ApiClientPlatform,
	createApiClient,
} from "@bittery/api-contract";
import type { AppApiClient } from "./api-client";
import {
	isRemoteHttpServer,
	resolveInsecureTransportPolicy,
} from "./server-transport-policy";
import { normalizeServerUrl } from "./server-url";
import type { RefreshResult, SessionSnapshot } from "./session-refresh";

export interface AccountSessionSnapshot extends SessionSnapshot {
	accountId: string;
	serverUrl: string;
	insecureTransportConfirmed: boolean;
}

export interface SessionRefreshingApiClientOptions {
	defaultServerUrl: string;
	getAccountSnapshot: () => Promise<AccountSessionSnapshot | null>;
	storeRefreshedSession: (
		snapshot: AccountSessionSnapshot,
		session: RefreshResult,
	) => Promise<void>;
	getClientId: () => Promise<string>;
	clientPlatform: ApiClientPlatform;
	clientVersion: string;
	supportedApiMajors?: readonly number[];
	thresholdRatio?: number;
	fetch?: (request: Request) => Promise<Response>;
}

interface SessionTiming {
	issuedAt: number | null;
	expiresAt: number | null;
}

const ROUTED_REQUEST_POLICY = {
	operatorEnabled: true,
	accountConfirmed: true,
} as const;

function requireServerUrl(value: string): string {
	const normalized = normalizeServerUrl(value, {
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

function accountKey(snapshot: AccountSessionSnapshot): string {
	return `${snapshot.accountId}\u0000${snapshot.serverUrl}`;
}

function parseExpiry(value: string | Date): number | null {
	const parsed =
		typeof value === "string" ? new Date(value).getTime() : value.getTime();
	return Number.isFinite(parsed) ? parsed : null;
}

function pathWithoutBase(pathname: string, basePathname: string): string {
	const basePath = basePathname.replace(/\/+$/, "");
	if (!basePath || basePath === "/") return pathname;
	if (pathname === basePath) return "/";
	return pathname.startsWith(`${basePath}/`)
		? pathname.slice(basePath.length)
		: pathname;
}

function rewriteRequest(
	request: Request,
	fromServerUrl: string,
	toServerUrl: string,
): Request {
	const target = new URL(request.url);
	const sourceServer = new URL(fromServerUrl);
	const destinationServer = new URL(toServerUrl);
	const relativePath = pathWithoutBase(target.pathname, sourceServer.pathname);
	const serverPath = destinationServer.pathname.replace(/\/+$/, "");
	target.protocol = destinationServer.protocol;
	target.host = destinationServer.host;
	target.pathname = `${serverPath}${relativePath}`;
	return new Request(target, request);
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
	const thresholdRatio = options.thresholdRatio ?? 0.75;
	const defaultServerUrl = requireServerUrl(options.defaultServerUrl);
	const fetchImpl =
		options.fetch ?? ((request: Request) => globalThis.fetch(request));
	const timingByAccount = new Map<string, SessionTiming>();
	const refreshByAccount = new Map<string, Promise<string>>();

	async function authorizeServer(serverUrl: string, accountConfirmed: boolean) {
		return resolveInsecureTransportPolicy({
			serverUrl,
			accountConfirmed,
			fetch: fetchImpl,
		});
	}

	function shouldRefresh(snapshot: AccountSessionSnapshot): boolean {
		if (!snapshot.token) return false;
		const timing = timingByAccount.get(accountKey(snapshot));
		const issuedAt = timing?.issuedAt ?? snapshot.issuedAt;
		const expiresAt = timing?.expiresAt ?? snapshot.expiresAt;
		if (!issuedAt || !expiresAt) return false;
		const lifetime = expiresAt - issuedAt;
		return lifetime > 0 && Date.now() >= issuedAt + lifetime * thresholdRatio;
	}

	async function refreshSnapshot(
		snapshot: AccountSessionSnapshot,
		force: boolean,
	): Promise<string> {
		if (!snapshot.token) return "";
		if (!force && !shouldRefresh(snapshot)) return snapshot.token;

		const key = accountKey(snapshot);
		const existing = refreshByAccount.get(key);
		if (existing) return existing;

		const refresh = (async () => {
			try {
				const serverUrl = requireServerUrl(snapshot.serverUrl);
				const refreshClient = createApiClient({
					serverUrl,
					authorizeInsecureTransport: () =>
						authorizeServer(serverUrl, snapshot.insecureTransportConfirmed),
					supportedApiMajors,
					getAccessToken: () => snapshot.token,
					getClientMetadata: metadata(options),
					fetch: fetchImpl,
				});
				const result = (await refreshClient.auth.sessions.refresh()).data;
				const expiresAt = parseExpiry(result.expiresAt);
				timingByAccount.set(key, {
					issuedAt: Date.now(),
					expiresAt,
				});
				await options.storeRefreshedSession(snapshot, result);
				return result.token;
			} catch {
				return snapshot.token ?? "";
			} finally {
				refreshByAccount.delete(key);
			}
		})();

		refreshByAccount.set(key, refresh);
		return refresh;
	}

	async function accountFetch(request: Request): Promise<Response> {
		if (request.headers.has("Authorization")) {
			let accountConfirmed = false;
			if (isRemoteHttpServer(defaultServerUrl)) {
				const snapshot = await options.getAccountSnapshot();
				accountConfirmed =
					snapshot?.insecureTransportConfirmed === true &&
					requireServerUrl(snapshot.serverUrl) === defaultServerUrl;
			}
			await authorizeServer(defaultServerUrl, accountConfirmed);
			return fetchImpl(request);
		}

		const snapshot = await options.getAccountSnapshot();
		const serverUrl = snapshot
			? requireServerUrl(snapshot.serverUrl)
			: defaultServerUrl;
		await authorizeServer(
			serverUrl,
			snapshot?.insecureTransportConfirmed === true,
		);
		const token = snapshot ? await refreshSnapshot(snapshot, false) : null;
		const routed = rewriteRequest(request, defaultServerUrl, serverUrl);
		const retrySource = routed.clone();
		const headers = new Headers(routed.headers);
		if (token) {
			headers.set("Authorization", `Bearer ${token}`);
		} else {
			headers.delete("Authorization");
		}

		const response = await fetchImpl(new Request(routed, { headers }));
		if (snapshot) {
			const expiresAt = response.headers.get("Bittery-Session-Expires");
			if (expiresAt) {
				timingByAccount.set(accountKey(snapshot), {
					issuedAt:
						timingByAccount.get(accountKey(snapshot))?.issuedAt ??
						snapshot.issuedAt ??
						Date.now(),
					expiresAt: parseExpiry(expiresAt),
				});
			}
			if (
				response.status === 401 &&
				token &&
				!request.url.endsWith("/api/v1/sessions/current/refresh")
			) {
				const refreshedToken = await refreshSnapshot(snapshot, true);
				if (refreshedToken && refreshedToken !== token) {
					const retryHeaders = new Headers(retrySource.headers);
					retryHeaders.set("Authorization", `Bearer ${refreshedToken}`);
					return fetchImpl(new Request(retrySource, { headers: retryHeaders }));
				}
			}
		}
		return response;
	}

	return createApiClient({
		serverUrl: defaultServerUrl,
		// accountFetch gates the routed account URL before it attaches or sends a bearer.
		insecureTransport: ROUTED_REQUEST_POLICY,
		supportedApiMajors,
		getClientMetadata: metadata(options),
		fetch: accountFetch,
	});
}
