import * as tauriStorage from "@bittery/crypto/storage-tauri";
import { detectCardBrand, maskCardNumber } from "@bittery/shared/credit-card";
import { copyToClipboard, decrypt, encrypt } from "@bittery/shared/crypto";
import { useTRPC, useTRPCClient } from "@bittery/shared/trpc";
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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
	Copy as CopyIcon,
	Edit,
	MoreVertical,
	Share2,
	Star,
	Trash2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import Loader from "../../../../components/loader";
import ItemDetail from "../../../../components/vault/item-detail";
import { ItemForm } from "../../../../components/vault/item-form";
import { VaultAvatar } from "../../../../components/vault/vault-avatar";

export const Route = createFileRoute("/vault/$id/$itemId/")({
	component: VaultItemComponent,
});

export interface CustomField {
	id: string;
	label: string;
	value: string;
	type: "text" | "password" | "email" | "url";
}

interface DecryptedItemData {
	title: string;
	url?: string;
	urls?: string[]; // Multiple URLs
	username?: string;
	password?: string;
	notes?: string;
	note?: string;
	customFields?: CustomField[];
	// Credit card fields
	cardholderName?: string;
	cardNumber?: string;
	cvv?: string;
	expiryDate?: string;
	billingAddress?: string;
}

function VaultItemComponent() {
	const trpc = useTRPC();
	const trpcClient = useTRPCClient();
	const queryClient = useQueryClient();
	const navigate = useNavigate();

	const { itemId } = Route.useParams();

	const [isNewItemDialogOpen, setIsNewItemDialogOpen] = useState(false);
	const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
	const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
	const [decryptedItemData, setDecryptedItemData] =
		useState<DecryptedItemData | null>(null);
	const selectedVaultId = Route.useParams().id;
	const [newItemCategory, _setNewItemCategory] = useState<
		"login" | "secure-note" | "credit-card"
	>("login");

	const { data: currentVault } = useQuery({
		queryKey: ["vault-keys", selectedVaultId],
		queryFn: async () => {
			const keys = await tauriStorage.getVaultKeys();
			if (!keys) return null;
			return keys.find((v) => v.vaultId === selectedVaultId);
		},
	});

	// Fetch items for the selected vault
	const { data: rawItem } = useQuery({
		...trpc.vault.getItem.queryOptions({
			itemId: itemId || "",
		}),
	});

	// Create item mutation
	const createItemMutation = useMutation({
		mutationFn: async (input: {
			category: "login" | "secure-note" | "credit-card";
			data: DecryptedItemData;
		}) => {
			if (!selectedVaultId) throw new Error("No vault selected");

			// Get vault key for encryption
			const vaultKey = await tauriStorage.getDecryptedVaultKey(selectedVaultId);

			if (!vaultKey) throw new Error("No vault key found");

			// Encrypt the item data
			const encryptedData = await encrypt(JSON.stringify(input.data), vaultKey);

			// Create overview based on category
			const overview: {
				title: string;
				url?: string;
				username?: string;
				cardBrand?: string;
				maskedCardNumber?: string;
			} = {
				title: input.data.title || "Untitled",
			};

			if (input.category === "login") {
				if (input.data.url) overview.url = input.data.url;
				if (input.data.username) overview.username = input.data.username;
			} else if (input.category === "credit-card") {
				if (input.data.cardNumber) {
					overview.cardBrand = detectCardBrand(input.data.cardNumber);
					overview.maskedCardNumber = maskCardNumber(input.data.cardNumber);
				}
			}

			return await trpcClient.vault.createItem.mutate({
				vaultId: selectedVaultId,
				category: input.category,
				overview,
				encryptedData: encryptedData.ciphertext,
				encryptionIv: encryptedData.iv,
				encryptionAlgorithm: encryptedData.algorithm,
			});
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: [["vault", "listItems"]] });
			setIsNewItemDialogOpen(false);
			toast.success("Item created successfully");
		},
		onError: (error) => {
			toast.error(`Failed to create item: ${error.message}`);
		},
	});

	// Update item mutation
	const updateItemMutation = useMutation({
		mutationFn: async (input: { data: DecryptedItemData }) => {
			if (!itemId) throw new Error("No item selected");
			if (!rawItem) throw new Error("No item data");

			// Get vault key for encryption
			const vaultKey = await tauriStorage.getDecryptedVaultKey(rawItem.vaultId);

			if (!vaultKey) throw new Error("No vault key found");

			// Encrypt the item data
			const encryptedData = await encrypt(JSON.stringify(input.data), vaultKey);

			// Create overview based on category
			const overview: {
				title: string;
				url?: string;
				username?: string;
				cardBrand?: string;
				maskedCardNumber?: string;
			} = {
				title: input.data.title || "Untitled",
			};

			if (rawItem.category === "login") {
				if (input.data.url) overview.url = input.data.url;
				if (input.data.username) overview.username = input.data.username;
			} else if (rawItem.category === "credit-card") {
				if (input.data.cardNumber) {
					overview.cardBrand = detectCardBrand(input.data.cardNumber);
					overview.maskedCardNumber = maskCardNumber(input.data.cardNumber);
				}
			}

			return await trpcClient.vault.updateItem.mutate({
				itemId,
				overview,
				encryptedData: encryptedData.ciphertext,
				encryptionIv: encryptedData.iv,
			});
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: [["vault", "getItem"]] });
			setIsEditDialogOpen(false);
			toast.success("Item updated successfully");
			// Refresh the item data
			getDecryptedItem();
		},
		onError: (error) => {
			toast.error(`Failed to update item: ${error.message}`);
		},
	});

	// Delete item mutation (soft delete)
	const deleteItemMutation = useMutation({
		mutationFn: async () => {
			if (!itemId) throw new Error("No item selected");
			return await trpcClient.vault.deleteItem.mutate({ itemId });
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: [["vault", "listItems"]] });
			setIsDeleteDialogOpen(false);
			toast.success("Item moved to trash");
			// Navigate back to vault
			navigate({ to: "/vault/$id", params: { id: selectedVaultId } });
		},
		onError: (error) => {
			toast.error(`Failed to delete item: ${error.message}`);
		},
	});

	// Toggle favorite mutation
	const toggleFavoriteMutation = useMutation({
		mutationFn: async (favorite: boolean) => {
			if (!itemId) throw new Error("No item selected");
			return await trpcClient.vault.toggleFavorite.mutate({ itemId, favorite });
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: [["vault", "listItems"]] });
			queryClient.invalidateQueries({ queryKey: [["vault", "getItem"]] });
			toast.success(
				rawItem?.favorite ? "Removed from favorites" : "Added to favorites",
			);
		},
		onError: (error) => {
			toast.error(`Failed to update favorite: ${error.message}`);
		},
	});

	const getDecryptedItem = useCallback(async () => {
		if (!rawItem) return;

		// Decrypt item data
		try {
			const vaultKey = await tauriStorage.getDecryptedVaultKey(rawItem.vaultId);

			if (!vaultKey) {
				toast.error("No vault key found for decryption");
				return;
			}

			const encryptedData = {
				ciphertext: rawItem.encryptedData,
				iv: rawItem.encryptionIv,
				algorithm: rawItem.encryptionAlgorithm,
			};

			const decryptedJson = await decrypt(encryptedData, vaultKey);
			setDecryptedItemData(JSON.parse(decryptedJson));
		} catch (error) {
			console.error("Failed to decrypt item:", error);
		}
	}, [rawItem]);

	useEffect(() => {
		getDecryptedItem();
	}, [getDecryptedItem]);

	const handleShare = async () => {
		if (decryptedItemData?.title) {
			let shareText = `${decryptedItemData.title}`;
			if ("url" in decryptedItemData && decryptedItemData.url) {
				shareText += `\n${decryptedItemData.url}`;
			}
			await copyToClipboard(shareText, 0);
			toast.success("Item details copied to clipboard");
		}
	};

	const handleDelete = () => {
		setIsDeleteDialogOpen(true);
	};

	const handleDuplicate = () => {
		toast.info("Duplicate functionality not yet implemented");
	};

	const confirmDelete = () => {
		deleteItemMutation.mutate();
	};

	if (!decryptedItemData) {
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
								<DropdownMenuItem onClick={handleDuplicate}>
									<CopyIcon className="mr-2 size-4" />
									Duplicate
								</DropdownMenuItem>
								<DropdownMenuItem
									onClick={() =>
										toggleFavoriteMutation.mutate(!rawItem?.favorite)
									}
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
							rawItem?.category === "secure-note" ? "secure-note" : "login"
						}
						data={decryptedItemData}
					/>
				</div>
			</div>
			<Dialog open={isNewItemDialogOpen} onOpenChange={setIsNewItemDialogOpen}>
				<DialogContent className="max-w-2xl">
					<DialogHeader>
						<DialogTitle>Create New Item</DialogTitle>
						<DialogDescription>
							Add a new {newItemCategory === "login" ? "login" : "secure note"}{" "}
							to your vault
						</DialogDescription>
					</DialogHeader>
					<ItemForm
						category={newItemCategory}
						onSubmit={(data) => {
							createItemMutation.mutate({
								category: newItemCategory,
								data,
							});
						}}
						onCancel={() => setIsNewItemDialogOpen(false)}
						isSubmitting={createItemMutation.isPending}
						selectedVaultId={selectedVaultId}
					/>
				</DialogContent>
			</Dialog>

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
									: "login"}
						</DialogDescription>
					</DialogHeader>
					{decryptedItemData && (
						<ItemForm
							category={
								rawItem?.category === "secure-note"
									? "secure-note"
									: rawItem?.category === "credit-card"
										? "credit-card"
										: "login"
							}
							initialData={decryptedItemData}
							onSubmit={(data) => {
								updateItemMutation.mutate({ data });
							}}
							onCancel={() => setIsEditDialogOpen(false)}
							isSubmitting={updateItemMutation.isPending}
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
							disabled={deleteItemMutation.isPending}
						>
							Move to Trash
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
