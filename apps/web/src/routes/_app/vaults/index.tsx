import {
	type CreateVaultInput,
	useAllVaultKeys,
	useCreateVault,
	useDeleteVault,
	useItems,
	useUpdateVault,
} from "@bittery/core/hooks";
import {
	Badge,
	Button,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
	Skeleton,
} from "@bittery/ui";
import {
	IconDotsOutlineDuo18 as Dots,
	IconKeyOutlineDuo18 as Key,
	IconLockOutlineDuo18 as Lock,
	IconPen2OutlineDuo18 as Pen,
	IconPlusOutlineDuo18 as Plus,
	IconTrash2OutlineDuo18 as Trash,
	IconVault3OutlineDuo18 as Vault,
} from "@bittery/ui/icons";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { CreateVaultDialog } from "@/components/vaults/create-vault-dialog";
import { DeleteVaultDialog } from "@/components/vaults/delete-vault-dialog";
import {
	type EditVaultData,
	type UpdateVaultData,
	EditVaultDialog,
} from "@/components/vaults/edit-vault-dialog";
import { VaultAvatar } from "@/components/vaults/vault-avatar";

export const Route = createFileRoute("/_app/vaults/")({
	component: VaultsPage,
	head: () => ({
		meta: [{ title: "Vaults - Bittery" }],
	}),
});

