/**
 * Sync Cache Service
 *
 * Owns account-scoped sync cache updates in the extension background worker.
 * Responsibilities:
 * - Resolve the account/token/server context used for SSE connection.
 * - Resolve deterministic account candidates for incoming sync events.
 * - Apply delta sync updates to item cache(s) before UI invalidation.
 * - Fall back to global cache updates when account-scoped updates cannot be applied.
 */

import { AccountResolver } from "@bittery/core/services/account-resolver";
import { handleTravelModeSyncEvent } from "@bittery/core/services/travel-mode-sync";
import type { VaultRepositoryCoordinator } from "@bittery/core/services/vault-repository-coordinator";
import type { ApiVaultClient } from "@bittery/core/services/vault-service";
import { createAccountApiClient } from "@bittery/shared/api-client-factory";
import type { ActiveAccountId } from "@bittery/storage/types";
import type {
	DeltaSyncApiClient,
	SyncApiClient,
	SyncEvent,
	SyncItemCache,
} from "@bittery/sync";
import { performDeltaSync } from "@bittery/sync";
import { itemCache, storage } from "../../lib/storage";
import { apiClient } from "../api-client";
import { core } from "../core-instance";
import { desktopClient } from "../desktop-client";

const DEFAULT_SERVER_URL = "http://localhost:3000";

export type SyncConnectionContext = {
	email: string | null;
	serverUrl: string;
	token: string;
};

type VaultKeyLike = {
	vaultId: string;
};

/**
 * The slice of `AccountStore` this service consumes.
 *
 * Every member is required; clearing the cache is not storage's job at all — that goes
 * through `itemCache`.
 */
export interface SyncCacheStorage {
	getActiveAccount: () => Promise<ActiveAccountId>;
	getAccountsList: () => Promise<
		Array<{ accountId: string; email: string; userId?: string }>
	>;
	getAuthToken: (accountId?: string) => Promise<string | null>;
	storeAuthToken: (token: string, accountId?: string) => Promise<void>;
	getServerUrl: (accountId?: string) => Promise<string | null>;
	getVaultKeys: (accountId?: string) => Promise<VaultKeyLike[] | null>;
	getAccountMetadata: (accountId: string) => Promise<{
		email?: string;
		insecureTransportConfirmed?: boolean;
	} | null>;
}

export interface SyncCacheDesktopClient {
	getAuthToken: (email: string) => Promise<string | null>;
	clearCache: () => void;
}

export type SyncEventApiClient = SyncApiClient;

export interface SyncCacheServiceDeps {
	storage: SyncCacheStorage;
	/**
	 * `VaultRepositoryCoordinator` in production. Not the raw `ItemCache`: delta sync also
	 * drives `syncVaultKeys` and `replaceItemId`, which sit above the cache and the crypto.
	 */
	itemCache: SyncItemCache;
	desktopClient: SyncCacheDesktopClient;
	defaultClient: SyncEventApiClient;
	createAccountClient: (
		token: string,
		serverUrl: string,
		insecureTransportConfirmed: boolean,
	) => SyncEventApiClient;
	/**
	 * Mirrors `performDeltaSync` exactly: `(accountScope, serverUrl, accountEmail)`.
	 */
	deltaSync: (
		client: DeltaSyncApiClient,
		cache: SyncItemCache,
		event: SyncEvent,
		accountScope: string,
		serverUrl?: string,
		accountEmail?: string | null,
	) => Promise<void>;
	handleTravelModeSync?: (
		event: SyncEvent,
		accountId: string,
		accountClient: SyncEventApiClient | null,
	) => Promise<void>;
	refreshFromServer: () => Promise<void>;
	logger: Pick<Console, "debug" | "info" | "warn" | "error">;
}

