import type { DecryptedItem, ItemCategory } from "@bittery/shared/types";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
	ArrowLeft,
	CreditCard,
	FileText,
	Key,
	Plus,
	Search,
	Star,
	Timer,
	User,
} from "lucide-react-native";
import { useState } from "react";
import {
	ActivityIndicator,
	FlatList,
	RefreshControl,
	Text,
	TextInput,
	TouchableOpacity,
	View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useDecryptedItems } from "../../../src/hooks/use-decrypted-items";
import * as storage from "../../../src/services/storage";

const categoryIcons: Record<ItemCategory, typeof Key> = {
	login: Key,
	"credit-card": CreditCard,
	identity: User,
	"secure-note": FileText,
	totp: Timer,
};

const categoryLabels: Record<ItemCategory, string> = {
	login: "Login",
	"credit-card": "Credit Card",
	identity: "Identity",
	"secure-note": "Secure Note",
	totp: "TOTP",
};

export default function VaultItemsScreen() {
	const router = useRouter();
	const { vaultId } = useLocalSearchParams<{ vaultId: string }>();
	const [searchQuery, setSearchQuery] = useState("");
	const [selectedCategory, setSelectedCategory] =
		useState<ItemCategory | null>(null);
	const [refreshing, setRefreshing] = useState(false);

	const { items, isLoading, error, refetch } = useDecryptedItems(vaultId);

	// Filter items based on search and category
	const filteredItems = items.filter((item) => {
		const matchesSearch =
			searchQuery === "" ||
			item.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
			item.username?.toLowerCase().includes(searchQuery.toLowerCase()) ||
			item.url?.toLowerCase().includes(searchQuery.toLowerCase());

		const matchesCategory =
			selectedCategory === null || item.category === selectedCategory;

		return matchesSearch && matchesCategory;
	});

	// Sort: favorites first, then alphabetically
	const sortedItems = [...filteredItems].sort((a, b) => {
		if (a.favorite && !b.favorite) return -1;
		if (!a.favorite && b.favorite) return 1;
		return a.title.localeCompare(b.title);
	});

	const handleRefresh = async () => {
		setRefreshing(true);
		try {
			await refetch();
		} finally {
			setRefreshing(false);
		}
	};

	const renderCategoryFilter = () => {
		const categories: (ItemCategory | null)[] = [
			null,
			"login",
			"credit-card",
			"identity",
			"secure-note",
			"totp",
		];

		return (
			<View className="flex-row px-4 py-2">
				{categories.map((category) => (
					<TouchableOpacity
						key={category || "all"}
						onPress={() => setSelectedCategory(category)}
						className={`mr-2 rounded-full px-4 py-2 ${
							selectedCategory === category
								? "bg-primary"
								: "bg-secondary"
						}`}
					>
						<Text
							className={`text-sm font-medium ${
								selectedCategory === category
									? "text-primary-foreground"
									: "text-foreground"
							}`}
						>
							{category ? categoryLabels[category] : "All"}
						</Text>
					</TouchableOpacity>
				))}
			</View>
		);
	};

	const renderItem = ({ item }: { item: DecryptedItem }) => {
		const Icon = categoryIcons[item.category];

		return (
			<TouchableOpacity
				onPress={() => router.push(`/(vault)/${vaultId}/${item.id}`)}
				className="flex-row items-center border-b border-border px-4 py-4"
			>
				<View className="mr-4 h-10 w-10 items-center justify-center rounded-lg bg-secondary">
					<Icon size={20} color="#6b7280" />
				</View>
				<View className="flex-1">
					<View className="flex-row items-center">
						<Text className="font-medium text-foreground">{item.title}</Text>
						{item.favorite && (
							<Star size={14} color="#eab308" fill="#eab308" className="ml-2" />
						)}
					</View>
					{item.username && (
						<Text className="text-sm text-muted-foreground" numberOfLines={1}>
							{item.username}
						</Text>
					)}
					{item.url && (
						<Text className="text-sm text-muted-foreground" numberOfLines={1}>
							{item.url}
						</Text>
					)}
				</View>
			</TouchableOpacity>
		);
	};

	if (isLoading) {
		return (
			<SafeAreaView className="flex-1 items-center justify-center bg-background">
				<ActivityIndicator size="large" color="#000" />
				<Text className="mt-4 text-muted-foreground">Decrypting items...</Text>
			</SafeAreaView>
		);
	}

	if (error) {
		return (
			<SafeAreaView className="flex-1 items-center justify-center bg-background">
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
		<SafeAreaView className="flex-1 bg-background">
			{/* Header */}
			<View className="border-b border-border px-4 py-4">
				<View className="flex-row items-center">
					<TouchableOpacity
						onPress={() => router.back()}
						className="mr-3 rounded-full bg-secondary p-2"
					>
						<ArrowLeft size={20} color="#6b7280" />
					</TouchableOpacity>
					<Text className="flex-1 text-xl font-bold text-foreground">
						Items
					</Text>
					<TouchableOpacity
						onPress={() => router.push(`/(vault)/${vaultId}/create`)}
						className="rounded-full bg-primary p-2"
					>
						<Plus size={20} color="#fff" />
					</TouchableOpacity>
				</View>

				{/* Search */}
				<View className="mt-4 flex-row items-center rounded-lg bg-secondary px-3 py-2">
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

			{/* Item List */}
			<FlatList
				data={sortedItems}
				renderItem={renderItem}
				keyExtractor={(item) => item.id}
				refreshControl={
					<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
				}
				ListEmptyComponent={
					<View className="flex-1 items-center justify-center p-8">
						<Key size={48} color="#9ca3af" />
						<Text className="mt-4 text-center text-lg font-semibold text-foreground">
							{searchQuery || selectedCategory
								? "No items found"
								: "No items yet"}
						</Text>
						<Text className="mt-2 text-center text-muted-foreground">
							{searchQuery || selectedCategory
								? "Try a different search or filter"
								: "Add your first password or secure item"}
						</Text>
						{!searchQuery && !selectedCategory && (
							<TouchableOpacity
								onPress={() => router.push(`/(vault)/${vaultId}/create`)}
								className="mt-4 rounded-lg bg-primary px-6 py-3"
							>
								<Text className="font-medium text-primary-foreground">
									Add Item
								</Text>
							</TouchableOpacity>
						)}
					</View>
				}
			/>
		</SafeAreaView>
	);
}
