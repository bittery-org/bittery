import {
	type UnifiedDeletedItem,
	useAllDeletedItems,
	usePermanentDeleteItem,
	useRestoreItem,
} from "@bittery/hooks";
import { ArchiveRestore, Trash2 } from "lucide-react-native";
import { useMemo, useState } from "react";
import {
	ActivityIndicator,
	Alert,
	FlatList,
	RefreshControl,
	Text,
	TouchableOpacity,
	View,
} from "react-native";
import { Swipeable } from "react-native-gesture-handler";
import { SafeAreaView } from "@/components/safe-area-view";
import { ItemListItem } from "../../src/components/item-list-item";

function formatDeletedAt(dateString: string): string {
	const date = new Date(dateString);
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

	if (diffDays === 0) return "Today";
	if (diffDays === 1) return "Yesterday";
	if (diffDays < 7) return `${diffDays} days ago`;
	if (diffDays < 30)
		return `${Math.floor(diffDays / 7)} week${diffDays >= 14 ? "s" : ""} ago`;
	return date.toLocaleDateString();
}

export default function TrashScreen() {
	const [refreshing, setRefreshing] = useState(false);
	const [actionInProgress, setActionInProgress] = useState<string | null>(null);

	const { items, isLoading, error, refetch } = useAllDeletedItems();

	// Shared hooks for item operations
	const restoreItem = useRestoreItem();
	const permanentDeleteItem = usePermanentDeleteItem();

	// Sort by deletion date (most recent first)
	const sortedItems = useMemo(() => {
		return [...items].sort((a, b) => {
			const dateA = new Date(a.deletedAt).getTime();
			const dateB = new Date(b.deletedAt).getTime();
			return dateB - dateA;
		});
	}, [items]);

	const handleRefresh = async () => {
		setRefreshing(true);
		try {
			await refetch();
		} finally {
			setRefreshing(false);
		}
	};

	const handleRestore = async (item: UnifiedDeletedItem) => {
		setActionInProgress(item.id);
		try {
			await restoreItem.mutateAsync({ itemId: item.id, vaultId: item.vaultId });
			await refetch();
		} catch (error) {
			console.error("Failed to restore item:", error);
			Alert.alert("Error", "Failed to restore item. Please try again.");
		} finally {
			setActionInProgress(null);
		}
	};

	const handlePermanentDelete = (item: UnifiedDeletedItem) => {
		Alert.alert(
			"Permanently Delete",
			`Are you sure you want to permanently delete "${item.title}"? This cannot be undone.`,
			[
				{ text: "Cancel", style: "cancel" },
				{
					text: "Delete",
					style: "destructive",
					onPress: async () => {
						setActionInProgress(item.id);
						try {
							await permanentDeleteItem.mutateAsync({
								itemId: item.id,
								vaultId: item.vaultId,
							});
							await refetch();
						} catch (error) {
							console.error("Failed to delete item:", error);
							Alert.alert("Error", "Failed to delete item. Please try again.");
						} finally {
							setActionInProgress(null);
						}
					},
				},
			],
		);
	};

	const renderRightActions = (item: UnifiedDeletedItem) => (
		<TouchableOpacity
			onPress={() => handlePermanentDelete(item)}
			className="items-center justify-center bg-destructive px-6"
			disabled={actionInProgress === item.id}
		>
			{actionInProgress === item.id ? (
				<ActivityIndicator size="small" color="#fff" />
			) : (
				<>
					<Trash2 size={20} color="#fff" />
					<Text className="mt-1 text-white text-xs">Delete</Text>
				</>
			)}
		</TouchableOpacity>
	);

	const renderLeftActions = (item: UnifiedDeletedItem) => (
		<TouchableOpacity
			onPress={() => handleRestore(item)}
			className="items-center justify-center bg-green-500 px-6"
			disabled={actionInProgress === item.id}
		>
			{actionInProgress === item.id ? (
				<ActivityIndicator size="small" color="#fff" />
			) : (
				<>
					<ArchiveRestore size={20} color="#fff" />
					<Text className="mt-1 text-white text-xs">Restore</Text>
				</>
			)}
		</TouchableOpacity>
	);

	const renderItem = ({ item }: { item: UnifiedDeletedItem }) => (
		<Swipeable
			renderRightActions={() => renderRightActions(item)}
			renderLeftActions={() => renderLeftActions(item)}
			overshootRight={false}
			overshootLeft={false}
		>
			<View className="flex-row items-center bg-background">
				<ItemListItem
					id={item.id}
					title={item.title || "[Untitled]"}
					category={item.category}
					favorite={item.favorite}
					username={item.username}
					url={item.url}
					vault={item.vault}
					showVaultBadge
					onPress={() => {}}
					rightContent={
						<Text className="text-muted-foreground text-xs">
							{formatDeletedAt(
								typeof item.deletedAt === "string"
									? item.deletedAt
									: item.deletedAt?.toISOString() || "",
							)}
						</Text>
					}
				/>
			</View>
		</Swipeable>
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
				<Text className="text-destructive">Error loading trash</Text>
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
			{/* Info banner */}
			<View className="flex-row items-center bg-muted/50 px-4 py-3">
				<Text className="flex-1 text-muted-foreground text-sm">
					Swipe right to restore, swipe left to delete permanently
				</Text>
			</View>

			{/* Trash list */}
			{sortedItems.length === 0 ? (
				<View className="flex-1 items-center justify-center p-8">
					<Trash2 size={48} color="#9ca3af" />
					<Text className="mt-4 text-center font-semibold text-foreground text-lg">
						Trash is empty
					</Text>
					<Text className="mt-2 text-center text-muted-foreground">
						Items you delete will appear here for 30 days before being
						permanently removed
					</Text>
				</View>
			) : (
				<FlatList
					data={sortedItems}
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
