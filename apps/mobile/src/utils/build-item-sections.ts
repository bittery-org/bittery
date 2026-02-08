import type { UnifiedItem } from "@bittery/core/hooks";
import type { DecryptedItem } from "@bittery/shared/types";

type Item = DecryptedItem | UnifiedItem;

export type ItemSection =
	| { type: "header"; title: string; count: number }
	| {
			type: "item";
			item: Item;
			isFirst: boolean;
			isLast: boolean;
	  };

export interface BuildItemSectionsOptions {
	favorites: Item[];
	regularItems: Item[];
}

/**
 * Builds a flat array of sections (headers + items) for FlatList rendering.
 * This allows rendering favorites and regular items as separate sections
 * with headers and proper first/last item indicators for styling.
 */
export function buildItemSections({
	favorites,
	regularItems,
}: BuildItemSectionsOptions): ItemSection[] {
	const sections: ItemSection[] = [];

	if (favorites.length > 0) {
		sections.push({
			type: "header",
			title: "Favorites",
			count: favorites.length,
		});
		for (let i = 0; i < favorites.length; i++) {
			sections.push({
				type: "item",
				item: favorites[i],
				isFirst: i === 0,
				isLast: i === favorites.length - 1,
			});
		}
	}

	if (regularItems.length > 0) {
		sections.push({
			type: "header",
			title: "All Items",
			count: regularItems.length,
		});
		for (let i = 0; i < regularItems.length; i++) {
			sections.push({
				type: "item",
				item: regularItems[i],
				isFirst: i === 0,
				isLast: i === regularItems.length - 1,
			});
		}
	}

	return sections;
}
