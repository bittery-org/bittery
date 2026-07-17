import {
	useDeletedItems,
	usePermanentDeleteItem,
	useRestoreItem,
} from "@bittery/core/hooks";
import { m as messages } from "@bittery/i18n/paraglide/messages";
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
	VaultAvatar,
} from "@bittery/ui";
import {
	IconArchive as Archive,
	IconArchiveRestore as Restore,
	IconTrash as Trash,
} from "@bittery/ui/icons";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Favicon } from "@/components/vault/favicon";
import { formatDate } from "@/lib/i18n-format";
import { useI18n } from "@/providers/i18n-provider";

export const Route = createFileRoute("/_app/vaults/trash")({
	component: VaultTrashPage,
	head: () => ({
		meta: [{ title: messages.vaults_trash_meta_title() }],
	}),
});

function formatDeletedDate(
	value: string | Date | null | undefined,
	fallbackLabel: string,
): string {
	if (!value) return fallbackLabel;
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return fallbackLabel;
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

	const handleRestore = async (itemId: string, vaultId: string) => {
		try {
			await restoreItem.mutateAsync({ itemId, vaultId });
			toast.success(m.vaults_trash_toast_restore_success());
		} catch {
			toast.error(m.vaults_trash_toast_restore_error());
		}
	};

	const handleConfirmPermanentDelete = async () => {
		if (!itemToDelete) return;
		try {
			await permanentDeleteItem.mutateAsync({
				itemId: itemToDelete.id,
				vaultId: itemToDelete.vaultId,
			});
			setItemToDelete(null);
			toast.success(m.vaults_trash_toast_permanent_delete_success());
		} catch {
			toast.error(m.vaults_trash_toast_permanent_delete_error());
			setItemToDelete(null);
		}
	};

	return (
		<div className="flex min-w-0 flex-1 flex-col overflow-hidden">
			{/* Header */}
			<div className="flex h-11 shrink-0 items-center gap-2 border-b px-4 xl:h-12">
				<Archive className="size-4 shrink-0 text-muted-foreground" />
				<span className="truncate font-medium text-sm">
					{m.vaults_trash_hero_heading()}
				</span>
				{!isLoading && sortedItems.length > 0 && (
					<Badge variant="secondary" className="ml-auto shrink-0">
						{sortedItems.length}
					</Badge>
				)}
			</div>

			{/* Content */}
			<div className="flex-1 overflow-y-auto">
				{isLoading ? (
					<div className="mx-auto w-full max-w-3xl space-y-2 px-6 py-8">
						{[1, 2, 3].map((i) => (
							<Skeleton key={i} className="h-14 rounded-lg" />
						))}
					</div>
				) : sortedItems.length === 0 ? (
					<div className="flex h-full flex-col items-center justify-center p-8 text-center">
						<div
							aria-hidden
							className="mb-4 flex size-12 items-center justify-center rounded-lg border bg-card"
						>
							<Archive className="size-5 text-muted-foreground" />
						</div>
						<h3 className="mb-1 font-semibold text-sm">
							{m.vaults_trash_empty_title()}
						</h3>
						<p className="max-w-64 text-muted-foreground text-sm">
							{m.vaults_trash_empty_description()}
						</p>
					</div>
				) : (
					<div className="mx-auto w-full max-w-3xl px-6 py-8">
						<p className="mb-4 text-muted-foreground text-sm">
							{m.vaults_trash_hero_description()}
						</p>
						<div className="divide-y overflow-hidden rounded-lg border bg-card">
							{sortedItems.map((item) => {
								const maskedCardNumber = item.cardNumber
									? maskCardNumber(item.cardNumber)
									: undefined;
								const title = item.title || m.vaults_trash_item_untitled();
								const secondaryText =
									item.username || item.email || maskedCardNumber || item.url;

								return (
									<div
										key={item.id}
										className="group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-foreground/4"
									>
										<Favicon item={item} title={title} size="sm" />
										<div className="min-w-0 flex-1">
											<div className="truncate font-medium text-sm">
												{title}
											</div>
											{secondaryText && (
												<div className="mt-0.5 truncate text-muted-foreground text-xs">
													{secondaryText}
												</div>
											)}
										</div>
										<div className="flex shrink-0 items-center gap-1.5 text-muted-foreground text-xs">
											<VaultAvatar
												name={item.vault.name}
												icon={item.vault.icon}
												imageUrl={item.vault.imageUrl}
												size="xs"
											/>
											<span className="max-w-32 truncate">
												{item.vault.name}
											</span>
											<span aria-hidden>·</span>
											<span>
												{m.vaults_trash_item_deleted_at({
													date: formatDeletedDate(
														item.deletedAt,
														m.vaults_trash_item_deleted_recently(),
													),
												})}
											</span>
										</div>
										<div className="ml-1 flex shrink-0 items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
											<Button
												variant="ghost"
												size="sm"
												className="size-7 p-0"
												onClick={() => handleRestore(item.id, item.vaultId)}
												disabled={restoreItem.isPending}
												title={m.vaults_trash_item_action_restore()}
												aria-label={m.vaults_trash_item_action_restore()}
											>
												<Restore className="size-4" />
											</Button>
											<Button
												variant="ghost"
												size="sm"
												className="size-7 p-0 hover:text-destructive"
												onClick={() =>
													setItemToDelete({
														id: item.id,
														vaultId: item.vaultId,
														title: item.title || m.vaults_trash_item_untitled(),
													})
												}
												disabled={permanentDeleteItem.isPending}
												title={m.vaults_trash_item_action_delete_forever()}
												aria-label={m.vaults_trash_item_action_delete_forever()}
											>
												<Trash className="size-4" />
											</Button>
										</div>
									</div>
								);
							})}
						</div>
					</div>
				)}
			</div>

			{/* Permanent delete confirmation dialog */}
			<Dialog
				open={itemToDelete !== null}
				onOpenChange={(open) => !open && setItemToDelete(null)}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{m.vaults_trash_delete_dialog_title()}</DialogTitle>
						<DialogDescription>
							{itemToDelete?.title
								? m.vaults_trash_delete_dialog_description_named({
										title: itemToDelete.title,
									})
								: m.vaults_trash_delete_dialog_description_unnamed()}
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button variant="outline" onClick={() => setItemToDelete(null)}>
							{m.vaults_trash_delete_dialog_action_cancel()}
						</Button>
						<Button
							variant="destructive"
							onClick={handleConfirmPermanentDelete}
						>
							{m.vaults_trash_delete_dialog_action_confirm()}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
