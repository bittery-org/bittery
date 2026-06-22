/**
 * useAccountSwitcher Hook
 *
 * React hook for managing multi-account operations via AccountSessionManager.
 */

import type { AccountMetadata, ActiveAccount } from "@bittery/storage/types";
import {
	type UseMutationResult,
	type UseQueryResult,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { usePlatformStorage } from "../../context/platform-context";
import {
	type AccountSessionManager,
	getAccountSessionManager,
} from "../../services/account-session-manager";

export interface UseAccountSwitcherOptions {
	enabled?: boolean;
}

export interface UseAccountSwitcherResult {
	accounts: UseQueryResult<AccountMetadata[], Error>;
	activeAccount: UseQueryResult<ActiveAccount, Error>;
	unlockedAccountIds: UseQueryResult<string[], Error>;
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

function toSuccessQuery<T>(
	data: T,
	enabled: boolean,
): UseQueryResult<T, Error> {
	return {
		data,
		error: null,
		isError: false,
		isPending: false,
		isLoading: false,
		isSuccess: enabled,
		status: enabled ? "success" : "pending",
		fetchStatus: "idle",
		isFetching: false,
		isRefetching: false,
		isLoadingError: false,
		isRefetchError: false,
		isPlaceholderData: false,
		isStale: false,
		dataUpdatedAt: Date.now(),
		errorUpdatedAt: 0,
		failureCount: 0,
		failureReason: null,
		errorUpdateCount: 0,
		isFetched: enabled,
		isFetchedAfterMount: enabled,
		isInitialLoading: false,
		isPaused: false,
		promise: Promise.resolve(data),
		refetch: () => Promise.resolve(toSuccessQuery(data, enabled)),
	} as UseQueryResult<T, Error>;
}

export function useAccountSwitcher(
	options: UseAccountSwitcherOptions = {},
): UseAccountSwitcherResult {
	const storage = usePlatformStorage();
	const manager = useAccountSessionManager();
	const enabled = options.enabled !== false && storage.supportsMultiAccount;

	useSyncExternalStore(manager.subscribe, manager.getSnapshot);

	useEffect(() => {
		if (enabled) {
			void manager.initialize();
		}
	}, [manager, enabled]);

	const accountsData = manager.getAccounts();
	const activeAccountData = manager.getActiveAccount();
	const unlockedAccountIdsData = manager.getUnlockedAccountIds();

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
		accounts: toSuccessQuery(accountsData, enabled),
		activeAccount: toSuccessQuery(activeAccountData, options.enabled !== false),
		unlockedAccountIds: toSuccessQuery(unlockedAccountIdsData, enabled),
		switchAccount,
		removeAccount,
		updateAccount,
		lockAllAccounts,
	};
}
