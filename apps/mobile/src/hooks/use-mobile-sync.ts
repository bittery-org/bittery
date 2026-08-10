import {
	AccountResolver,
	createStoredAccountApiClient,
} from "@bittery/core/services/account-resolver";
import { handleTravelModeSyncEvent } from "@bittery/core/services/travel-mode-sync";
import { createVaultCrypto } from "@bittery/core/services/vault-crypto";
import { getOrCreateVaultRepositoryCoordinator } from "@bittery/core/services/vault-repository-coordinator";
import type { ApiVaultClient } from "@bittery/core/services/vault-service";
import { createAccountApiClient } from "@bittery/shared/api-client-factory";
import type { OutboundQueueApiClient, SyncStorage } from "@bittery/sync";
import { useSync } from "@bittery/sync";
import type { QueryClient } from "@tanstack/react-query";
import { fetch as expoFetch } from "expo/fetch";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppState } from "react-native";
import { crypto } from "../lib/crypto";
import {
	getMobileSyncDb,
	getOrCreateMobileSyncClientId,
} from "../lib/sync-client-id";
import { itemCache, storage } from "../services/storage";

/**
 * `accountId` is deliberately non-nullable.
 *
 * It becomes `SyncSource.itemCacheAccountId`, and every `ItemCache` method now requires an
 * `accountId` argument — there is no account-less collection to fall back to. Sync is simply
 * not enabled until a real account is resolved.
 */
interface SyncConnectionContext {
	accountId: string;
	serverUrl: string;
}

/**
 * React Native-compatible sync storage implementation using SQLite
 */
class ReactNativeSyncStorage implements SyncStorage {
	async get<T>(key: string): Promise<T | null> {
		try {
			const db = await getMobileSyncDb();
			const result = await db.getFirstAsync<{ value: string }>(
				"SELECT value FROM sync_storage WHERE key = ?",
				[key],
			);
			return result ? JSON.parse(result.value) : null;
		} catch {
			return null;
		}
	}

	async set<T>(key: string, value: T): Promise<void> {
		const db = await getMobileSyncDb();
		await db.runAsync(
			"INSERT OR REPLACE INTO sync_storage (key, value) VALUES (?, ?)",
			[key, JSON.stringify(value)],
		);
	}

	async remove(key: string): Promise<void> {
		const db = await getMobileSyncDb();
		await db.runAsync("DELETE FROM sync_storage WHERE key = ?", [key]);
	}
}

/**
 * Resolve the best available account-scoped sync context.
 * In multi-account mode we prefer the active single account first, then fall
 * back to other known accounts.
 */
async function resolveMobileSyncContext(): Promise<SyncConnectionContext | null> {
	const [activeAccount, accounts] = await Promise.all([
		storage.getActiveAccount(),
		storage.getAccountsList(),
	]);

	const candidateIds: string[] = [];
	if (activeAccount) {
		candidateIds.push(activeAccount);
	}
	for (const account of accounts) {
		if (!candidateIds.includes(account.accountId)) {
			candidateIds.push(account.accountId);
		}
	}

	for (const accountId of candidateIds) {
		const [token, url] = await Promise.all([
			storage.getAuthToken(accountId),
			storage.getServerUrl(accountId),
		]);
		if (token && url) {
			return { accountId, serverUrl: url };
		}
	}

	// No account-less fallback: a context without an accountId could not name an
	// item-cache collection anyway.
	return null;
}

/**
 * Mobile-specific sync hook that integrates with React Native storage
 */
