import {
	Button,
	Command,
	CommandInput,
	CommandItem,
	CommandList,
	cn,
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	type MoveItemDialogProps,
	toast,
	VaultAvatar,
} from "@bittery/ui";
import {
	IconCheck as Check,
	IconLoaderCircle as LoaderCircle,
} from "@bittery/ui/icons";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
	runtimeMoveTargets,
	useMoveItem,
} from "@/hooks/use-runtime-item-mutations";
import { useRuntimeItems } from "@/hooks/use-runtime-items";
import { useI18n } from "@/providers/i18n-provider";

export function MoveItemDialog({
	open,
	onOpenChange,
	item,
	currentVaultId,
}: MoveItemDialogProps) {
	const { m } = useI18n();
	const [selectedVaultId, setSelectedVaultId] = useState<string>("");
	const [searchQuery, setSearchQuery] = useState("");
	// Runtime projections are already scoped to the explicit active Account.
	const runtimeItems = useRuntimeItems();
	const vaultKeys = useMemo(
		() =>
			runtimeItems.accountId === null
				? []
				: runtimeMoveTargets(runtimeItems.accountId, runtimeItems.vaults),
		[runtimeItems.accountId, runtimeItems.vaults],
	);
	const isLoading = open && runtimeItems.state === "loading";
	const moveItem = useMoveItem();
	const navigate = useNavigate();

	const currentVaultAccountId = useMemo(() => {
		const currentVault = vaultKeys.find((vk) => vk.vaultId === currentVaultId);
		return currentVault?.accountId;
	}, [vaultKeys, currentVaultId]);

	const filteredVaultKeys = useMemo(() => {
		if (!searchQuery.trim()) return vaultKeys;
		const query = searchQuery.toLowerCase();
		return vaultKeys.filter((vk) =>
			vk.vaultName.toLowerCase().includes(query),
		);
	}, [vaultKeys, searchQuery]);

	const selectedVault = useMemo(() => {
		return vaultKeys.find((vk) => vk.vaultId === selectedVaultId);
	}, [vaultKeys, selectedVaultId]);

	const isCrossAccount = useMemo(() => {
		if (!selectedVault) return false;
		return selectedVault.accountId !== currentVaultAccountId;
	}, [selectedVault, currentVaultAccountId]);

	const handleMove = async () => {
		if (!selectedVaultId) {
			toast.error(m.vaults_detail_items_move_dialog_toast_select_vault());
			return;
		}
		const sourceAccountId = currentVaultAccountId;
		if (!selectedVault || !sourceAccountId) {
			toast.error(m.vaults_detail_items_move_dialog_toast_error());
			return;
		}

		try {
			const result = await moveItem.mutateAsync({
				itemId: item.id,
				sourceVaultId: currentVaultId,
				targetVaultId: selectedVaultId,
				accountId: sourceAccountId,
				targetAccountId: selectedVault.accountId,
			});

			if (result.crossAccount) {
				toast.info(
					m.vaults_detail_items_move_dialog_toast_cross_account_pending(),
				);
			} else {
				toast.success(m.vaults_detail_items_move_dialog_toast_success());
			}

			onOpenChange(false);

			if (result.crossAccount) {
				return;
			}
			navigate({
				to: "/vaults/$vaultId",
				params: { vaultId: selectedVaultId },
				search: { itemId: item.id },
			});
		} catch (error) {
			const errorMessage =
				error instanceof Error
					? error.message
					: m.vaults_detail_items_move_dialog_toast_error();
			toast.error(errorMessage);
		}
	};

	const handleOpenChange = (newOpen: boolean) => {
		if (!newOpen) {
			setSelectedVaultId("");
			setSearchQuery("");
		}
		onOpenChange(newOpen);
	};

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent className="max-w-md gap-0 overflow-hidden p-0">
				<DialogHeader className="px-5 pt-5 pb-3 text-left">
					<DialogTitle className="font-medium text-base">
						{m.vaults_detail_items_move_dialog_title({ title: item.title })}
					</DialogTitle>
				</DialogHeader>

				{/* Filtering stays manual by Vault name; Command only
				    provides keyboard navigation between vault rows. */}
				<Command shouldFilter={false} className="rounded-none bg-transparent">
					<CommandInput
						autoFocus
						value={searchQuery}
						onValueChange={setSearchQuery}
						placeholder={m.vaults_detail_items_move_dialog_search_placeholder()}
					/>

					<CommandList className="max-h-80 p-2">
						{isLoading ? (
							<div className="flex items-center justify-center py-10">
								<LoaderCircle className="size-6 animate-spin text-muted-foreground" />
							</div>
						) : vaultKeys.length <= 1 ? (
							<div className="py-10 text-center text-muted-foreground text-sm">
								{m.vaults_detail_items_move_dialog_empty_no_other_vaults()}
							</div>
						) : filteredVaultKeys.length === 0 ? (
							<div className="py-10 text-center text-muted-foreground text-sm">
								{m.vaults_detail_items_move_dialog_empty_no_matches()}
							</div>
						) : (
							filteredVaultKeys.map((vaultKey) => {
											const isCurrentVault =
												vaultKey.vaultId === currentVaultId;
											const isReadOnly = vaultKey.role === "read-only";
											const isSelected = vaultKey.vaultId === selectedVaultId;
											const isDisabled = isCurrentVault || isReadOnly;

											return (
												<CommandItem
													key={vaultKey.vaultId}
													value={vaultKey.vaultId}
													disabled={isDisabled}
													onSelect={() => {
														// Second select (Enter / double-click) on the
														// chosen vault confirms the move.
														if (
															isSelected &&
															!moveItem.isPending &&
															selectedVaultId
														) {
															void handleMove();
														} else {
															setSelectedVaultId(vaultKey.vaultId);
														}
													}}
													className={cn(
														"relative cursor-pointer gap-2.5 rounded-sm px-2.5 py-1.5 data-[selected=true]:bg-overlay",
														isSelected &&
															"bg-selected shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-primary)_14%,transparent)] data-[selected=true]:bg-selected",
													)}
												>
													{isSelected && (
														<span
															aria-hidden
															className="absolute top-[7px] bottom-[7px] left-1 w-0.5 rounded-full bg-primary shadow-[0_0_8px_color-mix(in_oklab,var(--color-primary)_80%,transparent)]"
														/>
													)}
													<VaultAvatar
														name={vaultKey.vaultName}
														icon={vaultKey.vaultIcon}
														imageUrl={vaultKey.vaultImageUrl}
														size="sm"
													/>
													<span className="min-w-0 flex-1 truncate text-left font-medium">
														{vaultKey.vaultName}
													</span>
													{isCurrentVault && (
														<span className="rounded-[4px] border bg-foreground/3 px-1.5 py-0.5 text-[10px] text-muted-foreground">
															{m.vaults_detail_items_move_dialog_badge_current()}
														</span>
													)}
													{isReadOnly && !isCurrentVault && (
														<span className="rounded-[4px] border bg-foreground/3 px-1.5 py-0.5 text-[10px] text-muted-foreground">
															{m.vaults_common_role_read_only()}
														</span>
													)}
													{isSelected && (
														<Check className="size-4 shrink-0 text-primary drop-shadow-[0_0_4px_var(--color-primary)]" />
													)}
												</CommandItem>
											);
							})
						)}
					</CommandList>
				</Command>

				<DialogFooter className="border-t p-4">
					<Button
						variant="outline"
						onClick={() => handleOpenChange(false)}
						disabled={moveItem.isPending}
					>
						{m.vaults_detail_items_detail_action_cancel()}
					</Button>
					<Button
						onClick={handleMove}
						disabled={!selectedVaultId || moveItem.isPending}
					>
						{moveItem.isPending ? (
							<>
								<LoaderCircle className="size-4 animate-spin" />
								{isCrossAccount
									? m.vaults_detail_items_move_dialog_action_transferring()
									: m.vaults_detail_items_move_dialog_action_moving()}
							</>
						) : isCrossAccount ? (
							m.vaults_detail_items_move_dialog_action_transfer()
						) : (
							m.vaults_detail_items_move_dialog_action_move()
						)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
