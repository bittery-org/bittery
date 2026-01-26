/**
 * useCreateVault Hook
 *
 * Creates a new vault with encryption.
 * Returns a React Query mutation - apps handle success/error UI.
 */

import { useTRPCClient } from "@bittery/shared/trpc";
import { useMutation } from "@tanstack/react-query";
import { usePlatform, useQueryInvalidator } from "../../context/platform-context";
import { refreshVaultKeys } from "../../utils/vault-utils";

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
	/** S3 image key if custom image was uploaded */
	imageKey?: string;
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
 * - Generating a new vault encryption key
 * - Encrypting the vault key with the user's Master Unlock Key
 * - Creating the vault via API
 * - Refreshing local vault keys cache
 * - Invalidating relevant queries
 *
 * Does NOT handle:
 * - Toast notifications (app responsibility)
 * - Navigation (app responsibility)
 * - Image upload (should be done before calling this hook)
 *
 * @example
 * ```tsx
 * const createVault = useCreateVault();
 *
 * const handleSubmit = async (data) => {
 *   try {
 *     const result = await createVault.mutateAsync(data);
 *     toast.success("Vault created");
 *     navigate({ to: "/vault/$id", params: { id: result.vaultId } });
 *   } catch (error) {
 *     toast.error(error.message);
 *   }
 * };
 * ```
 */
export function useCreateVault() {
	const trpcClient = useTRPCClient();
	const { storage, crypto } = usePlatform();
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

			// Generate a new vault encryption key
			const vaultKey = await crypto.generateEncryptionKey();

			// Get the user's Master Unlock Key
			const masterUnlockKey = await storage.getMasterUnlockKey();
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
			const result = await trpcClient.vault.create.mutate({
				name: trimmedName,
				type: input.type,
				encryptedVaultKey: JSON.stringify(encryptedVaultKeyData),
				icon: input.icon,
				...(input.imageKey && { imageKey: input.imageKey }),
			});

			return { vaultId: result.vaultId };
		},
		onSuccess: async () => {
			// Refresh local vault keys cache
			await refreshVaultKeys(trpcClient, storage);
			// Invalidate vault-related queries
			await invalidator.invalidateVaultKeys();
		},
	});
}
