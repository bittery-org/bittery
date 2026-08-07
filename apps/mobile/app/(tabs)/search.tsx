import { useItems } from "@bittery/core/hooks";
import type { ItemCategory } from "@bittery/shared/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import * as SecureStore from "expo-secure-store";
import { PressableFeedback, SearchField } from "heroui-native";
import { useDeferredValue, useState } from "react";
import { FlatList, ScrollView, Text, View } from "react-native";
import { CategoryFilter } from "@/components/category-filter";
import { EmptyItemsState } from "@/components/empty-items-state";
import { ItemListItem } from "@/components/item-list-item";
import {
	AppBar,
	IconClock,
	IconSearch,
	IconX,
	iconSize,
	layout,
	Screen,
	SectionLabel,
	useBottomInset,
} from "@/components/ui";
import { useFilteredItems } from "@/hooks/use-filtered-items";
import { useI18n } from "@/providers/i18n-provider";

const RECENT_SEARCHES_KEY = "bittery_recent_searches";
const MAX_RECENT_SEARCHES = 10;
const RECENT_SEARCHES_QUERY_KEY = ["mobile", "recent-searches"] as const;

export default function SearchScreen() {
	const { m } = useI18n();
	const router = useRouter();
	const queryClient = useQueryClient();
	const [searchQuery, setSearchQuery] = useState("");
	const [selectedCategory, setSelectedCategory] = useState<
		ItemCategory | "all"
	>("all");
	const deferredQuery = useDeferredValue(searchQuery);
	const bottomInset = useBottomInset({ tabBar: true });

	const { items } = useItems();
	const recentSearchesQuery = useQuery({
		queryKey: RECENT_SEARCHES_QUERY_KEY,
		queryFn: async () => {
			try {
				const stored = await SecureStore.getItemAsync(RECENT_SEARCHES_KEY);
				return stored ? (JSON.parse(stored) as string[]) : [];
			} catch (error) {
				console.error("Failed to load recent searches:", error);
				return [];
			}
		},
	});
	const recentSearches = recentSearchesQuery.data ?? [];

	const { filteredItems } = useFilteredItems({
		items,
		searchQuery: deferredQuery,
		selectedCategory,
	});

	const persistRecentSearches = async (next: string[]) => {
		queryClient.setQueryData(RECENT_SEARCHES_QUERY_KEY, next);
		try {
			if (next.length === 0) {
				await SecureStore.deleteItemAsync(RECENT_SEARCHES_KEY);
				return;
			}
			await SecureStore.setItemAsync(RECENT_SEARCHES_KEY, JSON.stringify(next));
		} catch (error) {
			console.error("Failed to persist recent searches:", error);
		}
	};

	const saveRecentSearch = (query: string) => {
		if (!query.trim()) return;
		const next = [
			query,
			...recentSearches.filter((s) => s.toLowerCase() !== query.toLowerCase()),
		].slice(0, MAX_RECENT_SEARCHES);
		void persistRecentSearches(next);
	};

	const removeRecentSearch = (query: string) => {
		void persistRecentSearches(
			recentSearches.filter((s) => s.toLowerCase() !== query.toLowerCase()),
		);
	};

	const handleItemPress = (item: (typeof filteredItems)[number]) => {
		saveRecentSearch(searchQuery);
		router.push(`/(vault)/${item.vaultId}/${item.id}`);
	};

	const hasQuery = deferredQuery.trim().length > 0;
	const resultCount = filteredItems.length;

	return (
		<Screen>
			<AppBar title={m.mob_tab_search()} />

			<View className="px-4 pb-3">
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

			{hasQuery ? (
				<>
					<CategoryFilter
						selectedCategory={selectedCategory}
						onCategoryChange={setSelectedCategory}
					/>
					{resultCount === 0 ? (
						<EmptyItemsState
							icon={IconSearch}
							title={m.mob_search_no_results()}
							description={m.mob_search_no_results_description()}
						/>
					) : (
						<FlatList
							data={filteredItems}
							keyExtractor={(item) => item.id}
							keyboardShouldPersistTaps="handled"
							contentContainerStyle={{ paddingBottom: bottomInset }}
							ListHeaderComponent={
								<View className="px-4 pt-6 pb-2">
									<SectionLabel className="px-0 pb-0">
										{resultCount === 1
											? m.mob_search_result_count_singular({
													count: String(resultCount),
												})
											: m.mob_search_result_count_plural({
													count: String(resultCount),
												})}
									</SectionLabel>
								</View>
							}
							renderItem={({ item, index }) => (
								<ItemListItem
									item={item}
									vault={"vault" in item ? item.vault : undefined}
									showVaultBadge
									onPress={() => handleItemPress(item)}
									isFirstInSection={index === 0}
									isLastInSection={index === filteredItems.length - 1}
								/>
							)}
						/>
					)}
				</>
			) : recentSearches.length === 0 ? (
				<EmptyItemsState
					icon={IconSearch}
					title={m.mob_search_empty_title()}
					description={m.mob_search_empty_description()}
				/>
			) : (
				<ScrollView
					keyboardShouldPersistTaps="handled"
					contentContainerStyle={{ paddingBottom: bottomInset }}
				>
					<View className="px-4 pt-6">
						<SectionLabel
							trailing={
								<PressableFeedback
									onPress={() => void persistRecentSearches([])}
									className="rounded-full px-2 py-1"
								>
									<PressableFeedback.Highlight />
									<Text className="font-medium text-accent text-xs">
										{m.mob_search_recent_clear_all()}
									</Text>
								</PressableFeedback>
							}
						>
							{m.mob_search_recent_title()}
						</SectionLabel>
						<View className="overflow-hidden rounded-2xl border border-border bg-surface">
							{recentSearches.map((query, index) => (
								<View key={query}>
									{index > 0 ? <View className="ml-4 h-px bg-border" /> : null}
									<PressableFeedback
										onPress={() => setSearchQuery(query)}
										className="flex-row items-center px-4"
										style={{ minHeight: layout.rowHeightCompact }}
									>
										<PressableFeedback.Highlight />
										<IconClock size={iconSize.row} className="text-muted" />
										<Text
											numberOfLines={1}
											className="ml-3 flex-1 text-base text-foreground"
										>
											{query}
										</Text>
										<PressableFeedback
											onPress={() => removeRecentSearch(query)}
											accessibilityLabel={m.mob_search_recent_remove()}
											className="-mr-1 h-8 w-8 items-center justify-center rounded-full"
											hitSlop={8}
										>
											<PressableFeedback.Highlight />
											<IconX size={iconSize.chip} className="text-muted" />
										</PressableFeedback>
									</PressableFeedback>
								</View>
							))}
						</View>
					</View>
				</ScrollView>
			)}
		</Screen>
	);
}
