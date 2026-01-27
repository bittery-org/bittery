/**
 * useItems Hook - Unified Item Fetching
 *
 * Automatically detects whether we're in single-account or "All Accounts" mode
 * and fetches items accordingly. Components don't need to care about the mode.
 *
 * This replaces the pattern of:
 * ```
 * const isAllAccountsMode = activeEmail.data === "all";
 * const singleAccountData = useAllDecryptedItems({ enabled: !isAllAccountsMode });
 * const multiAccountData = useAllAccountsItems({ enabled: isAllAccountsMode });
 * const { items } = isAllAccountsMode ? multiAccountData : singleAccountData;
 * ```
 *
 * With simply:
 * ```
 * const { items } = useItems();
 * ```
 */

import { useQuery } from "@tanstack/react-query";
import { usePlatformStorage } from "../context/platform-context";
import {
	type MultiAccountItem,
	useAllAccountsItems,
} from "./internal/use-all-accounts-items";
import {
	type CrossVaultDecryptedItem,
	useAllDecryptedItems,
} from "./internal/use-all-decrypted-items";

export type UnifiedItem = CrossVaultDecryptedItem | MultiAccountItem;

export interface UseItemsOptions {
	enabled?: boolean;
}

/**
 * Hook to fetch all items across vaults.
 * Automatically handles single-account vs "All Accounts" mode.
 *
 * @param options - Query options
 * @returns Items, loading state, error, and refetch function
 *
 * @example
 * ```tsx
 * const { items, isLoading } = useItems();
 *
 * items.map(item => (
 *   <ItemCard key={item.id} item={item} />
 * ))
 * ```
 */
export function useItems(options: UseItemsOptions = {}) {
	const storage = usePlatformStorage();

	// Detect current mode
	const { data: activeEmail } = useQuery({
		queryKey: ["accounts", "active"],
		queryFn: () => storage.getActiveAccountEmail(),
		staleTime: 5 * 1000,
		enabled: storage.supportsMultiAccount && options.enabled !== false,
	});

	const isAllAccountsMode = activeEmail === "all";

	// Fetch data based on mode
	const singleAccountData = useAllDecryptedItems({
		enabled: options.enabled !== false && !isAllAccountsMode,
	});

	const multiAccountData = useAllAccountsItems({
		enabled: options.enabled !== false && isAllAccountsMode,
	});

	// Return unified interface
	const result = isAllAccountsMode ? multiAccountData : singleAccountData;

	return {
		items: result.items as UnifiedItem[],
		isLoading: result.isLoading,
		error: result.error,
		refetch: result.refetch,
		isAllAccountsMode,
	};
}
