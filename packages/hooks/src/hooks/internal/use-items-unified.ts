/**
 * Unified Items Hook
 *
 * Handles both single account and "All Accounts" mode with a unified implementation.
 */

import type { MultiAccountItem as CoreMultiAccountItem } from "@bittery/core";
import { useQuery } from "@tanstack/react-query";
import { useCoreContext } from "../../context/platform-context";
import { useAccountsInfo } from "./use-accounts-info";

/**
 * Decrypted item with source account metadata (for multi-account mode)
 */
export type MultiAccountItem = CoreMultiAccountItem;

/**
 * Options for useItemsUnified hook
 */
export interface UseItemsUnifiedOptions {
	enabled?: boolean;
}

/**
 * Hook to fetch and decrypt items from active account(s).
 */
export function useItemsUnified(options: UseItemsUnifiedOptions = {}) {
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
			"items-unified",
			accountsInfo.map((account) => account.email).sort(),
		],
		queryFn: () =>
			core.items.fetchAndDecryptItems(accountsInfo, {
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
