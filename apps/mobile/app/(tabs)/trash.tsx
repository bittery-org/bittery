import {
	type DeletedItem,
	useDeletedItems,
	usePermanentDeleteItem,
	useRestoreItem,
} from "@bittery/core/hooks";
import { Button, Card, Skeleton, useToast } from "heroui-native";
import {
	ArchiveRestore,
	ChevronLeft,
	ChevronRight,
	Trash2,
} from "lucide-react-native";
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
import { useI18n } from "@/providers/i18n-provider";
import { ItemListItem } from "../../src/components/item-list-item";

// Create styled icon components
const StyledTrash = withUniwind(Trash2);
const StyledArchiveRestore = withUniwind(ArchiveRestore);
const StyledChevronLeft = withUniwind(ChevronLeft);
const StyledChevronRight = withUniwind(ChevronRight);

type MessageFunctions = ReturnType<typeof useI18n>["m"];

function formatDeletedAt(dateString: string, m: MessageFunctions): string {
	const date = new Date(dateString);
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

	if (diffDays === 0) return m.mob_trash_time_today();
	if (diffDays === 1) return m.mob_trash_time_yesterday();
	if (diffDays < 7)
		return m.mob_trash_time_days_ago({ count: String(diffDays) });
	if (diffDays < 30) {
		const weeks = Math.floor(diffDays / 7);
		return diffDays >= 14
			? m.mob_trash_time_weeks_ago_plural({ count: String(weeks) })
			: m.mob_trash_time_weeks_ago_singular({ count: String(weeks) });
	}
	return date.toLocaleDateString();
}

export default function TrashScreen() {
	const { m } = useI18n();
	const { toast } = useToast();
	const [refreshing, setRefreshing] = useState(false);
	const [actionInProgress, setActionInProgress] = useState<string | null>(null);

	const { items, isLoading, error, refetch } = useDeletedItems();

	// Shared hooks for item operations
	const restoreItem = useRestoreItem();
	const permanentDeleteItem = usePermanentDeleteItem();

	// Sort by deletion date (most recent first)
	const sortedItems = useMemo(() => {
		return [...items].sort((a, b) => {
			const dateA = a.deletedAt ? new Date(a.deletedAt).getTime() : 0;
			const dateB = b.deletedAt ? new Date(b.deletedAt).getTime() : 0;
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

	const handleRestore = async (item: DeletedItem) => {
		setActionInProgress(item.id);
		try {
			await restoreItem.mutateAsync({ itemId: item.id, vaultId: item.vaultId });
			await refetch();
			toast.show({
				variant: "success",
				label: m.mob_trash_toast_restored(),
				placement: "bottom",
			});
		} catch (error) {
			console.error("Failed to restore item:", error);
			toast.show({
				variant: "danger",
				label: m.mob_trash_toast_restore_failed(),
				placement: "bottom",
			});
		} finally {
			setActionInProgress(null);
		}
	};

	const handlePermanentDelete = (item: DeletedItem) => {
		Alert.alert(
			m.mob_trash_alert_delete_title(),
			m.mob_trash_alert_delete_message({ title: item.title }),
			[
				{ text: m.mob_trash_alert_cancel(), style: "cancel" },
				{
					text: m.mob_trash_alert_delete_confirm(),
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
								label: m.mob_trash_toast_deleted(),
								placement: "bottom",
							});
						} catch (error) {
							console.error("Failed to delete item:", error);
							toast.show({
								variant: "danger",
								label: m.mob_trash_toast_delete_failed(),
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

	const renderRightActions = (item: DeletedItem) => (
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

	const renderLeftActions = (item: DeletedItem) => (
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

	const renderItem = ({ item }: { item: DeletedItem }) => (
		<Swipeable
			renderRightActions={() => renderRightActions(item)}
			renderLeftActions={() => renderLeftActions(item)}
			overshootRight={false}
			overshootLeft={false}
		>
			<ItemListItem
				item={item}
				vault={item.vault}
				showVaultBadge
				onPress={() => {}}
				rightContent={
					<Text className="text-muted text-xs">
						{formatDeletedAt(item.deletedAt ?? "", m)}
					</Text>
				}
			/>
		</Swipeable>
	);

	if (isLoading) {
		return (
			<SafeAreaView className="flex-1 bg-background" edges={[]}>
				{/* Info banner skeleton */}
				<View className="px-4 py-3">
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
					<Card.Title className="mb-4 text-center text-danger text-lg">
						{m.mob_trash_error_loading()}
					</Card.Title>
					<Button onPress={handleRefresh} variant="primary">
						{m.mob_items_button_retry()}
					</Button>
				</Card>
			</SafeAreaView>
		);
	}

	return (
		<SafeAreaView className="flex-1 bg-background" edges={[]}>
			{/* Swipe hint */}
			<View className="flex-row items-center justify-center gap-8 bg-surface/50 py-3">
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
						{m.mob_trash_empty_title()}
					</Text>
					<Text className="mt-2 text-center text-muted">
						{m.mob_trash_empty_description()}
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
