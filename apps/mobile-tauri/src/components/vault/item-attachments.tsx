/**
 * The attachments block on an item's detail screen: list, attach, download, rename, delete.
 *
 * A port of `apps/mobile/src/components/item-details/item-attachments.tsx` onto the WebView
 * kit, over the same `useItemAttachments` hook desktop and web use — every byte of crypto,
 * every presigned URL and the entitlement lookup all live in that hook, so this file is
 * presentation and platform plumbing only.
 *
 * The two platform-shaped parts:
 *
 * - **Attach** goes through `lib/file-picker.ts` (SAF picker + `fs.readFile`), not an
 *   `<input type="file">`, which does nothing at all in Tauri's Android WebView.
 * - **Download** goes through `lib/share.ts`'s `shareFile`, which is where "Save to Files"
 *   actually lives on Android. There is no filesystem location the app may write to that
 *   the user can then find.
 *
 * Names are ciphertext until decrypted, one round-trip per row, so each row owns its own
 * decryption query rather than the section decrypting the whole list up front — a 30-file
 * item would otherwise block its own header on 30 unwraps.
 */

import type { AttachmentMeta } from "@bittery/core/hooks";
import {
	getAttachmentUploadErrorCode,
	useItemAttachments,
} from "@bittery/core/hooks";
import { attachmentBytesToBase64 } from "@bittery/core/services/attachment-crypto";
import { toast } from "@bittery/ui";
import {
	IconCheck,
	IconDownload,
	IconFile,
	IconPaperclip,
	IconPencil,
	IconTrash,
	IconX,
} from "@bittery/ui/icons";
import { cn } from "@bittery/ui/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ComponentType, useState } from "react";
import {
	BrandButton,
	ConfirmSheet,
	IconTile,
	iconClass,
	ListCard,
	MobileSheet,
	Pressable,
	SectionLabel,
	TextField,
} from "@/components/ui";
import { type PickedFile, pickFile } from "@/lib/file-picker";
import { shareFile } from "@/lib/share";
import { useI18n } from "@/providers/i18n-provider";

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The decrypted-name cache key. Shared by the row's query and its post-rename write-through. */
function attachmentNameKey(attachment: AttachmentMeta, accountId: string) {
	return [
		"attachment",
		attachment.vaultId,
		attachment.itemId,
		attachment.id,
		accountId,
	] as const;
}

/** 44pt tap target, matching the field rows on the same screen. */
function RowAction({
	icon: Icon,
	label,
	onPress,
	tone = "default",
	disabled,
}: {
	icon: ComponentType<{ className?: string }>;
	label: string;
	onPress: () => void;
	tone?: "default" | "danger";
	disabled?: boolean;
}) {
	return (
		<Pressable
			onClick={onPress}
			disabled={disabled}
			aria-label={label}
			className="flex size-11 shrink-0 items-center justify-center rounded-full"
		>
			<Icon
				className={cn(
					iconClass.row,
					tone === "danger" ? "text-danger" : "text-muted-foreground",
				)}
			/>
		</Pressable>
	);
}

interface ItemAttachmentsProps {
	itemId: string;
	vaultId: string;
	accountId: string;
	canEdit?: boolean;
}

