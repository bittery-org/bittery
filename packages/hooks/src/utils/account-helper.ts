/**
 * Account Helper Utilities
 *
 * Helpers for detecting and working with accounts in multi-account mode.
 * These utilities help mutation hooks work correctly in "All Accounts" mode
 * by finding the correct account for each item.
 */

import type { UnifiedItem } from "../hooks/use-items";
import type { UnifiedDeletedItem } from "../hooks/use-all-deleted-items";

/**
 * Extracts the account email from an item if it has account metadata.
 * Returns undefined if the item doesn't have account info (single-account mode).
 *
 * @param item - The item to extract account email from
 * @returns Account email or undefined
 */
export function getItemAccountEmail(
	item: UnifiedItem | UnifiedDeletedItem | undefined,
): string | undefined {
	if (!item) return undefined;
	return "account" in item ? (item as any).account?.email : undefined;
}

/**
 * Finds the account email for a specific item by searching through a list of items.
 * This is useful when you only have the item ID and need to determine which account it belongs to.
 *
 * @param itemId - The ID of the item to find
 * @param items - The list of items to search through
 * @returns Account email or undefined if not found or in single-account mode
 */
export function findAccountEmailForItem(
	itemId: string,
	items: (UnifiedItem | UnifiedDeletedItem)[],
): string | undefined {
	const item = items.find((i) => i.id === itemId);
	return getItemAccountEmail(item);
}
