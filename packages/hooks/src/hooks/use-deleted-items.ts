/**
 * useDeletedItems Hook - Deleted Item Fetching
 *
 * Automatically detects whether we're in single-account or "All Accounts" mode
 * and fetches deleted items accordingly. Components don't need to care about the mode.
 */

import type { MultiAccountDeletedItem as CoreMultiAccountDeletedItem } from "@bittery/core";
import { useQuery } from "@tanstack/react-query";
import { useCoreContext } from "../context/platform-context";
import { useAccountsInfo } from "./use-accounts-info";

export type DeletedItem = CoreMultiAccountDeletedItem;

export interface UseDeletedItemsOptions {
	enabled?: boolean;
}

/**
 * Hook to fetch deleted items across vaults.
 * Automatically handles single-account vs "All Accounts" mode.
 *
 * @param options - Query options
 * @returns Deleted items, loading state, error, and refetch function
 *
 * @example
 * ```tsx
 * const { items, isLoading } = useDeletedItems();
 *
 * items.map(item => (
 *   <DeletedItemCard key={item.id} item={item} />
 * ))
 * ```
 */
export function useDeletedItems(options: UseDeletedItemsOptions = {}) {
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
			"deleted-items",
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
