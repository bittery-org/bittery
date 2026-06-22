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

import {
	AccountResolver,
	handleTravelModeSyncEvent,
	type RpcVaultClient,
	type VaultRepositoryCoordinator,
} from "@bittery/core";
import { createAccountRpcClient } from "@bittery/shared/rpc-client-factory";
import type {
	DeltaSyncClient,
	ItemCacheAdapter,
	SyncEvent,
} from "@bittery/sync";
import { performDeltaSync } from "@bittery/sync";
import { storage } from "../../lib/storage";
import { core } from "../core-instance";
import { desktopClient } from "../desktop-client";
import { rpcClient } from "../rpc-client";

const DEFAULT_SERVER_URL = "http://localhost:3000";

export type SyncConnectionContext = {
	email: string | null;
	serverUrl: string;
	token: string;
};

type ActiveAccount = { type: "single"; email: string } | { type: "all" } | null;

type VaultKeyLike = {
	vaultId: string;
};

export interface SyncCacheStorage {
	supportsItemCache: boolean;
	getActiveAccount: () => Promise<ActiveAccount>;
	getAccountsList: () => Promise<Array<{ email: string; userId?: string }>>;
	getAuthToken: (email?: string) => Promise<string | null>;
	storeAuthToken: (token: string, email?: string) => Promise<void>;
	getServerUrl: (email?: string) => Promise<string | null>;
	getVaultKeys: (email?: string) => Promise<VaultKeyLike[] | null>;
	clearItemCache?: (email?: string) => Promise<void>;
}

export interface SyncCacheDesktopClient {
	getAuthToken: (email: string) => Promise<string | null>;
	clearCache: () => void;
}

export interface SyncEventQueryClient extends DeltaSyncClient {
	sync: {
		getEventsSince: {
			query: (input: { sinceId?: string | null; limit?: number }) => Promise<{
				events: SyncEvent[];
				hasMore: boolean;
				requiresFullRefresh: boolean;
				cursor: { id: string } | null;
			}>;
		};
	};
}

export interface SyncCacheServiceDeps {
	storage: SyncCacheStorage;
	itemCache: ItemCacheAdapter;
	desktopClient: SyncCacheDesktopClient;
	defaultClient: SyncEventQueryClient;
	createAccountClient: (
		token: string,
		serverUrl: string,
	) => SyncEventQueryClient;
	deltaSync: (
		client: DeltaSyncClient,
		cache: ItemCacheAdapter,
		event: SyncEvent,
		accountEmail?: string,
	) => Promise<void>;
	handleTravelModeSync?: (
		event: SyncEvent,
		email: string,
		accountClient: SyncEventQueryClient | null,
	) => Promise<void>;
	logger: Pick<Console, "debug" | "info" | "warn" | "error">;
}

const defaultDeps: SyncCacheServiceDeps = {
	storage: storage as unknown as SyncCacheStorage,
	itemCache: core.vaultCoordinator,
	desktopClient,
	defaultClient: rpcClient as unknown as SyncEventQueryClient,
	createAccountClient: (token, serverUrl) =>
		createAccountRpcClient(token, serverUrl) as unknown as SyncEventQueryClient,
	deltaSync: performDeltaSync,
	handleTravelModeSync: async (event, email, accountClient) => {
		const accounts = new AccountResolver(storage);
		await handleTravelModeSyncEvent(
			event,
			email,
			storage,
			core.vaultCoordinator as VaultRepositoryCoordinator,
			accountClient
				? {
						rpcClient: accountClient as unknown as RpcVaultClient,
						accounts,
					}
				: undefined,
		);
	},
	logger: console,
};

function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

function uniqueEmails(emails: string[]): string[] {
	return Array.from(new Set(emails.map(normalizeEmail)));
}

function buildOrderedCandidates(
	preferredEmail: string | null,
	allEmails: string[],
): string[] {
	const uniqueOrdered = uniqueEmails(allEmails);
	if (!preferredEmail) {
		return uniqueOrdered;
	}

	const normalizedPreferred = normalizeEmail(preferredEmail);
	const withoutPreferred = uniqueOrdered.filter(
		(email) => email !== normalizedPreferred,
	);
	return [normalizedPreferred, ...withoutPreferred];
}

