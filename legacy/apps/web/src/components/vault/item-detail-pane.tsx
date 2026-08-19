import {
	getAttachmentUploadErrorCode,
	type UnifiedItem,
	useCreateShare,
	useItemAttachments,
	useQueryInvalidator,
	useToggleFavorite,
	useUpdateItem,
} from "@bittery/core/hooks";
import { useApiClient } from "@bittery/shared/api";
import { apiQueries } from "@bittery/shared/api-query";
import { detectCardBrand } from "@bittery/shared/credit-card";
import type { DecryptedItemData } from "@bittery/shared/types";
import {
	Button,
	cn,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
	ItemAttachments,
	ItemDetail,
	PasswordHistoryDialog,
	ShareHistoryDialog,
	ShareItemDialog,
	toast,
} from "@bittery/ui";
import {
	IconArrowLeft as ArrowLeft,
	IconArrowLeftRight as ArrowLeftRight,
	IconEllipsis as Dots,
	IconHistory as History,
	IconKey as Key,
	IconPencil as Pen,
	IconShare as Share,
	IconStar as Star,
	IconTrash as Trash,
} from "@bittery/ui/icons";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useCallback, useState } from "react";
import { Favicon } from "@/components/vault/favicon";
import { MoveItemDialog } from "@/components/vault/move-item-dialog";
import { useI18n } from "@/providers/i18n-provider";

