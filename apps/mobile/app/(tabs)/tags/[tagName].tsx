import { type UnifiedItem, useItems } from "@bittery/hooks";
import type { ItemCategory } from "@bittery/shared/types";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { Button, Card, Chip, Select, Skeleton } from "heroui-native";
import { ArrowLeft, ChevronDown, Tag } from "lucide-react-native";
import { useLayoutEffect, useMemo, useState } from "react";
import { FlatList, RefreshControl, ScrollView, Text, View } from "react-native";
import { withUniwind } from "uniwind";
import { SafeAreaView } from "@/components/safe-area-view";
import { categoryOptions } from "@/constants/item-categories";
import { ItemListItem } from "../../../src/components/item-list-item";

// Create styled icon components
const StyledTag = withUniwind(Tag);
const StyledArrowLeft = withUniwind(ArrowLeft);
const StyledChevronDown = withUniwind(ChevronDown);

// Generate a consistent color based on tag name
function getTagColor(
	name: string,
): "default" | "success" | "warning" | "danger" | "accent" {
	const colors: Array<"default" | "success" | "warning" | "danger" | "accent"> =
		["accent", "success", "warning", "danger", "default"];

	// Simple hash based on tag name
	let hash = 0;
	for (let i = 0; i < name.length; i++) {
		hash = name.charCodeAt(i) + ((hash << 5) - hash);
	}
	const index = Math.abs(hash) % colors.length;
	return colors[index];
}

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

	const selectedOption = categoryOptions.find(
		(opt) => opt.value === selectedCategory,
	);

	const renderCategoryFilter = () => (
		<View className="flex-row items-center justify-between border-border border-b px-4 py-2">
			<Text className="text-muted-foreground">
				{filteredItems.length} item{filteredItems.length !== 1 ? "s" : ""}
			</Text>
			<Select
				value={
					selectedOption
						? { value: selectedOption.value, label: selectedOption.label }
						: undefined
				}
				onValueChange={(option) => {
					if (option) {
						setSelectedCategory(option.value as ItemCategory | "all");
					}
				}}
			>
				<Select.Trigger asChild>
					<Button variant="ghost" size="sm">
						{selectedOption && (
							<selectedOption.icon size={16} className="text-current" />
						)}
						<Button.Label>{selectedOption?.label}</Button.Label>
						<StyledChevronDown size={16} className="text-current" />
					</Button>
				</Select.Trigger>
				<Select.Portal>
					<Select.Overlay />
					<Select.Content
						presentation="popover"
						placement="bottom"
						align="end"
						width={220}
					>
						<ScrollView className="max-h-72">
							{categoryOptions.map((option) => {
								const Icon = option.icon;
								return (
									<Select.Item
										key={option.value}
										value={option.value}
										label={option.label}
									>
										<View className="flex-1 flex-row items-center gap-3">
											<Icon size={18} className="text-muted" />
											<Text className="flex-1 text-base text-foreground">
												{option.label}
											</Text>
										</View>
										<Select.ItemIndicator />
									</Select.Item>
								);
							})}
						</ScrollView>
					</Select.Content>
				</Select.Portal>
			</Select>
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
				<View className="flex-row items-center justify-between border-border border-b px-4 py-2">
					<Skeleton className="h-4 w-20 rounded" />
					<Skeleton className="h-9 w-20 rounded-lg" />
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

	const tagColor = getTagColor(decodedTagName);

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
				<View className="flex-row items-center">
					<Chip variant="soft" color={tagColor} size="md" className="pr-2">
						<StyledTag size={14} className="text-current" />
						<Chip.Label className="font-medium mx-0.5">{decodedTagName}</Chip.Label>
					</Chip>
				</View>
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
