/**
 * useAllDeletedItems Hook - Unified Deleted Items Fetching
 *
 * Automatically detects whether we're in single-account or "All Accounts" mode
 * and fetches deleted items accordingly. Components don't need to care about the mode.
 *
 * This replaces the pattern of manually checking mode and conditionally fetching.
 *
 * Usage:
 * ```tsx
 * const { items, isLoading } = useAllDeletedItems();
 * ```
 */

import { useQuery } from "@tanstack/react-query";
import { usePlatformStorage } from "../context/platform-context";
import {
	useAllDecryptedDeletedItems,
	type CrossVaultDeletedItem,
} from "./internal/use-all-decrypted-deleted-items";
import {
	useAllAccountsDeletedItems,
	type MultiAccountDeletedItem,
} from "./internal/use-all-accounts-deleted-items";

export type UnifiedDeletedItem = CrossVaultDeletedItem | MultiAccountDeletedItem;

export interface UseAllDeletedItemsOptions {
	enabled?: boolean;
}

/**
 * Hook to fetch all deleted items across vaults.
 * Automatically handles single-account vs "All Accounts" mode.
 *
 * @param options - Query options
 * @returns Deleted items, loading state, error, and refetch function
 *
 * @example
 * ```tsx
 * const { items, isLoading } = useAllDeletedItems();
 *
 * items.map(item => (
 *   <DeletedItemCard key={item.id} item={item} />
 * ))
 * ```
 */
export function useAllDeletedItems(options: UseAllDeletedItemsOptions = {}) {
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
	const singleAccountData = useAllDecryptedDeletedItems({
		enabled: options.enabled !== false && !isAllAccountsMode,
	});

	const multiAccountData = useAllAccountsDeletedItems({
		enabled: options.enabled !== false && isAllAccountsMode,
	});

	// Return unified interface
	const result = isAllAccountsMode ? multiAccountData : singleAccountData;

	return {
		items: result.items as UnifiedDeletedItem[],
		isLoading: result.isLoading,
		error: result.error,
		refetch: result.refetch,
		isAllAccountsMode,
	};
}
