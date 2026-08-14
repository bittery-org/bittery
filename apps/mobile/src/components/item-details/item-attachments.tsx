import type { AttachmentMeta, FileInput } from "@bittery/core/hooks";
import {
	getAttachmentUploadErrorCode,
	useItemAttachments,
} from "@bittery/core/hooks";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system";
import * as Sharing from "expo-sharing";
import { Input, PressableFeedback, TextField, useToast } from "heroui-native";
import { useCallback, useState } from "react";
import { ActivityIndicator, Alert, Text, View } from "react-native";
import {
	BrandButton,
	IconCheck,
	IconDownload,
	IconFile,
	IconPaperclip,
	IconPencil,
	IconTrash,
	IconX,
	iconSize,
	ListCard,
} from "@/components/ui";
import { useI18n } from "@/providers/i18n-provider";
import { DetailSection } from "./detail-section";
import { RowAction } from "./field-row";

interface ItemAttachmentsProps {
	itemId: string;
	vaultId: string;
	accountId: string;
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
	accountId,
}: {
	attachment: AttachmentMeta;
	onDownload: (attachment: AttachmentMeta) => void;
	onDelete: (attachmentId: string) => void;
	canEdit: boolean;
	accountId: string;
}) {
	const [decryptedName, setDecryptedName] = useState<string | null>(null);
	const [isEditing, setIsEditing] = useState(false);
	const [editValue, setEditValue] = useState("");
	const [isRenaming, setIsRenaming] = useState(false);
	const { toast } = useToast();
	const { m } = useI18n();
	const queryClient = useQueryClient();
	const { decryptMeta, rename } = useItemAttachments(
		attachment.itemId,
		attachment.vaultId,
		accountId,
	);
	const decryptedNameQuery = useQuery({
		queryKey: [
			"attachment",
			attachment.vaultId,
			attachment.itemId,
			attachment.id,
			accountId,
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
			? m.mob_attachments_encrypted_file()
			: m.mob_attachments_loading_name());

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
			queryClient.setQueryData(
				[
					"attachment",
					attachment.vaultId,
					attachment.itemId,
					attachment.id,
					accountId,
				],
				trimmed,
			);
			setIsEditing(false);
			toast.show({
				variant: "accent",
				label: m.mob_attachments_toast_renamed(),
				placement: "bottom",
			});
		} catch {
			toast.show({
				variant: "danger",
				label: m.mob_attachments_toast_rename_failed(),
				placement: "bottom",
			});
		} finally {
			setIsRenaming(false);
		}
	}

	return (
		<View className="flex-row items-center gap-3 px-4 py-3">
			<View className="h-10 w-10 items-center justify-center rounded-xl bg-field-background">
				<IconFile size={iconSize.row} className="text-muted" />
			</View>
			<View className="min-w-0 flex-1">
				{isEditing ? (
					<View className="flex-row items-center gap-1">
						<TextField className="flex-1">
							<Input
								value={editValue}
								onChangeText={setEditValue}
								autoFocus
								editable={!isRenaming}
								submitBehavior="submit"
								onSubmitEditing={confirmRename}
							/>
						</TextField>
						{isRenaming ? (
							<ActivityIndicator size="small" />
						) : (
							<RowAction
								icon={IconCheck}
								accessibilityLabel={m.mob_attachments_toast_renamed()}
								onPress={confirmRename}
							/>
						)}
						<RowAction
							icon={IconX}
							accessibilityLabel={m.mob_attachments_cancel()}
							onPress={() => setIsEditing(false)}
						/>
					</View>
				) : (
					<>
						<Text
							numberOfLines={1}
							className="font-medium text-base text-foreground"
						>
							{displayName}
						</Text>
						<Text className="mt-0.5 text-muted text-sm">
							{formatBytes(attachment.fileSize)}
						</Text>
					</>
				)}
			</View>
			{isEditing ? null : (
				<View className="flex-row items-center">
					<RowAction
						icon={IconDownload}
						accessibilityLabel={m.mob_attachments_save_dialog_title({
							fileName: displayName,
						})}
						onPress={() => onDownload(attachment)}
					/>
					{canEdit ? (
						<RowAction
							icon={IconPencil}
							accessibilityLabel={m.mob_item_header_action_edit()}
							onPress={startEdit}
						/>
					) : null}
					{canEdit ? (
						<PressableFeedback
							onPress={() => onDelete(attachment.id)}
							accessibilityRole="button"
							accessibilityLabel={m.mob_attachments_delete_dialog_title()}
							className="h-10 w-10 items-center justify-center rounded-full"
						>
							<PressableFeedback.Highlight />
							<IconTrash size={iconSize.row} className="text-danger" />
						</PressableFeedback>
					) : null}
				</View>
			)}
		</View>
	);
}

