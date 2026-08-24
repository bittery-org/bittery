import {
	useAvailableTags,
	useDeleteItem,
	useUpdateItem,
} from "@bittery/core/hooks";
import type {
	DecryptedItem,
	DecryptedItemData,
	ItemCategory,
} from "@bittery/shared/types";
import {
	Badge,
	Button,
	CreateItemSheet,
	cn,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	EditItemSheet,
	getTagColorFromName,
	toast,
} from "@bittery/ui";
import { IconTag as TagIcon } from "@bittery/ui/icons";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { z } from "zod";
import { ItemDetailPane } from "@/components/vault/item-detail-pane";
import { ItemList } from "@/components/vault/item-list";
import { ItemListState } from "@/components/vault/item-list-state";
import { useAcceptLoginItem } from "@/hooks/use-accept-login-item";
import { useRuntimeItems } from "@/hooks/use-runtime-items";
import { canWriteVault, creatableVaults } from "@/lib/runtime-items";
import { useI18n } from "@/providers/i18n-provider";

export const Route = createFileRoute("/_app/vaults/tag/$tagName")({
	validateSearch: z.object({
		itemId: z.string().optional(),
	}),
	component: TagPage,
	head: ({ params }) => ({
		meta: [{ title: decodeURIComponent(params.tagName) }],
	}),
});

