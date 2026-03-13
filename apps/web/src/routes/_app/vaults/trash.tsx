import {
	useDeletedItems,
	usePermanentDeleteItem,
	useRestoreItem,
} from "@bittery/core/hooks";
import { maskCardNumber } from "@bittery/shared/credit-card";
import {
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
	IconBoxArchive3OutlineDuo18 as Archive,
	IconArrowLeftOutlineDuo18 as ArrowLeft,
	IconShareLeft2OutlineDuo18 as Restore,
	IconTrash2OutlineDuo18 as Trash,
} from "@bittery/ui/icons";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Favicon } from "@/components/vault/favicon";
import { VaultAvatar } from "@/components/vaults/vault-avatar";
import { formatDate } from "@/lib/i18n-format";
import { m as messages } from "@/paraglide/messages";
import { useI18n } from "@/providers/i18n-provider";

export const Route = createFileRoute("/_app/vaults/trash")({
	component: VaultTrashPage,
	head: () => ({
		meta: [{ title: messages["vaults.trash.meta_title"]() }],
	}),
});

function formatDeletedDate(
	value: string | Date | null | undefined,
	fallbackLabel: string,
): string {
	if (!value) {
		return fallbackLabel;
	}

	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) {
		return fallbackLabel;
	}

	return formatDate(date, {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
}

function VaultTrashPage() {
	const { m } = useI18n();
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
	const trashCountLabel =
		sortedItems.length === 1
			? m["vaults.trash.list.count.single"]({ count: sortedItems.length })
			: m["vaults.trash.list.count.plural"]({ count: sortedItems.length });

	const handleRestore = async (itemId: string, vaultId: string) => {
		try {
			await restoreItem.mutateAsync({ itemId, vaultId });
			toast.success(m["vaults.trash.toast.restore_success"]());
		} catch {
			toast.error(m["vaults.trash.toast.restore_error"]());
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
			toast.success(m["vaults.trash.toast.permanent_delete_success"]());
		} catch {
			toast.error(m["vaults.trash.toast.permanent_delete_error"]());
			setItemToDelete(null);
		}
	};

	return (
		<>
			<div className="mx-auto flex w-full max-w-6xl flex-col gap-6 pb-3">
				<section className="relative overflow-hidden rounded-2xl border bg-card p-3 sm:p-5">
					<div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-muted/60 via-transparent to-transparent" />

					<div className="relative flex items-center justify-between gap-3">
						<div className="flex min-w-0 items-center gap-3">
							<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted shadow-sm sm:h-10 sm:w-10">
								<Archive className="h-4 w-4 text-muted-foreground sm:h-5 sm:w-5" />
							</div>
							<div className="min-w-0">
								<h1 className="truncate font-semibold text-lg tracking-tight sm:text-xl">
									{m["vaults.trash.hero.heading"]()}
								</h1>
								{!isLoading && (
									<p className="text-muted-foreground text-xs">
										{trashCountLabel}
									</p>
								)}
							</div>
						</div>

						<Button
							variant="outline"
							size="sm"
							className="h-8 shrink-0 px-2 sm:px-3"
							asChild
						>
							<Link to="/vaults">
								<ArrowLeft className="h-3.5 w-3.5 sm:mr-1.5" />
								<span className="hidden text-xs sm:inline">
									{m["vaults.trash.action.back_to_vaults"]()}
								</span>
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
							<h3 className="font-medium text-lg">
								{m["vaults.trash.empty.title"]()}
							</h3>
							<p className="mt-1 text-muted-foreground text-sm">
								{m["vaults.trash.empty.description"]()}
							</p>
						</div>
					</div>
				) : (
					<div className="space-y-3">
						<div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
							<h2 className="font-semibold text-lg tracking-tight">
								{m["vaults.trash.list.heading"]()}
							</h2>
							<p className="text-muted-foreground text-sm">{trashCountLabel}</p>
						</div>

						<div className="space-y-2">
							{sortedItems.map((item) => {
								const maskedCardNumber = item.cardNumber
									? maskCardNumber(item.cardNumber)
									: undefined;
								const title = item.title || m["vaults.trash.item.untitled"]();
								const secondaryText =
									item.username || item.email || maskedCardNumber || item.url;

								return (
									<div
										key={item.id}
										className="group rounded-xl border bg-card p-4 transition-colors hover:bg-muted/20"
									>
										<div className="flex min-w-0 items-center gap-3">
											<Favicon item={item} title={title} size="sm" />

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
														{m["vaults.trash.item.deleted_at"]({
															date: formatDeletedDate(
																item.deletedAt,
																m["vaults.trash.item.deleted_recently"](),
															),
														})}
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
													{m["vaults.trash.item.action.restore"]()}
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
													{m["vaults.trash.item.action.delete_forever"]()}
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
						<DialogTitle>{m["vaults.trash.delete_dialog.title"]()}</DialogTitle>
						<DialogDescription>
							{itemToDelete?.title
								? m["vaults.trash.delete_dialog.description.named"]({
										title: itemToDelete.title,
									})
								: m["vaults.trash.delete_dialog.description.unnamed"]()}
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button variant="outline" onClick={() => setItemToDelete(null)}>
							{m["vaults.trash.delete_dialog.action.cancel"]()}
						</Button>
						<Button
							variant="destructive"
							onClick={handleConfirmPermanentDelete}
						>
							{m["vaults.trash.delete_dialog.action.confirm"]()}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
