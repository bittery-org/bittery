import { useAllVaultKeys, useMoveItem } from "@bittery/hooks";
import type { DecryptedItem } from "@bittery/shared/types";
import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Label,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	toast,
} from "@bittery/ui";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRight, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { VaultAvatar } from "./vault-avatar";

interface MoveItemDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	item: DecryptedItem;
	currentVaultId: string;
	currentVaultName?: string;
}

export function MoveItemDialog({
	open,
	onOpenChange,
	item,
	currentVaultId,
	currentVaultName,
}: MoveItemDialogProps) {
	const [selectedVaultId, setSelectedVaultId] = useState<string>("");
	const { vaultKeys, isLoading, isAllAccountsMode } = useAllVaultKeys();
	const moveItem = useMoveItem();
	const navigate = useNavigate();

	// Find the current vault's account email
	const currentVaultAccount = useMemo(() => {
		const currentVault = vaultKeys.find((vk) => vk.vaultId === currentVaultId);
		return currentVault?.accountEmail;
	}, [vaultKeys, currentVaultId]);

	// Get available vaults that can be selected (exclude current vault and read-only vaults)
	// Now supports cross-account transfers in multi-account mode!
	const availableVaults = useMemo(() => {
		return vaultKeys.filter((vk) => {
			// Skip current vault
			if (vk.vaultId === currentVaultId) return false;
			// Skip read-only vaults
			if (vk.role === "read-only") return false;
			return true;
		});
	}, [vaultKeys, currentVaultId]);

	// Group vaults by account in multi-account mode for better UX
	const vaultsByAccount = useMemo(() => {
		if (!isAllAccountsMode) {
			return { single: availableVaults };
		}

		const grouped: Record<string, typeof availableVaults> = {};
		for (const vault of availableVaults) {
			const accountKey = vault.accountEmail || "unknown";
			if (!grouped[accountKey]) {
				grouped[accountKey] = [];
			}
			grouped[accountKey].push(vault);
		}
		return grouped;
	}, [availableVaults, isAllAccountsMode]);

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
		}
		onOpenChange(newOpen);
	};

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>
						{isCrossAccount ? "Transfer Item" : "Move Item"}
					</DialogTitle>
					<DialogDescription>
						{isCrossAccount
							? `Transfer "${item.title}" to a different account. A new copy will be created in the target vault and the original will be deleted.`
							: `Move "${item.title}" to a different vault`}
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4 py-4">
					{/* Current Vault */}
					<div className="space-y-2">
						<Label className="text-muted-foreground text-sm">From</Label>
						<div className="flex items-center gap-2 rounded-md border border-input bg-muted px-3 py-2">
							<VaultAvatar name={currentVaultName || "Vault"} size="xs" />
							<span className="text-sm">
								{currentVaultName || "Current Vault"}
							</span>
						</div>
					</div>

					<div className="flex justify-center">
						<ArrowRight className="size-5 text-muted-foreground" />
					</div>

					{/* Target Vault Selection */}
					<div className="space-y-2">
						<Label htmlFor="target-vault">To</Label>
						{isLoading ? (
							<div className="flex items-center justify-center py-8">
								<Loader2 className="size-6 animate-spin text-muted-foreground" />
							</div>
						) : availableVaults.length === 0 ? (
							<div className="py-4 text-center text-muted-foreground text-sm">
								No other vaults available
							</div>
						) : (
							<Select
								value={selectedVaultId}
								onValueChange={setSelectedVaultId}
							>
								<SelectTrigger id="target-vault">
									<SelectValue placeholder="Select a vault" />
								</SelectTrigger>
								<SelectContent>
									{isAllAccountsMode
										? // Multi-account mode: group by account
											Object.entries(vaultsByAccount).map(
												([accountEmail, vaults]) => {
													if (vaults.length === 0) return null;

													const accountName =
														vaults[0].accountName || accountEmail;
													const isCurrentAccount =
														accountEmail === currentVaultAccount;

													return (
														<div key={accountEmail}>
															<div className="px-2 py-1.5 font-semibold text-muted-foreground text-xs">
																{accountName}
																{isCurrentAccount && " (current)"}
															</div>
															{vaults.map((vaultKey) => (
																<SelectItem
																	key={vaultKey.vaultId}
																	value={vaultKey.vaultId}
																>
																	<div className="flex items-center gap-2">
																		<VaultAvatar
																			name={vaultKey.vaultName}
																			icon={vaultKey.vaultIcon}
																			imageUrl={vaultKey.vaultImageUrl}
																			size="xs"
																		/>
																		<span>{vaultKey.vaultName}</span>
																	</div>
																</SelectItem>
															))}
														</div>
													);
												},
											)
										: // Single-account mode: simple list
											availableVaults.map((vaultKey) => (
												<SelectItem
													key={vaultKey.vaultId}
													value={vaultKey.vaultId}
												>
													<div className="flex items-center gap-2">
														<VaultAvatar
															name={vaultKey.vaultName}
															icon={vaultKey.vaultIcon}
															imageUrl={vaultKey.vaultImageUrl}
															size="xs"
														/>
														<span>{vaultKey.vaultName}</span>
													</div>
												</SelectItem>
											))}
								</SelectContent>
							</Select>
						)}
					</div>

					{/* Show account info for selected vault in multi-account mode */}
					{isAllAccountsMode && selectedVault && (
						<div className="rounded-md bg-muted px-3 py-2 text-sm">
							<span className="text-muted-foreground">Target account: </span>
							<span className="font-medium">
								{selectedVault.accountName || selectedVault.accountEmail}
							</span>
							{isCrossAccount && (
								<span className="ml-2 text-amber-600 text-xs dark:text-amber-500">
									(different account - will transfer)
								</span>
							)}
						</div>
					)}
				</div>

				<DialogFooter>
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
