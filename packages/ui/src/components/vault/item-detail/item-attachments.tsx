import { useI18n } from "@bittery/i18n/react";
import type { AttachmentMeta } from "@bittery/core/hooks";
import { getAttachmentUploadErrorCode, useItemAttachments } from "@bittery/core/hooks";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import {
	IconCheckOutlineDuo18 as Check,
	IconFileLockOutlineDuo18 as FileIcon,
	IconLoader2Fill18 as Loader,
	IconPen2OutlineDuo18 as Pencil,
	IconTrash2OutlineDuo18 as Trash,
	IconUpload4OutlineDuo18 as Upload,
	IconXmarkOutlineDuo18 as X,
} from "../../../icons";
import { Button } from "../../button";
import { Input } from "../../input";
import { toast } from "../../sonner";

interface ItemAttachmentsProps {
	itemId: string;
	vaultId: string;
	accountEmail?: string;
	canEdit?: boolean;
	handleDownloadedFile?: (bytes: Uint8Array, fileName: string) => void;
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

function defaultHandleDownloadedFile(bytes: Uint8Array, fileName: string) {
	const blob = new Blob([bytes as any]);
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = fileName;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
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
	const queryClient = useQueryClient();
	const { decryptMeta, rename } = useItemAttachments(
		attachment.itemId,
		attachment.vaultId,
		accountEmail,
	);

	const decryptedNameQuery = useQuery({
		queryKey: [
			"attachment",
			attachment.vaultId,
			attachment.itemId,
			attachment.id,
			accountEmail,
		],
		queryFn: async () => {
			const decrypted = await decryptMeta(attachment);
			return decrypted.name;
		},
		retry: false,
	});

	const displayName =
		decryptedName ??
		decryptedNameQuery.data ??
		(decryptedNameQuery.isError
			? m.vaults_detail_items_attachments_row_encrypted_file()
			: m.vaults_detail_items_attachments_row_loading());

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
			await rename.mutateAsync({ attachmentId: attachment.id, newName: trimmed });
			setDecryptedName(trimmed);
			queryClient.setQueryData(
				[
					"attachment",
					attachment.vaultId,
					attachment.itemId,
					attachment.id,
					accountEmail,
				],
				trimmed,
			);
			setIsEditing(false);
		} catch {
			toast.error(m.vaults_detail_items_attachments_toast_rename_attachment_failed());
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
						<Button size="sm" variant="ghost" onClick={confirmRename} disabled={isRenaming}>
							{isRenaming ? <Loader className="size-3 animate-spin" /> : <Check className="size-3" />}
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
				<p className="text-muted-foreground text-xs">{formatBytes(attachment.fileSize)}</p>
			</div>
			<div className="flex items-center gap-1">
				<Button
					size="sm"
					variant="ghost"
					onClick={() => onDownload(attachment)}
					title={m.vaults_detail_items_attachments_action_download()}
				>
					<Upload className="size-4 rotate-180" />
				</Button>
				{canEdit && !isEditing && (
					<Button
						size="sm"
						variant="ghost"
						onClick={startEdit}
						title={m.vaults_detail_items_attachments_action_rename_attachment()}
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
						title={m.vaults_detail_items_attachments_action_delete_attachment()}
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
	handleDownloadedFile,
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
	} = useItemAttachments(itemId, vaultId, accountEmail);

	const handleFileChange = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			const file = e.target.files?.[0];
			if (!file) return;

			if (
				attachmentMaxFileSizeBytes !== null &&
				file.size > attachmentMaxFileSizeBytes
			) {
				toast.error(
					m.vaults_detail_items_attachments_toast_file_too_large({
						maxFileSize: formatBytes(Number(attachmentMaxFileSizeBytes)),
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
			toast.success(m.vaults_detail_items_attachments_toast_uploaded());
		} catch (error) {
			const uploadErrorCode = getAttachmentUploadErrorCode(error);
			if (uploadErrorCode === "storage-limit-reached") {
				toast.error(m.vaults_detail_items_attachments_toast_storage_limit_reached());
			} else if (
				uploadErrorCode === "file-too-large" &&
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
			setPendingFile(null);
			setPendingName("");
		}
	}, [attachmentMaxFileSizeBytes, m, pendingFile, pendingName, upload]);

	const handleDownload = useCallback(
		async (attachment: AttachmentMeta) => {
			try {
				const { bytes, fileName } = await download.mutateAsync(attachment);
				(handleDownloadedFile ?? defaultHandleDownloadedFile)(bytes, fileName);
			} catch {
				toast.error(m.vaults_detail_items_attachments_toast_download_failed());
			}
		},
		[download, handleDownloadedFile, m],
	);

	const handleDelete = useCallback(
		async (attachmentId: string) => {
			try {
				await remove.mutateAsync(attachmentId);
				toast.success(m.vaults_detail_items_attachments_toast_deleted());
			} catch {
				toast.error(m.vaults_detail_items_attachments_toast_delete_failed());
			}
		},
		[m, remove],
	);

	return (
		<div className="mt-3 space-y-3">
			<div className="flex items-center justify-between">
				<span className="font-medium text-sm">
					{m.vaults_detail_items_attachments_label()}
					{attachments.length > 0 && <span className="ml-1">({attachments.length})</span>}
				</span>
				{canEdit && (
					<>
						<input ref={fileInputRef} type="file" className="hidden" onChange={handleFileChange} />
						<Button
							size="sm"
							variant="outline"
							onClick={() => fileInputRef.current?.click()}
							disabled={isUploading || !!pendingFile}
						>
							<Upload className="mr-1 h-3 w-3" />
							{m.vaults_detail_items_attachments_action_attach_file()}
						</Button>
					</>
				)}
			</div>

			{pendingFile && (
				<div className="space-y-2 rounded-md border p-3">
					<p className="text-muted-foreground text-sm">
						{m.vaults_detail_items_attachments_pending_display_name_for()} {" "}
						<span className="font-medium text-foreground">{pendingFile.name}</span>
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
						<Button size="sm" onClick={handleConfirmUpload} disabled={isUploading}>
							{isUploading && <Loader className="mr-1 h-3 w-3 animate-spin" />}
							{isUploading
								? m.vaults_detail_items_attachments_action_uploading()
								: m.vaults_detail_items_attachments_action_upload()}
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
							{m.vaults_detail_items_detail_action_cancel()}
						</Button>
					</div>
				</div>
			)}

			{isLoading && (
				<div className="flex items-center gap-2 text-muted-foreground text-sm">
					<Loader className="animate-spin" />
					{m.vaults_detail_items_attachments_loading()}
				</div>
			)}

			{!isLoading && attachments.length === 0 && (
				<p className="text-muted-foreground text-sm">
					{m.vaults_detail_items_attachments_empty()}
				</p>
			)}

			{attachments.length > 0 && (
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
