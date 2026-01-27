/**
 * useMoveItem Hook
 *
 * Moves a vault item to a different vault with re-encryption.
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
 * Input for moving an item to another vault
 */
export interface MoveItemInput {
  /** ID of the item to move */
  itemId: string;
  /** ID of the source vault */
  sourceVaultId: string;
  /** ID of the target vault */
  targetVaultId: string;
  /** Already-decrypted item data (caller must decrypt before moving) */
  decryptedData: DecryptedItemData;
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
    mutationFn: async (input: MoveItemInput): Promise<void> => {
      // Find which account this item belongs to (if in "All Accounts" mode)
      const accountEmail = findAccountEmailForItem(input.itemId, items);

      // Get target vault key for re-encryption (with account email if in multi-account mode)
      const targetVaultKey = await storage.getDecryptedVaultKey(
        input.targetVaultId,
        accountEmail,
      );

      if (!targetVaultKey) {
        throw new Error(
          "Cannot access target vault key. Please sign in again.",
        );
      }

      // Re-encrypt with target vault key
      const encryptedData = await crypto.encrypt(
        JSON.stringify(input.decryptedData),
        targetVaultKey,
      );

      const client = await getTRPCClientForAccount(
        storage,
        defaultClient,
        accountEmail,
      );

      // Move the item
      await client.vault.moveItem.mutate({
        itemId: input.itemId,
        sourceVaultId: input.sourceVaultId,
        targetVaultId: input.targetVaultId,
        encryptedData: encryptedData.ciphertext,
        encryptionIv: encryptedData.iv,
      });
    },
    onSuccess: async (_data, variables) => {
      // Invalidate item in target vault
      await invalidator.invalidateItem(
        variables.itemId,
        variables.targetVaultId,
      );
      // Invalidate source vault list
      await invalidator.invalidateVaultList(variables.sourceVaultId);
    },
  });
}
