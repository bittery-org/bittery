/**
 * useItems Hook - Unified Item Fetching
 *
 * Automatically detects whether we're in single-account or "All Accounts" mode
 * and fetches items accordingly. Components don't need to care about the mode.
 */

import { useQuery } from "@tanstack/react-query";
import { useCoreContext } from "../context/platform-context";
import type { MultiAccountItem as CoreMultiAccountItem } from "../services/item-service";
import { useAccountsInfo } from "./use-accounts-info";

/**
 * Decrypted item with source account metadata (for multi-account mode)
 */
export type MultiAccountItem = CoreMultiAccountItem;
export type UnifiedItem = MultiAccountItem;

export interface UseItemsOptions {
	enabled?: boolean;
}

// Backwards-compatible alias for existing consumers.
export type UseItemsUnifiedOptions = UseItemsOptions;

/**
 * Hook to fetch and decrypt items from active account(s).
 */
export function useItems(options: UseItemsOptions = {}) {
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
		queryKey: ["items", accountsInfo.map((account) => account.email).sort()],
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

// Backwards-compatible alias for existing consumers.
export function useItemsUnified(options: UseItemsUnifiedOptions = {}) {
	return useItems(options);
}
