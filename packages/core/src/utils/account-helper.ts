/**
 * Account Helper Utilities
 *
 * Compatibility wrappers around core account resolver helpers.
 */

import type { useRPCClient } from "@bittery/shared";
import type { AccountStore } from "@bittery/storage";
import type { DeletedItem } from "../hooks/use-deleted-items";
import type { UnifiedItem } from "../hooks/use-items";
import {
	findAccountForItem as findAccountForItemCore,
	getClientForAccount as getClientForAccountCore,
	getItemAccountEmail as getItemAccountEmailCore,
} from "../services/account-resolver";

/**
 * Extracts the account email from an item if it has account metadata.
 */
export function getItemAccountEmail(
	item: UnifiedItem | DeletedItem | undefined,
): string | undefined {
	return getItemAccountEmailCore(
		item as
			| { id: string; accountEmail?: string; account?: { email?: string } }
			| undefined,
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
		items as Array<{
			id: string;
			accountEmail?: string;
			account?: { email?: string };
		}>,
	);
}

export async function getTRPCClientForAccount(
	storage: AccountStore,
	defaultClient: ReturnType<typeof useRPCClient>,
	accountId: string,
) {
	return getClientForAccountCore(
		storage,
		defaultClient as Parameters<typeof getClientForAccountCore>[1],
		accountId,
	);
}
