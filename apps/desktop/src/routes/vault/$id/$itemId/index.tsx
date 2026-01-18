import * as tauriStorage from "@bittery/crypto/storage-tauri";
import { copyToClipboard } from "@bittery/shared/crypto";
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
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
	Copy as CopyIcon,
	Edit,
	MoreVertical,
	Share2,
	Star,
	Trash2,
} from "lucide-react";
import { useState } from "react";
import Loader from "../../../../components/loader";
import ItemDetail from "../../../../components/vault/item-detail";
import { ItemForm } from "../../../../components/vault/item-form";
import { VaultAvatar } from "../../../../components/vault/vault-avatar";
import { useVaultItemOperations } from "../../../../components/vault/use-vault-item-operations";
import { useDecryptedItem } from "../../../../hooks/use-decrypted-item";

export const Route = createFileRoute("/vault/$id/$itemId/")({
	component: VaultItemComponent,
});

function VaultItemComponent() {
	const { itemId, id: selectedVaultId } = Route.useParams();

	const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
	const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);

	// Use the new hooks
	const { rawItem, decryptedData, isLoading } = useDecryptedItem(itemId);
	const { updateItem, deleteItem, toggleFavorite, duplicateItem } =
		useVaultItemOperations();

	const { data: currentVault } = useQuery({
		queryKey: ["vault-keys", selectedVaultId],
		queryFn: async () => {
			const keys = await tauriStorage.getVaultKeys();
			if (!keys) return null;
			return keys.find((v) => v.vaultId === selectedVaultId);
		},
	});

	const handleShare = async () => {
		if (decryptedData?.title) {
			let shareText = `${decryptedData.title}`;
			if ("url" in decryptedData && decryptedData.url) {
				shareText += `\n${decryptedData.url}`;
			}
			await copyToClipboard(shareText, 0);
			toast.success("Item details copied to clipboard");
		}
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
							name={currentVault?.vaultName || "Vault"}
							icon={currentVault?.vaultIcon}
							imageUrl={currentVault?.vaultImageUrl}
							size="sm"
						/>
						<span>{currentVault?.vaultName || "Unknown Vault"}</span>
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
						category={
							rawItem?.category === "secure-note" ? "secure-note" :
							rawItem?.category === "credit-card" ? "credit-card" :
							rawItem?.category === "identity" ? "identity" : "login"
						}
						data={decryptedData}
					/>
				</div>
			</div>

			{/* Edit Item Dialog */}
			<Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
				<DialogContent className="max-w-2xl">
					<DialogHeader>
						<DialogTitle>Edit Item</DialogTitle>
						<DialogDescription>
							Update your{" "}
							{rawItem?.category === "secure-note"
								? "secure note"
								: rawItem?.category === "credit-card"
									? "credit card"
									: rawItem?.category === "identity"
										? "identity"
										: "login"}
						</DialogDescription>
					</DialogHeader>
					{decryptedData && (
						<ItemForm
							category={
								rawItem?.category === "secure-note"
									? "secure-note"
									: rawItem?.category === "credit-card"
										? "credit-card"
										: rawItem?.category === "identity"
											? "identity"
											: "login"
							}
							initialData={decryptedData}
							onSubmit={(data) => {
								if (!rawItem) return;
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
							selectedVaultId={selectedVaultId}
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
		</>
	);
}
