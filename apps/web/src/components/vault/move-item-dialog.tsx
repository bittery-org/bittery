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
import type { RuntimeVaultOption } from "@bittery/ui/runtime-presentation";
import { useMemo, useState } from "react";
import { useRuntimeItems } from "@/hooks/use-runtime-items";
import { useI18n } from "@/providers/i18n-provider";

export function MoveItemDialog({
	open,
	onOpenChange,
	item,
	currentVaultId,
	isMoving,
	onMove,
}: MoveItemDialogProps & {
	isMoving: boolean;
	onMove: (target: RuntimeVaultOption) => Promise<void>;
}) {
	const { m } = useI18n();
	const [selectedVaultId, setSelectedVaultId] = useState<string>("");
	const [searchQuery, setSearchQuery] = useState("");
	// Runtime projections are already scoped to the explicit active Account.
	const runtimeItems = useRuntimeItems();
	const vaults = runtimeItems.vaults;
	const isLoading = open && runtimeItems.state === "loading";
	const filteredVaults = useMemo(() => {
		if (!searchQuery.trim()) return vaults;
		const query = searchQuery.toLowerCase();
		return vaults.filter((vault) => vault.name.toLowerCase().includes(query));
	}, [vaults, searchQuery]);

	const selectedVault = useMemo(() => {
		return vaults.find((vault) => vault.id === selectedVaultId);
	}, [vaults, selectedVaultId]);

	const handleMove = async () => {
		if (!selectedVaultId) {
			toast.error(m.vaults_detail_items_move_dialog_toast_select_vault());
			return;
		}
		if (!selectedVault) {
			toast.error(m.vaults_detail_items_move_dialog_toast_error());
			return;
		}
		await onMove(selectedVault);
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
						) : vaults.length <= 1 ? (
							<div className="py-10 text-center text-muted-foreground text-sm">
								{m.vaults_detail_items_move_dialog_empty_no_other_vaults()}
							</div>
						) : filteredVaults.length === 0 ? (
							<div className="py-10 text-center text-muted-foreground text-sm">
								{m.vaults_detail_items_move_dialog_empty_no_matches()}
							</div>
						) : (
							filteredVaults.map((vault) => {
								const isCurrentVault = vault.id === currentVaultId;
								const isReadOnly = vault.role === "read-only";
								const isSelected = vault.id === selectedVaultId;
								const isDisabled = isCurrentVault || isReadOnly;

								return (
									<CommandItem
										key={vault.id}
										value={vault.id}
										disabled={isDisabled}
										onSelect={() => {
											// Second select (Enter / double-click) on the
											// chosen vault confirms the move.
											if (isSelected && !isMoving && selectedVaultId) {
												void handleMove();
											} else {
												setSelectedVaultId(vault.id);
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
											name={vault.name}
											icon={vault.icon}
											imageUrl={vault.imageUrl}
											size="sm"
										/>
										<span className="min-w-0 flex-1 truncate text-left font-medium">
											{vault.name}
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
						disabled={isMoving}
					>
						{m.vaults_detail_items_detail_action_cancel()}
					</Button>
					<Button onClick={handleMove} disabled={!selectedVaultId || isMoving}>
						{isMoving ? (
							<>
								<LoaderCircle className="size-4 animate-spin" />
								{m.vaults_detail_items_move_dialog_action_moving()}
							</>
						) : (
							m.vaults_detail_items_move_dialog_action_move()
						)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
