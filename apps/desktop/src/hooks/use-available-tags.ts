import type { DecryptedItem } from "@bittery/shared/types";
import { useMemo } from "react";

/**
 * Extract all unique tags from decrypted items
 */
export function useAvailableTags(items: DecryptedItem[]): string[] {
	return useMemo(() => {
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
}

/**
 * Filter items by selected tags
 * Returns items that have at least one of the selected tags
 */
export function filterItemsByTags(
	items: DecryptedItem[],
	selectedTags: string[],
): DecryptedItem[] {
	if (selectedTags.length === 0) return items;
	return items.filter((item) =>
		item.tags?.some((tag) => selectedTags.includes(tag)),
	);
}
