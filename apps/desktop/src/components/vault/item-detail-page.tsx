import {
	useCreateItem,
	useDeleteItem,
	useItem,
	useToggleFavorite,
	useUpdateItem,
} from "@bittery/core/hooks";
import type { DecryptedItem, DecryptedItemData } from "@bittery/shared/types";
import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
	toast,
} from "@bittery/ui";
import {
	IconArrowsLeftRightTrailOutlineDuo18,
	IconCopyOutlineDuo18,
	IconDotsOutlineDuo18,
	IconHistoryOutlineDuo18,
	IconPen2OutlineDuo18,
	IconShareLeft2OutlineDuo18,
	IconStarOutlineDuo18,
	IconTrash2OutlineDuo18,
} from "@bittery/ui/icons";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import Loader from "../loader";
import { VaultInfoPopover } from "./item-categories/shared/vault-info-popover";
import ItemDetail from "./item-detail";
import { ItemForm } from "./item-form";
import { MoveItemDialog } from "./move-item-dialog";
import { ShareHistoryDialog } from "./share-history-dialog";
import { ShareItemDialog } from "./share-item-dialog";

interface VaultInfo {
	name: string;
	type?: "personal" | "team";
	icon?: string | null;
	imageUrl?: string | null;
	accountName?: string;
	accountTeamName?: string;
	accountTeamAvatarUrl?: string | null;
}

interface ItemDetailPageProps {
	itemId: string;
	vaultInfo?: VaultInfo;
	availableTags: string[];
	onTagClick: (tagName: string) => void;
}

