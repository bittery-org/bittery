import type { UnifiedItem } from "@bittery/core/hooks";
import type { DecryptedItem } from "@bittery/shared/types";

type Item = DecryptedItem | UnifiedItem;

export type ItemSectionKind = "favorites" | "all";

export type ItemSection =
	| { type: "header"; kind: ItemSectionKind; count: number }
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
 * Flattens favorites and the rest into one array a `FlatList` can virtualise,
 * carrying the position flags each row needs to round its grouped-card corners.
 */
export function buildItemSections({
	favorites,
	regularItems,
}: BuildItemSectionsOptions): ItemSection[] {
	const sections: ItemSection[] = [];

	for (const [kind, items] of [
		["favorites", favorites],
		["all", regularItems],
	] as const) {
		if (items.length === 0) continue;

		sections.push({ type: "header", kind, count: items.length });
		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			if (!item) continue;
			sections.push({
				type: "item",
				item,
				isFirst: i === 0,
				isLast: i === items.length - 1,
			});
		}
	}

	return sections;
}
