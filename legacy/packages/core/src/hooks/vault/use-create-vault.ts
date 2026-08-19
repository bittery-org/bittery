/**
 * useCreateVault Hook
 *
 * Creates a new vault with encryption and optional image upload.
 */

import { useMutation } from "@tanstack/react-query";
import { useCoreContext } from "../../context/platform-context";
import { useRefreshAfterVaultMutation } from "./mutation-utils";

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
	accountId: string;
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
	const core = useCoreContext();
	const refreshAfterMutation = useRefreshAfterVaultMutation();

	return useMutation({
		mutationFn: (input: CreateVaultInput): Promise<CreateVaultResult> =>
			core.vaults.createVault(input),
		onSuccess: (_data, variables) => refreshAfterMutation(variables.accountId),
	});
}
