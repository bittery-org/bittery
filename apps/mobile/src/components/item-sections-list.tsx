import { memo, useCallback, useMemo } from "react";
import { FlatList, RefreshControl } from "react-native";
import { layout } from "@/components/ui";
import type { Item } from "@/types/item";
import {
	buildItemSections,
	type ItemSection,
} from "@/utils/build-item-sections";
import { ItemListItem } from "./item-list-item";
import { ItemSectionHeader } from "./item-section-header";

export interface ItemSectionsListProps {
	favorites: Item[];
	regularItems: Item[];
	onItemPress: (item: Item) => void;
	refreshing?: boolean;
	onRefresh?: () => void;
	showVaultBadge?: boolean;
	/** Padding that clears the tab bar — pass `useBottomInset(...)`. */
	bottomInset?: number;
	ListEmptyComponent?: React.ComponentProps<
		typeof FlatList
	>["ListEmptyComponent"];
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
		return <ItemSectionHeader kind={section.kind} count={section.count} />;
	}

	const item = section.item;

	return (
		<ItemListItem
			item={item}
			vault={"vault" in item ? item.vault : undefined}
			showVaultBadge={showVaultBadge}
			onPress={() => onItemPress(item)}
			isFirstInSection={section.isFirst}
			isLastInSection={section.isLast}
		/>
	);
});

/**
 * The app's main item surface: favorites first, then everything else, each
 * group painted as one grouped card and virtualised as a flat row list.
 */
export function ItemSectionsList({
	favorites,
	regularItems,
	onItemPress,
	refreshing = false,
	onRefresh,
	showVaultBadge = false,
	bottomInset = layout.gap.lg,
	ListEmptyComponent,
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
			item.type === "header" ? `header-${item.kind}` : item.item.id,
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
			ListEmptyComponent={ListEmptyComponent}
			keyboardShouldPersistTaps="handled"
			style={{ flex: 1 }}
			contentContainerStyle={{ paddingBottom: bottomInset, flexGrow: 1 }}
		/>
	);
}
