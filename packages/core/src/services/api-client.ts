/**
 * Single home for building account-scoped API clients from stored credentials.
 *
 * Two flavors, both reading auth token + server URL from `storage`:
 * - `createStoredAccountApiClient` — session-refreshing. Wires up
 *   `getSessionSnapshot`/`getRefreshToken`/`storeRefreshedSession` so the
 *   client can silently refresh an expiring session. Used by any long-lived
 *   flow (item/vault operations, account metadata sync, biometric unlock).
 * - `createStaticStoredAccountApiClient` — a plain, non-refreshing client.
 *   Used by quick-unlock flows where a session doesn't exist yet (that's the
 *   whole point of unlocking), so there is nothing to refresh against.
 *
 * Do not merge these two modes: refreshing depends on a live session already
 * existing, which isn't true during quick unlock.
 */

import {
	createAccountApiClient,
	createApiClientForServer,
	getDefaultServerUrl,
} from "@bittery/shared/api-client-factory";
import type { AccountStore } from "@bittery/storage";

export type DefaultApiClient = ReturnType<typeof createAccountApiClient>;

/**
 * Builds a session-refreshing API client for `accountId` from stored
 * credentials. Returns `null` when there is no stored auth token.
 */
export async function createStoredAccountApiClient(
	storage: AccountStore,
	accountId: string,
	clientId?: string,
): Promise<DefaultApiClient | null> {
	const [authToken, serverUrl] = await Promise.all([
		storage.getAuthToken(accountId),
		storage.getServerUrl(accountId),
	]);

	if (!authToken) {
		return null;
	}

	const resolvedServerUrl = serverUrl || getDefaultServerUrl();
	return createAccountApiClient(authToken, resolvedServerUrl, clientId, {
		accountId,
		getSessionSnapshot: async () => {
			const [token, sessionData] = await Promise.all([
				storage.getAuthToken(accountId),
				storage.getStoredSessionData(accountId),
			]);
			return {
				token,
				issuedAt: sessionData?.createdAt ?? null,
				expiresAt: sessionData?.expiresAt ?? null,
			};
		},
		storeRefreshedSession: async ({ token, sessionId, expiresAt }) => {
			await storage.storeAuthToken(token, accountId);
			await storage.updateStoredSessionMetadata(accountId, {
				sessionId,
				expiresAt,
			});
		},
		getInsecureTransportConfirmed: async () =>
			(await storage.getAccountMetadata(accountId))
				?.insecureTransportConfirmed === true,
		appPlatform: storage.platform,
	});
}

/**
 * Builds a STATIC (non-refreshing) API client for `accountId` from stored
 * credentials. Used by quick-unlock flows, which run before a session
 * exists. Returns `undefined` when there is no stored auth token.
 */
export async function createStaticStoredAccountApiClient(
	storage: AccountStore,
	accountId: string,
): Promise<DefaultApiClient | undefined> {
	const [authToken, account] = await Promise.all([
		storage.getAuthToken(accountId),
		storage.getAccountMetadata(accountId),
	]);
	if (!authToken) {
		return undefined;
	}
	const serverUrl =
		(await storage.getServerUrl(accountId)) || getDefaultServerUrl();
	return createAccountApiClient(authToken, serverUrl, undefined, undefined, {
		insecureTransportConfirmed: account?.insecureTransportConfirmed === true,
	});
}

/**
 * Builds the unauthenticated client a password-only Quick Unlock ceremony talks to.
 *
 * The previous token is deliberately ignored even when still valid: Quick Unlock always runs
 * `startLogin`/`finishLogin` against this Account's stored Server URL and HTTP consent, then
 * installs the newly issued Session.
 */
export async function createStoredAccountUnlockApiClient(
	storage: AccountStore,
	accountId: string,
): Promise<DefaultApiClient> {
	const [account, serverUrl] = await Promise.all([
		storage.getAccountMetadata(accountId),
		storage.getServerUrl(accountId),
	]);
	if (!serverUrl) {
		throw new Error("Quick Unlock requires the Account's stored Server URL.");
	}
	const metadata = {
		insecureTransportConfirmed: account?.insecureTransportConfirmed === true,
	};

	return createApiClientForServer(serverUrl, undefined, metadata);
}

export { createAccountApiClient, createApiClientForServer };
