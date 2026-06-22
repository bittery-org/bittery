import {
	useCreateItem,
	useDeleteItem,
	useItem,
	useToggleFavorite,
	useUpdateItem,
} from "@bittery/core/hooks";
import { detectCardBrand } from "@bittery/shared/credit-card";
import { getItemServerUrl } from "@bittery/shared/favicon";
import type { DecryptedItem, DecryptedItemData } from "@bittery/shared/types";
import {
	Button,
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
	ItemAttachments,
	ItemDetail,
	PasswordHistoryDialog,
	ShareHistoryDialog,
	ShareItemDialog,
	toast,
} from "@bittery/ui";
import {
	IconArrowsLeftRightTrailOutlineDuo18,
	IconCopyOutlineDuo18,
	IconDotsOutlineDuo18,
	IconHistoryOutlineDuo18,
	IconPen2OutlineDuo18,
	IconShareLeft2OutlineDuo18,
	IconStarOutlineDuo18,
	IconTrash2OutlineDuo18,
} from "@bittery/ui/icons";
import { useNavigate } from "@tanstack/react-router";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useState } from "react";
import { useI18n } from "../../providers/i18n-provider";
import Loader from "../loader";
import { Favicon } from "./favicon";
import { VaultInfoPopover } from "./item-categories/shared/vault-info-popover";
import { MoveItemDialog } from "./move-item-dialog";

interface VaultInfo {
	name: string;
	type?: "personal" | "team";
	icon?: string | null;
	imageUrl?: string | null;
	accountName?: string;
	accountTeamName?: string;
	accountTeamAvatarUrl?: string | null;
}

interface ItemDetailPageProps {
	itemId: string;
	vaultInfo?: VaultInfo;
	availableTags: string[];
	onTagClick: (tagName: string) => void;
}