export function handleDownloadedFile(bytes: Uint8Array, fileName: string) {
	const blob = new Blob([bytes as unknown as BlobPart]);
	const url = URL.createObjectURL(blob);
	const lowerName = fileName.toLowerCase();
	const isImage =
		lowerName.endsWith(".png") ||
		lowerName.endsWith(".jpg") ||
		lowerName.endsWith(".jpeg") ||
		lowerName.endsWith(".gif") ||
		lowerName.endsWith(".webp") ||
		lowerName.endsWith(".svg");
	const isPdf = lowerName.endsWith(".pdf");
	if (isImage || isPdf) {
		window.open(url, "_blank", "noopener,noreferrer");
	} else {
		const a = document.createElement("a");
		a.href = url;
		a.download = fileName;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
	}
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

interface ItemDetailPaneProps {
	selectedItem: UnifiedItem | null;
	selectedItemId: string | null;
	availableTags: string[];
	canWriteItems: boolean;
	onClose: () => void;
	onEdit: () => void;
	onDelete: () => void;
	onTagClick?: (tagName: string) => void;
	emptyIcon?: ReactNode;
}

export function ItemDetailPane({
	selectedItem,
	selectedItemId,
	availableTags,
	canWriteItems,
	onClose,
	onEdit,
	onDelete,
	onTagClick,
	emptyIcon,
}: ItemDetailPaneProps) {
	const { m } = useI18n();
	const toggleFavorite = useToggleFavorite();
	const updateItem = useUpdateItem();
	const createShare = useCreateShare();
	const api = useApiClient();
	const invalidator = useQueryInvalidator();
	const [isShareDialogOpen, setIsShareDialogOpen] = useState(false);
	const [isShareHistoryOpen, setIsShareHistoryOpen] = useState(false);
	const [isPasswordHistoryOpen, setIsPasswordHistoryOpen] = useState(false);
	const [isMoveDialogOpen, setIsMoveDialogOpen] = useState(false);
	const [isUpdatingTags, setIsUpdatingTags] = useState(false);
	const itemAttachments = useItemAttachments(
		selectedItem?.id,
		selectedItem?.vaultId,
		selectedItem?.accountId ?? "",
	);
	const shareLinks = useQuery({
		...apiQueries.shares.list(api, selectedItem?.id ?? ""),
		enabled: Boolean(selectedItem) && isShareHistoryOpen,
		staleTime: 0,
	});

	const handleTagsChange = useCallback(
		(newTags: string[]) => {
			if (!selectedItem) return;

			setIsUpdatingTags(true);

			const updatedData: DecryptedItemData = {
				...(selectedItem as DecryptedItemData),
				tags: newTags.length > 0 ? newTags : undefined,
			};

			updateItem.mutate(
				{
					itemId: selectedItem.id,
					vaultId: selectedItem.vaultId,
					accountId: selectedItem.accountId,
					data: updatedData,
				},
				{
					onSettled: () => {
						setIsUpdatingTags(false);
					},
				},
			);
		},
		[selectedItem, updateItem],
	);

	const handleRestorePassword = async (password: string) => {
		if (!selectedItem) return;
		try {
			await updateItem.mutateAsync({
				itemId: selectedItem.id,
				vaultId: selectedItem.vaultId,
				accountId: selectedItem.accountId,
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
	};

	return (
		<div
			className={cn(
				"flex min-w-0 flex-1 flex-col",
				!selectedItemId && "hidden md:flex",
			)}
			data-testid="item-detail-pane"
			data-item-id={selectedItem?.id}
		>
			{selectedItem ? (
				<>
					<div className="flex h-11 min-w-0 shrink-0 items-center justify-between border-b px-2.5 xl:h-12">
						<Button
							variant="ghost"
							size="sm"
							className="h-8 w-8 p-0 md:hidden"
							onClick={onClose}
						>
							<ArrowLeft className="h-4 w-4" />
						</Button>
						<div className="hidden md:block" />
						<div className="flex items-center gap-1">
							{" "}
							<Button
								variant="ghost"
								size="sm"
								onClick={() => setIsShareDialogOpen(true)}
								data-testid="item-share-button"
							>
								<Share className="mr-1.5 h-4 w-4" />
								{m.sharing_item_dialog_trigger()}
							</Button>{" "}
							{canWriteItems && (
								<Button
									variant="ghost"
									size="sm"
									onClick={onEdit}
									data-testid="item-edit-button"
								>
									<Pen className="mr-1.5 h-4 w-4" />
									{m.vaults_detail_items_detail_action_edit()}
								</Button>
							)}
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<Button variant="ghost" size="sm" className="size-7 p-0">
										<Dots className="h-4 w-4" />
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end">
									<DropdownMenuItem
										onClick={() =>
											toggleFavorite.mutate({
												itemId: selectedItem.id,
												vaultId: selectedItem.vaultId,
												accountId: selectedItem.accountId,
												favorite: !selectedItem.favorite,
											})
										}
										data-testid="item-favorite-button"
									>
										<Star
											className="h-4 w-4"
											fill={selectedItem.favorite ? "currentColor" : "none"}
										/>
										{selectedItem.favorite
											? m.vaults_detail_items_list_item_action_remove_favorite()
											: m.vaults_detail_items_list_item_action_add_favorite()}
									</DropdownMenuItem>{" "}
									<DropdownMenuItem onClick={() => setIsShareHistoryOpen(true)}>
										<History className="h-4 w-4" />
										{m.sharing_history_dialog_title()}
									</DropdownMenuItem>
									{selectedItem.category === "login" && (
										<DropdownMenuItem
											onClick={() => setIsPasswordHistoryOpen(true)}
										>
											<History className="h-4 w-4" />
											{m.vaults_detail_items_password_history_dialog_title()}
										</DropdownMenuItem>
									)}{" "}
									{canWriteItems && (
										<DropdownMenuItem
											onClick={() => setIsMoveDialogOpen(true)}
											data-testid="item-move-button"
										>
											<ArrowLeftRight className="h-4 w-4" />
											{m.vaults_detail_items_move_dialog_action_open()}
										</DropdownMenuItem>
									)}
									{canWriteItems && (
										<>
											<DropdownMenuSeparator />
											<DropdownMenuItem
												variant="destructive"
												onClick={onDelete}
												data-testid="item-delete-button"
											>
												<Trash className="h-4 w-4" />
												{m.vaults_detail_items_detail_action_delete()}
											</DropdownMenuItem>
										</>
									)}
								</DropdownMenuContent>
							</DropdownMenu>
						</div>
					</div>
					<div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
						<ItemDetail
							category={selectedItem.category}
							data={selectedItem}
							icon={
								<Favicon
									item={selectedItem}
									title={selectedItem.title}
									cardBrand={
										selectedItem.category === "credit-card" &&
										"cardNumber" in selectedItem &&
										typeof selectedItem.cardNumber === "string"
											? detectCardBrand(selectedItem.cardNumber)
											: undefined
									}
									size="lg"
								/>
							}
							onOpenUrl={(url) =>
								window.open(url, "_blank", "noopener,noreferrer")
							}
							onTagsChange={canWriteItems ? handleTagsChange : undefined}
							onTagClick={onTagClick}
							availableTags={availableTags}
							isUpdatingTags={isUpdatingTags}
						/>
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
							canEdit={canWriteItems}
							handleDownloadedFile={handleDownloadedFile}
						/>
					</div>

					<ShareItemDialog
						item={selectedItem}
						onCreateShare={(request) => createShare.mutateAsync(request)}
						open={isShareDialogOpen}
						onOpenChange={setIsShareDialogOpen}
					/>
					<ShareHistoryDialog
						links={shareLinks.data?.links ?? []}
						isLoading={shareLinks.isLoading}
						onRevoke={async (linkId) => {
							await api.share.remove(linkId);
							await invalidator.invalidateShare(selectedItem.id);
						}}
						onLoadAccessLogs={async (linkId) =>
							(await api.share.accessLogs(linkId)).data
						}
						open={isShareHistoryOpen}
						onOpenChange={setIsShareHistoryOpen}
					/>
					<MoveItemDialog
						open={isMoveDialogOpen}
						onOpenChange={setIsMoveDialogOpen}
						item={selectedItem}
						currentVaultId={selectedItem.vaultId}
					/>
					{selectedItem.category === "login" && (
						<PasswordHistoryDialog
							open={isPasswordHistoryOpen}
							onOpenChange={setIsPasswordHistoryOpen}
							passwordHistory={selectedItem.passwordHistory}
							currentPassword={selectedItem.password}
							onRestorePassword={handleRestorePassword}
							isRestoring={updateItem.isPending}
						/>
					)}
				</>
			) : (
				<div className="hidden flex-1 items-center justify-center p-8 text-center md:flex">
					<div>
						<div className="mb-4 inline-flex rounded-full border bg-foreground/3 p-5">
							{emptyIcon ?? <Key className="size-12 text-muted-foreground" />}
						</div>
						<h3 className="mb-2 font-medium text-sm">
							{m.vaults_shared_empty_no_item_selected()}
						</h3>
						<p className="text-muted-foreground text-sm">
							{m.vaults_shared_empty_select_item_to_view_details()}
						</p>
					</div>
				</div>
			)}
		</div>
	);
}
