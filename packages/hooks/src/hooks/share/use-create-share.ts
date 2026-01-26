/**
 * useCreateShare Hook
 *
 * Creates a secure share link for a vault item.
 * Returns a React Query mutation - apps handle success/error UI and URL generation.
 */

import { useTRPCClient } from "@bittery/shared/trpc";
import type { DecryptedItem } from "@bittery/shared/types";
import { useMutation } from "@tanstack/react-query";
import { usePlatform, useQueryInvalidator } from "../../context/platform-context";

/**
 * Expiration options for share links
 */
export type ShareExpirationOption =
	| "1hour"
	| "1day"
	| "7days"
	| "14days"
	| "30days";

/**
 * Access mode for share links
 */
export type ShareAccessMode = "anyone" | "email-restricted";

/**
 * Input for creating a share link
 */
export interface CreateShareInput {
	/** The decrypted item to share */
	item: DecryptedItem;
	/** Who can access the share link */
	accessMode: ShareAccessMode;
	/** When the link expires */
	expiresIn: ShareExpirationOption;
	/** Whether the link can only be used once */
	isOneTimeUse: boolean;
	/** Email addresses allowed to access (for email-restricted mode) */
	allowedEmails?: string[];
}

/**
 * Result from share creation
 */
export interface CreateShareResult {
	/** The share token from the API */
	token: string;
	/** The share key encoded as base64 (for URL fragment) */
	shareKeyBase64: string;
	/** When the share expires (ISO string) */
	expiresAt: string;
}

/**
 * Helper to convert Uint8Array to base64
 */
function arrayBufferToBase64(buffer: Uint8Array): string {
	return btoa(String.fromCharCode(...buffer));
}

/**
 * Hook for creating a secure share link for a vault item.
 *
 * Handles:
 * - Generating a share-specific encryption key
 * - Preparing and sanitizing item data for sharing
 * - Encrypting item data with the share key
 * - Creating the share via API
 * - Invalidating share queries
 *
 * Does NOT handle:
 * - Toast notifications (app responsibility)
 * - Building the final share URL (app provides base URL)
 * - Dialog state management (app responsibility)
 *
 * @example
 * ```tsx
 * const createShare = useCreateShare();
 *
 * const handleCreate = async () => {
 *   try {
 *     const result = await createShare.mutateAsync({
 *       item,
 *       accessMode: "anyone",
 *       expiresIn: "7days",
 *       isOneTimeUse: false,
 *     });
 *
 *     // Build the share URL (platform-specific base URL)
 *     const baseUrl = window.location.origin; // or await storage.getEffectiveWebAppUrl()
 *     const shareUrl = `${baseUrl}/share/${result.token}#${result.shareKeyBase64}`;
 *
 *     toast.success("Share link created!");
 *     setGeneratedLink(shareUrl);
 *   } catch (error) {
 *     toast.error(error.message);
 *   }
 * };
 * ```
 */
export function useCreateShare() {
	const trpcClient = useTRPCClient();
	const { storage, crypto } = usePlatform();
	const invalidator = useQueryInvalidator();

	return useMutation({
		mutationFn: async (input: CreateShareInput): Promise<CreateShareResult> => {
			const { item, accessMode, expiresIn, isOneTimeUse, allowedEmails } =
				input;

			// Verify we have access to the vault
			const vaultKey = await storage.getDecryptedVaultKey(item.vaultId);
			if (!vaultKey) {
				throw new Error("Could not decrypt vault key. Please log in again.");
			}

			// Generate a new share-specific encryption key
			const shareKey = await crypto.generateEncryptionKey();

			// Prepare item data for sharing (sanitized, no metadata like id, vaultId, etc.)
			const itemDataToShare = {
				title: item.title,
				category: item.category,
				url: item.url,
				urls: item.urls,
				username: item.username,
				password: item.password,
				notes: item.notes,
				note: item.note,
				customFields: item.customFields,
				// Credit card fields
				cardholderName: item.cardholderName,
				cardNumber: item.cardNumber,
				cvv: item.cvv,
				expiryDate: item.expiryDate,
				billingAddress: item.billingAddress,
				// Identity fields
				firstName: item.firstName,
				middleName: item.middleName,
				lastName: item.lastName,
				email: item.email,
				addresses: item.addresses,
				phoneNumbers: item.phoneNumbers,
				ssn: item.ssn,
				passportNumber: item.passportNumber,
				driversLicense: item.driversLicense,
				dateOfBirth: item.dateOfBirth,
				// TOTP fields
				totpSecret: item.totpSecret,
				totpIssuer: item.totpIssuer,
				totpAccountName: item.totpAccountName,
				totpAlgorithm: item.totpAlgorithm,
				totpDigits: item.totpDigits,
				totpPeriod: item.totpPeriod,
			};

			// Encrypt item data with the share key
			const encryptedData = await crypto.encrypt(
				JSON.stringify(itemDataToShare),
				shareKey,
			);

			// Encode the share key as base64 for the URL
			const shareKeyBase64 = arrayBufferToBase64(shareKey);

			// Encrypt the share key for storage
			const shareKeyEncrypted = await crypto.encrypt(shareKeyBase64, shareKey);

			// Create the share via API
			const result = await trpcClient.share.create.mutate({
				itemId: item.id,
				accessMode,
				isOneTimeUse,
				expiresIn,
				allowedEmails:
					accessMode === "email-restricted" ? allowedEmails : undefined,
				encryptedItemData: encryptedData.ciphertext,
				encryptionIv: encryptedData.iv,
				encryptedShareKey: shareKeyEncrypted.ciphertext,
				shareKeyIv: shareKeyEncrypted.iv,
			});

			return {
				token: result.token,
				shareKeyBase64,
				expiresAt: result.expiresAt,
			};
		},
		onSuccess: async () => {
			await invalidator.invalidateShare();
		},
	});
}
