import { useMoveItem, useMoveTargetVaults } from "@bittery/core/hooks";
import type { DecryptedItem } from "@bittery/shared/types";
import { Skeleton, toast, VaultAvatar } from "@bittery/ui";
import { IconCheck, IconTriangleAlert } from "@bittery/ui/icons";
import { useState } from "react";
import {
	BrandButton,
	iconClass,
	ListCard,
	ListRow,
	MobileSheet,
	Pressable,
} from "@/components/ui";
import { useI18n } from "@/providers/i18n-provider";

interface MoveItemSheetProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	item: DecryptedItem;
	currentVaultId: string;
	/** Called after a same-account move succeeds, with the destination vault. Cross-account
	 * moves stay put (the item transfers asynchronously), so this is not called for those. */
	onMoved: (targetVaultId: string) => void;
}

/**
 * Mobile's own move UI — a bottom sheet, not desktop's `MoveItemDialog`
 * (`apps/desktop/src/components/vault/move-item-dialog.tsx`). That component is app-level (it
 * calls desktop's `useNavigate` and assembles Command/CommandInput/CommandItem for keyboard
 * navigation that a touch sheet does not need), and only its prop-shape type
 * (`MoveItemDialogProps`) is exported from `@bittery/ui`, not the component itself — so per the
 * "do not force a bad seam" rule this is a small mobile-only presentation instead of an import.
 * Same two data hooks as desktop (`useMoveTargetVaults`, `useMoveItem`), same cross-account
 * transfer warning copy — the presentation is the mobile kit's `MobileSheet` + `ListCard`.
 */
export function MoveItemSheet({
	open,
	onOpenChange,
	item,
	currentVaultId,
	onMoved,
}: MoveItemSheetProps) {
	const { m } = useI18n();
	const [selectedVaultId, setSelectedVaultId] = useState<string>("");
	const { vaultKeys, isLoading } = useMoveTargetVaults({ enabled: open });
	const moveItem = useMoveItem();

	const currentVault = vaultKeys.find((vk) => vk.vaultId === currentVaultId);
	const currentVaultAccountId = currentVault?.accountId;
	const otherVaults = vaultKeys.filter((vk) => vk.vaultId !== currentVaultId);
	const selectedVault = vaultKeys.find((vk) => vk.vaultId === selectedVaultId);
	const isCrossAccount = Boolean(
		selectedVault && selectedVault.accountId !== currentVaultAccountId,
	);

	const handleOpenChange = (nextOpen: boolean) => {
		if (!nextOpen) {
			setSelectedVaultId("");
		}
		onOpenChange(nextOpen);
	};

	const handleMove = async () => {
		if (!selectedVault || !currentVaultAccountId) return;

		const {
			id,
			vaultId,
			category,
			favorite,
			createdAt,
			updatedAt,
			...decryptedData
		} = item;

		try {
			const result = await moveItem.mutateAsync({
				itemId: item.id,
				sourceVaultId: currentVaultId,
				targetVaultId: selectedVault.vaultId,
				category: item.category,
				decryptedData,
				accountId: currentVaultAccountId,
				targetAccountId: selectedVault.accountId,
			});

			if (result.crossAccount) {
				toast.info(
					m.vaults_detail_items_move_dialog_toast_cross_account_pending(),
				);
			} else {
				toast.success(m.vaults_detail_items_move_dialog_toast_success());
			}

			handleOpenChange(false);
			if (!result.crossAccount) {
				onMoved(selectedVault.vaultId);
			}
		} catch (error) {
			const errorMessage =
				error instanceof Error
					? error.message
					: m.vaults_detail_items_move_dialog_toast_error();
			toast.error(errorMessage);
		}
	};

	return (
		<MobileSheet
			open={open}
			onOpenChange={handleOpenChange}
			title={m.vaults_detail_items_move_dialog_title({ title: item.title })}
		>
			<div className="flex min-h-0 flex-col">
				<div className="native-scroll min-h-0 flex-1 px-4 pb-2">
					{isLoading ? (
						<div className="flex flex-col gap-2">
							{[0, 1, 2].map((row) => (
								<Skeleton key={row} className="h-14 rounded-2xl" />
							))}
						</div>
					) : otherVaults.length === 0 ? (
						<p className="py-10 text-center text-muted-foreground text-sm">
							{m.vaults_detail_items_move_dialog_empty_no_other_vaults()}
						</p>
					) : (
						<ListCard>
							{otherVaults.map((vaultKey) => {
								const isReadOnly = vaultKey.role === "read-only";
								const isSelected = vaultKey.vaultId === selectedVaultId;
								return (
									<ListRow
										key={vaultKey.vaultId}
										title={vaultKey.vaultName}
										subtitle={
											vaultKey.accountId !== currentVaultAccountId
												? (vaultKey.accountEmail ??
													vaultKey.accountName ??
													undefined)
												: undefined
										}
										leading={
											<VaultAvatar
												name={vaultKey.vaultName}
												icon={vaultKey.vaultIcon}
												imageUrl={vaultKey.vaultImageUrl}
												size="sm"
											/>
										}
										value={
											isReadOnly ? m.vaults_common_role_read_only() : undefined
										}
										trailing={
											isSelected ? (
												<IconCheck
													className={`${iconClass.row} text-primary`}
												/>
											) : undefined
										}
										isDisabled={isReadOnly}
										isSelected={isSelected}
										onPress={() => setSelectedVaultId(vaultKey.vaultId)}
									/>
								);
							})}
						</ListCard>
					)}
				</div>

				{isCrossAccount && selectedVault ? (
					<div className="mx-4 mt-3 flex items-start gap-2 rounded-xl bg-warning-soft px-3 py-2.5 text-warning text-xs">
						<IconTriangleAlert className="mt-px size-3.5 shrink-0" />
						<span>
							{m.vaults_detail_items_move_dialog_warning_cross_account()}
						</span>
					</div>
				) : null}

				<div className="flex shrink-0 flex-col gap-2 px-4 pt-3 pb-6">
					<BrandButton
						label={
							moveItem.isPending
								? isCrossAccount
									? m.vaults_detail_items_move_dialog_action_transferring()
									: m.vaults_detail_items_move_dialog_action_moving()
								: isCrossAccount
									? m.vaults_detail_items_move_dialog_action_transfer()
									: m.vaults_detail_items_move_dialog_action_move()
						}
						onClick={() => void handleMove()}
						disabled={!selectedVaultId}
						isLoading={moveItem.isPending}
					/>
					<Pressable
						onClick={() => handleOpenChange(false)}
						disabled={moveItem.isPending}
						surface="sheet"
						className="flex h-11 w-full items-center justify-center rounded-xl bg-surface-tertiary font-medium text-base text-foreground"
					>
						{m.vaults_detail_items_detail_action_cancel()}
					</Pressable>
				</div>
			</div>
		</MobileSheet>
	);
}
