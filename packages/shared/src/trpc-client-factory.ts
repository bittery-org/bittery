/**
 * Per-Account tRPC Client Factory
 *
 * Creates tRPC clients for specific accounts with their JWT tokens.
 * This is necessary for multi-account operations because the API uses
 * ctx.session.userId from the JWT to determine which user's data to return.
 *
 * IMPORTANT: This is separate from the default tRPC client in providers.tsx,
 * which always uses the active account's token. Use this factory when you
 * need to fetch data from a specific account that may not be active.
 */

import type { AppRouter } from "@bittery/api/routers/index";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { buildTrpcUrl, normalizeServerUrl } from "./server-url";

// Forward declare to avoid circular dependency with @bittery/storage
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

/**
 * Cache for tRPC clients to avoid creating new instances on every call.
 * Key format: `${serverUrl}:${authToken}`
 */
const clientCache = new Map<
	string,
	ReturnType<typeof createTRPCClient<AppRouter>>
>();

/**
 * Generate cache key for tRPC client.
 */
function getCacheKey(authToken: string, serverUrl: string): string {
	return `${serverUrl}:${authToken}`;
}

/**
 * Create a tRPC client for a specific account.
 *
 * This is needed for multi-account operations since the API uses
 * the JWT token to determine which user's data to return.
 *
 * NOTE: This is separate from the default tRPC client in providers.tsx,
 * which always uses the active account's token. Use this factory when
 * you need to fetch data from a specific account that may not be active.
 *
 * Clients are cached to avoid creating new instances on every call.
 * Use `clearTrpcClientCache()` to clear the cache on logout.
 *
 * @param authToken - JWT token for the specific account
 * @param serverUrl - API server URL (defaults to env variable or localhost:3000)
 * @returns tRPC client configured for this account
 */
export function createAccountTrpcClient(authToken: string, serverUrl: string) {
	const normalizedUrl = normalizeServerUrl(serverUrl) ?? DEFAULT_SERVER_URL;
	const cacheKey = getCacheKey(authToken, normalizedUrl);

	// Return cached client if exists
	const cachedClient = clientCache.get(cacheKey);
	if (cachedClient) {
		return cachedClient;
	}

	// Create new client
	const client = createTRPCClient<AppRouter>({
		links: [
			httpBatchLink({
				url: `${normalizedUrl}/trpc`,
				headers: {
					Authorization: `Bearer ${authToken}`,
				},
				fetch: (url, options) => {
					const resolvedUrl = buildTrpcUrl(normalizedUrl, url as string);
					return fetch(resolvedUrl, {
						...options,
						credentials: "include",
					});
				},
			}),
		],
	});

	// Cache the client
	clientCache.set(cacheKey, client);

	return client;
}

/**
 * Clear a specific account's tRPC client from cache.
 * Call this when a user logs out of a specific account.
 *
 * @param authToken - JWT token for the account
 * @param serverUrl - API server URL
 */
export function clearAccountTrpcClient(authToken: string, serverUrl: string) {
	const normalizedUrl = normalizeServerUrl(serverUrl) ?? DEFAULT_SERVER_URL;
	const cacheKey = getCacheKey(authToken, normalizedUrl);
	clientCache.delete(cacheKey);
}

/**
 * Clear all cached tRPC clients.
 * Call this on full logout or when switching between completely different sets of accounts.
 */
export function clearTrpcClientCache() {
	clientCache.clear();
}

/**
 * Create tRPC clients for all unlocked accounts.
 * Returns a map of email → tRPC client.
 *
 * This is used by hooks like useAllAccountsItems() to fetch data from
 * multiple accounts concurrently, each with their own JWT token.
 *
 * @param storage - Storage adapter instance
 * @returns Map of account email to tRPC client
 */
export async function createAllAccountTrpcClients(
	storage: IStorageAdapter,
): Promise<Map<string, ReturnType<typeof createAccountTrpcClient>>> {
	// Get all unlocked accounts (accounts with MUK in memory)
	const unlockedEmails = await storage.getUnlockedAccounts?.();

	if (!unlockedEmails || unlockedEmails.length === 0) {
		return new Map();
	}

	const clients = new Map();

	// Create a tRPC client for each unlocked account
	for (const email of unlockedEmails) {
		const authToken = await storage.getAuthToken(email);
		if (!authToken) {
			console.warn(
				`[trpc-client-factory] No auth token found for account: ${email}`,
			);
			continue;
		}

		const serverUrl = (await storage.getServerUrl(email)) ?? DEFAULT_SERVER_URL;
		const client = createAccountTrpcClient(authToken, serverUrl);

		clients.set(email, client);
	}

	return clients;
}
