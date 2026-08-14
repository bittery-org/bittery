import type { AccountSessionManager } from "@bittery/core/services/account-session-manager";
import { createAccountSync } from "@bittery/core/services/account-sync";
import type { AccountVaultRuntime } from "@bittery/core/services/account-vault-runtime";
import { getOrCreateClientId, type SyncStorage, useSync } from "@bittery/sync";
import { toast } from "@bittery/ui";
import { type QueryClient, useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { crypto } from "@/lib/crypto";
import { lifecycleDeps } from "@/lib/lifecycle";
import { vaultCrypto, vaultRepository } from "@/lib/vault-runtime";
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
		// Web Locks span every same-origin tab, which are all the contexts that can enqueue
		// or acknowledge this browser's queue document.
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
export function useWebSync(
	queryClient: QueryClient,
	manager: AccountSessionManager,
	vaultRuntime: AccountVaultRuntime,
	enabled = true,
) {
	const { m } = useI18n();
	const clientId = useMemo(() => getClientId(), []);
	const syncStorage = useMemo(() => new WebSyncStorage(), []);
	const accountSync = useMemo(
		() =>
			createAccountSync({
				lifecycle: lifecycleDeps,
				vaultRepository,
				crypto,
				vaultCrypto,
			}),
		[],
	);

	/**
	 * The accountId the item cache is namespaced under. `ItemCache` requires a real
	 * accountId for every call, so it is read from the live active-account snapshot
	 * instead of `null`. The snapshot is refreshed whenever the unlocked set changes
	 * and explicitly after a login.
	 */
	useSyncExternalStore(
		manager.subscribe,
		manager.getSnapshot,
		manager.getSnapshot,
	);
	const syncAccountId = manager.getActiveAccount();
	const runtimeRevision = useSyncExternalStore(
		vaultRuntime.subscribe,
		() => vaultRuntime.getSnapshot().revision,
		() => vaultRuntime.getSnapshot().revision,
	);
	const { data: assembly = null, isFetched } = useQuery({
		queryKey: [
			"account-sync-assembly",
			clientId,
			syncAccountId,
			runtimeRevision,
		],
		queryFn: () =>
			accountSync.assemble({
				clientId,
				activeAccountId: syncAccountId,
			}),
	});

	const onSessionRevoked = useCallback(
		async (payload: { sessionId: string }) => {
			// Server-side revocation is a sign-out, not a lock: the quick-unlock prompt must
			// not reappear for a session the server has already killed.
			await accountSync.invalidateSession(payload);
			queryClient.clear();

			if (
				typeof window !== "undefined" &&
				window.location.pathname !== "/login"
			) {
				window.location.href = "/login";
			}
		},
		[accountSync, queryClient],
	);
	const onTerminalCommandFailure = useCallback(() => {
		toast.error(m.sync_command_terminal_error(), {
			description: m.sync_command_terminal_error_description(),
		});
	}, [m]);

	return useSync({
		clientId,
		queryClient,
		sources: assembly?.sources ?? [],
		storage: syncStorage,
		enabled: enabled && isFetched && assembly !== null,
		replicaStore: assembly?.replicaStore,
		commandProjection: assembly?.commandProjection,
		semanticCommandExecutor: assembly?.semanticCommandExecutor,
		getClientForAccount: assembly?.getClientForAccount,
		onEventProcessed: assembly?.onEventProcessed,
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
