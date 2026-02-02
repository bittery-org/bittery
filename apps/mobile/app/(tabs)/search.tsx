import { type UnifiedItem, useItems } from "@bittery/hooks";
import type { ItemCategory } from "@bittery/shared/types";
import { useRouter } from "expo-router";
import * as SecureStore from "expo-secure-store";
import { Clock, Search as SearchIcon, X } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	FlatList,
	ScrollView,
	Text,
	TextInput,
	TouchableOpacity,
	View,
} from "react-native";
import { SafeAreaView } from "@/components/safe-area-view";
import { ItemListItem } from "../../src/components/item-list-item";

const RECENT_SEARCHES_KEY = "bittery_recent_searches";
const MAX_RECENT_SEARCHES = 10;

const categoryLabels: Record<ItemCategory | "all", string> = {
	all: "All",
	login: "Login",
	"credit-card": "Card",
	identity: "Identity",
	"secure-note": "Note",
	totp: "TOTP",
};

const categories: (ItemCategory | "all")[] = [
	"all",
	"login",
	"credit-card",
	"identity",
	"secure-note",
	"totp",
];

export default function SearchScreen() {
	const router = useRouter();
	const inputRef = useRef<TextInput>(null);
	const [searchQuery, setSearchQuery] = useState("");
	const [selectedCategory, setSelectedCategory] = useState<
		ItemCategory | "all"
	>("all");
	const [recentSearches, setRecentSearches] = useState<string[]>([]);
	const [debouncedQuery, setDebouncedQuery] = useState("");

	const { items } = useItems();

	const loadRecentSearches = useCallback(async () => {
		try {
			const stored = await SecureStore.getItemAsync(RECENT_SEARCHES_KEY);
			if (stored) {
				setRecentSearches(JSON.parse(stored));
			}
		} catch (error) {
			console.error("Failed to load recent searches:", error);
		}
	}, []);

	// Load recent searches on mount
	useEffect(() => {
		loadRecentSearches();
	}, [loadRecentSearches]);

	// Debounce search query
	useEffect(() => {
		const timer = setTimeout(() => {
			setDebouncedQuery(searchQuery);
		}, 300);
		return () => clearTimeout(timer);
	}, [searchQuery]);

	// Auto-focus on mount
	useEffect(() => {
		const timer = setTimeout(() => {
			inputRef.current?.focus();
		}, 100);
		return () => clearTimeout(timer);
	}, []);

	const saveRecentSearch = async (query: string) => {
		if (!query.trim()) return;

		try {
			const updated = [
				query,
				...recentSearches.filter(
					(s) => s.toLowerCase() !== query.toLowerCase(),
				),
			].slice(0, MAX_RECENT_SEARCHES);

			setRecentSearches(updated);
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
			setRecentSearches(updated);
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
			setRecentSearches([]);
			await SecureStore.deleteItemAsync(RECENT_SEARCHES_KEY);
		} catch (error) {
			console.error("Failed to clear recent searches:", error);
		}
	};

	// Filter items based on search
	const filteredItems = useMemo(() => {
		if (!debouncedQuery.trim()) return [];

		const query = debouncedQuery.toLowerCase();
		let filtered = items.filter(
			(item) =>
				item.title?.toLowerCase().includes(query) ||
				item.username?.toLowerCase().includes(query) ||
				item.url?.toLowerCase().includes(query) ||
				item.notes?.toLowerCase().includes(query) ||
				item.tags?.some((tag) => tag.toLowerCase().includes(query)),
		);

		// Apply category filter
		if (selectedCategory !== "all") {
			filtered = filtered.filter((item) => item.category === selectedCategory);
		}

		// Sort: favorites first, then alphabetically
		return filtered.sort((a, b) => {
			if (a.favorite && !b.favorite) return -1;
			if (!a.favorite && b.favorite) return 1;
			return (a.title || "").localeCompare(b.title || "");
		});
	}, [items, debouncedQuery, selectedCategory]);

	const handleItemPress = (item: UnifiedItem) => {
		saveRecentSearch(searchQuery);
		router.push(`/(vault)/${item.vaultId}/${item.id}`);
	};

	const handleRecentSearchPress = (query: string) => {
		setSearchQuery(query);
		setDebouncedQuery(query);
	};

	const renderCategoryFilter = () => (
		<View className="border-border border-b">
			<ScrollView
				horizontal
				showsHorizontalScrollIndicator={false}
				contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 8 }}
			>
				{categories.map((category) => (
					<TouchableOpacity
						key={category}
						onPress={() => setSelectedCategory(category)}
						className={`mr-2 rounded-full px-4 py-2 ${
							selectedCategory === category ? "bg-primary" : "bg-secondary"
						}`}
					>
						<Text
							className={`font-medium text-sm ${
								selectedCategory === category
									? "text-primary-foreground"
									: "text-foreground"
							}`}
						>
							{categoryLabels[category]}
						</Text>
					</TouchableOpacity>
				))}
			</ScrollView>
		</View>
	);

	const renderItem = ({ item }: { item: UnifiedItem }) => (
		<ItemListItem
			id={item.id}
			title={item.title || "[Untitled]"}
			category={item.category}
			favorite={item.favorite}
			username={item.username}
			url={item.url}
			vault={item.vault}
			showVaultBadge
			onPress={() => handleItemPress(item)}
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
		/>
	);

	const renderRecentSearches = () => {
		if (recentSearches.length === 0) {
			return (
				<View className="flex-1 items-center justify-center p-8">
					<SearchIcon size={48} color="#9ca3af" />
					<Text className="mt-4 text-center font-semibold text-foreground text-lg">
						Search your vault
					</Text>
					<Text className="mt-2 text-center text-muted-foreground">
						Find passwords, cards, notes, and more
					</Text>
				</View>
			);
		}

		return (
			<View className="flex-1">
				<View className="flex-row items-center justify-between px-4 py-3">
					<Text className="font-semibold text-muted-foreground text-sm">
						Recent Searches
					</Text>
					<TouchableOpacity onPress={clearRecentSearches}>
						<Text className="text-primary text-sm">Clear all</Text>
					</TouchableOpacity>
				</View>
				{recentSearches.map((query) => (
					<TouchableOpacity
						key={query}
						onPress={() => handleRecentSearchPress(query)}
						className="flex-row items-center border-border border-b px-4 py-3"
						activeOpacity={0.7}
					>
						<Clock size={18} color="#9ca3af" />
						<Text className="ml-3 flex-1 text-foreground">{query}</Text>
						<TouchableOpacity
							onPress={() => removeRecentSearch(query)}
							className="p-1"
							hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
						>
							<X size={16} color="#9ca3af" />
						</TouchableOpacity>
					</TouchableOpacity>
				))}
			</View>
		);
	};

	const renderSearchResults = () => {
		if (filteredItems.length === 0) {
			return (
				<View className="flex-1 items-center justify-center p-8">
					<SearchIcon size={48} color="#9ca3af" />
					<Text className="mt-4 text-center font-semibold text-foreground text-lg">
						No results found
					</Text>
					<Text className="mt-2 text-center text-muted-foreground">
						Try a different search term or filter
					</Text>
				</View>
			);
		}

		return (
			<FlatList
				data={filteredItems}
				renderItem={renderItem}
				keyExtractor={(item) => item.id}
				ListHeaderComponent={
					<View className="px-4 py-2">
						<Text className="text-muted-foreground text-sm">
							{filteredItems.length} result
							{filteredItems.length !== 1 ? "s" : ""}
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
			<View className="border-border border-b px-4 py-2">
				<View className="flex-row items-center rounded-lg bg-secondary px-3 py-2">
					<SearchIcon size={18} color="#6b7280" />
					<TextInput
						ref={inputRef}
						className="ml-2 flex-1 text-foreground"
						placeholder="Search items..."
						value={searchQuery}
						onChangeText={setSearchQuery}
						placeholderTextColor="#9ca3af"
						returnKeyType="search"
						autoCapitalize="none"
						autoCorrect={false}
					/>
					{searchQuery.length > 0 && (
						<TouchableOpacity
							onPress={() => {
								setSearchQuery("");
								setDebouncedQuery("");
							}}
							className="p-1"
						>
							<X size={18} color="#6b7280" />
						</TouchableOpacity>
					)}
				</View>
			</View>

			{/* Category Filter (only show when searching) */}
			{hasQuery && renderCategoryFilter()}

			{/* Content */}
			{hasQuery ? renderSearchResults() : renderRecentSearches()}
		</SafeAreaView>
	);
}
