import { useItems } from "@bittery/core/hooks";
import type { ItemCategory } from "@bittery/shared/types";
import { useRouter } from "expo-router";
import { PressableFeedback, SearchField } from "heroui-native";
import { useDeferredValue, useState } from "react";
import { View } from "react-native";
import { AccountSwitcher } from "@/components/account-switcher";
import { CategoryFilter } from "@/components/category-filter";
import { EmptyItemsState } from "@/components/empty-items-state";
import { ItemSectionsList } from "@/components/item-sections-list";
import { ItemsSkeletonList } from "@/components/items-skeleton-list";
import {
	AppBar,
	ErrorState,
	Fab,
	IconAlertCircle,
	IconKey,
	IconSearch,
	IconX,
	iconSize,
	layout,
	Screen,
	useBottomInset,
} from "@/components/ui";
import { useFilteredItems } from "@/hooks/use-filtered-items";
import { useI18n } from "@/providers/i18n-provider";

const FAB_CLEARANCE = layout.gap.lg + 56;

export default function AllItemsScreen() {
	const { m } = useI18n();
	const router = useRouter();
	const [selectedCategory, setSelectedCategory] = useState<
		ItemCategory | "all"
	>("all");
	const [searchQuery, setSearchQuery] = useState("");
	// Search takes over the title row rather than sitting under it — a field the
	// user is not typing in does not earn a permanent band on a phone.
	const [isSearching, setIsSearching] = useState(false);
	const [refreshing, setRefreshing] = useState(false);
	const deferredQuery = useDeferredValue(searchQuery);
	const bottomInset = useBottomInset({ tabBar: true, extra: FAB_CLEARANCE });

	const { items, isLoading, error, refetch } = useItems();

	const { favorites, regularItems } = useFilteredItems({
		items,
		searchQuery: deferredQuery,
		selectedCategory,
	});

	const handleRefresh = async () => {
		setRefreshing(true);
		try {
			await refetch();
		} finally {
			setRefreshing(false);
		}
	};

	const handleCreateItem = () => {
		router.push("/(vault)/create");
	};

	const closeSearch = () => {
		setIsSearching(false);
		setSearchQuery("");
	};

	const isFiltered = selectedCategory !== "all" || deferredQuery.trim() !== "";

	return (
		<Screen aurora>
			{isSearching ? (
				<View className="flex-row items-center gap-2 px-4 py-1.5">
					<View className="min-w-0 flex-1">
						<SearchField value={searchQuery} onChange={setSearchQuery}>
							<SearchField.Group>
								<SearchField.SearchIcon />
								<SearchField.Input
									placeholder={m.mob_search_placeholder()}
									autoCapitalize="none"
									autoCorrect={false}
									autoFocus
									returnKeyType="search"
								/>
								<SearchField.ClearButton
									accessibilityLabel={m.mob_search_clear()}
								/>
							</SearchField.Group>
						</SearchField>
					</View>
					<PressableFeedback
						onPress={closeSearch}
						accessibilityLabel={m.mob_common_close()}
						className="h-9 w-9 items-center justify-center rounded-full"
					>
						<PressableFeedback.Highlight />
						<IconX size={iconSize.bar} className="text-foreground" />
					</PressableFeedback>
				</View>
			) : (
				<AppBar
					largeTitle={m.mob_tab_all_items()}
					leading={<AccountSwitcher />}
					actions={
						<PressableFeedback
							onPress={() => setIsSearching(true)}
							accessibilityLabel={m.mob_tab_search()}
							className="h-9 w-9 items-center justify-center rounded-full"
						>
							<PressableFeedback.Highlight />
							<IconSearch size={iconSize.bar} className="text-foreground" />
						</PressableFeedback>
					}
				/>
			)}

			<CategoryFilter
				selectedCategory={selectedCategory}
				onCategoryChange={setSelectedCategory}
			/>

			{isLoading ? (
				<ItemsSkeletonList />
			) : error ? (
				<ErrorState
					icon={IconAlertCircle}
					title={m.mob_items_error_loading()}
					actionLabel={m.mob_items_button_retry()}
					onAction={handleRefresh}
				/>
			) : (
				<ItemSectionsList
					favorites={favorites}
					regularItems={regularItems}
					onItemPress={(item) =>
						router.push(`/(vault)/${item.vaultId}/${item.id}`)
					}
					refreshing={refreshing}
					onRefresh={handleRefresh}
					showVaultBadge
					bottomInset={bottomInset}
					ListEmptyComponent={
						<EmptyItemsState
							icon={isFiltered ? IconSearch : IconKey}
							title={
								isFiltered
									? m.mob_items_empty_no_items_filtered()
									: m.mob_items_empty_no_items()
							}
							description={
								isFiltered
									? m.mob_items_empty_try_filter()
									: m.mob_items_empty_add_items_description()
							}
							actionLabel={
								isFiltered ? undefined : m.mob_vault_items_empty_add_item()
							}
							onAction={isFiltered ? undefined : handleCreateItem}
						/>
					}
				/>
			)}

			<Fab
				onPress={handleCreateItem}
				accessibilityLabel={m.mob_create_item_header()}
			/>
		</Screen>
	);
}
