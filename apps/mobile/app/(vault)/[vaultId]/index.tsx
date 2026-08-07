import { useAllVaultKeys, useVaultItems } from "@bittery/core/hooks";
import type { ItemCategory } from "@bittery/shared/types";
import { useLocalSearchParams, useRouter } from "expo-router";
import { PressableFeedback, SearchField } from "heroui-native";
import { useDeferredValue, useState } from "react";
import { View } from "react-native";
import { CategoryFilter } from "@/components/category-filter";
import { EmptyItemsState } from "@/components/empty-items-state";
import { ItemSectionsList } from "@/components/item-sections-list";
import { ItemsSkeletonList } from "@/components/items-skeleton-list";
import {
	AppBar,
	ErrorState,
	IconAlertCircle,
	IconKey,
	IconPlus,
	IconSearch,
	IconX,
	iconSize,
	Screen,
	useBottomInset,
} from "@/components/ui";
import { VaultAvatar } from "@/components/vault-avatar";
import { useFilteredItems } from "@/hooks/use-filtered-items";
import { useI18n } from "@/providers/i18n-provider";

export default function VaultItemsScreen() {
	const { m } = useI18n();
	const router = useRouter();
	const { vaultId } = useLocalSearchParams<{ vaultId: string }>();
	const [selectedCategory, setSelectedCategory] = useState<
		ItemCategory | "all"
	>("all");
	const [searchQuery, setSearchQuery] = useState("");
	// Search unfolds from the app bar rather than holding a band open — same
	// recipe as the Items tab.
	const [isSearching, setIsSearching] = useState(false);
	const [refreshing, setRefreshing] = useState(false);
	const deferredQuery = useDeferredValue(searchQuery);
	const bottomInset = useBottomInset();

	const { items, isLoading, error, refetch } = useVaultItems(vaultId);
	const { vaultKeys } = useAllVaultKeys();
	const currentVault = vaultKeys.find((v) => v.vaultId === vaultId);

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
		router.push(`/(vault)/create?vaultId=${vaultId}`);
	};

	const closeSearch = () => {
		setIsSearching(false);
		setSearchQuery("");
	};

	const isFiltered = selectedCategory !== "all" || deferredQuery.trim() !== "";

	return (
		<Screen>
			<AppBar
				showBack
				title={
					currentVault?.vaultName ??
					(isLoading
						? m.mob_vault_items_loading()
						: m.mob_vault_items_fallback_title())
				}
				leading={
					currentVault ? (
						<VaultAvatar
							name={currentVault.vaultName}
							icon={currentVault.vaultIcon}
							imageUrl={currentVault.vaultImageUrl}
							size="xs"
						/>
					) : null
				}
				actions={
					<>
						<PressableFeedback
							onPress={() => setIsSearching(true)}
							accessibilityLabel={m.mob_tab_search()}
							className="h-9 w-9 items-center justify-center rounded-full"
						>
							<PressableFeedback.Highlight />
							<IconSearch size={iconSize.bar} className="text-foreground" />
						</PressableFeedback>
						<PressableFeedback
							onPress={handleCreateItem}
							accessibilityLabel={m.mob_create_item_header()}
							className="h-9 w-9 items-center justify-center rounded-full"
						>
							<PressableFeedback.Highlight />
							<IconPlus size={iconSize.bar} className="text-foreground" />
						</PressableFeedback>
					</>
				}
			/>

			{isSearching ? (
				<View className="flex-row items-center gap-2 px-4 pb-2.5">
					<View className="min-w-0 flex-1">
						<SearchField value={searchQuery} onChange={setSearchQuery}>
							<SearchField.Group>
								<SearchField.SearchIcon />
								<SearchField.Input
									placeholder={m.mob_vault_items_search_placeholder()}
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
			) : null}

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
					onItemPress={(item) => router.push(`/(vault)/${vaultId}/${item.id}`)}
					refreshing={refreshing}
					onRefresh={handleRefresh}
					bottomInset={bottomInset}
					ListEmptyComponent={
						<EmptyItemsState
							icon={isFiltered ? IconSearch : IconKey}
							title={
								isFiltered
									? m.mob_vault_items_empty_filtered()
									: m.mob_vault_items_empty_no_items()
							}
							description={
								isFiltered
									? m.mob_vault_items_empty_filtered_description()
									: m.mob_vault_items_empty_description()
							}
							actionLabel={
								isFiltered ? undefined : m.mob_vault_items_empty_add_item()
							}
							onAction={isFiltered ? undefined : handleCreateItem}
						/>
					}
				/>
			)}
		</Screen>
	);
}
