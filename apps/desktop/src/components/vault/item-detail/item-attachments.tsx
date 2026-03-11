/**
 * ItemAttachments Component (Desktop)
 *
 * Displays encrypted file attachments for a vault item.
 * Supports upload (with optional display name), download (with client-side decryption),
 * rename, and delete.
 */

import type { AttachmentMeta } from "@bittery/core/hooks";
import {
	getAttachmentUploadErrorCode,
	useItemAttachments,
} from "@bittery/core/hooks";
import { Button, Input, toast } from "@bittery/ui";
import {
	IconCheckOutlineDuo18 as Check,
	IconFileLockOutlineDuo18 as FileIcon,
	IconLoader2Fill18 as Loader,
	IconPen2OutlineDuo18 as Pencil,
	IconTrash2OutlineDuo18 as Trash,
	IconUpload4OutlineDuo18 as Upload,
	IconXmarkOutlineDuo18 as X,
} from "@bittery/ui/icons";
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../../../providers/i18n-provider";

interface ItemAttachmentsProps {
	itemId: string;
	vaultId: string;
	accountEmail?: string;
	canEdit?: boolean;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) {
		return new Intl.NumberFormat(undefined, {
			style: "unit",
			unit: "byte",
			unitDisplay: "narrow",
			maximumFractionDigits: 0,
		}).format(bytes);
	}

	if (bytes < 1024 * 1024) {
		return new Intl.NumberFormat(undefined, {
			style: "unit",
			unit: "kilobyte",
			unitDisplay: "narrow",
			maximumFractionDigits: 1,
		}).format(bytes / 1024);
	}

	return new Intl.NumberFormat(undefined, {
		style: "unit",
		unit: "megabyte",
		unitDisplay: "narrow",
		maximumFractionDigits: 1,
	}).format(bytes / (1024 * 1024));
}

