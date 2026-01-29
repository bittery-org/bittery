/**
 * useCreateVault Hook
 *
 * Creates a new vault with encryption and optional image upload.
 * Returns a React Query mutation - apps handle success/error UI.
 */

import { useTRPCClient } from "@bittery/shared/trpc";
import { useMutation } from "@tanstack/react-query";
import {
	usePlatform,
	usePlatformStorage,
	useQueryInvalidator,
} from "../../context/platform-context";
import { getTRPCClientForAccount } from "../../utils/account-helper";
import { refreshVaultKeys } from "../../utils/vault-utils";

/**
 * Image file input - supports File (browser) or Blob
 */
export type ImageFileInput = File | (Blob & { name?: string });

/**
 * Input for creating a new vault
 */
export interface CreateVaultInput {
	/** Vault name (will be trimmed) */
	name: string;
	/** Vault type */
	type: "personal" | "team";
	/** Vault icon identifier */
	icon: string;
	/**
	 * Custom image file for the vault (optional).
	 * If provided, the hook will upload it to S3 and use the returned key.
	 * Accepts File (browser) or Blob with optional name.
	 */
	imageFile?: ImageFileInput;
	/**
	 * S3 image key if custom image was already uploaded (optional).
	 * Use this if you've already uploaded the image yourself.
	 * If both imageFile and imageKey are provided, imageKey takes precedence.
	 * @deprecated Prefer using imageFile - the hook handles upload automatically
	 */
	imageKey?: string;
	/**
	 * Account email for multi-account mode (optional).
	 * Required when creating a vault in "All Accounts" mode in desktop app.
	 * If not provided, uses the current/default account.
	 */
	accountEmail?: string;
}

/**
 * Result from vault creation
 */
export interface CreateVaultResult {
	vaultId: string;
}

/**
 * Hook for creating a new vault.
 *
 * Handles:
 * - Image upload to S3 (if imageFile provided)
 * - Generating a new vault encryption key
 * - Encrypting the vault key with the user's Master Unlock Key
 * - Creating the vault via API
 * - Refreshing local vault keys cache
 * - Invalidating relevant queries
 * - Multi-account mode (automatically uses correct account's client and Master Unlock Key)
 *
 * Does NOT handle:
 * - Toast notifications (app responsibility)
 * - Navigation (app responsibility)
 *
 * @example
 * ```tsx
 * const createVault = useCreateVault();
 *
 * const handleSubmit = async (data) => {
 *   try {
 *     const result = await createVault.mutateAsync({
 *       name: "My Vault",
 *       type: "personal",
 *       icon: "shield",
 *       imageFile: selectedFile, // optional - hook handles upload
 *       accountEmail: "user@example.com", // optional - for multi-account mode
 *     });
 *     toast.success("Vault created");
 *     navigate({ to: "/vault/$id", params: { id: result.vaultId } });
 *   } catch (error) {
 *     toast.error(error.message);
 *   }
 * };
 * ```
 */
export function useCreateVault() {
	const defaultClient = useTRPCClient();
	const storage = usePlatformStorage();
	const { crypto } = usePlatform();
	const invalidator = useQueryInvalidator();

	return useMutation({
		mutationFn: async (input: CreateVaultInput): Promise<CreateVaultResult> => {
			const trimmedName = input.name.trim();

			if (!trimmedName) {
				throw new Error("Vault name is required");
			}

			if (trimmedName.length < 2) {
				throw new Error("Vault name must be at least 2 characters");
			}

			// Get the correct tRPC client for this account
			const client = await getTRPCClientForAccount(
				storage,
				defaultClient,
				input.accountEmail,
			);

			// Determine the image key to use
			let imageKey = input.imageKey;

			// If imageFile is provided and no imageKey, upload the image
			if (input.imageFile && !imageKey) {
				const file = input.imageFile;
				const contentType = file.type;
				// File has name property, Blob might have it added
				const fileName = "name" in file && file.name ? file.name : "image";

				// Validate it's an image
				if (!contentType.startsWith("image/")) {
					throw new Error("Vault image must be an image file");
				}

				// Get presigned upload URL
				const upload = await client.vault.createImageUpload.mutate({
					fileName,
					contentType,
				});

				// Upload the file
				const uploadResponse = await fetch(upload.uploadUrl, {
					method: "PUT",
					headers: {
						"Content-Type": contentType,
					},
					body: file,
				});

				if (!uploadResponse.ok) {
					throw new Error("Failed to upload vault image");
				}

				imageKey = upload.key;
			}

			// Generate a new vault encryption key
			const vaultKey = await crypto.generateEncryptionKey();

			// Get the user's Master Unlock Key (with account email if in multi-account mode)
			const masterUnlockKey = await storage.getMasterUnlockKey(
				input.accountEmail,
			);

			if (!masterUnlockKey) {
				throw new Error("Master Unlock Key not found. Please sign in again.");
			}

			// Encrypt the vault key with the MUK
			const vaultKeyBase64 = btoa(String.fromCharCode(...vaultKey));

			const encryptedVaultKeyData = await crypto.encrypt(
				vaultKeyBase64,
				masterUnlockKey,
			);

			// Create the vault
			const result = await client.vault.create.mutate({
				name: trimmedName,
				type: input.type,
				encryptedVaultKey: JSON.stringify(encryptedVaultKeyData),
				icon: input.icon,
				...(imageKey && { imageKey }),
			});

			return { vaultId: result.vaultId };
		},
		onSuccess: async (_data, variables) => {
			// Get the correct tRPC client for this account
			const client = await getTRPCClientForAccount(
				storage,
				defaultClient,
				variables.accountEmail,
			);

			// Refresh local vault keys cache
			await refreshVaultKeys(client, storage);
			// Invalidate vault-related queries
			await invalidator.invalidateVaultKeys();
		},
	});
}
