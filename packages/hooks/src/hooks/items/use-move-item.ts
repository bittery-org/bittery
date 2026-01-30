/**
 * useMoveItem Hook
 *
 * Moves a vault item to a different vault with re-encryption.
 * Supports both same-account moves and cross-account transfers.
 * Returns a React Query mutation - apps handle success/error UI.
 * Automatically handles multi-account mode.
 *
 * Cross-account transfers:
 * - Creates item in target account's vault
 * - Deletes item from source account's vault
 * - Both operations authenticated with respective account tokens
 */

import { useTRPCClient } from "@bittery/shared/trpc";
import type { DecryptedItemData, ItemCategory } from "@bittery/shared/types";
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
 * Input for moving an item to another vault
 */
export interface MoveItemInput {
	/** ID of the item to move */
	itemId: string;
	/** ID of the source vault */
	sourceVaultId: string;
	/** ID of the target vault */
	targetVaultId: string;
	/** Item category (needed for cross-account transfers) */
	category: ItemCategory;
	/** Already-decrypted item data (caller must decrypt before moving) */
	decryptedData: DecryptedItemData;
	/** Optional: target account email (if known, avoids search) */
	targetAccountEmail?: string;
}

/**
 * Hook for moving an item to a different vault.
 *
 * Moving an item requires re-encryption with the target vault's key,
 * so the caller must provide the already-decrypted item data.
 *
 * Handles:
 * - Re-encrypting item data with target vault key
 * - Moving the item via API
 * - Invalidating relevant queries (both source and target vaults)
 * - Multi-account mode (automatically uses correct account's client and vault key)
 *
 * Does NOT handle:
 * - Toast notifications (app responsibility)
 * - Navigation after move (app responsibility)
 * - Confirmation dialog (app responsibility)
 *
 * @example
 * ```tsx
 * const moveItem = useMoveItem();
 *
 * const handleMove = async (targetVaultId: string) => {
 *   try {
 *     await moveItem.mutateAsync({
 *       itemId,
 *       sourceVaultId: currentVaultId,
 *       targetVaultId,
 *       decryptedData: currentDecryptedData,
 *     });
 *     toast.success("Item moved");
 *     navigate({ to: "/vault/$id/$itemId", params: { id: targetVaultId, itemId } });
 *   } catch (error) {
 *     toast.error(error.message);
 *   }
 * };
 * ```
 */
export function useMoveItem() {
	const { items } = useItems();
	const defaultClient = useTRPCClient();
	const storage = usePlatformStorage();
	const { crypto } = usePlatform();
	const invalidator = useQueryInvalidator();

	return useMutation({
		mutationFn: async (
			input: MoveItemInput,
		): Promise<{ crossAccount: boolean; newItemId?: string }> => {
			// Find which account the source item belongs to
			const sourceAccountEmail = findAccountEmailForItem(input.itemId, items);

			// Find which account the target vault belongs to
			let targetAccountEmail = input.targetAccountEmail || sourceAccountEmail;

			// Search for target vault if not provided
			if (!input.targetAccountEmail) {
				// First check if target vault is in source account
				const sourceVaultKeys = await storage.getVaultKeys(sourceAccountEmail);
				const targetInSource = sourceVaultKeys?.find(
					(vk) => vk.vaultId === input.targetVaultId,
				);

				if (targetInSource) {
					targetAccountEmail = sourceAccountEmail;
				} else if (sourceAccountEmail) {
					// Multi-account mode: search other accounts
					const accounts = await storage.getAccountsList();
					for (const account of accounts) {
						if (account.email === sourceAccountEmail) continue;
						const vaultKeys = await storage.getVaultKeys(account.email);
						const targetVault = vaultKeys?.find(
							(vk) => vk.vaultId === input.targetVaultId,
						);
						if (targetVault) {
							targetAccountEmail = account.email;
							break;
						}
					}
				}
			}

			// Determine if this is a cross-account transfer
			const isCrossAccount = sourceAccountEmail !== targetAccountEmail;

			// Get target vault key for re-encryption
			const targetVaultKey = await storage.getDecryptedVaultKey(
				input.targetVaultId,
				targetAccountEmail,
			);

			if (!targetVaultKey) {
				throw new Error(
					"Cannot access target vault key. Please unlock the target account.",
				);
			}

			// Re-encrypt with target vault key
			const encryptedData = await crypto.encrypt(
				JSON.stringify(input.decryptedData),
				targetVaultKey,
			);

			if (isCrossAccount) {
				// Cross-account transfer: Create in target, then permanently delete from source
				console.log(
					`[useMoveItem] Cross-account transfer from ${sourceAccountEmail} to ${targetAccountEmail}`,
				);

				// Step 1: Create item in target account
				const targetClient = await getTRPCClientForAccount(
					storage,
					defaultClient,
					targetAccountEmail,
				);

				const createResult = await targetClient.vault.createItem.mutate({
					vaultId: input.targetVaultId,
					category: input.category,
					encryptedData: encryptedData.ciphertext,
					encryptionIv: encryptedData.iv,
					encryptionAlgorithm: "aes-256-gcm",
				});

				// Step 2: Permanently delete item from source account
				// First soft-delete it, then permanently delete it
				try {
					const sourceClient = await getTRPCClientForAccount(
						storage,
						defaultClient,
						sourceAccountEmail,
					);

					// Soft delete first (required by permanentlyDeleteItem API)
					await sourceClient.vault.deleteItem.mutate({
						itemId: input.itemId,
					});

					// Then permanently delete
					await sourceClient.vault.permanentlyDeleteItem.mutate({
						itemId: input.itemId,
					});
				} catch (deleteError) {
					console.error(
						"[useMoveItem] Failed to delete item from source account after creating in target:",
						deleteError,
					);
					// Item was created in target but not deleted from source
					// This is not ideal but the user can manually delete it
					throw new Error(
						"Item created in target account but failed to delete from source. Please delete the original item manually.",
					);
				}

				return { crossAccount: true, newItemId: createResult.itemId };
			}

			// Same-account move: Use the standard moveItem API
			const client = await getTRPCClientForAccount(
				storage,
				defaultClient,
				sourceAccountEmail,
			);

			await client.vault.moveItem.mutate({
				itemId: input.itemId,
				sourceVaultId: input.sourceVaultId,
				targetVaultId: input.targetVaultId,
				encryptedData: encryptedData.ciphertext,
				encryptionIv: encryptedData.iv,
			});

			return { crossAccount: false };
		},
		onSuccess: async (data, variables) => {
			// Invalidate queries for both source and target vaults
			await invalidator.invalidateVaultList(variables.sourceVaultId);
			await invalidator.invalidateVaultList(variables.targetVaultId);

			// For cross-account transfers, also invalidate deleted items
			// (since we permanently delete from source after soft-delete)
			if (data.crossAccount) {
				await invalidator.invalidateDeletedItems(variables.sourceVaultId);
			}

			// Also invalidate vault keys to refresh vault metadata
			await invalidator.invalidateVaultKeys();
		},
	});
}
