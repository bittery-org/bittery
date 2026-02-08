/**
 * useVaultItems Hook - Simplified Vault-Specific Item Fetching
 */

import type { DecryptedItem } from "@bittery/shared/types";
import { useQuery } from "@tanstack/react-query";
import { useCoreContext } from "../../context/platform-context";
import { useAccountsInfo } from "./use-accounts-info";

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
	const core = useCoreContext();
	const {
		accountsInfo,
		isLoading: isLoadingAccounts,
		isAllAccountsMode,
	} = useAccountsInfo({ enabled: options.enabled });

	const {
		data: items = [],
		isLoading: isLoadingItems,
		error,
		refetch,
	} = useQuery({
		queryKey: ["vault-items", vaultId, accountsInfo.map((a) => a.email).sort()],
		queryFn: async (): Promise<DecryptedItem[]> =>
			core.items.fetchVaultItems(vaultId, accountsInfo),
		enabled: !!vaultId && accountsInfo.length > 0 && options.enabled !== false,
		staleTime: 5 * 60 * 1000,
		gcTime: 10 * 60 * 1000,
	});

	return {
		items,
		isLoading: isLoadingAccounts || isLoadingItems,
		error,
		refetch,
		isAllAccountsMode,
	};
}
