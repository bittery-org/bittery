/**
 * Unified Deleted Items Hook
 *
 * Handles both single account and "All Accounts" mode with a unified implementation.
 */

import type { MultiAccountDeletedItem as CoreMultiAccountDeletedItem } from "@bittery/core";
import { useQuery } from "@tanstack/react-query";
import { useCoreContext } from "../../context/platform-context";
import { useAccountsInfo } from "./use-accounts-info";

/**
 * Deleted item with source account metadata (for multi-account mode)
 */
export type MultiAccountDeletedItem = CoreMultiAccountDeletedItem;

/**
 * Options for useDeletedItemsUnified hook
 */
export interface UseDeletedItemsUnifiedOptions {
	enabled?: boolean;
}

/**
 * Hook to fetch and decrypt deleted items from active account(s).
 */
export function useDeletedItemsUnified(
	options: UseDeletedItemsUnifiedOptions = {},
) {
	const core = useCoreContext();
	const {
		accountsInfo,
		isLoading: isLoadingAccounts,
		isAllAccountsMode,
	} = useAccountsInfo({ enabled: options.enabled });

	const {
		data: items = [],
		isLoading: isLoadingItems,
		error,
		refetch,
	} = useQuery({
		queryKey: [
			"deleted-items-unified",
			accountsInfo.map((account) => account.email).sort(),
		],
		queryFn: () =>
			core.items.fetchDeletedItems(accountsInfo, {
				isAllAccountsMode,
			}),
		enabled: accountsInfo.length > 0 && options.enabled !== false,
		staleTime: 5 * 60 * 1000,
		gcTime: 10 * 60 * 1000,
	});

	return {
		items,
		isLoading: isLoadingAccounts || isLoadingItems,
		error,
		refetch,
		isAllAccountsMode,
		unlockedAccounts: accountsInfo,
	};
}
