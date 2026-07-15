/**
 * useAllVaultKeys Hook
 *
 * Fetches all vault keys with account metadata from VaultRepositoryCoordinator.
 */

import type { VaultKeyData } from "@bittery/storage/types";
import { useMemo } from "react";
import { useVaultRepositorySync } from "./use-vault-repository-sync";

/**
 * Vault key with associated account metadata
 */
export interface VaultKeyWithAccount extends VaultKeyData {
	accountId: string;
	accountEmail?: string;
	accountName?: string;
	accountTeamName?: string;
	accountTeamAvatarUrl?: string | null;
}

export interface UseAllVaultKeysOptions {
	enabled?: boolean;
}

/**
 * Hook to fetch all vault keys with account metadata.
 * Automatically handles single-account vs "All Accounts" mode.
 *
 * In single-account mode: Returns vault keys for one account
 * In all-accounts mode: Returns vault keys from all unlocked accounts with account metadata
 *
 * @param options - Query options
 * @returns Vault keys with account metadata, loading state, and error
 *
 * @example
 * ```tsx
 * const { vaultKeys, isLoading, isAllAccountsMode } = useAllVaultKeys();
 *
 * vaultKeys.map(vault => (
 *   <VaultItem
 *     key={vault.vaultId}
 *     name={vault.vaultName}
 *     accountEmail={vault.accountEmail} // Only present in multi-account mode
 *   />
 * ))
 * ```
 */
export function useAllVaultKeys(options: UseAllVaultKeysOptions = {}) {
	const {
		accountsInfo,
		isAllAccountsMode,
		isLoading,
		snapshot,
		vaultCoordinator,
	} = useVaultRepositorySync({
		enabled: options.enabled,
	});

	const vaultKeys = useMemo(() => {
		// Snapshot is an invalidation signal from the coordinator store.
		void snapshot;

		if (accountsInfo.length === 0) {
			return [] as VaultKeyWithAccount[];
		}

		return accountsInfo.flatMap((account) =>
			vaultCoordinator
				.getRepositoryForAccount(account.accountId)
				.getVaultKeys()
				.map((vaultKey) => ({
					...vaultKey,
					accountId: account.accountId,
					accountEmail: isAllAccountsMode ? account.email : undefined,
					accountName: isAllAccountsMode ? account.name : undefined,
					accountTeamName: isAllAccountsMode ? account.teamName : undefined,
					accountTeamAvatarUrl: isAllAccountsMode
						? account.teamAvatarUrl
						: undefined,
				})),
		);
	}, [accountsInfo, isAllAccountsMode, snapshot, vaultCoordinator]);

	return {
		vaultKeys,
		isLoading,
		error: null,
		isAllAccountsMode,
	};
}
