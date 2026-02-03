import type { UnifiedItem } from "@bittery/hooks";
import type { DecryptedItem } from "@bittery/shared/types";
import { FlatList, RefreshControl } from "react-native";
import { buildItemSections } from "../utils/build-item-sections";
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
	const sections = buildItemSections({ favorites, regularItems });

	return (
		<FlatList
			data={sections}
			renderItem={({ item: section }) => {
				if (section.type === "header") {
					return (
						<ItemSectionHeader title={section.title} count={section.count} />
					);
				}

				const item = section.item;
				return (
					<ItemListItem
						id={item.id}
						title={item.title || "[Untitled]"}
						category={item.category}
						favorite={item.favorite}
						username={item.username}
						url={item.url}
						vault={"vault" in item ? item.vault : undefined}
						showVaultBadge={showVaultBadge}
						onPress={() => onItemPress(item)}
						// Pass TOTP data for inline display
						totpSecret={item.totpSecret}
						totpAlgorithm={item.totpAlgorithm}
						totpDigits={item.totpDigits}
						totpPeriod={item.totpPeriod}
						// Show inline TOTP for TOTP items or login items with TOTP secret
						showInlineTotp={
							(item.category === "totp" || item.category === "login") &&
							Boolean(item.totpSecret)
						}
						// Position in section for rounded corners
						isFirstInSection={section.isFirst}
						isLastInSection={section.isLast}
					/>
				);
			}}
			keyExtractor={(item, _index) =>
				item.type === "header" ? `header-${item.title}` : item.item.id
			}
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
