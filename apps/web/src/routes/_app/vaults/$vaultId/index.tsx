import {
	useAvailableTags,
	useConvertVaultType,
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
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
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
	IconDotsOutlineDuo18 as Dots,
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
import { ItemList } from "@/components/vault/item-list";
import type { VaultOption } from "@/components/vault/types";
import { AddMemberDialog } from "@/components/vaults/add-member-dialog";
import { DeleteVaultDialog } from "@/components/vaults/delete-vault-dialog";
import {
	EditVaultDialog,
	type UpdateVaultData,
} from "@/components/vaults/edit-vault-dialog";
import { VaultAvatar } from "@/components/vaults/vault-avatar";
import { VaultMemberList } from "@/components/vaults/vault-member-list";
import { m as messages } from "@/paraglide/messages";
import { useI18n } from "@/providers/i18n-provider";

export const Route = createFileRoute("/_app/vaults/$vaultId/")({
	component: VaultDetailPage,
	head: () => ({
		meta: [{ title: messages["vaults.detail.meta_title"]() }],
	}),
});

type VaultMessageCatalog = ReturnType<typeof useI18n>["m"];

function getVaultRoleLabel(role: string, m: VaultMessageCatalog): string {
	switch (role) {
		case "owner":
			return m["vaults.common.role.owner"]();
		case "admin":
			return m["vaults.common.role.admin"]();
		case "member":
			return m["vaults.common.role.member"]();
		case "read-only":
			return m["vaults.common.role.read_only"]();
		default:
			return role;
	}
}

function getVaultTypeLabel(type: string, m: VaultMessageCatalog): string {
	switch (type) {
		case "personal":
			return m["vaults.common.type.personal"]();
		case "team":
			return m["vaults.common.type.team"]();
		default:
			return type;
	}
}

function VaultDetailPage() {
	const { vaultId } = Route.useParams();
	const navigate = useNavigate();
	const trpc = useTRPC();
	const { m } = useI18n();

	const { state: sidebarState, isMobile } = useSidebar();
	const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
	const [showCompactHeader, setShowCompactHeader] = useState(false);
	const [isCreateItemSheetOpen, setIsCreateItemSheetOpen] = useState(false);
	const [isEditItemDialogOpen, setIsEditItemDialogOpen] = useState(false);
	const [isDeleteItemDialogOpen, setIsDeleteItemDialogOpen] = useState(false);
	const [isEditVaultDialogOpen, setIsEditVaultDialogOpen] = useState(false);
	const [isDeleteVaultDialogOpen, setIsDeleteVaultDialogOpen] = useState(false);
	const [isMakeSharedDialogOpen, setIsMakeSharedDialogOpen] = useState(false);
	const [isMakePrivateDialogOpen, setIsMakePrivateDialogOpen] = useState(false);
	const [pendingItemIdToSelect, setPendingItemIdToSelect] = useState<
		string | null
	>(null);
	const headerRef = useRef<HTMLElement>(null);

	// Use core hooks for vault metadata and items (local-first, same as desktop)
	const { vaultInfo, isLoading: isLoadingVault } = useVaultInfo(vaultId);
	const { items: decryptedItems, isLoading: isLoadingItems } =
		useVaultItems(vaultId);
	const selectedItem =
		selectedItemId === null
			? null
			: (decryptedItems.find((item) => item.id === selectedItemId) ?? null);
	const createItem = useCreateItem();
	const updateItem = useUpdateItem();
	const deleteItem = useDeleteItem();
	const convertVaultType = useConvertVaultType();
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
			setSelectedItemId(itemToSelect.id);
			setPendingItemIdToSelect(null);
		}
	}, [decryptedItems, pendingItemIdToSelect]);

	useEffect(() => {
		if (!selectedItemId) {
			return;
		}

		const stillExists = decryptedItems.some(
			(item) => item.id === selectedItemId,
		);
		if (!stillExists) {
			setSelectedItemId(null);
			setIsEditItemDialogOpen(false);
			setIsDeleteItemDialogOpen(false);
		}
	}, [decryptedItems, selectedItemId]);

	// Members still come from tRPC (no local hook for membership data)
	const membersQuery = useQuery(
		trpc.vault.members.list.queryOptions({ vaultId }),
	);

	// Get available tags from decrypted items
	const availableTags = useAvailableTags(decryptedItems);

	const role = vaultInfo?.role;
	const isOwner = role === "owner";
	const canWriteItems = role !== "read-only";
	const canEditVault = role === "owner" || role === "admin";
	const canDeleteVault = role === "owner";
	const canManageMembers = canEditVault;
	const itemCount = decryptedItems.length;
	const hasMemberData = Array.isArray(membersQuery.data);
	const memberCount = membersQuery.data?.length ?? 0;
	const canMakeShared = isOwner && vaultInfo?.vaultType === "personal";
	const canMakePrivate = isOwner && vaultInfo?.vaultType === "team";
	const canMakePrivateNow =
		canMakePrivate && hasMemberData && memberCount === 1;
	const showMakePrivateDisabledAction = canMakePrivate && !canMakePrivateNow;
	const showMakePrivateDisabledReason =
		canMakePrivate && hasMemberData && memberCount > 1;
	const hasVaultConversionActions =
		canMakeShared || canMakePrivateNow || showMakePrivateDisabledAction;
	const hasVaultMenuActions =
		canEditVault || canDeleteVault || hasVaultConversionActions;

	const handleItemSelect = (item: DecryptedItem) => {
		setSelectedItemId(item.id);
	};

	const handleCloseSheet = () => {
		setSelectedItemId(null);
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
		toast.success(m["vaults.detail.toast.item_created"]());
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
		toast.success(m["vaults.detail.toast.item_updated"]());
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
			setSelectedItemId(null);
			toast.success(m["vaults.detail.toast.item_moved_to_trash"]());
		} catch {
			toast.error(m["vaults.detail.toast.item_delete_error"]());
		}
	};

	const handleUpdateVault = async (
		targetVaultId: string,
		data: UpdateVaultData,
	) => {
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
		toast.success(m["vaults.detail.toast.vault_deleted"]());
		navigate({ to: "/vaults" });
	};

	const handleConvertVaultType = async (targetType: "personal" | "team") => {
		try {
			await convertVaultType.mutateAsync({
				vaultId,
				targetType,
				accountEmail: vaultInfo?.accountEmail,
			});
			if (targetType === "team") {
				setIsMakeSharedDialogOpen(false);
				toast.success(m["vaults.detail.toast.convert_to_shared_success"]());
			} else {
				setIsMakePrivateDialogOpen(false);
				toast.success(m["vaults.detail.toast.convert_to_private_success"]());
			}
		} catch (error) {
			const apiMessage =
				error instanceof Error && error.message.trim().length > 0
					? error.message
					: null;
			toast.error(apiMessage ?? m["vaults.detail.toast.convert_failed"]());
		}
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
				<p className="text-muted-foreground">
					{m["vaults.detail.empty.not_found"]()}
				</p>
				<Link to="/vaults" className="text-primary text-sm hover:underline">
					{m["vaults.detail.empty.back_to_vaults"]()}
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
	const itemCountLabel =
		itemCount === 1
			? m["vaults.detail.count.items.single"]({ count: itemCount })
			: m["vaults.detail.count.items.plural"]({ count: itemCount });
	const memberCountLabel =
		memberCount === 1
			? m["vaults.detail.count.members.single"]({ count: memberCount })
			: m["vaults.detail.count.members.plural"]({ count: memberCount });
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
										{getVaultRoleLabel(role ?? "member", m)}
									</Badge>
								</div>
								<Button
									variant="ghost"
									size="sm"
									className="h-7 text-xs"
									asChild
								>
									<Link to="/vaults">
										<ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
										{m["vaults.detail.action.all_vaults"]()}
									</Link>
								</Button>
							</>
						)}
					</div>
				</div>

				{/* Header */}
				<section
					ref={headerRef}
					className="relative overflow-hidden rounded-2xl border bg-card p-3 sm:p-5 lg:rounded-xl lg:p-5"
				>
					<div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-muted/60 via-transparent to-transparent lg:from-muted/30" />

					<div className="relative flex flex-col gap-3 sm:gap-4 lg:flex-row lg:items-center lg:justify-between lg:gap-4">
						<div className="flex items-center gap-3 text-left lg:gap-3.5">
							<VaultAvatar
								name={vaultInfo.vaultName}
								icon={vaultInfo.vaultIcon}
								imageUrl={vaultInfo.vaultImageUrl}
								size="lg"
								className="h-9 w-9 shrink-0 rounded-lg shadow-sm sm:h-10 sm:w-10 lg:rounded-lg"
							/>
							<div className="min-w-0 space-y-0.5">
								<div className="flex flex-wrap items-center gap-2">
									<h1 className="truncate font-semibold text-lg tracking-tight sm:text-xl lg:text-xl">
										{vaultInfo.vaultName}
									</h1>
									<div className="flex items-center gap-1.5">
										<Badge
											variant="secondary"
											className="px-1.5 py-0 text-[11px] capitalize"
										>
											{getVaultTypeLabel(vaultInfo.vaultType, m)}
										</Badge>
										<Badge
											variant={roleBadgeVariant}
											className="px-1.5 py-0 text-[11px] capitalize"
										>
											{getVaultRoleLabel(role ?? "member", m)}
										</Badge>
									</div>
								</div>
								<p className="text-muted-foreground text-xs">
									{itemCountLabel} · {memberCountLabel}
								</p>
							</div>
						</div>

						<div className="flex w-full flex-wrap items-center gap-1.5 sm:gap-2 lg:w-auto lg:justify-end">
							<Button
								variant="outline"
								size="sm"
								className="h-8 px-2 text-xs sm:px-3"
								asChild
							>
								<Link to="/vaults">
									<ArrowLeft className="h-3.5 w-3.5 sm:mr-1.5" />
									<span className="hidden sm:inline">
										{m["vaults.detail.action.all_vaults"]()}
									</span>
								</Link>
							</Button>
							{canWriteItems && (
								<Button
									variant="outline"
									size="sm"
									className="h-8 px-2 text-xs sm:px-3"
									onClick={() => setIsCreateItemSheetOpen(true)}
									data-testid="new-item-button"
								>
									<Plus className="h-3.5 w-3.5 sm:mr-1.5" />
									<span className="hidden sm:inline">
										{m["vaults.detail.action.new_item"]()}
									</span>
								</Button>
							)}
							{hasVaultMenuActions && (
								<DropdownMenu>
									<DropdownMenuTrigger asChild>
										<Button
											variant="outline"
											size="sm"
											className="h-8 px-2 text-xs sm:px-3"
											data-testid="vault-menu-button"
										>
											<Dots className="h-3.5 w-3.5 sm:mr-1.5" />
											<span className="hidden sm:inline">
												{m["vaults.detail.action.manage"]()}
											</span>
										</Button>
									</DropdownMenuTrigger>
									<DropdownMenuContent align="end">
										{canEditVault && (
											<DropdownMenuItem
												onClick={() => setIsEditVaultDialogOpen(true)}
												data-testid="edit-vault-button"
											>
												<Pen className="h-4 w-4" />
												{m["vaults.detail.action.edit_vault"]()}
											</DropdownMenuItem>
										)}

										{canEditVault && hasVaultConversionActions && (
											<DropdownMenuSeparator />
										)}

										{canMakeShared && (
											<DropdownMenuItem
												onClick={() => setIsMakeSharedDialogOpen(true)}
												disabled={convertVaultType.isPending}
												data-testid="make-shared-button"
											>
												<Users className="h-4 w-4" />
												{m["vaults.detail.convert.action.make_shared"]()}
											</DropdownMenuItem>
										)}

										{canMakePrivateNow && (
											<DropdownMenuItem
												onClick={() => setIsMakePrivateDialogOpen(true)}
												disabled={convertVaultType.isPending}
												data-testid="make-private-button"
											>
												<Lock className="h-4 w-4" />
												{m["vaults.detail.convert.action.make_private"]()}
											</DropdownMenuItem>
										)}

										{showMakePrivateDisabledAction && (
											<DropdownMenuItem
												disabled
												data-testid="make-private-button-disabled"
											>
												<Lock className="h-4 w-4" />
												{m["vaults.detail.convert.action.make_private"]()}
											</DropdownMenuItem>
										)}

										{showMakePrivateDisabledReason && (
											<DropdownMenuItem disabled>
												{m[
													"vaults.detail.convert.make_private_disabled_reason"
												]({
													count: memberCount,
												})}
											</DropdownMenuItem>
										)}

										{hasVaultConversionActions && canDeleteVault && (
											<DropdownMenuSeparator />
										)}

										{canDeleteVault && (
											<DropdownMenuItem
												variant="destructive"
												onClick={() => setIsDeleteVaultDialogOpen(true)}
												data-testid="delete-vault-button"
											>
												<Trash className="h-4 w-4" />
												{m["vaults.detail.action.delete_vault"]()}
											</DropdownMenuItem>
										)}
									</DropdownMenuContent>
								</DropdownMenu>
							)}
						</div>
					</div>
				</section>

				{/* Tabs Area */}
				<Tabs defaultValue="items" className="flex min-h-0 flex-1 flex-col">
					<TabsList className="w-fit shrink-0">
						<TabsTrigger value="items">
							<Key className="mr-2 h-4 w-4" />
							{m["vaults.detail.tab.items"]()}
						</TabsTrigger>
						<TabsTrigger value="members">
							<Users className="mr-2 h-4 w-4" />
							{m["vaults.detail.tab.members"]()}
							{memberCount > 1 && (
								<span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-muted-foreground text-xs">
									{memberCount}
								</span>
							)}
						</TabsTrigger>
					</TabsList>

					<TabsContent
						value="items"
						className="mt-4 flex min-h-0 flex-1 flex-col"
					>
						<div className="flex min-h-0 flex-1 flex-col space-y-3">
							<div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
								<h2 className="font-semibold text-lg tracking-tight">
									{m["vaults.detail.items.heading"]()}
								</h2>
								<p className="text-muted-foreground text-sm">
									{canWriteItems
										? m["vaults.detail.items.description.can_write"]()
										: m["vaults.detail.items.description.read_only"]()}
								</p>
							</div>
							<div className="min-h-0 flex-1">
								<ItemList
									items={decryptedItems}
									isLoading={isLoadingItems}
									vaultId={vaultId}
									onItemSelect={handleItemSelect}
									selectedItemId={selectedItemId ?? undefined}
									canWriteItems={canWriteItems}
								/>
							</div>
						</div>
					</TabsContent>

					<TabsContent value="members" className="mt-4">
						<div className="space-y-4">
							<div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
								<div>
									<h2 className="font-semibold text-lg tracking-tight">
										{m["vaults.detail.members.heading"]()}
									</h2>
									<p className="text-muted-foreground text-sm">
										{canManageMembers
											? m["vaults.detail.members.description.can_manage"]()
											: m["vaults.detail.members.description.read_only"]()}
									</p>
								</div>
								{canManageMembers && vaultInfo.vaultType === "team" && (
									<AddMemberDialog vaultId={vaultId} />
								)}
							</div>
							{membersQuery.isLoading ? (
								<div className="space-y-1 overflow-hidden rounded-xl border">
									<Skeleton className="h-13 rounded-none" />
									<Skeleton className="h-13 rounded-none" />
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
								<p>{m["vaults.detail.members.personal_hint"]()}</p>
							</div>
						)}
					</TabsContent>
				</Tabs>

				{/* Item Detail Sheet */}
				<Sheet
					open={!!selectedItem}
					onOpenChange={(open) => !open && handleCloseSheet()}
				>
					<SheetContent
						className="w-full min-w-0 sm:max-w-2xl"
						data-testid="item-detail-sheet"
					>
						<div className="h-full min-w-0 overflow-y-auto">
							{selectedItem && (
								<ItemDetail
									category={selectedItem.category}
									data={selectedItem}
									item={selectedItem}
									vaultId={vaultId}
									availableTags={availableTags}
									canEdit={canWriteItems}
									onEdit={
										canWriteItems
											? () => setIsEditItemDialogOpen(true)
											: undefined
									}
									onDelete={
										canWriteItems
											? () => setIsDeleteItemDialogOpen(true)
											: undefined
									}
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
			<Dialog
				open={isEditItemDialogOpen}
				onOpenChange={setIsEditItemDialogOpen}
			>
				<DialogContent
					className="flex max-h-[85vh] max-w-2xl flex-col"
					data-testid="edit-item-dialog"
				>
					<DialogHeader className="shrink-0">
						<DialogTitle>
							{m["vaults.detail.edit_item_dialog.title"]()}
						</DialogTitle>
						<DialogDescription>
							{m["vaults.detail.edit_item_dialog.description"]()}
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
							submitLabel={m["vaults.detail.edit_item_dialog.action.submit"]()}
							selectedVaultId={vaultId}
						/>
					)}
				</DialogContent>
			</Dialog>

			{/* Delete Item Confirmation Dialog */}
			<Dialog
				open={isDeleteItemDialogOpen}
				onOpenChange={setIsDeleteItemDialogOpen}
			>
				<DialogContent data-testid="delete-item-dialog">
					<DialogHeader>
						<DialogTitle>
							{m["vaults.detail.delete_item_dialog.title"]()}
						</DialogTitle>
						<DialogDescription>
							{m["vaults.detail.delete_item_dialog.description"]()}
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => setIsDeleteItemDialogOpen(false)}
							disabled={deleteItem.isPending}
							data-testid="delete-item-cancel-button"
						>
							{m["vaults.detail.delete_item_dialog.action.cancel"]()}
						</Button>
						<Button
							variant="destructive"
							onClick={handleDeleteItem}
							disabled={deleteItem.isPending || !canWriteItems}
							data-testid="delete-item-confirm-button"
						>
							{m["vaults.detail.delete_item_dialog.action.confirm"]()}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* Vault Type Conversion Dialogs */}
			<Dialog
				open={isMakeSharedDialogOpen}
				onOpenChange={setIsMakeSharedDialogOpen}
			>
				<DialogContent data-testid="make-shared-dialog">
					<DialogHeader>
						<DialogTitle>
							{m["vaults.detail.convert.confirm.make_shared.title"]()}
						</DialogTitle>
						<DialogDescription>
							{m["vaults.detail.convert.confirm.make_shared.description"]()}
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => setIsMakeSharedDialogOpen(false)}
							disabled={convertVaultType.isPending}
						>
							{m["settings.common.action.cancel"]()}
						</Button>
						<Button
							onClick={() => handleConvertVaultType("team")}
							disabled={convertVaultType.isPending}
							data-testid="make-shared-confirm-button"
						>
							{m["vaults.detail.convert.confirm.make_shared.action.confirm"]()}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<Dialog
				open={isMakePrivateDialogOpen}
				onOpenChange={setIsMakePrivateDialogOpen}
			>
				<DialogContent data-testid="make-private-dialog">
					<DialogHeader>
						<DialogTitle>
							{m["vaults.detail.convert.confirm.make_private.title"]()}
						</DialogTitle>
						<DialogDescription>
							{m["vaults.detail.convert.confirm.make_private.description"]()}
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => setIsMakePrivateDialogOpen(false)}
							disabled={convertVaultType.isPending}
						>
							{m["settings.common.action.cancel"]()}
						</Button>
						<Button
							onClick={() => handleConvertVaultType("personal")}
							disabled={convertVaultType.isPending}
							data-testid="make-private-confirm-button"
						>
							{m["vaults.detail.convert.confirm.make_private.action.confirm"]()}
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
