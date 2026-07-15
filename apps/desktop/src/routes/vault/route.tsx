import {
	type CreateVaultInput,
	useAccountMetadataSyncAll,
	useAllVaultKeys,
	useCreateItem,
	useCreateVault,
	useCrossVaultTags,
	useDeleteVault,
	useUpdateVault,
} from "@bittery/core/hooks";
import { getAccountSessionManager } from "@bittery/core/services/account-session-manager";
import type { DecryptedItemData, ItemCategory } from "@bittery/shared/types";
import { CreateItemSheet, toast } from "@bittery/ui";
import { useQuery } from "@tanstack/react-query";
import {
	createFileRoute,
	Outlet,
	redirect,
	useNavigate,
	useParams,
} from "@tanstack/react-router";
import { useState } from "react";
import { storage } from "@/lib/storage";
import type { AccountOption } from "../../components/vault/create-vault-dialog";
import { CreateVaultDialog } from "../../components/vault/create-vault-dialog";
import { DeleteVaultDialog } from "../../components/vault/delete-vault-dialog";
import { EditVaultDialog } from "../../components/vault/edit-vault-dialog";
import { VaultHeader } from "../../components/vault/vault-header";
import { VaultSidebar } from "../../components/vault/vault-sidebar";
import { VaultDndProvider } from "../../providers/dnd-provider";

export const Route = createFileRoute("/vault")({
	component: RouteComponent,
	beforeLoad: async () => {
		// Get active account
		const activeAccount = await storage.getActiveAccount();
		if (!activeAccount) {
			throw redirect({ to: "/login" });
		}

		// Handle "All Accounts" mode specially
		if (activeAccount.type === "all") {
			// Check if we have any unlocked accounts
			const unlockedAccounts = await storage.getUnlockedAccounts?.();
			if (!unlockedAccounts || unlockedAccounts.length === 0) {
				// No unlocked accounts, redirect to unlock
				throw redirect({ to: "/unlock" });
			}
			// At least one account is unlocked, allow access
			return;
		}

		// Single account mode: validate session for specific account
		const accountsList = await storage.getAccountsList();
		const activeAccountEmail = accountsList.find(
			(account) => account.accountId === activeAccount.accountId,
		)?.email;

		// Check if user has stored credentials for active account
		const hasSecretKey = await storage.getStoredSecretKey(
			activeAccount.accountId,
		);
		const sessionValid = await storage.isSessionValid(activeAccount.accountId);

		if (!hasSecretKey || !sessionValid) {
			throw redirect({
				to: "/unlock",
				search: activeAccountEmail ? { email: activeAccountEmail } : undefined,
			});
		}

		const restored = await getAccountSessionManager({ storage }).unlockAccount(
			activeAccount.accountId,
			true,
		);

		if (!restored) {
			throw redirect({
				to: "/unlock",
				search: activeAccountEmail ? { email: activeAccountEmail } : undefined,
			});
		}
	},
});

