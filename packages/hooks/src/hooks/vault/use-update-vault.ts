/**
 * useUpdateVault Hook
 *
 * Updates an existing vault's metadata.
 * Returns a React Query mutation - apps handle success/error UI.
 */

import { useTRPCClient } from "@bittery/shared/trpc";
import { useMutation } from "@tanstack/react-query";
import {
	usePlatform,
	useQueryInvalidator,
} from "../../context/platform-context";
import { getTRPCClientForAccount } from "../../utils/account-helper";
import { refreshVaultKeys } from "../../utils/vault-utils";

/**
 * Input for updating a vault
 */
export interface UpdateVaultInput {
	/** ID of the vault to update */
	vaultId: string;
	/** New vault name (will be trimmed) */
	name?: string;
	/** Icon identifier */
	icon?: string | null;
	/** Image file to upload (optional) */
	imageFile?: File;
	/** Set to true to remove the current image */
	removeImage?: boolean;
	accountEmail?: string;
}

/**
 * Hook for updating a vault's metadata.
 *
 * Handles:
 * - Validating the new name
 * - Updating the vault via API
 * - Refreshing local vault keys cache
 * - Invalidating relevant queries
 *
 * Does NOT handle:
 * - Toast notifications (app responsibility)
 *
 * @example
 * ```tsx
 * const updateVault = useUpdateVault();
 *
 * const handleRename = async (vaultId, newName) => {
 *   try {
 *     await updateVault.mutateAsync({ vaultId, name: newName });
 *     toast.success("Vault renamed");
 *   } catch (error) {
 *     toast.error(error.message);
 *   }
 * };
 * ```
 */
export function useUpdateVault() {
	const defaultClient = useTRPCClient();
	const { storage } = usePlatform();
	const invalidator = useQueryInvalidator();

	return useMutation({
		mutationFn: async (input: UpdateVaultInput): Promise<void> => {
			const client = await getTRPCClientForAccount(
				storage,
				defaultClient,
				input.accountEmail,
			);

			// Validate name if provided
			if (input.name !== undefined) {
				const trimmedName = input.name.trim();

				if (!trimmedName) {
					throw new Error("Vault name is required");
				}

				if (trimmedName.length < 2) {
					throw new Error("Vault name must be at least 2 characters");
				}
			}

			// Handle image upload if file provided
			let imageKey: string | null | undefined;
			if (input.imageFile) {
				// Get presigned upload URL
				const upload = await client.vault.createImageUpload.mutate({
					vaultId: input.vaultId,
					fileName: input.imageFile.name,
					contentType: input.imageFile.type,
				});

				// Upload the file
				await fetch(upload.uploadUrl, {
					method: "PUT",
					body: input.imageFile,
					headers: {
						"Content-Type": input.imageFile.type,
					},
				});

				imageKey = upload.key;
			} else if (input.removeImage) {
				imageKey = null;
			}

			await client.vault.update.mutate({
				vaultId: input.vaultId,
				...(input.name !== undefined && { name: input.name.trim() }),
				...(input.icon !== undefined && { icon: input.icon }),
				...(imageKey !== undefined && { imageKey }),
			});
		},
		onSuccess: async (_data, variables) => {
			const client = await getTRPCClientForAccount(
				storage,
				defaultClient,
				variables.accountEmail,
			);

			// Refresh local vault keys cache (name may have changed)
			await refreshVaultKeys(client, storage, variables.accountEmail);
			// Invalidate vault-related queries
			await invalidator.invalidateVaultKeys();
		},
	});
}
