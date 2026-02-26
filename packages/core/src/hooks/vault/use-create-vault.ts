/**
 * useCreateVault Hook
 *
 * Creates a new vault with encryption and optional image upload.
 */

import { useTRPCClient } from "@bittery/shared/trpc";
import { useMutation } from "@tanstack/react-query";
import {
	useCoreContext,
	useQueryInvalidator,
} from "../../context/platform-context";

/**
 * Image file input - supports File (browser) or Blob
 */
export type ImageFileInput = File | (Blob & { name?: string });

/**
 * Input for creating a new vault
 */
export interface CreateVaultInput {
	name: string;
	type: "personal" | "team";
	icon: string;
	imageFile?: ImageFileInput;
	imageKey?: string;
	accountEmail?: string;
}

/**
 * Result from vault creation
 */
export interface CreateVaultResult {
	vaultId: string;
}

/**
 * Hook for creating a new vault.
 */
export function useCreateVault() {
	const defaultClient = useTRPCClient();
	const core = useCoreContext();
	const invalidator = useQueryInvalidator();

	return useMutation({
		mutationFn: (input: CreateVaultInput): Promise<CreateVaultResult> =>
			core.vaults.createVault(input, defaultClient),
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
