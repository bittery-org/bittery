import { useI18n } from "@bittery/i18n/react";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import {
	IconCheck as Check,
	IconFileLock as FileIcon,
	IconLoaderCircle as Loader,
	IconPencil as Pencil,
	IconTrash as Trash,
	IconUpload as Upload,
	IconX as X,
} from "../../../icons";
import { Button } from "../../button";
import { Input } from "../../input";
import { toast } from "../../sonner";

export interface AttachmentItem {
	id: string;
	itemId: string;
	vaultId: string;
	storageKey: string;
	encryptedAttachmentKey: string;
	attachmentKeyIv: string;
	attachmentKeyAlgorithm: string;
	envelopeVersion: number;
	encryptedName: string;
	encryptedContentType: string;
	encryptionIv: string;
	encryptedContentTypeIv: string;
	encryptionAlgorithm: string;
	fileSize: number;
	uploadedBy: string;
	createdAt: Date | string;
}

export type AttachmentUploadErrorCode =
	| "file-too-large"
	| "storage-limit-reached"
	| "unknown";

export interface ItemAttachmentsProps {
	attachments: AttachmentItem[];
	isLoading: boolean;
	attachmentMaxFileSizeBytes: number | bigint | null;
	onDecryptMeta: (attachment: AttachmentItem) => Promise<{ name: string }>;
	onUpload: (file: File & { displayName?: string }) => Promise<unknown>;
	onDownload: (attachment: AttachmentItem) => Promise<{
		bytes: Uint8Array;
		fileName: string;
	}>;
	onRename: (attachmentId: string, newName: string) => Promise<unknown>;
	onDelete: (attachmentId: string) => Promise<unknown>;
	getUploadErrorCode: (error: unknown) => AttachmentUploadErrorCode;
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

export function getAttachmentRenameInitialValue(
	currentName: string | null | undefined,
): string {
	return currentName ?? "";
}

export function shouldRenameAttachment(
	currentName: string | null | undefined,
	nextName: string,
): boolean {
	return nextName.length > 0 && nextName !== currentName;
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
	onDecryptMeta,
	onRename,
	onDownload,
	onDelete,
	canEdit,
}: {
	attachment: AttachmentItem;
	onDecryptMeta: (attachment: AttachmentItem) => Promise<{ name: string }>;
	onRename: (attachmentId: string, newName: string) => Promise<unknown>;
	onDownload: (attachment: AttachmentItem) => void;
	onDelete: (attachmentId: string) => void;
	canEdit: boolean;
}) {
	const { m } = useI18n();
	const [decryptedName, setDecryptedName] = useState<string | null>(null);
	const [isEditing, setIsEditing] = useState(false);
	const [editValue, setEditValue] = useState("");
	const [isRenaming, setIsRenaming] = useState(false);
	const decryptedNameQuery = useQuery({
		queryKey: [
			"attachment",
			attachment.vaultId,
			attachment.itemId,
			attachment.id,
		],
		queryFn: async () => {
			const decrypted = await onDecryptMeta(attachment);
			return decrypted.name;
		},
		retry: false,
	});

	const currentName = decryptedName ?? decryptedNameQuery.data;
	const displayName =
		currentName ??
		(decryptedNameQuery.isError
			? m.vaults_detail_items_attachments_row_encrypted_file()
			: m.vaults_detail_items_attachments_row_loading());

	function startEdit() {
		setEditValue(getAttachmentRenameInitialValue(currentName));
		setIsEditing(true);
	}

	async function confirmRename() {
		const trimmed = editValue.trim();
		if (!shouldRenameAttachment(currentName, trimmed)) {
			setIsEditing(false);
			return;
		}
		setIsRenaming(true);
		try {
			await onRename(attachment.id, trimmed);
			setDecryptedName(trimmed);
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
	attachments,
	isLoading,
	attachmentMaxFileSizeBytes,
	onDecryptMeta,
	onUpload,
	onDownload,
	onRename,
	onDelete,
	getUploadErrorCode,
	canEdit = false,
	handleDownloadedFile,
}: ItemAttachmentsProps) {
	const { m } = useI18n();
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [isUploading, setIsUploading] = useState(false);
	const [pendingFile, setPendingFile] = useState<File | null>(null);
	const [pendingName, setPendingName] = useState("");

	const handleFileChange = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			const file = e.target.files?.[0];
			if (!file) return;

			if (
				attachmentMaxFileSizeBytes !== null &&
				file.size > Number(attachmentMaxFileSizeBytes)
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
			await onUpload(
				Object.assign(pendingFile, {
					displayName: pendingName.trim() || pendingFile.name,
				}),
			);
			toast.success(m.vaults_detail_items_attachments_toast_uploaded());
		} catch (error) {
			const uploadErrorCode = getUploadErrorCode(error);
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
	}, [attachmentMaxFileSizeBytes, getUploadErrorCode, m, onUpload, pendingFile, pendingName]);

	const handleDownload = useCallback(
		async (attachment: AttachmentItem) => {
			try {
				const { bytes, fileName } = await onDownload(attachment);
				(handleDownloadedFile ?? defaultHandleDownloadedFile)(bytes, fileName);
			} catch {
				toast.error(m.vaults_detail_items_attachments_toast_download_failed());
			}
		},
		[handleDownloadedFile, m, onDownload],
	);

	const handleDelete = useCallback(
		async (attachmentId: string) => {
			try {
				await onDelete(attachmentId);
				toast.success(m.vaults_detail_items_attachments_toast_deleted());
			} catch {
				toast.error(m.vaults_detail_items_attachments_toast_delete_failed());
			}
		},
		[m, onDelete],
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
							onDecryptMeta={onDecryptMeta}
							onRename={onRename}
							onDownload={handleDownload}
							onDelete={handleDelete}
							canEdit={canEdit}
						/>
					))}
				</div>
			)}
		</div>
	);
}
