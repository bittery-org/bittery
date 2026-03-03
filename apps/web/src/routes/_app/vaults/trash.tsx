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
	Skeleton,
	toast,
} from "@bittery/ui";
import {
	IconArrowLeftOutlineDuo18 as ArrowLeft,
	IconBoxArchive3OutlineDuo18 as Archive,
	IconShareLeft2OutlineDuo18 as Restore,
	IconTrash2OutlineDuo18 as Trash,
} from "@bittery/ui/icons";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Favicon } from "@/components/vault/favicon";
import { VaultAvatar } from "@/components/vaults/vault-avatar";

export const Route = createFileRoute("/_app/vaults/trash")({
	component: VaultTrashPage,
	head: () => ({
		meta: [{ title: "Trash - Bittery" }],
	}),
});

function formatDeletedDate(value: string | Date | null | undefined): string {
	if (!value) {
		return "recently";
	}

	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) {
		return "recently";
	}

	return new Intl.DateTimeFormat("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
	}).format(date);
}

function VaultTrashPage() {
	const { items: deletedItems, isLoading } = useDeletedItems();
	const restoreItem = useRestoreItem();
	const permanentDeleteItem = usePermanentDeleteItem();

	const [itemToDelete, setItemToDelete] = useState<{
		id: string;
		vaultId: string;
		title: string;
	} | null>(null);

	const sortedItems = useMemo(() => {
		return [...deletedItems].sort((a, b) => {
			const left = a.deletedAt ? new Date(a.deletedAt).getTime() : 0;
			const right = b.deletedAt ? new Date(b.deletedAt).getTime() : 0;
			return right - left;
		});
	}, [deletedItems]);

	const handleRestore = async (itemId: string, vaultId: string) => {
		try {
			await restoreItem.mutateAsync({ itemId, vaultId });
			toast.success("Item restored successfully");
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : "Failed to restore item";
			toast.error(errorMessage);
		}
	};

	const handleConfirmPermanentDelete = async () => {
		if (!itemToDelete) {
			return;
		}

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
	};

	return (
		<>
			<div className="mx-auto flex w-full max-w-6xl flex-col gap-6 pb-3">
				<section className="relative overflow-hidden rounded-2xl border bg-card p-6 sm:p-7">
					<div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-muted/60 via-transparent to-transparent" />
					<div className="pointer-events-none absolute -top-24 right-0 h-56 w-56 rounded-full bg-muted/50 blur-3xl" />

					<div className="relative flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
						<div className="space-y-4">
							<Badge variant="secondary" className="w-fit">
								<Archive className="mr-1 h-3.5 w-3.5" />
								Trash
							</Badge>
							<div className="space-y-2">
								<h1 className="text-balance font-bold text-3xl tracking-tight md:text-4xl">
									Deleted Items
								</h1>
								<p className="max-w-2xl text-muted-foreground">
									Items moved to trash can be restored or permanently deleted.
								</p>
							</div>
						</div>

						<Button variant="outline" asChild>
							<Link to="/vaults">
								<ArrowLeft className="mr-2 h-4 w-4" />
								Back to Vaults
							</Link>
						</Button>
					</div>
				</section>

				{isLoading ? (
					<div className="space-y-3">
						{[1, 2, 3].map((i) => (
							<Skeleton key={i} className="h-24 rounded-xl" />
						))}
					</div>
				) : sortedItems.length === 0 ? (
					<div className="flex flex-col items-center gap-4 rounded-xl border border-dashed p-10 text-center">
						<div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
							<Archive className="h-6 w-6 text-muted-foreground" />
						</div>
						<div>
							<h3 className="font-medium text-lg">Trash is empty</h3>
							<p className="mt-1 text-muted-foreground text-sm">
								Deleted items will appear here.
							</p>
						</div>
					</div>
				) : (
					<div className="space-y-3">
						<div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
							<h2 className="font-semibold text-lg tracking-tight">
								All Trash
							</h2>
							<p className="text-muted-foreground text-sm">
								{sortedItems.length} item{sortedItems.length !== 1 ? "s" : ""}{" "}
								in trash
							</p>
						</div>

						<div className="space-y-2">
							{sortedItems.map((item) => {
								const maskedCardNumber = item.cardNumber
									? maskCardNumber(item.cardNumber)
									: undefined;
								const title = item.title || "[Untitled]";
								const secondaryText =
									item.username || item.email || maskedCardNumber || item.url;

								return (
									<div
										key={item.id}
										className="group rounded-xl border bg-card p-4 transition-colors hover:bg-muted/20"
									>
										<div className="flex min-w-0 items-center gap-3">
											<Favicon
												url={item.url}
												title={title}
												category={item.category}
												size="sm"
											/>

											<div className="min-w-0 flex-1">
												<div className="truncate font-medium">{title}</div>
												{secondaryText && (
													<div className="truncate text-muted-foreground text-sm">
														{secondaryText}
													</div>
												)}
												<div className="mt-1 flex items-center gap-2 text-muted-foreground text-xs">
													<VaultAvatar
														name={item.vault.name}
														icon={item.vault.icon}
														imageUrl={item.vault.imageUrl}
														size="xs"
													/>
													<span className="truncate">{item.vault.name}</span>
													<span>•</span>
													<span>
														Deleted {formatDeletedDate(item.deletedAt)}
													</span>
												</div>
											</div>

											<div className="flex shrink-0 items-center gap-2">
												<Button
													variant="outline"
													size="sm"
													onClick={() => handleRestore(item.id, item.vaultId)}
													disabled={restoreItem.isPending}
												>
													<Restore className="h-4 w-4" />
													Restore
												</Button>
												<Button
													variant="destructive"
													size="sm"
													onClick={() =>
														setItemToDelete({
															id: item.id,
															vaultId: item.vaultId,
															title,
														})
													}
													disabled={permanentDeleteItem.isPending}
												>
													<Trash className="h-4 w-4" />
													Delete Forever
												</Button>
											</div>
										</div>
									</div>
								);
							})}
						</div>
					</div>
				)}
			</div>

			<Dialog
				open={itemToDelete !== null}
				onOpenChange={(open) => !open && setItemToDelete(null)}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Permanently Delete Item?</DialogTitle>
						<DialogDescription>
							This action cannot be undone.{" "}
							{itemToDelete?.title ? `"${itemToDelete.title}"` : "This item"}{" "}
							will be permanently removed.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button variant="outline" onClick={() => setItemToDelete(null)}>
							Cancel
						</Button>
						<Button
							variant="destructive"
							onClick={handleConfirmPermanentDelete}
						>
							Delete Forever
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
