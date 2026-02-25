/**
 * useItemAttachments Hook
 *
 * Provides attachment operations for vault items:
 * - List attachments
 * - Upload (encrypt client-side → presigned upload → save metadata)
 * - Download (get presigned URL → fetch encrypted blob → decrypt → save/preview)
 * - Delete
 */

import { useTRPC, useTRPCClient } from "@bittery/shared/trpc";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { usePlatform } from "../context/platform-context";

export interface AttachmentMeta {
	id: string;
	itemId: string;
	vaultId: string;
	storageKey: string;
	encryptedName: string;
	encryptedContentType: string;
	encryptionIv: string;
	encryptionAlgorithm: string;
	fileSize: number;
	uploadedBy: string | null;
	createdAt: Date | string;
}

export interface DecryptedAttachment extends AttachmentMeta {
	name: string;
	contentType: string;
}

/**
 * Platform-agnostic file input interface.
 * Compatible with the browser's `File` API and React Native file adapters.
 */
export interface FileInput {
	name: string;
	type: string;
	size: number;
	arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * Hook to list, upload, download, and delete attachments for a vault item.
 * @param itemId - The item to manage attachments for
 * @param vaultId - The vault the item belongs to (needed to look up vault key)
 * @param accountEmail - Optional account email for multi-account support
 */
export function useItemAttachments(
	itemId: string | undefined,
	vaultId: string | undefined,
	accountEmail?: string,
) {
	const trpc = useTRPC();
	const client = useTRPCClient();
	const { storage, crypto } = usePlatform();
	const queryClient = useQueryClient();

	const queryKey = trpc.vault.listAttachments.queryKey({
		itemId: itemId ?? "",
	});

	// List attachments
	const {
		data: attachments = [],
		isLoading,
		error,
	} = useQuery(
		trpc.vault.listAttachments.queryOptions(
			{ itemId: itemId ?? "" },
			{ enabled: !!itemId },
		),
	);

	// Helper to get the decrypted vault key
	async function getVaultKey(): Promise<Uint8Array> {
		if (!vaultId) throw new Error("vaultId is required");
		const key = await storage.getDecryptedVaultKey(vaultId, accountEmail);
		if (!key) throw new Error("Vault key not found. Please sign in again.");
		return key;
	}

	// Decrypt attachment metadata (name + contentType)
	async function decryptAttachmentMeta(
		attachment: AttachmentMeta,
	): Promise<DecryptedAttachment> {
		const vaultKey = await getVaultKey();
		const name = await crypto.decrypt(
			{
				ciphertext: attachment.encryptedName,
				iv: attachment.encryptionIv,
				algorithm: attachment.encryptionAlgorithm,
			},
			vaultKey,
		);
		const contentType = await crypto.decrypt(
			{
				ciphertext: attachment.encryptedContentType,
				iv: attachment.encryptionIv,
				algorithm: attachment.encryptionAlgorithm,
			},
			vaultKey,
		);
		return { ...attachment, name, contentType };
	}

	// Upload mutation
	const uploadMutation = useMutation({
		mutationFn: async (file: FileInput) => {
			if (!itemId) throw new Error("itemId is required");
			const vaultKey = await getVaultKey();

			// Read file as ArrayBuffer and convert to base64
			const fileBuffer = await file.arrayBuffer();
			const fileBytes = new Uint8Array(fileBuffer);
			const base64File = btoa(
				fileBytes.reduce((data, byte) => data + String.fromCharCode(byte), ""),
			);

			// Encrypt the file contents
			const encryptedFile = await crypto.encrypt(base64File, vaultKey);

			// Encrypt the metadata (name + content type share the same IV)
			const encryptedName = await crypto.encrypt(file.name, vaultKey);
			const encryptedContentType = await crypto.encrypt(
				file.type || "application/octet-stream",
				vaultKey,
			);

			// Get presigned upload URL
			const upload = await client.vault.createAttachmentUpload.mutate({
				itemId,
				fileName: `${encryptedFile.iv}.enc`,
				contentType: "application/octet-stream",
			});

			// Upload encrypted file content to S3
			const encryptedBlob = new TextEncoder().encode(
				JSON.stringify(encryptedFile),
			);
			const uploadResponse = await fetch(upload.uploadUrl, {
				method: "PUT",
				headers: { "Content-Type": "application/octet-stream" },
				body: encryptedBlob,
			});

			if (!uploadResponse.ok) {
				throw new Error("Failed to upload attachment");
			}

			// Save metadata
			await client.vault.createAttachment.mutate({
				itemId,
				storageKey: upload.key,
				encryptedName: encryptedName.ciphertext,
				encryptedContentType: encryptedContentType.ciphertext,
				encryptionIv: encryptedName.iv,
				encryptionAlgorithm: encryptedName.algorithm,
				fileSize: file.size,
			});
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey });
		},
	});

	// Download mutation - fetches, decrypts, and returns a Blob URL
	const downloadMutation = useMutation({
		mutationFn: async (attachment: AttachmentMeta) => {
			const vaultKey = await getVaultKey();

			// Get presigned download URL + encrypted metadata from server
			const { downloadUrl, encryptionIv, encryptionAlgorithm, encryptedName } =
				await client.vault.getAttachmentDownloadUrl.mutate({
					attachmentId: attachment.id,
				});

			// Fetch encrypted file from S3
			const response = await fetch(downloadUrl);
			if (!response.ok) throw new Error("Failed to download attachment");

			const encryptedJson = await response.text();
			const encryptedFile = JSON.parse(encryptedJson) as {
				ciphertext: string;
				iv: string;
				algorithm: string;
			};

			// Decrypt file contents
			const base64File = await crypto.decrypt(encryptedFile, vaultKey);

			// Decrypt filename
			const fileName = await crypto.decrypt(
				{
					ciphertext: encryptedName,
					iv: encryptionIv,
					algorithm: encryptionAlgorithm,
				},
				vaultKey,
			);

			// Convert base64 back to binary
			const binaryString = atob(base64File);
			const bytes = new Uint8Array(binaryString.length);
			for (let i = 0; i < binaryString.length; i++) {
				bytes[i] = binaryString.charCodeAt(i);
			}

			return { bytes, fileName };
		},
	});

	// Delete mutation
	const deleteMutation = useMutation({
		mutationFn: async (attachmentId: string) => {
			await client.vault.deleteAttachment.mutate({ attachmentId });
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey });
		},
	});

	return {
		attachments: attachments as AttachmentMeta[],
		isLoading,
		error,
		upload: uploadMutation,
		download: downloadMutation,
		remove: deleteMutation,
		decryptMeta: decryptAttachmentMeta,
	};
}
