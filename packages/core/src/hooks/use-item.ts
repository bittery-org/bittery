/**
 * useItem Hook - Unified Single Item Fetching
 *
 * Reads from the local VaultRepositoryCoordinator.
 */

import { toCachedItemFromRepositoryItem } from "@bittery/shared/item-mapping";
import type { DecryptedItemData, ItemCategory } from "@bittery/shared/types";
import type { CachedEncryptedItem } from "@bittery/types";
import { useMemo } from "react";
import type { CoordinatedItemAccount } from "../services/vault-repository-coordinator";
import { extractDecryptedItemData } from "./items/mutation-utils";
import { useVaultRepositorySync } from "./use-vault-repository-sync";

export interface UseItemOptions {
	accountEmail?: string;
	enabled?: boolean;
}

/**
 * The item's own fields come straight from the cached record, so this hook cannot quietly
 * drop one the server started sending. `account` is the coordinator's, not the server's.
 */
export type RawItemForAccount = CachedEncryptedItem & {
	/** Already decoded by the repository; the wire spells it as an open string. */
	category: ItemCategory;
	account?: CoordinatedItemAccount;
};

export interface UseItemResult {
	rawItem: RawItemForAccount | null;
	decryptedData: DecryptedItemData | null | undefined;
	isLoading: boolean;
	error: Error | null;
	refetch: () => void;
}

/**
 * Hook to fetch and decrypt a single item.
 */
export function useItem(
	itemId: string,
	options: UseItemOptions = {},
): UseItemResult {
	const { enabled = true } = options;
	const { isLoading, refetch, snapshot, vaultCoordinator } =
		useVaultRepositorySync({
			enabled,
			requiredId: itemId,
		});

	const item = useMemo(() => {
		// Snapshot is an invalidation signal from the coordinator store.
		void snapshot;

		if (!enabled || !itemId) {
			return undefined;
		}
		return vaultCoordinator.getById(itemId);
	}, [vaultCoordinator, enabled, itemId, snapshot]);

	if (!enabled || !itemId) {
		return {
			rawItem: null,
			decryptedData: null,
			isLoading: false,
			error: null,
			refetch,
		};
	}

	if (!item) {
		return {
			rawItem: null,
			decryptedData: null,
			isLoading,
			error: null,
			refetch,
		};
	}

	const rawItem: RawItemForAccount = {
		...toCachedItemFromRepositoryItem(item, {
			accountId: item.account?.accountId,
			accountEmail: item.account?.email,
			serverUrl: item.account?.serverUrl,
		}),
		category: item.category,
		account: item.account,
	};

	return {
		rawItem,
		decryptedData: extractDecryptedItemData(item),
		isLoading,
		error: null,
		refetch,
	};
}