function shouldClearDesktopCacheForEvent(event: SyncEvent): boolean {
	return event.type.startsWith("item_") || event.type.startsWith("vault_");
}

export interface SyncCacheService {
	resolveConnectionContext: () => Promise<SyncConnectionContext | null>;
	getClientForEmail: (email?: string | null) => Promise<SyncEventQueryClient>;
	resolveCandidateEmailsForEvent: (event: SyncEvent) => Promise<string[]>;
	applyDeltaSyncForEvent: (event: SyncEvent) => Promise<void>;
	clearItemCachesForKnownAccounts: () => Promise<void>;
}

export function createSyncCacheService(
	overrides: Partial<SyncCacheServiceDeps> = {},
): SyncCacheService {
	const deps: SyncCacheServiceDeps = {
		...defaultDeps,
		...overrides,
	};

	async function clearItemCacheForEmail(email?: string): Promise<void> {
		await deps.storage.clearItemCache?.(email);
		if (!deps.itemCache.clearItemCache) {
			return;
		}
		try {
			await deps.itemCache.clearItemCache(email);
		} catch (error) {
			deps.logger.debug(
				`[sync-cache-service] Item cache clear skipped for ${email ?? "global"}: ${String(error)}`,
			);
		}
	}

	async function resolveActiveSingleEmail(): Promise<string | null> {
		const active = await deps.storage.getActiveAccount();
		if (!active || active.type !== "single") {
			return null;
		}
		return normalizeEmail(active.email);
	}

	async function getAllKnownEmails(): Promise<string[]> {
		const accounts = await deps.storage.getAccountsList();
		return uniqueEmails(accounts.map((account) => account.email));
	}

	async function getAuthTokenForEmail(email: string): Promise<string | null> {
		const normalizedEmail = normalizeEmail(email);

		const localToken = await deps.storage.getAuthToken(normalizedEmail);
		if (localToken) {
			return localToken;
		}

		try {
			const desktopToken =
				await deps.desktopClient.getAuthToken(normalizedEmail);
			if (!desktopToken) {
				return null;
			}
			await deps.storage.storeAuthToken(desktopToken, normalizedEmail);
			return desktopToken;
		} catch {
			// Desktop bridge failures should not block fallback to other accounts.
			return null;
		}
	}

	async function getServerUrlForEmail(email?: string | null): Promise<string> {
		if (email) {
			const accountScoped = await deps.storage.getServerUrl(
				normalizeEmail(email),
			);
			if (accountScoped) {
				return accountScoped;
			}
		}

		const globalServerUrl = await deps.storage.getServerUrl();
		return globalServerUrl ?? DEFAULT_SERVER_URL;
	}

	async function getAccountClientForEmail(
		email: string,
	): Promise<SyncEventQueryClient | null> {
		const normalizedEmail = normalizeEmail(email);
		const token = await getAuthTokenForEmail(normalizedEmail);
		if (!token) {
			return null;
		}

		const serverUrl = await getServerUrlForEmail(normalizedEmail);
		return deps.createAccountClient(token, serverUrl);
	}

	async function resolveConnectionContext(): Promise<SyncConnectionContext | null> {
		const activeEmail = await resolveActiveSingleEmail();
		const knownEmails = await getAllKnownEmails();
		const candidates = buildOrderedCandidates(activeEmail, knownEmails);

		for (const email of candidates) {
			const token = await getAuthTokenForEmail(email);
			if (!token) {
				continue;
			}

			const serverUrl = await getServerUrlForEmail(email);
			deps.logger.info(
				`[sync-cache-service] Selected account-scoped sync context: ${email}`,
			);
			return {
				email,
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

		const fallbackServerUrl = await getServerUrlForEmail(null);
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
	): Promise<SyncEventQueryClient> {
		if (!email) {
			return deps.defaultClient;
		}
		const client = await getAccountClientForEmail(email);
		return client ?? deps.defaultClient;
	}

	async function resolveCandidateEmailsForEvent(
		event: SyncEvent,
	): Promise<string[]> {
		const activeSingleEmail = await resolveActiveSingleEmail();
		if (activeSingleEmail) {
			return [activeSingleEmail];
		}

		const allEmails = await getAllKnownEmails();
		if (allEmails.length === 0) {
			return [];
		}

		const effectiveVaultId =
			event.vaultId ??
			(event.type === "vault_access_revoked" ? event.entityId : null);
		if (!effectiveVaultId) {
			return allEmails;
		}

		const matched: string[] = [];
		for (const email of allEmails) {
			const vaultKeys = await deps.storage.getVaultKeys(email);
			if (
				vaultKeys?.some((vaultKey) => vaultKey.vaultId === effectiveVaultId)
			) {
				matched.push(email);
			}
		}

		return matched.length > 0 ? matched : allEmails;
	}

	async function resolveTravelModeAccountEmail(
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
			return normalizeEmail(firstMatch.email);
		}

		deps.logger.warn(
			`[sync-cache-service] No account matched travel_mode_updated user ${ownerUserId}`,
		);

		const onlyAccount = accounts.at(0);
		if (accounts.length === 1 && onlyAccount) {
			return normalizeEmail(onlyAccount.email);
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
				return normalizeEmail(onlyEmailMatch.email);
			}
		}

		return null;
	}

	async function applyDeltaSyncForEvent(event: SyncEvent): Promise<void> {
		if (event.type === "travel_mode_updated") {
			const accountEmail = await resolveTravelModeAccountEmail(event);
			if (!accountEmail) {
				return;
			}

			deps.logger.debug(
				`[sync-cache-service] Applying travel_mode_updated for account: ${accountEmail}`,
			);

			try {
				const accountClient = await getAccountClientForEmail(accountEmail);
				await deps.handleTravelModeSync?.(event, accountEmail, accountClient);
			} catch (error) {
				deps.logger.warn(
					`[sync-cache-service] Travel mode sync failed for ${accountEmail}`,
					error,
				);
			}
			return;
		}

		const candidateEmails = await resolveCandidateEmailsForEvent(event);

		deps.logger.debug(
			`[sync-cache-service] Applying ${event.type} for candidate accounts: ${
				candidateEmails.join(", ") || "(global)"
			}`,
		);

		if (candidateEmails.length === 0) {
			await deps.deltaSync(deps.defaultClient, deps.itemCache, event);
			if (shouldClearDesktopCacheForEvent(event)) {
				deps.desktopClient.clearCache();
			}
			return;
		}

		let applied = 0;
		for (const email of candidateEmails) {
			try {
				const accountClient = await getAccountClientForEmail(email);
				if (!accountClient) {
					deps.logger.debug(
						`[sync-cache-service] Skipping ${email} (no token available)`,
					);
					continue;
				}

				await deps.deltaSync(accountClient, deps.itemCache, event, email);
				applied++;
			} catch (error) {
				deps.logger.warn(
					`[sync-cache-service] Delta sync failed for ${email} (${event.type})`,
					error,
				);
			}
		}

		if (applied === 0) {
			deps.logger.warn(
				`[sync-cache-service] No account-scoped delta applied for ${event.type}; falling back to global cache update`,
			);
			if (deps.storage.clearItemCache || deps.itemCache.clearItemCache) {
				await Promise.all(
					candidateEmails.map((email) => clearItemCacheForEmail(email)),
				);
			}
			await deps.deltaSync(deps.defaultClient, deps.itemCache, event);
		}

		if (shouldClearDesktopCacheForEvent(event)) {
			deps.desktopClient.clearCache();
		}
	}

	async function clearItemCachesForKnownAccounts(): Promise<void> {
		if (!deps.storage.clearItemCache && !deps.itemCache.clearItemCache) {
			return;
		}

		const activeSingleEmail = await resolveActiveSingleEmail();
		const allEmails = await getAllKnownEmails();
		const candidates = buildOrderedCandidates(activeSingleEmail, allEmails);

		if (candidates.length === 0) {
			await clearItemCacheForEmail();
			return;
		}

		await Promise.all(candidates.map((email) => clearItemCacheForEmail(email)));
	}

	return {
		resolveConnectionContext,
		getClientForEmail,
		resolveCandidateEmailsForEvent,
		applyDeltaSyncForEvent,
		clearItemCachesForKnownAccounts,
	};
}

export const syncCacheService = createSyncCacheService();
