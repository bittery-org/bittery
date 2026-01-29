/**
 * useAllVaultKeys Hook
 *
 * Fetches all vault keys with account metadata for active account(s).
 * Uses useAccountsInfo to handle both single and multi-account modes.
 */

import type { VaultKeyData } from "@bittery/storage/types";
import { useQuery } from "@tanstack/react-query";
import { usePlatformStorage } from "../../context/platform-context";
import { useAccountsInfo } from "./use-accounts-info";

/**
 * Vault key with associated account metadata
 */
export interface VaultKeyWithAccount extends VaultKeyData {
	accountEmail?: string;
	accountName?: string;
	accountTeamName?: string;
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
	const storage = usePlatformStorage();

	// Get all account info using utility hook
	const {
		accountsInfo,
		isLoading: isLoadingAccounts,
		isAllAccountsMode,
	} = useAccountsInfo({ enabled: options.enabled });

	// Fetch vault keys from all accounts IN PARALLEL
	const {
		data: vaultKeys = [],
		isLoading: isLoadingVaults,
		error,
	} = useQuery({
		queryKey: ["all-vault-keys", accountsInfo.map((a) => a.email).sort()],
		queryFn: async (): Promise<VaultKeyWithAccount[]> => {
			if (accountsInfo.length === 0) return [];

			// Fetch vault keys from all accounts in parallel
			const results = await Promise.all(
				accountsInfo.map(async (account) => {
					try {
						const keys = await storage.getVaultKeys(account.email);
						if (!keys || keys.length === 0) return [];

						// In multi-account mode, add account metadata to each vault key
						if (isAllAccountsMode) {
							return keys.map((key) => ({
								...key,
								accountEmail: account.email,
								accountName: account.name,
								accountTeamName: account.teamName,
							}));
						}

						// In single-account mode, return keys as-is
						return keys;
					} catch (error) {
						console.error(
							`[useAllVaultKeys] Failed to fetch vault keys for ${account.email}:`,
							error,
						);
						return [];
					}
				}),
			);

			// Flatten results from all accounts
			return results.flat();
		},
		enabled: accountsInfo.length > 0 && options.enabled !== false,
		staleTime: 5 * 60 * 1000, // 5 minutes
		gcTime: 10 * 60 * 1000, // 10 minutes
	});

	return {
		vaultKeys,
		isLoading: isLoadingAccounts || isLoadingVaults,
		error,
		isAllAccountsMode,
	};
}
