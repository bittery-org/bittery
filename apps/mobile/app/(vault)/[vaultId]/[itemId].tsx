import {
	useCreateShare,
	useDeleteItem,
	useUpdateItem,
	useVaultItems,
} from "@bittery/core/hooks";
import * as Clipboard from "expo-clipboard";
import { useLocalSearchParams, useRouter } from "expo-router";
import type { PopoverTriggerRef } from "heroui-native";
import { useToast } from "heroui-native";
import { useRef, useState } from "react";
import { ScrollView } from "react-native";
import {
	CategoryFields,
	CustomFields,
	ErrorState,
	ItemAttachments,
	ItemHeader,
	ItemMetadata,
	LoadingState,
	NotesSection,
	NotFoundState,
	TagsSection,
} from "@/components/item-details";
import { PasswordHistorySheet } from "@/components/password-history-sheet";
import { ShareItemSheet } from "@/components/share/share-item-sheet";
import { layout, Screen, useBottomInset } from "@/components/ui";
import { useI18n } from "@/providers/i18n-provider";

export default function ItemDetailScreen() {
	const { m } = useI18n();
	const router = useRouter();
	const bottomInset = useBottomInset();
	const { vaultId, itemId } = useLocalSearchParams<{
		vaultId: string;
		itemId: string;
	}>();

	const { items, isLoading, error } = useVaultItems(vaultId);
	const deleteItem = useDeleteItem();
	const createShare = useCreateShare();
	const updateItem = useUpdateItem();
	const { toast } = useToast();
	const popoverRef = useRef<PopoverTriggerRef>(null);
	const [shareSheetVisible, setShareSheetVisible] = useState(false);
	const [passwordHistoryVisible, setPasswordHistoryVisible] = useState(false);

	const item = items.find((i) => i.id === itemId);

	const handleCopy = async (value: string, label: string) => {
		await Clipboard.setStringAsync(value);
		toast.show({
			variant: "accent",
			label: m.mob_item_detail_toast_copied(),
			description: m.mob_item_detail_toast_copied_description({ label }),
			placement: "bottom",
		});
	};

	const handleDelete = async () => {
		try {
			await deleteItem.mutateAsync({ itemId, vaultId });
			toast.show({
				variant: "accent",
				label: m.mob_item_detail_toast_deleted(),
				placement: "bottom",
			});
			router.back();
		} catch (error) {
			toast.show({
				variant: "danger",
				label: m.mob_item_detail_toast_delete_failed(),
				description:
					error instanceof Error ? error.message : m.mob_detail_error_unknown(),
				placement: "bottom",
			});
		}
	};

	const handleEdit = () => {
		router.push(`/(vault)/${vaultId}/edit/${itemId}`);
	};

	const handleRestorePassword = async (password: string) => {
		try {
			await updateItem.mutateAsync({
				itemId,
				vaultId,
				data: { password },
			});
			toast.show({
				variant: "accent",
				label: m.mob_item_detail_toast_password_restored(),
				placement: "bottom",
			});
			setPasswordHistoryVisible(false);
		} catch (error) {
			toast.show({
				variant: "danger",
				label: m.mob_item_detail_toast_password_restore_failed(),
				description:
					error instanceof Error ? error.message : m.mob_detail_error_unknown(),
				placement: "bottom",
			});
		}
	};

	if (isLoading) {
		return <LoadingState />;
	}

	if (error) {
		return <ErrorState error={error} onBack={() => router.back()} />;
	}

	if (!item) {
		return <NotFoundState onBack={() => router.back()} />;
	}

	return (
		<Screen>
			<ItemHeader
				item={item}
				vaultId={vaultId}
				onBack={() => router.back()}
				onEdit={handleEdit}
				onDelete={handleDelete}
				onShare={() => setShareSheetVisible(true)}
				onPasswordHistory={() => setPasswordHistoryVisible(true)}
				isDeleting={deleteItem.isPending}
				isSharing={createShare.isPending}
				popoverRef={popoverRef}
			/>

			<ScrollView
				className="flex-1"
				contentContainerStyle={{
					paddingHorizontal: layout.screenPadding,
					paddingBottom: bottomInset,
					gap: layout.gap.lg,
				}}
			>
				<CategoryFields
					category={item.category}
					item={item}
					onCopy={handleCopy}
				/>

				<NotesSection
					notes={item.notes || item.note}
					showForSecureNote={item.category === "secure-note"}
					onCopy={handleCopy}
				/>

				<TagsSection tags={item.tags} />

				<CustomFields fields={item.customFields} onCopy={handleCopy} />

				<ItemAttachments itemId={itemId} vaultId={vaultId} canEdit />

				<ItemMetadata createdAt={item.createdAt} updatedAt={item.updatedAt} />
			</ScrollView>

			<ShareItemSheet
				item={item}
				visible={shareSheetVisible}
				onClose={() => setShareSheetVisible(false)}
			/>

			<PasswordHistorySheet
				visible={passwordHistoryVisible}
				onClose={() => setPasswordHistoryVisible(false)}
				passwordHistory={item.passwordHistory}
				currentPassword={item.password}
				onCopyPassword={(password) =>
					handleCopy(password, m.mob_detail_field_password())
				}
				onRestorePassword={handleRestorePassword}
				isRestoring={updateItem.isPending}
			/>
		</Screen>
	);
}
