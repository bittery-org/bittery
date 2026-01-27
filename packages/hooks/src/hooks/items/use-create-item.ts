/**
 * useCreateItem Hook
 *
 * Creates a new vault item with encryption.
 * Returns a React Query mutation - apps handle success/error UI.
 */

import { useTRPCClient } from "@bittery/shared/trpc";
import type { DecryptedItemData, ItemCategory } from "@bittery/shared/types";
import { useMutation } from "@tanstack/react-query";
import {
  usePlatform,
  useQueryInvalidator,
} from "../../context/platform-context";
import { getTRPCClientForAccount } from "../../utils/account-helper";

/**
 * Input for creating a new item
 */
export interface CreateItemInput {
  /** ID of the vault to create the item in */
  vaultId: string;
  /** Category of the item */
  category: ItemCategory;
  /** Decrypted item data to encrypt and store */
  data: DecryptedItemData;
  accountEmail?: string;
}

/**
 * Result from item creation
 */
export interface CreateItemResult {
  itemId: string;
}

/**
 * Hook for creating a new vault item.
 *
 * Handles:
 * - Encrypting item data with the vault key
 * - Creating the item via API
 * - Invalidating relevant queries
 *
 * Does NOT handle:
 * - Toast notifications (app responsibility)
 * - Navigation (app responsibility)
 *
 * @example
 * ```tsx
 * const createItem = useCreateItem();
 *
 * const handleSubmit = async (data) => {
 *   try {
 *     const result = await createItem.mutateAsync({
 *       vaultId,
 *       category: "login",
 *       data: { title: "Example", username: "user", password: "secret" },
 *     });
 *     toast.success("Item created");
 *     navigate({ to: "/vault/$id/$itemId", params: { id: vaultId, itemId: result.itemId } });
 *   } catch (error) {
 *     toast.error(error.message);
 *   }
 * };
 * ```
 */
export function useCreateItem() {
  const defaultClient = useTRPCClient();
  const { storage, crypto } = usePlatform();
  const invalidator = useQueryInvalidator();

  return useMutation({
    mutationFn: async (input: CreateItemInput): Promise<CreateItemResult> => {
      // Get the vault key for encryption
      const vaultKey = await storage.getDecryptedVaultKey(
        input.vaultId,
        input.accountEmail,
      );

      if (!vaultKey) {
        throw new Error("No vault key found. Please sign in again.");
      }

      const client = await getTRPCClientForAccount(
        storage,
        defaultClient,
        input.accountEmail,
      );

      // Encrypt the item data
      const encryptedData = await crypto.encrypt(
        JSON.stringify(input.data),
        vaultKey,
      );

      // Create the item
      const result = await client.vault.createItem.mutate({
        vaultId: input.vaultId,
        category: input.category,
        encryptedData: encryptedData.ciphertext,
        encryptionIv: encryptedData.iv,
        encryptionAlgorithm: encryptedData.algorithm,
      });

      return { itemId: result.id };
    },
    onSuccess: async (_data, variables) => {
      await invalidator.invalidateVaultList(variables.vaultId);
    },
  });
}
