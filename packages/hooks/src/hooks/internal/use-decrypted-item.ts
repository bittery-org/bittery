/**
 * useDecryptedItem Hook
 *
 * Fetches and decrypts a single vault item by ID.
 * Context-aware: works in both single-account and "All Accounts" mode.
 */

import { useTRPCClient } from "@bittery/shared/trpc";
import { useQuery } from "@tanstack/react-query";
import { useCoreContext, usePlatform } from "../../context/platform-context";

export interface UseDecryptedItemOptions {
	accountEmail?: string;
}

/**
 * Hook to fetch and decrypt a single vault item.
 */
export function useDecryptedItem(
	itemId: string,
	options: UseDecryptedItemOptions = {},
) {
	const trpcClient = useTRPCClient();
	const core = useCoreContext();
	const { storage } = usePlatform();
	const { accountEmail } = options;

	const { data: activeAccount } = useQuery({
		queryKey: ["accounts", "active"],
		queryFn: () => storage.getActiveAccount(),
		staleTime: 5 * 1000,
		enabled: storage.supportsMultiAccount && !accountEmail,
	});

	const isAllAccountsMode = activeAccount?.type === "all";

	const { data, isLoading, error, refetch } = useQuery({
		queryKey: accountEmail
			? ["decrypted-item-account", itemId, accountEmail]
			: ["decrypted-item", itemId],
		queryFn: () =>
			core.items.fetchAndDecryptItem(itemId, trpcClient, accountEmail),
		enabled: !!itemId && (!isAllAccountsMode || !!accountEmail),
		staleTime: 5 * 60 * 1000,
		gcTime: 10 * 60 * 1000,
	});

	return {
		rawItem: data?.rawItem,
		decryptedData: data?.decryptedData,
		isLoading,
		error,
		refetch,
	};
}
