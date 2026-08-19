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
 * Builds the client a password unlock talks to: the stored auth token when one exists, an
 * unauthenticated client for the account's server when it does not.
 *
 * A missing token is the *normal* state here, not a failure. `AccountStore.clearSession`
 * drops `jwt_token` on every lock and deliberately keeps `session_data`, so quick unlock
 * nearly always runs without a token — it re-runs SRP against `startLogin`/`finishLogin`,
 * neither of which is authenticated, and mints a fresh one. Refusing to build a client
 * without a token would make locking an account indistinguishable from signing out of it.
 */
export async function createStoredAccountUnlockApiClient(
	storage: AccountStore,
	accountId: string,
): Promise<DefaultApiClient> {
	const [authToken, account, serverUrl] = await Promise.all([
		storage.getAuthToken(accountId),
		storage.getAccountMetadata(accountId),
		storage.getServerUrl(accountId),
	]);
	const resolvedServerUrl = serverUrl || getDefaultServerUrl();
	const metadata = {
		insecureTransportConfirmed: account?.insecureTransportConfirmed === true,
	};

	if (!authToken) {
		return createApiClientForServer(resolvedServerUrl, undefined, metadata);
	}
	return createAccountApiClient(
		authToken,
		resolvedServerUrl,
		undefined,
		undefined,
		metadata,
	);
}

export { createAccountApiClient, createApiClientForServer };
