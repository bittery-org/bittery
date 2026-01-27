/**
 * useAllDeletedItems Hook - Unified Deleted Items Fetching
 *
 * Automatically detects whether we're in single-account or "All Accounts" mode
 * and fetches deleted items accordingly. Components don't need to care about the mode.
 *
 * Uses the unified internal implementation that handles both modes with a single
 * code path, eliminating the need for conditional hook calls and complex mode detection.
 */

import {
	type MultiAccountDeletedItem,
	useDeletedItemsUnified,
} from "./internal/use-deleted-items-unified";

export type UnifiedDeletedItem = MultiAccountDeletedItem;

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
	return useDeletedItemsUnified(options);
}
