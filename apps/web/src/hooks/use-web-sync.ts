import { createStoredAccountApiClient } from "@bittery/core/services/account-resolver";
import {
	createInitialSyncBootstrap,
	createStagedFullRefresh,
} from "@bittery/core/services/staged-full-refresh";
import { createVaultCrypto } from "@bittery/core/services/vault-crypto";
import { getOrCreateVaultRepositoryCoordinator } from "@bittery/core/services/vault-repository-coordinator";
import {
	getOrCreateClientId,
	type OutboundQueueApiClient,
	type SyncStorage,
	useSync,
} from "@bittery/sync";
import { toast } from "@bittery/ui";
import type { QueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { getServerUrl } from "@/lib/auth-server";
import { crypto } from "@/lib/crypto";
import {
	forgetActiveSession,
	getActiveAccountIdSnapshot,
	initializeStorage,
	itemCache,
	storage,
	subscribeActiveAccountId,
} from "@/lib/storage";
import { useI18n } from "@/providers/i18n-provider";

/**
 * Get or create a unique client ID for this browser session
 */
function getClientId(): string {
	if (typeof window === "undefined") {
		return "server";
	}
	return getOrCreateClientId(window.sessionStorage);
}

class WebSyncStorage implements SyncStorage {
	private getStorageKey(key: string): string {
		return `bittery_sync_${key}`;
	}

	async get<T>(key: string): Promise<T | null> {
		if (typeof window === "undefined") {
			return null;
		}

		const value = window.localStorage.getItem(this.getStorageKey(key));
		if (!value) {
			return null;
		}

		try {
			return JSON.parse(value) as T;
		} catch {
			return null;
		}
	}

	async set<T>(key: string, value: T): Promise<void> {
		if (typeof window === "undefined") {
			return;
		}

		window.localStorage.setItem(this.getStorageKey(key), JSON.stringify(value));
	}

	async remove(key: string): Promise<void> {
		if (typeof window === "undefined") {
			return;
		}
		window.localStorage.removeItem(this.getStorageKey(key));
	}

	async update<T>(
		key: string,
		updater: (current: T | null) => T | null,
	): Promise<T | null> {
		if (typeof window === "undefined") {
			return updater(null);
		}
		const storageKey = this.getStorageKey(key);
		return navigator.locks.request(`bittery-sync:${storageKey}`, async () => {
			const stored = window.localStorage.getItem(storageKey);
			let current: T | null = null;
			if (stored) {
				try {
					current = JSON.parse(stored) as T;
				} catch {
					current = null;
				}
			}
			const next = updater(current);
			if (next === null) {
				window.localStorage.removeItem(storageKey);
			} else {
				window.localStorage.setItem(storageKey, JSON.stringify(next));
			}
			return next;
		});
	}
}

/**
 * Web-specific sync hook that integrates with existing auth system
 */
export function useWebSync(queryClient: QueryClient, enabled = true) {
	const { m } = useI18n();
	const serverUrl = getServerUrl();
	const clientId = useMemo(() => getClientId(), []);
	const syncStorage = useMemo(() => new WebSyncStorage(), []);
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

	/**
	 * The accountId the item cache is namespaced under. `ItemCache` requires a real
	 * accountId for every call, so it is read from the live active-account snapshot
	 * instead of `null`. The snapshot is refreshed whenever the unlocked set changes
	 * and explicitly after a login.
	 */
	const syncAccountId = useSyncExternalStore(
		subscribeActiveAccountId,
		getActiveAccountIdSnapshot,
		getActiveAccountIdSnapshot,
	);

	const getAuthTokenAsync = useCallback(async () => {
		await initializeStorage();
		return (await storage.getAuthToken()) || null;
	}, []);

	const onSessionRevoked = useCallback(async () => {
		// Server-side revocation is a sign-out, not a lock: the quick-unlock prompt must
		// not reappear for a session the server has already killed.
		await forgetActiveSession();
		queryClient.clear();

		if (
			typeof window !== "undefined" &&
			window.location.pathname !== "/login"
		) {
			window.location.href = "/login";
		}
	}, [queryClient]);
	// A queued mutation carries the account that produced it, so the drain must
	// authenticate as that account rather than as whichever one is active now.
	const getClientForAccount = useCallback(
		async (accountId: string): Promise<OutboundQueueApiClient> => {
			await initializeStorage();
			const client = await createStoredAccountApiClient(
				storage,
				accountId,
				clientId,
			);
			if (!client) {
				throw new Error(`No API client for account ${accountId}`);
			}
			return client;
		},
		[clientId],
	);

	const refreshFromServer = useMemo(
		() => createStagedFullRefresh(storage, vaultCoordinator),
		[vaultCoordinator],
	);
	const initializeFromServer = useMemo(
		() => createInitialSyncBootstrap(storage, vaultCoordinator),
		[vaultCoordinator],
	);
	const onTerminalCommandFailure = useCallback(() => {
		toast.error(m.sync_command_terminal_error(), {
			description: m.sync_command_terminal_error_description(),
		});
	}, [m]);

	return useSync({
		serverUrl,
		getAuthToken: getAuthTokenAsync,
		clientId,
		queryClient,
		storage: syncStorage,
		enabled,
		itemCacheAdapter: vaultCoordinator,
		itemCacheAccountId: syncAccountId,
		getClientForAccount,
		refreshFromServer,
		initializeFromServer,
		onSessionRevoked,
		onTerminalCommandFailure,
	});
}

/**
 * Get the client ID for use in mutations
 */
export function useSyncClientId(): string {
	return useMemo(() => getClientId(), []);
}
