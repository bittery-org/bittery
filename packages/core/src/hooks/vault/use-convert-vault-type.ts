/**
 * useConvertVaultType Hook
 *
 * Converts an existing vault between personal and team types.
 */

import { useTRPCClient } from "@bittery/shared/trpc";
import { useMutation } from "@tanstack/react-query";
import {
	useCoreContext,
	useQueryInvalidator,
} from "../../context/platform-context";

export interface ConvertVaultTypeInput {
	vaultId: string;
	targetType: "personal" | "team";
	personalEncryptedVaultKey?: string;
	accountEmail?: string;
}

export interface ConvertVaultTypeResult {
	success: true;
	vaultId: string;
	previousType: "personal" | "team";
	newType: "personal" | "team";
}

export function useConvertVaultType() {
	const defaultClient = useTRPCClient();
	const core = useCoreContext();
	const invalidator = useQueryInvalidator();

	return useMutation({
		mutationFn: (
			input: ConvertVaultTypeInput,
		): Promise<ConvertVaultTypeResult> =>
			core.vaults.convertVaultType(input, defaultClient),
		onSuccess: async (_data, variables) => {
			await core.vaults.refreshVaultKeys(defaultClient, variables.accountEmail);
			const { accountsInfo } = await core.accounts.resolveAccounts();
			if (accountsInfo.length > 0) {
				await core.vaultCoordinator.refreshFromServer(accountsInfo);
			}
			await invalidator.invalidateVaultKeys();
			await invalidator.invalidateVaultList(variables.vaultId);
			await invalidator.invalidateVaultMembers(variables.vaultId);
		},
	});
}
