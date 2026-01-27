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
import { refreshVaultKeys } from "../../utils/vault-utils";
import { getTRPCClientForAccount } from "../../utils/account-helper";

/**
 * Input for updating a vault
 */
export interface UpdateVaultInput {
  /** ID of the vault to update */
  vaultId: string;
  /** New vault name (will be trimmed) */
  name: string;
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

      const trimmedName = input.name.trim();

      if (!trimmedName) {
        throw new Error("Vault name is required");
      }

      if (trimmedName.length < 2) {
        throw new Error("Vault name must be at least 2 characters");
      }

      await client.vault.update.mutate({
        vaultId: input.vaultId,
        name: trimmedName,
      });
    },
    onSuccess: async (_data, variables) => {
      const client = await getTRPCClientForAccount(
        storage,
        defaultClient,
        variables.accountEmail,
      );

      // Refresh local vault keys cache (name may have changed)
      await refreshVaultKeys(client, storage);
      // Invalidate vault-related queries
      await invalidator.invalidateVaultKeys();
    },
  });
}
