/**
 * ItemAttachments Component
 *
 * Displays encrypted file attachments for a vault item.
 * Supports upload, download (with client-side decryption), preview, and delete.
 */

import type { AttachmentMeta } from "@bittery/core/hooks";
import { useItemAttachments } from "@bittery/core/hooks";
import { Button, toast } from "@bittery/ui";
import {
	IconFileLockOutlineDuo18 as FileIcon,
	IconLoader2Fill18 as Loader,
	IconTrash2OutlineDuo18 as Trash,
	IconUpload3OutlineDuo18 as Upload,
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
}: {
	attachment: AttachmentMeta;
	onDownload: (attachment: AttachmentMeta) => void;
	onDelete: (attachmentId: string) => void;
	canEdit: boolean;
}) {
	const [decryptedName, setDecryptedName] = useState<string | null>(null);
	const { decryptMeta } = useItemAttachments(
		attachment.itemId,
		attachment.vaultId,
	);

	// Lazy-decrypt the name on mount
	// biome-ignore lint/correctness/useExhaustiveDependencies: decryptMeta is stable for same vault
	useEffect(() => {
		decryptMeta(attachment)
			.then((d) => setDecryptedName(d.name))
			.catch(() => setDecryptedName("Encrypted file"));
	}, [attachment.id]);

	const displayName = decryptedName ?? "Loading...";

	return (
		<div className="flex items-center gap-3 rounded-md border p-3">
			<FileIcon size={18} className="shrink-0 text-muted-foreground" />
			<div className="min-w-0 flex-1">
				<p className="truncate font-medium text-sm" title={displayName}>
					{displayName}
				</p>
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
					<Upload size={16} className="rotate-180" />
				</Button>
				{canEdit && (
					<Button
						size="sm"
						variant="ghost"
						className="text-destructive hover:bg-destructive/10 hover:text-destructive"
						onClick={() => onDelete(attachment.id)}
						title="Delete attachment"
					>
						<Trash size={16} />
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

	const { attachments, isLoading, upload, download, remove } =
		useItemAttachments(itemId, vaultId, accountEmail);

	const handleFileChange = useCallback(
		async (e: React.ChangeEvent<HTMLInputElement>) => {
			const file = e.target.files?.[0];
			if (!file) return;

			// 25 MB limit
			if (file.size > 25 * 1024 * 1024) {
				toast.error("File too large. Maximum size is 25 MB.");
				return;
			}

			setIsUploading(true);
			try {
				await upload.mutateAsync(file);
				toast.success("Attachment uploaded successfully");
			} catch {
				toast.error("Failed to upload attachment. Please try again.");
			} finally {
				setIsUploading(false);
				// Reset input so the same file can be re-selected
				if (fileInputRef.current) fileInputRef.current.value = "";
			}
		},
		[upload],
	);

	const handleDownload = useCallback(
		async (attachment: AttachmentMeta) => {
			try {
				const { bytes, fileName } = await download.mutateAsync(attachment);

				// Create a blob URL for download/preview
				const blob = new Blob([bytes]);
				const url = URL.createObjectURL(blob);

				// Try to detect if it's previewable
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
					// Open in new tab for preview
					window.open(url, "_blank");
				} else {
					// Trigger download
					const a = document.createElement("a");
					a.href = url;
					a.download = fileName;
					document.body.appendChild(a);
					a.click();
					document.body.removeChild(a);
				}

				// Clean up the object URL after a delay
				setTimeout(() => URL.revokeObjectURL(url), 60_000);
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
		<div className="space-y-3">
			<div className="flex items-center justify-between">
				<span className="font-medium text-muted-foreground text-sm">
					Attachments
					{attachments.length > 0 && (
						<span className="ml-1 text-muted-foreground">
							({attachments.length})
						</span>
					)}
				</span>
				{canEdit && (
					<>
						<input
							ref={fileInputRef}
							type="file"
							className="hidden"
							onChange={handleFileChange}
							disabled={isUploading}
						/>
						<Button
							size="sm"
							variant="outline"
							onClick={() => fileInputRef.current?.click()}
							disabled={isUploading}
						>
							{isUploading ? (
								<Loader className="mr-1 animate-spin" />
							) : (
								<Upload size={14} className="mr-1" />
							)}
							{isUploading ? "Uploading..." : "Attach file"}
						</Button>
					</>
				)}
			</div>

			{isLoading && (
				<div className="flex items-center gap-2 text-muted-foreground text-sm">
					<Loader className="animate-spin" />
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
						/>
					))}
				</div>
			)}
		</div>
	);
}
