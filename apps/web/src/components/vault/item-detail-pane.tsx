import { useToggleFavorite, useUpdateItem } from "@bittery/core/hooks";
import { detectCardBrand } from "@bittery/shared/credit-card";
import type { DecryptedItem, DecryptedItemData } from "@bittery/shared/types";
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
	IconArrowLeftOutlineDuo18 as ArrowLeft,
	IconDotsOutlineDuo18 as Dots,
	IconHistoryOutlineDuo18 as History,
	IconKeyOutlineDuo18 as Key,
	IconPen2OutlineDuo18 as Pen,
	IconShareLeft2OutlineDuo18 as Share,
	IconStarOutlineDuo18 as Star,
	IconTrash2OutlineDuo18 as Trash,
} from "@bittery/ui/icons";
import { type ReactNode, useCallback, useState } from "react";
import { Favicon } from "@/components/vault/favicon";
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
	selectedItem: DecryptedItem | null;
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
	const [isShareDialogOpen, setIsShareDialogOpen] = useState(false);
	const [isShareHistoryOpen, setIsShareHistoryOpen] = useState(false);
	const [isPasswordHistoryOpen, setIsPasswordHistoryOpen] = useState(false);
	const [isUpdatingTags, setIsUpdatingTags] = useState(false);

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
		>
			{selectedItem ? (
				<>
					<div className="flex items-center justify-between border-b px-3 py-2.5">
						<Button
							variant="ghost"
							size="sm"
							className="h-8 w-8 p-0 md:hidden"
							onClick={onClose}
						>
							<ArrowLeft className="h-4 w-4" />
						</Button>
						<div className="hidden md:block" />
						<div className="flex items-center gap-1">						<Button
							variant="ghost"
							size="sm"
							onClick={() => setIsShareDialogOpen(true)}
						>
							<Share className="mr-1.5 h-4 w-4" />
							{m.sharing_item_dialog_trigger()}
						</Button>							{canWriteItems && (
								<Button
									variant="ghost"
									size="sm"
									onClick={onEdit}
								>
									<Pen className="mr-1.5 h-4 w-4" />
									{m.vaults_detail_items_detail_action_edit()}
								</Button>
							)}
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<Button
										variant="ghost"
										size="sm"
										className="h-8 w-8 p-0"
									>
										<Dots className="h-4 w-4" />
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end">
									<DropdownMenuItem
										onClick={() =>
											toggleFavorite.mutate({
												itemId: selectedItem.id,
												vaultId: selectedItem.vaultId,
												favorite: !selectedItem.favorite,
											})
										}
									>
										<Star
											className="h-4 w-4"
											fill={
												selectedItem.favorite
													? "currentColor"
													: "none"
											}
										/>
										{selectedItem.favorite
											? m.vaults_detail_items_list_item_action_remove_favorite()
											: m.vaults_detail_items_list_item_action_add_favorite()}
									</DropdownMenuItem>								<DropdownMenuItem
									onClick={() => setIsShareHistoryOpen(true)}
								>
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
							)}								{canWriteItems && (
										<>
											<DropdownMenuSeparator />
											<DropdownMenuItem
												variant="destructive"
												onClick={onDelete}
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
					<div className="min-h-0 flex-1 overflow-y-auto p-4">
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
											? detectCardBrand(
													selectedItem.cardNumber,
												)
											: undefined
									}
									size="lg"
								/>
							}
							onOpenUrl={(url) =>
								window.open(
									url,
									"_blank",
									"noopener,noreferrer",
								)
							}
							onTagsChange={canWriteItems ? handleTagsChange : undefined}
							onTagClick={onTagClick}
							availableTags={availableTags}
							isUpdatingTags={isUpdatingTags}
						/>
						<ItemAttachments
							itemId={selectedItem.id}
							vaultId={selectedItem.vaultId}
							canEdit={canWriteItems}
							handleDownloadedFile={handleDownloadedFile}
						/>
					</div>

					<ShareItemDialog
						item={selectedItem}
						open={isShareDialogOpen}
						onOpenChange={setIsShareDialogOpen}
					/>
					<ShareHistoryDialog
						itemId={selectedItem.id}
						open={isShareHistoryOpen}
						onOpenChange={setIsShareHistoryOpen}
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
						<div className="mb-4 inline-flex rounded-full bg-muted p-6">
							{emptyIcon ?? (
								<Key className="size-12 text-muted-foreground" />
							)}
						</div>
						<h3 className="mb-2 font-semibold text-lg">
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
