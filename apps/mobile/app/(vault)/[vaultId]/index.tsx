import { useAllVaultKeys, useVaultItems } from "@bittery/core/hooks";
import type { ItemCategory } from "@bittery/shared/types";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Button, Card, Input, Skeleton, TextField } from "heroui-native";
import { ArrowLeft, Key, Plus, Search } from "lucide-react-native";
import { useState } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import { withUniwind } from "uniwind";
import { CategoryFilter } from "@/components/category-filter";
import { EmptyItemsState } from "@/components/empty-items-state";
import { ItemSectionsList } from "@/components/item-sections-list";
import { ItemsSkeletonList } from "@/components/items-skeleton-list";
import { SafeAreaView } from "@/components/safe-area-view";
import { VaultAvatar } from "@/components/vault-avatar";
import { useFilteredItems } from "@/hooks/use-filtered-items";
import { useI18n } from "@/providers/i18n-provider";

// Create styled icon components
const StyledSearch = withUniwind(Search);
const StyledKey = withUniwind(Key);
const StyledPlus = withUniwind(Plus);
const StyledArrowLeft = withUniwind(ArrowLeft);

export default function VaultItemsScreen() {
	const { m } = useI18n();
	const router = useRouter();
	const { vaultId } = useLocalSearchParams<{ vaultId: string }>();
	const [selectedCategory, setSelectedCategory] = useState<
		ItemCategory | "all"
	>("all");
	const [refreshing, setRefreshing] = useState(false);

	const { items, isLoading, error, refetch } = useVaultItems(vaultId);
	const { vaultKeys = [] } = useAllVaultKeys();
	const currentVault = vaultKeys.find((v) => v.vaultId === vaultId);

	// Filter and sort items
	const { favorites, regularItems } = useFilteredItems({
		items,
		searchQuery: "",
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
				<View className="px-4 py-4">
					<View className="flex-row items-center">
						<Button isIconOnly variant="secondary" size="sm" className="mr-3">
							<StyledArrowLeft size={18} className="text-muted" />
						</Button>
						<Card.Title className="flex-1 text-xl" numberOfLines={1}>
						{m.mob_vault_items_loading()}
						</Card.Title>
						<Button isIconOnly variant="secondary" size="sm">
							<StyledPlus size={18} className="text-muted" />
						</Button>
					</View>

					{/* Search skeleton */}
					<View className="mt-4">
						<TextField>
							<View className="w-full flex-row items-center">
								<Input
									placeholder={m.mob_vault_items_search_placeholder()}
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
				<View className="flex-row gap-2 px-4 py-3">
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
					<Card.Title className="mb-4 text-center text-danger text-lg">
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
	const hasFilterOrSearch = selectedCategory !== "all";

	return (
		<SafeAreaView className="flex-1 bg-background">
			{/* Header */}
			<View className="px-4 py-4">
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
					{currentVault && (
						<VaultAvatar
							name={currentVault.vaultName}
							icon={currentVault.vaultIcon}
							imageUrl={currentVault.vaultImageUrl}
							size="sm"
							className="mr-3"
						/>
					)}
					<Card.Title className="flex-1 text-xl" numberOfLines={1}>
						{currentVault?.vaultName || m.mob_vault_items_fallback_title()}
					</Card.Title>
					<Button
						isIconOnly
						variant="primary"
						size="sm"
						onPress={() => router.push(`/(vault)/create?vaultId=${vaultId}`)}
					>
						<StyledPlus size={18} className="text-accent-foreground" />
					</Button>
				</View>
			</View>

			{/* Category Filter */}
			<CategoryFilter
				selectedCategory={selectedCategory}
				onCategoryChange={setSelectedCategory}
			/>

			{/* Items List */}
			{hasNoItems ? (
				<ScrollView
					contentContainerStyle={{ flexGrow: 1 }}
					refreshControl={
						<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
					}
				>
					<EmptyItemsState
						icon={<StyledKey size={48} className="mb-4 text-muted" />}
						title={hasFilterOrSearch ? m.mob_vault_items_empty_filtered() : m.mob_vault_items_empty_no_items()}
						description={
							hasFilterOrSearch
								? m.mob_vault_items_empty_filtered_description()
								: m.mob_vault_items_empty_description()
						}
						actionLabel={!hasFilterOrSearch ? m.mob_vault_items_empty_add_item() : undefined}
						onAction={
							!hasFilterOrSearch
								? () => router.push(`/(vault)/create?vaultId=${vaultId}`)
								: undefined
						}
					/>
				</ScrollView>
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
