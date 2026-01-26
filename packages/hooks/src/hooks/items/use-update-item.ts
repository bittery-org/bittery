/**
 * useUpdateItem Hook
 *
 * Updates an existing vault item with encryption.
 * Returns a React Query mutation - apps handle success/error UI.
 * Automatically handles multi-account mode.
 */

import { useTRPCClient } from "@bittery/shared/trpc";
import { createAccountTrpcClient } from "@bittery/shared/trpc-client-factory";
import type { DecryptedItemData } from "@bittery/shared/types";
import { useMutation } from "@tanstack/react-query";
import {
	usePlatform,
	useQueryInvalidator,
	usePlatformStorage,
} from "../../context/platform-context";
import { useItems } from "../use-items";
import { findAccountEmailForItem } from "../../utils/account-helper";

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
 * - Multi-account mode (automatically uses correct account's client and vault key)
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
	const { items } = useItems();
	const defaultClient = useTRPCClient();
	const storage = usePlatformStorage();
	const { crypto } = usePlatform();
	const invalidator = useQueryInvalidator();

	return useMutation({
		mutationFn: async (input: UpdateItemInput): Promise<void> => {
			// Find which account this item belongs to (if in "All Accounts" mode)
			const accountEmail = findAccountEmailForItem(input.itemId, items);

			// Get the vault key for encryption (with account email if in multi-account mode)
			const vaultKey = await storage.getDecryptedVaultKey(
				input.vaultId,
				accountEmail,
			);
			if (!vaultKey) {
				throw new Error("No vault key found. Please sign in again.");
			}

			// Encrypt the updated item data
			const encryptedData = await crypto.encrypt(
				JSON.stringify(input.data),
				vaultKey,
			);

			// Get the correct tRPC client for this account
			let client = defaultClient;
			if (accountEmail) {
				const authToken = await storage.getAuthToken(accountEmail);
				const serverUrl = await storage.getServerUrl(accountEmail);
				if (authToken) {
					client = createAccountTrpcClient(
						authToken,
						serverUrl || "http://localhost:3000",
					);
				}
			}

			// Update the item
			await client.vault.updateItem.mutate({
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
