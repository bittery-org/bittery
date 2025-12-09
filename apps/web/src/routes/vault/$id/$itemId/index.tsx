import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
	Copy as CopyIcon,
	Edit,
	FolderOpen,
	MoreVertical,
	Share2,
	Trash2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import Loader from "@/components/loader";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import ItemDetail from "@/components/vault/item-detail";
import { ItemForm } from "@/components/vault/item-form";
import {
	copyToClipboard,
	decrypt,
	encrypt,
	getDecryptedVaultKey,
	getVaultKeys,
} from "@/lib/crypto";
import { useTRPC, useTRPCClient } from "@/utils/trpc";

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
}

function VaultItemComponent() {
	const trpc = useTRPC();
	const trpcClient = useTRPCClient();
	const queryClient = useQueryClient();

	const { itemId } = Route.useParams();

	const [isNewItemDialogOpen, setIsNewItemDialogOpen] = useState(false);
	const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
	const [decryptedItemData, setDecryptedItemData] =
		useState<DecryptedItemData | null>(null);
	const selectedVaultId = Route.useParams().id;
	const [newItemCategory, _setNewItemCategory] = useState<
		"login" | "secure-note"
	>("login");

	// Get vault name
	const vaultKeys = getVaultKeys();
	const currentVault = vaultKeys?.find((v) => v.vaultId === selectedVaultId);

	// Fetch items for the selected vault
	const { data: rawItem } = useQuery({
		...trpc.vault.getItem.queryOptions({
			itemId: itemId || "",
		}),
	});

	// Create item mutation
	const createItemMutation = useMutation({
		mutationFn: async (input: {
			category: "login" | "secure-note";
			data: DecryptedItemData;
		}) => {
			if (!selectedVaultId) throw new Error("No vault selected");

			// Get vault key for encryption
			const vaultKey = await getDecryptedVaultKey(selectedVaultId);

			if (!vaultKey) throw new Error("No vault key found");

			// Encrypt the item data
			const encryptedData = await encrypt(JSON.stringify(input.data), vaultKey);

			// Create overview
			const overview = {
				title: input.data.title || "Untitled",
				...(input.data.url && { url: input.data.url }),
				...(input.data.username && { username: input.data.username }),
			};

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
			const vaultKey = await getDecryptedVaultKey(rawItem.vaultId);

			if (!vaultKey) throw new Error("No vault key found");

			// Encrypt the item data
			const encryptedData = await encrypt(JSON.stringify(input.data), vaultKey);

			// Create overview
			const overview = {
				title: input.data.title || "Untitled",
				...(input.data.url && { url: input.data.url }),
				...(input.data.username && { username: input.data.username }),
			};

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

	const getDecryptedItem = useCallback(async () => {
		if (!rawItem) return;

		// Decrypt item data
		try {
			const vaultKey = await getDecryptedVaultKey(rawItem.vaultId);

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
		toast.error("Delete functionality not yet implemented");
	};

	const handleDuplicate = () => {
		toast.info("Duplicate functionality not yet implemented");
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
						<FolderOpen className="size-4" />
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
							{rawItem?.category === "secure-note" ? "secure note" : "login"}
						</DialogDescription>
					</DialogHeader>
					{decryptedItemData && (
						<ItemForm
							category={
								rawItem?.category === "secure-note" ? "secure-note" : "login"
							}
							initialData={decryptedItemData}
							onSubmit={(data) => {
								updateItemMutation.mutate({ data });
							}}
							onCancel={() => setIsEditDialogOpen(false)}
							isSubmitting={updateItemMutation.isPending}
							submitLabel="Update"
						/>
					)}
				</DialogContent>
			</Dialog>
		</>
	);
}
