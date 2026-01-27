/**
 * useVaultInfo Hook
 *
 * Fetches vault metadata for a specific vault.
 * Automatically handles single-account vs multi-account mode.
 */

import type { VaultKeyData } from "@bittery/storage/types";
import { useQuery } from "@tanstack/react-query";
import { usePlatformStorage } from "../../context/platform-context";
import { useAccountsInfo } from "./use-accounts-info";

export interface UseVaultInfoOptions {
	enabled?: boolean;
}

/**
 * Hook to get vault information from local storage.
 * Automatically handles single-account vs "All Accounts" mode.
 *
 * @param vaultId - The ID of the vault to get info for
 * @param options - Query options
 * @returns Vault key data, loading state, and error
 *
 * @example
 * ```tsx
 * const { vaultInfo, isLoading } = useVaultInfo(vaultId);
 *
 * if (vaultInfo) {
 *   console.log('Vault name:', vaultInfo.vaultName);
 *   console.log('Role:', vaultInfo.role);
 * }
 * ```
 */
export function useVaultInfo(
	vaultId: string,
	options: UseVaultInfoOptions = {},
) {
	const storage = usePlatformStorage();

	// Get account info (handles both single and multi-account mode)
	const { accountsInfo, isLoading: isLoadingAccounts } = useAccountsInfo({
		enabled: options.enabled,
	});

	// Find vault info from the correct account
	const {
		data: vaultInfo = null,
		isLoading: isLoadingVault,
		error,
	} = useQuery({
		queryKey: ["vault-info", vaultId, accountsInfo.map((a) => a.email).sort()],
		queryFn: async (): Promise<VaultKeyData | null> => {
			if (!vaultId || accountsInfo.length === 0) return null;

			// Search through all accounts to find which one has this vault
			for (const account of accountsInfo) {
				const vaultKeys = await storage.getVaultKeys(account.email);
				if (!vaultKeys) continue;

				const vaultKey = vaultKeys.find((vk) => vk.vaultId === vaultId);
				if (vaultKey) {
					return vaultKey;
				}
			}

			return null;
		},
		enabled: !!vaultId && accountsInfo.length > 0 && options.enabled !== false,
		staleTime: 5 * 60 * 1000, // 5 minutes
	});

	return {
		vaultInfo,
		isLoading: isLoadingAccounts || isLoadingVault,
		error,
	};
}
