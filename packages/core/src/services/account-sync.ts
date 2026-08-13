import type { CryptoPort } from "@bittery/crypto-port";
import { getDefaultServerUrl } from "@bittery/shared/api-client-factory";
import type { AccountMetadata, ActiveAccountId } from "@bittery/storage/types";
import {
	buildDefaultSyncSourceId,
	type SyncEventContext,
	type SyncSource,
} from "@bittery/sync/source";
import type { SyncEvent, SyncItemCache } from "@bittery/sync/types";
import {
	invalidateAccountSession,
	type LifecycleDeps,
	type LifecycleOutcome,
} from "./account-lifecycle";
import {
	AccountResolver,
	createStoredAccountApiClient,
	type DefaultApiClient,
} from "./account-resolver";
import {
	createInitialSyncBootstrap,
	createStagedFullRefresh,
} from "./staged-full-refresh";
import { handleTravelModeSyncEvent } from "./travel-mode-sync";
import { createVaultCrypto } from "./vault-crypto";
import { getOrCreateVaultRepositoryCoordinator } from "./vault-repository-coordinator";

export type AccountSyncClientFactory = (
	accountId: string,
	clientId: string,
) => Promise<DefaultApiClient | null>;

export interface AccountSyncAssembly {
	serverUrl: string;
	getAuthToken: () => Promise<string | null>;
	sources: SyncSource[];
	getClientForAccount: (accountId: string) => Promise<DefaultApiClient>;
	itemCacheAdapter: SyncItemCache;
	onEventProcessed: (
		event: SyncEvent,
		context: SyncEventContext,
	) => Promise<void>;
}

export interface AccountSyncModule {
	/** Resolve the current account into the complete, account-scoped Sync configuration. */
	assemble(input: {
		clientId: string;
		activeAccountId?: ActiveAccountId;
	}): Promise<AccountSyncAssembly | null>;
	/** Apply the shared destructive Session invalidation, leaving UI effects to the app. */
	invalidateSession(payload: { sessionId: string }): Promise<LifecycleOutcome>;
}

export interface CreateAccountSyncOptions {
	crypto: CryptoPort;
	lifecycle: LifecycleDeps;
	/** Internal remote seam; production uses the stored-account HTTP adapter. */
	clientFactory?: AccountSyncClientFactory;
}

interface ResolvedAccount {
	metadata: AccountMetadata;
	serverUrl: string;
	apiClient: DefaultApiClient;
}

/**
 * Account-aware Sync policy shared by web, desktop and mobile.
 *
 * Apps observe their platform lifecycle and render outcomes. This React-free module owns
 * account discovery, account-authenticated clients, repository bootstrap/full refresh,
 * Travel mode processing and Session invalidation.
 */
export function createAccountSync({
	crypto,
	lifecycle,
	clientFactory,
}: CreateAccountSyncOptions): AccountSyncModule {
	const { storage, itemCache } = lifecycle;
	const coordinator = getOrCreateVaultRepositoryCoordinator(
		crypto,
		createVaultCrypto({ crypto, storage }),
		storage,
		itemCache,
	);
	const accounts = new AccountResolver(storage);
	const refreshFromServer = createStagedFullRefresh(storage, coordinator);
	const initializeFromServer = createInitialSyncBootstrap(storage, coordinator);
	const createClient: AccountSyncClientFactory =
		clientFactory ??
		((accountId, clientId) =>
			createStoredAccountApiClient(storage, accountId, clientId));

	let cached:
		| {
				key: string;
				assembly: AccountSyncAssembly;
		  }
		| undefined;

	async function resolveAccount(
		accountId: string,
		clientId: string,
	): Promise<ResolvedAccount | null> {
		const [metadata, serverUrl, apiClient] = await Promise.all([
			storage.getAccountMetadata(accountId),
			storage.getServerUrl(accountId),
			createClient(accountId, clientId),
		]);
		if (!metadata || !apiClient) {
			return null;
		}
		return {
			metadata,
			serverUrl: serverUrl || metadata.serverUrl || getDefaultServerUrl(),
			apiClient,
		};
	}

	async function requireClient(
		accountId: string,
		clientId: string,
	): Promise<DefaultApiClient> {
		const client = await createClient(accountId, clientId);
		if (!client) {
			throw new Error(`No API client for account ${accountId}`);
		}
		return client;
	}

	return {
		async assemble({ clientId, activeAccountId }) {
			await Promise.all([storage.initialize(), itemCache.initialize()]);
			const accountId =
				activeAccountId === undefined
					? await storage.getActiveAccount()
					: activeAccountId;
			if (!accountId || !clientId) {
				cached = undefined;
				return null;
			}

			const account = await resolveAccount(accountId, clientId);
			if (!account) {
				cached = undefined;
				return null;
			}

			const cacheKey = JSON.stringify([
				clientId,
				accountId,
				account.metadata.email,
				account.serverUrl,
			]);
			if (cached?.key === cacheKey) {
				return cached.assembly;
			}

			const getClientForAccount = (targetAccountId: string) =>
				requireClient(targetAccountId, clientId);
			const getAuthToken = () => storage.getAuthToken(accountId);
			const source: SyncSource = {
				id: buildDefaultSyncSourceId(account.serverUrl, accountId),
				serverUrl: account.serverUrl,
				getAuthToken,
				apiClient: account.apiClient,
				refreshFromServer,
				initializeFromServer,
				itemCacheAccountId: accountId,
				itemCacheAccountEmail: account.metadata.email,
				itemCacheServerUrl: account.serverUrl,
			};
			const assembly: AccountSyncAssembly = {
				serverUrl: account.serverUrl,
				getAuthToken,
				sources: [source],
				getClientForAccount,
				itemCacheAdapter: coordinator,
				onEventProcessed: async (event, context) => {
					if (event.type !== "travel_mode_updated" || !context.accountId) {
						return;
					}
					await handleTravelModeSyncEvent(
						event,
						context.accountId,
						storage,
						itemCache,
						coordinator,
						{
							apiClient: await getClientForAccount(context.accountId),
							accounts,
						},
					);
				},
			};
			cached = { key: cacheKey, assembly };
			return assembly;
		},

		async invalidateSession(payload) {
			cached = undefined;
			return await invalidateAccountSession(
				{ sessionId: payload.sessionId },
				lifecycle,
			);
		},
	};
}
