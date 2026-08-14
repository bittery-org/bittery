/**
 * useItems Hook - Unified Item Fetching
 *
 * Local-first read path backed by VaultRepository.
 */

import { useMemo } from "react";
import type { VaultRepositoryItemWithAccount } from "../services/vault-repository";
import { useVaultRepositoryState } from "./use-vault-repository-state";

/**
 * Decrypted item with source account metadata (for multi-account mode)
 */
export type MultiAccountItem = VaultRepositoryItemWithAccount;
export type UnifiedItem = MultiAccountItem;

export interface UseItemsOptions {
	enabled?: boolean;
}

// Backwards-compatible alias for existing consumers.
export type UseItemsUnifiedOptions = UseItemsOptions;

/**
 * Hook to fetch and decrypt items from active account(s).
 */
export function useItems(options: UseItemsOptions = {}) {
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
		return enabled ? (vaultRepository.getAll() as MultiAccountItem[]) : [];
	}, [vaultRepository, enabled, snapshot]);

	return {
		items,
		isLoading,
		error,
		refetch,
		unlockedAccounts: accountsInfo,
	};
}

// Backwards-compatible alias for existing consumers.
export function useItemsUnified(options: UseItemsUnifiedOptions = {}) {
	return useItems(options);
}