export function ItemAttachments({
	itemId,
	vaultId,
	accountId,
	canEdit = false,
}: ItemAttachmentsProps) {
	const { m } = useI18n();
	const [isUploading, setIsUploading] = useState(false);
	const [isDownloading, setIsDownloading] = useState(false);
	/** A picked file waiting for the user to confirm the name it will be stored under. */
	const [pendingFile, setPendingFile] = useState<PickedFile | null>(null);
	const [pendingName, setPendingName] = useState("");
	const [attachmentPendingDelete, setAttachmentPendingDelete] = useState<
		string | null
	>(null);

	const {
		attachments,
		isLoading,
		upload,
		download,
		remove,
		attachmentMaxFileSizeBytes,
	} = useItemAttachments(itemId, vaultId, accountId);

	/**
	 * A zero limit is the server saying "this plan has no attachments" — `billing/service.rs`
	 * only ever returns `Some(0)` for Free, or when the attachments entitlement is off. Every
	 * file is larger than nothing, so offering Attach here can only ever produce a rejection,
	 * and the rejection reads as the nonsense "Maximum size is 0 B".
	 */
	const isAttachmentsEntitled = Number(attachmentMaxFileSizeBytes ?? 1) > 0;

	const handlePickFile = async () => {
		let picked: PickedFile | null;
		try {
			picked = await pickFile();
		} catch (error) {
			console.error("[attachments] file pick failed", error);
			toast.error(m.mob_attachments_pick_failed());
			return;
		}
		// Cancelling the picker is an outcome, not a failure — say nothing.
		if (!picked) return;

		// Checked here as well as server-side so a 20MB file is refused before it is read,
		// encrypted and uploaded only to be rejected at the end.
		if (
			attachmentMaxFileSizeBytes !== null &&
			picked.size > attachmentMaxFileSizeBytes
		) {
			toast.error(
				m.vaults_detail_items_attachments_toast_file_too_large({
					maxFileSize: formatBytes(Number(attachmentMaxFileSizeBytes)),
				}),
			);
			return;
		}

		setPendingName(picked.name);
		setPendingFile(picked);
	};

	const closePending = () => {
		setPendingFile(null);
		setPendingName("");
	};

	const handleConfirmUpload = async () => {
		if (!pendingFile) return;
		setIsUploading(true);
		try {
			await upload.mutateAsync(
				Object.assign(pendingFile, {
					displayName: pendingName.trim() || pendingFile.name,
				}),
			);
			toast.success(m.mob_attachments_toast_uploaded());
			closePending();
		} catch (error) {
			const code = getAttachmentUploadErrorCode(error);
			if (code === "storage-limit-reached") {
				toast.error(
					m.vaults_detail_items_attachments_toast_storage_limit_reached(),
				);
			} else if (
				code === "file-too-large" &&
				attachmentMaxFileSizeBytes !== null
			) {
				toast.error(
					m.vaults_detail_items_attachments_toast_file_too_large({
						maxFileSize: formatBytes(Number(attachmentMaxFileSizeBytes)),
					}),
				);
			} else {
				toast.error(m.vaults_detail_items_attachments_toast_upload_failed());
			}
		} finally {
			setIsUploading(false);
		}
	};

	const handleDownload = async (attachment: AttachmentMeta) => {
		setIsDownloading(true);
		try {
			const { bytes, fileName } = await download.mutateAsync(attachment);
			await shareFile({
				base64Data: attachmentBytesToBase64(bytes),
				fileName,
				title: m.mob_attachments_save_dialog_title({ fileName }),
			});
		} catch (error) {
			console.error("[attachments] download failed", error);
			toast.error(m.mob_attachments_toast_download_failed(), {
				description: m.mob_attachments_toast_download_failed_description(),
			});
		} finally {
			setIsDownloading(false);
		}
	};

	const handleDelete = async () => {
		if (!attachmentPendingDelete) return;
		try {
			await remove.mutateAsync(attachmentPendingDelete);
			toast.success(m.mob_attachments_toast_deleted());
			setAttachmentPendingDelete(null);
		} catch {
			toast.error(m.mob_attachments_toast_delete_failed(), {
				description: m.mob_attachments_toast_delete_failed_description(),
			});
		}
	};

	return (
		<div>
			<SectionLabel
				trailing={
					canEdit && isAttachmentsEntitled ? (
						<Pressable
							onClick={() => void handlePickFile()}
							disabled={isUploading || pendingFile !== null}
							className="-mr-1 flex h-8 items-center gap-1.5 rounded-full px-2 font-medium text-primary text-sm"
						>
							<IconPaperclip className={iconClass.chip} />
							{m.mob_attachments_attach_button()}
						</Pressable>
					) : undefined
				}
			>
				{attachments.length > 0
					? m.mob_attachments_title_count({ count: String(attachments.length) })
					: m.mob_attachments_title()}
			</SectionLabel>

			<ListCard>
				{isLoading ? (
					<p className="px-4 py-4 text-muted-foreground text-sm">
						{m.mob_attachments_loading()}
					</p>
				) : attachments.length === 0 ? (
					<p className="px-4 py-4 text-muted-foreground text-sm">
						{isAttachmentsEntitled
							? m.mob_attachments_empty()
							: m.mob_attachments_plan_locked()}
					</p>
				) : (
					attachments.map((attachment) => (
						<AttachmentRow
							key={attachment.id}
							attachment={attachment}
							accountId={accountId}
							canEdit={canEdit}
							onDownload={() => void handleDownload(attachment)}
							onDelete={() => setAttachmentPendingDelete(attachment.id)}
						/>
					))
				)}
				{isDownloading ? (
					<p className="px-4 py-3 text-muted-foreground text-sm">
						{m.mob_attachments_preparing_download()}
					</p>
				) : null}
			</ListCard>

			{/* Naming happens in a sheet rather than inline in the card: the keyboard covers the
			    lower half of the screen, and a card row halfway down the detail scroller would
			    end up behind it. */}
			<MobileSheet
				open={pendingFile !== null}
				onOpenChange={(next) => {
					if (!next && !isUploading) closePending();
				}}
				title={m.mob_attachments_attach_button()}
				description={
					pendingFile
						? `${m.mob_attachments_display_name_label()} ${pendingFile.name}`
						: undefined
				}
			>
				<form
					onSubmit={(event) => {
						event.preventDefault();
						void handleConfirmUpload();
					}}
					className="flex flex-col gap-3 px-4 pt-1 pb-6"
				>
					<TextField
						label={m.mob_attachments_display_name_label()}
						value={pendingName}
						onChange={(event) => setPendingName(event.target.value)}
						placeholder={pendingFile?.name}
						disabled={isUploading}
						autoFocus
					/>
					<BrandButton
						label={
							isUploading
								? m.mob_attachments_uploading()
								: m.mob_attachments_upload_button()
						}
						isLoading={isUploading}
						onClick={() => void handleConfirmUpload()}
					/>
					<Pressable
						onClick={closePending}
						disabled={isUploading}
						surface="sheet"
						className="flex h-11 w-full items-center justify-center rounded-xl bg-surface-tertiary font-medium text-base text-foreground"
					>
						{m.mob_attachments_cancel()}
					</Pressable>
				</form>
			</MobileSheet>

			<ConfirmSheet
				open={attachmentPendingDelete !== null}
				onOpenChange={(next) => {
					if (!next) setAttachmentPendingDelete(null);
				}}
				title={m.mob_attachments_delete_dialog_title()}
				description={m.mob_attachments_delete_dialog_message()}
				confirmLabel={m.mob_attachments_delete_dialog_confirm()}
				cancelLabel={m.mob_attachments_delete_dialog_cancel()}
				onConfirm={() => void handleDelete()}
				isPending={remove.isPending}
			/>
		</div>
	);
}

