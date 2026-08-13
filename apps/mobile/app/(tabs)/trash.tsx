import {
	type DeletedItem,
	useDeletedItems,
	usePermanentDeleteItem,
	useRestoreItem,
} from "@bittery/core/hooks";
import { useThemeColor, useToast } from "heroui-native";
import { useMemo, useState } from "react";
import {
	ActivityIndicator,
	Alert,
	FlatList,
	Pressable,
	RefreshControl,
	Text,
	View,
} from "react-native";
import Swipeable from "react-native-gesture-handler/ReanimatedSwipeable";
import { ItemListItem } from "@/components/item-list-item";
import { ItemsSkeletonList } from "@/components/items-skeleton-list";
import {
	AppBar,
	EmptyState,
	ErrorState,
	IconAlertCircle,
	IconArchiveRestore,
	IconTrash,
	iconSize,
	layout,
	Screen,
	useBottomInset,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import { useI18n } from "@/providers/i18n-provider";

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
	const [success, danger] = useThemeColor(["success", "danger"]);
	const [refreshing, setRefreshing] = useState(false);
	const [actionInProgress, setActionInProgress] = useState<string | null>(null);
	const bottomInset = useBottomInset({ tabBar: true });

	const { items, isLoading, error, refetch } = useDeletedItems();
	const restoreItem = useRestoreItem();
	const permanentDeleteItem = usePermanentDeleteItem();

	const sortedItems = useMemo(
		() =>
			[...items].sort((a, b) => {
				const dateA = a.deletedAt ? new Date(a.deletedAt).getTime() : 0;
				const dateB = b.deletedAt ? new Date(b.deletedAt).getTime() : 0;
				return dateB - dateA;
			}),
		[items],
	);

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
			const accountId = item.accountId ?? item.account?.accountId;
			if (!accountId) throw new Error("Item account is unavailable");
			await restoreItem.mutateAsync({
				itemId: item.id,
				vaultId: item.vaultId,
				accountId,
			});
			await refetch();
			toast.show({
				variant: "success",
				label: m.mob_trash_toast_restored(),
				placement: "bottom",
			});
		} catch (restoreError) {
			console.error("Failed to restore item:", restoreError);
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
							const accountId = item.accountId ?? item.account?.accountId;
							if (!accountId) throw new Error("Item account is unavailable");
							await permanentDeleteItem.mutateAsync({
								itemId: item.id,
								vaultId: item.vaultId,
								accountId,
							});
							await refetch();
							toast.show({
								variant: "success",
								label: m.mob_trash_toast_deleted(),
								placement: "bottom",
							});
						} catch (deleteError) {
							console.error("Failed to delete item:", deleteError);
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

	const renderAction = (
		item: DeletedItem,
		tone: "restore" | "delete",
		onPress: () => void,
	) => {
		const isRestore = tone === "restore";
		const Icon = isRestore ? IconArchiveRestore : IconTrash;
		const label = isRestore
			? m.mob_trash_action_restore()
			: m.mob_trash_action_delete_forever();

		return (
			<Pressable
				onPress={onPress}
				disabled={actionInProgress === item.id}
				accessibilityRole="button"
				accessibilityLabel={label}
				className={cn(
					"w-24 items-center justify-center gap-1",
					isRestore ? "bg-success-soft" : "bg-danger-soft",
				)}
			>
				{actionInProgress === item.id ? (
					<ActivityIndicator
						size="small"
						color={isRestore ? success : danger}
					/>
				) : (
					<>
						<Icon
							size={iconSize.bar}
							className={isRestore ? "text-success" : "text-danger"}
						/>
						<Text
							numberOfLines={1}
							className={cn(
								"font-medium text-2xs",
								isRestore ? "text-success" : "text-danger",
							)}
						>
							{label}
						</Text>
					</>
				)}
			</Pressable>
		);
	};

	const renderItem = ({
		item,
		index,
	}: {
		item: DeletedItem;
		index: number;
	}) => {
		const isFirst = index === 0;
		const isLast = index === sortedItems.length - 1;

		return (
			<View className="px-4">
				<View
					className={cn(
						"overflow-hidden border-border border-x bg-surface",
						isFirst ? "rounded-t-2xl border-t" : "",
						isLast ? "rounded-b-2xl border-b" : "",
					)}
				>
					{isFirst ? null : <View className="ml-14 h-px bg-border" />}
					<Swipeable
						renderLeftActions={() =>
							renderAction(item, "restore", () => handleRestore(item))
						}
						renderRightActions={() =>
							renderAction(item, "delete", () => handlePermanentDelete(item))
						}
						overshootLeft={false}
						overshootRight={false}
					>
						<ItemListItem
							item={item}
							vault={item.vault}
							showVaultBadge
							variant="plain"
							// Trashed items have no detail route; restore/delete live in the swipe actions.
							onPress={() => {}}
							rightContent={
								<Text className="text-2xs text-muted">
									{formatDeletedAt(item.deletedAt ?? "", m)}
								</Text>
							}
						/>
					</Swipeable>
				</View>
			</View>
		);
	};

	return (
		<Screen>
			<AppBar showBack title={m.mob_tab_trash()} />

			{isLoading ? (
				<ItemsSkeletonList />
			) : error ? (
				<ErrorState
					icon={IconAlertCircle}
					title={m.mob_trash_error_loading()}
					actionLabel={m.mob_items_button_retry()}
					onAction={handleRefresh}
				/>
			) : (
				<FlatList
					data={sortedItems}
					renderItem={renderItem}
					keyExtractor={(item) => item.id}
					refreshControl={
						<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
					}
					contentContainerStyle={{
						paddingTop: layout.gap.md,
						paddingBottom: bottomInset,
						flexGrow: 1,
					}}
					ListHeaderComponent={
						sortedItems.length === 0 ? null : (
							<Text className="px-5 pb-3 text-muted text-xs">
								{m.mob_trash_swipe_hint()}
							</Text>
						)
					}
					ListEmptyComponent={
						<EmptyState
							icon={IconTrash}
							title={m.mob_trash_empty_title()}
							description={m.mob_trash_empty_description()}
						/>
					}
				/>
			)}
		</Screen>
	);
}
