import {
	useDeletedItems,
	usePermanentDeleteItem,
	useRestoreItem,
} from "@bittery/core/hooks";
import { maskCardNumber } from "@bittery/shared/credit-card";
import {
	Badge,
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
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useState } from "react";
import { Favicon } from "../../../components/vault/favicon";
import { VaultAvatar } from "../../../components/vault/vault-avatar";

export const Route = createFileRoute("/vault/trash")({
	component: TrashComponent,
});

function TrashComponent() {
	const [itemToDelete, setItemToDelete] = useState<{
		id: string;
		vaultId: string;
	} | null>(null);

	const { items: deletedItems, isLoading } = useDeletedItems();

	// Shared hooks for item operations
	const restoreItem = useRestoreItem();
	const permanentDeleteItem = usePermanentDeleteItem();

	// Sort items by deletedAt (most recent first)
	const sortedItems = [...deletedItems].sort((a, b) => {
		return new Date(b.deletedAt).getTime() - new Date(a.deletedAt).getTime();
	});

	const handleRestore = async (
		e: React.MouseEvent,
		itemId: string,
		vaultId: string,
	) => {
		e.preventDefault();
		e.stopPropagation();
		try {
			await restoreItem.mutateAsync({ itemId, vaultId });
			toast.success("Item restored successfully");
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : "Failed to restore item";
			toast.error(errorMessage);
		}
	};

	const handlePermanentDelete = (
		e: React.MouseEvent,
		itemId: string,
		vaultId: string,
	) => {
		e.preventDefault();
		e.stopPropagation();
		setItemToDelete({ id: itemId, vaultId });
	};

	const confirmPermanentDelete = async () => {
		if (itemToDelete) {
			try {
				await permanentDeleteItem.mutateAsync({
					itemId: itemToDelete.id,
					vaultId: itemToDelete.vaultId,
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

	if (isLoading) {
		return (
			<div className="flex w-78 flex-col border-r bg-background">
				<div className="flex flex-1 items-center justify-center">
					<div className="text-muted-foreground text-sm">Loading trash...</div>
				</div>
			</div>
		);
	}

	return (
		<>
			<div className="flex w-78 flex-col border-r bg-background">
				{/* Header */}
				<div className="flex items-center gap-2 border-b px-4 py-3">
					<IconBoxArchive3OutlineDuo18 className="size-4 text-muted-foreground" />
					<span className="font-medium">Trash</span>
					<Badge variant="secondary" className="ml-auto">
						{deletedItems.length}
					</Badge>
				</div>

				<div className="flex-1 overflow-y-auto">
					{deletedItems.length === 0 ? (
						<div className="flex h-full flex-col items-center justify-center p-8 text-center">
							<h3 className="mb-2 font-semibold">Trash is empty</h3>
							<p className="text-muted-foreground text-sm">
								Deleted items will appear here
							</p>
						</div>
					) : (
						<div className="flex flex-col p-2">
							{sortedItems.map((item) => {
								const maskedCardNumber = item.cardNumber
									? maskCardNumber(item.cardNumber)
									: undefined;
								const title = item.title || "[Untitled]";

								return (
									<div
										key={item.id}
										className="group mb-1 w-full rounded-md px-3 py-2.5 text-left transition-colors hover:bg-muted/30"
									>
										<div className="flex min-w-0 items-center gap-3">
											<Favicon
												url={item.url}
												title={title}
												category={item.category}
												size="sm"
											/>
											<div className="min-w-0 flex-1">
												<div className="flex items-center gap-1.5">
													<span className="truncate font-medium text-sm">
														{title}
													</span>
												</div>
												{item.username && (
													<div className="mt-0.5 truncate text-muted-foreground text-xs">
														{item.username}
													</div>
												)}
												{maskedCardNumber && (
													<div className="mt-0.5 truncate text-muted-foreground text-xs">
														{maskedCardNumber}
													</div>
												)}
												<div className="mt-0.5 flex items-center gap-1 text-muted-foreground/70 text-xs">
													<VaultAvatar
														name={item.vault.name}
														icon={item.vault.icon}
														imageUrl={item.vault.imageUrl}
														size="xs"
													/>
													<span className="truncate">{item.vault.name}</span>
												</div>
											</div>
											<div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
												<Button
													variant="ghost"
													size="sm"
													className="h-7 w-7 p-0"
													onClick={(e) =>
														handleRestore(e, item.id, item.vaultId)
													}
													disabled={restoreItem.isPending}
													title="Restore"
												>
													<IconShareLeft2OutlineDuo18 className="size-4 text-muted-foreground hover:text-foreground" />
												</Button>
												<Button
													variant="ghost"
													size="sm"
													className="h-7 w-7 p-0"
													onClick={(e) =>
														handlePermanentDelete(e, item.id, item.vaultId)
													}
													disabled={permanentDeleteItem.isPending}
													title="Delete forever"
												>
													<IconTrash2OutlineDuo18 className="size-4 text-muted-foreground hover:text-destructive" />
												</Button>
											</div>
										</div>
									</div>
								);
							})}
						</div>
					)}
				</div>
			</div>

			<div className="flex h-full flex-1 flex-col">
				<div className="flex flex-1 flex-col overflow-y-auto">
					<Outlet />
				</div>
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
		</>
	);
}
