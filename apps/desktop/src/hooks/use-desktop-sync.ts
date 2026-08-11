import {
	invalidateAccountSession,
	type LifecycleOutcome,
} from "@bittery/core/services/account-lifecycle";
import {
	AccountResolver,
	createStoredAccountApiClient,
} from "@bittery/core/services/account-resolver";
import {
	createInitialSyncBootstrap,
	createStagedFullRefresh,
} from "@bittery/core/services/staged-full-refresh";
import { handleTravelModeSyncEvent } from "@bittery/core/services/travel-mode-sync";
import { createVaultCrypto } from "@bittery/core/services/vault-crypto";
import { getOrCreateVaultRepositoryCoordinator } from "@bittery/core/services/vault-repository-coordinator";
import type { ApiVaultClient } from "@bittery/core/services/vault-service";
import { isUnauthorizedApiError } from "@bittery/shared/api-client";
import { createAccountApiClient } from "@bittery/shared/api-client-factory";
import type {
	OutboundQueueApiClient,
	SyncSource,
	SyncStorage,
} from "@bittery/sync";
import { buildDefaultSyncSourceId, useSync } from "@bittery/sync";
import { toast } from "@bittery/ui";
import type { QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { crypto } from "@/lib/crypto";
import { lifecycleDeps } from "@/lib/lifecycle";
import { itemCache, storage } from "@/lib/storage";
import {
	getDesktopSyncStore,
	getOrCreateDesktopSyncClientId,
} from "@/lib/sync-client-id";
import { useI18n } from "@/providers/i18n-provider";

/**
 * `accountId` is deliberately non-nullable: it becomes `SyncSource.itemCacheAccountId`, which
 * `SyncOrchestrator.getDeltaSyncAccountScope()` now requires — it throws if absent.
 */
interface SyncConnectionContext {
	accountId: string;
	email: string | null;
	serverUrl: string;
	apiClient: SyncSource["apiClient"];
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
	if (activeAccount) {
		candidateIds.push(activeAccount);
	}

	const contexts: SyncConnectionContext[] = [];
	for (const accountId of candidateIds) {
		const [token, url] = await Promise.all([
			storage.getAuthToken(accountId),
			storage.getServerUrl(accountId),
		]);
		if (token && url) {
			const email = accountById.get(accountId)?.email ?? null;
			const apiClient = await createStoredAccountApiClient(
				storage,
				accountId,
				clientId,
			);
			if (!apiClient) {
				continue;
			}
			contexts.push({
				accountId,
				email,
				serverUrl: url,
				apiClient: apiClient as unknown as SyncSource["apiClient"],
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

const SESSION_REVALIDATION_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Desktop-specific sync hook that integrates with Tauri storage
 */
export function useDesktopSync(queryClient: QueryClient, enabled = true) {
	const { m } = useI18n();
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
		async (accountId: string): Promise<OutboundQueueApiClient> => {
			const [accountToken, accountServerUrl, account] = await Promise.all([
				storage.getAuthToken(accountId),
				storage.getServerUrl(accountId),
				storage.getAccountMetadata(accountId),
			]);
			if (accountToken) {
				const client = await createStoredAccountApiClient(
					storage,
					accountId,
					clientId,
				);
				if (client) {
					return client as unknown as OutboundQueueApiClient;
				}
				return createAccountApiClient(
					accountToken,
					accountServerUrl || serverUrl || "http://localhost:3000",
					undefined,
					undefined,
					{
						insecureTransportConfirmed:
							account?.insecureTransportConfirmed === true,
					},
				) as unknown as OutboundQueueApiClient;
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
					await createAccountApiClient(token, url, undefined, undefined, {
						insecureTransportConfirmed:
							account.insecureTransportConfirmed === true,
					}).auth.me();
				} catch (error) {
					if (!isUnauthorizedApiError(error)) {
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
			const apiClient = await getClientForAccount(accountId);
			const accounts = new AccountResolver(storage);
			await handleTravelModeSyncEvent(
				event,
				accountId,
				storage,
				itemCache,
				vaultCoordinator,
				{
					apiClient: apiClient as unknown as ApiVaultClient,
					accounts,
				},
			);
		},
		[getClientForAccount, vaultCoordinator],
	);

	const refreshFromServer = useMemo(
		() => createStagedFullRefresh(storage, vaultCoordinator),
		[vaultCoordinator],
	);
	const initializeFromServer = useMemo(
		() => createInitialSyncBootstrap(storage, vaultCoordinator),
		[vaultCoordinator],
	);

	const syncSources = useMemo<SyncSource[]>(
		() =>
			syncContexts.map((context) => ({
				id: buildDefaultSyncSourceId(context.serverUrl, context.accountId),
				serverUrl: context.serverUrl,
				getAuthToken: () => storage.getAuthToken(context.accountId),
				apiClient: context.apiClient,
				refreshFromServer,
				initializeFromServer,
				itemCacheAccountId: context.accountId,
				itemCacheAccountEmail: context.email,
				itemCacheServerUrl: context.serverUrl,
			})),
		[syncContexts, refreshFromServer, initializeFromServer],
	);
	const onTerminalCommandFailure = useCallback(() => {
		toast.error(m.sync_command_terminal_error(), {
			description: m.sync_command_terminal_error_description(),
		});
	}, [m]);

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
		onTerminalCommandFailure,
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
