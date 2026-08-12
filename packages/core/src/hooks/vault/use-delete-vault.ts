/**
 * useDeleteVault Hook
 *
 * Deletes a vault permanently.
 */

import { useApiClient } from "@bittery/shared/api";
import { useMutation } from "@tanstack/react-query";
import { useCoreContext } from "../../context/platform-context";
import { useRefreshAfterVaultMutation } from "./mutation-utils";

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
	const defaultClient = useApiClient();
	const core = useCoreContext();
	const refreshAfterMutation = useRefreshAfterVaultMutation();

	return useMutation({
		mutationFn: async (input: DeleteVaultInput): Promise<void> => {
			await core.vaults.deleteVault(
				input.vaultId,
				defaultClient,
				input.accountId,
			);
		},
		onSuccess: (_data, variables) => refreshAfterMutation(variables.accountId),
	});
}
