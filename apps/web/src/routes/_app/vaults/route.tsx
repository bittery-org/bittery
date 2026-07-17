import {
	type CreateVaultInput,
	useAllVaultKeys,
	useAvailableTags,
	useCreateVault,
	useDeleteVault,
	useItemCounts,
	useItems,
	useUpdateVault,
} from "@bittery/core/hooks";
import { Button, Sheet, SheetContent, toast } from "@bittery/ui";
import { IconVault3OutlineDuo18 as VaultIcon } from "@bittery/ui/icons";
import {
	createFileRoute,
	Outlet,
	useNavigate,
	useParams,
} from "@tanstack/react-router";
import { useState } from "react";
import { VaultNavSidebar } from "@/components/vault/vault-nav-sidebar";
import { CreateVaultDialog } from "@/components/vaults/create-vault-dialog";
import { DeleteVaultDialog } from "@/components/vaults/delete-vault-dialog";
import {
	EditVaultDialog,
	type UpdateVaultData,
} from "@/components/vaults/edit-vault-dialog";
import { storage } from "@/lib/storage";
import { useI18n } from "@/providers/i18n-provider";
import { VaultDndProvider } from "@/providers/vault-dnd-provider";

export const Route = createFileRoute("/_app/vaults")({
	component: VaultsLayout,
});

function VaultsLayout() {
	const { m } = useI18n();
	const navigate = useNavigate();
	const params = useParams({ strict: false });
	const currentVaultId = (params as { vaultId?: string }).vaultId;

	const { vaultKeys } = useAllVaultKeys();
	const { items, isLoading: isLoadingItems } = useItems();
	const availableTags = useAvailableTags(items);
	const itemCounts = useItemCounts(isLoadingItems ? undefined : items);
	const createVault = useCreateVault();
	const updateVault = useUpdateVault();
	const deleteVault = useDeleteVault();

	const [isSidebarOpen, setIsSidebarOpen] = useState(false);
	const [isCreateVaultDialogOpen, setIsCreateVaultDialogOpen] = useState(false);
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

	const handleCreateVault = async (data: CreateVaultInput) => {
		const active = await storage.getActiveAccount();
		if (active?.type !== "single") throw new Error();
		const result = await createVault.mutateAsync({
			...data,
			accountId: active.accountId,
		});
		navigate({ to: "/vaults/$vaultId", params: { vaultId: result.vaultId } });
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

	const handleUpdateVault = async (vaultId: string, data: UpdateVaultData) => {
		const accountId = vaultKeys.find(
			(vault) => vault.vaultId === vaultId,
		)?.accountId;
		if (!accountId) throw new Error();
		await updateVault.mutateAsync({
			vaultId,
			name: data.name,
			icon: data.icon,
			imageFile: data.imageFile,
			removeImage: data.removeImage,
			accountId,
		});
		setEditingVault(null);
	};

	const handleOpenDeleteVault = (vault: { id: string; name: string }) => {
		setDeletingVault(vault);
		setIsDeleteVaultDialogOpen(true);
	};

	const handleDeleteVault = async (vaultId: string) => {
		const accountId = vaultKeys.find(
			(vault) => vault.vaultId === vaultId,
		)?.accountId;
		if (!accountId) throw new Error();
		await deleteVault.mutateAsync({ vaultId, accountId });
		setDeletingVault(null);
		if (currentVaultId === vaultId) {
			navigate({ to: "/vaults" });
		}
		toast.success(m.vaults_detail_toast_vault_deleted());
	};

	const tags = availableTags;

	return (
		<VaultDndProvider>
			<div className="flex min-h-0 flex-1 overflow-hidden">
				{/* Desktop sidebar */}
				<aside className="hidden w-54 shrink-0 flex-col border-r lg:flex">
					<VaultNavSidebar
						hasHeaderInset
						vaults={vaultKeys}
						tags={tags}
						itemCounts={itemCounts}
						currentVaultId={currentVaultId}
						onNewVault={() => setIsCreateVaultDialogOpen(true)}
						onEditVault={handleOpenEditVault}
						onDeleteVault={handleOpenDeleteVault}
					/>
				</aside>

				{/* Main content area */}
				<div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
					{/* Mobile header with sidebar toggle */}
					<div className="flex h-10 shrink-0 items-center border-b pr-3 pl-12 lg:hidden">
						<Button
							variant="ghost"
							size="sm"
							className="h-8 w-8 p-0"
							onClick={() => setIsSidebarOpen(true)}
							aria-label={m.vaults_nav_sidebar_toggle()}
						>
							<VaultIcon className="h-4 w-4" />
						</Button>
					</div>

					{/* Child routes render here */}
					<div className="flex min-h-0 flex-1 overflow-hidden">
						<Outlet />
					</div>
				</div>

				{/* Mobile sidebar Sheet */}
				<Sheet open={isSidebarOpen} onOpenChange={setIsSidebarOpen}>
					<SheetContent side="left" className="w-64 p-0">
						<VaultNavSidebar
							vaults={vaultKeys}
							tags={tags}
							itemCounts={itemCounts}
							currentVaultId={currentVaultId}
							onNewVault={() => {
								setIsSidebarOpen(false);
								setIsCreateVaultDialogOpen(true);
							}}
							onEditVault={(vault) => {
								setIsSidebarOpen(false);
								handleOpenEditVault(vault);
							}}
							onDeleteVault={(vault) => {
								setIsSidebarOpen(false);
								handleOpenDeleteVault(vault);
							}}
							onNavigate={() => setIsSidebarOpen(false)}
						/>
					</SheetContent>
				</Sheet>

				{/* Vault Dialogs */}
				<CreateVaultDialog
					open={isCreateVaultDialogOpen}
					onOpenChange={setIsCreateVaultDialogOpen}
					onSubmit={handleCreateVault}
				/>

				<EditVaultDialog
					key={editingVault?.id || "edit-vault-dialog"}
					open={isEditVaultDialogOpen}
					onOpenChange={(open) => {
						setIsEditVaultDialogOpen(open);
						if (!open) setEditingVault(null);
					}}
					vault={editingVault}
					onSubmit={handleUpdateVault}
				/>

				<DeleteVaultDialog
					open={isDeleteVaultDialogOpen}
					onOpenChange={(open) => {
						setIsDeleteVaultDialogOpen(open);
						if (!open) setDeletingVault(null);
					}}
					vault={deletingVault}
					onConfirm={handleDeleteVault}
				/>
			</div>
		</VaultDndProvider>
	);
}
