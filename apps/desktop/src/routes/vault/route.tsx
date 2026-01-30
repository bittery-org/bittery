import {
	type CreateVaultInput,
	useAccountMetadataSyncAll,
	useAllVaultKeys,
	useCreateItem,
	useCreateVault,
	useCrossVaultTags,
	useDeleteVault,
	useUpdateVault,
} from "@bittery/hooks";
import type { DecryptedItemData, ItemCategory } from "@bittery/shared/types";
import { toast } from "@bittery/ui";
import {
	createFileRoute,
	Outlet,
	redirect,
	useNavigate,
	useParams,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { storage } from "@/lib/storage";
import { CreateItemDialog } from "../../components/vault/create-item-dialog";
import type { AccountOption } from "../../components/vault/create-vault-dialog";
import { CreateVaultDialog } from "../../components/vault/create-vault-dialog";
import { DeleteVaultDialog } from "../../components/vault/delete-vault-dialog";
import { EditVaultDialog } from "../../components/vault/edit-vault-dialog";
import { ImportDialog } from "../../components/vault/import-dialog";
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
		// Check if user has stored credentials for active account
		const hasSecretKey = await storage.getStoredSecretKey(activeAccount.email);
		const sessionValid = await storage.isSessionValid(activeAccount.email);

		if (!hasSecretKey || !sessionValid) {
			throw redirect({ to: "/unlock", search: { email: activeAccount.email } });
		}

		const restored = await storage.tryRestoreSession(true, activeAccount.email);

		if (!restored) {
			throw redirect({ to: "/unlock", search: { email: activeAccount.email } });
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
	} | null>(null);
	const [isDeleteVaultDialogOpen, setIsDeleteVaultDialogOpen] = useState(false);
	const [deletingVault, setDeletingVault] = useState<{
		id: string;
		name: string;
	} | null>(null);
	const [isImportDialogOpen, setIsImportDialogOpen] = useState(false);
	const [importingVaultId, setImportingVaultId] = useState<string | null>(null);
	const [importingVaultAccountEmail, setImportingVaultAccountEmail] = useState<
		string | undefined
	>(undefined);
	const [availableAccounts, setAvailableAccounts] = useState<AccountOption[]>(
		[],
	);

	// Load available accounts for multi-account mode
	useEffect(() => {
		const loadAccounts = async () => {
			if (isAllAccountsMode) {
				const emails = await storage.getUnlockedAccounts?.();
				if (emails && emails.length > 0) {
					// Fetch metadata for each account
					const accounts = await Promise.all(
						emails.map(async (email) => {
							const metadata = await storage.getAccountMetadata?.(email);
							return {
								email,
								name: metadata?.name,
								teamName: metadata?.teamName,
							};
						}),
					);
					setAvailableAccounts(accounts);
				}
			}
		};
		loadAccounts();
	}, [isAllAccountsMode]);

	// Get all account emails for metadata sync
	const [accountEmails, setAccountEmails] = useState<string[]>([]);

	useEffect(() => {
		const getAccountEmails = async () => {
			const activeAccount = await storage.getActiveAccount();
			if (!activeAccount) {
				setAccountEmails([]);
				return;
			}

			if (activeAccount.type === "all") {
				// In "All Accounts" mode, sync all unlocked accounts
				const emails = await storage.getUnlockedAccounts?.();
				setAccountEmails(emails || []);
			} else {
				// Single account mode
				setAccountEmails([activeAccount.email]);
			}
		};
		getAccountEmails();
	}, []);

	// Sync account metadata for all accounts periodically
	// This keeps team avatar URLs up-to-date
	useAccountMetadataSyncAll({
		emails: accountEmails,
		enabled: accountEmails.length > 0,
		refetchInterval: 60000, // Check every minute
	});

	// Vault operation handlers
	const handleCreateVault = async (data: CreateVaultInput) => {
		try {
			// Determine accountEmail for new vault
			let accountEmail = data.accountEmail;

			// If no account email provided and we're not in all-accounts mode,
			// get the active account email
			if (!accountEmail && !isAllAccountsMode) {
				const activeAccount = await storage.getActiveAccount();
				if (activeAccount?.type === "single") {
					accountEmail = activeAccount.email;
				}
			}

			// If in all-accounts mode and no account selected, require selection
			if (isAllAccountsMode && !accountEmail) {
				toast.error("Please select an account for the new vault");
				throw new Error("Account selection required");
			}

			// Hook handles image upload internally if imageFile is provided
			const result = await createVaultMutation.mutateAsync({
				...data,
				accountEmail,
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

	const handleOpenEditVault = (vault: { id: string; name: string }) => {
		setEditingVault(vault);
		setIsEditVaultDialogOpen(true);
	};

	const handleUpdateVault = async (vaultId: string, name: string) => {
		try {
			// Find the vault to get its account email
			const vault = vaultKeys?.find((v) => v.vaultId === vaultId);
			const accountEmail =
				vault && "accountEmail" in vault ? vault.accountEmail : undefined;

			await updateVaultMutation.mutateAsync({
				vaultId,
				name,
				accountEmail,
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
			const accountEmail =
				vault && "accountEmail" in vault ? vault.accountEmail : undefined;

			await deleteVaultMutation.mutateAsync({
				vaultId,
				accountEmail,
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
			const accountEmail =
				vault && "accountEmail" in vault ? vault.accountEmail : undefined;

			const result = await createItemMutation.mutateAsync({
				vaultId,
				category,
				data,
				accountEmail,
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

	const handleOpenImportDialog = (vaultId: string) => {
		// Find the vault to get its account email
		const vault = vaultKeys?.find((v) => v.vaultId === vaultId);
		const accountEmail =
			vault && "accountEmail" in vault ? vault.accountEmail : undefined;

		setImportingVaultId(vaultId);
		setImportingVaultAccountEmail(accountEmail);
		setIsImportDialogOpen(true);
	};

	return (
		<VaultDndProvider>
			<div className="flex h-screen flex-col overflow-hidden">
				<VaultHeader
					hasVaults={!!vaultKeys?.length}
					onNewItemClick={() => setIsNewItemDialogOpen(true)}
				/>

				<div className="flex flex-1 overflow-hidden">
					<VaultSidebar
						vaults={vaultKeys || []}
						tags={crossVaultTags}
						currentVaultId={params.id}
						onNewVault={() => setIsNewVaultDialogOpen(true)}
						onEditVault={handleOpenEditVault}
						onDeleteVault={handleOpenDeleteVault}
						onImportItems={handleOpenImportDialog}
					/>

					<div className="flex h-full flex-1 flex-col">
						<div className="flex flex-1 overflow-hidden">
							<Outlet />
						</div>
					</div>
				</div>

				{/* New Item Dialog */}
				<CreateItemDialog
					open={isNewItemDialogOpen}
					onOpenChange={setIsNewItemDialogOpen}
					vaults={
						vaultKeys?.map((v) => ({
							id: v.vaultId,
							name: v.vaultName,
							type: v.vaultType as "personal" | "team",
							accountEmail: "accountEmail" in v ? v.accountEmail : undefined,
							accountName: "accountName" in v ? v.accountName : undefined,
							accountTeamName:
								"accountTeamName" in v ? v.accountTeamName : undefined,
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

				{importingVaultId && (
					<ImportDialog
						vaultId={importingVaultId}
						accountEmail={importingVaultAccountEmail}
						open={isImportDialogOpen}
						onOpenChange={(open) => {
							setIsImportDialogOpen(open);
							if (!open) {
								setImportingVaultId(null);
								setImportingVaultAccountEmail(undefined);
							}
						}}
					/>
				)}
			</div>
		</VaultDndProvider>
	);
}
