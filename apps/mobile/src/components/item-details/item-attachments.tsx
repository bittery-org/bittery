import type { AttachmentMeta, FileInput } from "@bittery/core/hooks";
import { useItemAttachments } from "@bittery/core/hooks";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system";
import * as Sharing from "expo-sharing";
import { Button, Card, useToast } from "heroui-native";
import {
	Check,
	Download,
	File,
	Loader2,
	Paperclip,
	Pencil,
	Trash2,
	X,
} from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Text, TextInput, View } from "react-native";
import { withUniwind } from "uniwind";

const StyledFile = withUniwind(File);
const StyledDownload = withUniwind(Download);
const StyledTrash2 = withUniwind(Trash2);
const StyledPaperclip = withUniwind(Paperclip);
const StyledLoader2 = withUniwind(Loader2);
const StyledPencil = withUniwind(Pencil);
const StyledCheck = withUniwind(Check);
const StyledX = withUniwind(X);

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
	const { toast } = useToast();
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
			await rename.mutateAsync({ attachmentId: attachment.id, newName: trimmed });
			setDecryptedName(trimmed);
			setIsEditing(false);
			toast.show({ variant: "accent", label: "Attachment renamed", placement: "bottom" });
		} catch {
			toast.show({ variant: "danger", label: "Rename failed", placement: "bottom" });
		} finally {
			setIsRenaming(false);
		}
	}

	return (
		<Card variant="default" className="mb-2">
			<Card.Body className="py-2">
				<View className="flex-row items-center gap-3">
					<StyledFile size={18} className="shrink-0 text-muted" />
					<View className="flex-1">
						{isEditing ? (
							<View className="flex-row items-center gap-1">
								<TextInput
									value={editValue}
									onChangeText={setEditValue}
									className="flex-1 text-foreground text-sm border-b border-muted pb-0.5"
									autoFocus
									editable={!isRenaming}
									submitBehavior="submit"
									onSubmitEditing={confirmRename}
								/>
								<Button isIconOnly size="sm" variant="ghost" onPress={confirmRename} isDisabled={isRenaming}>
									{isRenaming
										? <StyledLoader2 size={14} className="animate-spin text-foreground" />
										: <StyledCheck size={14} className="text-foreground" />}
								</Button>
								<Button isIconOnly size="sm" variant="ghost" onPress={() => setIsEditing(false)} isDisabled={isRenaming}>
									<StyledX size={14} className="text-foreground" />
								</Button>
							</View>
						) : (
							<Text
								className="font-medium text-foreground text-sm"
								numberOfLines={1}
							>
								{displayName}
							</Text>
						)}
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
						{canEdit && !isEditing && (
							<Button isIconOnly size="sm" variant="ghost" onPress={startEdit}>
								<StyledPencil size={18} className="text-foreground" />
							</Button>
						)}
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
	// Pending file waiting for a display name before upload
	const [pendingAsset, setPendingAsset] = useState<DocumentPicker.DocumentPickerAsset | null>(null);
	const [pendingName, setPendingName] = useState("");

	const { attachments, isLoading, upload, download, remove } =
		useItemAttachments(itemId, vaultId, accountEmail);

	const handlePickFile = useCallback(async () => {
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

		setPendingName(asset.name);
		setPendingAsset(asset);
	}, []);

	const handleConfirmUpload = useCallback(async () => {
		if (!pendingAsset) return;
		setIsUploading(true);
		try {
			const fileInput = createFileInputFromAsset(pendingAsset);
			await upload.mutateAsync(
				Object.assign(fileInput, { displayName: pendingName.trim() || pendingAsset.name }),
			);
			toast.show({ variant: "accent", label: "Attachment uploaded", placement: "bottom" });
		} catch {
			toast.show({
				variant: "danger",
				label: "Upload failed",
				description: "Failed to upload attachment. Please try again.",
				placement: "bottom",
			});
		} finally {
			setIsUploading(false);
			setPendingAsset(null);
			setPendingName("");
		}
	}, [pendingAsset, pendingName, upload, toast]);

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
							onPress={handlePickFile}
							isDisabled={isUploading || !!pendingAsset}
						>
							<StyledPaperclip size={14} className="text-foreground" />
							<Text className="ml-1 text-foreground text-sm">Attach</Text>
						</Button>
					)}
				</View>

				{/* Name input shown after picking a file */}
				{pendingAsset && (
					<View className="mb-2 rounded-md border border-muted p-2 gap-2">
						<Text className="text-muted text-xs">
							Display name for{" "}
							<Text className="text-foreground font-medium">{pendingAsset.name}</Text>
						</Text>
						<TextInput
							value={pendingName}
							onChangeText={setPendingName}
							className="text-foreground text-sm border border-muted rounded px-2 py-1"
							placeholder={pendingAsset.name}
							editable={!isUploading}
							submitBehavior="submit"
							onSubmitEditing={handleConfirmUpload}
						/>
						<View className="flex-row gap-2">
							<Button size="sm" onPress={handleConfirmUpload} isDisabled={isUploading} className="flex-1">
								{isUploading
									? <StyledLoader2 size={14} className="animate-spin text-foreground mr-1" />
									: null}
								<Text className="text-sm">{isUploading ? "Uploading..." : "Upload"}</Text>
							</Button>
							<Button size="sm" variant="ghost" onPress={() => { setPendingAsset(null); setPendingName(""); }} isDisabled={isUploading}>
								<Text className="text-sm">Cancel</Text>
							</Button>
						</View>
					</View>
				)}

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
								accountEmail={accountEmail}
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
