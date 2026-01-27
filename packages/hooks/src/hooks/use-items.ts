/**
 * useItems Hook - Unified Item Fetching
 *
 * Automatically detects whether we're in single-account or "All Accounts" mode
 * and fetches items accordingly. Components don't need to care about the mode.
 *
 * Uses the unified internal implementation that handles both modes with a single
 * code path, eliminating the need for conditional hook calls and complex mode detection.
 */

import {
	type MultiAccountItem,
	useItemsUnified,
} from "./internal/use-items-unified";

export type UnifiedItem = MultiAccountItem;

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
	return useItemsUnified(options);
}
