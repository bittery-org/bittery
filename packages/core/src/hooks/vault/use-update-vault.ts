/**
 * useUpdateVault Hook
 *
 * Updates an existing vault's metadata.
 */

import { useTRPCClient } from "@bittery/shared/trpc";
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
	accountEmail?: string;
}

/**
 * Hook for updating a vault's metadata.
 */
export function useUpdateVault() {
	const defaultClient = useTRPCClient();
	const core = useCoreContext();
	const invalidator = useQueryInvalidator();

	return useMutation({
		mutationFn: (input: UpdateVaultInput): Promise<void> =>
			core.vaults.updateVault(input, defaultClient),
		onSuccess: async (_data, variables) => {
			await core.vaults.refreshVaultKeys(defaultClient, variables.accountEmail);
			await invalidator.invalidateVaultKeys();
		},
	});
}
