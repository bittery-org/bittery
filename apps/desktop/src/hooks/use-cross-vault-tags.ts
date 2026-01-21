import { useMemo } from "react";
import { useAllDecryptedItems } from "./use-all-decrypted-items";

/**
 * Hook to extract all unique tags from all items across all vaults.
 * Returns sorted array of tag names.
 */
export function useCrossVaultTags() {
	const { items, isLoading, error } = useAllDecryptedItems();

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
