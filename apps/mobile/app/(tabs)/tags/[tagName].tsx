import { type UnifiedItem, useItems } from "@bittery/hooks";
import type { ItemCategory } from "@bittery/shared/types";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { Button, Card, Chip, Skeleton } from "heroui-native";
import { ArrowLeft, Tag } from "lucide-react-native";
import { useLayoutEffect, useMemo, useState } from "react";
import { FlatList, RefreshControl, Text, View } from "react-native";
import { withUniwind } from "uniwind";
import { SafeAreaView } from "@/components/safe-area-view";
import { ItemListItem } from "../../../src/components/item-list-item";

// Create styled icon components
const StyledTag = withUniwind(Tag);
const StyledArrowLeft = withUniwind(ArrowLeft);

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

	const { items, isLoading, error, refetch } = useItems();

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

	const handleItemPress = (item: UnifiedItem) => {
		router.push(`/${item.vaultId}/${item.id}`);
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

	if (isLoading) {
		return (
			<SafeAreaView className="flex-1 bg-background" edges={["bottom"]}>
				{/* Tag header skeleton */}
				<View className="flex-row items-center border-border border-b px-4 py-3">
					<Skeleton className="mr-3 h-9 w-9 rounded-full" />
					<Skeleton className="h-8 w-24 rounded-full" />
				</View>

				{/* Category filter skeleton */}
				<View className="flex-row gap-2 border-border border-b px-4 py-3">
					{[1, 2, 3, 4, 5].map((i) => (
						<Skeleton key={i} className="h-8 w-16 rounded-full" />
					))}
				</View>

				{/* Skeleton items */}
				<View className="flex-1 p-4">
					{[1, 2, 3, 4, 5, 6].map((i) => (
						<Card key={i} className="mb-2">
							<Card.Body className="flex-row items-center py-3">
								<Skeleton className="mr-3 h-10 w-10 rounded-lg" />
								<View className="flex-1">
									<Skeleton className="mb-2 h-4 w-32 rounded" />
									<Skeleton className="h-3 w-24 rounded" />
								</View>
							</Card.Body>
						</Card>
					))}
				</View>
			</SafeAreaView>
		);
	}

	if (error) {
		return (
			<SafeAreaView
				className="flex-1 items-center justify-center bg-background p-8"
				edges={["bottom"]}
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
		<SafeAreaView className="flex-1 bg-background" edges={["bottom"]}>
			{/* Tag header */}
			<View className="flex-row items-center border-border border-b px-4 py-3">
				<Button
					isIconOnly
					variant="secondary"
					size="sm"
					onPress={() => router.back()}
					className="mr-3"
				>
					<StyledArrowLeft size={20} className="text-foreground" />
				</Button>
				<Chip variant="primary" color="accent" size="md">
					<StyledTag size={14} className="text-current" />
					<Chip.Label>{decodedTagName}</Chip.Label>
				</Chip>
				<Text className="ml-2 text-muted-foreground">
					{filteredItems.length} item{filteredItems.length !== 1 ? "s" : ""}
				</Text>
			</View>

			{/* Category Filter */}
			{renderCategoryFilter()}

			{/* Items list */}
			{filteredItems.length === 0 ? (
				<View className="flex-1 items-center justify-center p-8">
					<Card
						variant="secondary"
						className="w-full max-w-sm items-center p-8"
					>
						<StyledTag size={48} className="mb-4 text-muted" />
						<Card.Title className="mb-2 text-center text-lg">
							No items found
						</Card.Title>
						<Card.Description className="text-center">
							{selectedCategory !== "all"
								? "Try a different category filter"
								: "No items have this tag"}
						</Card.Description>
					</Card>
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
