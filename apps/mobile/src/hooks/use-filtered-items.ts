import type { UnifiedItem } from "@bittery/core/hooks";
import type { DecryptedItem, ItemCategory } from "@bittery/shared/types";
import { useMemo } from "react";

type Item = DecryptedItem | UnifiedItem;

export interface UseFilteredItemsOptions {
	items: Item[];
	searchQuery?: string;
	selectedCategory?: ItemCategory | "all";
}

export interface FilteredItemsResult {
	filteredItems: Item[];
	favorites: Item[];
	regularItems: Item[];
}

/**
 * Hook to filter and sort vault items by search query and category.
 * Automatically separates favorites from regular items and sorts alphabetically.
 */
export function useFilteredItems({
	items,
	searchQuery = "",
	selectedCategory = "all",
}: UseFilteredItemsOptions): FilteredItemsResult {
	// Filter and sort items
	const filteredItems = useMemo(() => {
		let filtered = items;

		// Apply search filter
		if (searchQuery) {
			const query = searchQuery.toLowerCase();
			filtered = filtered.filter(
				(item) =>
					item.title?.toLowerCase().includes(query) ||
					item.username?.toLowerCase().includes(query) ||
					item.url?.toLowerCase().includes(query) ||
					item.notes?.toLowerCase().includes(query) ||
					("tags" in item &&
						item.tags?.some((tag: string) =>
							tag.toLowerCase().includes(query),
						)),
			);
		}

		// Apply category filter
		if (selectedCategory !== "all") {
			filtered = filtered.filter((item) => item.category === selectedCategory);
		}

		// Sort: favorites first, then alphabetically
		return [...filtered].sort((a, b) => {
			if (a.favorite && !b.favorite) return -1;
			if (!a.favorite && b.favorite) return 1;
			return (a.title || "").localeCompare(b.title || "");
		});
	}, [items, searchQuery, selectedCategory]);

	// Separate favorites and regular items
	const { favorites, regularItems } = useMemo(() => {
		const favs = filteredItems.filter((item) => item.favorite);
		const regular = filteredItems.filter((item) => !item.favorite);
		return { favorites: favs, regularItems: regular };
	}, [filteredItems]);

	return { filteredItems, favorites, regularItems };
}
