import type { AttachmentMeta, FileInput } from "@bittery/core/hooks";
import { useItemAttachments } from "@bittery/core/hooks";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system";
import * as Sharing from "expo-sharing";
import { Button, Card, useToast } from "heroui-native";
import {
	Download,
	File,
	Loader2,
	Paperclip,
	Trash2,
} from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Text, View } from "react-native";
import { withUniwind } from "uniwind";

const StyledFile = withUniwind(File);
const StyledDownload = withUniwind(Download);
const StyledTrash2 = withUniwind(Trash2);
const StyledPaperclip = withUniwind(Paperclip);
const StyledLoader2 = withUniwind(Loader2);

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

/**
 * Create a FileInput adapter from a DocumentPicker asset.
 * Reads file content from the URI using expo-file-system.
 */
function createFileInputFromAsset(
	asset: DocumentPicker.DocumentPickerAsset,
): FileInput {
	return {
		name: asset.name,
		type: asset.mimeType ?? "application/octet-stream",
		size: asset.size ?? 0,
		arrayBuffer: async (): Promise<ArrayBuffer> => {
			return new FileSystem.File(asset.uri).arrayBuffer();
		},
	};
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

	// biome-ignore lint/correctness/useExhaustiveDependencies: decryptMeta is stable for same vault
	useEffect(() => {
		decryptMeta(attachment)
			.then((d) => setDecryptedName(d.name))
			.catch(() => setDecryptedName("Encrypted file"));
	}, [attachment.id]);

	const displayName = decryptedName ?? "Loading...";

	return (
		<Card variant="default" className="mb-2">
			<Card.Body className="py-2">
				<View className="flex-row items-center gap-3">
					<StyledFile size={18} className="shrink-0 text-muted" />
					<View className="flex-1">
						<Text
							className="font-medium text-foreground text-sm"
							numberOfLines={1}
						>
							{displayName}
						</Text>
						<Text className="text-muted text-xs">
							{formatBytes(attachment.fileSize)}
						</Text>
					</View>
					<View className="flex-row items-center gap-1">
						<Button
							isIconOnly
							size="sm"
							variant="ghost"
							onPress={() => onDownload(attachment)}
						>
							<StyledDownload size={18} className="text-foreground" />
						</Button>
						{canEdit && (
							<Button
								isIconOnly
								size="sm"
								variant="ghost"
								onPress={() => onDelete(attachment.id)}
							>
								<StyledTrash2 size={18} className="text-danger" />
							</Button>
						)}
					</View>
				</View>
			</Card.Body>
		</Card>
	);
}

export function ItemAttachments({
	itemId,
	vaultId,
	accountEmail,
	canEdit = false,
}: ItemAttachmentsProps) {
	const { toast } = useToast();
	const [isUploading, setIsUploading] = useState(false);
	const [isDownloading, setIsDownloading] = useState(false);

	const { attachments, isLoading, upload, download, remove } =
		useItemAttachments(itemId, vaultId, accountEmail);

	const handlePickAndUpload = useCallback(async () => {
		const result = await DocumentPicker.getDocumentAsync({
			copyToCacheDirectory: true,
			multiple: false,
		});

		if (result.canceled || result.assets.length === 0) return;

		const asset = result.assets[0];

		// 25 MB limit
		if ((asset.size ?? 0) > 25 * 1024 * 1024) {
			Alert.alert("File too large", "Maximum attachment size is 25 MB.");
			return;
		}

		setIsUploading(true);
		try {
			const fileInput = createFileInputFromAsset(asset);
			await upload.mutateAsync(fileInput);
			toast.show({
				variant: "accent",
				label: "Attachment uploaded",
				placement: "bottom",
			});
		} catch {
			toast.show({
				variant: "danger",
				label: "Upload failed",
				description: "Failed to upload attachment. Please try again.",
				placement: "bottom",
			});
		} finally {
			setIsUploading(false);
		}
	}, [upload, toast]);

	const handleDownload = useCallback(
		async (attachment: AttachmentMeta) => {
			setIsDownloading(true);
			try {
				const { bytes, fileName } = await download.mutateAsync(attachment);

				// Write to a temp file
				const tempFile = new FileSystem.File(FileSystem.Paths.cache, fileName);
				tempFile.write(bytes);

				// Open share sheet so user can save/open the file
				const canShare = await Sharing.isAvailableAsync();
				if (canShare) {
					await Sharing.shareAsync(tempFile.uri, {
						mimeType: "application/octet-stream",
						dialogTitle: `Save ${fileName}`,
						UTI: "public.data",
					});
				} else {
					Alert.alert("Error", "Sharing is not available on this device.");
				}
			} catch {
				toast.show({
					variant: "danger",
					label: "Download failed",
					description: "Failed to download attachment. Please try again.",
					placement: "bottom",
				});
			} finally {
				setIsDownloading(false);
			}
		},
		[download, toast],
	);

	const handleDelete = useCallback(
		async (attachmentId: string) => {
			Alert.alert(
				"Delete Attachment",
				"Are you sure you want to delete this attachment?",
				[
					{ text: "Cancel", style: "cancel" },
					{
						text: "Delete",
						style: "destructive",
						onPress: async () => {
							try {
								await remove.mutateAsync(attachmentId);
								toast.show({
									variant: "accent",
									label: "Attachment deleted",
									placement: "bottom",
								});
							} catch {
								toast.show({
									variant: "danger",
									label: "Delete failed",
									description: "Failed to delete attachment.",
									placement: "bottom",
								});
							}
						},
					},
				],
			);
		},
		[remove, toast],
	);

	return (
		<Card variant="default" className="mb-2">
			<Card.Body className="py-3">
				<View className="mb-2 flex-row items-center justify-between">
					<Card.Description>
						Attachments
						{attachments.length > 0 ? ` (${attachments.length})` : ""}
					</Card.Description>
					{canEdit && (
						<Button
							size="sm"
							variant="ghost"
							onPress={handlePickAndUpload}
							isDisabled={isUploading}
						>
							{isUploading ? (
								<StyledLoader2
									size={14}
									className="animate-spin text-foreground"
								/>
							) : (
								<StyledPaperclip size={14} className="text-foreground" />
							)}
							<Text className="ml-1 text-foreground text-sm">
								{isUploading ? "Uploading..." : "Attach"}
							</Text>
						</Button>
					)}
				</View>

				{isLoading && (
					<View className="flex-row items-center gap-2 py-2">
						<ActivityIndicator size="small" />
						<Text className="text-muted text-sm">Loading attachments...</Text>
					</View>
				)}

				{!isLoading && attachments.length === 0 && (
					<Text className="text-muted text-sm">No attachments.</Text>
				)}

				{!isLoading && attachments.length > 0 && (
					<View>
						{attachments.map((attachment) => (
							<AttachmentRow
								key={attachment.id}
								attachment={attachment}
								onDownload={handleDownload}
								onDelete={handleDelete}
								canEdit={canEdit}
							/>
						))}
					</View>
				)}

				{isDownloading && (
					<View className="mt-2 flex-row items-center gap-2">
						<ActivityIndicator size="small" />
						<Text className="text-muted text-sm">Preparing download...</Text>
					</View>
				)}
			</Card.Body>
		</Card>
	);
}
