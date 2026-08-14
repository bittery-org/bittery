import {
	getAttachmentUploadErrorCode,
	useCreateItem,
	useCreateShare,
	useDeleteItem,
	useItem,
	useItemAttachments,
	useQueryInvalidator,
	useToggleFavorite,
	useUpdateItem,
	type VaultInfoWithAccount,
} from "@bittery/core/hooks";
import { useApiClient } from "@bittery/shared/api";
import { apiQueries } from "@bittery/shared/api-query";
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
	IconArrowLeftRight,
	IconCopy,
	IconEllipsis,
	IconHistory,
	IconPencil,
	IconShare,
	IconStar,
	IconTrash,
} from "@bittery/ui/icons";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useState } from "react";
import { useI18n } from "../../providers/i18n-provider";
import Loader from "../loader";
import { Favicon } from "./favicon";
import { VaultInfoPopover } from "./item-categories/shared/vault-info-popover";
import { MoveItemDialog } from "./move-item-dialog";

interface ItemDetailPageProps {
	itemId: string;
	/** The item's vault and the account holding it, straight from `useVaultInfo`. */
	vaultInfo?: VaultInfoWithAccount | null;
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
	const itemAccountId = rawItem?.accountId ?? rawItem?.account?.accountId;

	// Shared hooks for item operations
	const updateItem = useUpdateItem();
	const deleteItem = useDeleteItem();
	const toggleFavorite = useToggleFavorite();
	const createItem = useCreateItem();
	const createShare = useCreateShare();
	const api = useApiClient();
	const invalidator = useQueryInvalidator();
	const itemAttachments = useItemAttachments(
		rawItem?.id,
		rawItem?.vaultId,
		itemAccountId ?? "",
	);
	const shareLinks = useQuery({
		...apiQueries.shares.list(api, rawItem?.id ?? ""),
		enabled: Boolean(rawItem) && isShareHistoryOpen,
		staleTime: 0,
	});

