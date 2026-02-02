import { type UnifiedItem, useItems } from "@bittery/hooks";
import type { ItemCategory } from "@bittery/shared/types";
import { Tabs, useRouter } from "expo-router";
import { Button, Card, Chip, Skeleton, TextField } from "heroui-native";
import { Key, Plus, Search, Star } from "lucide-react-native";
import { useMemo, useState } from "react";
import { FlatList, RefreshControl, View } from "react-native";
import { withUniwind } from "uniwind";
import { SafeAreaView } from "@/components/safe-area-view";
import { ItemListItem } from "../../src/components/item-list-item";
import { VaultPicker } from "../../src/components/vault-picker";

// Create styled icon components
const StyledSearch = withUniwind(Search);
const StyledKey = withUniwind(Key);
const StyledPlus = withUniwind(Plus);
const StyledStar = withUniwind(Star);

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
		<View className="border-border border-b px-4 py-3">
			<FlatList
				horizontal
				showsHorizontalScrollIndicator={false}
				data={categories}
				keyExtractor={(item) => item}
				renderItem={({ item: category }) => (
					<View className="mr-2">
						<Chip
							variant={selectedCategory === category ? "primary" : "secondary"}
							color={selectedCategory === category ? "accent" : "default"}
							onPress={() => setSelectedCategory(category)}
							size="md"
						>
							<Chip.Label>{categoryLabels[category]}</Chip.Label>
						</Chip>
					</View>
				)}
				contentContainerStyle={{ paddingVertical: 4 }}
			/>
		</View>
	);

	const renderItem = ({
		item,
		isFirst,
		isLast,
	}: { item: UnifiedItem; isFirst: boolean; isLast: boolean }) => (
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
			// Position in section for rounded corners
			isFirstInSection={isFirst}
			isLastInSection={isLast}
		/>
	);

	const renderSectionHeader = (title: string, count: number) => (
		<View className="flex-row items-center px-4 pt-4 pb-2">
			{title === "Favorites" && (
				<StyledStar
					size={14}
					fill="#eab308"
					className="mr-1.5 text-yellow-500"
				/>
			)}
			<Card.Title className="font-semibold text-muted-foreground text-xs uppercase tracking-wide">
				{title} ({count})
			</Card.Title>
		</View>
	);

	const renderListContent = () => {
		if (favorites.length === 0 && regularItems.length === 0) {
			return (
				<View className="flex-1 items-center justify-center p-8">
					<Card
						variant="secondary"
						className="w-full max-w-sm items-center p-8"
					>
						<StyledKey size={48} className="mb-4 text-muted" />
						<Card.Title className="mb-2 text-center text-lg">
							{searchQuery || selectedCategory !== "all"
								? "No items found"
								: "No items yet"}
						</Card.Title>
						<Card.Description className="text-center">
							{searchQuery || selectedCategory !== "all"
								? "Try a different search or filter"
								: "Add items to your vaults to see them here"}
						</Card.Description>
					</Card>
				</View>
			);
		}

		// Combine sections into a single data array
		const sections: Array<
			| { type: "header"; title: string; count: number }
			| {
					type: "item";
					item: UnifiedItem;
					isFirst: boolean;
					isLast: boolean;
			  }
		> = [];

		if (favorites.length > 0) {
			sections.push({
				type: "header",
				title: "Favorites",
				count: favorites.length,
			});
			for (let i = 0; i < favorites.length; i++) {
				sections.push({
					type: "item",
					item: favorites[i],
					isFirst: i === 0,
					isLast: i === favorites.length - 1,
				});
			}
		}

		if (regularItems.length > 0) {
			sections.push({
				type: "header",
				title: "All Items",
				count: regularItems.length,
			});
			for (let i = 0; i < regularItems.length; i++) {
				sections.push({
					type: "item",
					item: regularItems[i],
					isFirst: i === 0,
					isLast: i === regularItems.length - 1,
				});
			}
		}

		return (
			<FlatList
				data={sections}
				renderItem={({ item: section }) => {
					if (section.type === "header") {
						return renderSectionHeader(section.title, section.count);
					}
					return renderItem({
						item: section.item,
						isFirst: section.isFirst,
						isLast: section.isLast,
					});
				}}
				keyExtractor={(item, _index) =>
					item.type === "header" ? `header-${item.title}` : item.item.id
				}
				refreshControl={
					<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
				}
				style={{ flex: 1 }}
				contentContainerStyle={{ paddingTop: 8, paddingBottom: 8, flexGrow: 1 }}
			/>
		);
	};

	const renderSkeletonItem = (index: number) => (
		<Card key={index} className="mx-4 mb-2">
			<Card.Body className="flex-row items-center py-3">
				<Skeleton className="mr-3 h-10 w-10 rounded-lg" />
				<View className="flex-1">
					<Skeleton className="mb-2 h-4 w-32 rounded" />
					<Skeleton className="h-3 w-24 rounded" />
				</View>
			</Card.Body>
		</Card>
	);

	if (isLoading) {
		return (
			<SafeAreaView className="flex-1 bg-background" edges={[]}>
				{/* Search Skeleton */}
				<View className="border-border border-b px-4 py-3">
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

				{/* Category filter skeleton */}
				<View className="flex-row gap-2 border-border border-b px-4 py-3">
					{[1, 2, 3, 4, 5].map((i) => (
						<Skeleton key={i} className="h-8 w-16 rounded-full" />
					))}
				</View>

				{/* Skeleton items */}
				<View className="flex-1 py-2">
					{[1, 2, 3, 4, 5, 6].map(renderSkeletonItem)}
				</View>
			</SafeAreaView>
		);
	}

	if (error) {
		return (
			<SafeAreaView
				className="flex-1 items-center justify-center bg-background p-8"
				edges={[]}
			>
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

	return (
		<>
			<Tabs.Screen
				options={{
					headerRight: () => (
						<Button
							isIconOnly
							variant="primary"
							size="sm"
							onPress={() => setShowVaultPicker(true)}
							className="mr-4"
						>
							<StyledPlus size={18} className="text-accent-foreground" />
						</Button>
					),
				}}
			/>
			<SafeAreaView className="flex-1 bg-background" edges={[]}>
				{/* Search */}
				<View className="border-border border-b px-4 py-3">
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

				{/* Category Filter */}
				{renderCategoryFilter()}

				{/* Items List */}
				<View className="flex-1">{renderListContent()}</View>
			</SafeAreaView>
			<VaultPicker
				visible={showVaultPicker}
				onClose={() => setShowVaultPicker(false)}
				onSelect={handleVaultSelect}
			/>
		</>
	);
}
