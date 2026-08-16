/**
 * M3-C2 — "Trash" tab (D12). Deleted items across every unlocked vault, restore and permanent
 * delete. Mirrors desktop's `/vault/trash` (`apps/desktop/src/routes/vault/trash.tsx`) — same
 * two mutations, `ConfirmDialog` instead of a hand-assembled `AlertDialog` for the permanent
 * delete confirmation (`ConfirmDialog` did not exist yet when desktop's trash screen was
 * written).
 */

import {
	type DeletedItem,
	useDeletedItems,
	usePermanentDeleteItem,
	useRestoreItem,
} from "@bittery/core/hooks";
import { formatDate } from "@bittery/i18n/format/browser";
import { maskCardNumber } from "@bittery/shared/credit-card";
import { ConfirmDialog, Skeleton, toast, VaultAvatar } from "@bittery/ui";
import { IconArchiveRestore, IconTrash } from "@bittery/ui/icons";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Favicon } from "@/components/vault/favicon";
import { TabScreen } from "@/components/vault/tab-screen";
import { useI18n } from "@/providers/i18n-provider";

export const Route = createFileRoute("/vault/trash")({
	component: TrashScreen,
});

function formatDeletedDate(
	value: string | Date | null | undefined,
	fallbackLabel: string,
): string {
	if (!value) return fallbackLabel;
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return fallbackLabel;
	return formatDate(date, { month: "short", day: "numeric", year: "numeric" });
}

function TrashSkeleton() {
	return (
		<div className="flex flex-col gap-2 p-3">
			{[0, 1, 2].map((row) => (
				<Skeleton key={row} className="h-16 rounded-lg" />
			))}
		</div>
	);
}

function TrashScreen() {
	const { m } = useI18n();
	const { items: deletedItems, isLoading } = useDeletedItems();
	const restoreItem = useRestoreItem();
	const permanentDeleteItem = usePermanentDeleteItem();
	const [itemToDelete, setItemToDelete] = useState<DeletedItem | null>(null);

	const sortedItems = useMemo(() => {
		return [...deletedItems].sort((a, b) => {
			const left = a.deletedAt ? new Date(a.deletedAt).getTime() : 0;
			const right = b.deletedAt ? new Date(b.deletedAt).getTime() : 0;
			return right - left;
		});
	}, [deletedItems]);

	const handleRestore = async (item: DeletedItem) => {
		const accountId = item.accountId ?? item.account?.accountId;
		if (!accountId) return;
		try {
			await restoreItem.mutateAsync({
				itemId: item.id,
				vaultId: item.vaultId,
				accountId,
			});
			toast.success(m.mob_trash_toast_restored());
		} catch {
			toast.error(m.mob_trash_toast_restore_failed());
		}
	};

	const handleConfirmPermanentDelete = async () => {
		if (!itemToDelete) return;
		const accountId = itemToDelete.accountId ?? itemToDelete.account?.accountId;
		if (!accountId) return;
		try {
			await permanentDeleteItem.mutateAsync({
				itemId: itemToDelete.id,
				vaultId: itemToDelete.vaultId,
				accountId,
			});
			toast.success(m.mob_trash_toast_deleted());
			setItemToDelete(null);
		} catch {
			toast.error(m.mob_trash_toast_delete_failed());
			setItemToDelete(null);
		}
	};

	return (
		<TabScreen title={m.mob_tab_trash()} activeTab="trash">
			{isLoading ? (
				<TrashSkeleton />
			) : sortedItems.length === 0 ? (
				<div className="flex h-full flex-col items-center justify-center gap-1 p-8 text-center">
					<h2 className="font-semibold text-lg">{m.mob_trash_empty_title()}</h2>
					<p className="text-muted-foreground text-sm">
						{m.mob_trash_empty_description()}
					</p>
				</div>
			) : (
				<div className="flex flex-col gap-1 p-2">
					{sortedItems.map((item) => {
						const maskedCardNumber = item.cardNumber
							? maskCardNumber(item.cardNumber)
							: undefined;
						const title = item.title || m.vaults_trash_item_untitled();
						const secondary =
							item.username || item.email || maskedCardNumber || item.url;

						return (
							<div
								key={item.id}
								className="flex items-center gap-2.5 rounded-lg px-2 py-2"
							>
								<Favicon item={item} title={title} size="sm" />
								<div className="min-w-0 flex-1">
									<p className="truncate font-medium text-sm">{title}</p>
									<div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
										<VaultAvatar
											name={item.vault.name}
											icon={item.vault.icon}
											imageUrl={item.vault.imageUrl}
											size="xs"
										/>
										<span className="truncate">
											{secondary
												? secondary
												: m.vaults_trash_item_deleted_at({
														date: formatDeletedDate(
															item.deletedAt,
															m.vaults_trash_item_deleted_recently(),
														),
													})}
										</span>
									</div>
								</div>
								<button
									type="button"
									onClick={() => void handleRestore(item)}
									disabled={restoreItem.isPending}
									aria-label={m.mob_trash_action_restore()}
									className="flex size-11 shrink-0 items-center justify-center rounded-md text-foreground active:bg-foreground/5"
								>
									<IconArchiveRestore className="size-4.5" />
								</button>
								<button
									type="button"
									onClick={() => setItemToDelete(item)}
									disabled={permanentDeleteItem.isPending}
									aria-label={m.mob_trash_action_delete_forever()}
									className="flex size-11 shrink-0 items-center justify-center rounded-md text-destructive active:bg-destructive/10"
								>
									<IconTrash className="size-4.5" />
								</button>
							</div>
						);
					})}
				</div>
			)}

			<ConfirmDialog
				open={itemToDelete !== null}
				onOpenChange={(open) => !open && setItemToDelete(null)}
				title={m.mob_trash_alert_delete_title()}
				description={
					itemToDelete?.title
						? m.mob_trash_alert_delete_message({ title: itemToDelete.title })
						: m.vaults_trash_delete_dialog_description_unnamed()
				}
				cancelLabel={m.mob_trash_alert_cancel()}
				confirmLabel={m.mob_trash_alert_delete_confirm()}
				onConfirm={() => void handleConfirmPermanentDelete()}
				busy={permanentDeleteItem.isPending}
				destructive
			/>
		</TabScreen>
	);
}