export function ItemAttachments({
	itemId,
	vaultId,
	accountId,
	canEdit = false,
}: ItemAttachmentsProps) {
	const { m } = useI18n();
	const { toast } = useToast();
	const [isUploading, setIsUploading] = useState(false);
	const [isDownloading, setIsDownloading] = useState(false);
	// Pending file waiting for a display name before upload
	const [pendingAsset, setPendingAsset] =
		useState<DocumentPicker.DocumentPickerAsset | null>(null);
	const [pendingName, setPendingName] = useState("");

	const {
		attachments,
		isLoading,
		upload,
		download,
		remove,
		attachmentMaxFileSizeBytes,
	} = useItemAttachments(itemId, vaultId, accountId);

	const handlePickFile = useCallback(async () => {
		const result = await DocumentPicker.getDocumentAsync({
			copyToCacheDirectory: true,
			multiple: false,
		});

		if (result.canceled) return;

		const [asset] = result.assets;
		if (!asset) return;

		if (
			attachmentMaxFileSizeBytes !== null &&
			(asset.size ?? 0) > attachmentMaxFileSizeBytes
		) {
			toast.show({
				variant: "danger",
				label: m.vaults_detail_items_attachments_toast_file_too_large({
					maxFileSize: formatBytes(Number(attachmentMaxFileSizeBytes)),
				}),
				placement: "bottom",
			});
			return;
		}

		setPendingName(asset.name);
		setPendingAsset(asset);
	}, [attachmentMaxFileSizeBytes, m, toast]);

	const handleConfirmUpload = useCallback(async () => {
		if (!pendingAsset) return;
		setIsUploading(true);
		try {
			const fileInput = createFileInputFromAsset(pendingAsset);
			await upload.mutateAsync(
				Object.assign(fileInput, {
					displayName: pendingName.trim() || pendingAsset.name,
				}),
			);
			toast.show({
				variant: "accent",
				label: m.mob_attachments_toast_uploaded(),
				placement: "bottom",
			});
		} catch (error) {
			const uploadErrorCode = getAttachmentUploadErrorCode(error);
			if (uploadErrorCode === "storage-limit-reached") {
				toast.show({
					variant: "danger",
					label:
						m.vaults_detail_items_attachments_toast_storage_limit_reached(),
					placement: "bottom",
				});
			} else if (
				uploadErrorCode === "file-too-large" &&
				attachmentMaxFileSizeBytes !== null
			) {
				toast.show({
					variant: "danger",
					label: m.vaults_detail_items_attachments_toast_file_too_large({
						maxFileSize: formatBytes(Number(attachmentMaxFileSizeBytes)),
					}),
					placement: "bottom",
				});
			} else {
				toast.show({
					variant: "danger",
					label: m.vaults_detail_items_attachments_toast_upload_failed(),
					placement: "bottom",
				});
			}
		} finally {
			setIsUploading(false);
			setPendingAsset(null);
			setPendingName("");
		}
	}, [attachmentMaxFileSizeBytes, m, pendingAsset, pendingName, toast, upload]);

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
						dialogTitle: m.mob_attachments_save_dialog_title({ fileName }),
						UTI: "public.data",
					});
				} else {
					Alert.alert(
						m.mob_common_error_title(),
						m.mob_attachments_sharing_not_available(),
					);
				}
			} catch {
				toast.show({
					variant: "danger",
					label: m.mob_attachments_toast_download_failed(),
					description: m.mob_attachments_toast_download_failed_description(),
					placement: "bottom",
				});
			} finally {
				setIsDownloading(false);
			}
		},
		[
			download,
			toast,
			m.mob_attachments_save_dialog_title,
			m.mob_attachments_sharing_not_available,
			m.mob_attachments_toast_download_failed,
			m.mob_attachments_toast_download_failed_description,
			m.mob_common_error_title,
		],
	);

	const handleDelete = useCallback(
		async (attachmentId: string) => {
			Alert.alert(
				m.mob_attachments_delete_dialog_title(),
				m.mob_attachments_delete_dialog_message(),
				[
					{ text: m.mob_attachments_delete_dialog_cancel(), style: "cancel" },
					{
						text: m.mob_attachments_delete_dialog_confirm(),
						style: "destructive",
						onPress: async () => {
							try {
								await remove.mutateAsync(attachmentId);
								toast.show({
									variant: "accent",
									label: m.mob_attachments_toast_deleted(),
									placement: "bottom",
								});
							} catch {
								toast.show({
									variant: "danger",
									label: m.mob_attachments_toast_delete_failed(),
									description:
										m.mob_attachments_toast_delete_failed_description(),
									placement: "bottom",
								});
							}
						},
					},
				],
			);
		},
		[
			remove,
			toast,
			m.mob_attachments_delete_dialog_cancel,
			m.mob_attachments_delete_dialog_confirm,
			m.mob_attachments_delete_dialog_message,
			m.mob_attachments_delete_dialog_title,
			m.mob_attachments_toast_delete_failed,
			m.mob_attachments_toast_delete_failed_description,
			m.mob_attachments_toast_deleted,
		],
	);

	const attachButton = canEdit ? (
		<PressableFeedback
			onPress={handlePickFile}
			isDisabled={isUploading || !!pendingAsset}
			accessibilityRole="button"
			accessibilityLabel={m.mob_attachments_attach_button()}
			className="h-8 flex-row items-center gap-1.5 rounded-full px-2"
		>
			<PressableFeedback.Highlight />
			<IconPaperclip size={iconSize.chip} className="text-accent" />
			<Text className="font-medium text-accent text-sm">
				{m.mob_attachments_attach_button()}
			</Text>
		</PressableFeedback>
	) : null;

	return (
		<DetailSection
			title={
				attachments.length > 0
					? m.mob_attachments_title_count({ count: String(attachments.length) })
					: m.mob_attachments_title()
			}
			action={attachButton}
		>
			<ListCard>
				{pendingAsset ? (
					<View className="gap-3 p-4">
						<Text className="text-muted text-sm">
							{m.mob_attachments_display_name_label()}{" "}
							<Text className="font-medium text-foreground">
								{pendingAsset.name}
							</Text>
						</Text>
						<TextField>
							<Input
								value={pendingName}
								onChangeText={setPendingName}
								placeholder={pendingAsset.name}
								editable={!isUploading}
								submitBehavior="submit"
								onSubmitEditing={handleConfirmUpload}
							/>
						</TextField>
						<View className="flex-row gap-2">
							<BrandButton
								label={
									isUploading
										? m.mob_attachments_uploading()
										: m.mob_attachments_upload_button()
								}
								onPress={handleConfirmUpload}
								isLoading={isUploading}
								fullWidth={false}
								className="flex-1"
							/>
							<PressableFeedback
								onPress={() => {
									setPendingAsset(null);
									setPendingName("");
								}}
								isDisabled={isUploading}
								accessibilityRole="button"
								accessibilityLabel={m.mob_attachments_cancel()}
								className="h-11 flex-1 items-center justify-center rounded-xl border border-border"
							>
								<PressableFeedback.Highlight />
								<Text className="font-medium text-base text-foreground">
									{m.mob_attachments_cancel()}
								</Text>
							</PressableFeedback>
						</View>
					</View>
				) : null}

				{isLoading ? (
					<View className="flex-row items-center gap-2 px-4 py-4">
						<ActivityIndicator size="small" />
						<Text className="text-muted text-sm">
							{m.mob_attachments_loading()}
						</Text>
					</View>
				) : null}

				{!isLoading && attachments.length === 0 && !pendingAsset ? (
					<View className="px-4 py-4">
						<Text className="text-muted text-sm">
							{m.mob_attachments_empty()}
						</Text>
					</View>
				) : null}

				{!isLoading
					? attachments.map((attachment) => (
							<AttachmentRow
								key={attachment.id}
								attachment={attachment}
								onDownload={handleDownload}
								onDelete={handleDelete}
								canEdit={canEdit}
								accountId={accountId}
							/>
						))
					: null}

				{isDownloading ? (
					<View className="flex-row items-center gap-2 px-4 py-3">
						<ActivityIndicator size="small" />
						<Text className="text-muted text-sm">
							{m.mob_attachments_preparing_download()}
						</Text>
					</View>
				) : null}
			</ListCard>
		</DetailSection>
	);
}
