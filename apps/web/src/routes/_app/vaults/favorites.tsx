import {
	useAllVaultKeys,
	useAvailableTags,
	useCreateItem,
	useDeleteItem,
	useItems,
	useUpdateItem,
} from "@bittery/core/hooks";
import { m as messages } from "@bittery/i18n/paraglide/messages";
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
	Skeleton,
	toast,
	type VaultOption,
} from "@bittery/ui";
import { IconStarOutlineDuo18 as Star } from "@bittery/ui/icons";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { z } from "zod";
import { ItemDetailPane } from "@/components/vault/item-detail-pane";
import { ItemList } from "@/components/vault/item-list";
import { useI18n } from "@/providers/i18n-provider";

export const Route = createFileRoute("/_app/vaults/favorites")({
	validateSearch: z.object({
		itemId: z.string().optional(),
	}),
	component: FavoritesPage,
	head: () => ({
		meta: [{ title: messages.vaults_favorites_title() }],
	}),
});

function FavoritesPage() {
	const navigate = useNavigate();
	const { m } = useI18n();
	const { itemId: selectedItemIdFromSearch } = Route.useSearch();

	const { items: allItems, isLoading } = useItems();
	const { vaultKeys } = useAllVaultKeys();
	const favoriteItems = useMemo(
		() => allItems.filter((item) => item.favorite),
		[allItems],
	);
	const availableTags = useAvailableTags(favoriteItems);
	const createItem = useCreateItem();
	const updateItem = useUpdateItem();
	const deleteItem = useDeleteItem();

	const [isCreateItemSheetOpen, setIsCreateItemSheetOpen] = useState(false);
	const [isEditItemDialogOpen, setIsEditItemDialogOpen] = useState(false);
	const [isDeleteItemDialogOpen, setIsDeleteItemDialogOpen] = useState(false);

	const selectedItemId =
		selectedItemIdFromSearch &&
		favoriteItems.some((item) => item.id === selectedItemIdFromSearch)
			? selectedItemIdFromSearch
			: null;
	const selectedItem =
		selectedItemId === null
			? null
			: (favoriteItems.find((item) => item.id === selectedItemId) ?? null);

	const canWriteItems = selectedItem
		? (() => {
				const vault = vaultKeys.find((v) => v.vaultId === selectedItem.vaultId);
				return vault ? vault.role !== "read-only" : false;
			})()
		: true;

	const handleItemSelect = (item: DecryptedItem) => {
		navigate({ to: "/vaults/favorites", search: { itemId: item.id } });
	};

	const handleCloseDetail = () => {
		navigate({ to: "/vaults/favorites", search: { itemId: undefined } });
	};

	const handleCreateItem = async (
		data: DecryptedItemData,
		vaultId: string,
		category: ItemCategory,
	) => {
		const result = await createItem.mutateAsync({
			vaultId,
			category,
			data,
		});
		navigate({ to: "/vaults/favorites", search: { itemId: result.itemId } });
		setIsCreateItemSheetOpen(false);
		toast.success(m.vaults_detail_toast_item_created());
	};

	const handleUpdateItem = async (data: DecryptedItemData) => {
		if (!selectedItem) return;
		await updateItem.mutateAsync({
			itemId: selectedItem.id,
			vaultId: selectedItem.vaultId,
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
			});
			setIsDeleteItemDialogOpen(false);
			navigate({ to: "/vaults/favorites", search: { itemId: undefined } });
			toast.success(m.vaults_detail_toast_item_moved_to_trash());
		} catch {
			toast.error(m.vaults_detail_toast_item_delete_error());
		}
	};

	const itemFormVaults: VaultOption[] = vaultKeys.map((v) => ({
		id: v.vaultId,
		name: v.vaultName,
		type: v.vaultType,
		icon: v.vaultIcon,
		imageUrl: v.vaultImageUrl,
	}));

	return (
		<>
			{/* Middle pane: favorites list */}
			<div
				className={cn(
					"flex w-full shrink-0 flex-col border-r md:w-80",
					selectedItemId && "hidden md:flex",
				)}
			>
				<div className="flex items-center gap-2 border-b px-4 py-3">
					<Star className="size-4 text-yellow-500" fill="currentColor" />
					<span className="font-medium">{m.vaults_favorites_title()}</span>
					<Badge variant="secondary" className="ml-auto">
						{favoriteItems.length}
					</Badge>
				</div>
				<div className="flex min-h-0 flex-1 flex-col overflow-hidden py-1">
					{isLoading ? (
						<div className="space-y-2 p-2">
							{[1, 2, 3, 4, 5].map((i) => (
								<Skeleton key={i} className="h-16" />
							))}
						</div>
					) : favoriteItems.length === 0 ? (
						<div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
							<h3 className="mb-2 font-semibold">
								{m.vaults_favorites_empty_title()}
							</h3>
							<p className="text-muted-foreground text-sm">
								{m.vaults_favorites_empty_description()}
							</p>
						</div>
					) : (
						<ItemList
							items={favoriteItems}
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
				selectedVaultId={vaultKeys[0]?.vaultId}
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
