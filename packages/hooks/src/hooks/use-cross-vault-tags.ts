/**
 * useCrossVaultTags Hook
 *
 * Extracts all unique tags from all items across all vaults.
 * Returns sorted array of tag names.
 * Context-aware: works in both single-account and "All Accounts" mode.
 */

import { useMemo } from "react";
import { useItems } from "./use-items";

/**
 * Hook to extract all unique tags from all items across all vaults.
 * Returns sorted array of tag names.
 * Context-aware: works in both single-account and "All Accounts" mode.
 *
 * @returns Object containing tags array, loading state, and error
 */
export function useCrossVaultTags() {
  const { items, isLoading, error } = useItems();

  const tags = useMemo(() => {
    const tagSet = new Set<string>();
    for (const item of items) {
      if (item.tags) {
        for (const tag of item.tags) {
          tagSet.add(tag);
        }
      }
    }
    return Array.from(tagSet).sort();
  }, [items]);

  return {
    tags,
    isLoading,
    error,
  };
}