export function ItemDetailPage({
	itemId,
	vaultInfo,
	availableTags,
	onTagClick,
}: ItemDetailPageProps) {
	const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
	const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
	const [isShareDialogOpen, setIsShareDialogOpen] = useState(false);
	const [isShareHistoryOpen, setIsShareHistoryOpen] = useState(false);
	const [isMoveDialogOpen, setIsMoveDialogOpen] = useState(false);
	const [isUpdatingTags, setIsUpdatingTags] = useState(false);

	const navigate = useNavigate();
	// Unified hook - automatically handles account detection
	const { rawItem, decryptedData, isLoading } = useItem(itemId);

	// Shared hooks for item operations
	const updateItem = useUpdateItem();
	const deleteItem = useDeleteItem();
	const toggleFavorite = useToggleFavorite();
	const createItem = useCreateItem();

	const handleTagsChange = useCallback(
		(newTags: string[]) => {
			if (!rawItem || !decryptedData) return;

			setIsUpdatingTags(true);

			const updatedData: DecryptedItemData = {
				...decryptedData,
				tags: newTags.length > 0 ? newTags : undefined,
			};

			updateItem.mutate(
				{
					itemId: rawItem.id,
					vaultId: rawItem.vaultId,
					data: updatedData,
				},
				{
					onSettled: () => {
						setIsUpdatingTags(false);
					},
					// Don't show toast for tag updates (silent update)
				},
			);
		},
		[rawItem, decryptedData, updateItem],
	);

	const handleShare = () => {
		setIsShareDialogOpen(true);
	};

	const handleDelete = () => {
		setIsDeleteDialogOpen(true);
	};

	const handleDuplicate = async () => {
		if (!rawItem || !decryptedData) return;

		try {
			// Create a duplicate with "Copy of" prefix
			const duplicatedData: DecryptedItemData = {
				...decryptedData,
				title: `Copy of ${decryptedData.title || "Item"}`,
			};

			const result = await createItem.mutateAsync({
				vaultId: rawItem.vaultId,
				category: rawItem.category,
				data: duplicatedData,
			});

			toast.success("Item duplicated successfully");

			// Navigate to the duplicated item
			navigate({
				to: "/vault/$id/$itemId",
				params: { id: rawItem.vaultId, itemId: result.itemId },
			});
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : "Failed to duplicate item";
			toast.error(errorMessage);
		}
	};

	const confirmDelete = async () => {
		if (!rawItem) return;
		console.log(rawItem);

		try {
			await deleteItem.mutateAsync({
				itemId: rawItem.id,
				vaultId: rawItem.vaultId,
			});

			toast.success("Item moved to trash");

			// Navigate back to vault
			navigate({ to: "/vault/$id", params: { id: rawItem.vaultId } });
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : "Failed to delete item";
			toast.error(errorMessage);
		}
	};

	const getCategoryDisplayName = (category: string) => {
		switch (category) {
			case "secure-note":
				return "secure note";
			case "credit-card":
				return "credit card";
			case "identity":
				return "identity";
			case "totp":
				return "authenticator";
			default:
				return "login";
		}
	};

	if (isLoading || !decryptedData) {
		return <Loader />;
	}

	return (
		<>
			<div className="flex flex-1 flex-col">
				{/* Top bar */}
				<div className="mb-3 flex items-center justify-between px-4 py-2">
					<div className="-ml-2">
						<VaultInfoPopover
							vaultName={vaultInfo?.name || "Unknown Vault"}
							vaultIcon={vaultInfo?.icon}
							vaultImageUrl={vaultInfo?.imageUrl}
							vaultType={vaultInfo?.type}
							accountName={vaultInfo?.accountName}
							accountTeamName={vaultInfo?.accountTeamName}
							accountTeamAvatarUrl={vaultInfo?.accountTeamAvatarUrl}
						/>
					</div>
					<div className="flex items-center gap-2">
						<Button variant="ghost" size="sm" onClick={handleShare}>
							<IconShareLeft2OutlineDuo18 />
							Share
						</Button>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setIsEditDialogOpen(true)}
						>
							<IconPen2OutlineDuo18 />
							Edit
						</Button>
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button variant="ghost" size="icon">
									<IconDotsOutlineDuo18 className="size-4" />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuItem
									onClick={handleDuplicate}
									disabled={createItem.isPending}
								>
									<IconCopyOutlineDuo18 className="size-4" />
									Duplicate
								</DropdownMenuItem>
								<DropdownMenuItem onClick={() => setIsMoveDialogOpen(true)}>
									<IconArrowsLeftRightTrailOutlineDuo18 className="size-4" />
									Move to Vault
								</DropdownMenuItem>
								<DropdownMenuItem
									onClick={async () => {
										if (!rawItem) return;
										try {
											await toggleFavorite.mutateAsync({
												itemId: rawItem.id,
												vaultId: rawItem.vaultId,
												favorite: !rawItem.favorite,
											});
											toast.success(
												!rawItem.favorite
													? "Added to favorites"
													: "Removed from favorites",
											);
										} catch (error) {
											const errorMessage =
												error instanceof Error
													? error.message
													: "Failed to update favorite";
											toast.error(errorMessage);
										}
									}}
									disabled={toggleFavorite.isPending}
								>
									<IconStarOutlineDuo18
										className="size-4"
										fill={rawItem?.favorite ? "currentColor" : "none"}
									/>
									{rawItem?.favorite
										? "Remove from Favorites"
										: "Add to Favorites"}
								</DropdownMenuItem>
								<DropdownMenuItem onClick={() => setIsShareHistoryOpen(true)}>
									<IconHistoryOutlineDuo18 className="size-4" />
									Share History
								</DropdownMenuItem>
								<DropdownMenuSeparator />
								<DropdownMenuItem
									onClick={handleDelete}
									className="text-destructive focus:text-destructive"
								>
									<IconTrash2OutlineDuo18 className="size-4" />
									Delete
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				</div>

				{/* Content area */}
				<div className="flex-1 overflow-y-auto px-4 py-3">
					<ItemDetail
						category={rawItem?.category ?? "login"}
						data={decryptedData}
						onTagsChange={handleTagsChange}
						onTagClick={onTagClick}
						availableTags={availableTags}
						isUpdatingTags={isUpdatingTags}
					/>
				</div>
			</div>

			{/* Edit Item Dialog */}
			<Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
				<DialogContent className="flex max-h-[85vh] max-w-2xl flex-col">
					<DialogHeader className="shrink-0">
						<DialogTitle>Edit Item</DialogTitle>
						<DialogDescription>
							Update your {getCategoryDisplayName(rawItem?.category ?? "login")}
						</DialogDescription>
					</DialogHeader>
					{decryptedData && rawItem && (
						<ItemForm
							category={rawItem.category}
							initialData={decryptedData}
							onSubmit={async (data) => {
								try {
									await updateItem.mutateAsync({
										itemId: rawItem.id,
										vaultId: rawItem.vaultId,
										data,
									});
									toast.success("Item updated successfully");
									setIsEditDialogOpen(false);
								} catch (error) {
									const errorMessage =
										error instanceof Error
											? error.message
											: "Failed to update item";
									toast.error(errorMessage);
								}
							}}
							onCancel={() => setIsEditDialogOpen(false)}
							isSubmitting={updateItem.isPending}
							submitLabel="Update"
							selectedVaultId={rawItem.vaultId}
						/>
					)}
				</DialogContent>
			</Dialog>

			{/* Delete Confirmation Dialog */}
			<Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Move to Trash?</DialogTitle>
						<DialogDescription>
							This item will be moved to trash. You can restore it later or
							delete it permanently from the trash.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => setIsDeleteDialogOpen(false)}
						>
							Cancel
						</Button>
						<Button
							variant="destructive"
							onClick={confirmDelete}
							disabled={deleteItem.isPending}
						>
							Move to Trash
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* Share Item Dialog */}
			{rawItem && decryptedData && (
				<ShareItemDialog
					open={isShareDialogOpen}
					onOpenChange={setIsShareDialogOpen}
					item={
						{
							id: rawItem.id,
							vaultId: rawItem.vaultId,
							category: rawItem.category,
							favorite: rawItem.favorite,
							createdAt: rawItem.createdAt,
							updatedAt: rawItem.updatedAt,
							...decryptedData,
						} as DecryptedItem
					}
				/>
			)}

			{/* Share History Dialog */}
			{rawItem && (
				<ShareHistoryDialog
					itemId={rawItem.id}
					open={isShareHistoryOpen}
					onOpenChange={setIsShareHistoryOpen}
				/>
			)}

			{/* Move Item Dialog */}
			{rawItem && decryptedData && (
				<MoveItemDialog
					open={isMoveDialogOpen}
					onOpenChange={setIsMoveDialogOpen}
					item={
						{
							id: rawItem.id,
							vaultId: rawItem.vaultId,
							category: rawItem.category,
							favorite: rawItem.favorite,
							createdAt: rawItem.createdAt,
							updatedAt: rawItem.updatedAt,
							...decryptedData,
						} as DecryptedItem
					}
					currentVaultId={rawItem.vaultId}
				/>
			)}
		</>
	);
}
