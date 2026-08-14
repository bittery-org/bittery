import { useMoveItem, useMoveTargetVaults } from "@bittery/core/hooks";
import {
	Avatar,
	AvatarFallback,
	AvatarImage,
	Button,
	Command,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
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
	IconCheck,
	IconLoaderCircle,
	IconTriangleAlert,
} from "@bittery/ui/icons";
import { cn, getInitials } from "@bittery/ui/lib/utils";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useI18n } from "../../providers/i18n-provider";

export function MoveItemDialog({
	open,
	onOpenChange,
	item,
	currentVaultId,
}: MoveItemDialogProps) {
	const { m } = useI18n();
	const [selectedVaultId, setSelectedVaultId] = useState<string>("");
	const [searchQuery, setSearchQuery] = useState("");
	// Only resolve/hydrate cross-account move targets while the dialog is open;
	// the dialog stays mounted with the item detail page, so an unconditional
	// call would hydrate every unlocked account's repo on every item view.
	const { vaultKeys, isLoading } = useMoveTargetVaults({ enabled: open });
	const moveItem = useMoveItem();
	const navigate = useNavigate();

	// Find the account that owns the current vault. Used to detect cross-account targets.
	const currentVaultAccountId = useMemo(() => {
		const currentVault = vaultKeys.find((vk) => vk.vaultId === currentVaultId);
		return currentVault?.accountId;
	}, [vaultKeys, currentVaultId]);

	// Filter vaults by search query
	const filteredVaultKeys = useMemo(() => {
		if (!searchQuery.trim()) return vaultKeys;
		const query = searchQuery.toLowerCase();
		return vaultKeys.filter(
			(vk) =>
				vk.vaultName.toLowerCase().includes(query) ||
				vk.accountName?.toLowerCase().includes(query) ||
				vk.accountTeamName?.toLowerCase().includes(query),
		);
	}, [vaultKeys, searchQuery]);

	// Group vaults by account. Move targets are surfaced across every unlocked
	// account, so the list is always account-grouped (the current vault is
	// rendered disabled).
	const vaultsByAccount = useMemo(() => {
		const grouped: Record<string, typeof filteredVaultKeys> = {};
		for (const vault of filteredVaultKeys) {
			const accountKey = vault.accountId;
			if (!grouped[accountKey]) {
				grouped[accountKey] = [];
			}
			grouped[accountKey].push(vault);
		}
		return grouped;
	}, [filteredVaultKeys]);

	// Check if selected vault is in a different account
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
			// Extract decrypted data from the item (exclude metadata fields)
			const {
				id,
				vaultId,
				category,
				favorite,
				createdAt,
				updatedAt,
				...decryptedData
			} = item;

			const result = await moveItem.mutateAsync({
				itemId: item.id,
				sourceVaultId: currentVaultId,
				targetVaultId: selectedVaultId,
				category: item.category,
				decryptedData,
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
				to: "/vault/$id/$itemId",
				params: { id: selectedVaultId, itemId: item.id },
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

				{/* Filtering stays manual (name + account/team match), Command only
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
								<IconLoaderCircle className="size-6 animate-spin text-muted-foreground" />
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
							/* Move targets are always account-grouped so cross-account
							   targets are surfaced regardless of active-account view. */
							Object.entries(vaultsByAccount).map(([accountId, vaults]) => {
								const [firstVault] = vaults;
								if (!firstVault) return null;

								const accountName =
									firstVault.accountTeamName ||
									firstVault.accountName ||
									firstVault.accountEmail ||
									m.vaults_detail_items_move_dialog_account_unknown();
								const accountTeamAvatarUrl = firstVault.accountTeamAvatarUrl;

								return (
									<CommandGroup key={accountId} className="p-0 pb-1">
										<div className="flex items-center gap-2 px-2.5 py-2">
											<Avatar className="size-5 rounded-[5px]">
												<AvatarImage
													src={accountTeamAvatarUrl ?? undefined}
													alt={accountName}
													className="rounded-[5px]"
												/>
												<AvatarFallback className="rounded-[5px] bg-linear-to-br from-primary to-primary-deep font-semibold text-[9px] text-primary-foreground shadow-[inset_0_0_0_1px_oklch(1_0_0/0.15)]">
													{getInitials(accountName)}
												</AvatarFallback>
											</Avatar>
											<span className="truncate font-semibold text-[10.5px] text-muted-foreground uppercase tracking-[0.06em]">
												{accountName}
											</span>
										</div>

										{vaults.map((vaultKey) => {
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
														<IconCheck className="size-4 shrink-0 text-primary drop-shadow-[0_0_4px_var(--color-primary)]" />
													)}
												</CommandItem>
											);
										})}
									</CommandGroup>
								);
							})
						)}
					</CommandList>
				</Command>

				{/* Cross-account warning */}
				{isCrossAccount && selectedVault && (
					<div className="mx-4 mb-3 flex items-start gap-2.5 rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2.5 text-amber-600 text-sm dark:text-amber-400">
						<IconTriangleAlert className="mt-0.5 size-4 shrink-0" />
						<span>
							{m.vaults_detail_items_move_dialog_warning_cross_account()}
						</span>
					</div>
				)}

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
								<IconLoaderCircle className="size-4 animate-spin" />
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
