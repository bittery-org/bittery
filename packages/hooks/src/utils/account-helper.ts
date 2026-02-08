/**
 * Account Helper Utilities
 *
 * Compatibility wrappers around @bittery/core account resolver helpers.
 */

import {
	findAccountForItem as findAccountForItemCore,
	getClientForAccount as getClientForAccountCore,
	getItemAccountEmail as getItemAccountEmailCore,
} from "@bittery/core";
import type { useTRPCClient } from "@bittery/shared";
import type { IStorageAdapter } from "@bittery/storage";
import type { DeletedItem } from "../hooks/use-deleted-items";
import type { UnifiedItem } from "../hooks/use-items";

/**
 * Extracts the account email from an item if it has account metadata.
 */
export function getItemAccountEmail(
	item: UnifiedItem | DeletedItem | undefined,
): string | undefined {
	return getItemAccountEmailCore(
		item as { id: string; account?: { email?: string } } | undefined,
	);
}

/**
 * Finds the account email for a specific item.
 */
export function findAccountEmailForItem(
	itemId: string,
	items: (UnifiedItem | DeletedItem)[],
): string | undefined {
	return findAccountForItemCore(
		itemId,
		items as Array<{ id: string; account?: { email?: string } }>,
	);
}

export async function getTRPCClientForAccount(
	storage: IStorageAdapter,
	defaultClient: ReturnType<typeof useTRPCClient>,
	accountEmail?: string,
) {
	return getClientForAccountCore(
		storage,
		defaultClient as Parameters<typeof getClientForAccountCore>[1],
		accountEmail,
	);
}