function RouteComponent() {
	// Fetch all vault keys with account metadata
	// Automatically handles single-account vs "All Accounts" mode
	const { vaultKeys, isAllAccountsMode } = useAllVaultKeys();

	// Get cross-vault tags for sidebar
	const { tags: crossVaultTags } = useCrossVaultTags();

	const params = useParams({ strict: false });
	const navigate = useNavigate();

	// Shared hooks for vault and item operations
	const createVaultMutation = useCreateVault();
	const updateVaultMutation = useUpdateVault();
	const deleteVaultMutation = useDeleteVault();
	const createItemMutation = useCreateItem();

	const [isNewItemDialogOpen, setIsNewItemDialogOpen] = useState(false);
	const [isNewVaultDialogOpen, setIsNewVaultDialogOpen] = useState(false);
	const [isEditVaultDialogOpen, setIsEditVaultDialogOpen] = useState(false);
	const [editingVault, setEditingVault] = useState<{
		id: string;
		name: string;
		icon?: string | null;
		imageUrl?: string | null;
	} | null>(null);
	const [isDeleteVaultDialogOpen, setIsDeleteVaultDialogOpen] = useState(false);
	const [deletingVault, setDeletingVault] = useState<{
		id: string;
		name: string;
	} | null>(null);
	const availableAccountsQuery = useQuery({
		queryKey: ["vault-route", "available-accounts", isAllAccountsMode],
		enabled: isAllAccountsMode,
		queryFn: async (): Promise<AccountOption[]> => {
			const accountIds = await storage.getUnlockedAccounts?.();
			if (!accountIds?.length) {
				return [];
			}

			return await Promise.all(
				accountIds.map(async (accountId) => {
					const metadata = await storage.getAccountMetadata?.(accountId);
					return {
						accountId,
						email: metadata?.email ?? accountId,
						name: metadata?.name,
						teamName: metadata?.teamName,
					};
				}),
			);
		},
	});
	const availableAccounts = availableAccountsQuery.data ?? [];
	const accountIdsQuery = useQuery({
		queryKey: ["vault-route", "account-ids"],
		queryFn: async () => {
			const activeAccount = await storage.getActiveAccount();
			if (!activeAccount) {
				return [];
			}

			if (activeAccount.type === "all") {
				return (await storage.getUnlockedAccounts?.()) ?? [];
			}
			return [activeAccount.accountId];
		},
	});
	const accountIds = accountIdsQuery.data ?? [];

	// Sync account metadata for all accounts periodically
	// This keeps team avatar URLs up-to-date
	useAccountMetadataSyncAll({
		accountIds,
		enabled: accountIds.length > 0,
		refetchInterval: 60000, // Check every minute
	});

	// Vault operation handlers
	const handleCreateVault = async (data: CreateVaultInput) => {
		try {
			let accountId = data.accountId;

			// If no account email provided and we're not in all-accounts mode,
			// get the active account email
			if (!accountId && !isAllAccountsMode) {
				const activeAccount = await storage.getActiveAccount();
				if (activeAccount?.type === "single") {
					accountId = activeAccount.accountId;
				}
			}

			// If in all-accounts mode and no account selected, require selection
			if (isAllAccountsMode && !accountId) {
				toast.error("Please select an account for the new vault");
				throw new Error("Account selection required");
			}

			// Hook handles image upload internally if imageFile is provided
			const result = await createVaultMutation.mutateAsync({
				...data,
				accountId,
			});

			toast.success("Vault created successfully");
			navigate({ to: "/vault/$id", params: { id: result.vaultId } });
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : "Failed to create vault";
			toast.error(errorMessage);
			throw error;
		}
	};

	const handleOpenEditVault = (vault: {
		id: string;
		name: string;
		icon?: string | null;
		imageUrl?: string | null;
	}) => {
		setEditingVault(vault);
		setIsEditVaultDialogOpen(true);
	};

	const handleUpdateVault = async (
		vaultId: string,
		data: {
			name: string;
			icon?: string | null;
			imageFile?: File;
			removeImage?: boolean;
		},
	) => {
		try {
			// Find the vault to get its account email
			const vault = vaultKeys?.find((v) => v.vaultId === vaultId);
			const accountId = vault?.accountId;
			if (!accountId) throw new Error();

			await updateVaultMutation.mutateAsync({
				vaultId,
				name: data.name,
				icon: data.icon,
				imageFile: data.imageFile,
				removeImage: data.removeImage,
				accountId,
			});
			setEditingVault(null);
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : "Failed to update vault";
			toast.error(errorMessage);
			throw error;
		}
	};

	const handleOpenDeleteVault = (vault: { id: string; name: string }) => {
		setDeletingVault(vault);
		setIsDeleteVaultDialogOpen(true);
	};

	const handleDeleteVault = async (vaultId: string) => {
		try {
			// Find the vault to get its account email
			const vault = vaultKeys?.find((v) => v.vaultId === vaultId);
			const accountId = vault?.accountId;
			if (!accountId) throw new Error();

			await deleteVaultMutation.mutateAsync({
				vaultId,
				accountId,
			});
			setDeletingVault(null);

			if (params.id === vaultId) {
				navigate({ to: "/vault" });
			}

			toast.success("Vault deleted successfully");
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : "Failed to delete vault";
			toast.error(errorMessage);
			throw error;
		}
	};

	// Item operation handlers
	const handleCreateItem = async (
		data: DecryptedItemData,
		vaultId: string,
		category: ItemCategory,
	) => {
		try {
			// Find the vault to get its account email
			const vault = vaultKeys?.find((v) => v.vaultId === vaultId);
			const accountId = vault?.accountId;
			if (!accountId) throw new Error();

			const result = await createItemMutation.mutateAsync({
				vaultId,
				category,
				data,
				accountId,
			});

			// Close dialog
			setIsNewItemDialogOpen(false);

			// Navigate to the newly created item
			navigate({
				to: "/vault/$id/$itemId",
				params: { id: vaultId, itemId: result.itemId },
			});

			toast.success("Item created successfully");
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : "Failed to create item";
			toast.error(errorMessage);
			throw error;
		}
	};

	return (
		<VaultDndProvider>
			<div className="flex h-screen overflow-hidden">
				<VaultSidebar
					vaults={vaultKeys || []}
					tags={crossVaultTags}
					currentVaultId={params.id}
					onNewVault={() => setIsNewVaultDialogOpen(true)}
					onEditVault={handleOpenEditVault}
					onDeleteVault={handleOpenDeleteVault}
				/>

				<div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
					<VaultHeader
						hasVaults={!!vaultKeys?.length}
						onNewItemClick={() => setIsNewItemDialogOpen(true)}
					/>
					<div className="flex min-w-0 flex-1 overflow-hidden">
						<Outlet />
					</div>
				</div>

				{/* New Item Sheet */}
				<CreateItemSheet
					open={isNewItemDialogOpen}
					onOpenChange={setIsNewItemDialogOpen}
					vaults={
						vaultKeys?.map((v) => ({
							id: v.vaultId,
							name: v.vaultName,
							type: v.vaultType as "personal" | "team",
							icon: v.vaultIcon,
							imageUrl: v.vaultImageUrl,
							accountId: v.accountId,
							accountEmail: "accountEmail" in v ? v.accountEmail : undefined,
							accountName: "accountName" in v ? v.accountName : undefined,
							accountTeamName:
								"accountTeamName" in v ? v.accountTeamName : undefined,
							accountTeamAvatarUrl:
								"accountTeamAvatarUrl" in v
									? v.accountTeamAvatarUrl
									: undefined,
						})) || []
					}
					selectedVaultId={params.id}
					onCreateItem={(data, vaultId, category) =>
						handleCreateItem(data, vaultId, category)
					}
				/>

				<CreateVaultDialog
					open={isNewVaultDialogOpen}
					onOpenChange={setIsNewVaultDialogOpen}
					onSubmit={handleCreateVault}
					accounts={isAllAccountsMode ? availableAccounts : undefined}
				/>

				<EditVaultDialog
					key={editingVault?.id || "edit-vault-dialog"}
					open={isEditVaultDialogOpen}
					onOpenChange={(open) => {
						setIsEditVaultDialogOpen(open);
						if (!open) {
							setEditingVault(null);
						}
					}}
					vault={editingVault}
					onSubmit={handleUpdateVault}
				/>

				<DeleteVaultDialog
					open={isDeleteVaultDialogOpen}
					onOpenChange={(open) => {
						setIsDeleteVaultDialogOpen(open);
						if (!open) {
							setDeletingVault(null);
						}
					}}
					vault={deletingVault}
					onConfirm={handleDeleteVault}
				/>
			</div>
		</VaultDndProvider>
	);
}
