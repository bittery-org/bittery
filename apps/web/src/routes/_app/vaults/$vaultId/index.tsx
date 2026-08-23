import {
	useAvailableTags,
	useConvertVaultType,
	useCreateItem,
	useDeleteItem,
	useUpdateItem,
	useVaultInfo,
} from "@bittery/core/hooks";
import { m as messages } from "@bittery/i18n/paraglide/messages";
import { useApiClient } from "@bittery/shared/api";
import { apiQueries } from "@bittery/shared/api-query";
import type {
	DecryptedItem,
	DecryptedItemData,
	ItemCategory,
} from "@bittery/shared/types";
import {
	Badge,
	Button,
	CreateItemSheet,
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
	EditItemSheet,
	Skeleton,
	toast,
	VaultAvatar,
	type VaultOption,
} from "@bittery/ui";
import {
	IconEllipsis as Dots,
	IconLock as Lock,
	IconPlus as Plus,
	IconUsers as Users,
} from "@bittery/ui/icons";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { z } from "zod";
import { ItemDetailPane } from "@/components/vault/item-detail-pane";
import { ItemList } from "@/components/vault/item-list";
import { ItemListState } from "@/components/vault/item-list-state";
import { AddMemberDialog } from "@/components/vaults/add-member-dialog";
import { VaultMemberList } from "@/components/vaults/vault-member-list";
import { useRuntimeItems } from "@/hooks/use-runtime-items";
import { useI18n } from "@/providers/i18n-provider";

export const Route = createFileRoute("/_app/vaults/$vaultId/")({
	validateSearch: z.object({
		itemId: z.string().optional(),
	}),
	component: VaultDetailPage,
	head: () => ({
		meta: [{ title: messages.vaults_detail_meta_title() }],
	}),
});

