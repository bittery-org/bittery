/**
 * M3-C2 — shared item detail body for every "$itemId" route (`/vault/$id/$itemId`,
 * `/vault/all-items/$itemId`, `/vault/favorites/$itemId`, `/vault/tag/$tagName/$itemId`). Each
 * route file is just `<ItemDetailScreen itemId={...} onBack={...} />` — the vault a
 * cross-vault-list item lives in is not in any of those URLs, but `useItem` already resolves it
 * (`rawItem.vaultId`), so one component covers every entry point instead of four near-copies.
 *
 * Wires `ItemDetail` (`@bittery/ui`) for edit/delete/tags/passkey-removal, adds favorite and
 * move as header icon buttons (neither is a prop `ItemDetail` accepts — see `ItemDetail`'s
 * props in `packages/ui/src/components/vault/item-detail/shared.tsx`), and reuses
 * `EditItemSheet` / `PasswordHistoryDialog` / `ConfirmDialog` / `MoveItemSheet` for the rest.
 */

import {
	useAvailableTags,
	useDeleteItem,
	useItem,
	useItems,
	useToggleFavorite,
	useUpdateItem,
	useVaultInfo,
} from "@bittery/core/hooks";
import { detectCardBrand } from "@bittery/shared/credit-card";
import { getItemServerUrl } from "@bittery/shared/favicon";
import type { DecryptedItem, DecryptedItemData } from "@bittery/shared/types";
import {
	ConfirmDialog,
	EditItemSheet,
	ItemDetail,
	PasswordHistoryDialog,
	Skeleton,
	toast,
} from "@bittery/ui";
import { IconArrowLeftRight, IconHistory, IconStar } from "@bittery/ui/icons";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { MobileScreen } from "@/components/mobile-screen";
import { Favicon } from "@/components/vault/favicon";
import { MoveItemSheet } from "@/components/vault/move-item-sheet";
import { useI18n } from "@/providers/i18n-provider";

function getCategoryDisplayName(
	category: string,
	m: ReturnType<typeof useI18n>["m"],
) {
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
}

function ItemDetailSkeleton() {
	return (
		<div className="space-y-4 px-4 py-4">
			<div className="flex items-center gap-4">
				<Skeleton className="size-12 rounded-lg" />
				<div className="flex-1 space-y-1.5">
					<Skeleton className="h-4 w-40" />
					<Skeleton className="h-3 w-24" />
				</div>
			</div>
			<Skeleton className="h-32 w-full rounded-lg" />
		</div>
	);
}

interface ItemDetailScreenProps {
	itemId: string;
	onBack: () => void;
}

