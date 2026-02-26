/**
 * useDeletedItems Hook - Deleted Item Fetching
 *
 * Local-first read path backed by VaultRepositoryCoordinator.
 */

import { useMemo } from "react";
import type { CoordinatedItem } from "../services/vault-repository-coordinator";
import { useVaultRepositorySync } from "./use-vault-repository-sync";

export type DeletedItem = CoordinatedItem;

export interface UseDeletedItemsOptions {
	enabled?: boolean;
}

/**
 * Hook to fetch deleted items across vaults.
 */
export function useDeletedItems(options: UseDeletedItemsOptions = {}) {
	const {
		accountsInfo,
		isAllAccountsMode,
		isLoading,
		refetch,
		snapshot,
		vaultCoordinator,
	} = useVaultRepositorySync({
		enabled: options.enabled,
	});

	const items = useMemo(() => {
		// Snapshot is an invalidation signal from the coordinator store.
		void snapshot;
		return vaultCoordinator.getDeleted() as DeletedItem[];
	}, [vaultCoordinator, snapshot]);

	return {
		items,
		isLoading,
		error: null,
		refetch,
		isAllAccountsMode,
		unlockedAccounts: accountsInfo,
	};
}
