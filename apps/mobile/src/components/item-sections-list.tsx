import type { UnifiedItem } from "@bittery/core/hooks";
import type { DecryptedItem } from "@bittery/shared/types";
import { memo, useCallback, useMemo } from "react";
import { FlatList, RefreshControl } from "react-native";
import {
	buildItemSections,
	type ItemSection,
} from "../utils/build-item-sections";
import { ItemListItem } from "./item-list-item";
import { ItemSectionHeader } from "./item-section-header";

type Item = DecryptedItem | UnifiedItem;

export interface ItemSectionsListProps {
	favorites: Item[];
	regularItems: Item[];
	onItemPress: (item: Item) => void;
	refreshing?: boolean;
	onRefresh?: () => void;
	showVaultBadge?: boolean;
}

interface ItemSectionRowProps {
	section: ItemSection;
	onItemPress: (item: Item) => void;
	showVaultBadge: boolean;
}

const ItemSectionRow = memo(function ItemSectionRow({
	section,
	onItemPress,
	showVaultBadge,
}: ItemSectionRowProps) {
	if (section.type === "header") {
		return <ItemSectionHeader title={section.title} count={section.count} />;
	}

	const item = section.item;

	return (
		<ItemListItem
			item={item}
			vault={"vault" in item ? item.vault : undefined}
			showVaultBadge={showVaultBadge}
			onPress={() => onItemPress(item)}
			// Position in section for rounded corners
			isFirstInSection={section.isFirst}
			isLastInSection={section.isLast}
		/>
	);
});

/**
 * Renders a sectioned list of items with favorites and regular items separated.
 * Handles section headers, item rendering with TOTP support, and pull-to-refresh.
 */
export function ItemSectionsList({
	favorites,
	regularItems,
	onItemPress,
	refreshing = false,
	onRefresh,
	showVaultBadge = false,
}: ItemSectionsListProps) {
	const sections = useMemo(
		() => buildItemSections({ favorites, regularItems }),
		[favorites, regularItems],
	);

	const renderItem = useCallback(
		({ item: section }: { item: ItemSection }) => (
			<ItemSectionRow
				section={section}
				onItemPress={onItemPress}
				showVaultBadge={showVaultBadge}
			/>
		),
		[onItemPress, showVaultBadge],
	);

	const keyExtractor = useCallback(
		(item: ItemSection) =>
			item.type === "header" ? `header-${item.title}` : item.item.id,
		[],
	);

	return (
		<FlatList
			data={sections}
			renderItem={renderItem}
			keyExtractor={keyExtractor}
			refreshControl={
				onRefresh ? (
					<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
				) : undefined
			}
			keyboardShouldPersistTaps="handled"
			style={{ flex: 1 }}
			contentContainerStyle={{ paddingTop: 8, paddingBottom: 8, flexGrow: 1 }}
		/>
	);
}
