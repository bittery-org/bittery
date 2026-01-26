import {
	useCreateItem,
	useCreateVault,
	useCrossVaultTags,
	useDeleteVault,
	useUpdateVault,
} from "@bittery/hooks";
import type { DecryptedItemData, ItemCategory } from "@bittery/shared/types";
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
import { storage } from "@/lib/storage";
import { CreateItemDialog } from "../../components/vault/create-item-dialog";
import { CreateVaultDialog } from "../../components/vault/create-vault-dialog";
import { DeleteVaultDialog } from "../../components/vault/delete-vault-dialog";
import { EditVaultDialog } from "../../components/vault/edit-vault-dialog";
import { ImportDialog } from "../../components/vault/import-dialog";
import { VaultHeader } from "../../components/vault/vault-header";
import { VaultSidebar } from "../../components/vault/vault-sidebar";
import { trpc } from "../../lib/providers";
import { VaultDndProvider } from "../../providers/dnd-provider";

export const Route = createFileRoute("/vault")({
	component: RouteComponent,
	beforeLoad: async () => {
		// Get active account
		const activeEmail = await storage.getActiveAccountEmail();
		if (!activeEmail) {
			throw redirect({ to: "/login" });
		}

		// Check if user has stored credentials for active account
		const hasSecretKey = await storage.getStoredSecretKey(activeEmail);
		const sessionValid = await storage.isSessionValid(activeEmail);

		if (!hasSecretKey || !sessionValid) {
			throw redirect({ to: "/unlock", search: { email: activeEmail } });
		}

		const restored = await storage.tryRestoreSession(true, activeEmail);

		if (!restored) {
			throw redirect({ to: "/unlock", search: { email: activeEmail } });
		}
	},
});

function RouteComponent() {
	const { data: vaultKeys } = useQuery({
		queryKey: ["vault-keys"],
		queryFn: async () => {
			const keys = await storage.getVaultKeys();
			return keys;
		},
	});

	// Get cross-vault tags for sidebar
	const { tags: crossVaultTags } = useCrossVaultTags();

	const params = useParams({ strict: false });
	const navigate = useNavigate();
	const queryClient = useQueryClient();

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

	// Vault operation handlers
	const handleCreateVault = async (data: {
		name: string;
		type: "personal" | "team";
		icon: string;
		imageFile: File | null;
	}) => {
		try {
			// Hook handles image upload internally if imageFile is provided
			const result = await createVaultMutation.mutateAsync({
				name: data.name,
				type: data.type,
				icon: data.icon,
				imageFile: data.imageFile ?? undefined,
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
			await updateVaultMutation.mutateAsync({ vaultId, name });
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
			await deleteVaultMutation.mutateAsync({ vaultId });
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
			const result = await createItemMutation.mutateAsync({
				vaultId,
				category,
				data,
			});

			// Prefetch the item to avoid race condition
			await queryClient.prefetchQuery(
				trpc.vault.getItem.queryOptions({ itemId: result.itemId }),
			);

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
