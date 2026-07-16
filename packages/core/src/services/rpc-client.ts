/**
 * Single home for building account-scoped RPC clients from stored credentials.
 *
 * Two flavors, both reading auth token + server URL from `storage`:
 * - `createStoredAccountRpcClient` — session-refreshing. Wires up
 *   `getSessionSnapshot`/`getRefreshToken`/`storeRefreshedSession` so the
 *   client can silently refresh an expiring session. Used by any long-lived
 *   flow (item/vault operations, account metadata sync, biometric unlock).
 * - `createStaticStoredAccountRpcClient` — a plain, non-refreshing client.
 *   Used by quick-unlock flows where a session doesn't exist yet (that's the
 *   whole point of unlocking), so there is nothing to refresh against.
 *
 * Do not merge these two modes: refreshing depends on a live session already
 * existing, which isn't true during quick unlock.
 */

import {
	createAccountRpcClient,
	createRpcClientForServer,
	getDefaultServerUrl,
} from "@bittery/shared/rpc-client-factory";
import type { IStorageAdapter } from "@bittery/storage/adapter";

export type DefaultRpcClient = ReturnType<typeof createAccountRpcClient>;

/**
 * Builds a session-refreshing RPC client for `accountId` from stored
 * credentials. Returns `null` when there is no stored auth token.
 */
export async function createStoredAccountRpcClient(
	storage: IStorageAdapter,
	accountId: string,
	clientId?: string,
): Promise<DefaultRpcClient | null> {
	const [authToken, serverUrl] = await Promise.all([
		storage.getAuthToken(accountId),
		storage.getServerUrl(accountId),
	]);

	if (!authToken) {
		return null;
	}

	const resolvedServerUrl = serverUrl || getDefaultServerUrl();
	return createAccountRpcClient(authToken, resolvedServerUrl, clientId, {
		getSessionSnapshot: async () => {
			const [token, sessionData] = await Promise.all([
				storage.getAuthToken(accountId),
				storage.getStoredSessionData?.(accountId),
			]);
			return {
				token,
				issuedAt: sessionData?.createdAt ?? null,
				expiresAt: sessionData?.expiresAt ?? null,
			};
		},
		getRefreshToken: () => storage.getAuthToken(accountId),
		storeRefreshedSession: async ({ token, sessionId, expiresAt }) => {
			await storage.storeAuthToken(token, accountId);
			await storage.updateStoredSessionMetadata?.(accountId, {
				sessionId,
				expiresAt,
			});
		},
		appPlatform: storage.platform,
	});
}

/**
 * Builds a STATIC (non-refreshing) RPC client for `accountId` from stored
 * credentials. Used by quick-unlock flows, which run before a session
 * exists. Returns `undefined` when there is no stored auth token.
 */
export async function createStaticStoredAccountRpcClient(
	storage: IStorageAdapter,
	accountId: string,
): Promise<DefaultRpcClient | undefined> {
	const authToken = await storage.getAuthToken(accountId);
	if (!authToken) {
		return undefined;
	}
	const serverUrl =
		(await storage.getServerUrl?.(accountId)) || getDefaultServerUrl();
	return createAccountRpcClient(authToken, serverUrl);
}

export { createAccountRpcClient, createRpcClientForServer };
