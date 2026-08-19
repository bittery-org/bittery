/**
 * useConvertVaultType Hook
 *
 * Converts an existing vault between personal and team types.
 */

import { useMutation } from "@tanstack/react-query";
import {
	useCoreContext,
	useQueryInvalidator,
} from "../../context/platform-context";
import { useRefreshAfterVaultMutation } from "./mutation-utils";

export interface ConvertVaultTypeInput {
	vaultId: string;
	targetType: "personal" | "team";
	personalEncryptedVaultKey?: string;
	accountId: string;
}

export interface ConvertVaultTypeResult {
	success: true;
	vaultId: string;
	previousType: "personal" | "team";
	newType: "personal" | "team";
}

export function useConvertVaultType() {
	const core = useCoreContext();
	const invalidator = useQueryInvalidator();
	const refreshAfterMutation = useRefreshAfterVaultMutation();

	return useMutation({
		mutationFn: (
			input: ConvertVaultTypeInput,
		): Promise<ConvertVaultTypeResult> => core.vaults.convertVaultType(input),
		onSuccess: async (_data, variables) => {
			await refreshAfterMutation(variables.accountId);
			await invalidator.invalidateVaultList(variables.vaultId);
			await invalidator.invalidateVaultMembers(variables.vaultId);
		},
	});
}
