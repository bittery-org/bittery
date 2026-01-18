import * as tauriStorage from "@bittery/crypto/storage-tauri";
import { encrypt, generateEncryptionKey } from "@bittery/shared/crypto";
import { useTRPCClient } from "@bittery/shared/trpc";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
	Input,
	Label,
	toast,
} from "@bittery/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createFileRoute,
	Link,
	Outlet,
	redirect,
	useNavigate,
	useParams,
} from "@tanstack/react-router";
import { MoreHorizontal, Pencil, PlusIcon, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { AccountSwitcher } from "../../components/account-switcher";
import { CreateItemDialog } from "../../components/vault/create-item-dialog";
import { SearchCombobox } from "../../components/vault/search-combobox";
import {
	VaultAvatar,
	vaultIconOptions,
} from "../../components/vault/vault-avatar";

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

	const params = useParams({ strict: false });
	const navigate = useNavigate();
	const trpcClient = useTRPCClient();
	const queryClient = useQueryClient();

	const [isNewItemDialogOpen, setIsNewItemDialogOpen] = useState(false);

	const [isNewVaultDialogOpen, setIsNewVaultDialogOpen] = useState(false);
	const [vaultName, setVaultName] = useState("");
	const [vaultType, setVaultType] = useState<"personal" | "team">("personal");
	const [isCreatingVault, setIsCreatingVault] = useState(false);
	const [vaultIcon, setVaultIcon] = useState("lock");
	const [vaultImageFile, setVaultImageFile] = useState<File | null>(null);
	const [vaultImagePreview, setVaultImagePreview] = useState<string | null>(
		null,
	);

	// Edit vault state
	const [isEditVaultDialogOpen, setIsEditVaultDialogOpen] = useState(false);
	const [editingVault, setEditingVault] = useState<{
		id: string;
		name: string;
	} | null>(null);
	const [editVaultName, setEditVaultName] = useState("");
	const [isUpdatingVault, setIsUpdatingVault] = useState(false);

	// Delete vault state
	const [isDeleteVaultDialogOpen, setIsDeleteVaultDialogOpen] = useState(false);
	const [deletingVault, setDeletingVault] = useState<{
		id: string;
		name: string;
	} | null>(null);
	const [isDeletingVault, setIsDeletingVault] = useState(false);

	useEffect(() => {
		return () => {
			if (vaultImagePreview) {
				URL.revokeObjectURL(vaultImagePreview);
			}
		};
	}, [vaultImagePreview]);

	const resetVaultForm = () => {
		setVaultName("");
		setVaultType("personal");
		setVaultIcon("lock");
		setVaultImageFile(null);
		setVaultImagePreview(null);
	};

	const handleCreateItem = async (
		data: DecryptedItemData,
		vaultId: string,
		category: "login" | "secure-note" | "credit-card" | "identity",
	) => {
		try {
			// Get vault key for encryption
			const vaultKey = await tauriStorage.getDecryptedVaultKey(vaultId);

			if (!vaultKey) {
				throw new Error("No vault key found");
			}

			// Encrypt the item data
			const encryptedData = await encrypt(JSON.stringify(data), vaultKey);

			// Create overview
			const overview: {
				title: string;
				url?: string;
				username?: string;
				fullName?: string;
				email?: string;
			} = {
				title: data.title || "Untitled",
			};

			if (category === "login") {
				if (data.url) overview.url = data.url;
				if (data.username) overview.username = data.username;
			} else if (category === "identity") {
				const fullName = [data.firstName, data.middleName, data.lastName]
					.filter(Boolean)
					.join(" ");
				if (fullName) overview.fullName = fullName;
				if (data.email) overview.email = data.email;
			}

			const createdItem = await trpcClient.vault.createItem.mutate({
				vaultId: vaultId,
				category: category,
				overview,
				encryptedData: encryptedData.ciphertext,
				encryptionIv: encryptedData.iv,
				encryptionAlgorithm: encryptedData.algorithm,
			});

			// Invalidate queries to refresh the list
			queryClient.invalidateQueries({ queryKey: [["vault", "listItems"]] });

			// Close dialog
			setIsNewItemDialogOpen(false);

			// Navigate to the newly created item
			navigate({
				to: "/vault/$id/$itemId",
				params: { id: vaultId, itemId: createdItem.id },
			});

			toast.success("Item created successfully");
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : "Failed to create item";
			toast.error(errorMessage);
			throw error;
		}
	};

	const handleCreateVault = async () => {
		if (!vaultName.trim()) {
			toast.error("Vault name is required");
			return;
		}

		if (vaultName.trim().length < 2) {
			toast.error("Vault name must be at least 2 characters");
			return;
		}

		setIsCreatingVault(true);
		try {
			let imageKey: string | undefined;

			if (vaultImageFile) {
				if (!vaultImageFile.type.startsWith("image/")) {
					throw new Error("Vault image must be an image file");
				}

				const upload = await trpcClient.vault.createImageUpload.mutate({
					fileName: vaultImageFile.name,
					contentType: vaultImageFile.type,
				});

				const uploadResponse = await fetch(upload.uploadUrl, {
					method: "PUT",
					headers: {
						"Content-Type": vaultImageFile.type,
					},
					body: vaultImageFile,
				});

				if (!uploadResponse.ok) {
					throw new Error("Failed to upload vault image");
				}

				imageKey = upload.key;
			}

			// Generate a new encryption key for this vault
			const vaultKey = generateEncryptionKey();

			// Get the Master Unlock Key to encrypt the vault key
			const masterUnlockKey = await tauriStorage.getMasterUnlockKey();
			if (!masterUnlockKey) {
				throw new Error("Master Unlock Key not found");
			}

			// Encrypt the vault key with the Master Unlock Key
			const encryptedVaultKeyData = await encrypt(
				btoa(String.fromCharCode(...vaultKey)),
				masterUnlockKey,
			);

			// Create the vault via API
			const result = await trpcClient.vault.create.mutate({
				name: vaultName.trim(),
				type: vaultType,
				encryptedVaultKey: JSON.stringify(encryptedVaultKeyData),
				icon: vaultIcon,
				...(imageKey && { imageKey }),
			});

			// Refresh vault keys in local storage
			const vaultKeys = await trpcClient.vault.list.query();
			await tauriStorage.storeVaultKeys(
				vaultKeys.map((v) => ({
					vaultId: v.id,
					vaultName: v.name,
					vaultType: v.type,
					vaultIcon: v.icon,
					vaultImageUrl: v.imageUrl,
					encryptedVaultKey: v.encryptedVaultKey,
					role: v.role,
				})),
			);

			// Invalidate vault-keys query to refresh the UI
			queryClient.invalidateQueries({ queryKey: ["vault-keys"] });

			// Close dialog and reset form
			setIsNewVaultDialogOpen(false);
			resetVaultForm();

			toast.success("Vault created successfully");

			// Navigate to the new vault
			navigate({ to: "/vault/$id", params: { id: result.vaultId } });
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : "Failed to create vault";
			toast.error(errorMessage);
			console.error("Vault creation error:", error);
		} finally {
			setIsCreatingVault(false);
		}
	};

	const handleOpenEditVault = (vault: { id: string; name: string }) => {
		setEditingVault(vault);
		setEditVaultName(vault.name);
		setIsEditVaultDialogOpen(true);
	};

	const handleUpdateVault = async () => {
		if (!editingVault) return;

		if (!editVaultName.trim()) {
			toast.error("Vault name is required");
			return;
		}

		if (editVaultName.trim().length < 2) {
			toast.error("Vault name must be at least 2 characters");
			return;
		}

		setIsUpdatingVault(true);
		try {
			await trpcClient.vault.update.mutate({
				vaultId: editingVault.id,
				name: editVaultName.trim(),
			});

			// Refresh vault keys in local storage
			const vaultList = await trpcClient.vault.list.query();
			await tauriStorage.storeVaultKeys(
				vaultList.map((v) => ({
					vaultId: v.id,
					vaultName: v.name,
					vaultType: v.type,
					vaultIcon: v.icon,
					vaultImageUrl: v.imageUrl,
					encryptedVaultKey: v.encryptedVaultKey,
					role: v.role,
				})),
			);

			// Invalidate vault-keys query to refresh the UI
			queryClient.invalidateQueries({ queryKey: ["vault-keys"] });

			setIsEditVaultDialogOpen(false);
			setEditingVault(null);
			setEditVaultName("");

			toast.success("Vault renamed successfully");
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : "Failed to rename vault";
			toast.error(errorMessage);
		} finally {
			setIsUpdatingVault(false);
		}
	};

	const handleOpenDeleteVault = (vault: { id: string; name: string }) => {
		setDeletingVault(vault);
		setIsDeleteVaultDialogOpen(true);
	};

	const handleDeleteVault = async () => {
		if (!deletingVault) return;

		setIsDeletingVault(true);
		try {
			await trpcClient.vault.delete.mutate({
				vaultId: deletingVault.id,
			});

			// Refresh vault keys in local storage
			const vaultList = await trpcClient.vault.list.query();
			await tauriStorage.storeVaultKeys(
				vaultList.map((v) => ({
					vaultId: v.id,
					vaultName: v.name,
					vaultType: v.type,
					vaultIcon: v.icon,
					vaultImageUrl: v.imageUrl,
					encryptedVaultKey: v.encryptedVaultKey,
					role: v.role,
				})),
			);

			// Invalidate vault-keys query to refresh the UI
			queryClient.invalidateQueries({ queryKey: ["vault-keys"] });

			setIsDeleteVaultDialogOpen(false);
			setDeletingVault(null);

			// Navigate to vault root if we were viewing the deleted vault
			if (params.id === deletingVault.id) {
				navigate({ to: "/vault" });
			}

			toast.success("Vault deleted successfully");
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : "Failed to delete vault";
			toast.error(errorMessage);
		} finally {
			setIsDeletingVault(false);
		}
	};

	return (
		<div className="flex h-screen flex-col overflow-hidden">
			{/* Top Header */}
			<header className="flex items-center space-x-2 border-b px-2 py-2">
				{/* <div className="flex items-center gap-2">
					<div className="flex size-6 items-center justify-center rounded-sm bg-primary text-primary-foreground">
						<ShieldCheck className="size-4" />
					</div>
					<span className="font-bold text-xl tracking-tight">Bittery</span>
				</div> */}
				<AccountSwitcher />
				<div className="flex flex-1 items-center space-x-6 pl-2">
					<div className="flex-1">
						<SearchCombobox />
					</div>
					<Button
						onClick={() => setIsNewItemDialogOpen(true)}
						disabled={!vaultKeys?.length}
					>
						<PlusIcon />
						New Item
					</Button>
				</div>
			</header>

			{/* Main Content Area */}
			<div className="flex flex-1 overflow-hidden">
				{/* Left Sidebar - Vaults */}
				<div className="flex w-48 flex-col border-r bg-background">
					<div className="flex flex-1 flex-col overflow-y-auto p-2">
						{vaultKeys?.map((vault) => (
							<div
								key={vault.vaultId}
								className={`group relative mb-1 w-full rounded-md text-left text-sm transition-colors ${
									params.id === vault.vaultId
										? "bg-muted/60"
										: "hover:bg-muted/30"
								}`}
							>
								<Link
									to="/vault/$id"
									params={{ id: vault.vaultId }}
									className="block px-3 py-2"
								>
									<div className="flex min-w-0 items-center gap-2">
										<VaultAvatar
											name={vault.vaultName}
											icon={vault.vaultIcon}
											imageUrl={vault.vaultImageUrl}
											size="sm"
										/>
										<div className="truncate">{vault.vaultName}</div>
									</div>
								</Link>
								{vault.role === "owner" && (
									<DropdownMenu>
										<DropdownMenuTrigger asChild>
											<Button
												variant="ghost"
												size="sm"
												className="-translate-y-1/2 absolute top-1/2 right-1 h-6 w-6 p-0 opacity-0 group-hover:opacity-100"
												onClick={(e) => e.stopPropagation()}
											>
												<MoreHorizontal className="h-4 w-4" />
											</Button>
										</DropdownMenuTrigger>
										<DropdownMenuContent align="end">
											<DropdownMenuItem
												onClick={() =>
													handleOpenEditVault({
														id: vault.vaultId,
														name: vault.vaultName,
													})
												}
											>
												<Pencil className="mr-2 h-4 w-4" />
												Rename
											</DropdownMenuItem>
											<DropdownMenuSeparator />
											<DropdownMenuItem
												variant="destructive"
												onClick={() =>
													handleOpenDeleteVault({
														id: vault.vaultId,
														name: vault.vaultName,
													})
												}
											>
												<Trash2 className="mr-2 h-4 w-4" />
												Delete
											</DropdownMenuItem>
										</DropdownMenuContent>
									</DropdownMenu>
								)}
							</div>
						))}
					</div>
					<div className="border-t p-2">
						<Button
							onClick={() => setIsNewVaultDialogOpen(true)}
							variant="outline"
							className="w-full"
							size="sm"
						>
							<PlusIcon className="mr-2 h-4 w-4" />
							New Vault
						</Button>
					</div>
				</div>

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
				onCreateItem={(data, vaultId, category) => handleCreateItem(data, vaultId, category)}
			/>

			{/* New Vault Dialog */}
			<Dialog
				open={isNewVaultDialogOpen}
				onOpenChange={(open) => {
					setIsNewVaultDialogOpen(open);
					if (!open) {
						resetVaultForm();
					}
				}}
			>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>Create New Vault</DialogTitle>
						<DialogDescription>
							Create a new vault to organize your passwords and secure notes.
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-4 py-4">
						<div className="space-y-2">
							<Label htmlFor="vault-name">Vault Name *</Label>
							<Input
								id="vault-name"
								placeholder="My Vault"
								value={vaultName}
								onChange={(e) => setVaultName(e.target.value)}
								disabled={isCreatingVault}
								onKeyDown={(e) => {
									if (e.key === "Enter" && !isCreatingVault) {
										handleCreateVault();
									}
								}}
							/>
						</div>
						<div className="space-y-2">
							<Label>Vault Type</Label>
							<div className="flex gap-2">
								<Button
									type="button"
									variant={vaultType === "personal" ? "default" : "outline"}
									onClick={() => setVaultType("personal")}
									disabled={isCreatingVault}
									className="flex-1"
								>
									Personal
								</Button>
								<Button
									type="button"
									variant={vaultType === "team" ? "default" : "outline"}
									onClick={() => setVaultType("team")}
									disabled={isCreatingVault}
									className="flex-1"
								>
									Team
								</Button>
							</div>
						</div>
						<div className="space-y-2">
							<Label>Appearance</Label>
							<div className="flex items-start gap-4">
								<VaultAvatar
									name={vaultName || "Vault"}
									icon={vaultIcon}
									imageUrl={vaultImagePreview}
									size="lg"
								/>
								<div className="flex flex-1 flex-col gap-3">
									<div className="grid grid-cols-4 gap-2">
										{vaultIconOptions.map((option) => (
											<Button
												key={option.value}
												type="button"
												variant={
													vaultIcon === option.value ? "default" : "outline"
												}
												onClick={() => setVaultIcon(option.value)}
												disabled={isCreatingVault}
												size="sm"
												className="h-9 px-0"
												aria-label={option.label}
											>
												<option.Icon className="size-4" />
											</Button>
										))}
									</div>
									<div className="flex flex-col gap-2">
										<Input
											id="vault-image"
											type="file"
											accept="image/*"
											disabled={isCreatingVault}
											onChange={(event) => {
												const file = event.target.files?.[0] || null;
												if (!file) {
													setVaultImageFile(null);
													setVaultImagePreview(null);
													return;
												}

												if (!file.type.startsWith("image/")) {
													toast.error("Please select an image file");
													event.currentTarget.value = "";
													setVaultImageFile(null);
													setVaultImagePreview(null);
													return;
												}

												if (file.size > 2 * 1024 * 1024) {
													toast.error("Image must be smaller than 2MB");
													event.currentTarget.value = "";
													setVaultImageFile(null);
													setVaultImagePreview(null);
													return;
												}

												setVaultImageFile(file);
												setVaultImagePreview(URL.createObjectURL(file));
											}}
										/>
										{vaultImagePreview && (
											<Button
												type="button"
												variant="ghost"
												size="sm"
												onClick={() => {
													setVaultImageFile(null);
													setVaultImagePreview(null);
												}}
												disabled={isCreatingVault}
												className="h-8 justify-start px-2 text-muted-foreground"
											>
												Remove custom image
											</Button>
										)}
										<p className="text-muted-foreground text-xs">
											Optional. PNG, JPG, or WebP up to 2MB.
										</p>
									</div>
								</div>
							</div>
						</div>
					</div>
					<div className="flex gap-2">
						<Button
							onClick={handleCreateVault}
							disabled={isCreatingVault}
							className="flex-1"
						>
							{isCreatingVault ? "Creating..." : "Create Vault"}
						</Button>
						<Button
							variant="outline"
							onClick={() => {
								setIsNewVaultDialogOpen(false);
								resetVaultForm();
							}}
							disabled={isCreatingVault}
						>
							Cancel
						</Button>
					</div>
				</DialogContent>
			</Dialog>

			{/* Edit Vault Dialog */}
			<Dialog
				open={isEditVaultDialogOpen}
				onOpenChange={(open) => {
					setIsEditVaultDialogOpen(open);
					if (!open) {
						setEditingVault(null);
						setEditVaultName("");
					}
				}}
			>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>Rename Vault</DialogTitle>
						<DialogDescription>
							Enter a new name for this vault.
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-4 py-4">
						<div className="space-y-2">
							<Label htmlFor="edit-vault-name">Vault Name</Label>
							<Input
								id="edit-vault-name"
								placeholder="My Vault"
								value={editVaultName}
								onChange={(e) => setEditVaultName(e.target.value)}
								disabled={isUpdatingVault}
								onKeyDown={(e) => {
									if (e.key === "Enter" && !isUpdatingVault) {
										handleUpdateVault();
									}
								}}
							/>
						</div>
					</div>
					<div className="flex gap-2">
						<Button
							onClick={handleUpdateVault}
							disabled={isUpdatingVault}
							className="flex-1"
						>
							{isUpdatingVault ? "Saving..." : "Save"}
						</Button>
						<Button
							variant="outline"
							onClick={() => {
								setIsEditVaultDialogOpen(false);
								setEditingVault(null);
								setEditVaultName("");
							}}
							disabled={isUpdatingVault}
						>
							Cancel
						</Button>
					</div>
				</DialogContent>
			</Dialog>

			{/* Delete Vault Confirmation Dialog */}
			<AlertDialog
				open={isDeleteVaultDialogOpen}
				onOpenChange={(open) => {
					setIsDeleteVaultDialogOpen(open);
					if (!open) {
						setDeletingVault(null);
					}
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Delete Vault</AlertDialogTitle>
						<AlertDialogDescription>
							Are you sure you want to delete "{deletingVault?.name}"? This will
							permanently delete the vault and all its items. This action cannot
							be undone.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={isDeletingVault}>
							Cancel
						</AlertDialogCancel>
						<AlertDialogAction
							onClick={handleDeleteVault}
							disabled={isDeletingVault}
							className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
						>
							{isDeletingVault ? "Deleting..." : "Delete"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
