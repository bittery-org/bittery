/**
 * ItemAttachments Component (Desktop)
 *
 * Displays encrypted file attachments for a vault item.
 * Supports upload (with optional display name), download (with client-side decryption),
 * rename, and delete.
 */

import type { AttachmentMeta } from "@bittery/core/hooks";
import { useItemAttachments } from "@bittery/core/hooks";
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

interface ItemAttachmentsProps {
	itemId: string;
	vaultId: string;
	accountEmail?: string;
	canEdit?: boolean;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
			.catch(() => setDecryptedName("Encrypted file"));
	}, [attachment.id]);

	const displayName = decryptedName ?? "Loading...";

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
			toast.error("Failed to rename attachment.");
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
					title="Download"
				>
					<Upload className="size-4 rotate-180" />
				</Button>
				{canEdit && !isEditing && (
					<Button
						size="sm"
						variant="ghost"
						onClick={startEdit}
						title="Rename attachment"
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
						title="Delete attachment"
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
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [isUploading, setIsUploading] = useState(false);
	const [pendingFile, setPendingFile] = useState<File | null>(null);
	const [pendingName, setPendingName] = useState("");

	const { attachments, isLoading, upload, download, remove } =
		useItemAttachments(itemId, vaultId, accountEmail);

	const handleFileChange = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			const file = e.target.files?.[0];
			if (!file) return;

			// 25 MB limit
			if (file.size > 25 * 1024 * 1024) {
				toast.error("File too large. Maximum size is 25 MB.");
				if (fileInputRef.current) fileInputRef.current.value = "";
				return;
			}

			setPendingName(file.name);
			setPendingFile(file);
			if (fileInputRef.current) fileInputRef.current.value = "";
		},
		[],
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
			toast.success("Attachment uploaded successfully");
		} catch {
			toast.error("Failed to upload attachment. Please try again.");
		} finally {
			setIsUploading(false);
			setPendingFile(null);
			setPendingName("");
		}
	}, [pendingFile, pendingName, upload]);

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
				toast.success(`"${fileName}" downloaded successfully`);
			} catch {
				toast.error("Failed to download attachment. Please try again.");
			}
		},
		[download],
	);

	const handleDelete = useCallback(
		async (attachmentId: string) => {
			try {
				await remove.mutateAsync(attachmentId);
				toast.success("Attachment deleted");
			} catch {
				toast.error("Failed to delete attachment. Please try again.");
			}
		},
		[remove],
	);

	return (
		<div className="mt-3 space-y-3">
			<div className="flex items-center justify-between">
				<span className="font-medium text-sm">
					Attachments
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
							Attach file
						</Button>
					</>
				)}
			</div>

			{/* Name input shown after picking a file */}
			{pendingFile && (
				<div className="space-y-2 rounded-md border p-3">
					<p className="text-muted-foreground text-sm">
						Display name for{" "}
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
							{isUploading ? "Uploading..." : "Upload"}
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
							Cancel
						</Button>
					</div>
				</div>
			)}

			{isLoading && (
				<div className="flex items-center gap-2 text-muted-foreground text-sm">
					<Loader className="h-4 w-4 animate-spin" />
					Loading attachments...
				</div>
			)}

			{!isLoading && attachments.length === 0 && (
				<p className="text-muted-foreground text-sm">No attachments.</p>
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
