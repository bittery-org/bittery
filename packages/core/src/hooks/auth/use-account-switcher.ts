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
import { usePlatformStorage } from "../../context/platform-context";
import {
	type AccountSessionManager,
	getAccountSessionManager,
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
	removeAccount: UseMutationResult<void, Error, string, unknown>;
	updateAccount: UseMutationResult<void, Error, AccountMetadata, unknown>;
	lockAllAccounts: UseMutationResult<void, Error, void, unknown>;
}

function useAccountSessionManager(): AccountSessionManager {
	const storage = usePlatformStorage();
	const queryClient = useQueryClient();

	return useMemo(
		() =>
			getAccountSessionManager({
				storage,
				invalidateQueries: async (keys) => {
					await Promise.all(
						keys.map((key) => queryClient.invalidateQueries({ queryKey: key })),
					);
				},
			}),
		[storage, queryClient],
	);
}

export function useAccountSwitcher(
	options: UseAccountSwitcherOptions = {},
): UseAccountSwitcherResult {
	const storage = usePlatformStorage();
	const manager = useAccountSessionManager();
	const enabled = options.enabled !== false && storage.supportsMultiAccount;
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
		mutationFn: async (accountId: string) => {
			await manager.removeAccount(accountId);
		},
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
