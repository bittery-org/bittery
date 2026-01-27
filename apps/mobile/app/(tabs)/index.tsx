import { type UnifiedItem, useItems } from "@bittery/hooks";
import type { ItemCategory } from "@bittery/shared/types";
import { Tabs, useRouter } from "expo-router";
import { Key, Plus, Search, Star } from "lucide-react-native";
import { useMemo, useState } from "react";
import {
	FlatList,
	RefreshControl,
	ScrollView,
	Text,
	TextInput,
	TouchableOpacity,
	View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ItemListItem } from "../../src/components/item-list-item";
import { VaultPicker } from "../../src/components/vault-picker";

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

export default function AllItemsScreen() {
	const router = useRouter();
	const [searchQuery, setSearchQuery] = useState("");
	const [selectedCategory, setSelectedCategory] = useState<
		ItemCategory | "all"
	>("all");
	const [refreshing, setRefreshing] = useState(false);
	const [showVaultPicker, setShowVaultPicker] = useState(false);

	const { items, isLoading, error, refetch } = useItems();

	const handleVaultSelect = (vaultId: string) => {
		router.push(`/(vault)/${vaultId}/create`);
	};

	// Filter and sort items
	const filteredItems = useMemo(() => {
		let filtered = items;

		// Apply search filter
		if (searchQuery) {
			const query = searchQuery.toLowerCase();
			filtered = filtered.filter(
				(item) =>
					item.title?.toLowerCase().includes(query) ||
					item.username?.toLowerCase().includes(query) ||
					item.url?.toLowerCase().includes(query) ||
					item.notes?.toLowerCase().includes(query) ||
					item.tags?.some((tag) => tag.toLowerCase().includes(query)),
			);
		}

		// Apply category filter
		if (selectedCategory !== "all") {
			filtered = filtered.filter((item) => item.category === selectedCategory);
		}

		// Sort: favorites first, then alphabetically
		return [...filtered].sort((a, b) => {
			if (a.favorite && !b.favorite) return -1;
			if (!a.favorite && b.favorite) return 1;
			return (a.title || "").localeCompare(b.title || "");
		});
	}, [items, searchQuery, selectedCategory]);

	// Separate favorites and regular items
	const { favorites, regularItems } = useMemo(() => {
		const favs = filteredItems.filter((item) => item.favorite);
		const regular = filteredItems.filter((item) => !item.favorite);
		return { favorites: favs, regularItems: regular };
	}, [filteredItems]);

	const handleRefresh = async () => {
		setRefreshing(true);
		try {
			await refetch();
		} finally {
			setRefreshing(false);
		}
	};

	const handleItemPress = (item: UnifiedItem) => {
		router.push(`/(vault)/${item.vaultId}/${item.id}`);
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

	const renderSectionHeader = (title: string, count: number) => (
		<View className="flex-row items-center bg-muted/30 px-4 py-2">
			{title === "Favorites" && (
				<Star size={14} color="#eab308" fill="#eab308" />
			)}
			<Text
				className={`font-semibold text-muted-foreground text-xs uppercase tracking-wide ${
					title === "Favorites" ? "ml-1.5" : ""
				}`}
			>
				{title} ({count})
			</Text>
		</View>
	);

	const renderListContent = () => {
		if (favorites.length === 0 && regularItems.length === 0) {
			return (
				<View className="flex-1 items-center justify-center p-8">
					<Key size={48} color="#9ca3af" />
					<Text className="mt-4 text-center font-semibold text-foreground text-lg">
						{searchQuery || selectedCategory !== "all"
							? "No items found"
							: "No items yet"}
					</Text>
					<Text className="mt-2 text-center text-muted-foreground">
						{searchQuery || selectedCategory !== "all"
							? "Try a different search or filter"
							: "Add items to your vaults to see them here"}
					</Text>
				</View>
			);
		}

		// Combine sections into a single data array
		const sections: Array<
			| { type: "header"; title: string; count: number }
			| { type: "item"; item: UnifiedItem }
		> = [];

		if (favorites.length > 0) {
			sections.push({
				type: "header",
				title: "Favorites",
				count: favorites.length,
			});
			for (const item of favorites) {
				sections.push({ type: "item", item });
			}
		}

		if (regularItems.length > 0) {
			sections.push({
				type: "header",
				title: "All Items",
				count: regularItems.length,
			});
			for (const item of regularItems) {
				sections.push({ type: "item", item });
			}
		}

		return (
			<FlatList
				data={sections}
				renderItem={({ item: section }) => {
					if (section.type === "header") {
						return renderSectionHeader(section.title, section.count);
					}
					return renderItem({ item: section.item });
				}}
				keyExtractor={(item, _index) =>
					item.type === "header" ? `header-${item.title}` : item.item.id
				}
				refreshControl={
					<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
				}
			/>
		);
	};

	const renderSkeletonItem = (index: number) => (
		<View
			key={index}
			className="flex-row items-center border-border border-b px-4 py-3"
		>
			<View className="mr-3 h-10 w-10 animate-pulse rounded-lg bg-secondary" />
			<View className="flex-1">
				<View className="h-4 w-32 animate-pulse rounded bg-secondary" />
				<View className="mt-2 h-3 w-24 animate-pulse rounded bg-secondary" />
			</View>
		</View>
	);

	if (isLoading) {
		return (
			<SafeAreaView className="flex-1 bg-background" edges={["bottom"]}>
				{/* Search */}
				<View className="border-border border-b px-4 py-2">
					<View className="flex-row items-center rounded-lg bg-secondary px-3 py-2">
						<Search size={18} color="#6b7280" />
						<View className="ml-2 h-5 flex-1 rounded bg-muted" />
					</View>
				</View>

				{/* Category filter skeleton */}
				<View className="flex-row border-border border-b px-4 py-2">
					{[1, 2, 3, 4, 5].map((i) => (
						<View
							key={i}
							className="mr-2 h-8 w-16 animate-pulse rounded-full bg-secondary"
						/>
					))}
				</View>

				{/* Skeleton items */}
				{[1, 2, 3, 4, 5, 6].map(renderSkeletonItem)}
			</SafeAreaView>
		);
	}

	if (error) {
		return (
			<SafeAreaView
				className="flex-1 items-center justify-center bg-background"
				edges={["bottom"]}
			>
				<Text className="text-destructive">Error loading items</Text>
				<TouchableOpacity
					onPress={handleRefresh}
					className="mt-4 rounded-lg bg-primary px-4 py-2"
				>
					<Text className="text-primary-foreground">Retry</Text>
				</TouchableOpacity>
			</SafeAreaView>
		);
	}

	return (
		<>
			<Tabs.Screen
				options={{
					headerRight: () => (
						<TouchableOpacity
							onPress={() => setShowVaultPicker(true)}
							className="mr-4 rounded-full bg-primary p-2"
						>
							<Plus size={18} color="#fff" />
						</TouchableOpacity>
					),
				}}
			/>
			<SafeAreaView className="flex-1 bg-background" edges={["bottom"]}>
				{/* Search */}
				<View className="border-border border-b px-4 py-2">
					<View className="flex-row items-center rounded-lg bg-secondary px-3 py-2">
						<Search size={18} color="#6b7280" />
						<TextInput
							className="ml-2 flex-1 text-foreground"
							placeholder="Search items..."
							value={searchQuery}
							onChangeText={setSearchQuery}
							placeholderTextColor="#9ca3af"
						/>
					</View>
				</View>

				{/* Category Filter */}
				{renderCategoryFilter()}

				{/* Items List */}
				{renderListContent()}
			</SafeAreaView>
			<VaultPicker
				visible={showVaultPicker}
				onClose={() => setShowVaultPicker(false)}
				onSelect={handleVaultSelect}
			/>
		</>
	);
}
