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
import { useI18n } from "@/providers/i18n-provider";
import { Favicon } from "../../../components/vault/favicon";
import { VaultAvatar } from "../../../components/vault/vault-avatar";

export const Route = createFileRoute("/vault/trash")({
	component: TrashComponent,
});

function TrashComponent() {
	const { m } = useI18n();
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
		const left = b.deletedAt ? new Date(b.deletedAt).getTime() : 0;
		const right = a.deletedAt ? new Date(a.deletedAt).getTime() : 0;
		return left - right;
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
			toast.success(m["vaults.trash.toast.restore_success"]());
		} catch (error) {
			console.error("Failed to restore item:", error);
			toast.error(m["vaults.trash.toast.restore_error"]());
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
				toast.success(m["vaults.trash.toast.permanent_delete_success"]());
			} catch (error) {
				console.error("Failed to delete item permanently:", error);
				toast.error(m["vaults.trash.toast.permanent_delete_error"]());
				setItemToDelete(null);
			}
		}
	};

	if (isLoading) {
		return (
			<div className="flex w-78 flex-col border-r bg-background">
				<div className="flex flex-1 items-center justify-center">
					<div className="text-muted-foreground text-sm">
						{m["vaults.trash.loading"]()}
					</div>
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
					<span className="font-medium">{m["vaults.trash.hero.badge"]()}</span>
					<Badge variant="secondary" className="ml-auto">
						{deletedItems.length}
					</Badge>
				</div>

				<div className="flex-1 overflow-y-auto">
					{deletedItems.length === 0 ? (
						<div className="flex h-full flex-col items-center justify-center p-8 text-center">
							<h3 className="mb-2 font-semibold">
								{m["vaults.trash.empty.title"]()}
							</h3>
							<p className="text-muted-foreground text-sm">
								{m["vaults.trash.empty.description"]()}
							</p>
						</div>
					) : (
						<div className="flex flex-col p-2">
							{sortedItems.map((item) => {
								const maskedCardNumber = item.cardNumber
									? maskCardNumber(item.cardNumber)
									: undefined;
								const title = item.title || m["vaults.trash.item.untitled"]();

								return (
									<div
										key={item.id}
										className="group mb-1 w-full rounded-md px-3 py-2.5 text-left transition-colors hover:bg-muted/30"
									>
										<div className="flex min-w-0 items-center gap-3">
											<Favicon item={item} title={title} size="sm" />
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
													title={m["vaults.trash.item.action.restore"]()}
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
													title={m["vaults.trash.item.action.delete_forever"]()}
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

			<div className="flex h-full min-w-0 flex-1 flex-col">
				<div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
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
						<DialogTitle>{m["vaults.trash.delete_dialog.title"]()}</DialogTitle>
						<DialogDescription>
							{m["vaults.trash.delete_dialog.description.unnamed"]()}
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button variant="outline" onClick={() => setItemToDelete(null)}>
							{m["vaults.trash.delete_dialog.action.cancel"]()}
						</Button>
						<Button variant="destructive" onClick={confirmPermanentDelete}>
							{m["vaults.trash.delete_dialog.action.confirm"]()}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
