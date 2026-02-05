/**
 * useCrossVaultTags Hook
 *
 * Extracts all unique tags from all items across all vaults.
 * Returns sorted array of tag names.
 * Context-aware: works in both single-account and "All Accounts" mode.
 */

import { useMemo } from "react";
import { useItems } from "./use-items";
import type { MultiAccountItem } from "./internal/use-items-unified";

/**
 * Hook to extract all unique tags from all items across all vaults.
 * Returns sorted array of tag names.
 * Context-aware: works in both single-account and "All Accounts" mode.
 *
 * @returns Object containing tags array, loading state, and error
 */
export function useCrossVaultTags(items?: MultiAccountItem[]) {
  const { items: fetchedItems, isLoading, error } = useItems({
    enabled: items == null,
  });

  const allItems = items ?? fetchedItems;

  const tags = useMemo(() => {
    const tagSet = new Set<string>();
    for (const item of allItems) {
      if (item.tags) {
        for (const tag of item.tags) {
          tagSet.add(tag);
        }
      }
    }
    return Array.from(tagSet).sort();
  }, [allItems]);

  return {
    tags,
    isLoading,
    error,
  };
}
