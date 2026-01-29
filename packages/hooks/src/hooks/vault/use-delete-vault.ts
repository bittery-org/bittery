/**
 * useDeleteVault Hook
 *
 * Deletes a vault permanently.
 * Returns a React Query mutation - apps handle success/error UI.
 */

import { useTRPCClient } from "@bittery/shared/trpc";
import { useMutation } from "@tanstack/react-query";
import {
	usePlatformStorage,
	useQueryInvalidator,
} from "../../context/platform-context";
import { getTRPCClientForAccount } from "../../utils/account-helper";
import { refreshVaultKeys } from "../../utils/vault-utils";

/**
 * Input for deleting a vault
 */
export interface DeleteVaultInput {
	/** ID of the vault to delete */
	vaultId: string;
	accountEmail?: string;
}

/**
 * Hook for deleting a vault.
 *
 * Handles:
 * - Deleting the vault via API
 * - Refreshing local vault keys cache
 * - Invalidating relevant queries
 *
 * Does NOT handle:
 * - Toast notifications (app responsibility)
 * - Navigation after deletion (app responsibility)
 * - Confirmation dialog (app responsibility)
 *
 * @example
 * ```tsx
 * const deleteVault = useDeleteVault();
 *
 * const handleDelete = async (vaultId, isCurrentVault) => {
 *   try {
 *     await deleteVault.mutateAsync({ vaultId });
 *     toast.success("Vault deleted");
 *     if (isCurrentVault) {
 *       navigate({ to: "/vault" });
 *     }
 *   } catch (error) {
 *     toast.error(error.message);
 *   }
 * };
 * ```
 */
export function useDeleteVault() {
	const defaultClient = useTRPCClient();
	const storage = usePlatformStorage();
	const invalidator = useQueryInvalidator();

	return useMutation({
		mutationFn: async (input: DeleteVaultInput): Promise<void> => {
			const client = await getTRPCClientForAccount(
				storage,
				defaultClient,
				input.accountEmail,
			);

			await client.vault.delete.mutate({ vaultId: input.vaultId });
		},
		onSuccess: async (_data, variables) => {
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
