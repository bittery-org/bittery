/**
 * useItemAttachments Hook
 *
 * Provides attachment operations for vault items:
 * - List attachments (derived from local `useItem` repository state)
 * - Upload (encrypt client-side → presigned upload → save metadata)
 * - Download (get presigned URL → fetch encrypted blob → decrypt → save/preview)
 * - Rename (re-encrypt name with a new IV)
 * - Delete
 */

import {
	getDecryptedVaultKey,
	type VaultKeyCryptoProvider,
} from "@bittery/shared";
import { useTRPCClient } from "@bittery/shared/trpc";
import { useMutation } from "@tanstack/react-query";
import { usePlatform } from "../context/platform-context";
import { useItem } from "./use-item";

export interface AttachmentMeta {
	id: string;
	itemId: string;
	vaultId: string;
	storageKey: string;
	encryptedName: string;
	encryptedContentType: string;
	encryptionIv: string;
	/** IV used specifically for encryptedContentType. Falls back to encryptionIv for old rows. */
	encryptedContentTypeIv: string | null;
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
 *
 * Attachment list is read from local repository state via `useItem`.
 * This means opening item detail does not trigger `vault.getItem` network calls.
 * After attachment mutations, we refresh repository data through the shared refetch path.
 *
 * @param itemId - The item to manage attachments for
 * @param vaultId - The vault the item belongs to (needed to look up vault key)
 * @param accountEmail - Optional account email for multi-account support
 */
export function useItemAttachments(
	itemId: string | undefined,
	vaultId: string | undefined,
	accountEmail?: string,
) {
	const client = useTRPCClient();
	const { storage, crypto } = usePlatform();

	const {
		rawItem,
		isLoading,
		error,
		refetch: refetchItem,
	} = useItem(itemId ?? "", { enabled: !!itemId });
	const attachments = (rawItem?.attachments ?? []) as AttachmentMeta[];

	// Helper to get the decrypted vault key
	async function getVaultKey(): Promise<Uint8Array> {
		if (!vaultId) throw new Error("vaultId is required");
		const key = await getDecryptedVaultKey({
			vaultId,
			email: accountEmail,
			storage,
			crypto: crypto as unknown as VaultKeyCryptoProvider,
		});
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
				// Use the dedicated content-type IV if present, otherwise fall back
				// to the name IV (for attachments created before this fix)
				iv: attachment.encryptedContentTypeIv ?? attachment.encryptionIv,
				algorithm: attachment.encryptionAlgorithm,
			},
			vaultKey,
		);
		return { ...attachment, name, contentType };
	}

	/** Refresh local repository snapshot after attachment mutation succeeds */
	function invalidateItem() {
		void refetchItem();
	}

	// Upload mutation
	const uploadMutation = useMutation({
		mutationFn: async (file: FileInput & { displayName?: string }) => {
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

			// Use custom display name if provided, otherwise use the file name
			const nameToEncrypt = file.displayName?.trim() || file.name;

			// Encrypt name and content-type with separate IVs
			const encryptedName = await crypto.encrypt(nameToEncrypt, vaultKey);
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
				encryptedContentTypeIv: encryptedContentType.iv,
				encryptionAlgorithm: encryptedName.algorithm,
				fileSize: file.size,
			});
		},
		onSuccess: () => {
			invalidateItem();
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

	// Rename mutation
	const renameMutation = useMutation({
		mutationFn: async ({
			attachmentId,
			newName,
		}: {
			attachmentId: string;
			newName: string;
		}) => {
			const vaultKey = await getVaultKey();
			const encryptedName = await crypto.encrypt(newName.trim(), vaultKey);
			await client.vault.updateAttachment.mutate({
				attachmentId,
				encryptedName: encryptedName.ciphertext,
				encryptionIv: encryptedName.iv,
				encryptionAlgorithm: encryptedName.algorithm,
			});
		},
		onSuccess: () => {
			invalidateItem();
		},
	});

	// Delete mutation
	const deleteMutation = useMutation({
		mutationFn: async (attachmentId: string) => {
			await client.vault.deleteAttachment.mutate({ attachmentId });
		},
		onSuccess: () => {
			invalidateItem();
		},
	});

	return {
		attachments: attachments as AttachmentMeta[],
		isLoading,
		error,
		upload: uploadMutation,
		download: downloadMutation,
		remove: deleteMutation,
		rename: renameMutation,
		decryptMeta: decryptAttachmentMeta,
	};
}
