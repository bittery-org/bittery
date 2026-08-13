/**
 * useItem Hook - Unified Single Item Fetching
 *
 * Reads from the local VaultRepository.
 */

import { toCachedItemFromRepositoryItem } from "@bittery/shared/item-mapping";
import type { DecryptedItemData, ItemCategory } from "@bittery/shared/types";
import type { CachedEncryptedItem } from "@bittery/types";
import { useMemo } from "react";
import type { VaultRepositoryItemAccount } from "../services/vault-repository";
import { extractDecryptedItemData } from "./items/mutation-utils";
import { useVaultRepositoryState } from "./use-vault-repository-state";

export interface UseItemOptions {
	accountId?: string;
	accountEmail?: string;
	enabled?: boolean;
}

/**
 * The item's own fields come straight from the cached record, so this hook cannot quietly
 * drop one the server started sending. `account` is the repository's, not the server's.
 */
export type RawItemForAccount = CachedEncryptedItem & {
	/** Already decoded by the repository; the wire spells it as an open string. */
	category: ItemCategory;
	account?: VaultRepositoryItemAccount;
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
	const { isLoading, error, refetch, snapshot, vaultRepository } =
		useVaultRepositoryState({
			enabled,
		});

	const item = useMemo(() => {
		// Snapshot is an invalidation signal from the repository.
		void snapshot;

		if (!enabled || !itemId) {
			return undefined;
		}
		return vaultRepository.getById(itemId, options.accountId);
	}, [vaultRepository, enabled, itemId, options.accountId, snapshot]);

	if (!enabled || !itemId) {
		return {
			rawItem: null,
			decryptedData: null,
			isLoading: false,
			error,
			refetch,
		};
	}

	if (!item) {
		return {
			rawItem: null,
			decryptedData: null,
			isLoading,
			error,
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
		error,
		refetch,
	};
}