function VaultDetailPage() {
	const { vaultId } = Route.useParams();
	const { itemId: selectedItemIdFromSearch } = Route.useSearch();
	const navigate = useNavigate();
	const api = useApiClient();
	const { m } = useI18n();

	const [isCreateItemSheetOpen, setIsCreateItemSheetOpen] = useState(false);
	const [isEditItemDialogOpen, setIsEditItemDialogOpen] = useState(false);
	const [isDeleteItemDialogOpen, setIsDeleteItemDialogOpen] = useState(false);
	const [isMembersDialogOpen, setIsMembersDialogOpen] = useState(false);
	const [isMakeSharedDialogOpen, setIsMakeSharedDialogOpen] = useState(false);
	const [isMakePrivateDialogOpen, setIsMakePrivateDialogOpen] = useState(false);

	const { vaultInfo, isLoading: isLoadingVault } = useVaultInfo(vaultId);
	const { items: allItems, state: itemsState } = useRuntimeItems();
	const decryptedItems = useMemo(
		() => allItems.filter((item) => item.vaultId === vaultId),
		[allItems, vaultId],
	);
	const selectedItemId =
		selectedItemIdFromSearch &&
		decryptedItems.some((item) => item.id === selectedItemIdFromSearch)
			? selectedItemIdFromSearch
			: null;
	const selectedItem =
		selectedItemId === null
			? null
			: (decryptedItems.find((item) => item.id === selectedItemId) ?? null);
	const createItem = useCreateItem();
	const updateItem = useUpdateItem();
	const deleteItem = useDeleteItem();
	const convertVaultType = useConvertVaultType();

	const membersQuery = useQuery(apiQueries.vaults.members(api, vaultId));

	const availableTags = useAvailableTags(decryptedItems);

	const role = vaultInfo?.role;
	const isOwner = role === "owner";
	const canWriteItems = role !== "read-only";
	const canManageMembers = role === "owner" || role === "admin";
	const canMakeShared = isOwner && vaultInfo?.vaultType === "personal";
	const canMakePrivate = isOwner && vaultInfo?.vaultType === "team";
	const hasMemberData = Array.isArray(membersQuery.data);
	const memberCount = membersQuery.data?.length ?? 0;
	const canMakePrivateNow =
		canMakePrivate && hasMemberData && memberCount === 1;
	const showMakePrivateDisabledAction = canMakePrivate && !canMakePrivateNow;
	const showMakePrivateDisabledReason =
		canMakePrivate && hasMemberData && memberCount > 1;
	const hasVaultConversionActions =
		canMakeShared || canMakePrivateNow || showMakePrivateDisabledAction;
	const hasManageActions = canManageMembers || hasVaultConversionActions;
	const itemCount = decryptedItems.length;

	const handleItemSelect = (item: DecryptedItem) => {
		navigate({
			to: "/vaults/$vaultId",
			params: { vaultId },
			search: { itemId: item.id },
		});
	};

	const handleCloseDetail = () => {
		navigate({
			to: "/vaults/$vaultId",
			params: { vaultId },
			search: { itemId: undefined },
		});
	};

	const handleCreateItem = async (
		data: DecryptedItemData,
		targetVaultId: string,
		category: ItemCategory,
	) => {
		if (!vaultInfo?.accountId || targetVaultId !== vaultInfo.vaultId) {
			throw new Error("Vault account is unavailable");
		}
		const result = await createItem.mutateAsync({
			vaultId: targetVaultId,
			accountId: vaultInfo.accountId,
			category,
			data,
		});
		navigate({
			to: "/vaults/$vaultId",
			params: { vaultId },
			search: { itemId: result.itemId },
		});
		setIsCreateItemSheetOpen(false);
		toast.success(m.vaults_detail_toast_item_created());
	};

	const handleUpdateItem = async (data: DecryptedItemData) => {
		if (!selectedItem) return;
		await updateItem.mutateAsync({
			itemId: selectedItem.id,
			vaultId: selectedItem.vaultId,
			accountId: selectedItem.accountId,
			data,
		});
		setIsEditItemDialogOpen(false);
		toast.success(m.vaults_detail_toast_item_updated());
	};

	const handleDeleteItem = async () => {
		if (!selectedItem) return;
		try {
			await deleteItem.mutateAsync({
				itemId: selectedItem.id,
				vaultId: selectedItem.vaultId,
				accountId: selectedItem.accountId,
			});
			setIsDeleteItemDialogOpen(false);
			navigate({
				to: "/vaults/$vaultId",
				params: { vaultId },
				search: { itemId: undefined },
			});
			toast.success(m.vaults_detail_toast_item_moved_to_trash());
		} catch {
			toast.error(m.vaults_detail_toast_item_delete_error());
		}
	};

	const handleConvertVaultType = async (targetType: "personal" | "team") => {
		try {
			if (!vaultInfo?.accountId) throw new Error();
			await convertVaultType.mutateAsync({
				vaultId,
				targetType,
				accountId: vaultInfo.accountId,
			});
			if (targetType === "team") {
				setIsMakeSharedDialogOpen(false);
				toast.success(m.vaults_detail_toast_convert_to_shared_success());
			} else {
				setIsMakePrivateDialogOpen(false);
				toast.success(m.vaults_detail_toast_convert_to_private_success());
			}
		} catch (error) {
			const apiMessage =
				error instanceof Error && error.message.trim().length > 0
					? error.message
					: null;
			toast.error(apiMessage ?? m.vaults_detail_toast_convert_failed());
		}
	};

	if (isLoadingVault) {
		return (
			<div className="flex w-full flex-1 items-center justify-center">
				<Skeleton className="h-48 w-64 rounded-xl" />
			</div>
		);
	}

	if (!vaultInfo) {
		return (
			<div className="flex w-full flex-1 flex-col items-center justify-center gap-3 text-center">
				<div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
					<Lock className="h-6 w-6 text-muted-foreground" />
				</div>
				<p className="text-muted-foreground">
					{m.vaults_detail_empty_not_found()}
				</p>
			</div>
		);
	}

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
			{/* Middle pane: vault header + item list */}
			<div
				className={cn(
					"flex w-full shrink-0 flex-col border-r md:w-78",
					selectedItemId && "hidden md:flex",
				)}
			>
				{/* Vault header */}
				<div className="flex h-11 shrink-0 items-center gap-2 border-b px-2.5 xl:h-12">
					<VaultAvatar
						name={vaultInfo.vaultName}
						icon={vaultInfo.vaultIcon}
						imageUrl={vaultInfo.vaultImageUrl}
						size="xs"
					/>
					<span className="min-w-0 truncate font-medium text-sm">
						{vaultInfo.vaultName}
					</span>
					<Badge variant="secondary" className="ml-auto shrink-0">
						{itemCount}
					</Badge>
					<div className="flex shrink-0 items-center gap-1">
						{canWriteItems && (
							<Button
								variant="ghost"
								size="sm"
								className="size-7 p-0"
								onClick={() => setIsCreateItemSheetOpen(true)}
								data-testid="new-item-button"
							>
								<Plus className="size-3.5" />
							</Button>
						)}
						{hasManageActions && (
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<Button
										variant="ghost"
										size="sm"
										className="size-7 p-0"
										data-testid="vault-menu-button"
									>
										<Dots className="size-3.5" />
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end">
									{canManageMembers && (
										<DropdownMenuItem
											onClick={() => setIsMembersDialogOpen(true)}
										>
											<Users className="h-4 w-4" />
											{m.vaults_detail_tab_members()}
										</DropdownMenuItem>
									)}
									{canManageMembers && hasVaultConversionActions && (
										<DropdownMenuSeparator />
									)}
									{canMakeShared && (
										<DropdownMenuItem
											onClick={() => setIsMakeSharedDialogOpen(true)}
											disabled={convertVaultType.isPending}
											data-testid="make-shared-button"
										>
											<Users className="h-4 w-4" />
											{m.vaults_detail_convert_action_make_shared()}
										</DropdownMenuItem>
									)}
									{canMakePrivateNow && (
										<DropdownMenuItem
											onClick={() => setIsMakePrivateDialogOpen(true)}
											disabled={convertVaultType.isPending}
											data-testid="make-private-button"
										>
											<Lock className="h-4 w-4" />
											{m.vaults_detail_convert_action_make_private()}
										</DropdownMenuItem>
									)}
									{showMakePrivateDisabledAction && (
										<DropdownMenuItem
											disabled
											data-testid="make-private-button-disabled"
										>
											<Lock className="h-4 w-4" />
											{m.vaults_detail_convert_action_make_private()}
										</DropdownMenuItem>
									)}
									{showMakePrivateDisabledReason && (
										<DropdownMenuItem disabled>
											{m.vaults_detail_convert_make_private_disabled_reason({
												count: memberCount,
											})}
										</DropdownMenuItem>
									)}
								</DropdownMenuContent>
							</DropdownMenu>
						)}
					</div>
				</div>

				{/* Item list */}
				<div className="flex min-h-0 flex-1 flex-col overflow-hidden py-1">
					{itemsState === "ready" ? (
						<ItemList
							items={decryptedItems}
							isLoading={false}
							onItemSelect={handleItemSelect}
							selectedItemId={selectedItemId ?? undefined}
						/>
					) : (
						<ItemListState state={itemsState} />
					)}
				</div>
			</div>

			{/* Right pane: item detail */}
			<ItemDetailPane
				selectedItem={selectedItem}
				selectedItemId={selectedItemId}
				availableTags={availableTags}
				canWriteItems={canWriteItems}
				onClose={handleCloseDetail}
				onEdit={() => setIsEditItemDialogOpen(true)}
				onDelete={() => setIsDeleteItemDialogOpen(true)}
			/>

			{/* Create Item Sheet */}
			<CreateItemSheet
				open={isCreateItemSheetOpen}
				onOpenChange={setIsCreateItemSheetOpen}
				vaults={itemFormVaults}
				selectedVaultId={vaultId}
				onCreateItem={handleCreateItem}
			/>

			{/* Edit Item Sheet */}
			<EditItemSheet
				open={isEditItemDialogOpen && !!selectedItem}
				onOpenChange={setIsEditItemDialogOpen}
				item={selectedItem}
				onUpdateItem={handleUpdateItem}
				isSubmitting={updateItem.isPending || !canWriteItems}
				dataTestId="edit-item-dialog"
			/>

			{/* Delete Item Confirmation Dialog */}
			<Dialog
				open={isDeleteItemDialogOpen && !!selectedItem}
				onOpenChange={setIsDeleteItemDialogOpen}
			>
				<DialogContent data-testid="delete-item-dialog">
					<DialogHeader>
						<DialogTitle>
							{m.vaults_detail_delete_item_dialog_title()}
						</DialogTitle>
						<DialogDescription>
							{m.vaults_detail_delete_item_dialog_description()}
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => setIsDeleteItemDialogOpen(false)}
							disabled={deleteItem.isPending}
							data-testid="delete-item-cancel-button"
						>
							{m.vaults_detail_delete_item_dialog_action_cancel()}
						</Button>
						<Button
							variant="destructive"
							onClick={handleDeleteItem}
							disabled={deleteItem.isPending || !canWriteItems}
							data-testid="delete-item-confirm-button"
						>
							{m.vaults_detail_delete_item_dialog_action_confirm()}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* Members Dialog */}
			<Dialog open={isMembersDialogOpen} onOpenChange={setIsMembersDialogOpen}>
				<DialogContent className="max-w-2xl">
					<DialogHeader>
						<DialogTitle>{m.vaults_nav_members_dialog_title()}</DialogTitle>
						<DialogDescription>
							{canManageMembers
								? m.vaults_detail_members_description_can_manage()
								: m.vaults_detail_members_description_read_only()}
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-4">
						{canManageMembers && vaultInfo.vaultType === "team" && (
							<AddMemberDialog vaultId={vaultId} />
						)}
						{membersQuery.isLoading ? (
							<div className="space-y-1 overflow-hidden rounded-xl border">
								<Skeleton className="h-13 rounded-none" />
								<Skeleton className="h-13 rounded-none" />
							</div>
						) : (
							<VaultMemberList
								vaultId={vaultId}
								members={[...(membersQuery.data || [])]}
								userRole={role ?? "member"}
							/>
						)}
						{vaultInfo.vaultType === "personal" && (
							<div className="flex items-center gap-3 rounded-xl border border-dashed p-5 text-muted-foreground text-sm">
								<Lock className="h-5 w-5 shrink-0" />
								<p>{m.vaults_detail_members_personal_hint()}</p>
							</div>
						)}
					</div>
					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => setIsMembersDialogOpen(false)}
						>
							{m.vaults_nav_members_dialog_close()}
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
							{m.vaults_detail_convert_confirm_make_shared_title()}
						</DialogTitle>
						<DialogDescription>
							{m.vaults_detail_convert_confirm_make_shared_description()}
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => setIsMakeSharedDialogOpen(false)}
							disabled={convertVaultType.isPending}
						>
							{m.settings_common_action_cancel()}
						</Button>
						<Button
							onClick={() => handleConvertVaultType("team")}
							disabled={convertVaultType.isPending}
							data-testid="make-shared-confirm-button"
						>
							{m.vaults_detail_convert_confirm_make_shared_action_confirm()}
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
							{m.vaults_detail_convert_confirm_make_private_title()}
						</DialogTitle>
						<DialogDescription>
							{m.vaults_detail_convert_confirm_make_private_description()}
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => setIsMakePrivateDialogOpen(false)}
							disabled={convertVaultType.isPending}
						>
							{m.settings_common_action_cancel()}
						</Button>
						<Button
							onClick={() => handleConvertVaultType("personal")}
							disabled={convertVaultType.isPending}
							data-testid="make-private-confirm-button"
						>
							{m.vaults_detail_convert_confirm_make_private_action_confirm()}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