export function ItemDetailPage({
	itemId,
	vaultInfo,
	availableTags,
	onTagClick,
}: ItemDetailPageProps) {
	const { m } = useI18n();
	const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
	const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
	const [isShareDialogOpen, setIsShareDialogOpen] = useState(false);
	const [isShareHistoryOpen, setIsShareHistoryOpen] = useState(false);
	const [isPasswordHistoryOpen, setIsPasswordHistoryOpen] = useState(false);
	const [isMoveDialogOpen, setIsMoveDialogOpen] = useState(false);
	const [isUpdatingTags, setIsUpdatingTags] = useState(false);

	const navigate = useNavigate();
	// Unified hook - automatically handles account detection
	const { rawItem, decryptedData, isLoading } = useItem(itemId);

	// Shared hooks for item operations
	const updateItem = useUpdateItem();
	const deleteItem = useDeleteItem();
	const toggleFavorite = useToggleFavorite();
	const createItem = useCreateItem();

	const handleTagsChange = useCallback(
		(newTags: string[]) => {
			if (!rawItem || !decryptedData) return;

			setIsUpdatingTags(true);

			const updatedData: DecryptedItemData = {
				...decryptedData,
				tags: newTags.length > 0 ? newTags : undefined,
			};

			updateItem.mutate(
				{
					itemId: rawItem.id,
					vaultId: rawItem.vaultId,
					data: updatedData,
				},
				{
					onSettled: () => {
						setIsUpdatingTags(false);
					},
					// Don't show toast for tag updates (silent update)
				},
			);
		},
		[rawItem, decryptedData, updateItem],
	);

	const handleRemovePasskey = useCallback(
		async (credentialId: string) => {
			if (!rawItem || !decryptedData || rawItem.category !== "login") return;

			const currentPasskeys = decryptedData.passkeys ?? [];
			const nextPasskeys = currentPasskeys.filter(
				(passkey) => passkey.credentialId !== credentialId,
			);
			if (nextPasskeys.length === currentPasskeys.length) {
				return;
			}

			const updatedData: DecryptedItemData = {
				...decryptedData,
				passkeys: nextPasskeys.length > 0 ? nextPasskeys : undefined,
			};

			try {
				await updateItem.mutateAsync({
					itemId: rawItem.id,
					vaultId: rawItem.vaultId,
					data: updatedData,
				});
				toast.success(
					m.vaults_detail_items_detail_page_toast_passkey_removed(),
				);
			} catch (error) {
				const errorMessage =
					error instanceof Error
						? error.message
						: m.vaults_detail_items_detail_page_toast_passkey_remove_error();
				toast.error(errorMessage);
			}
		},
		[rawItem, decryptedData, m, updateItem],
	);

	const handleShare = () => {
		setIsShareDialogOpen(true);
	};

	const handleDelete = () => {
		setIsDeleteDialogOpen(true);
	};

	const handleDuplicate = async () => {
		if (!rawItem || !decryptedData) return;

		try {
			const titleForDuplicate =
				decryptedData.title ||
				m.vaults_detail_items_detail_page_duplicate_default_title();

			const duplicatedData: DecryptedItemData = {
				...decryptedData,
				title: m.vaults_detail_items_detail_page_duplicate_title({
					title: titleForDuplicate,
				}),
			};

			const result = await createItem.mutateAsync({
				vaultId: rawItem.vaultId,
				category: rawItem.category,
				data: duplicatedData,
			});

			toast.success(m.vaults_detail_items_detail_page_toast_item_duplicated());

			// Navigate to the duplicated item
			navigate({
				to: "/vault/$id/$itemId",
				params: { id: rawItem.vaultId, itemId: result.itemId },
			});
		} catch (error) {
			const errorMessage =
				error instanceof Error
					? error.message
					: m.vaults_detail_items_detail_page_toast_item_duplicate_error();
			toast.error(errorMessage);
		}
	};

	const handleRestorePassword = useCallback(
		async (password: string) => {
			if (!rawItem) {
				return;
			}

			try {
				await updateItem.mutateAsync({
					itemId: rawItem.id,
					vaultId: rawItem.vaultId,
					data: { password },
				});
				toast.success(
					m.vaults_detail_items_password_history_dialog_toast_restore_success(),
				);
				setIsPasswordHistoryOpen(false);
			} catch (error) {
				const errorMessage =
					error instanceof Error
						? error.message
						: m.vaults_detail_items_password_history_dialog_toast_restore_error();
				toast.error(errorMessage);
			}
		},
		[rawItem, m, updateItem],
	);

	const confirmDelete = async () => {
		if (!rawItem) return;

		try {
			await deleteItem.mutateAsync({
				itemId: rawItem.id,
				vaultId: rawItem.vaultId,
			});

			toast.success(m.vaults_detail_toast_item_moved_to_trash());

			// Navigate back to vault
			navigate({ to: "/vault/$id", params: { id: rawItem.vaultId } });
		} catch (error) {
			const errorMessage =
				error instanceof Error
					? error.message
					: m.vaults_detail_toast_item_delete_error();
			toast.error(errorMessage);
		}
	};

	const getCategoryDisplayName = (category: string) => {
		switch (category) {
			case "secure-note":
				return m.vaults_detail_items_category_secure_note_title();
			case "credit-card":
				return m.vaults_detail_items_category_credit_card_title();
			case "identity":
				return m.vaults_detail_items_category_identity_title();
			case "totp":
				return m.vaults_detail_items_category_totp_title();
			default:
				return m.vaults_detail_items_category_login_title();
		}
	};

	if (isLoading || !decryptedData) {
		return <Loader />;
	}

	return (
		<>
			<div className="flex min-w-0 flex-1 flex-col">
				{/* Top bar */}
				<div className="mb-3 flex min-w-0 items-center justify-between px-4 py-2">
					<div className="-ml-2 min-w-0">
						<VaultInfoPopover
							vaultName={
								vaultInfo?.name ||
								m.vaults_detail_items_detail_page_vault_unknown()
							}
							vaultIcon={vaultInfo?.icon}
							vaultImageUrl={vaultInfo?.imageUrl}
							vaultType={vaultInfo?.type}
							accountName={vaultInfo?.accountName}
							accountTeamName={vaultInfo?.accountTeamName}
							accountTeamAvatarUrl={vaultInfo?.accountTeamAvatarUrl}
						/>
					</div>
					<div className="flex shrink-0 items-center gap-2">
						<Button variant="ghost" size="sm" onClick={handleShare}>
							<IconShareLeft2OutlineDuo18 />
							{m.sharing_item_dialog_trigger()}
						</Button>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setIsEditDialogOpen(true)}
						>
							<IconPen2OutlineDuo18 />
							{m.vaults_detail_items_detail_action_edit()}
						</Button>
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button variant="ghost" size="icon">
									<IconDotsOutlineDuo18 className="size-4" />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuItem
									onClick={handleDuplicate}
									disabled={createItem.isPending}
								>
									<IconCopyOutlineDuo18 className="size-4" />
									{m.vaults_detail_items_detail_page_action_duplicate()}
								</DropdownMenuItem>
								<DropdownMenuItem onClick={() => setIsMoveDialogOpen(true)}>
									<IconArrowsLeftRightTrailOutlineDuo18 className="size-4" />
									{m.vaults_detail_items_move_dialog_action_open()}
								</DropdownMenuItem>
								<DropdownMenuItem
									onClick={async () => {
										if (!rawItem) return;
										try {
											await toggleFavorite.mutateAsync({
												itemId: rawItem.id,
												vaultId: rawItem.vaultId,
												favorite: !rawItem.favorite,
											});
											toast.success(
												!rawItem.favorite
													? m.vaults_detail_items_detail_page_toast_favorite_added()
													: m.vaults_detail_items_detail_page_toast_favorite_removed(),
											);
										} catch (error) {
											const errorMessage =
												error instanceof Error
													? error.message
													: m.vaults_detail_items_list_toast_favorite_update_failed();
											toast.error(errorMessage);
										}
									}}
									disabled={toggleFavorite.isPending}
								>
									<IconStarOutlineDuo18
										className="size-4"
										fill={rawItem?.favorite ? "currentColor" : "none"}
									/>
									{rawItem?.favorite
										? m.vaults_detail_items_list_item_action_remove_favorite()
										: m.vaults_detail_items_list_item_action_add_favorite()}
								</DropdownMenuItem>
								<DropdownMenuItem onClick={() => setIsShareHistoryOpen(true)}>
									<IconHistoryOutlineDuo18 className="size-4" />
									{m.sharing_history_dialog_title()}
								</DropdownMenuItem>
								{rawItem?.category === "login" && (
									<DropdownMenuItem
										onClick={() => setIsPasswordHistoryOpen(true)}
									>
										<IconHistoryOutlineDuo18 className="size-4" />
										{m.vaults_detail_items_password_history_dialog_title()}
									</DropdownMenuItem>
								)}
								<DropdownMenuSeparator />
								<DropdownMenuItem
									onClick={handleDelete}
									className="text-destructive focus:text-destructive"
								>
									<IconTrash2OutlineDuo18 className="size-4" />
									{m.vaults_detail_items_detail_action_delete()}
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				</div>

				{/* Content area */}
				<div className="min-w-0 flex-1 overflow-y-auto px-4 py-3">
					<ItemDetail
						category={rawItem?.category ?? "login"}
						data={decryptedData}
						icon={
							rawItem ? (
								<Favicon
									url={
										rawItem.category === "login" ? decryptedData.url : undefined
									}
									title={decryptedData.title}
									serverUrl={getItemServerUrl(rawItem)}
									category={rawItem.category}
									cardBrand={
										rawItem.category === "credit-card" &&
										"cardNumber" in decryptedData &&
										decryptedData.cardNumber
											? detectCardBrand(decryptedData.cardNumber)
											: undefined
									}
									size="lg"
								/>
							) : undefined
						}
						onRemovePasskey={handleRemovePasskey}
						onTagsChange={handleTagsChange}
						onTagClick={onTagClick}
						availableTags={availableTags}
						isUpdatingTags={isUpdatingTags}
						onOpenUrl={openUrl}
					/>
					{rawItem && (
						<ItemAttachments
							itemId={rawItem.id}
							vaultId={rawItem.vaultId}
							accountEmail={rawItem.accountEmail ?? rawItem.account?.email}
							canEdit
						/>
					)}
				</div>
			</div>

			{/* Edit Item Sheet */}
			<EditItemSheet
				open={isEditDialogOpen && !!decryptedData && !!rawItem}
				onOpenChange={setIsEditDialogOpen}
				item={
					decryptedData && rawItem
						? {
								...decryptedData,
								category: rawItem.category,
								vaultId: rawItem.vaultId,
							}
						: null
				}
				description={m.vaults_detail_items_detail_page_edit_dialog_description({
					category: getCategoryDisplayName(rawItem?.category ?? "login"),
				})}
				onUpdateItem={async (data) => {
					if (!rawItem) return;
					try {
						await updateItem.mutateAsync({
							itemId: rawItem.id,
							vaultId: rawItem.vaultId,
							data,
						});
						toast.success(m.vaults_detail_toast_item_updated());
						setIsEditDialogOpen(false);
					} catch (error) {
						const errorMessage =
							error instanceof Error
								? error.message
								: m.vaults_detail_items_form_toast_save_item_failed();
						toast.error(errorMessage);
					}
				}}
				isSubmitting={updateItem.isPending}
				dataTestId="edit-item-dialog"
			/>

			{/* Delete Confirmation Dialog */}
			<Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
				<DialogContent>
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
							onClick={() => setIsDeleteDialogOpen(false)}
						>
							{m.vaults_detail_delete_item_dialog_action_cancel()}
						</Button>
						<Button
							variant="destructive"
							onClick={confirmDelete}
							disabled={deleteItem.isPending}
						>
							{m.vaults_detail_delete_item_dialog_action_confirm()}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* Share Item Dialog */}
			{rawItem && decryptedData && (
				<ShareItemDialog
					open={isShareDialogOpen}
					onOpenChange={setIsShareDialogOpen}
					item={
						{
							id: rawItem.id,
							vaultId: rawItem.vaultId,
							category: rawItem.category,
							favorite: rawItem.favorite,
							createdAt: rawItem.createdAt,
							updatedAt: rawItem.updatedAt,
							...decryptedData,
						} as DecryptedItem
					}
				/>
			)}

			{/* Share History Dialog */}
			{rawItem && (
				<ShareHistoryDialog
					itemId={rawItem.id}
					open={isShareHistoryOpen}
					onOpenChange={setIsShareHistoryOpen}
				/>
			)}

			{/* Password History Dialog */}
			{rawItem?.category === "login" && decryptedData && (
				<PasswordHistoryDialog
					open={isPasswordHistoryOpen}
					onOpenChange={setIsPasswordHistoryOpen}
					passwordHistory={decryptedData.passwordHistory}
					currentPassword={decryptedData.password}
					onRestorePassword={handleRestorePassword}
					isRestoring={updateItem.isPending}
				/>
			)}

			{/* Move Item Dialog */}
			{rawItem && decryptedData && (
				<MoveItemDialog
					open={isMoveDialogOpen}
					onOpenChange={setIsMoveDialogOpen}
					item={
						{
							id: rawItem.id,
							vaultId: rawItem.vaultId,
							category: rawItem.category,
							favorite: rawItem.favorite,
							createdAt: rawItem.createdAt,
							updatedAt: rawItem.updatedAt,
							...decryptedData,
						} as DecryptedItem
					}
					currentVaultId={rawItem.vaultId}
				/>
			)}
		</>
	);
}
