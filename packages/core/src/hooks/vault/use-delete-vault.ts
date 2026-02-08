/**
 * useDeleteVault Hook
 *
 * Deletes a vault permanently.
 */

import { useTRPCClient } from "@bittery/shared/trpc";
import { useMutation } from "@tanstack/react-query";
import {
	useCoreContext,
	useQueryInvalidator,
} from "../../context/platform-context";

/**
 * Input for deleting a vault
 */
export interface DeleteVaultInput {
	vaultId: string;
	accountEmail?: string;
}

/**
 * Hook for deleting a vault.
 */
export function useDeleteVault() {
	const defaultClient = useTRPCClient();
	const core = useCoreContext();
	const invalidator = useQueryInvalidator();

	return useMutation({
		mutationFn: async (input: DeleteVaultInput): Promise<void> => {
			await core.vaults.deleteVault(
				input.vaultId,
				defaultClient,
				input.accountEmail,
			);
		},
		onSuccess: async (_data, variables) => {
			await core.vaults.refreshVaultKeys(defaultClient, variables.accountEmail);
			await invalidator.invalidateVaultKeys();
		},
	});
}
