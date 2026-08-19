/**
 * useDeleteVault Hook
 *
 * Deletes a vault permanently.
 */

import { useMutation } from "@tanstack/react-query";
import { useCoreContext } from "../../context/platform-context";
import { useRefreshAfterVaultDeletion } from "./mutation-utils";

/**
 * Input for deleting a vault
 */
export interface DeleteVaultInput {
	vaultId: string;
	accountId: string;
}

/**
 * Hook for deleting a vault.
 */
export function useDeleteVault() {
	const core = useCoreContext();
	const refreshAfterDeletion = useRefreshAfterVaultDeletion();

	return useMutation({
		mutationFn: async (input: DeleteVaultInput): Promise<void> => {
			await core.vaults.deleteVault(input.vaultId, input.accountId);
		},
		onSuccess: (_data, variables) => refreshAfterDeletion(variables),
	});
}
