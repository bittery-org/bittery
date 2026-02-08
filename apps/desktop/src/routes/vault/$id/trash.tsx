import { usePermanentDeleteItem, useRestoreItem } from "@bittery/core/hooks";
import { useTRPC } from "@bittery/shared/trpc";
import type { ItemCategory } from "@bittery/shared/types";
import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	toast,
} from "@bittery/ui";
import {
	IconBoxArchive3OutlineDuo18,
	IconShareLeft2OutlineDuo18,
	IconTrash2OutlineDuo18,
} from "@bittery/ui/icons";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { storage } from "@/lib/storage";
import { Favicon } from "../../../components/vault/favicon";
import { decrypt } from "../../../lib/tauri-crypto";

export const Route = createFileRoute("/vault/$id/trash")({
	component: TrashComponent,
});

interface DeletedItem {
	id: string;
	vaultId: string;
	category: ItemCategory;
	encryptedData: string;
	encryptionIv: string;
	encryptionAlgorithm: string;
	createdAt: string;
	updatedAt: string;
	deletedAt: string | null;
}

interface DecryptedDeletedItem extends DeletedItem {
	title: string;
	url?: string;
	username?: string;
}

function TrashComponent() {
	const trpc = useTRPC();

	const { id: vaultId } = Route.useParams();

	const [itemToDelete, setItemToDelete] = useState<string | null>(null);
	const [decryptedItems, setDecryptedItems] = useState<DecryptedDeletedItem[]>(
		[],
	);

	// Shared hooks for item operations
	const restoreItem = useRestoreItem();
	const permanentDeleteItem = usePermanentDeleteItem();

	// Fetch deleted items
	const { data: rawItems = [] } = useQuery({
		...trpc.vault.listDeletedItems.queryOptions({
			vaultId: vaultId || "",
		}),
		enabled: !!vaultId,
	});

	// Decrypt items when they change
	useEffect(() => {
		if (!vaultId || rawItems.length === 0) {
			setDecryptedItems([]);
			return;
		}

		const decryptItems = async () => {
			const vaultKey = await storage.getDecryptedVaultKey(vaultId);
			if (!vaultKey) {
				console.error("Failed to get vault key");
				return;
			}

			const decrypted: DecryptedDeletedItem[] = [];

			for (const item of rawItems) {
				try {
					const decryptedData = await decrypt(
						{
							algorithm: item.encryptionAlgorithm,
							iv: item.encryptionIv,
							ciphertext: item.encryptedData,
						},
						vaultKey,
					);

					const data = JSON.parse(decryptedData);

					decrypted.push({
						...item,
						title: data.title || "Untitled",
						url: data.url,
						username: data.username,
					});
				} catch (error) {
					console.error("Failed to decrypt item:", item.id, error);
					// Add item with fallback data
					decrypted.push({
						...item,
						title: "Unable to decrypt",
						url: undefined,
						username: undefined,
					});
				}
			}

			setDecryptedItems(decrypted);
		};

		decryptItems();
	}, [rawItems, vaultId]);

	const handleRestore = async (itemId: string) => {
		try {
			await restoreItem.mutateAsync({ itemId, vaultId });
			toast.success("Item restored successfully");
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : "Failed to restore item";
			toast.error(errorMessage);
		}
	};

	const handlePermanentDelete = (itemId: string) => {
		setItemToDelete(itemId);
	};

	const confirmPermanentDelete = async () => {
		if (itemToDelete) {
			try {
				await permanentDeleteItem.mutateAsync({
					itemId: itemToDelete,
					vaultId,
				});
				setItemToDelete(null);
				toast.success("Item permanently deleted");
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : "Failed to delete item";
				toast.error(errorMessage);
				setItemToDelete(null);
			}
		}
	};

	const formatDate = (dateString: string | null) => {
		if (!dateString) return "";
		const date = new Date(dateString);
		return new Intl.DateTimeFormat("en-US", {
			month: "short",
			day: "numeric",
			year: "numeric",
		}).format(date);
	};

	return (
		<div className="flex flex-1 flex-col">
			{/* Header */}
			<div className="flex items-center justify-between border-b bg-background px-8 py-4">
				<div className="flex items-center gap-3">
					<IconBoxArchive3OutlineDuo18 className="size-5 text-muted-foreground" />
					<div>
						<h2 className="font-semibold text-lg">Trash</h2>
						<p className="text-muted-foreground text-sm">
							Deleted items can be restored or permanently deleted
						</p>
					</div>
				</div>
			</div>

			{/* Content */}
			<div className="flex-1 overflow-y-auto p-8">
				{decryptedItems.length === 0 ? (
					<div className="flex h-full flex-col items-center justify-center text-center">
						<div className="mb-4 inline-flex rounded-full bg-muted p-6">
							<IconBoxArchive3OutlineDuo18
								size={48}
								className="text-muted-foreground"
							/>
						</div>
						<h3 className="mb-2 font-semibold text-lg">Trash is Empty</h3>
						<p className="text-muted-foreground text-sm">
							Deleted items will appear here
						</p>
					</div>
				) : (
					<div className="mx-auto max-w-4xl space-y-2">
						{decryptedItems.map((item) => (
							<div
								key={item.id}
								className="flex items-center justify-between rounded-lg border bg-card p-4 transition-colors hover:bg-muted/30"
							>
								<div className="flex min-w-0 flex-1 items-center gap-4">
									<Favicon
										url={item.url}
										title={item.title}
										category={item.category}
										size="md"
									/>
									<div className="min-w-0 flex-1">
										<div className="font-medium">{item.title}</div>
										{item.username && (
											<div className="mt-0.5 text-muted-foreground text-sm">
												{item.username}
											</div>
										)}
										<div className="mt-1 text-muted-foreground text-xs">
											Deleted {formatDate(item.deletedAt)}
										</div>
									</div>
								</div>
								<div className="flex items-center gap-2">
									<Button
										variant="outline"
										size="sm"
										onClick={() => handleRestore(item.id)}
										disabled={restoreItem.isPending}
									>
										<IconShareLeft2OutlineDuo18 className="size-4" />
										Restore
									</Button>
									<Button
										variant="destructive"
										size="sm"
										onClick={() => handlePermanentDelete(item.id)}
										disabled={permanentDeleteItem.isPending}
									>
										<IconTrash2OutlineDuo18 className="size-4" />
										Delete Forever
									</Button>
								</div>
							</div>
						))}
					</div>
				)}
			</div>

			{/* Confirmation Dialog */}
			<Dialog
				open={itemToDelete !== null}
				onOpenChange={(open) => !open && setItemToDelete(null)}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Permanently Delete Item?</DialogTitle>
						<DialogDescription>
							This action cannot be undone. This will permanently delete the
							item from the database.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button variant="outline" onClick={() => setItemToDelete(null)}>
							Cancel
						</Button>
						<Button variant="destructive" onClick={confirmPermanentDelete}>
							Delete Forever
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
