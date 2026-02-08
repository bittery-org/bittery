/**
 * useItem Hook - Unified Single Item Fetching
 *
 * Automatically detects the account for an item and fetches it with the correct credentials.
 * Works in both single-account and "All Accounts" mode without manual account management.
 */

import { useTRPCClient } from "@bittery/shared/trpc";
import type { DecryptedItemData } from "@bittery/shared/types";
import { useQuery } from "@tanstack/react-query";
import { useCoreContext, usePlatform } from "../context/platform-context";
import { useItems } from "./use-items";

export interface UseItemOptions {
	accountEmail?: string;
	enabled?: boolean;
}

export interface UseItemResult {
	rawItem: any;
	decryptedData: DecryptedItemData | null | undefined;
	isLoading: boolean;
	error: Error | null;
	refetch: () => void;
}

/**
 * Hook to fetch and decrypt a single item.
 * Automatically handles account detection in "All Accounts" mode.
 *
 * @param itemId - The ID of the item to fetch
 * @returns Object containing raw item, decrypted data, loading state, and error
 *
 * @example
 * ```tsx
 * const { decryptedData, isLoading } = useItem(itemId);
 *
 * if (isLoading) return <Loader />;
 * return <ItemDetails data={decryptedData} />;
 * ```
 */
export function useItem(
	itemId: string,
	options: UseItemOptions = {},
): UseItemResult {
	const trpcClient = useTRPCClient();
	const core = useCoreContext();
	const { storage } = usePlatform();
	const { accountEmail: explicitAccountEmail, enabled = true } = options;

	const { data: activeAccount, isLoading: isLoadingActiveAccount } = useQuery({
		queryKey: ["accounts", "active"],
		queryFn: () => storage.getActiveAccount(),
		staleTime: 5 * 1000,
		enabled: enabled && storage.supportsMultiAccount && !explicitAccountEmail,
	});

	const isAllAccountsMode = activeAccount?.type === "all";
	const shouldResolveFromItems =
		enabled && isAllAccountsMode && !explicitAccountEmail;
	const isResolvingAccountMode =
		enabled &&
		storage.supportsMultiAccount &&
		!explicitAccountEmail &&
		isLoadingActiveAccount;

	// In all-accounts mode without explicit account, find the source account first.
	const { items, isLoading: isLoadingItems } = useItems({
		enabled: shouldResolveFromItems,
	});

	const itemFromList = shouldResolveFromItems
		? items.find((i) => i.id === itemId)
		: undefined;
	const resolvedAccountEmail = explicitAccountEmail
		? explicitAccountEmail
		: isAllAccountsMode && itemFromList && "account" in itemFromList
			? (itemFromList as any).account?.email
			: undefined;

	const { data, isLoading, error, refetch } = useQuery({
		queryKey: resolvedAccountEmail
			? ["decrypted-item-account", itemId, resolvedAccountEmail]
			: ["decrypted-item", itemId],
		queryFn: () =>
			core.items.fetchAndDecryptItem(itemId, trpcClient, resolvedAccountEmail),
		enabled:
			!!itemId &&
			enabled &&
			!isResolvingAccountMode &&
			(!isAllAccountsMode || !!resolvedAccountEmail),
		staleTime: 5 * 60 * 1000,
		gcTime: 10 * 60 * 1000,
	});

	return {
		rawItem: data?.rawItem,
		decryptedData: data?.decryptedData,
		isLoading:
			isLoading ||
			isLoadingActiveAccount ||
			(shouldResolveFromItems && isLoadingItems),
		error: (error as Error | null) ?? null,
		refetch,
	};
}
