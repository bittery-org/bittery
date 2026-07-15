/**
 * useItems Hook - Unified Item Fetching
 *
 * Local-first read path backed by VaultRepositoryCoordinator.
 */

import { useMemo } from "react";
import type { CoordinatedItem } from "../services/vault-repository-coordinator";
import { useVaultRepositorySync } from "./use-vault-repository-sync";

/**
 * Decrypted item with source account metadata (for multi-account mode)
 */
export type MultiAccountItem = CoordinatedItem;
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
	const { accountsInfo, isLoading, refetch, snapshot, vaultCoordinator } =
		useVaultRepositorySync({
			enabled: options.enabled,
		});

	const items = useMemo(() => {
		// Snapshot is an invalidation signal from the coordinator store.
		void snapshot;
		return vaultCoordinator.getAll() as MultiAccountItem[];
	}, [vaultCoordinator, snapshot]);

	return {
		items,
		isLoading,
		error: null,
		refetch,
		unlockedAccounts: accountsInfo,
	};
}

// Backwards-compatible alias for existing consumers.
export function useItemsUnified(options: UseItemsUnifiedOptions = {}) {
	return useItems(options);
}
