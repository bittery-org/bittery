import {
	type UnifiedDeletedItem,
	useAllDeletedItems,
	usePermanentDeleteItem,
	useRestoreItem,
} from "@bittery/hooks";
import { Button, Card, Skeleton, useToast } from "heroui-native";
import { ArchiveRestore, ChevronLeft, ChevronRight, Trash2 } from "lucide-react-native";
import { useMemo, useState } from "react";
import {
	ActivityIndicator,
	Alert,
	FlatList,
	RefreshControl,
	Text,
	View,
} from "react-native";
import Swipeable from "react-native-gesture-handler/ReanimatedSwipeable";
import { withUniwind } from "uniwind";
import { SafeAreaView } from "@/components/safe-area-view";
import { ItemListItem } from "../../src/components/item-list-item";

// Create styled icon components
const StyledTrash = withUniwind(Trash2);
const StyledArchiveRestore = withUniwind(ArchiveRestore);
const StyledChevronLeft = withUniwind(ChevronLeft);
const StyledChevronRight = withUniwind(ChevronRight);

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
	const { toast } = useToast();
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
			toast.show({
				variant: "success",
				label: "Item restored successfully",
				placement: "bottom",
			});
		} catch (error) {
			console.error("Failed to restore item:", error);
			toast.show({
				variant: "danger",
				label: "Failed to restore item. Please try again.",
				placement: "bottom",
			});
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
							toast.show({
								variant: "success",
								label: "Item permanently deleted",
								placement: "bottom",
							});
						} catch (error) {
							console.error("Failed to delete item:", error);
							toast.show({
								variant: "danger",
								label: "Failed to delete item. Please try again.",
								placement: "bottom",
							});
						} finally {
							setActionInProgress(null);
						}
					},
				},
			],
		);
	};

	const renderRightActions = (item: UnifiedDeletedItem) => (
		<View className="items-center justify-center bg-danger px-6">
			{actionInProgress === item.id ? (
				<ActivityIndicator size="small" color="#fff" />
			) : (
				<Button
					isIconOnly
					variant="ghost"
					onPress={() => handlePermanentDelete(item)}
					isDisabled={actionInProgress === item.id}
				>
					<StyledTrash size={20} className="text-white" />
				</Button>
			)}
		</View>
	);

	const renderLeftActions = (item: UnifiedDeletedItem) => (
		<View className="items-center justify-center bg-success px-6">
			{actionInProgress === item.id ? (
				<ActivityIndicator size="small" color="#fff" />
			) : (
				<Button
					isIconOnly
					variant="ghost"
					onPress={() => handleRestore(item)}
					isDisabled={actionInProgress === item.id}
				>
					<StyledArchiveRestore size={20} className="text-white" />
				</Button>
			)}
		</View>
	);

	const renderItem = ({ item }: { item: UnifiedDeletedItem }) => (
		<Swipeable
			renderRightActions={() => renderRightActions(item)}
			renderLeftActions={() => renderLeftActions(item)}
			overshootRight={false}
			overshootLeft={false}
		>
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
					<Text className="text-muted text-xs">
						{formatDeletedAt(
							typeof item.deletedAt === "string"
								? item.deletedAt
								: item.deletedAt?.toISOString() || "",
						)}
					</Text>
				}
			/>
		</Swipeable>
	);

	if (isLoading) {
		return (
			<SafeAreaView className="flex-1 bg-background" edges={[]}>
				{/* Info banner skeleton */}
				<View className="border-border border-b px-4 py-3">
					<Skeleton className="h-4 w-3/4 rounded" />
				</View>

				{/* Skeleton items */}
				<View className="gap-2 p-4">
					{[1, 2, 3, 4, 5].map((i) => (
						<Card key={i} variant="secondary" className="p-4">
							<View className="flex-row items-center gap-3">
								<Skeleton className="h-10 w-10 rounded-full" />
								<View className="flex-1 gap-2">
									<Skeleton className="h-4 w-3/4 rounded" />
									<Skeleton className="h-3 w-1/2 rounded" />
								</View>
							</View>
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
				edges={[]}
			>
				<Card variant="secondary" className="w-full max-w-sm items-center p-8">
					<Card.Title className="mb-4 text-center text-destructive text-lg">
						Error loading trash
					</Card.Title>
					<Button onPress={handleRefresh} variant="primary">
						Retry
					</Button>
				</Card>
			</SafeAreaView>
		);
	}

	return (
		<SafeAreaView className="flex-1 bg-background" edges={[]}>
			{/* Swipe hint */}
			<View className="border-border flex-row items-center justify-center gap-8 border-b bg-surface/50 py-3">
				<View className="flex-row items-center gap-1.5">
					<StyledChevronRight size={18} className="text-success" />
					<StyledArchiveRestore size={18} className="text-success" />
				</View>
				<View className="h-4 w-px bg-border" />
				<View className="flex-row items-center gap-1.5">
					<StyledTrash size={18} className="text-danger" />
					<StyledChevronLeft size={18} className="text-danger" />
				</View>
			</View>

			{/* Trash list */}
			{sortedItems.length === 0 ? (
				<View className="flex-1 items-center justify-center p-8">
					<StyledTrash size={48} className="mb-4 text-muted" />
					<Text className="text-center font-semibold text-foreground text-lg">
						Trash is empty
					</Text>
					<Text className="mt-2 text-center text-muted">
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
