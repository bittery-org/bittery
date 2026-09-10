import type { CryptoPort } from "@bittery/crypto-port";
import { getDefaultServerUrl } from "@bittery/shared/api-client-factory";
import type { AccountMetadata, ActiveAccountId } from "@bittery/storage/types";
import {
	buildDefaultSyncSourceId,
	type ItemCommandProjection,
	type SemanticItemCommandExecutor,
	type SyncEvent,
	type SyncEventContext,
	type SyncOrchestratorReplica,
	type SyncSource,
} from "@bittery/sync";
import {
	type LifecycleDeps,
	type LifecycleOutcome,
	lockInvalidSession,
} from "./account-lifecycle";
import {
	AccountResolver,
	createStoredAccountApiClient,
	type DefaultApiClient,
} from "./account-resolver";
import { CrossAccountItemCommandExecutor } from "./cross-account-item-command-executor";
import {
	createInitialSyncBootstrap,
	createStagedFullRefresh,
} from "./staged-full-refresh";
import { handleTravelModeSyncEvent } from "./travel-mode-sync";
import type { VaultCrypto } from "./vault-crypto";
import type { VaultRepository } from "./vault-repository";

export type AccountSyncClientFactory = (
	accountId: string,
	clientId: string,
) => Promise<DefaultApiClient | null>;

export interface AccountSyncAssembly {
	sources: SyncSource[];
	getClientForAccount: (accountId: string) => Promise<DefaultApiClient>;
	replicaStore: SyncOrchestratorReplica;
	commandProjection: ItemCommandProjection;
	semanticCommandExecutor: SemanticItemCommandExecutor;
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
	/** Lock the Account after Server Session invalidation, leaving UI effects to the app. */
	invalidateSession(payload: {
		sessionId: string;
		accountId?: string;
	}): Promise<LifecycleOutcome>;
}

export interface CreateAccountSyncOptions {
	lifecycle: LifecycleDeps;
	vaultRepository: VaultRepository;
	crypto: CryptoPort;
	vaultCrypto: VaultCrypto;
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
	lifecycle,
	vaultRepository,
	crypto,
	vaultCrypto,
	clientFactory,
}: CreateAccountSyncOptions): AccountSyncModule {
	const { storage, itemCache } = lifecycle;
	const accounts = new AccountResolver(storage);
	const refreshFromServer = createStagedFullRefresh(storage, vaultRepository);
	const initializeFromServer = createInitialSyncBootstrap(
		storage,
		vaultRepository,
	);
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
	let initialization: Promise<void> | undefined;

	function initialize(): Promise<void> {
		initialization ??= Promise.all([
			storage.initialize(),
			itemCache.initialize(),
		])
			.then(() => undefined)
			.catch((error) => {
				// A transient platform failure must remain retryable on the next rebuild.
				initialization = undefined;
				throw error;
			});
		return initialization;
	}

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
			await initialize();
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
			const semanticExecutor = new CrossAccountItemCommandExecutor({
				crypto,
				vaultCrypto,
				getClientForAccount,
			});
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
				sources: [source],
				getClientForAccount,
				replicaStore: vaultRepository,
				commandProjection: vaultRepository,
				semanticCommandExecutor: semanticExecutor,
				onEventProcessed: async (event, context) => {
					if (event.type !== "travel_mode_updated" || !context.accountId) {
						return;
					}
					await handleTravelModeSyncEvent(
						event,
						context.accountId,
						storage,
						itemCache,
						vaultRepository,
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
			return await lockInvalidSession(
				payload.accountId
					? { accountId: payload.accountId }
					: { sessionId: payload.sessionId },
				lifecycle,
			);
		},
	};
}
