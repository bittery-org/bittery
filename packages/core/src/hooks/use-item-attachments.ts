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
import { resolveAccountScopeId } from "@bittery/storage/account-id";
import { useMutation, useQuery } from "@tanstack/react-query";
import { usePlatform } from "../context/platform-context";
import {
	buildAttachmentBlobEncryptionContext,
	buildAttachmentContentTypeEncryptionContext,
	buildAttachmentNameEncryptionContext,
} from "../services/encryption-context";
import { createStoredAccountRpcClient } from "../services/account-resolver";
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
	const { storage, crypto } = usePlatform();

	const {
		rawItem,
		isLoading,
		error,
		refetch: refetchItem,
	} = useItem(itemId ?? "", { enabled: !!itemId });
	const attachments = (rawItem?.attachments ?? []) as AttachmentMeta[];
	const accountScope =
		accountEmail ?? rawItem?.account?.accountId ?? rawItem?.accountEmail;

	async function getAccountRpcClient() {
		const accountId = await resolveAccountScopeId(storage, accountScope);
		if (!accountId) {
			throw new Error("Account context is required for attachment operations");
		}
		const accountClient = await createStoredAccountRpcClient(storage, accountId);
		if (!accountClient) {
			throw new Error("Account session is not available");
		}
		return accountClient;
	}

	const entitlementsQuery = useQuery({
		queryKey: ["billing", "entitlements", accountScope ?? "active"],
		queryFn: async () => {
			const accountClient = await getAccountRpcClient();
			return accountClient.billing.entitlements.query();
		},
		enabled: Boolean(itemId && accountScope),
	});

	// Helper to get the decrypted vault key
	async function getVaultKey(): Promise<Uint8Array> {
		if (!vaultId) throw new Error("vaultId is required");
		const accountId = await resolveAccountScopeId(storage, accountScope);
		const key = await getDecryptedVaultKey({
			vaultId,
			accountId,
			storage,
			crypto: crypto as unknown as VaultKeyCryptoProvider,
		});
		if (!key) throw new Error("Vault key not found. Please sign in again.");
		return key;
	}

	async function getCurrentUserId(): Promise<string> {
		const accountId = await resolveAccountScopeId(storage, accountScope);
		const sessionData = await storage.getStoredSessionData?.(accountId);
		if (sessionData?.userId) {
			return sessionData.userId;
		}
		if (accountId) {
			const accountMetadata = await storage.getAccountMetadata?.(accountId);
			if (accountMetadata?.userId) {
				return accountMetadata.userId;
			}
		}
		const activeUserId = await storage.getActiveAccountUserId();
		if (activeUserId) {
			return activeUserId;
		}
		throw new Error("User ID not available for attachment encryption context");
	}

	// Decrypt attachment metadata (name + contentType)
	async function decryptAttachmentMeta(
		attachment: AttachmentMeta,
	): Promise<DecryptedAttachment> {
		const vaultKey = await getVaultKey();
		const contextUserId = attachment.uploadedBy || (await getCurrentUserId());
		const nameContext = buildAttachmentNameEncryptionContext({
			vaultId: attachment.vaultId,
			attachmentKey: attachment.storageKey,
			userId: contextUserId,
		});
		const contentTypeContext = buildAttachmentContentTypeEncryptionContext({
			vaultId: attachment.vaultId,
			attachmentKey: attachment.storageKey,
			userId: contextUserId,
		});
		const name = await crypto.decrypt(
			{
				ciphertext: attachment.encryptedName,
				iv: attachment.encryptionIv,
				algorithm: attachment.encryptionAlgorithm,
			},
			vaultKey,
			nameContext,
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
			contentTypeContext,
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
			if (!vaultId) throw new Error("vaultId is required");
			const vaultKey = await getVaultKey();
			const userId = await getCurrentUserId();
			const accountClient = await getAccountRpcClient();

			// Read file as ArrayBuffer and convert to base64
			const fileBuffer = await file.arrayBuffer();
			const fileBytes = new Uint8Array(fileBuffer);
			const base64File = btoa(
				fileBytes.reduce((data, byte) => data + String.fromCharCode(byte), ""),
			);

			// Encrypt the file contents
			// storageKey is stable and available before metadata creation, so we use it
			// as the attachment entity key for context binding.
			const upload = await accountClient.vault.createAttachmentUpload.mutate({
				itemId,
				fileName: `${globalThis.crypto?.randomUUID?.() ?? Date.now()}.enc`,
				contentType: "application/octet-stream",
				fileSize: file.size,
			});

			const blobContext = buildAttachmentBlobEncryptionContext({
				vaultId,
				attachmentKey: upload.key,
				userId,
			});
			const encryptedFile = await crypto.encrypt(
				base64File,
				vaultKey,
				blobContext,
			);

			// Use custom display name if provided, otherwise use the file name
			const nameToEncrypt = file.displayName?.trim() || file.name;

			// Encrypt name and content-type with separate IVs
			const nameContext = buildAttachmentNameEncryptionContext({
				vaultId,
				attachmentKey: upload.key,
				userId,
			});
			const encryptedName = await crypto.encrypt(
				nameToEncrypt,
				vaultKey,
				nameContext,
			);
			const contentTypeContext = buildAttachmentContentTypeEncryptionContext({
				vaultId,
				attachmentKey: upload.key,
				userId,
			});
			const encryptedContentType = await crypto.encrypt(
				file.type || "application/octet-stream",
				vaultKey,
				contentTypeContext,
			);

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
			await accountClient.vault.createAttachment.mutate({
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
			const contextUserId = attachment.uploadedBy || (await getCurrentUserId());
			const blobContext = buildAttachmentBlobEncryptionContext({
				vaultId: attachment.vaultId,
				attachmentKey: attachment.storageKey,
				userId: contextUserId,
			});
			const nameContext = buildAttachmentNameEncryptionContext({
				vaultId: attachment.vaultId,
				attachmentKey: attachment.storageKey,
				userId: contextUserId,
			});

			// Get presigned download URL + encrypted metadata from server
			const { downloadUrl, encryptionIv, encryptionAlgorithm, encryptedName } =
				await (await getAccountRpcClient()).vault.getAttachmentDownloadUrl.mutate({
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
			const base64File = await crypto.decrypt(
				encryptedFile,
				vaultKey,
				blobContext,
			);

			// Decrypt filename
			const fileName = await crypto.decrypt(
				{
					ciphertext: encryptedName,
					iv: encryptionIv,
					algorithm: encryptionAlgorithm,
				},
				vaultKey,
				nameContext,
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
			const attachment = attachments.find((entry) => entry.id === attachmentId);
			if (!attachment) {
				throw new Error("Attachment metadata not found");
			}
			const contextUserId = attachment.uploadedBy || (await getCurrentUserId());
			const nameContext = buildAttachmentNameEncryptionContext({
				vaultId: attachment.vaultId,
				attachmentKey: attachment.storageKey,
				userId: contextUserId,
			});
			const encryptedName = await crypto.encrypt(
				newName.trim(),
				vaultKey,
				nameContext,
			);
			await (await getAccountRpcClient()).vault.updateAttachment.mutate({
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
			await (await getAccountRpcClient()).vault.deleteAttachment.mutate({
				attachmentId,
			});
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
