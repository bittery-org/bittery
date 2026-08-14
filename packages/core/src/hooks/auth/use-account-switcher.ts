/**
 * useAccountSwitcher Hook
 *
 * React hook for managing multi-account operations via AccountSessionManager.
 */

import type { AccountMetadata, ActiveAccountId } from "@bittery/storage/types";
import {
	type UseMutationResult,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import {
	usePlatformAccountManager,
	usePlatformItemCache,
	usePlatformStorage,
} from "../../context/platform-context";
import type { LifecycleOutcome } from "../../services/account-lifecycle";
import {
	type AccountSessionManager,
	getAccountSessionManager,
	peekAccountSessionManager,
} from "../../services/account-session-manager";

export interface UseAccountSwitcherOptions {
	enabled?: boolean;
}

export interface UseAccountSwitcherResult {
	accounts: AccountMetadata[];
	activeAccount: ActiveAccountId;
	unlockedAccountIds: string[];
	isInitialized: boolean;
	refresh(): Promise<void>;
	switchAccount: UseMutationResult<void, Error, ActiveAccountId, unknown>;
	/** Resolves the outcome so callers can branch on `remaining`/`activeAccount` without re-reading storage. */
	removeAccount: UseMutationResult<LifecycleOutcome, Error, string, unknown>;
	updateAccount: UseMutationResult<void, Error, AccountMetadata, unknown>;
	lockAllAccounts: UseMutationResult<void, Error, void, unknown>;
}

function useAccountSessionManager(): AccountSessionManager {
	const storage = usePlatformStorage();
	const itemCache = usePlatformItemCache();
	const ownedManager = usePlatformAccountManager();
	const queryClient = useQueryClient();

	return useMemo(
		() =>
			ownedManager ??
			// Several components use this hook, and on desktop/mobile the account
			// provider owns construction — so only construct when nobody else has.
			peekAccountSessionManager() ??
			getAccountSessionManager({
				storage,
				itemCache,
				invalidateQueries: async (keys) => {
					await Promise.all(
						keys.map((key) => queryClient.invalidateQueries({ queryKey: key })),
					);
				},
			}),
		[ownedManager, storage, itemCache, queryClient],
	);
}

export function useAccountSwitcher(
	options: UseAccountSwitcherOptions = {},
): UseAccountSwitcherResult {
	const manager = useAccountSessionManager();
	const enabled = options.enabled !== false;
	const refresh = useCallback(() => manager.refresh(), [manager]);

	useSyncExternalStore(manager.subscribe, manager.getSnapshot);

	useEffect(() => {
		if (enabled) {
			void manager.initialize();
		}
	}, [manager, enabled]);

	const switchAccount = useMutation({
		mutationFn: async (account: ActiveAccountId) => {
			await manager.switchAccount(account);
		},
	});

	const removeAccount = useMutation({
		mutationFn: (accountId: string) => manager.removeAccount(accountId),
	});

	const updateAccount = useMutation({
		mutationFn: async (metadata: AccountMetadata) => {
			await manager.addAccount(metadata);
		},
	});

	const lockAllAccounts = useMutation({
		mutationFn: async () => {
			await manager.lockAll();
		},
	});

	return {
		accounts: manager.getAccounts(),
		activeAccount: manager.getActiveAccount(),
		unlockedAccountIds: manager.getUnlockedAccountIds(),
		isInitialized: manager.isInitialized(),
		refresh,
		switchAccount,
		removeAccount,
		updateAccount,
		lockAllAccounts,
	};
}
