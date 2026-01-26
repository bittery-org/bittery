/**
 * useUpdateItem Hook
 *
 * Updates an existing vault item with encryption.
 * Returns a React Query mutation - apps handle success/error UI.
 */

import { useTRPCClient } from "@bittery/shared/trpc";
import type { DecryptedItemData } from "@bittery/shared/types";
import { useMutation } from "@tanstack/react-query";
import {
	usePlatform,
	useQueryInvalidator,
} from "../../context/platform-context";

/**
 * Input for updating an item
 */
export interface UpdateItemInput {
	/** ID of the item to update */
	itemId: string;
	/** ID of the vault containing the item */
	vaultId: string;
	/** Updated decrypted item data */
	data: DecryptedItemData;
}

/**
 * Hook for updating a vault item.
 *
 * Handles:
 * - Encrypting updated item data with the vault key
 * - Updating the item via API
 * - Invalidating relevant queries
 *
 * Does NOT handle:
 * - Toast notifications (app responsibility)
 *
 * @example
 * ```tsx
 * const updateItem = useUpdateItem();
 *
 * const handleSave = async () => {
 *   try {
 *     await updateItem.mutateAsync({
 *       itemId,
 *       vaultId,
 *       data: updatedData,
 *     });
 *     toast.success("Item updated");
 *   } catch (error) {
 *     toast.error(error.message);
 *   }
 * };
 * ```
 */
export function useUpdateItem() {
	const trpcClient = useTRPCClient();
	const { storage, crypto } = usePlatform();
	const invalidator = useQueryInvalidator();

	return useMutation({
		mutationFn: async (input: UpdateItemInput): Promise<void> => {
			// Get the vault key for encryption
			const vaultKey = await storage.getDecryptedVaultKey(input.vaultId);
			if (!vaultKey) {
				throw new Error("No vault key found. Please sign in again.");
			}

			// Encrypt the updated item data
			const encryptedData = await crypto.encrypt(
				JSON.stringify(input.data),
				vaultKey,
			);

			// Update the item
			await trpcClient.vault.updateItem.mutate({
				itemId: input.itemId,
				encryptedData: encryptedData.ciphertext,
				encryptionIv: encryptedData.iv,
			});
		},
		onSuccess: async (_data, variables) => {
			await invalidator.invalidateItem(variables.itemId, variables.vaultId);
		},
	});
}
