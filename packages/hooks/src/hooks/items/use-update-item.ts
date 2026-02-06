/**
 * useUpdateItem Hook
 *
 * Updates an existing vault item with encryption.
 * Returns a React Query mutation - apps handle success/error UI.
 * Automatically handles multi-account mode.
 */

import { useTRPCClient } from "@bittery/shared/trpc";
import type { DecryptedItemData } from "@bittery/shared/types";
import { useMutation } from "@tanstack/react-query";
import {
	usePlatform,
	usePlatformStorage,
	useQueryInvalidator,
} from "../../context/platform-context";
import {
	findAccountEmailForItem,
	getTRPCClientForAccount,
} from "../../utils/account-helper";
import { useItems } from "../use-items";

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
		mutationFn: async (
			input: UpdateItemInput,
		): Promise<{
			_encryptedData: { ciphertext: string; iv: string; algorithm: string };
			_accountEmail: string | undefined;
		}> => {
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

			const client = await getTRPCClientForAccount(
				storage,
				defaultClient,
				accountEmail,
			);

			// Update the item
			await client.vault.updateItem.mutate({
				itemId: input.itemId,
				encryptedData: encryptedData.ciphertext,
				encryptionIv: encryptedData.iv,
			});

			return { _encryptedData: encryptedData, _accountEmail: accountEmail };
		},
		onSuccess: async (data, variables) => {
			// Update local cache if supported
			if (storage.supportsItemCache) {
				const cachedItems = await storage.getCachedItems?.(data._accountEmail);
				const existing = cachedItems?.find((i) => i.id === variables.itemId);
				if (existing) {
					storage.upsertCachedItem?.(
						{
							...existing,
							encryptedData: data._encryptedData.ciphertext,
							encryptionIv: data._encryptedData.iv,
							encryptionAlgorithm: data._encryptedData.algorithm,
							updatedAt: new Date().toISOString(),
							version: existing.version + 1,
						},
						data._accountEmail,
					);
				}
			}
			await invalidator.invalidateItem(variables.itemId, variables.vaultId);
		},
	});
}
