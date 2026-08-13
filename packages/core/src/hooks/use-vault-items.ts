/**
 * useVaultItems Hook - Simplified Vault-Specific Item Fetching
 */

import type { DecryptedItem } from "@bittery/shared/types";
import { useMemo } from "react";
import { useVaultRepositoryState } from "./use-vault-repository-state";

export interface UseVaultItemsOptions {
	accountId?: string;
	enabled?: boolean;
}

/**
 * Hook to fetch and decrypt items from a specific vault.
 */
export function useVaultItems(
	vaultId: string,
	options: UseVaultItemsOptions = {},
) {
	const { isLoading, error, refetch, snapshot, vaultRepository, enabled } =
		useVaultRepositoryState({
			enabled: options.enabled,
		});

	const items = useMemo(() => {
		// Snapshot is an invalidation signal from the repository.
		void snapshot;
		return enabled
			? (vaultRepository.getByVault(
					vaultId,
					options.accountId,
				) as DecryptedItem[])
			: [];
	}, [vaultRepository, enabled, vaultId, options.accountId, snapshot]);

	return {
		items,
		isLoading,
		error,
		refetch,
	};
}
