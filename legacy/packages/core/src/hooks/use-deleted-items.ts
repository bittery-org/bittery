/**
 * useDeletedItems Hook - Deleted Item Fetching
 *
 * Local-first read path backed by VaultRepository.
 */

import { useMemo } from "react";
import type { VaultRepositoryItemWithAccount } from "../services/vault-repository";
import { useVaultRepositoryState } from "./use-vault-repository-state";

export type DeletedItem = VaultRepositoryItemWithAccount;

export interface UseDeletedItemsOptions {
	enabled?: boolean;
}

/**
 * Hook to fetch deleted items across vaults.
 */
export function useDeletedItems(options: UseDeletedItemsOptions = {}) {
	const {
		accountsInfo,
		isLoading,
		error,
		refetch,
		snapshot,
		vaultRepository,
		enabled,
	} = useVaultRepositoryState({
		enabled: options.enabled,
	});

	const items = useMemo(() => {
		// Snapshot is an invalidation signal from the repository.
		void snapshot;
		return enabled ? (vaultRepository.getDeleted() as DeletedItem[]) : [];
	}, [vaultRepository, enabled, snapshot]);

	return {
		items,
		isLoading,
		error,
		refetch,
		unlockedAccounts: accountsInfo,
	};
}
