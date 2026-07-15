/**
 * useUpdateVault Hook
 *
 * Updates an existing vault's metadata.
 */

import { useRPCClient } from "@bittery/shared/rpc";
import { useMutation } from "@tanstack/react-query";
import {
	useCoreContext,
	useQueryInvalidator,
} from "../../context/platform-context";

/**
 * Input for updating a vault
 */
export interface UpdateVaultInput {
	vaultId: string;
	name?: string;
	icon?: string | null;
	imageFile?: File;
	removeImage?: boolean;
	accountId: string;
}

/**
 * Hook for updating a vault's metadata.
 */
export function useUpdateVault() {
	const defaultClient = useRPCClient();
	const core = useCoreContext();
	const invalidator = useQueryInvalidator();

	return useMutation({
		mutationFn: (input: UpdateVaultInput): Promise<void> =>
			core.vaults.updateVault(input, defaultClient),
		onSuccess: async (_data, variables) => {
			await core.vaults.refreshVaultKeys(defaultClient, variables.accountId);
			const { accountsInfo } = await core.accounts.resolveAccounts();
			if (accountsInfo.length > 0) {
				await core.vaultCoordinator.refreshFromServer(accountsInfo);
			}
			await invalidator.invalidateVaultKeys();
		},
	});
}
