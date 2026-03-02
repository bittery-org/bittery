import {
	useAvailableTags,
	useCreateItem,
	useDeleteItem,
	useDeleteVault,
	useUpdateItem,
	useUpdateVault,
	useVaultInfo,
	useVaultItems,
} from "@bittery/core/hooks";
import { useTRPC } from "@bittery/shared/trpc";
import type {
	DecryptedItem,
	DecryptedItemData,
	ItemCategory,
} from "@bittery/shared/types";
import {
	Badge,
	Button,
	cn,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Sheet,
	SheetContent,
	Skeleton,
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
	toast,
	useSidebar,
} from "@bittery/ui";
import {
	IconArrowLeftOutlineDuo18 as ArrowLeft,
	IconKeyOutlineDuo18 as Key,
	IconLockOutlineDuo18 as Lock,
	IconPen2OutlineDuo18 as Pen,
	IconPlusOutlineDuo18 as Plus,
	IconTrash2OutlineDuo18 as Trash,
	IconUsers6OutlineDuo18 as Users,
} from "@bittery/ui/icons";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { CreateItemSheet } from "@/components/vault/create-item-sheet";
import ItemDetail from "@/components/vault/item-detail";
import { ItemForm } from "@/components/vault/item-form";
import type { VaultOption } from "@/components/vault/types";
import { AddMemberDialog } from "@/components/vaults/add-member-dialog";
import { DeleteVaultDialog } from "@/components/vaults/delete-vault-dialog";
import {
	type UpdateVaultData,
	EditVaultDialog,
} from "@/components/vaults/edit-vault-dialog";
import { VaultMemberList } from "@/components/vaults/vault-member-list";
import { VaultAvatar } from "@/components/vaults/vault-avatar";
import { ItemList } from "@/components/vault/item-list";

export const Route = createFileRoute("/_app/vaults/$vaultId/")({
	component: VaultDetailPage,
	head: () => ({
		meta: [{ title: "Vault - Bittery" }],
	}),
});