export function useMobileSync(queryClient: QueryClient, enabled = true) {
	const [clientId, setClientId] = useState<string>("");
	const [serverUrl, setServerUrl] = useState<string>("");
	const [syncAccountId, setSyncAccountId] = useState<string | null>(null);
	const [isInitialized, setIsInitialized] = useState(false);

	// Initialize and keep sync connection context fresh.
	useEffect(() => {
		let mounted = true;
		let resolving = false;

		const resolveContext = async () => {
			if (resolving) {
				return;
			}
			resolving = true;
			try {
				const [id, context] = await Promise.all([
					getOrCreateMobileSyncClientId(),
					resolveMobileSyncContext(),
				]);
				if (!mounted) {
					return;
				}
				setClientId(id);
				setServerUrl(context?.serverUrl ?? "");
				setSyncAccountId(context?.accountId ?? null);
				setIsInitialized(true);
			} finally {
				resolving = false;
			}
		};

		void resolveContext();

		const appStateSubscription = AppState.addEventListener(
			"change",
			(nextState) => {
				if (nextState === "active") {
					void resolveContext();
				}
			},
		);

		const interval = setInterval(() => {
			if (AppState.currentState === "active") {
				void resolveContext();
			}
		}, 30000);

		return () => {
			mounted = false;
			appStateSubscription.remove();
			clearInterval(interval);
		};
	}, []);

	const getAuthToken = useCallback(async () => {
		return storage.getAuthToken(syncAccountId ?? undefined);
	}, [syncAccountId]);
	const getClientForAccount = useCallback(
		async (accountId: string) => {
			const client = await createStoredAccountApiClient(
				storage,
				accountId,
				clientId,
			);
			if (!client) throw new Error(`No API client for account ${accountId}`);
			return client as unknown as OutboundQueueApiClient;
		},
		[clientId],
	);
	const resolveLegacyAccountId = useCallback(async (email: string) => {
		const matches = (await storage.getAccountsList()).filter(
			(account) => account.email.toLowerCase() === email.toLowerCase(),
		);
		if (matches.length !== 1)
			throw new Error(`Ambiguous legacy account queue for ${email}`);
		return matches[0]?.accountId;
	}, []);

	const syncStorage = useMemo(() => new ReactNativeSyncStorage(), []);
	const vaultCoordinator = useMemo(
		() =>
			getOrCreateVaultRepositoryCoordinator(
				crypto,
				createVaultCrypto({ crypto, storage }),
				storage,
				itemCache,
			),
		[],
	);

	const onTravelModeEvent = useCallback(
		async (event: { type: string; metadata?: Record<string, unknown> }) => {
			if (!syncAccountId || event.type !== "travel_mode_updated") {
				return;
			}
			const [token, accountServerUrl, account] = await Promise.all([
				storage.getAuthToken(syncAccountId),
				storage.getServerUrl(syncAccountId),
				storage.getAccountMetadata(syncAccountId),
			]);
			if (!token) {
				return;
			}
			const apiClient = createAccountApiClient(
				token,
				accountServerUrl || serverUrl || "http://localhost:3000",
				undefined,
				undefined,
				{
					insecureTransportConfirmed:
						account?.insecureTransportConfirmed === true,
				},
			);
			const accounts = new AccountResolver(storage);
			await handleTravelModeSyncEvent(
				event,
				syncAccountId,
				storage,
				itemCache,
				vaultCoordinator,
				{
					apiClient: apiClient as unknown as ApiVaultClient,
					accounts,
				},
			);
		},
		[serverUrl, syncAccountId, vaultCoordinator],
	);

	const syncState = useSync({
		serverUrl,
		getAuthToken,
		clientId,
		queryClient,
		storage: syncStorage,
		enabled:
			enabled && isInitialized && !!serverUrl && !!clientId && !!syncAccountId,
		realtimeEnabled: true,
		itemCacheAdapter: vaultCoordinator,
		itemCacheAccountId: syncAccountId,
		itemCacheServerUrl: syncAccountId ? serverUrl : null,
		getClientForAccount,
		resolveLegacyAccountId,
		fetch: expoFetch,
		onEventProcessed: onTravelModeEvent,
	});

	return {
		...syncState,
		clientId,
		isInitialized,
	};
}

/**
 * Get the client ID for use in mutations
 */
export function useMobileClientId(): string {
	const [clientId, setClientId] = useState<string>("");

	useEffect(() => {
		getOrCreateMobileSyncClientId().then(setClientId);
	}, []);

	return clientId;
}