	const handleTagsChange = useCallback(
		(newTags: string[]) => {
			if (!rawItem || !decryptedData || !itemAccountId) return;

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
					accountId: itemAccountId,
				},
				{
					onSettled: () => {
						setIsUpdatingTags(false);
					},
					// Don't show toast for tag updates (silent update)
				},
			);
		},
		[rawItem, decryptedData, itemAccountId, updateItem],
	);

	const handleRemovePasskey = useCallback(
		async (credentialId: string) => {
			if (
				!rawItem ||
				!decryptedData ||
				!itemAccountId ||
				rawItem.category !== "login"
			)
				return;

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
					accountId: itemAccountId,
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
		[rawItem, decryptedData, itemAccountId, m, updateItem],
	);

	const handleShare = () => {
		setIsShareDialogOpen(true);
	};

	const handleDelete = () => {
		setIsDeleteDialogOpen(true);
	};

	const handleDuplicate = async () => {
		if (!rawItem || !decryptedData || !itemAccountId) return;

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
				accountId: itemAccountId,
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
			if (!rawItem || !itemAccountId) {
				return;
			}

			try {
				await updateItem.mutateAsync({
					itemId: rawItem.id,
					vaultId: rawItem.vaultId,
					data: { password },
					accountId: itemAccountId,
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
		[rawItem, itemAccountId, m, updateItem],
	);

	const confirmDelete = async () => {
		if (!rawItem || !itemAccountId) return;

		try {
			await deleteItem.mutateAsync({
				itemId: rawItem.id,
				vaultId: rawItem.vaultId,
				accountId: itemAccountId,
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
				<div className="flex h-9 min-w-0 shrink-0 items-center justify-between border-b px-2.5">
					<div className="min-w-0">
						<VaultInfoPopover
							vaultName={
								vaultInfo?.vaultName ||
								m.vaults_detail_items_detail_page_vault_unknown()
							}
							vaultIcon={vaultInfo?.vaultIcon}
							vaultImageUrl={vaultInfo?.vaultImageUrl}
							accountName={vaultInfo?.accountName}
							accountTeamName={vaultInfo?.accountTeamName}
						/>
					</div>
					<div className="flex shrink-0 items-center gap-1">
						<Button variant="ghost" size="sm" onClick={handleShare}>
							<IconShare />
							{m.sharing_item_dialog_trigger()}
						</Button>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setIsEditDialogOpen(true)}
						>
							<IconPencil />
							{m.vaults_detail_items_detail_action_edit()}
						</Button>
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button variant="ghost" size="sm" className="size-7 p-0">
									<IconEllipsis className="size-4" />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuItem
									onClick={handleDuplicate}
									disabled={createItem.isPending}
								>
									<IconCopy className="size-4" />
									{m.vaults_detail_items_detail_page_action_duplicate()}
								</DropdownMenuItem>
								<DropdownMenuItem onClick={() => setIsMoveDialogOpen(true)}>
									<IconArrowLeftRight className="size-4" />
									{m.vaults_detail_items_move_dialog_action_open()}
								</DropdownMenuItem>
								<DropdownMenuItem
									onClick={async () => {
										if (!rawItem || !itemAccountId) return;
										try {
											await toggleFavorite.mutateAsync({
												itemId: rawItem.id,
												vaultId: rawItem.vaultId,
												favorite: !rawItem.favorite,
												accountId: itemAccountId,
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
									<IconStar
										className="size-4"
										fill={rawItem?.favorite ? "currentColor" : "none"}
									/>
									{rawItem?.favorite
										? m.vaults_detail_items_list_item_action_remove_favorite()
										: m.vaults_detail_items_list_item_action_add_favorite()}
								</DropdownMenuItem>
								<DropdownMenuItem onClick={() => setIsShareHistoryOpen(true)}>
									<IconHistory className="size-4" />
									{m.sharing_history_dialog_title()}
								</DropdownMenuItem>
								{rawItem?.category === "login" && (
									<DropdownMenuItem
										onClick={() => setIsPasswordHistoryOpen(true)}
									>
										<IconHistory className="size-4" />
										{m.vaults_detail_items_password_history_dialog_title()}
									</DropdownMenuItem>
								)}
								<DropdownMenuSeparator />
								<DropdownMenuItem
									onClick={handleDelete}
									className="text-destructive focus:text-destructive"
								>
									<IconTrash className="size-4" />
									{m.vaults_detail_items_detail_action_delete()}
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				</div>

				{/* Content area */}
				<div className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
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
							attachments={itemAttachments.attachments}
							isLoading={itemAttachments.isLoading}
							attachmentMaxFileSizeBytes={
								itemAttachments.attachmentMaxFileSizeBytes
							}
							onDecryptMeta={itemAttachments.decryptMeta}
							onUpload={(file) => itemAttachments.upload.mutateAsync(file)}
							onDownload={(attachment) =>
								itemAttachments.download.mutateAsync(attachment)
							}
							onRename={(attachmentId, newName) =>
								itemAttachments.rename.mutateAsync({ attachmentId, newName })
							}
							onDelete={(attachmentId) =>
								itemAttachments.remove.mutateAsync(attachmentId)
							}
							getUploadErrorCode={getAttachmentUploadErrorCode}
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
					if (!rawItem || !itemAccountId) return;
					try {
						await updateItem.mutateAsync({
							itemId: rawItem.id,
							vaultId: rawItem.vaultId,
							data,
							accountId: itemAccountId,
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
					onCreateShare={(request) => createShare.mutateAsync(request)}
				/>
			)}

			{/* Share History Dialog */}
			{rawItem && (
				<ShareHistoryDialog
					links={shareLinks.data?.links ?? []}
					isLoading={shareLinks.isLoading}
					onRevoke={async (linkId) => {
						await api.share.remove(linkId);
						await invalidator.invalidateShare(rawItem.id);
					}}
					onLoadAccessLogs={async (linkId) =>
						(await api.share.accessLogs(linkId)).data
					}
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
