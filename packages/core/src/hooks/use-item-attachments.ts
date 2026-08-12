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

import type { KeyRef } from "@bittery/crypto-port";
import {
	resolveAccountScopeId,
	resolveUserIdForScope,
} from "@bittery/storage/account-id";
import { useMutation, useQuery } from "@tanstack/react-query";
import { usePlatform } from "../context/platform-context";
import { createStoredAccountApiClient } from "../services/api-client";
import {
	attachmentBase64ToBytes,
	attachmentBytesToBase64,
	decryptAttachmentBlob,
	decryptAttachmentMeta as decryptAttachmentMetaShared,
	decryptAttachmentName,
	encodeAttachmentBlobEnvelope,
	encryptAttachmentName,
	encryptAttachmentParts,
	parseAttachmentBlobEnvelope,
} from "../services/attachment-crypto";
import { useItem } from "./use-item";

export interface AttachmentMeta {
	id: string;
	itemId: string;
	vaultId: string;
	storageKey: string;
	encryptedName: string;
	encryptedContentType: string;
	encryptionIv: string;
	/** IV used specifically for encryptedContentType. */
	encryptedContentTypeIv: string;
	encryptionAlgorithm: string;
	fileSize: number;
	uploadedBy: string;
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

export type AttachmentUploadErrorCode =
	| "file-too-large"
	| "storage-limit-reached"
	| "unknown";

const ATTACHMENT_FILE_TOO_LARGE_MESSAGE =
	"Attachment file exceeds the maximum allowed size for your current plan.";
const ATTACHMENT_STORAGE_LIMIT_REACHED_MESSAGE =
	"Attachment storage quota has been reached for your current plan.";

export function getAttachmentUploadErrorCode(
	error: unknown,
): AttachmentUploadErrorCode {
	const message =
		error instanceof Error
			? error.message
			: typeof error === "object" &&
					error !== null &&
					"message" in error &&
					typeof error.message === "string"
				? error.message
				: null;

	if (message === ATTACHMENT_FILE_TOO_LARGE_MESSAGE) {
		return "file-too-large";
	}

	if (message === ATTACHMENT_STORAGE_LIMIT_REACHED_MESSAGE) {
		return "storage-limit-reached";
	}

	return "unknown";
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
	const { storage, crypto, core } = usePlatform();
	const { vaultCrypto } = core;

	const {
		rawItem,
		isLoading,
		error,
		refetch: refetchItem,
	} = useItem(itemId ?? "", { enabled: !!itemId });
	const attachments = (rawItem?.attachments ?? []) as AttachmentMeta[];
	const accountScope =
		accountEmail ?? rawItem?.account?.accountId ?? rawItem?.accountEmail;

	async function getAccountApiClient() {
		const accountId = await resolveAccountScopeId(storage, accountScope);
		if (!accountId) {
			throw new Error("Account context is required for attachment operations");
		}
		const accountClient = await createStoredAccountApiClient(
			storage,
			accountId,
		);
		if (!accountClient) {
			throw new Error("Account session is not available");
		}
		return accountClient;
	}

	const entitlementsQuery = useQuery({
		queryKey: ["billing", "entitlements", accountScope ?? "active"],
		queryFn: async () => {
			const accountClient = await getAccountApiClient();
			return (await accountClient.billing.entitlements()).data;
		},
		enabled: Boolean(itemId && accountScope),
	});

	// Helper to get the decrypted vault key
	async function getVaultKey(): Promise<KeyRef> {
		if (!vaultId) throw new Error("vaultId is required");
		const accountId = await resolveAccountScopeId(storage, accountScope);
		if (!accountId) {
			throw new Error("Account context is required");
		}
		const key = await vaultCrypto.getVaultKey({
			vaultId,
			accountId,
		});
		if (!key) throw new Error("Vault key not found. Please sign in again.");
		return key;
	}

	async function withVaultKey<T>(
		work: (key: KeyRef) => Promise<T>,
	): Promise<T> {
		const key = await getVaultKey();
		try {
			return await work(key);
		} finally {
			await crypto.destroyKey(key);
		}
	}

	async function getCurrentUserId(): Promise<string> {
		return resolveUserIdForScope(storage, accountScope, {
			errorMessage: "User ID not available for attachment encryption context",
		});
	}

	// Decrypt attachment metadata (name + contentType)
	async function decryptAttachmentMeta(
		attachment: AttachmentMeta,
	): Promise<DecryptedAttachment> {
		return withVaultKey(async (vaultKey) => {
			const contextUserId = attachment.uploadedBy;
			const { name, contentType } = await decryptAttachmentMetaShared(
				vaultCrypto,
				vaultKey,
				{
					vaultId: attachment.vaultId,
					attachmentKey: attachment.storageKey,
					userId: contextUserId,
				},
				attachment,
			);
			return { ...attachment, name, contentType };
		});
	}

	/** Refresh local repository snapshot after attachment mutation succeeds */
	function invalidateItem() {
		void refetchItem();
	}

	// Upload mutation
	const uploadMutation = useMutation({
		mutationFn: async (file: FileInput & { displayName?: string }) => {
			if (!itemId) throw new Error("itemId is required");
			if (!vaultId) throw new Error("vaultId is required");
			return withVaultKey(async (vaultKey) => {
				const userId = await getCurrentUserId();
				const accountClient = await getAccountApiClient();

				// Read file as ArrayBuffer and convert to base64
				const fileBuffer = await file.arrayBuffer();
				const fileBytes = new Uint8Array(fileBuffer);
				const base64File = attachmentBytesToBase64(fileBytes);

				// storageKey is stable and available before metadata creation, so we use it
				// as the attachment entity key for context binding.
				const { data: upload } = await accountClient.attachments.createUpload(
					itemId,
					{
						fileName: `${globalThis.crypto?.randomUUID?.() ?? Date.now()}.enc`,
						contentType: "application/octet-stream",
						fileSize: file.size,
					},
				);

				// Use custom display name if provided, otherwise use the file name
				const nameToEncrypt = file.displayName?.trim() || file.name;

				// Encrypt blob, name and content-type (each with its own IV) in one shot.
				const encrypted = await encryptAttachmentParts(
					vaultCrypto,
					vaultKey,
					{ vaultId, attachmentKey: upload.key, userId },
					{
						base64File,
						name: nameToEncrypt,
						contentType: file.type || "application/octet-stream",
					},
				);

				// Upload encrypted file content to S3
				const encryptedBlob = encodeAttachmentBlobEnvelope(
					encrypted.blobEnvelope,
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
				await accountClient.attachments.create(itemId, {
					storageKey: upload.key,
					encryptedName: encrypted.encryptedName,
					encryptedContentType: encrypted.encryptedContentType,
					encryptionIv: encrypted.encryptionIv,
					encryptedContentTypeIv: encrypted.encryptedContentTypeIv,
					encryptionAlgorithm: encrypted.encryptionAlgorithm,
					fileSize: file.size,
				});
			});
		},
		onSuccess: () => {
			invalidateItem();
		},
	});

	// Download mutation - fetches, decrypts, and returns a Blob URL
	const downloadMutation = useMutation({
		mutationFn: async (attachment: AttachmentMeta) => {
			return withVaultKey(async (vaultKey) => {
				const contextUserId = attachment.uploadedBy;
				const scope = {
					vaultId: attachment.vaultId,
					attachmentKey: attachment.storageKey,
					userId: contextUserId,
				};

				// Get presigned download URL + encrypted metadata from server
				const {
					data: {
						downloadUrl,
						encryptionIv,
						encryptionAlgorithm,
						encryptedName,
					},
				} = await (await getAccountApiClient()).attachments.createDownloadUrl(
					attachment.id,
				);

				// Fetch encrypted file from S3
				const response = await fetch(downloadUrl);
				if (!response.ok) throw new Error("Failed to download attachment");

				const encryptedJson = await response.text();
				const encryptedFile = parseAttachmentBlobEnvelope(encryptedJson);

				// Decrypt file contents
				const base64File = await decryptAttachmentBlob(
					vaultCrypto,
					vaultKey,
					scope,
					encryptedFile,
				);

				// Decrypt filename
				const fileName = await decryptAttachmentName(
					vaultCrypto,
					vaultKey,
					scope,
					{
						ciphertext: encryptedName,
						iv: encryptionIv,
						algorithm: encryptionAlgorithm,
					},
				);

				// Convert base64 back to binary
				const bytes = attachmentBase64ToBytes(base64File);

				return { bytes, fileName };
			});
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
			const attachment = attachments.find((entry) => entry.id === attachmentId);
			if (!attachment) {
				throw new Error("Attachment metadata not found");
			}
			return withVaultKey(async (vaultKey) => {
				const contextUserId = attachment.uploadedBy;
				const encryptedName = await encryptAttachmentName(
					vaultCrypto,
					vaultKey,
					{
						vaultId: attachment.vaultId,
						attachmentKey: attachment.storageKey,
						userId: contextUserId,
					},
					newName.trim(),
				);
				await (await getAccountApiClient()).attachments.update(attachmentId, {
					encryptedName: encryptedName.ciphertext,
					encryptionIv: encryptedName.iv,
					encryptionAlgorithm: encryptedName.algorithm,
				});
			});
		},
		onSuccess: () => {
			invalidateItem();
		},
	});

	// Delete mutation
	const deleteMutation = useMutation({
		mutationFn: async (attachmentId: string) => {
			await (await getAccountApiClient()).attachments.remove(attachmentId);
		},
		onSuccess: () => {
			invalidateItem();
		},
	});

	return {
		attachments: attachments as AttachmentMeta[],
		isLoading,
		error,
		attachmentMaxFileSizeBytes:
			entitlementsQuery.data?.limits.attachmentMaxFileSizeBytes ?? null,
		attachmentStorageBytes:
			entitlementsQuery.data?.limits.attachmentStorageBytes ?? null,
		upload: uploadMutation,
		download: downloadMutation,
		remove: deleteMutation,
		rename: renameMutation,
		decryptMeta: decryptAttachmentMeta,
	};
}
