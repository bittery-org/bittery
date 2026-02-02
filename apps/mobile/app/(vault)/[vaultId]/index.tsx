import { useVaultItems } from "@bittery/hooks";
import type { ItemCategory } from "@bittery/shared/types";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Button, Card, Skeleton, TextField } from "heroui-native";
import { ArrowLeft, Key, Plus, Search } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";
import { withUniwind } from "uniwind";
import { CategoryFilter } from "@/components/category-filter";
import { EmptyItemsState } from "@/components/empty-items-state";
import { ItemSectionsList } from "@/components/item-sections-list";
import { ItemsSkeletonList } from "@/components/items-skeleton-list";
import { SafeAreaView } from "@/components/safe-area-view";
import { useFilteredItems } from "@/hooks/use-filtered-items";

// Create styled icon components
const StyledSearch = withUniwind(Search);
const StyledKey = withUniwind(Key);
const StyledPlus = withUniwind(Plus);
const StyledArrowLeft = withUniwind(ArrowLeft);

export default function VaultItemsScreen() {
	const router = useRouter();
	const { vaultId } = useLocalSearchParams<{ vaultId: string }>();
	const [searchQuery, setSearchQuery] = useState("");
	const [selectedCategory, setSelectedCategory] = useState<
		ItemCategory | "all"
	>("all");
	const [refreshing, setRefreshing] = useState(false);

	const { items, isLoading, error, refetch } = useVaultItems(vaultId);

	// Filter and sort items
	const { favorites, regularItems } = useFilteredItems({
		items,
		searchQuery,
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


	if (isLoading) {
		return (
			<SafeAreaView className="flex-1 bg-background">
				{/* Header */}
				<View className="border-border border-b px-4 py-4">
					<View className="flex-row items-center">
						<Button isIconOnly variant="secondary" size="sm" className="mr-3">
							<StyledArrowLeft size={18} className="text-muted" />
						</Button>
						<Card.Title className="flex-1 text-xl">Items</Card.Title>
						<Button isIconOnly variant="secondary" size="sm">
							<StyledPlus size={18} className="text-muted" />
						</Button>
					</View>

					{/* Search skeleton */}
					<View className="mt-4">
						<TextField>
							<View className="w-full flex-row items-center">
								<TextField.Input
									placeholder="Search items..."
									editable={false}
									className="flex-1 pr-4 pl-12"
								/>
								<StyledSearch
									size={18}
									className="absolute left-3.5 text-muted"
									pointerEvents="none"
								/>
							</View>
						</TextField>
					</View>
				</View>

				{/* Category filter skeleton */}
				<View className="flex-row gap-2 border-border border-b px-4 py-3">
					{[1, 2, 3, 4, 5].map((i) => (
						<Skeleton key={i} className="h-8 w-16 rounded-full" />
					))}
				</View>

				{/* Skeleton items */}
				<ItemsSkeletonList />
			</SafeAreaView>
		);
	}

	if (error) {
		return (
			<SafeAreaView className="flex-1 items-center justify-center bg-background p-8">
				<Card variant="secondary" className="w-full max-w-sm items-center p-8">
					<Card.Title className="mb-4 text-center text-destructive text-lg">
						Error loading items
					</Card.Title>
					<Button onPress={handleRefresh} variant="primary">
						Retry
					</Button>
				</Card>
			</SafeAreaView>
		);
	}

	const hasNoItems = favorites.length === 0 && regularItems.length === 0;
	const hasFilterOrSearch = searchQuery || selectedCategory !== "all";

	return (
		<SafeAreaView className="flex-1 bg-background">
			{/* Header */}
			<View className="border-border border-b px-4 py-4">
				<View className="flex-row items-center">
					<Button
						isIconOnly
						variant="secondary"
						size="sm"
						onPress={() => router.back()}
						className="mr-3"
					>
						<StyledArrowLeft size={18} className="text-foreground" />
					</Button>
					<Card.Title className="flex-1 text-xl">Items</Card.Title>
					<Button
						isIconOnly
						variant="primary"
						size="sm"
						onPress={() => router.push(`/(vault)/create?vaultId=${vaultId}`)}
					>
						<StyledPlus size={18} className="text-accent-foreground" />
					</Button>
				</View>

				{/* Search */}
				<View className="mt-4">
					<TextField>
						<View className="w-full flex-row items-center">
							<TextField.Input
								placeholder="Search items..."
								value={searchQuery}
								onChangeText={setSearchQuery}
								autoCapitalize="none"
								autoCorrect={false}
								className="flex-1 pr-4 pl-12"
							/>
							<StyledSearch
								size={18}
								className="absolute left-3.5 text-muted"
								pointerEvents="none"
							/>
						</View>
					</TextField>
				</View>
			</View>

			{/* Category Filter */}
			<CategoryFilter
				selectedCategory={selectedCategory}
				onCategoryChange={setSelectedCategory}
			/>

			{/* Items List */}
			{hasNoItems ? (
				<EmptyItemsState
					icon={<StyledKey size={48} className="mb-4 text-muted" />}
					title={hasFilterOrSearch ? "No items found" : "No items yet"}
					description={
						hasFilterOrSearch
							? "Try a different search or filter"
							: "Add your first password or secure item"
					}
					actionLabel={!hasFilterOrSearch ? "Add Item" : undefined}
					onAction={
						!hasFilterOrSearch
							? () => router.push(`/(vault)/create?vaultId=${vaultId}`)
							: undefined
					}
				/>
			) : (
				<ItemSectionsList
					favorites={favorites}
					regularItems={regularItems}
					onItemPress={(item) => router.push(`/(vault)/${vaultId}/${item.id}`)}
					refreshing={refreshing}
					onRefresh={handleRefresh}
				/>
			)}
		</SafeAreaView>
	);
}
