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
} from "@bittery/ui";
import {
	Copy as CopyIcon,
	Edit,
	History,
	MoreVertical,
	Share2,
	Star,
	Trash2,
} from "lucide-react";
import { useCallback, useState } from "react";
import { useDecryptedItem } from "@bittery/hooks";
import Loader from "../loader";
import ItemDetail from "./item-detail";
import { ItemForm } from "./item-form";
import { ShareHistoryDialog } from "./share-history-dialog";
import { ShareItemDialog } from "./share-item-dialog";
import { useVaultItemOperations } from "./use-vault-item-operations";
import { VaultAvatar } from "./vault-avatar";

interface VaultInfo {
	name: string;
	icon?: string | null;
	imageUrl?: string | null;
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
	const [isUpdatingTags, setIsUpdatingTags] = useState(false);

	const { rawItem, decryptedData, isLoading } = useDecryptedItem(itemId);
	const { updateItem, deleteItem, toggleFavorite, duplicateItem } =
		useVaultItemOperations();

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
					skipToast: true,
				},
				{
					onSettled: () => {
						setIsUpdatingTags(false);
					},
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

	const handleDuplicate = () => {
		if (!rawItem) return;
		duplicateItem.mutate({
			itemId: rawItem.id,
			vaultId: rawItem.vaultId,
		});
	};

	const confirmDelete = () => {
		if (!rawItem) return;
		deleteItem.mutate({
			itemId: rawItem.id,
			vaultId: rawItem.vaultId,
		});
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
				<div className="flex items-center justify-between border-b bg-background px-8 py-2">
					<div className="flex items-center gap-2 text-muted-foreground text-sm">
						<VaultAvatar
							name={vaultInfo?.name || "Vault"}
							icon={vaultInfo?.icon}
							imageUrl={vaultInfo?.imageUrl}
							size="sm"
						/>
						<span>{vaultInfo?.name || "Unknown Vault"}</span>
					</div>
					<div className="flex items-center gap-2">
						<Button variant="ghost" size="sm" onClick={handleShare}>
							<Share2 className="mr-2 size-4" />
							Share
						</Button>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setIsEditDialogOpen(true)}
						>
							<Edit className="mr-2 size-4" />
							Edit
						</Button>
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button variant="ghost" size="icon">
									<MoreVertical className="size-4" />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuItem
									onClick={handleDuplicate}
									disabled={duplicateItem.isPending}
								>
									<CopyIcon className="mr-2 size-4" />
									Duplicate
								</DropdownMenuItem>
								<DropdownMenuItem
									onClick={() => {
										if (!rawItem) return;
										toggleFavorite.mutate({
											itemId: rawItem.id,
											favorite: !rawItem.favorite,
											vaultId: rawItem.vaultId,
										});
									}}
									disabled={toggleFavorite.isPending}
								>
									<Star
										className="mr-2 size-4"
										fill={rawItem?.favorite ? "currentColor" : "none"}
									/>
									{rawItem?.favorite
										? "Remove from Favorites"
										: "Add to Favorites"}
								</DropdownMenuItem>
								<DropdownMenuItem onClick={() => setIsShareHistoryOpen(true)}>
									<History className="mr-2 size-4" />
									Share History
								</DropdownMenuItem>
								<DropdownMenuSeparator />
								<DropdownMenuItem
									onClick={handleDelete}
									className="text-destructive focus:text-destructive"
								>
									<Trash2 className="mr-2 size-4" />
									Delete
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				</div>

				{/* Content area */}
				<div className="flex-1 overflow-y-auto px-8 py-3">
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
							onSubmit={(data) => {
								updateItem.mutate(
									{
										itemId: rawItem.id,
										vaultId: rawItem.vaultId,
										data,
									},
									{
										onSuccess: () => {
											setIsEditDialogOpen(false);
										},
									},
								);
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
		</>
	);
}
