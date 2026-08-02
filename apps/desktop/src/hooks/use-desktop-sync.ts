import {
	AccountResolver,
	createStoredAccountRpcClient,
	getOrCreateVaultRepositoryCoordinator,
	handleTravelModeSyncEvent,
	type RpcVaultClient,
} from "@bittery/core";
import {
	invalidateAccountSession,
	type LifecycleOutcome,
} from "@bittery/core/services/account-lifecycle";
import { isUnauthorizedRpcError } from "@bittery/shared/rpc-client";
import { createAccountRpcClient } from "@bittery/shared/rpc-client-factory";
import type {
	OutboundQueueClient,
	SyncSource,
	SyncStorage,
} from "@bittery/sync";
import { useSync } from "@bittery/sync";
import type { ICrypto } from "@bittery/types";
import type { QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { lifecycleDeps } from "@/lib/lifecycle";
import { itemCache, storage } from "@/lib/storage";
import {
	getDesktopSyncStore,
	getOrCreateDesktopSyncClientId,
} from "@/lib/sync-client-id";
import * as tauriCrypto from "@/lib/tauri-crypto";

/**
 * `accountId` is deliberately non-nullable: it becomes `SyncSource.itemCacheAccountId`, and
 * a `null` there silently routes every cached item and vault into `ItemCache`'s literal
 * `"default"` collection instead of the account's own (packages/storage/CONTEXT.md §4.1).
 * Desktop always has a real accountId — every account-scoped value it reads is keyed by one.
 */
interface SyncConnectionContext {
	accountId: string;
	email: string | null;
	serverUrl: string;
	rpcClient: SyncSource["rpcClient"];
}

function areSyncContextsEquivalent(
	left: SyncConnectionContext[],
	right: SyncConnectionContext[],
): boolean {
	if (left.length !== right.length) {
		return false;
	}

	return left.every((context, index) => {
		const other = right[index];
		return (
			other &&
			context.accountId === other.accountId &&
			context.email === other.email &&
			context.serverUrl === other.serverUrl
		);
	});
}

async function resolveDesktopSyncContexts(
	clientId?: string,
): Promise<SyncConnectionContext[]> {
	const [activeAccount, accounts] = await Promise.all([
		storage.getActiveAccount(),
		storage.getAccountsList(),
	]);

	const accountById = new Map(
		accounts.map((account) => [account.accountId, account]),
	);
	const candidateIds: string[] = [];
	if (activeAccount?.type === "single") {
		candidateIds.push(activeAccount.accountId);
	}

	const contexts: SyncConnectionContext[] = [];
	for (const accountId of candidateIds) {
		const [token, url] = await Promise.all([
			storage.getAuthToken(accountId),
			storage.getServerUrl(accountId),
		]);
		if (token && url) {
			const email = accountById.get(accountId)?.email ?? null;
			const rpcClient = await createStoredAccountRpcClient(
				storage,
				accountId,
				clientId,
			);
			if (!rpcClient) {
				continue;
			}
			contexts.push({
				accountId,
				email,
				serverUrl: url,
				rpcClient: rpcClient as unknown as SyncSource["rpcClient"],
			});
		}
	}

	// No account-less fallback: `storage.getAuthToken()` / `getServerUrl()` without an
	// accountId resolve the *active* account, which is exactly the account the loop above
	// already tried — and would hand the sync orchestrator a `null` itemCacheAccountId.
	return contexts;
}

/**
 * Tauri-compatible sync storage implementation
 */
class TauriSyncStorage implements SyncStorage {
	async get<T>(key: string): Promise<T | null> {
		try {
			const store = await getDesktopSyncStore();
			const value = await store.get<string>(key);
			return value ? JSON.parse(value) : null;
		} catch {
			return null;
		}
	}

	async set<T>(key: string, value: T): Promise<void> {
		const store = await getDesktopSyncStore();
		await store.set(key, JSON.stringify(value));
		await store.save();
	}

	async remove(key: string): Promise<void> {
		const store = await getDesktopSyncStore();
		await store.delete(key);
		await store.save();
	}
}

const crypto: ICrypto = {
	decrypt: tauriCrypto.decrypt,
	encrypt: tauriCrypto.encrypt,
	rsaDecrypt: tauriCrypto.rsaDecrypt,
	generateEncryptionKey: tauriCrypto.generateEncryptionKey,
	generateUuid: tauriCrypto.generateUuid,
	deriveKeys: tauriCrypto.deriveKeys,
	generateClientEphemeral: tauriCrypto.generateClientEphemeral,
	deriveClientSession: tauriCrypto.deriveClientSession,
	verifyServerSession: tauriCrypto.verifyServerSession,
	validateSecretKey: tauriCrypto.validateSecretKey,
	validateKdfProfile: tauriCrypto.validateKdfProfile,
};

const SESSION_REVALIDATION_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Desktop-specific sync hook that integrates with Tauri storage
 */
export function useDesktopSync(queryClient: QueryClient, enabled = true) {
	const [clientId, setClientId] = useState<string>("");
	const [serverUrl, setServerUrl] = useState<string>("");
	const [syncContexts, setSyncContexts] = useState<SyncConnectionContext[]>([]);
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
				const id = await getOrCreateDesktopSyncClientId();
				const contexts = await resolveDesktopSyncContexts(id);
				if (!mounted) {
					return;
				}
				setClientId(id);
				setServerUrl(contexts[0]?.serverUrl ?? "");
				setSyncContexts((current) =>
					areSyncContextsEquivalent(current, contexts) ? current : contexts,
				);
				setIsInitialized(true);
			} finally {
				resolving = false;
			}
		};

		void resolveContext();
		const interval = setInterval(() => {
			void resolveContext();
		}, 5000);

		return () => {
			mounted = false;
			clearInterval(interval);
		};
	}, []);

	const getAuthToken = useCallback(async () => {
		return storage.getAuthToken(syncContexts[0]?.accountId ?? undefined);
	}, [syncContexts]);

	const getClientForAccount = useCallback(
		async (accountId: string): Promise<OutboundQueueClient> => {
			const [accountToken, accountServerUrl] = await Promise.all([
				storage.getAuthToken(accountId),
				storage.getServerUrl(accountId),
			]);
			if (accountToken) {
				const client = await createStoredAccountRpcClient(
					storage,
					accountId,
					clientId,
				);
				if (client) {
					return client as unknown as OutboundQueueClient;
				}
				return createAccountRpcClient(
					accountToken,
					accountServerUrl || serverUrl || "http://localhost:3000",
				) as unknown as OutboundQueueClient;
			}

			throw new Error(
				`No auth token available for account queue drain (${accountId})`,
			);
		},
		[clientId, serverUrl],
	);

	const resolveLegacyAccountId = useCallback(async (email: string) => {
		const matches = (await storage.getAccountsList()).filter(
			(account) => account.email.toLowerCase() === email.toLowerCase(),
		);
		if (matches.length !== 1) {
			throw new Error(`Ambiguous legacy account queue for ${email}`);
		}
		return matches[0]?.accountId;
	}, []);

	/** The UI half of an invalidation; the record half already happened in core. */
	const applyInvalidatedSession = useCallback(
		async (outcome: LifecycleOutcome) => {
			const invalidated = outcome.affected[0];
			if (!invalidated) {
				return null;
			}

			await queryClient.cancelQueries();
			queryClient.clear();

			if (outcome.wasActive) {
				window.location.href = `/unlock?email=${encodeURIComponent(invalidated.email.toLowerCase())}`;
			}
			return invalidated;
		},
		[queryClient],
	);

	const handleAccountSessionInvalidation = useCallback(
		async (email: string) => {
			await applyInvalidatedSession(
				await invalidateAccountSession({ email }, lifecycleDeps),
			);
		},
		[applyInvalidatedSession],
	);

	const onSessionRevoked = useCallback(
		async (payload: { sessionId: string }) => {
			const revoked = await applyInvalidatedSession(
				await invalidateAccountSession(
					{ sessionId: payload.sessionId },
					lifecycleDeps,
				),
			);
			if (!revoked) {
				return;
			}

			setSyncContexts((current) =>
				current.filter((context) => context.accountId !== revoked.accountId),
			);
		},
		[applyInvalidatedSession],
	);

	// Revalidate persisted sessions on startup/interval when online.
	// This catches revoked sessions even if the app was closed at revocation time.
	useEffect(() => {
		if (!enabled || !isInitialized) {
			return;
		}

		let cancelled = false;

		const revalidateSessions = async () => {
			if (typeof navigator !== "undefined" && !navigator.onLine) {
				return;
			}

			const accounts = await storage.getAccountsList();
			for (const account of accounts) {
				if (cancelled) {
					return;
				}

				const email = account.email.toLowerCase();
				const [token, url, sessionData] = await Promise.all([
					storage.getAuthToken(account.accountId),
					storage.getServerUrl(account.accountId),
					storage.getStoredSessionData(account.accountId),
				]);

				if (!token || !url || !sessionData?.sessionId) {
					continue;
				}

				try {
					await createAccountRpcClient(token, url).auth.me.query();
				} catch (error) {
					if (!isUnauthorizedRpcError(error)) {
						continue;
					}

					await handleAccountSessionInvalidation(email);
					setSyncContexts((current) =>
						current.filter((context) => context.email?.toLowerCase() !== email),
					);
				}
			}
		};

		void revalidateSessions();
		const interval = setInterval(() => {
			void revalidateSessions();
		}, SESSION_REVALIDATION_INTERVAL_MS);

		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, [enabled, handleAccountSessionInvalidation, isInitialized]);

	const syncStorage = useMemo(() => new TauriSyncStorage(), []);
	const vaultCoordinator = useMemo(
		() => getOrCreateVaultRepositoryCoordinator(crypto, storage, itemCache),
		[],
	);

	const onTravelModeEvent = useCallback(
		async (
			event: { type: string; metadata?: Record<string, unknown> },
			context?: {
				accountId?: string | null;
				accountEmail?: string | null;
			},
		) => {
			const accountId = context?.accountId;
			const accountEmail = context?.accountEmail;
			if (!accountId || !accountEmail || event.type !== "travel_mode_updated") {
				return;
			}
			const rpcClient = await getClientForAccount(accountId);
			const accounts = new AccountResolver(storage);
			await handleTravelModeSyncEvent(
				event,
				accountId,
				storage,
				itemCache,
				vaultCoordinator,
				{
					rpcClient: rpcClient as unknown as RpcVaultClient,
					accounts,
				},
			);
		},
		[getClientForAccount, vaultCoordinator],
	);

	const syncSources = useMemo<SyncSource[]>(
		() =>
			syncContexts.map((context) => ({
				id: context.accountId,
				serverUrl: context.serverUrl,
				getAuthToken: () => storage.getAuthToken(context.accountId),
				rpcClient: context.rpcClient,
				itemCacheAccountId: context.accountId,
				itemCacheAccountEmail: context.email,
				itemCacheServerUrl: context.serverUrl,
			})),
		[syncContexts],
	);

	const syncState = useSync({
		serverUrl,
		getAuthToken,
		clientId,
		queryClient,
		storage: syncStorage,
		enabled: enabled && isInitialized && !!clientId && syncSources.length > 0,
		itemCacheAdapter: vaultCoordinator,
		sources: syncSources,
		getClientForAccount,
		resolveLegacyAccountId,
		onSessionRevoked,
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
export function useDesktopClientId(): string {
	const [clientId, setClientId] = useState<string>("");

	useEffect(() => {
		getOrCreateDesktopSyncClientId().then(setClientId);
	}, []);

	return clientId;
}