function VaultsPage() {
	const navigate = useNavigate();
	const { vaultKeys, isLoading } = useAllVaultKeys();
	const { items } = useItems();
	const createVault = useCreateVault();
	const updateVault = useUpdateVault();
	const deleteVault = useDeleteVault();

	const [isCreateVaultDialogOpen, setIsCreateVaultDialogOpen] = useState(false);
	const [isEditVaultDialogOpen, setIsEditVaultDialogOpen] = useState(false);
	const [isDeleteVaultDialogOpen, setIsDeleteVaultDialogOpen] = useState(false);
	const [editingVault, setEditingVault] = useState<EditVaultData | null>(null);
	const [deletingVault, setDeletingVault] = useState<
		{ id: string; name: string } | null
	>(null);

	// Build per-vault item counts from local decrypted items
	const itemCountByVault = useMemo(() => {
		const map = new Map<string, number>();
		for (const item of items) {
			map.set(item.vaultId, (map.get(item.vaultId) || 0) + 1);
		}
		return map;
	}, [items]);

	const totalItems = items.length;
	const totalVaults = vaultKeys.length;

	const handleCreateVault = async (data: CreateVaultInput) => {
		const result = await createVault.mutateAsync(data);
		navigate({ to: "/vaults/$vaultId", params: { vaultId: result.vaultId } });
	};

	const handleOpenEditVault = (vault: EditVaultData) => {
		setEditingVault(vault);
		setIsEditVaultDialogOpen(true);
	};

	const handleUpdateVault = async (vaultId: string, data: UpdateVaultData) => {
		await updateVault.mutateAsync({
			vaultId,
			name: data.name,
			icon: data.icon,
			imageFile: data.imageFile,
			removeImage: data.removeImage,
		});
		setEditingVault(null);
	};

	const handleOpenDeleteVault = (vault: { id: string; name: string }) => {
		setDeletingVault(vault);
		setIsDeleteVaultDialogOpen(true);
	};

	const handleDeleteVault = async (vaultId: string) => {
		await deleteVault.mutateAsync({ vaultId });
		setDeletingVault(null);
	};

	return (
		<>
			<div className="mx-auto flex w-full max-w-6xl flex-col gap-6 pb-3">
				{/* Hero Banner */}
				<section className="relative overflow-hidden rounded-2xl border bg-card p-6 sm:p-7">
					<div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-muted/60 via-transparent to-transparent" />
					<div className="pointer-events-none absolute -top-24 right-0 h-56 w-56 rounded-full bg-muted/50 blur-3xl" />

					<div className="relative flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
						<div className="space-y-4">
							<Badge variant="secondary" className="w-fit">
								<Vault className="mr-1 h-3.5 w-3.5" />
								Vaults
							</Badge>
							<div className="space-y-2">
								<h1 className="text-balance font-bold text-3xl tracking-tight md:text-4xl">
									Your Vaults
								</h1>
								<p className="max-w-2xl text-muted-foreground">
									Browse and manage your encrypted password vaults.
								</p>
							</div>
							{!isLoading && totalVaults > 0 && (
								<div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
									<div className="inline-flex items-center gap-1.5 rounded-md border bg-background/70 px-2.5 py-1">
										<Lock className="h-3.5 w-3.5" />
										{totalVaults} vault{totalVaults !== 1 ? "s" : ""}
									</div>
									<div className="inline-flex items-center gap-1.5 rounded-md border bg-background/70 px-2.5 py-1">
										<Key className="h-3.5 w-3.5" />
										{totalItems} item{totalItems !== 1 ? "s" : ""} total
									</div>
								</div>
							)}
						</div>

						<Button
							onClick={() => setIsCreateVaultDialogOpen(true)}
							data-testid="new-vault-button"
						>
							<Plus className="mr-2 h-4 w-4" />
							New Vault
						</Button>
					</div>
				</section>

				{/* Vault Grid */}
				{isLoading ? (
					<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
						{[1, 2, 3].map((i) => (
							<Skeleton key={i} className="h-36 rounded-xl" />
						))}
					</div>
				) : totalVaults === 0 ? (
					<div className="flex flex-col items-center gap-4 rounded-xl border border-dashed p-10 text-center">
						<div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
							<Vault className="h-6 w-6 text-muted-foreground" />
						</div>
						<div>
							<h3 className="font-medium text-lg">No vaults yet</h3>
							<p className="mt-1 text-muted-foreground text-sm">
								Create your first vault to get started.
							</p>
						</div>
						<Button
							onClick={() => setIsCreateVaultDialogOpen(true)}
							data-testid="empty-new-vault-button"
						>
							<Plus className="mr-2 h-4 w-4" />
							Create Vault
						</Button>
					</div>
				) : (
					<div className="space-y-3">
						<div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
							<h2 className="font-semibold text-lg tracking-tight">All Vaults</h2>
							<p className="text-muted-foreground text-sm">
								Click a vault to view items and manage access.
							</p>
						</div>
						<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
							{vaultKeys.map((vault) => {
								const itemCount = itemCountByVault.get(vault.vaultId) || 0;
								const canEditVault =
									vault.role === "owner" || vault.role === "admin";
								const canDeleteVault = vault.role === "owner";

								return (
									<div
										key={vault.vaultId}
										className="group relative"
										data-testid="vault-card-container"
									>
										{(canEditVault || canDeleteVault) && (
											<div className="absolute top-2 right-2 z-20">
												<DropdownMenu>
													<DropdownMenuTrigger asChild>
														<Button
															variant="ghost"
															size="sm"
															className="h-8 w-8 p-0"
															data-testid={`vault-card-actions-trigger-${vault.vaultId}`}
														>
															<Dots className="h-4 w-4" />
														</Button>
													</DropdownMenuTrigger>
													<DropdownMenuContent align="end">
														{canEditVault && (
															<DropdownMenuItem
																onClick={() =>
																	handleOpenEditVault({
																		id: vault.vaultId,
																		name: vault.vaultName,
																		icon: vault.vaultIcon,
																		imageUrl: vault.vaultImageUrl,
																	})
																}
																data-testid={`vault-card-edit-action-${vault.vaultId}`}
															>
																<Pen className="h-4 w-4" />
																Edit Vault
															</DropdownMenuItem>
														)}
														{canEditVault && canDeleteVault && (
															<DropdownMenuSeparator />
														)}
														{canDeleteVault && (
															<DropdownMenuItem
																variant="destructive"
																onClick={() =>
																	handleOpenDeleteVault({
																		id: vault.vaultId,
																		name: vault.vaultName,
																	})
																}
																data-testid={`vault-card-delete-action-${vault.vaultId}`}
															>
																<Trash className="h-4 w-4" />
																Delete Vault
															</DropdownMenuItem>
														)}
													</DropdownMenuContent>
												</DropdownMenu>
											</div>
										)}

										<Link
											to="/vaults/$vaultId"
											params={{ vaultId: vault.vaultId }}
											className="block"
										>
											<div
												className="relative overflow-hidden rounded-xl border bg-card p-5 pr-12 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
												data-testid="vault-card"
											>
												<div className="absolute top-0 left-0 h-full w-1 rounded-l-xl bg-primary/80" />
												<div className="flex items-start justify-between gap-3">
													<div className="flex min-w-0 items-center gap-3">
												<VaultAvatar
													name={vault.vaultName}
													icon={vault.vaultIcon}
													imageUrl={vault.vaultImageUrl}
													size="md"
												/>
														<div className="min-w-0">
															<h3
																className="truncate font-semibold leading-tight"
																data-testid="vault-name"
															>
																{vault.vaultName}
															</h3>
															<p
																className="mt-0.5 text-muted-foreground text-xs capitalize"
																data-testid="vault-type"
															>
																{vault.vaultType} vault
															</p>
														</div>
													</div>
													<Badge
														variant={
															vault.role === "owner" ? "default" : "secondary"
														}
														className="shrink-0"
													>
														{vault.role}
													</Badge>
												</div>
												<div className="mt-4 flex items-center gap-3 text-muted-foreground text-xs">
													<div className="flex items-center gap-1">
														<Key className="h-3.5 w-3.5" />
														{itemCount} item{itemCount !== 1 ? "s" : ""}
													</div>
												</div>
											</div>
										</Link>
									</div>
								);
							})}
						</div>
					</div>
				)}
			</div>

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
		</>
	);
}