function VaultDetailPage() {
	const { vaultId } = Route.useParams();
	const navigate = useNavigate();
	const trpc = useTRPC();

	const { state: sidebarState, isMobile } = useSidebar();
	const [selectedItem, setSelectedItem] = useState<DecryptedItem | null>(null);
	const [showCompactHeader, setShowCompactHeader] = useState(false);
	const [isCreateItemSheetOpen, setIsCreateItemSheetOpen] = useState(false);
	const [isEditItemDialogOpen, setIsEditItemDialogOpen] = useState(false);
	const [isDeleteItemDialogOpen, setIsDeleteItemDialogOpen] = useState(false);
	const [isEditVaultDialogOpen, setIsEditVaultDialogOpen] = useState(false);
	const [isDeleteVaultDialogOpen, setIsDeleteVaultDialogOpen] = useState(false);
	const [pendingItemIdToSelect, setPendingItemIdToSelect] = useState<
		string | null
	>(null);
	const headerRef = useRef<HTMLElement>(null);

	// Use core hooks for vault metadata and items (local-first, same as desktop)
	const { vaultInfo, isLoading: isLoadingVault } = useVaultInfo(vaultId);
	const { items: decryptedItems, isLoading: isLoadingItems } =
		useVaultItems(vaultId);
	const createItem = useCreateItem();
	const updateItem = useUpdateItem();
	const deleteItem = useDeleteItem();
	const updateVault = useUpdateVault();
	const deleteVault = useDeleteVault();

	// Observe main header visibility to show compact fixed header on scroll
	useEffect(() => {
		if (isLoadingVault) {
			setShowCompactHeader(false);
			return;
		}

		const el = headerRef.current;
		if (!el) return;

		// Find nearest scrollable ancestor (the overflow-y-auto container)
		let scrollParent: HTMLElement | null = el.parentElement;
		while (scrollParent) {
			const overflow = getComputedStyle(scrollParent).overflowY;
			if (
				overflow === "auto" ||
				overflow === "scroll" ||
				overflow === "overlay"
			) {
				break;
			}
			scrollParent = scrollParent.parentElement;
		}

		const observer = new IntersectionObserver(
			([entry]) => {
				if (entry) setShowCompactHeader(!entry.isIntersecting);
			},
			{ root: scrollParent, threshold: 0 },
		);

		observer.observe(el);
		return () => observer.disconnect();
	}, [isLoadingVault]);

	useEffect(() => {
		if (!pendingItemIdToSelect) {
			return;
		}

		const itemToSelect = decryptedItems.find(
			(item) => item.id === pendingItemIdToSelect,
		);
		if (itemToSelect) {
			setSelectedItem(itemToSelect);
			setPendingItemIdToSelect(null);
		}
	}, [decryptedItems, pendingItemIdToSelect]);

	useEffect(() => {
		if (!selectedItem) {
			return;
		}

		const stillExists = decryptedItems.some((item) => item.id === selectedItem.id);
		if (!stillExists) {
			setSelectedItem(null);
			setIsEditItemDialogOpen(false);
			setIsDeleteItemDialogOpen(false);
		}
	}, [decryptedItems, selectedItem]);

	// Members still come from tRPC (no local hook for membership data)
	const membersQuery = useQuery(
		trpc.vault.members.list.queryOptions({ vaultId }),
	);

	// Get available tags from decrypted items
	const availableTags = useAvailableTags(decryptedItems);

	const role = vaultInfo?.role;
	const canWriteItems = role !== "read-only";
	const canEditVault = role === "owner" || role === "admin";
	const canDeleteVault = role === "owner";
	const canManageMembers = canEditVault;
	const itemCount = decryptedItems.length;
	const memberCount = membersQuery.data?.length ?? 0;

	const handleItemSelect = (item: DecryptedItem) => {
		setSelectedItem(item);
	};

	const handleCloseSheet = () => {
		setSelectedItem(null);
	};

	const handleCreateItem = async (
		data: DecryptedItemData,
		targetVaultId: string,
		category: ItemCategory,
	) => {
		const result = await createItem.mutateAsync({
			vaultId: targetVaultId,
			category,
			data,
		});
		setPendingItemIdToSelect(result.itemId);
		setIsCreateItemSheetOpen(false);
		toast.success("Item created successfully");
	};

	const handleUpdateItem = async (data: DecryptedItemData) => {
		if (!selectedItem) {
			return;
		}

		await updateItem.mutateAsync({
			itemId: selectedItem.id,
			vaultId: selectedItem.vaultId,
			data,
		});
		setIsEditItemDialogOpen(false);
		toast.success("Item updated successfully");
	};

	const handleDeleteItem = async () => {
		if (!selectedItem) {
			return;
		}

		try {
			await deleteItem.mutateAsync({
				itemId: selectedItem.id,
				vaultId: selectedItem.vaultId,
			});
			setIsDeleteItemDialogOpen(false);
			setSelectedItem(null);
			toast.success("Item moved to trash");
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : "Failed to delete item";
			toast.error(errorMessage);
		}
	};

	const handleUpdateVault = async (targetVaultId: string, data: UpdateVaultData) => {
		await updateVault.mutateAsync({
			vaultId: targetVaultId,
			name: data.name,
			icon: data.icon,
			imageFile: data.imageFile,
			removeImage: data.removeImage,
		});
	};

	const handleDeleteVault = async (targetVaultId: string) => {
		await deleteVault.mutateAsync({
			vaultId: targetVaultId,
		});
		toast.success("Vault deleted successfully");
		navigate({ to: "/vaults" });
	};

	if (isLoadingVault) {
		return (
			<div className="mx-auto w-full max-w-6xl space-y-6">
				<Skeleton className="h-48 w-full rounded-2xl" />
				<Skeleton className="h-64" />
			</div>
		);
	}

	if (!vaultInfo) {
		return (
			<div className="flex flex-col items-center gap-3 py-12 text-center">
				<div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
					<Lock className="h-6 w-6 text-muted-foreground" />
				</div>
				<p className="text-muted-foreground">Vault not found</p>
				<Link to="/vaults" className="text-primary text-sm hover:underline">
					Back to vaults
				</Link>
			</div>
		);
	}

	const roleBadgeVariant =
		role === "owner" ? "default" : role === "admin" ? "secondary" : "outline";

	const compactHeaderLeft = isMobile
		? "0px"
		: sidebarState === "expanded"
			? "var(--sidebar-width)"
			: "calc(var(--sidebar-width-icon) + 1.5rem)";

	const itemFormVaults: VaultOption[] = [
		{
			id: vaultInfo.vaultId,
			name: vaultInfo.vaultName,
			type: vaultInfo.vaultType,
			icon: vaultInfo.vaultIcon,
			imageUrl: vaultInfo.vaultImageUrl,
		},
	];

	return (
		<>
			<div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-6 pb-3">
				{/* Compact fixed header (visible on scroll) */}
				<div
					className={cn(
						"fixed",
						"top-0",
						"right-0",
						"z-50",
						"flex",
						"h-11",
						"items-center",
						"border-b",
						"bg-background/80",
						"backdrop-blur-sm",
						"transition-[left,opacity,transform]",
						"duration-200",
						showCompactHeader && vaultInfo
							? "translate-y-0 opacity-100"
							: "pointer-events-none -translate-y-full opacity-0",
					)}
					style={{ left: compactHeaderLeft }}
				>
					<div className="mx-auto flex h-full w-full max-w-6xl items-center justify-between pr-5 pl-14 lg:pr-6 lg:pl-16 xl:pl-6">
						{vaultInfo && (
							<>
							<div className="flex items-center gap-2.5">
								<VaultAvatar
									name={vaultInfo.vaultName}
									icon={vaultInfo.vaultIcon}
									imageUrl={vaultInfo.vaultImageUrl}
									size="xs"
								/>
									<span className="font-medium text-sm">
										{vaultInfo.vaultName}
									</span>
									<Badge
										variant={roleBadgeVariant}
										className="px-1.5 py-0 text-[11px] capitalize"
									>
										{role}
									</Badge>
								</div>
								<Button variant="ghost" size="sm" className="h-7 text-xs" asChild>
									<Link to="/vaults">
										<ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
										All Vaults
									</Link>
								</Button>
							</>
						)}
					</div>
				</div>

				{/* Header */}
				<section
					ref={headerRef}
					className="relative overflow-hidden rounded-2xl border bg-card p-6 sm:p-7 lg:rounded-xl lg:p-5"
				>
					<div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-muted/60 via-transparent to-transparent lg:from-muted/30" />

					<div className="relative flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between lg:gap-4">
						<div className="flex flex-col items-center gap-4 text-center lg:flex-row lg:items-center lg:gap-3.5 lg:text-left">
							<VaultAvatar
								name={vaultInfo.vaultName}
								icon={vaultInfo.vaultIcon}
								imageUrl={vaultInfo.vaultImageUrl}
								size="lg"
								className="h-14 w-14 rounded-xl shadow-sm lg:h-10 lg:w-10 lg:rounded-lg"
							/>
							<div className="space-y-3 lg:space-y-0.5">
								<div className="flex flex-wrap items-center justify-center gap-2 lg:hidden">
									<Badge variant="secondary" className="capitalize">
										{vaultInfo.vaultType} vault
									</Badge>
									<Badge variant={roleBadgeVariant} className="capitalize">
										{role}
									</Badge>
								</div>
								<div className="space-y-1.5 lg:space-y-0">
									<div className="flex flex-wrap items-center justify-center gap-2.5 lg:justify-start">
										<h1 className="text-balance font-bold text-3xl tracking-tight md:text-4xl lg:font-semibold lg:text-xl">
											{vaultInfo.vaultName}
										</h1>
										<div className="hidden items-center gap-1.5 lg:flex">
											<Badge
												variant="secondary"
												className="px-1.5 py-0 text-[11px] capitalize"
											>
												{vaultInfo.vaultType}
											</Badge>
											<Badge
												variant={roleBadgeVariant}
												className="px-1.5 py-0 text-[11px] capitalize"
											>
												{role}
											</Badge>
										</div>
									</div>
									<p className="text-center text-muted-foreground lg:text-left lg:text-xs">
										{itemCount} item{itemCount !== 1 ? "s" : ""} · {memberCount}{" "}
										member
										{memberCount !== 1 ? "s" : ""}
									</p>
								</div>
								<div className="flex flex-wrap items-center justify-center gap-2 text-muted-foreground text-xs lg:hidden">
									<div className="inline-flex items-center gap-1.5 rounded-md border bg-background/70 px-2.5 py-1">
										<Key className="h-3.5 w-3.5" />
										{itemCount} item{itemCount !== 1 ? "s" : ""} encrypted
									</div>
									<div className="inline-flex items-center gap-1.5 rounded-md border bg-background/70 px-2.5 py-1">
										<Users className="h-3.5 w-3.5" />
										{memberCount} member
										{memberCount !== 1 ? "s" : ""}
									</div>
								</div>
							</div>
						</div>

						<div className="flex w-full flex-wrap items-center justify-center gap-2 lg:w-auto lg:justify-end">
							<Button
								variant="outline"
								size="sm"
								className="h-8 px-2 text-xs lg:px-3"
								asChild
							>
								<Link to="/vaults">
									<ArrowLeft
										className={cn(
											"h-3.5 w-3.5",
											!isMobile ? "mr-1.5" : undefined,
										)}
									/>
									{!isMobile ? "All Vaults" : null}
								</Link>
							</Button>
							{canWriteItems && (
								<Button
									size="sm"
									className="h-8 px-2 text-xs lg:px-3"
									onClick={() => setIsCreateItemSheetOpen(true)}
									data-testid="new-item-button"
								>
									<Plus
										className={cn(
											"h-3.5 w-3.5",
											!isMobile ? "mr-1.5" : undefined,
										)}
									/>
									{!isMobile ? "New Item" : null}
								</Button>
							)}
							{canEditVault && (
								<Button
									variant="outline"
									size="sm"
									className="h-8 px-2 text-xs lg:px-3"
									onClick={() => setIsEditVaultDialogOpen(true)}
									data-testid="edit-vault-button"
								>
									<Pen
										className={cn(
											"h-3.5 w-3.5",
											!isMobile ? "mr-1.5" : undefined,
										)}
									/>
									{!isMobile ? "Edit Vault" : null}
								</Button>
							)}
							{canDeleteVault && (
								<Button
									variant="outline"
									size="sm"
									className="h-8 px-2 text-xs lg:px-3"
									onClick={() => setIsDeleteVaultDialogOpen(true)}
									data-testid="delete-vault-button"
								>
									<Trash
										className={cn(
											"h-3.5 w-3.5",
											!isMobile ? "mr-1.5" : undefined,
										)}
									/>
									{!isMobile ? "Delete Vault" : null}
								</Button>
							)}
							{canManageMembers && vaultInfo.vaultType === "team" && (
								<AddMemberDialog vaultId={vaultId} />
							)}
						</div>
					</div>
				</section>

				{/* Tabs Area */}
				<Tabs defaultValue="items" className="flex min-h-0 flex-1 flex-col">
					<TabsList className="w-fit shrink-0">
						<TabsTrigger value="items">
							<Key className="mr-2 h-4 w-4" />
							Items
						</TabsTrigger>
						<TabsTrigger value="members">
							<Users className="mr-2 h-4 w-4" />
							Members
							{memberCount > 1 && (
								<span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-muted-foreground text-xs">
									{memberCount}
								</span>
							)}
						</TabsTrigger>
					</TabsList>

					<TabsContent value="items" className="mt-4 flex min-h-0 flex-1 flex-col">
						<div className="flex min-h-0 flex-1 flex-col space-y-3">
							<div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
								<h2 className="font-semibold text-lg tracking-tight">Vault Items</h2>
								<p className="text-muted-foreground text-sm">
									{canWriteItems
										? "Click on an item to view or update details."
										: "You have read-only access to this vault."}
								</p>
							</div>
							<div className="min-h-0 flex-1">
								<ItemList
									items={decryptedItems}
									isLoading={isLoadingItems}
									vaultId={vaultId}
									onItemSelect={handleItemSelect}
									selectedItemId={selectedItem?.id}
									canWriteItems={canWriteItems}
								/>
							</div>
						</div>
					</TabsContent>

					<TabsContent value="members" className="mt-4">
						<div className="space-y-3">
							<div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
								<h2 className="font-semibold text-lg tracking-tight">Vault Members</h2>
								<p className="text-muted-foreground text-sm">
									{canManageMembers
										? "Manage who has access and their permissions."
										: "People who have access to this vault."}
								</p>
							</div>
							{membersQuery.isLoading ? (
								<div className="grid gap-3 sm:grid-cols-2">
									<Skeleton className="h-28" />
									<Skeleton className="h-28" />
								</div>
							) : (
								<VaultMemberList
									vaultId={vaultId}
									members={membersQuery.data || []}
									userRole={role ?? "member"}
								/>
							)}
						</div>

						{vaultInfo.vaultType === "personal" && (
							<div className="mt-4 flex items-center gap-3 rounded-xl border border-dashed p-5 text-muted-foreground text-sm">
								<Lock className="h-5 w-5 shrink-0" />
								<p>
									This is a personal vault. To share access with others, convert
									it to a team vault in the desktop app.
								</p>
							</div>
						)}
					</TabsContent>
				</Tabs>

				{/* Item Detail Sheet */}
				<Sheet
					open={!!selectedItem}
					onOpenChange={(open) => !open && handleCloseSheet()}
				>
					<SheetContent className="w-full min-w-0 sm:max-w-2xl" data-testid="item-detail-sheet">
						<div className="h-full min-w-0 overflow-y-auto">
							{selectedItem && (
								<ItemDetail
									category={selectedItem.category}
									data={selectedItem}
									item={selectedItem}
									vaultId={vaultId}
									availableTags={availableTags}
									canEdit={canWriteItems}
									onEdit={canWriteItems ? () => setIsEditItemDialogOpen(true) : undefined}
									onDelete={canWriteItems ? () => setIsDeleteItemDialogOpen(true) : undefined}
								/>
							)}
						</div>
					</SheetContent>
				</Sheet>
			</div>

			{/* Create Item Sheet */}
			<CreateItemSheet
				open={isCreateItemSheetOpen}
				onOpenChange={setIsCreateItemSheetOpen}
				vaults={itemFormVaults}
				selectedVaultId={vaultId}
				onCreateItem={handleCreateItem}
			/>

			{/* Edit Item Dialog */}
			<Dialog open={isEditItemDialogOpen} onOpenChange={setIsEditItemDialogOpen}>
				<DialogContent className="flex max-h-[85vh] max-w-2xl flex-col" data-testid="edit-item-dialog">
					<DialogHeader className="shrink-0">
						<DialogTitle>Edit Item</DialogTitle>
						<DialogDescription>
							Update your selected vault item.
						</DialogDescription>
					</DialogHeader>
					{selectedItem && (
						<ItemForm
							category={selectedItem.category}
							initialData={selectedItem}
							onSubmit={async (data) => {
								await handleUpdateItem(data as DecryptedItemData);
							}}
							onCancel={() => setIsEditItemDialogOpen(false)}
							isSubmitting={updateItem.isPending || !canWriteItems}
							submitLabel="Update"
							selectedVaultId={vaultId}
						/>
					)}
				</DialogContent>
			</Dialog>

			{/* Delete Item Confirmation Dialog */}
			<Dialog open={isDeleteItemDialogOpen} onOpenChange={setIsDeleteItemDialogOpen}>
				<DialogContent data-testid="delete-item-dialog">
					<DialogHeader>
						<DialogTitle>Move to Trash?</DialogTitle>
						<DialogDescription>
							This item will be moved to trash. You can restore it later or
							delete it permanently from the trash.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => setIsDeleteItemDialogOpen(false)}
							disabled={deleteItem.isPending}
							data-testid="delete-item-cancel-button"
						>
							Cancel
						</Button>
						<Button
							variant="destructive"
							onClick={handleDeleteItem}
							disabled={deleteItem.isPending || !canWriteItems}
							data-testid="delete-item-confirm-button"
						>
							Move to Trash
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* Vault Management Dialogs */}
			<EditVaultDialog
				key={vaultInfo.vaultId}
				open={isEditVaultDialogOpen}
				onOpenChange={setIsEditVaultDialogOpen}
				vault={{
					id: vaultInfo.vaultId,
					name: vaultInfo.vaultName,
					icon: vaultInfo.vaultIcon,
					imageUrl: vaultInfo.vaultImageUrl,
				}}
				onSubmit={handleUpdateVault}
			/>

			<DeleteVaultDialog
				open={isDeleteVaultDialogOpen}
				onOpenChange={setIsDeleteVaultDialogOpen}
				vault={{ id: vaultInfo.vaultId, name: vaultInfo.vaultName }}
				onConfirm={handleDeleteVault}
			/>
		</>
	);
}