function AttachmentRow({
	attachment,
	accountId,
	canEdit,
	onDownload,
	onDelete,
}: {
	attachment: AttachmentMeta;
	accountId: string;
	canEdit: boolean;
	onDownload: () => void;
	onDelete: () => void;
}) {
	const { m } = useI18n();
	const queryClient = useQueryClient();
	const [isEditing, setIsEditing] = useState(false);
	const [editValue, setEditValue] = useState("");
	const [isRenaming, setIsRenaming] = useState(false);

	const { decryptMeta, rename } = useItemAttachments(
		attachment.itemId,
		attachment.vaultId,
		accountId,
	);

	const nameKey = attachmentNameKey(attachment, accountId);
	const nameQuery = useQuery({
		queryKey: nameKey,
		queryFn: async () => (await decryptMeta(attachment)).name,
		// A name that will not decrypt will not decrypt on the third attempt either, and each
		// retry is a vault-key unwrap.
		retry: false,
	});

	const displayName =
		nameQuery.data ??
		(nameQuery.isError
			? m.mob_attachments_encrypted_file()
			: m.mob_attachments_loading_name());

	const startEdit = () => {
		setEditValue(nameQuery.data ?? "");
		setIsEditing(true);
	};

	const confirmRename = async () => {
		const trimmed = editValue.trim();
		if (!trimmed || trimmed === nameQuery.data) {
			setIsEditing(false);
			return;
		}
		setIsRenaming(true);
		try {
			await rename.mutateAsync({
				attachmentId: attachment.id,
				newName: trimmed,
			});
			// Write straight through instead of invalidating: the new name is already known,
			// and refetching would spend another vault-key unwrap to learn what we just sent.
			queryClient.setQueryData(nameKey, trimmed);
			setIsEditing(false);
			toast.success(m.mob_attachments_toast_renamed());
		} catch {
			toast.error(m.mob_attachments_toast_rename_failed());
		} finally {
			setIsRenaming(false);
		}
	};

	if (isEditing) {
		return (
			<form
				onSubmit={(event) => {
					event.preventDefault();
					void confirmRename();
				}}
				className="flex items-center gap-1 px-4 py-3"
			>
				<TextField
					className="min-w-0 flex-1"
					value={editValue}
					onChange={(event) => setEditValue(event.target.value)}
					disabled={isRenaming}
					aria-label={m.vaults_detail_items_attachments_action_rename_attachment()}
					autoFocus
				/>
				<RowAction
					icon={IconCheck}
					label={m.vaults_detail_items_attachments_action_rename_attachment()}
					onPress={() => void confirmRename()}
					disabled={isRenaming}
				/>
				<RowAction
					icon={IconX}
					label={m.mob_attachments_cancel()}
					onPress={() => setIsEditing(false)}
					disabled={isRenaming}
				/>
			</form>
		);
	}

	return (
		<div className="flex items-center gap-3 px-4 py-3">
			<IconTile>
				<IconFile className={iconClass.row} />
			</IconTile>
			<div className="min-w-0 flex-1">
				<p className="truncate font-medium text-base text-foreground">
					{displayName}
				</p>
				<p className="mt-0.5 text-muted-foreground text-sm">
					{formatBytes(attachment.fileSize)}
				</p>
			</div>
			<div className="flex shrink-0 items-center">
				<RowAction
					icon={IconDownload}
					label={m.vaults_detail_items_attachments_action_download()}
					onPress={onDownload}
				/>
				{canEdit ? (
					<RowAction
						icon={IconPencil}
						label={m.vaults_detail_items_attachments_action_rename_attachment()}
						onPress={startEdit}
					/>
				) : null}
				{canEdit ? (
					<RowAction
						icon={IconTrash}
						tone="danger"
						label={m.vaults_detail_items_attachments_action_delete_attachment()}
						onPress={onDelete}
					/>
				) : null}
			</div>
		</div>
	);
}
