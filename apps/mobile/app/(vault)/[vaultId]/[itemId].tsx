import { useCreateShare, useDeleteItem, useVaultItems } from "@bittery/hooks";
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
	ItemHeader,
	ItemMetadata,
	LoadingState,
	NotesSection,
	NotFoundState,
	TagsSection,
} from "@/components/item-details";
import { SafeAreaView } from "@/components/safe-area-view";
import { ShareItemSheet } from "@/components/share/share-item-sheet";

export default function ItemDetailScreen() {
	const router = useRouter();
	const { vaultId, itemId } = useLocalSearchParams<{
		vaultId: string;
		itemId: string;
	}>();

	const { items, isLoading, error } = useVaultItems(vaultId);
	const deleteItem = useDeleteItem();
	const createShare = useCreateShare();
	const { toast } = useToast();
	const popoverRef = useRef<PopoverTriggerRef>(null);
	const [shareSheetVisible, setShareSheetVisible] = useState(false);

	const item = items.find((i) => i.id === itemId);

	const handleCopy = async (value: string, label: string) => {
		await Clipboard.setStringAsync(value);
		toast.show({
			variant: "accent",
			label: "Copied to clipboard",
			description: `${label} has been copied to clipboard.`,
			placement: "bottom",
		});
	};

	const handleDelete = async () => {
		try {
			await deleteItem.mutateAsync({ itemId, vaultId });
			toast.show({
				variant: "accent",
				label: "Item moved to trash",
				description: "The item has been moved to trash.",
				placement: "bottom",
			});
			router.back();
		} catch (error) {
			toast.show({
				variant: "danger",
				label: "Failed to delete item",
				description: error instanceof Error ? error.message : "Unknown error",
				placement: "bottom",
			});
		}
	};

	const handleEdit = () => {
		router.push(`/(vault)/${vaultId}/edit/${itemId}`);
	};

	const handleShare = () => {
		setShareSheetVisible(true);
	};

	// Loading state
	if (isLoading) {
		return <LoadingState />;
	}

	// Error state
	if (error) {
		return <ErrorState error={error} onBack={() => router.back()} />;
	}

	// Not found state
	if (!item) {
		return <NotFoundState onBack={() => router.back()} />;
	}

	return (
		<SafeAreaView className="flex-1 bg-background">
			<ItemHeader
				item={item}
				vaultId={vaultId}
				onBack={() => router.back()}
				onEdit={handleEdit}
				onDelete={handleDelete}
				onShare={handleShare}
				isDeleting={deleteItem.isPending}
				isSharing={createShare.isPending}
				popoverRef={popoverRef}
			/>

			<ScrollView className="flex-1 px-4 pt-4">
				{/* Category-specific fields */}
				<CategoryFields
					category={item.category}
					item={item}
					onCopy={handleCopy}
				/>

				{/* Notes (for non-secure-note items) */}
				<NotesSection
					notes={item.notes || item.note}
					showForSecureNote={item.category === "secure-note"}
				/>

				{/* Tags */}
				<TagsSection tags={item.tags} />

				{/* Custom Fields */}
				<CustomFields fields={item.customFields} onCopy={handleCopy} />

				{/* Metadata */}
				<ItemMetadata createdAt={item.createdAt} updatedAt={item.updatedAt} />
			</ScrollView>

			{/* Share Sheet */}
			<ShareItemSheet
				item={item}
				visible={shareSheetVisible}
				onClose={() => setShareSheetVisible(false)}
			/>
		</SafeAreaView>
	);
}
