import { useItems } from "@bittery/core/hooks";
import type { ItemCategory } from "@bittery/shared/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import * as SecureStore from "expo-secure-store";
import { Input, TextField } from "heroui-native";
import { Clock, Search as SearchIcon, X } from "lucide-react-native";
import { useDeferredValue, useState } from "react";
import { FlatList, Text, TouchableOpacity, View } from "react-native";
import { withUniwind } from "uniwind";
import { CategoryFilter } from "@/components/category-filter";
import { EmptyItemsState } from "@/components/empty-items-state";
import { ItemListItem } from "@/components/item-list-item";
import { SafeAreaView } from "@/components/safe-area-view";
import { useFilteredItems } from "@/hooks/use-filtered-items";
import { useI18n } from "@/providers/i18n-provider";

// Create styled icon components
const StyledSearch = withUniwind(SearchIcon);
const StyledClock = withUniwind(Clock);
const StyledX = withUniwind(X);

const RECENT_SEARCHES_KEY = "bittery_recent_searches";
const MAX_RECENT_SEARCHES = 10;

export default function SearchScreen() {
	const { m } = useI18n();
	const router = useRouter();
	const queryClient = useQueryClient();
	const [searchQuery, setSearchQuery] = useState("");
	const [selectedCategory, setSelectedCategory] = useState<
		ItemCategory | "all"
	>("all");
	const debouncedQuery = useDeferredValue(searchQuery);

	const { items } = useItems();
	const recentSearchesQuery = useQuery({
		queryKey: ["mobile", "recent-searches"],
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

	// Filter items based on debounced search query
	const { filteredItems } = useFilteredItems({
		items,
		searchQuery: debouncedQuery,
		selectedCategory,
	});

	const saveRecentSearch = async (query: string) => {
		if (!query.trim()) return;

		try {
			const updated = [
				query,
				...recentSearches.filter(
					(s) => s.toLowerCase() !== query.toLowerCase(),
				),
			].slice(0, MAX_RECENT_SEARCHES);

			queryClient.setQueryData(["mobile", "recent-searches"], updated);
			await SecureStore.setItemAsync(
				RECENT_SEARCHES_KEY,
				JSON.stringify(updated),
			);
		} catch (error) {
			console.error("Failed to save recent search:", error);
		}
	};

	const removeRecentSearch = async (query: string) => {
		try {
			const updated = recentSearches.filter(
				(s) => s.toLowerCase() !== query.toLowerCase(),
			);
			queryClient.setQueryData(["mobile", "recent-searches"], updated);
			await SecureStore.setItemAsync(
				RECENT_SEARCHES_KEY,
				JSON.stringify(updated),
			);
		} catch (error) {
			console.error("Failed to remove recent search:", error);
		}
	};

	const clearRecentSearches = async () => {
		try {
			queryClient.setQueryData(["mobile", "recent-searches"], []);
			await SecureStore.deleteItemAsync(RECENT_SEARCHES_KEY);
		} catch (error) {
			console.error("Failed to clear recent searches:", error);
		}
	};

	const handleItemPress = (item: (typeof filteredItems)[number]) => {
		saveRecentSearch(searchQuery);
		router.push(`/(vault)/${item.vaultId}/${item.id}`);
	};

	const handleRecentSearchPress = (query: string) => {
		setSearchQuery(query);
	};

	const renderRecentSearches = () => {
		if (recentSearches.length === 0) {
			return (
				<EmptyItemsState
					icon={<StyledSearch size={48} className="mb-4 text-muted" />}
					title={m.mob_search_empty_title()}
					description={m.mob_search_empty_description()}
				/>
			);
		}

		return (
			<View className="flex-1">
				<View className="flex-row items-center justify-between px-4 py-3">
					<Text className="font-semibold text-muted text-sm uppercase tracking-wide">
						{m.mob_search_recent_title()}
					</Text>
					<TouchableOpacity onPress={clearRecentSearches}>
						<Text className="text-accent text-sm">
							{m.mob_search_recent_clear_all()}
						</Text>
					</TouchableOpacity>
				</View>
				{recentSearches.map((query) => (
					<TouchableOpacity
						key={query}
						onPress={() => handleRecentSearchPress(query)}
						className="flex-row items-center px-4 py-3"
						activeOpacity={0.7}
					>
						<StyledClock size={18} className="text-muted" />
						<Text className="ml-3 flex-1 text-foreground">{query}</Text>
						<TouchableOpacity
							onPress={() => removeRecentSearch(query)}
							className="p-1"
							hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
						>
							<StyledX size={16} className="text-muted" />
						</TouchableOpacity>
					</TouchableOpacity>
				))}
			</View>
		);
	};

	const renderSearchResults = () => {
		if (filteredItems.length === 0) {
			return (
				<EmptyItemsState
					icon={<StyledSearch size={48} className="mb-4 text-muted" />}
					title={m.mob_search_no_results()}
					description={m.mob_search_no_results_description()}
				/>
			);
		}

		return (
			<FlatList
				data={filteredItems}
				renderItem={({ item }) => (
					<ItemListItem
						item={item}
						vault={"vault" in item ? item.vault : undefined}
						showVaultBadge
						onPress={() => handleItemPress(item)}
					/>
				)}
				keyExtractor={(item) => item.id}
				ListHeaderComponent={
					<View className="px-4 py-2">
						<Text className="text-muted text-sm">
							{filteredItems.length !== 1
								? m.mob_search_result_count_plural({
										count: String(filteredItems.length),
									})
								: m.mob_search_result_count_singular({
										count: String(filteredItems.length),
									})}
						</Text>
					</View>
				}
				keyboardShouldPersistTaps="handled"
			/>
		);
	};

	const hasQuery = debouncedQuery.trim().length > 0;

	return (
		<SafeAreaView className="flex-1 bg-background" edges={["bottom"]}>
			{/* Search Input */}
			<View className="px-4 py-3">
				<TextField>
					<View className="w-full flex-row items-center">
						<Input
							placeholder={m.mob_search_placeholder()}
							value={searchQuery}
							onChangeText={setSearchQuery}
							returnKeyType="search"
							autoCapitalize="none"
							autoCorrect={false}
							autoFocus
							className="flex-1 pr-12 pl-12"
						/>
						<StyledSearch
							size={18}
							className="absolute left-3.5 text-muted"
							pointerEvents="none"
						/>
						{searchQuery.length > 0 && (
							<TouchableOpacity
								onPress={() => {
									setSearchQuery("");
								}}
								className="absolute right-3.5 p-1"
								hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
							>
								<StyledX size={18} className="text-muted" />
							</TouchableOpacity>
						)}
					</View>
				</TextField>
			</View>

			{/* Category Filter (only show when searching) */}
			{hasQuery && (
				<CategoryFilter
					selectedCategory={selectedCategory}
					onCategoryChange={setSelectedCategory}
				/>
			)}

			{/* Content */}
			{hasQuery ? renderSearchResults() : renderRecentSearches()}
		</SafeAreaView>
	);
}
