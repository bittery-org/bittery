/**
 * Trash — deleted items across every unlocked vault, with restore and permanent delete. No longer
 * a tab (DESIGN-NATIVE.md § Information architecture): it is a rare, reversible place, reached
 * from the account sheet and from Settings, so it is a pushed screen.
 *
 * Same two mutations as desktop's `/vault/trash`, with `ConfirmSheet` — the phone answer to a
 * desktop alert dialog — in place of `ConfirmDialog`.
 */

import {
	type DeletedItem,
	useDeletedItems,
	usePermanentDeleteItem,
	useRestoreItem,
} from "@bittery/core/hooks";
import { formatDate } from "@bittery/i18n/format/browser";
import { maskCardNumber } from "@bittery/shared/credit-card";
import { toast } from "@bittery/ui";
import { IconArchiveRestore, IconTrash } from "@bittery/ui/icons";
import {
	createFileRoute,
	useNavigate,
	useRouter,
} from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { MobileScreen } from "@/components/mobile-screen";
import {
	BarButton,
	ConfirmSheet,
	EmptyState,
	iconClass,
	ListCard,
	ListRow,
} from "@/components/ui";
import { Favicon } from "@/components/vault/favicon";
import { ItemsSkeleton } from "@/components/vault/items-skeleton";
import { VaultTile } from "@/components/vault/vault-tile";
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

function TrashScreen() {
	const { m } = useI18n();
	const navigate = useNavigate();
	const router = useRouter();
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

	// Trash is reached from the account sheet on any tab and from Settings, so there is no single
	// screen to return to — go back where the user came from, and fall back to Settings for a
	// cold start straight into this route.
	const handleBack = () => {
		if (router.history.canGoBack()) {
			router.history.back();
			return;
		}
		void navigate({ to: "/vault/settings" });
	};

	return (
		<MobileScreen
			title={m.mob_tab_trash()}
			backLabel={m.mob_common_go_back()}
			onBack={handleBack}
		>
			{isLoading ? (
				<ItemsSkeleton count={4} />
			) : sortedItems.length === 0 ? (
				<EmptyState
					className="min-h-full"
					icon={IconTrash}
					title={m.mob_trash_empty_title()}
					description={m.mob_trash_empty_description()}
				/>
			) : (
				<div className="px-4 pt-4">
					<ListCard>
						{sortedItems.map((item) => {
							const maskedCardNumber = item.cardNumber
								? maskCardNumber(item.cardNumber)
								: undefined;
							const title = item.title || m.vaults_trash_item_untitled();
							const secondary =
								item.username || item.email || maskedCardNumber || item.url;

							return (
								// Not pressable: a trashed item has no detail route, so the row's only
								// actions are the two trailing buttons.
								<ListRow
									key={item.id}
									leading={<Favicon item={item} title={title} />}
									title={title}
									subtitle={
										<span className="flex min-w-0 items-center gap-1.5">
											<VaultTile
												name={item.vault.name}
												icon={item.vault.icon}
												imageUrl={item.vault.imageUrl}
												size={16}
												radius={5}
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
										</span>
									}
									trailing={
										<span className="flex items-center">
											<BarButton
												onClick={() => void handleRestore(item)}
												disabled={restoreItem.isPending}
												aria-label={m.mob_trash_action_restore()}
											>
												<IconArchiveRestore className={iconClass.row} />
											</BarButton>
											<BarButton
												onClick={() => setItemToDelete(item)}
												disabled={permanentDeleteItem.isPending}
												aria-label={m.mob_trash_action_delete_forever()}
												className="text-danger"
											>
												<IconTrash className={iconClass.row} />
											</BarButton>
										</span>
									}
								/>
							);
						})}
					</ListCard>
				</div>
			)}

			<ConfirmSheet
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
				isPending={permanentDeleteItem.isPending}
			/>
		</MobileScreen>
	);
}