const defaultDeps: SyncCacheServiceDeps = {
	storage,
	itemCache: core.vaultCoordinator,
	desktopClient,
	defaultClient: apiClient,
	createAccountClient: (token, serverUrl, insecureTransportConfirmed) =>
		createAccountApiClient(token, serverUrl, undefined, undefined, {
			insecureTransportConfirmed,
		}),
	deltaSync: performDeltaSync,
	handleTravelModeSync: async (event, accountId, accountClient) => {
		const accounts = new AccountResolver(storage);
		await handleTravelModeSyncEvent(
			event,
			accountId,
			storage,
			itemCache,
			core.vaultCoordinator as VaultRepositoryCoordinator,
			accountClient
				? {
						apiClient: accountClient as unknown as ApiVaultClient,
						accounts,
					}
				: undefined,
		);
	},
	refreshFromServer: async () => {
		const accounts = await new AccountResolver(
			storage,
		).resolveUnlockedAccounts();
		await core.vaultCoordinator.refreshFromServer(accounts);
	},
	logger: console,
};

function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

function uniqueAccountIds(accountIds: string[]): string[] {
	return Array.from(new Set(accountIds));
}

function buildOrderedCandidates(
	preferredAccountId: string | null,
	allAccountIds: string[],
): string[] {
	const uniqueOrdered = uniqueAccountIds(allAccountIds);
	if (!preferredAccountId) {
		return uniqueOrdered;
	}

	const withoutPreferred = uniqueOrdered.filter(
		(accountId) => accountId !== preferredAccountId,
	);
	return [preferredAccountId, ...withoutPreferred];
}

function shouldClearDesktopCacheForEvent(event: SyncEvent): boolean {
	return event.type.startsWith("item_") || event.type.startsWith("vault_");
}

export interface SyncCacheService {
	resolveConnectionContext: () => Promise<SyncConnectionContext | null>;
	getClientForEmail: (email?: string | null) => Promise<SyncEventApiClient>;
	resolveCandidateAccountIdsForEvent: (event: SyncEvent) => Promise<string[]>;
	applyDeltaSyncForEvent: (event: SyncEvent) => Promise<void>;
	refreshItemCachesForKnownAccounts: () => Promise<void>;
}

