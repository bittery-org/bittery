/**
 * useVaultItems Hook - Simplified Vault-Specific Item Fetching
 */

import type { DecryptedItem } from "@bittery/shared/types";
import { useMemo } from "react";
import { useVaultRepositorySync } from "./use-vault-repository-sync";

export interface UseVaultItemsOptions {
	enabled?: boolean;
}

/**
 * Hook to fetch and decrypt items from a specific vault.
 */
export function useVaultItems(
	vaultId: string,
	options: UseVaultItemsOptions = {},
) {
	const { isAllAccountsMode, isLoading, refetch, snapshot, vaultCoordinator } =
		useVaultRepositorySync({
			enabled: options.enabled,
			requiredId: vaultId,
		});

	const items = useMemo(
		() => vaultCoordinator.getByVault(vaultId) as DecryptedItem[],
		[vaultCoordinator, vaultId, snapshot],
	);

	return {
		items,
		isLoading,
		error: null,
		refetch,
		isAllAccountsMode,
	};
}
