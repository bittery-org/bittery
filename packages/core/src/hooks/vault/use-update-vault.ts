/**
 * useUpdateVault Hook
 *
 * Updates an existing vault's metadata.
 */

import { useApiClient } from "@bittery/shared/api";
import { useMutation } from "@tanstack/react-query";
import { useCoreContext } from "../../context/platform-context";
import { useRefreshAfterVaultMutation } from "./mutation-utils";

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
	const defaultClient = useApiClient();
	const core = useCoreContext();
	const refreshAfterMutation = useRefreshAfterVaultMutation();

	return useMutation({
		mutationFn: (input: UpdateVaultInput): Promise<void> =>
			core.vaults.updateVault(input, defaultClient),
		onSuccess: (_data, variables) => refreshAfterMutation(variables.accountId),
	});
}
