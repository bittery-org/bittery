import { useDeleteItem, useVaultItems } from "@bittery/hooks";
import * as Clipboard from "expo-clipboard";
import { useLocalSearchParams, useRouter } from "expo-router";
import type { PopoverTriggerRef } from "heroui-native";
import { useToast } from "heroui-native";
import { useRef } from "react";
import { ScrollView } from "react-native";
import {
  CategoryFields,
  CustomFields,
  ErrorState,
  ItemHeader,
  ItemMetadata,
  LoadingState,
  NotFoundState,
  NotesSection,
  TagsSection,
} from "@/components/item-details";
import { SafeAreaView } from "@/components/safe-area-view";

export default function ItemDetailScreen() {
  const router = useRouter();
  const { vaultId, itemId } = useLocalSearchParams<{
    vaultId: string;
    itemId: string;
  }>();

  const { items, isLoading, error } = useVaultItems(vaultId);
  const deleteItem = useDeleteItem();
  const { toast } = useToast();
  const popoverRef = useRef<PopoverTriggerRef>(null);

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
        isDeleting={deleteItem.isPending}
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
    </SafeAreaView>
  );
}
