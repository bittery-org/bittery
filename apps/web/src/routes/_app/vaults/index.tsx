import {
	useAvailableTags,
	useAllVaultKeys,
	useCreateItem,
	useDeleteItem,
	useItems,
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
	cn,
	CreateItemSheet,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	ItemForm,
	Skeleton,
	toast,
	type VaultOption,
} from "@bittery/ui";
import {
	IconGrid2OutlineDuo18 as Grid,
	IconPlusOutlineDuo18 as Plus,
} from "@bittery/ui/icons";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { ItemDetailPane } from "@/components/vault/item-detail-pane";
import { ItemList } from "@/components/vault/item-list";
import { m as messages } from "@bittery/i18n/paraglide/messages";
import { useI18n } from "@/providers/i18n-provider";

export const Route = createFileRoute("/_app/vaults/")({
	validateSearch: (search) => ({
		itemId: typeof search.itemId === "string" ? search.itemId : undefined,
	}),
	component: AllItemsPage,
	head: () => ({
		meta: [{ title: messages.vaults_page_meta_title() }],
	}),
});

function AllItemsPage() {
	const navigate = useNavigate();
	const { m } = useI18n();
	const { itemId: selectedItemIdFromSearch } = Route.useSearch();

	const { items, isLoading } = useItems();
	const { vaultKeys } = useAllVaultKeys();
	const availableTags = useAvailableTags(items);
	const createItem = useCreateItem();
	const updateItem = useUpdateItem();
	const deleteItem = useDeleteItem();

	const [isCreateItemSheetOpen, setIsCreateItemSheetOpen] = useState(false);
	const [isEditItemDialogOpen, setIsEditItemDialogOpen] = useState(false);
	const [isDeleteItemDialogOpen, setIsDeleteItemDialogOpen] = useState(false);

	const selectedItemId =
		selectedItemIdFromSearch &&
		items.some((item) => item.id === selectedItemIdFromSearch)
			? selectedItemIdFromSearch
			: null;
	const selectedItem =
		selectedItemId === null
			? null
			: (items.find((item) => item.id === selectedItemId) ?? null);

	const canWriteItems = selectedItem
		? (() => {
				const vault = vaultKeys.find(
					(v) => v.vaultId === selectedItem.vaultId,
				);
				return vault ? vault.role !== "read-only" : false;
			})()
		: true;

	const handleItemSelect = (item: DecryptedItem) => {
		navigate({ to: "/vaults", search: { itemId: item.id } });
	};

	const handleCloseDetail = () => {
		navigate({ to: "/vaults", search: { itemId: undefined } });
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
		navigate({ to: "/vaults", search: { itemId: result.itemId } });
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
			navigate({ to: "/vaults", search: { itemId: undefined } });
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
			{/* Middle pane: item list */}
			<div
				className={cn(
					"flex w-full shrink-0 flex-col border-r md:w-80",
					selectedItemId && "hidden md:flex",
				)}
			>
				<div className="flex items-center gap-2 border-b px-4 py-3">
					<Grid className="size-4 text-muted-foreground" />
					<span className="font-medium">
						{m.vaults_sidebar_link_all_objects()}
					</span>
					<Badge variant="secondary" className="ml-auto">
						{items.length}
					</Badge>
					<Button
						variant="ghost"
						size="sm"
						className="h-7 w-7 p-0"
						onClick={() => setIsCreateItemSheetOpen(true)}
					>
						<Plus className="h-4 w-4" />
					</Button>
				</div>
				<div className="flex min-h-0 flex-1 flex-col overflow-hidden p-1">
					{isLoading ? (
						<div className="space-y-2 p-2">
							{[1, 2, 3, 4, 5].map((i) => (
								<Skeleton key={i} className="h-16" />
							))}
						</div>
					) : (
						<ItemList
							items={items}
							isLoading={false}
							vaultId=""
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

			{/* Edit Item Dialog */}
			<Dialog
				open={isEditItemDialogOpen && !!selectedItem}
				onOpenChange={setIsEditItemDialogOpen}
			>
				<DialogContent
					className="flex max-h-[85vh] max-w-2xl flex-col"
					data-testid="edit-item-dialog"
				>
					<DialogHeader className="shrink-0">
						<DialogTitle>
							{m.vaults_detail_edit_item_dialog_title()}
						</DialogTitle>
						<DialogDescription>
							{m.vaults_detail_edit_item_dialog_description()}
						</DialogDescription>
					</DialogHeader>
					{selectedItem && (
						<ItemForm
							category={selectedItem.category}
							initialData={selectedItem}
							onSubmit={async (data) => {
								await handleUpdateItem(data as DecryptedItemData);
							}}
							onCancel={() => setIsEditItemDialogOpen(false)}
							isSubmitting={updateItem.isPending}
							submitLabel={m.vaults_detail_edit_item_dialog_action_submit()}
							selectedVaultId={selectedItem.vaultId}
						/>
					)}
				</DialogContent>
			</Dialog>

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
