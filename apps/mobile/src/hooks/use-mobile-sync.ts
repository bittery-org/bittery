import {
	AccountResolver,
	createStoredAccountRpcClient,
	getOrCreateVaultRepositoryCoordinator,
	handleTravelModeSyncEvent,
	type RpcVaultClient,
} from "@bittery/core";
import { createAccountRpcClient } from "@bittery/shared/rpc-client-factory";
import type { OutboundQueueClient, SyncStorage } from "@bittery/sync";
import { useSync } from "@bittery/sync";
import type { ICrypto } from "@bittery/types";
import type { QueryClient } from "@tanstack/react-query";
import { fetch as expoFetch } from "expo/fetch";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppState } from "react-native";
import {
	base64ToArrayBuffer,
	decrypt,
	deriveClientSession,
	deriveKeys,
	encrypt,
	generateClientEphemeral,
	generateUuid,
	generateEncryptionKey as nativeGenerateEncryptionKey,
	rsaDecrypt,
	validateKdfProfile,
	validateSecretKey,
	verifyServerSession,
} from "../lib/crypto/native-crypto";
import {
	getMobileSyncDb,
	getOrCreateMobileSyncClientId,
} from "../lib/sync-client-id";
import { itemCache, storage } from "../services/storage";

/**
 * `accountId` is deliberately non-nullable.
 *
 * It becomes `SyncSource.itemCacheAccountId`, and `ItemCache` falls back to the literal
 * collection segment `"default"` when it is not given one — so a `null` here would not fail,
 * it would silently read and write a collection that belongs to no account. Sync is simply
 * not enabled until a real account is resolved. See packages/storage/CONTEXT.md §4.1.
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

const crypto: ICrypto = {
	decrypt,
	encrypt,
	rsaDecrypt,
	generateEncryptionKey: async () => {
		const keyBase64 = nativeGenerateEncryptionKey();
		return base64ToArrayBuffer(keyBase64);
	},
	generateUuid,
	deriveKeys,
	generateClientEphemeral,
	deriveClientSession,
	verifyServerSession,
	validateSecretKey,
	validateKdfProfile,
};

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
	if (activeAccount?.type === "single") {
		candidateIds.push(activeAccount.accountId);
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
			const client = await createStoredAccountRpcClient(
				storage,
				accountId,
				clientId,
			);
			if (!client) throw new Error(`No RPC client for account ${accountId}`);
			return client as unknown as OutboundQueueClient;
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
		() => getOrCreateVaultRepositoryCoordinator(crypto, storage, itemCache),
		[],
	);

	const onTravelModeEvent = useCallback(
		async (event: { type: string; metadata?: Record<string, unknown> }) => {
			if (!syncAccountId || event.type !== "travel_mode_updated") {
				return;
			}
			const [token, accountServerUrl] = await Promise.all([
				storage.getAuthToken(syncAccountId),
				storage.getServerUrl(syncAccountId),
			]);
			if (!token) {
				return;
			}
			const rpcClient = createAccountRpcClient(
				token,
				accountServerUrl || serverUrl || "http://localhost:3000",
			);
			const accounts = new AccountResolver(storage);
			await handleTravelModeSyncEvent(
				event,
				syncAccountId,
				storage,
				itemCache,
				vaultCoordinator,
				{
					rpcClient: rpcClient as unknown as RpcVaultClient,
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

	useEffect(() => {
		// Intentionally no per-status logging here; this hook is always mounted.
	}, []);

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
