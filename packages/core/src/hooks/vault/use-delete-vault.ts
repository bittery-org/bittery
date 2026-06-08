/**
 * useDeleteVault Hook
 *
 * Deletes a vault permanently.
 */

import { useRPCClient } from "@bittery/shared/rpc";
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
	const defaultClient = useRPCClient();
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
			const { accountsInfo } = await core.accounts.resolveAccounts();
			if (accountsInfo.length > 0) {
				await core.vaultCoordinator.refreshFromServer(accountsInfo);
			}
			await invalidator.invalidateVaultKeys();
		},
	});
}
