import type { ItemCategory } from "@bittery/shared/types";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { ArrowLeft, Tag } from "lucide-react-native";
import { useLayoutEffect, useMemo, useState } from "react";
import {
	ActivityIndicator,
	FlatList,
	RefreshControl,
	ScrollView,
	Text,
	TouchableOpacity,
	View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ItemListItem } from "../../../src/components/item-list-item";
import { TagChip } from "../../../src/components/tag-chip";
import {
	type CrossVaultDecryptedItem,
	useAllDecryptedItems,
} from "../../../src/hooks/use-all-decrypted-items";

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

export default function TagFilterScreen() {
	const router = useRouter();
	const navigation = useNavigation();
	const { tagName } = useLocalSearchParams<{ tagName: string }>();
	const decodedTagName = decodeURIComponent(tagName || "");

	// Set the header title dynamically
	useLayoutEffect(() => {
		navigation.setOptions({
			title: decodedTagName || "Tag",
		});
	}, [navigation, decodedTagName]);

	const [selectedCategory, setSelectedCategory] = useState<
		ItemCategory | "all"
	>("all");
	const [refreshing, setRefreshing] = useState(false);

	const { items, isLoading, error, refetch } = useAllDecryptedItems();

	// Filter items by tag and category
	const filteredItems = useMemo(() => {
		let filtered = items.filter((item) =>
			item.tags?.some(
				(tag) => tag.toLowerCase() === decodedTagName.toLowerCase(),
			),
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
	}, [items, decodedTagName, selectedCategory]);

	const handleRefresh = async () => {
		setRefreshing(true);
		try {
			await refetch();
		} finally {
			setRefreshing(false);
		}
	};

	const handleItemPress = (item: CrossVaultDecryptedItem) => {
		router.push(`/${item.vaultId}/${item.id}`);
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

	const renderItem = ({ item }: { item: CrossVaultDecryptedItem }) => (
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

	if (isLoading) {
		return (
			<SafeAreaView
				className="flex-1 items-center justify-center bg-background"
				edges={["bottom"]}
			>
				<ActivityIndicator size="large" color="#000" />
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
		<SafeAreaView className="flex-1 bg-background" edges={["bottom"]}>
			{/* Tag header */}
			<View className="flex-row items-center border-border border-b px-4 py-3">
				<TouchableOpacity
					onPress={() => router.back()}
					className="mr-3 rounded-full bg-secondary p-2"
				>
					<ArrowLeft size={20} color="#6b7280" />
				</TouchableOpacity>
				<TagChip name={decodedTagName} selected />
				<Text className="ml-2 text-muted-foreground">
					{filteredItems.length} item{filteredItems.length !== 1 ? "s" : ""}
				</Text>
			</View>

			{/* Category Filter */}
			{renderCategoryFilter()}

			{/* Items list */}
			{filteredItems.length === 0 ? (
				<View className="flex-1 items-center justify-center p-8">
					<Tag size={48} color="#9ca3af" />
					<Text className="mt-4 text-center font-semibold text-foreground text-lg">
						No items found
					</Text>
					<Text className="mt-2 text-center text-muted-foreground">
						{selectedCategory !== "all"
							? "Try a different category filter"
							: "No items have this tag"}
					</Text>
				</View>
			) : (
				<FlatList
					data={filteredItems}
					renderItem={renderItem}
					keyExtractor={(item) => item.id}
					refreshControl={
						<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
					}
				/>
			)}
		</SafeAreaView>
	);
}