function TagPage() {
	const navigate = useNavigate();
	const { m } = useI18n();
	const { tagName: encodedTagName } = Route.useParams();
	const { itemId: selectedItemIdFromSearch } = Route.useSearch();

	const tagName = decodeURIComponent(encodedTagName);
	const tagColor = getTagColorFromName(tagName);

	const {
		items: allItems,
		accountId,
		vaults,
		state: itemsState,
	} = useRuntimeItems();

	const taggedItems = useMemo(
		() => allItems.filter((item) => item.tags?.includes(tagName)),
		[allItems, tagName],
	);

	const availableTags = useAvailableTags(taggedItems);
	const acceptLoginItem = useAcceptLoginItem();
	const updateItem = useUpdateItem();
	const deleteItem = useDeleteItem();

	const [isCreateItemSheetOpen, setIsCreateItemSheetOpen] = useState(false);
	const [isEditItemDialogOpen, setIsEditItemDialogOpen] = useState(false);
	const [isDeleteItemDialogOpen, setIsDeleteItemDialogOpen] = useState(false);

	const selectedItemId =
		selectedItemIdFromSearch &&
		taggedItems.some((item) => item.id === selectedItemIdFromSearch)
			? selectedItemIdFromSearch
			: null;
	const selectedItem =
		selectedItemId === null
			? null
			: (taggedItems.find((item) => item.id === selectedItemId) ?? null);

	const canWriteItems = selectedItem
		? canWriteVault(vaults, selectedItem.vaultId)
		: true;

	const handleItemSelect = (item: DecryptedItem) => {
		navigate({
			to: "/vaults/tag/$tagName",
			params: { tagName: encodedTagName },
			search: { itemId: item.id },
		});
	};

	const handleCloseDetail = () => {
		navigate({
			to: "/vaults/tag/$tagName",
			params: { tagName: encodedTagName },
			search: { itemId: undefined },
		});
	};

	const handleCreateItem = async (
		data: DecryptedItemData,
		vaultId: string,
		category: ItemCategory,
	) => {
		const result = await acceptLoginItem.accept({
			accountId,
			vaultId,
			category,
			data,
		});
		navigate({
			to: "/vaults/tag/$tagName",
			params: { tagName: encodedTagName },
			search: { itemId: result.itemId },
		});
		setIsCreateItemSheetOpen(false);
		toast.success(m.vaults_detail_toast_item_created());
	};

	const handleUpdateItem = async (data: DecryptedItemData) => {
		if (!selectedItem) return;
		await updateItem.mutateAsync({
			itemId: selectedItem.id,
			vaultId: selectedItem.vaultId,
			accountId: selectedItem.accountId,
			data,
		});
		setIsEditItemDialogOpen(false);
		toast.success(m.vaults_detail_toast_item_updated());
	};

	const handleDeleteItem = async () => {
		if (!selectedItem) return;
		try {
			await deleteItem.mutateAsync({
				itemId: selectedItem.id,
				vaultId: selectedItem.vaultId,
				accountId: selectedItem.accountId,
			});
			setIsDeleteItemDialogOpen(false);
			navigate({
				to: "/vaults/tag/$tagName",
				params: { tagName: encodedTagName },
				search: { itemId: undefined },
			});
			toast.success(m.vaults_detail_toast_item_moved_to_trash());
		} catch {
			toast.error(m.vaults_detail_toast_item_delete_error());
		}
	};

	const itemFormVaults = creatableVaults(vaults);

	return (
		<>
			{/* Middle pane: tagged items list */}
			<div
				className={cn(
					"flex w-full shrink-0 flex-col border-r md:w-78",
					selectedItemId && "hidden md:flex",
				)}
			>
				<div className="flex h-11 shrink-0 items-center gap-2 border-b px-2.5 xl:h-12">
					<TagIcon className="size-3.5 shrink-0" style={{ color: tagColor }} />
					<span className="truncate font-medium text-sm">{tagName}</span>
					<Badge variant="secondary" className="ml-auto shrink-0">
						{taggedItems.length}
					</Badge>
				</div>
				<div className="flex min-h-0 flex-1 flex-col overflow-hidden py-1">
					{itemsState !== "ready" ? (
						<ItemListState state={itemsState} />
					) : taggedItems.length === 0 ? (
						<div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
							<h3 className="mb-2 font-semibold">
								{m.vaults_tag_empty_title()}
							</h3>
							<p className="text-muted-foreground text-sm">
								{m.vaults_tag_empty_description({ tagName })}
							</p>
						</div>
					) : (
						<ItemList
							items={taggedItems}
							isLoading={false}
							onItemSelect={handleItemSelect}
							selectedItemId={selectedItemId ?? undefined}
						/>
					)}
				</div>
			</div>

			{/* Right pane: item detail */}
			<ItemDetailPane
				selectedItem={selectedItem}
				selectedItemId={selectedItemId}
				availableTags={availableTags}
				canWriteItems={canWriteItems}
				onClose={handleCloseDetail}
				onEdit={() => setIsEditItemDialogOpen(true)}
				onDelete={() => setIsDeleteItemDialogOpen(true)}
			/>

			{/* Create Item Sheet */}
			<CreateItemSheet
				open={isCreateItemSheetOpen}
				onOpenChange={setIsCreateItemSheetOpen}
				vaults={itemFormVaults}
				selectedVaultId={itemFormVaults[0]?.id}
				onCreateItem={handleCreateItem}
			/>

			{/* Edit Item Sheet */}
			<EditItemSheet
				open={isEditItemDialogOpen && !!selectedItem}
				onOpenChange={setIsEditItemDialogOpen}
				item={selectedItem}
				onUpdateItem={handleUpdateItem}
				isSubmitting={updateItem.isPending}
				dataTestId="edit-item-dialog"
			/>

			{/* Delete Item Dialog */}
			<Dialog
				open={isDeleteItemDialogOpen && !!selectedItem}
				onOpenChange={setIsDeleteItemDialogOpen}
			>
				<DialogContent data-testid="delete-item-dialog">
					<DialogHeader>
						<DialogTitle>
							{m.vaults_detail_delete_item_dialog_title()}
						</DialogTitle>
						<DialogDescription>
							{m.vaults_detail_delete_item_dialog_description()}
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => setIsDeleteItemDialogOpen(false)}
							disabled={deleteItem.isPending}
						>
							{m.vaults_detail_delete_item_dialog_action_cancel()}
						</Button>
						<Button
							variant="destructive"
							onClick={handleDeleteItem}
							disabled={deleteItem.isPending}
						>
							{m.vaults_detail_delete_item_dialog_action_confirm()}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
