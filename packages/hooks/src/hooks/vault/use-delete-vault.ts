/**
 * useDeleteVault Hook
 *
 * Deletes a vault permanently.
 * Returns a React Query mutation - apps handle success/error UI.
 */

import { useTRPCClient } from "@bittery/shared/trpc";
import { useMutation } from "@tanstack/react-query";
import {
	usePlatform,
	useQueryInvalidator,
} from "../../context/platform-context";
import { refreshVaultKeys } from "../../utils/vault-utils";

/**
 * Input for deleting a vault
 */
export interface DeleteVaultInput {
	/** ID of the vault to delete */
	vaultId: string;
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
	const trpcClient = useTRPCClient();
	const { storage } = usePlatform();
	const invalidator = useQueryInvalidator();

	return useMutation({
		mutationFn: async (input: DeleteVaultInput): Promise<void> => {
			await trpcClient.vault.delete.mutate({ vaultId: input.vaultId });
		},
		onSuccess: async () => {
			// Refresh local vault keys cache
			await refreshVaultKeys(trpcClient, storage);
			// Invalidate vault-related queries
			await invalidator.invalidateVaultKeys();
		},
	});
}
