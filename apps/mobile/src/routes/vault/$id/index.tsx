/**
 * One vault's item list, pushed from Browse. Each row opens `/vault/$id/$itemId`.
 *
 * No virtualisation: the spike measured ~51ms to decrypt 2 000 items, so a plain list is fine.
 * Creating an item is the FAB, preselected to this vault; the app bar keeps the TOTP-QR scanner
 * and carries the vault's own edit/delete actions behind an overflow sheet — this screen is the
 * only place a single vault is the subject, so it is where those two verbs belong.
 */

import {
	useAllVaultKeys,
	useDeleteVault,
	useVaultInfo,
	useVaultItems,
} from "@bittery/core/hooks";
import { toast } from "@bittery/ui";
import {
	IconEllipsis,
	IconKey,
	IconPencil,
	IconQrCode,
	IconTrash,
} from "@bittery/ui/icons";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { MobileScreen } from "@/components/mobile-screen";
import {
	BarButton,
	ConfirmSheet,
	EmptyState,
	Fab,
	iconClass,
	ListCard,
	MobileSheet,
	SheetAction,
} from "@/components/ui";
import { CreateItemSheet } from "@/components/vault/create-item-sheet";
import { MobileItemRow } from "@/components/vault/item-row";
import { ItemsSkeleton } from "@/components/vault/items-skeleton";
import { EditVaultSheet } from "@/components/vault/vault-form-sheet";
import { useCreateItemFlow } from "@/hooks/use-create-item-flow";
import { useFavoriteToggle } from "@/hooks/use-favorite-toggle";
import { useI18n } from "@/providers/i18n-provider";

export const Route = createFileRoute("/vault/$id/")({
	component: VaultItemListScreen,
});

function VaultItemListScreen() {
	const { m } = useI18n();
	const navigate = useNavigate();
	const { id } = Route.useParams();
	const { vaultInfo } = useVaultInfo(id);
	const { items, isLoading } = useVaultItems(id);
	const { vaultKeys } = useAllVaultKeys();
	const createItemFlow = useCreateItemFlow(vaultKeys);
	const { handleToggle } = useFavoriteToggle();
	const deleteVault = useDeleteVault();

	const [isActionsOpen, setIsActionsOpen] = useState(false);
	const [isEditOpen, setIsEditOpen] = useState(false);
	const [isDeleteOpen, setIsDeleteOpen] = useState(false);

	const isReadOnly = vaultInfo?.role === "read-only";

	/**
	 * Closes the overflow sheet, then runs the action once it has finished animating out.
	 * Radix holds a scroll lock and `pointer-events: none` on the body for the length of the
	 * exit transition, so opening the next sheet in the same tick leaves the app untappable.
	 * Same reason and same 220ms as `ItemDetailScreen.runAction`.
	 */
	const runAction = (action: () => void) => {
		setIsActionsOpen(false);
		setTimeout(action, 220);
	};

	const handleDeleteVault = async () => {
		if (!vaultInfo) return;
		try {
			await deleteVault.mutateAsync({
				vaultId: vaultInfo.vaultId,
				accountId: vaultInfo.accountId,
			});
			toast.success(m.mob_vault_toast_deleted());
			setIsDeleteOpen(false);
			// Back to Browse, not back in history: the screen behind this one may be the item
			// detail of an item that no longer exists.
			await navigate({ to: "/vault" });
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: m.mob_vault_toast_delete_failed(),
			);
		}
	};

	return (
		<MobileScreen
			title={vaultInfo?.vaultName ?? m.mob_vault_items_fallback_title()}
			subtitle={
				isLoading
					? undefined
					: items.length === 1
						? m.mob_item_count_singular({ count: String(items.length) })
						: m.mob_item_count_plural({ count: String(items.length) })
			}
			backLabel={m.mob_common_go_back()}
			onBack={() => navigate({ to: "/vault" })}
			headerEnd={
				<>
					<BarButton
						onClick={() => void createItemFlow.scanTotpQr()}
						aria-label={m.mob_form_totp_scan_qr()}
					>
						<IconQrCode className={iconClass.bar} />
					</BarButton>
					{/* Read-only members cannot rename or delete, so they get no overflow at all
					    rather than a sheet of disabled rows. */}
					{vaultInfo && !isReadOnly ? (
						<BarButton
							onClick={() => setIsActionsOpen(true)}
							aria-label={m.mob_a11y_more_actions()}
						>
							<IconEllipsis className={iconClass.bar} />
						</BarButton>
					) : null}
				</>
			}
			overlay={
				<>
					<Fab
						onPress={() => createItemFlow.setIsOpen(true)}
						ariaLabel={m.mob_create_item_header()}
						aboveTabBar={false}
					/>

					<MobileSheet
						open={isActionsOpen}
						onOpenChange={setIsActionsOpen}
						title={m.mob_vault_actions_sheet_title()}
						hideTitle
					>
						<div className="flex flex-col gap-0.5 px-3 pt-1 pb-4">
							<SheetAction
								icon={IconPencil}
								label={m.mob_vault_action_edit()}
								onPress={() => runAction(() => setIsEditOpen(true))}
							/>
							<SheetAction
								icon={IconTrash}
								tone="danger"
								label={m.mob_vault_action_delete()}
								disabled={deleteVault.isPending}
								onPress={() => runAction(() => setIsDeleteOpen(true))}
							/>
						</div>
					</MobileSheet>

					{/* Keyed on the vault so the form's initial state follows a vault switch —
					    the sheet's fields are `useState` seeded from props, which React keeps
					    across a re-render but not across a remount. */}
					{vaultInfo ? (
						<EditVaultSheet
							key={vaultInfo.vaultId}
							open={isEditOpen}
							onOpenChange={setIsEditOpen}
							vault={vaultInfo}
						/>
					) : null}

					<ConfirmSheet
						open={isDeleteOpen}
						onOpenChange={setIsDeleteOpen}
						title={m.mob_vault_delete_confirm_title({
							name: vaultInfo?.vaultName ?? "",
						})}
						description={m.mob_vault_delete_confirm_description()}
						confirmLabel={m.mob_vault_delete_confirm_confirm()}
						cancelLabel={m.mob_settings_cancel()}
						onConfirm={() => void handleDeleteVault()}
						isPending={deleteVault.isPending}
					/>
				</>
			}
		>
			{isLoading ? (
				<ItemsSkeleton />
			) : items.length === 0 ? (
				<EmptyState
					className="min-h-full"
					icon={IconKey}
					title={m.mob_vault_items_empty_no_items()}
					description={m.mob_vault_items_empty_description()}
					action={{
						label: m.mob_vault_items_empty_add_item(),
						onPress: () => createItemFlow.setIsOpen(true),
					}}
				/>
			) : (
				<div className="px-4 pt-4">
					<ListCard>
						{items.map((item) => (
							<MobileItemRow
								key={item.id}
								item={item}
								onSelect={() =>
									navigate({
										to: "/vault/$id/$itemId",
										params: { id, itemId: item.id },
									})
								}
								onToggleFavorite={() => handleToggle(item)}
							/>
						))}
					</ListCard>
				</div>
			)}

			<CreateItemSheet
				open={createItemFlow.isOpen}
				onOpenChange={createItemFlow.setIsOpen}
				vaults={createItemFlow.vaultOptions}
				selectedVaultId={id}
				initialCategory={createItemFlow.initialCategory}
				onCreateItem={createItemFlow.handleCreateItem}
			/>
		</MobileScreen>
	);
}
