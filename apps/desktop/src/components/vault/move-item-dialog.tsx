import { useAllVaultKeys, useMoveItem } from "@bittery/hooks";
import type { DecryptedItem } from "@bittery/shared/types";
import {
	Avatar,
	AvatarFallback,
	AvatarImage,
	Button,
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Input,
	toast,
} from "@bittery/ui";
import { cn } from "@bittery/ui/lib/utils";
import { useNavigate } from "@tanstack/react-router";
import { Check, Loader2, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { VaultAvatar } from "./vault-avatar";

function getInitials(name: string): string {
	if (!name) return "??";
	const parts = name.trim().split(/\s+/);
	if (parts.length >= 2) {
		return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
	}
	return name.slice(0, 2).toUpperCase();
}

interface MoveItemDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	item: DecryptedItem;
	currentVaultId: string;
}

export function MoveItemDialog({
	open,
	onOpenChange,
	item,
	currentVaultId,
}: MoveItemDialogProps) {
	const [selectedVaultId, setSelectedVaultId] = useState<string>("");
	const [searchQuery, setSearchQuery] = useState("");
	const { vaultKeys, isLoading, isAllAccountsMode } = useAllVaultKeys();
	const moveItem = useMoveItem();
	const navigate = useNavigate();

	// Find the current vault's account email
	const currentVaultAccount = useMemo(() => {
		const currentVault = vaultKeys.find((vk) => vk.vaultId === currentVaultId);
		return currentVault?.accountEmail;
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

	// Group vaults by account in multi-account mode for better UX
	// Includes all vaults (current vault will be shown as disabled)
	const vaultsByAccount = useMemo(() => {
		if (!isAllAccountsMode) {
			return { single: filteredVaultKeys };
		}

		const grouped: Record<string, typeof filteredVaultKeys> = {};
		for (const vault of filteredVaultKeys) {
			const accountKey = vault.accountEmail || "unknown";
			if (!grouped[accountKey]) {
				grouped[accountKey] = [];
			}
			grouped[accountKey].push(vault);
		}
		return grouped;
	}, [filteredVaultKeys, isAllAccountsMode]);

	// Check if selected vault is in a different account
	const selectedVault = useMemo(() => {
		return vaultKeys.find((vk) => vk.vaultId === selectedVaultId);
	}, [vaultKeys, selectedVaultId]);

	const isCrossAccount = useMemo(() => {
		if (!selectedVault || !isAllAccountsMode) return false;
		return selectedVault.accountEmail !== currentVaultAccount;
	}, [selectedVault, currentVaultAccount, isAllAccountsMode]);

	const handleMove = async () => {
		if (!selectedVaultId) {
			toast.error("Please select a vault");
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
				targetAccountEmail: selectedVault?.accountEmail,
			});

			if (result.crossAccount) {
				toast.success(
					"Item transferred to other account successfully. A new copy was created in the target vault and the original was deleted.",
				);
			} else {
				toast.success("Item moved successfully");
			}

			onOpenChange(false);

			// Navigate to the item in the target vault
			// For cross-account transfers, use the new item ID
			const targetItemId = result.newItemId || item.id;
			navigate({
				to: "/vault/$id/$itemId",
				params: { id: selectedVaultId, itemId: targetItemId },
			});
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : "Failed to move item";
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
			<DialogContent className="max-w-md gap-0 p-0">
				<DialogHeader className="p-6 pb-4">
					<DialogTitle className="font-medium text-base">
						Move "{item.title}" to a different vault
					</DialogTitle>
				</DialogHeader>

				{/* Search */}
				<div className="px-6 pb-3">
					<div className="relative">
						<Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
						<Input
							placeholder="Search vaults..."
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
							className="pl-9"
						/>
					</div>
				</div>

				{/* Vault List */}
				<div className="px-3 pb-3">
					{isLoading ? (
						<div className="flex items-center justify-center py-8">
							<Loader2 className="size-6 animate-spin text-muted-foreground" />
						</div>
					) : vaultKeys.length <= 1 ? (
						<div className="py-8 text-center text-muted-foreground text-sm">
							No other vaults available
						</div>
					) : filteredVaultKeys.length === 0 ? (
						<div className="py-8 text-center text-muted-foreground text-sm">
							No vaults match your search
						</div>
					) : (
						<div className="max-h-80 space-y-1 overflow-y-auto">
							{isAllAccountsMode ? (
								// Multi-account mode: group by account
								Object.entries(vaultsByAccount).map(
									([accountEmail, vaults]) => {
										if (vaults.length === 0) return null;

										const accountName =
											vaults[0].accountTeamName ||
											vaults[0].accountName ||
											accountEmail;
										const accountTeamAvatarUrl =
											vaults[0].accountTeamAvatarUrl;

										return (
											<div key={accountEmail} className="py-1">
												<div className="flex items-center gap-2 px-3 py-2 font-medium text-muted-foreground text-xs uppercase tracking-wide">
													<Avatar className="size-5 text-[10px]">
														<AvatarImage
															src={accountTeamAvatarUrl ?? undefined}
															alt={accountName}
														/>
														<AvatarFallback className="text-[10px]">
															{getInitials(accountName)}
														</AvatarFallback>
													</Avatar>
													<span>{accountName}</span>
												</div>
												<div className="ml-4 space-y-0.5">
													{vaults.map((vaultKey) => {
														const isCurrentVault =
															vaultKey.vaultId === currentVaultId;
														const isSelected =
															vaultKey.vaultId === selectedVaultId;
														const isDisabled =
															isCurrentVault || vaultKey.role === "read-only";

														return (
															<button
																type="button"
																key={vaultKey.vaultId}
																disabled={isDisabled}
																onClick={() =>
																	!isDisabled &&
																	setSelectedVaultId(vaultKey.vaultId)
																}
																className={cn(
																	"flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm outline-none transition-colors",
																	isSelected &&
																		!isDisabled &&
																		"bg-primary/10 ring-1 ring-primary/20",
																	!isDisabled &&
																		!isSelected &&
																		"hover:bg-accent",
																	isDisabled && "cursor-not-allowed opacity-50",
																)}
															>
																<VaultAvatar
																	name={vaultKey.vaultName}
																	icon={vaultKey.vaultIcon}
																	imageUrl={vaultKey.vaultImageUrl}
																	size="sm"
																/>
																<span className="flex-1 text-left font-medium">
																	{vaultKey.vaultName}
																</span>
																{isCurrentVault && (
																	<span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground text-xs">
																		Current
																	</span>
																)}
																{isSelected && !isDisabled && (
																	<div className="flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
																		<Check className="size-3" />
																	</div>
																)}
															</button>
														);
													})}
												</div>
											</div>
										);
									},
								)
							) : (
								// Single-account mode: simple list with current vault included
								filteredVaultKeys.map((vaultKey) => {
									const isCurrentVault = vaultKey.vaultId === currentVaultId;
									const isSelected = vaultKey.vaultId === selectedVaultId;
									const isDisabled =
										isCurrentVault || vaultKey.role === "read-only";

									return (
										<button
											type="button"
											key={vaultKey.vaultId}
											disabled={isDisabled}
											onClick={() =>
												!isDisabled && setSelectedVaultId(vaultKey.vaultId)
											}
											className={cn(
												"flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm outline-none transition-colors",
												isSelected &&
													!isDisabled &&
													"bg-primary/10 ring-1 ring-primary/20",
												!isDisabled && !isSelected && "hover:bg-accent",
												isDisabled && "cursor-not-allowed opacity-50",
											)}
										>
											<VaultAvatar
												name={vaultKey.vaultName}
												icon={vaultKey.vaultIcon}
												imageUrl={vaultKey.vaultImageUrl}
												size="sm"
											/>
											<span className="flex-1 text-left font-medium">
												{vaultKey.vaultName}
											</span>
											{isCurrentVault && (
												<span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground text-xs">
													Current
												</span>
											)}
											{isSelected && !isDisabled && (
												<div className="flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
													<Check className="size-3" />
												</div>
											)}
										</button>
									);
								})
							)}
						</div>
					)}
				</div>

				{/* Cross-account warning */}
				{isCrossAccount && selectedVault && (
					<div className="mx-6 mb-3 rounded-lg bg-amber-500/10 px-3 py-2.5 text-amber-600 text-sm dark:text-amber-500">
						This will transfer the item to a different account. A new copy will
						be created and the original deleted.
					</div>
				)}

				<DialogFooter className="border-t p-4">
					<Button
						variant="outline"
						onClick={() => handleOpenChange(false)}
						disabled={moveItem.isPending}
					>
						Cancel
					</Button>
					<Button
						onClick={handleMove}
						disabled={!selectedVaultId || moveItem.isPending}
					>
						{moveItem.isPending ? (
							<>
								<Loader2 className="mr-2 size-4 animate-spin" />
								{isCrossAccount ? "Transferring..." : "Moving..."}
							</>
						) : isCrossAccount ? (
							"Transfer"
						) : (
							"Move"
						)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
