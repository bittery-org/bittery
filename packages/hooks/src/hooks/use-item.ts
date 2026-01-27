/**
 * useItem Hook - Unified Single Item Fetching
 *
 * Automatically detects the account for an item and fetches it with the correct credentials.
 * Works in both single-account and "All Accounts" mode without manual account management.
 *
 * This replaces the complex pattern of checking mode and passing accountEmail manually.
 */

import type { DecryptedItemData } from "@bittery/shared/types";
import { useDecryptedItem } from "./internal/use-decrypted-item";
import { useItems } from "./use-items";

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
export function useItem(itemId: string): UseItemResult {
	// Get all items to find which account this item belongs to
	const { items, isAllAccountsMode } = useItems();

	// Find the item to get its account email (if in "All Accounts" mode)
	const itemFromList = items.find((i) => i.id === itemId);
	const accountEmail =
		isAllAccountsMode && itemFromList && "account" in itemFromList
			? (itemFromList as any).account?.email
			: undefined;

	// Fetch the full item with the correct account credentials
	const result = useDecryptedItem(itemId, { accountEmail });

	return result as UseItemResult;
}
