import {
	useDeletedItems,
	usePermanentDeleteItem,
	useRestoreItem,
} from "@bittery/core/hooks";
import { m as messages } from "@bittery/i18n/paraglide/messages";
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
	VaultAvatar,
} from "@bittery/ui";
import {
	IconBoxArchive3OutlineDuo18 as Archive,
	IconShareLeft2OutlineDuo18 as Restore,
	IconTrash2OutlineDuo18 as Trash,
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
		<div className="flex flex-1 flex-col overflow-hidden">
			{/* Header */}
			<div className="flex items-center justify-between border-b bg-background px-8 py-4">
				<div className="flex items-center gap-3">
					<Archive className="size-5 text-muted-foreground" />
					<div>
						<h2 className="font-semibold text-lg">
							{m.vaults_trash_hero_heading()}
						</h2>
						<p className="text-muted-foreground text-sm">
							{m.vaults_trash_hero_description()}
						</p>
					</div>
				</div>
				{!isLoading && sortedItems.length > 0 && (
					<span className="text-muted-foreground text-sm">
						{sortedItems.length === 1
							? m.vaults_trash_list_count_single({ count: sortedItems.length })
							: m.vaults_trash_list_count_plural({ count: sortedItems.length })}
					</span>
				)}
			</div>

			{/* Content */}
			<div className="flex-1 overflow-y-auto p-8">
				{isLoading ? (
					<div className="mx-auto max-w-4xl space-y-2">
						{[1, 2, 3].map((i) => (
							<Skeleton key={i} className="h-20" />
						))}
					</div>
				) : sortedItems.length === 0 ? (
					<div className="flex h-full flex-col items-center justify-center text-center">
						<div className="mb-4 inline-flex rounded-full bg-muted p-6">
							<Archive className="size-12 text-muted-foreground" />
						</div>
						<h3 className="mb-2 font-semibold text-lg">
							{m.vaults_trash_empty_title()}
						</h3>
						<p className="text-muted-foreground text-sm">
							{m.vaults_trash_empty_description()}
						</p>
					</div>
				) : (
					<div className="mx-auto max-w-4xl space-y-2">
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
									className="flex items-center justify-between rounded-lg border bg-card p-4 transition-colors hover:bg-muted/30"
								>
									<div className="flex min-w-0 flex-1 items-center gap-4">
										<Favicon item={item} title={title} size="md" />
										<div className="min-w-0 flex-1">
											<div className="font-medium">{title}</div>
											{secondaryText && (
												<div className="mt-0.5 truncate text-muted-foreground text-sm">
													{secondaryText}
												</div>
											)}
											<div className="mt-1 flex items-center gap-1.5 text-muted-foreground text-xs">
												<VaultAvatar
													name={item.vault.name}
													icon={item.vault.icon}
													imageUrl={item.vault.imageUrl}
													size="xs"
												/>
												<span className="truncate">{item.vault.name}</span>
												<span>·</span>
												<span>
													{m.vaults_trash_item_deleted_at({
														date: formatDeletedDate(
															item.deletedAt,
															m.vaults_trash_item_deleted_recently(),
														),
													})}
												</span>
											</div>
										</div>
									</div>
									<div className="ml-4 flex shrink-0 items-center gap-2">
										<Button
											variant="outline"
											size="sm"
											onClick={() => handleRestore(item.id, item.vaultId)}
											disabled={restoreItem.isPending}
										>
											<Restore className="size-4" />
											{m.vaults_trash_item_action_restore()}
										</Button>
										<Button
											variant="destructive"
											size="sm"
											onClick={() =>
												setItemToDelete({
													id: item.id,
													vaultId: item.vaultId,
													title: item.title || m.vaults_trash_item_untitled(),
												})
											}
											disabled={permanentDeleteItem.isPending}
										>
											<Trash className="size-4" />
											{m.vaults_trash_item_action_delete_forever()}
										</Button>
									</div>
								</div>
							);
						})}
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
