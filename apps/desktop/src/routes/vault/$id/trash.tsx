import {
	useDeletedItems,
	usePermanentDeleteItem,
	useRestoreItem,
} from "@bittery/core/hooks";
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
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Favicon } from "../../../components/vault/favicon";
import { formatDate } from "../../../lib/i18n-format";

export const Route = createFileRoute("/vault/$id/trash")({
	component: TrashComponent,
});

function TrashComponent() {
	const { id: vaultId } = Route.useParams();

	const [itemToDelete, setItemToDelete] = useState<string | null>(null);

	// Shared hooks for item operations
	const restoreItem = useRestoreItem();
	const permanentDeleteItem = usePermanentDeleteItem();
	const { items: allDeletedItems, isLoading } = useDeletedItems();

	const deletedItems = useMemo(() => {
		return allDeletedItems
			.filter((item) => item.vaultId === vaultId)
			.sort((a, b) => {
				const dateA = a.deletedAt ? new Date(a.deletedAt).getTime() : 0;
				const dateB = b.deletedAt ? new Date(b.deletedAt).getTime() : 0;
				return dateB - dateA;
			});
	}, [allDeletedItems, vaultId]);

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

	const formatDeletedDate = (dateString: string | null) => {
		if (!dateString) return "";
		return formatDate(dateString, {
			month: "short",
			day: "numeric",
			year: "numeric",
		});
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
				{isLoading ? (
					<div className="flex h-full items-center justify-center text-muted-foreground text-sm">
						Loading trash...
					</div>
				) : deletedItems.length === 0 ? (
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
						{deletedItems.map((item) => (
							<div
								key={item.id}
								className="flex items-center justify-between rounded-lg border bg-card p-4 transition-colors hover:bg-muted/30"
							>
								<div className="flex min-w-0 flex-1 items-center gap-4">
									<Favicon item={item} size="md" />
									<div className="min-w-0 flex-1">
										<div className="font-medium">
											{item.title || "Untitled"}
										</div>
										{item.username && (
											<div className="mt-0.5 text-muted-foreground text-sm">
												{item.username}
											</div>
										)}
										<div className="mt-1 text-muted-foreground text-xs">
											Deleted {formatDeletedDate(item.deletedAt)}
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
