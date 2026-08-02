import {
	type CreateVaultInput,
	useAccountMetadataSyncAll,
	useAllVaultKeys,
	useCreateItem,
	useCreateVault,
	useCrossVaultTags,
	useDeleteVault,
	useItemCounts,
	useItems,
	useUpdateVault,
} from "@bittery/core/hooks";
import { peekAccountSessionManager } from "@bittery/core/services/account-session-manager";
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
import { useState, useSyncExternalStore } from "react";
import {
	clearCreateItemIntent,
	consumeViewItemIntent,
	getCreateItemIntent,
	subscribeCreateItemIntent,
} from "@/lib/create-item-intent";
import { storage } from "@/lib/storage";
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

		// Single account mode: validate session for specific account
		const accountsList = await storage.getAccountsList();
		const activeAccountEmail = accountsList.find(
			(account) => account.accountId === activeAccount,
		)?.email;

		// Check if user has stored credentials for active account
		const hasSecretKey = await storage.getStoredSecretKey(activeAccount);
		const sessionValid = await storage.isSessionValid(activeAccount);

		if (!hasSecretKey || !sessionValid) {
			throw redirect({
				to: "/unlock",
				search: activeAccountEmail ? { email: activeAccountEmail } : undefined,
			});
		}

		// This guard can run before AccountProvider constructs the manager; with no
		// manager there is no verified unlock, so send the user to /unlock.
		const restored = await peekAccountSessionManager()?.unlockAccount(
			activeAccount,
			true,
		);

		if (!restored) {
			throw redirect({
				to: "/unlock",
				search: activeAccountEmail ? { email: activeAccountEmail } : undefined,
			});
		}

		// Extension "view item" handoff that arrived while the app was locked
		// (or on another route): consume it now that the session is valid.
		const viewIntent = consumeViewItemIntent();
		if (viewIntent) {
			throw redirect({
				to: "/vault/$id/$itemId",
				params: { id: viewIntent.vaultId, itemId: viewIntent.itemId },
			});
		}
	},
});

function RouteComponent() {
	// Fetch the active account's vault keys for the sidebar / vault list.
	const { vaultKeys } = useAllVaultKeys();

	// One item subscription feeds both the sidebar tags and its counts.
	const { items, isLoading: isLoadingItems } = useItems();
	const { tags: crossVaultTags } = useCrossVaultTags(items);
	const itemCounts = useItemCounts(isLoadingItems ? undefined : items);

	const params = useParams({ strict: false });
	const navigate = useNavigate();

	// Shared hooks for vault and item operations
	const createVaultMutation = useCreateVault();
	const updateVaultMutation = useUpdateVault();
	const deleteVaultMutation = useDeleteVault();
	const createItemMutation = useCreateItem();

	const [isNewItemDialogOpen, setIsNewItemDialogOpen] = useState(false);
	// Pending "new item" request from the browser extension (via native
	// messaging). Presence of an intent forces the sheet open; closing the
	// sheet or creating the item consumes it.
	const createItemIntent = useSyncExternalStore(
		subscribeCreateItemIntent,
		getCreateItemIntent,
	);
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
	const accountIdsQuery = useQuery({
		queryKey: ["vault-route", "account-ids"],
		queryFn: async () => {
			const activeAccount = await storage.getActiveAccount();
			if (!activeAccount) {
				return [];
			}

			return [activeAccount];
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

			// If no account provided, use the active account.
			if (!accountId) {
				const activeAccount = await storage.getActiveAccount();
				if (activeAccount) {
					accountId = activeAccount;
				}
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
			clearCreateItemIntent();

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
					itemCounts={itemCounts}
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
					open={isNewItemDialogOpen || createItemIntent !== null}
					onOpenChange={(open) => {
						setIsNewItemDialogOpen(open);
						if (!open) {
							clearCreateItemIntent();
						}
					}}
					initialUrl={createItemIntent?.url}
					vaults={
						vaultKeys?.map((v) => ({
							id: v.vaultId,
							name: v.vaultName,
							type: v.vaultType,
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