function AttachmentRow({
	attachment,
	onDownload,
	onDelete,
	canEdit,
	accountEmail,
}: {
	attachment: AttachmentMeta;
	onDownload: (attachment: AttachmentMeta) => void;
	onDelete: (attachmentId: string) => void;
	canEdit: boolean;
	accountEmail?: string;
}) {
	const { m } = useI18n();
	const [decryptedName, setDecryptedName] = useState<string | null>(null);
	const [isEditing, setIsEditing] = useState(false);
	const [editValue, setEditValue] = useState("");
	const [isRenaming, setIsRenaming] = useState(false);
	const { decryptMeta, rename } = useItemAttachments(
		attachment.itemId,
		attachment.vaultId,
		accountEmail,
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: decryptMeta is stable for same vault
	useEffect(() => {
		decryptMeta(attachment)
			.then((d) => setDecryptedName(d.name))
			.catch(() =>
				setDecryptedName(
					m["vaults.detail.items.attachments.row.encrypted_file"](),
				),
			);
	}, [attachment.id, m]);

	const displayName =
		decryptedName ?? m["vaults.detail.items.attachments.row.loading"]();

	function startEdit() {
		setEditValue(decryptedName ?? "");
		setIsEditing(true);
	}

	async function confirmRename() {
		const trimmed = editValue.trim();
		if (!trimmed || trimmed === decryptedName) {
			setIsEditing(false);
			return;
		}
		setIsRenaming(true);
		try {
			await rename.mutateAsync({
				attachmentId: attachment.id,
				newName: trimmed,
			});
			setDecryptedName(trimmed);
			setIsEditing(false);
		} catch {
			toast.error(
				m["vaults.detail.items.attachments.toast.rename_attachment_failed"](),
			);
		} finally {
			setIsRenaming(false);
		}
	}

	return (
		<div className="flex items-center gap-3 rounded-md border p-3">
			<FileIcon className="size-4 shrink-0 text-muted-foreground" />
			<div className="min-w-0 flex-1">
				{isEditing ? (
					<div className="flex items-center gap-1">
						<Input
							className="h-6 py-0 text-sm"
							value={editValue}
							onChange={(e) => setEditValue(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") confirmRename();
								if (e.key === "Escape") setIsEditing(false);
							}}
							autoFocus
							disabled={isRenaming}
						/>
						<Button
							size="sm"
							variant="ghost"
							onClick={confirmRename}
							disabled={isRenaming}
						>
							{isRenaming ? (
								<Loader className="size-3 animate-spin" />
							) : (
								<Check className="size-3" />
							)}
						</Button>
						<Button
							size="sm"
							variant="ghost"
							onClick={() => setIsEditing(false)}
							disabled={isRenaming}
						>
							<X className="size-3" />
						</Button>
					</div>
				) : (
					<p className="truncate font-medium text-sm" title={displayName}>
						{displayName}
					</p>
				)}
				<p className="text-muted-foreground text-xs">
					{formatBytes(attachment.fileSize)}
				</p>
			</div>
			<div className="flex items-center gap-1">
				<Button
					size="sm"
					variant="ghost"
					onClick={() => onDownload(attachment)}
					title={m["vaults.detail.items.attachments.action.download"]()}
				>
					<Upload className="size-4 rotate-180" />
				</Button>
				{canEdit && !isEditing && (
					<Button
						size="sm"
						variant="ghost"
						onClick={startEdit}
						title={m[
							"vaults.detail.items.attachments.action.rename_attachment"
						]()}
					>
						<Pencil className="size-4" />
					</Button>
				)}
				{canEdit && (
					<Button
						size="sm"
						variant="ghost"
						className="text-destructive hover:bg-destructive/10 hover:text-destructive"
						onClick={() => onDelete(attachment.id)}
						title={m[
							"vaults.detail.items.attachments.action.delete_attachment"
						]()}
					>
						<Trash className="size-4" />
					</Button>
				)}
			</div>
		</div>
	);
}

export function ItemAttachments({
	itemId,
	vaultId,
	accountEmail,
	canEdit = false,
}: ItemAttachmentsProps) {
	const { m } = useI18n();
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [isUploading, setIsUploading] = useState(false);
	const [pendingFile, setPendingFile] = useState<File | null>(null);
	const [pendingName, setPendingName] = useState("");

	const {
		attachments,
		isLoading,
		upload,
		download,
		remove,
		attachmentMaxFileSizeBytes,
	} =
		useItemAttachments(itemId, vaultId, accountEmail);

	const handleFileChange = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			const file = e.target.files?.[0];
			if (!file) return;

			if (
				attachmentMaxFileSizeBytes !== null &&
				file.size > attachmentMaxFileSizeBytes
			) {
				toast.error(
					m["vaults.detail.items.attachments.toast.file_too_large"]({
						maxFileSize: formatBytes(attachmentMaxFileSizeBytes),
					}),
				);
				if (fileInputRef.current) fileInputRef.current.value = "";
				return;
			}

			setPendingName(file.name);
			setPendingFile(file);
			if (fileInputRef.current) fileInputRef.current.value = "";
		},
		[attachmentMaxFileSizeBytes, m],
	);

	const handleConfirmUpload = useCallback(async () => {
		if (!pendingFile) return;
		setIsUploading(true);
		try {
			await upload.mutateAsync(
				Object.assign(pendingFile, {
					displayName: pendingName.trim() || pendingFile.name,
				}),
			);
			toast.success(m["vaults.detail.items.attachments.toast.uploaded"]());
		} catch (error) {
			const uploadErrorCode = getAttachmentUploadErrorCode(error);
			if (uploadErrorCode === "storage-limit-reached") {
				toast.error(
					m["vaults.detail.items.attachments.toast.storage_limit_reached"](),
				);
			} else if (
				uploadErrorCode === "file-too-large" &&
				attachmentMaxFileSizeBytes !== null
			) {
				toast.error(
					m["vaults.detail.items.attachments.toast.file_too_large"]({
						maxFileSize: formatBytes(attachmentMaxFileSizeBytes),
					}),
				);
			} else {
				toast.error(m["vaults.detail.items.attachments.toast.upload_failed"]());
			}
		} finally {
			setIsUploading(false);
			setPendingFile(null);
			setPendingName("");
		}
	}, [attachmentMaxFileSizeBytes, m, pendingFile, pendingName, upload]);

	const handleDownload = useCallback(
		async (attachment: AttachmentMeta) => {
			try {
				const { bytes, fileName } = await download.mutateAsync(attachment);

				const blob = new Blob([bytes]);
				const url = URL.createObjectURL(blob);

				// Trigger download via anchor element
				const a = document.createElement("a");
				a.href = url;
				a.download = fileName;
				document.body.appendChild(a);
				a.click();
				document.body.removeChild(a);

				setTimeout(() => URL.revokeObjectURL(url), 60_000);
				toast.success(
					m["vaults.detail.items.attachments.toast.downloaded"]({ fileName }),
				);
			} catch {
				toast.error(
					m["vaults.detail.items.attachments.toast.download_failed"](),
				);
			}
		},
		[download, m],
	);

	const handleDelete = useCallback(
		async (attachmentId: string) => {
			try {
				await remove.mutateAsync(attachmentId);
				toast.success(m["vaults.detail.items.attachments.toast.deleted"]());
			} catch {
				toast.error(m["vaults.detail.items.attachments.toast.delete_failed"]());
			}
		},
		[m, remove],
	);

	return (
		<div className="mt-3 space-y-3">
			<div className="flex items-center justify-between">
				<span className="font-medium text-sm">
					{m["vaults.detail.items.attachments.label"]()}
					{attachments.length > 0 && (
						<span className="ml-1">({attachments.length})</span>
					)}
				</span>
				{canEdit && (
					<>
						<input
							ref={fileInputRef}
							type="file"
							className="hidden"
							onChange={handleFileChange}
						/>
						<Button
							size="sm"
							variant="outline"
							onClick={() => fileInputRef.current?.click()}
							disabled={isUploading || !!pendingFile}
						>
							<Upload className="mr-1 h-3 w-3" />
							{m["vaults.detail.items.attachments.action.attach_file"]()}
						</Button>
					</>
				)}
			</div>

			{/* Name input shown after picking a file */}
			{pendingFile && (
				<div className="space-y-2 rounded-md border p-3">
					<p className="text-muted-foreground text-sm">
						{m["vaults.detail.items.attachments.pending.display_name_for"]()}{" "}
						<span className="font-medium text-foreground">
							{pendingFile.name}
						</span>
					</p>
					<div className="flex items-center gap-2">
						<Input
							className="h-8 flex-1 text-sm"
							placeholder={pendingFile.name}
							value={pendingName}
							onChange={(e) => setPendingName(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") handleConfirmUpload();
								if (e.key === "Escape") {
									setPendingFile(null);
									setPendingName("");
								}
							}}
							autoFocus
							disabled={isUploading}
						/>
						<Button
							size="sm"
							onClick={handleConfirmUpload}
							disabled={isUploading}
						>
							{isUploading && <Loader className="mr-1 h-3 w-3 animate-spin" />}
							{isUploading
								? m["vaults.detail.items.attachments.action.uploading"]()
								: m["vaults.detail.items.attachments.action.upload"]()}
						</Button>
						<Button
							size="sm"
							variant="ghost"
							onClick={() => {
								setPendingFile(null);
								setPendingName("");
							}}
							disabled={isUploading}
						>
							{m["vaults.detail.items.detail.action.cancel"]()}
						</Button>
					</div>
				</div>
			)}

			{isLoading && (
				<div className="flex items-center gap-2 text-muted-foreground text-sm">
					<Loader className="h-4 w-4 animate-spin" />
					{m["vaults.detail.items.attachments.loading"]()}
				</div>
			)}

			{!isLoading && attachments.length === 0 && (
				<p className="text-muted-foreground text-sm">
					{m["vaults.detail.items.attachments.empty"]()}
				</p>
			)}

			{!isLoading && attachments.length > 0 && (
				<div className="space-y-2">
					{attachments.map((attachment) => (
						<AttachmentRow
							key={attachment.id}
							attachment={attachment}
							onDownload={handleDownload}
							onDelete={handleDelete}
							canEdit={canEdit}
							accountEmail={accountEmail}
						/>
					))}
				</div>
			)}
		</div>
	);
}