export function createSyncCacheService(
	overrides: Partial<SyncCacheServiceDeps> = {},
): SyncCacheService {
	const deps: SyncCacheServiceDeps = {
		...defaultDeps,
		...overrides,
	};

	async function clearItemCacheForAccountId(accountId: string): Promise<void> {
		try {
			await deps.itemCache.clearItemCache(accountId);
		} catch (error) {
			deps.logger.debug(
				`[sync-cache-service] Item cache clear skipped for ${accountId}: ${String(error)}`,
			);
		}
	}

	async function resolveActiveSingleAccountId(): Promise<string | null> {
		return await deps.storage.getActiveAccount();
	}

	async function getAllKnownAccountIds(): Promise<string[]> {
		const accounts = await deps.storage.getAccountsList();
		return uniqueAccountIds(accounts.map((account) => account.accountId));
	}

	async function resolveEmailForAccountId(
		accountId: string,
	): Promise<string | undefined> {
		const metadata = await deps.storage.getAccountMetadata(accountId);
		if (metadata?.email) {
			return metadata.email;
		}

		const accounts = await deps.storage.getAccountsList();
		return accounts.find((account) => account.accountId === accountId)?.email;
	}

	async function getAuthTokenForAccountId(
		accountId: string,
	): Promise<string | null> {
		const localToken = await deps.storage.getAuthToken(accountId);
		if (localToken) {
			return localToken;
		}

		try {
			const email = await resolveEmailForAccountId(accountId);
			if (!email) {
				return null;
			}

			const desktopToken = await deps.desktopClient.getAuthToken(accountId);
			if (!desktopToken) {
				return null;
			}
			await deps.storage.storeAuthToken(desktopToken, accountId);
			return desktopToken;
		} catch {
			// Desktop bridge failures should not block fallback to other accounts.
			return null;
		}
	}

	async function getServerUrlForAccountId(
		accountId?: string | null,
	): Promise<string> {
		if (accountId) {
			const accountScoped = await deps.storage.getServerUrl(accountId);
			if (accountScoped) {
				return accountScoped;
			}
		}

		const globalServerUrl = await deps.storage.getServerUrl();
		return globalServerUrl ?? DEFAULT_SERVER_URL;
	}

	async function getAccountClientForAccountId(
		accountId: string,
	): Promise<SyncEventApiClient | null> {
		const token = await getAuthTokenForAccountId(accountId);
		if (!token) {
			return null;
		}

		const [serverUrl, account] = await Promise.all([
			getServerUrlForAccountId(accountId),
			deps.storage.getAccountMetadata(accountId),
		]);
		return deps.createAccountClient(
			token,
			serverUrl,
			account?.insecureTransportConfirmed === true,
		);
	}

	async function resolveConnectionContext(): Promise<SyncConnectionContext | null> {
		const activeAccountId = await resolveActiveSingleAccountId();
		const knownAccountIds = await getAllKnownAccountIds();
		const candidates = buildOrderedCandidates(activeAccountId, knownAccountIds);

		for (const accountId of candidates) {
			const token = await getAuthTokenForAccountId(accountId);
			if (!token) {
				continue;
			}

			const serverUrl = await getServerUrlForAccountId(accountId);
			const email = await resolveEmailForAccountId(accountId);
			deps.logger.info(
				`[sync-cache-service] Selected account-scoped sync context: ${accountId}`,
			);
			return {
				email: email ? normalizeEmail(email) : null,
				serverUrl,
				token,
			};
		}

		// Compatibility fallback for legacy/global token resolution paths.
		const fallbackToken = await deps.storage.getAuthToken();
		if (!fallbackToken) {
			deps.logger.info(
				"[sync-cache-service] No account-scoped or fallback token available",
			);
			return null;
		}

		const fallbackServerUrl = await getServerUrlForAccountId(null);
		deps.logger.info(
			"[sync-cache-service] Using fallback sync context without explicit account scope",
		);
		return {
			email: null,
			serverUrl: fallbackServerUrl,
			token: fallbackToken,
		};
	}

	async function getClientForEmail(
		email?: string | null,
	): Promise<SyncEventApiClient> {
		if (!email) {
			return deps.defaultClient;
		}

		const normalizedEmail = normalizeEmail(email);
		const accounts = await deps.storage.getAccountsList();
		const matchedAccount = accounts.find(
			(account) => normalizeEmail(account.email) === normalizedEmail,
		);
		if (!matchedAccount) {
			return deps.defaultClient;
		}

		const client = await getAccountClientForAccountId(matchedAccount.accountId);
		return client ?? deps.defaultClient;
	}

	async function resolveCandidateAccountIdsForEvent(
		event: SyncEvent,
	): Promise<string[]> {
		const activeSingleAccountId = await resolveActiveSingleAccountId();
		if (activeSingleAccountId) {
			return [activeSingleAccountId];
		}

		const allAccountIds = await getAllKnownAccountIds();
		if (allAccountIds.length === 0) {
			return [];
		}

		const effectiveVaultId =
			event.vaultId ??
			(event.type === "vault_access_revoked" ? event.entityId : null);
		if (!effectiveVaultId) {
			return allAccountIds;
		}

		const matched: string[] = [];
		for (const accountId of allAccountIds) {
			const vaultKeys = await deps.storage.getVaultKeys(accountId);
			if (
				vaultKeys?.some((vaultKey) => vaultKey.vaultId === effectiveVaultId)
			) {
				matched.push(accountId);
			}
		}

		return matched.length > 0 ? matched : allAccountIds;
	}

	async function resolveTravelModeAccountId(
		event: SyncEvent,
	): Promise<string | null> {
		const ownerUserId = event.userId || event.entityId;
		if (!ownerUserId) {
			return null;
		}

		const accounts = await deps.storage.getAccountsList();
		const matched = accounts.filter(
			(account) => account.userId === ownerUserId,
		);
		const firstMatch = matched.at(0);
		if (firstMatch) {
			if (matched.length > 1) {
				deps.logger.warn(
					`[sync-cache-service] Multiple accounts matched travel_mode_updated user ${ownerUserId}`,
				);
			}
			return firstMatch.accountId;
		}

		deps.logger.warn(
			`[sync-cache-service] No account matched travel_mode_updated user ${ownerUserId}`,
		);

		const onlyAccount = accounts.at(0);
		if (accounts.length === 1 && onlyAccount) {
			return onlyAccount.accountId;
		}

		const metadataEmail =
			typeof event.metadata?.email === "string" ? event.metadata.email : null;
		if (metadataEmail) {
			const normalizedMetadataEmail = normalizeEmail(metadataEmail);
			const emailMatches = accounts.filter(
				(account) => normalizeEmail(account.email) === normalizedMetadataEmail,
			);
			const onlyEmailMatch = emailMatches.at(0);
			if (emailMatches.length === 1 && onlyEmailMatch) {
				return onlyEmailMatch.accountId;
			}
		}

		return null;
	}

	async function applyDeltaSyncForEvent(event: SyncEvent): Promise<void> {
		if (event.type === "travel_mode_updated") {
			const accountId = await resolveTravelModeAccountId(event);
			if (!accountId) {
				return;
			}

			deps.logger.debug(
				`[sync-cache-service] Applying travel_mode_updated for account: ${accountId}`,
			);

			try {
				const accountClient = await getAccountClientForAccountId(accountId);
				await deps.handleTravelModeSync?.(event, accountId, accountClient);
			} catch (error) {
				deps.logger.warn(
					`[sync-cache-service] Travel mode sync failed for ${accountId}`,
					error,
				);
			}
			return;
		}

		const candidateAccountIds = await resolveCandidateAccountIdsForEvent(event);

		deps.logger.debug(
			`[sync-cache-service] Applying ${event.type} for candidate accounts: ${
				candidateAccountIds.join(", ") || "(global)"
			}`,
		);

		// `ItemCache` requires an accountId for every write. With no known account there is
		// nothing to scope the delta to, so drop it rather than guess.
		if (candidateAccountIds.length === 0) {
			deps.logger.warn(
				`[sync-cache-service] Dropping ${event.type}: no known account to scope the cache write to`,
			);
			if (shouldClearDesktopCacheForEvent(event)) {
				deps.desktopClient.clearCache();
			}
			return;
		}

		let applied = 0;
		for (const accountId of candidateAccountIds) {
			try {
				const accountClient = await getAccountClientForAccountId(accountId);
				if (!accountClient) {
					deps.logger.debug(
						`[sync-cache-service] Skipping ${accountId} (no token available)`,
					);
					continue;
				}

				const email = await resolveEmailForAccountId(accountId);
				// `accountId` is the cache scope; the email only decorates the cached item.
				await deps.deltaSync(
					accountClient,
					deps.itemCache,
					event,
					accountId,
					await getServerUrlForAccountId(accountId),
					email ? normalizeEmail(email) : undefined,
				);
				applied++;
			} catch (error) {
				deps.logger.warn(
					`[sync-cache-service] Delta sync failed for ${accountId} (${event.type})`,
					error,
				);
			}
		}

		// Invalidating the candidates' caches is the correct fallback when no account-scoped
		// delta applied — the next read re-bootstraps them from the server.
		if (applied === 0) {
			deps.logger.warn(
				`[sync-cache-service] No account-scoped delta applied for ${event.type}; clearing candidate caches so the next read re-bootstraps`,
			);
			await Promise.all(
				candidateAccountIds.map((accountId) =>
					clearItemCacheForAccountId(accountId),
				),
			);
		}

		if (shouldClearDesktopCacheForEvent(event)) {
			deps.desktopClient.clearCache();
		}
	}

	async function refreshItemCachesForKnownAccounts(): Promise<void> {
		await deps.refreshFromServer();
	}

	return {
		resolveConnectionContext,
		getClientForEmail,
		resolveCandidateAccountIdsForEvent,
		applyDeltaSyncForEvent,
		refreshItemCachesForKnownAccounts,
	};
}

export const syncCacheService = createSyncCacheService();
