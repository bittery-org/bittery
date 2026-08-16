import { useMoveItem, useMoveTargetVaults } from "@bittery/core/hooks";
import type { DecryptedItem } from "@bittery/shared/types";
import {
	Button,
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
	Skeleton,
	toast,
	VaultAvatar,
} from "@bittery/ui";
import { IconCheck } from "@bittery/ui/icons";
import { cn } from "@bittery/ui/lib/utils";
import { useState } from "react";
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
 * transfer warning copy.
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
		<Sheet open={open} onOpenChange={handleOpenChange}>
			<SheetContent
				side="bottom"
				className="flex max-h-[80vh] flex-col gap-0 overflow-hidden p-0"
			>
				<SheetHeader className="border-b px-5 pt-5 pb-4 text-left">
					<SheetTitle className="truncate">
						{m.vaults_detail_items_move_dialog_title({ title: item.title })}
					</SheetTitle>
				</SheetHeader>

				<div className="flex-1 overflow-y-auto px-3 py-2">
					{isLoading ? (
						<div className="flex flex-col gap-1 p-2">
							{[0, 1, 2].map((row) => (
								<Skeleton key={row} className="h-14 rounded-lg" />
							))}
						</div>
					) : otherVaults.length === 0 ? (
						<div className="py-10 text-center text-muted-foreground text-sm">
							{m.vaults_detail_items_move_dialog_empty_no_other_vaults()}
						</div>
					) : (
						otherVaults.map((vaultKey) => {
							const isReadOnly = vaultKey.role === "read-only";
							const isSelected = vaultKey.vaultId === selectedVaultId;
							return (
								<button
									key={vaultKey.vaultId}
									type="button"
									disabled={isReadOnly}
									onClick={() => setSelectedVaultId(vaultKey.vaultId)}
									className={cn(
										"flex min-h-14 w-full items-center gap-3 rounded-lg px-3 py-2 text-left disabled:opacity-40",
										isSelected ? "bg-selected" : "active:bg-foreground/5",
									)}
								>
									<VaultAvatar
										name={vaultKey.vaultName}
										icon={vaultKey.vaultIcon}
										imageUrl={vaultKey.vaultImageUrl}
										size="sm"
									/>
									<div className="min-w-0 flex-1">
										<p className="truncate font-medium text-sm">
											{vaultKey.vaultName}
										</p>
										{vaultKey.accountId !== currentVaultAccountId && (
											<p className="truncate text-muted-foreground text-xs">
												{vaultKey.accountEmail ?? vaultKey.accountName ?? ""}
											</p>
										)}
									</div>
									{isReadOnly && (
										<span className="shrink-0 rounded-[4px] border bg-foreground/3 px-1.5 py-0.5 text-[10px] text-muted-foreground">
											{m.vaults_common_role_read_only()}
										</span>
									)}
									{isSelected && (
										<IconCheck className="size-4 shrink-0 text-primary" />
									)}
								</button>
							);
						})
					)}
				</div>

				{isCrossAccount && selectedVault && (
					<div className="mx-4 mb-3 rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2.5 text-amber-600 text-xs dark:text-amber-400">
						{m.vaults_detail_items_move_dialog_warning_cross_account()}
					</div>
				)}

				<div className="flex gap-2 border-t p-3">
					<Button
						type="button"
						variant="outline"
						className="h-11 flex-1"
						onClick={() => handleOpenChange(false)}
						disabled={moveItem.isPending}
					>
						{m.vaults_detail_items_detail_action_cancel()}
					</Button>
					<Button
						type="button"
						className="h-11 flex-1"
						onClick={() => void handleMove()}
						disabled={!selectedVaultId || moveItem.isPending}
					>
						{moveItem.isPending
							? isCrossAccount
								? m.vaults_detail_items_move_dialog_action_transferring()
								: m.vaults_detail_items_move_dialog_action_moving()
							: isCrossAccount
								? m.vaults_detail_items_move_dialog_action_transfer()
								: m.vaults_detail_items_move_dialog_action_move()}
					</Button>
				</div>
			</SheetContent>
		</Sheet>
	);
}