export function ItemDetailScreen({ itemId, onBack }: ItemDetailScreenProps) {
	const { m } = useI18n();
	const navigate = useNavigate();
	const { rawItem, decryptedData, isLoading } = useItem(itemId);
	const { vaultInfo } = useVaultInfo(rawItem?.vaultId ?? "");
	const { items: allItems } = useItems();
	const availableTags = useAvailableTags(allItems);

	const [isEditOpen, setIsEditOpen] = useState(false);
	const [isDeleteOpen, setIsDeleteOpen] = useState(false);
	const [isMoveOpen, setIsMoveOpen] = useState(false);
	const [isPasswordHistoryOpen, setIsPasswordHistoryOpen] = useState(false);
	const [isUpdatingTags, setIsUpdatingTags] = useState(false);

	const updateItem = useUpdateItem();
	const deleteItem = useDeleteItem();
	const toggleFavorite = useToggleFavorite();

	const itemAccountId = rawItem?.accountId ?? rawItem?.account?.accountId;
	const canRender = !isLoading && rawItem && decryptedData;

	const handleTagsChange = (newTags: string[]) => {
		if (!rawItem || !decryptedData || !itemAccountId) return;
		const updatedData: DecryptedItemData = {
			...decryptedData,
			tags: newTags.length > 0 ? newTags : undefined,
		};
		setIsUpdatingTags(true);
		updateItem.mutate(
			{
				itemId: rawItem.id,
				vaultId: rawItem.vaultId,
				data: updatedData,
				accountId: itemAccountId,
			},
			{ onSettled: () => setIsUpdatingTags(false) },
		);
	};

	const handleTagClick = (tagName: string) => {
		navigate({
			to: "/vault/tag/$tagName",
			params: { tagName: encodeURIComponent(tagName) },
		});
	};

	const handleRemovePasskey = async (credentialId: string) => {
		if (
			!rawItem ||
			!decryptedData ||
			!itemAccountId ||
			rawItem.category !== "login"
		) {
			return;
		}
		const nextPasskeys = (decryptedData.passkeys ?? []).filter(
			(passkey) => passkey.credentialId !== credentialId,
		);
		try {
			await updateItem.mutateAsync({
				itemId: rawItem.id,
				vaultId: rawItem.vaultId,
				data: {
					...decryptedData,
					passkeys: nextPasskeys.length > 0 ? nextPasskeys : undefined,
				},
				accountId: itemAccountId,
			});
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: m.vaults_detail_items_detail_login_passkeys_remove_dialog_title(),
			);
		}
	};

	const handleToggleFavorite = async () => {
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
			toast.error(
				error instanceof Error
					? error.message
					: m.vaults_detail_items_list_toast_favorite_update_failed(),
			);
		}
	};

	const confirmDelete = async () => {
		if (!rawItem || !itemAccountId) return;
		try {
			await deleteItem.mutateAsync({
				itemId: rawItem.id,
				vaultId: rawItem.vaultId,
				accountId: itemAccountId,
			});
			toast.success(m.mob_item_detail_toast_deleted());
			setIsDeleteOpen(false);
			onBack();
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: m.mob_item_detail_toast_delete_failed(),
			);
		}
	};

	const handleRestorePassword = async (password: string) => {
		if (!rawItem || !itemAccountId) return;
		try {
			await updateItem.mutateAsync({
				itemId: rawItem.id,
				vaultId: rawItem.vaultId,
				data: { password },
				accountId: itemAccountId,
			});
			toast.success(m.mob_item_detail_toast_password_restored());
			setIsPasswordHistoryOpen(false);
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: m.mob_item_detail_toast_password_restore_failed(),
			);
		}
	};

	return (
		<MobileScreen
			title={
				decryptedData?.title ??
				vaultInfo?.vaultName ??
				m.mob_vault_items_fallback_title()
			}
			backLabel={m.mob_common_go_back()}
			onBack={onBack}
			headerEnd={
				canRender ? (
					<div className="flex shrink-0 items-center gap-1">
						{rawItem.category === "login" && (
							<button
								type="button"
								onClick={() => setIsPasswordHistoryOpen(true)}
								aria-label={m.mob_item_header_action_password_history()}
								className="flex size-11 items-center justify-center rounded-md text-foreground active:bg-foreground/5"
							>
								<IconHistory className="size-4.5" />
							</button>
						)}
						<button
							type="button"
							onClick={() => setIsMoveOpen(true)}
							aria-label={m.vaults_detail_items_move_dialog_action_open()}
							className="flex size-11 items-center justify-center rounded-md text-foreground active:bg-foreground/5"
						>
							<IconArrowLeftRight className="size-4.5" />
						</button>
						<button
							type="button"
							onClick={() => void handleToggleFavorite()}
							disabled={toggleFavorite.isPending}
							aria-label={
								rawItem?.favorite
									? m.vaults_detail_items_list_item_action_remove_favorite()
									: m.vaults_detail_items_list_item_action_add_favorite()
							}
							className="flex size-11 items-center justify-center rounded-md text-foreground active:bg-foreground/5"
						>
							<IconStar
								className="size-4.5"
								fill={rawItem?.favorite ? "currentColor" : "none"}
							/>
						</button>
					</div>
				) : undefined
			}
		>
			<div className="px-4 py-4">
				{!canRender ? (
					isLoading ? (
						<ItemDetailSkeleton />
					) : (
						<div className="flex flex-col items-center justify-center gap-1 p-8 text-center">
							<h2 className="font-semibold text-lg">
								{m.mob_detail_not_found()}
							</h2>
						</div>
					)
				) : (
					<ItemDetail
						category={rawItem.category}
						data={decryptedData}
						icon={
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
						}
						onEdit={() => setIsEditOpen(true)}
						onDelete={() => setIsDeleteOpen(true)}
						onRemovePasskey={handleRemovePasskey}
						onTagsChange={handleTagsChange}
						onTagClick={handleTagClick}
						availableTags={availableTags}
						isUpdatingTags={isUpdatingTags}
					/>
				)}
			</div>

			{rawItem && decryptedData && (
				<EditItemSheet
					open={isEditOpen}
					onOpenChange={setIsEditOpen}
					item={{
						...decryptedData,
						category: rawItem.category,
						vaultId: rawItem.vaultId,
					}}
					description={m.vaults_detail_items_detail_page_edit_dialog_description(
						{
							category: getCategoryDisplayName(rawItem.category, m),
						},
					)}
					onUpdateItem={async (data) => {
						if (!itemAccountId) return;
						try {
							await updateItem.mutateAsync({
								itemId: rawItem.id,
								vaultId: rawItem.vaultId,
								data,
								accountId: itemAccountId,
							});
							toast.success(m.mob_edit_item_toast_success());
							setIsEditOpen(false);
						} catch (error) {
							toast.error(
								error instanceof Error
									? error.message
									: m.mob_edit_item_toast_failed(),
							);
						}
					}}
					isSubmitting={updateItem.isPending}
					dataTestId="edit-item-sheet"
				/>
			)}

			<ConfirmDialog
				open={isDeleteOpen}
				onOpenChange={setIsDeleteOpen}
				title={m.vaults_detail_delete_item_dialog_title()}
				description={m.vaults_detail_delete_item_dialog_description()}
				cancelLabel={m.vaults_detail_delete_item_dialog_action_cancel()}
				confirmLabel={m.vaults_detail_delete_item_dialog_action_confirm()}
				onConfirm={() => void confirmDelete()}
				busy={deleteItem.isPending}
				destructive
			/>

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

			{rawItem && decryptedData && (
				<MoveItemSheet
					open={isMoveOpen}
					onOpenChange={setIsMoveOpen}
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
					onMoved={(targetVaultId) =>
						navigate({
							to: "/vault/$id/$itemId",
							params: { id: targetVaultId, itemId },
							replace: true,
						})
					}
				/>
			)}
		</MobileScreen>
	);
}
