/**
 * useAccountSwitcher Hook
 *
 * React hook for managing multi-account operations via AccountSessionManager.
 */

import type { AccountMetadata, ActiveAccount } from "@bittery/storage/types";
import {
	type UseMutationResult,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import {
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
	activeAccount: ActiveAccount;
	unlockedAccountIds: string[];
	isInitialized: boolean;
	refresh(): Promise<void>;
	switchAccount: UseMutationResult<void, Error, ActiveAccount, unknown>;
	/** Resolves the outcome so callers can branch on `remaining`/`activeAccount` without re-reading storage. */
	removeAccount: UseMutationResult<LifecycleOutcome, Error, string, unknown>;
	updateAccount: UseMutationResult<void, Error, AccountMetadata, unknown>;
	lockAllAccounts: UseMutationResult<void, Error, void, unknown>;
}

function useAccountSessionManager(): AccountSessionManager {
	const storage = usePlatformStorage();
	const itemCache = usePlatformItemCache();
	const queryClient = useQueryClient();

	return useMemo(
		() =>
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
		[storage, itemCache, queryClient],
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
		mutationFn: async (account: ActiveAccount) => {
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
