import { useMemo } from "react";
import { useAllDecryptedItems } from "./use-all-decrypted-items";

export interface TagInfo {
	name: string;
	count: number;
}

/**
 * Hook to extract all unique tags from all items across all vaults.
 * Returns sorted array of tag names with their item counts.
 */
export function useCrossVaultTags() {
	const { items, isLoading, error } = useAllDecryptedItems();

	const tags = useMemo((): TagInfo[] => {
		const tagCounts = new Map<string, number>();
		for (const item of items) {
			if (item.tags) {
				for (const tag of item.tags) {
					tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
				}
			}
		}
		return Array.from(tagCounts.entries())
			.map(([name, count]) => ({ name, count }))
			.sort((a, b) => a.name.localeCompare(b.name));
	}, [items]);

	return {
		tags,
		isLoading,
		error,
	};
}
