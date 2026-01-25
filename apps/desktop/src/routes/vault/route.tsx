import { encrypt } from "../../lib/tauri-crypto";
import * as tauriStorage from "@bittery/crypto/storage-tauri";
import { useTRPCClient } from "@bittery/shared/trpc";
import type { ItemCategory } from "@bittery/shared/types";
import { toast } from "@bittery/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createFileRoute,
	Outlet,
	redirect,
	useNavigate,
	useParams,
} from "@tanstack/react-router";
import { useState } from "react";
import { CreateItemDialog } from "../../components/vault/create-item-dialog";
import { CreateVaultDialog } from "../../components/vault/create-vault-dialog";
import { DeleteVaultDialog } from "../../components/vault/delete-vault-dialog";
import { EditVaultDialog } from "../../components/vault/edit-vault-dialog";
import { ImportDialog } from "../../components/vault/import-dialog";
import { useVaultOperations } from "../../components/vault/use-vault-operations";
import { VaultHeader } from "../../components/vault/vault-header";
import { VaultSidebar } from "../../components/vault/vault-sidebar";
import { useCrossVaultTags } from "../../hooks/use-cross-vault-tags";
import { trpc } from "../../lib/providers";
import { VaultDndProvider } from "../../providers/dnd-provider";
import { useQueryInvalidator } from "../../providers/sync-provider";

export const Route = createFileRoute("/vault")({
	component: RouteComponent,
	beforeLoad: async () => {
		// Get active account
		const activeEmail = await tauriStorage.getActiveAccountEmail();
		if (!activeEmail) {
			throw redirect({ to: "/login" });
		}

		// Check if user has stored credentials for active account
		const hasSecretKey = await tauriStorage.hasStoredSecretKey(activeEmail);
		const sessionValid = await tauriStorage.isSessionValid(activeEmail);

		if (!hasSecretKey || !sessionValid) {
			throw redirect({ to: "/unlock", search: { email: activeEmail } });
		}

		const restored = await tauriStorage.tryRestoreSession(true, activeEmail);

		if (!restored) {
			throw redirect({ to: "/unlock", search: { email: activeEmail } });
		}
	},
});

interface DecryptedItemData {
	title: string;
	url?: string;
	username?: string;
	password?: string;
	notes?: string;
	note?: string;
	// Identity fields
	firstName?: string;
	middleName?: string;
	lastName?: string;
	email?: string;
}

function RouteComponent() {
	const { data: vaultKeys } = useQuery({
		queryKey: ["vault-keys"],
		queryFn: async () => {
			const keys = await tauriStorage.getVaultKeys();
			return keys;
		},
	});

	// Get cross-vault tags for sidebar
	const { tags: crossVaultTags } = useCrossVaultTags();

	const params = useParams({ strict: false });
	const navigate = useNavigate();
	const trpcClient = useTRPCClient();
	const queryClient = useQueryClient();
	const invalidator = useQueryInvalidator();
	const { createVault, updateVault, deleteVault } = useVaultOperations();

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

	const handleCreateItem = async (
		data: DecryptedItemData,
		vaultId: string,
		category: ItemCategory,
	) => {
		try {
			// Get vault key for encryption
			const vaultKey = await tauriStorage.getDecryptedVaultKey(vaultId);

			if (!vaultKey) {
				throw new Error("No vault key found");
			}

			// Encrypt the item data
			const encryptedData = await encrypt(JSON.stringify(data), vaultKey);

			const createdItem = await trpcClient.vault.createItem.mutate({
				vaultId: vaultId,
				category: category,
				encryptedData: encryptedData.ciphertext,
				encryptionIv: encryptedData.iv,
				encryptionAlgorithm: encryptedData.algorithm,
			});

			// Prefetch the item to avoid race condition
			await queryClient.prefetchQuery(
				trpc.vault.getItem.queryOptions({ itemId: createdItem.itemId }),
			);
			// Invalidate queries to refresh the list
			await invalidator.invalidateVaultList(vaultId);

			// Close dialog
			setIsNewItemDialogOpen(false);

			// Navigate to the newly created item
			navigate({
				to: "/vault/$id/$itemId",
				params: { id: vaultId, itemId: createdItem.itemId },
			});

			toast.success("Item created successfully");
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : "Failed to create item";
			toast.error(errorMessage);
			throw error;
		}
	};

	const handleOpenEditVault = (vault: { id: string; name: string }) => {
		setEditingVault(vault);
		setIsEditVaultDialogOpen(true);
	};

	const handleUpdateVault = async (vaultId: string, name: string) => {
		await updateVault(vaultId, name);
		setEditingVault(null);
	};

	const handleOpenDeleteVault = (vault: { id: string; name: string }) => {
		setDeletingVault(vault);
		setIsDeleteVaultDialogOpen(true);
	};

	const handleDeleteVault = async (vaultId: string) => {
		await deleteVault(vaultId, params.id);
		setDeletingVault(null);
	};

	const handleOpenImportDialog = (vaultId: string) => {
		setImportingVaultId(vaultId);
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
					onSubmit={createVault}
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
						open={isImportDialogOpen}
						onOpenChange={(open) => {
							setIsImportDialogOpen(open);
							if (!open) {
								setImportingVaultId(null);
							}
						}}
					/>
				)}
			</div>
		</VaultDndProvider>
	);
}
