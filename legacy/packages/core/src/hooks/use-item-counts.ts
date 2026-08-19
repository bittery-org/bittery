/**
 * useItemCounts Hook
 *
 * Derives the sidebar item counts (total, favorites, per-vault) from an
 * already-loaded item array. Counts are a pure client-side derivation of the
 * in-memory vault repository, so no extra fetch is involved.
 */

import type { DecryptedItem } from "@bittery/shared/types";
import { useMemo } from "react";

export interface VaultItemCounts {
	/** Total non-deleted items across every unlocked vault. */
	total: number;
	/** Non-deleted items flagged as favorite. */
	favorites: number;
	/** Non-deleted item count keyed by vault id. Vaults with no items are absent. */
	byVault: Record<string, number>;
}

/**
 * Count items for the vault sidebar.
 *
 * @param items - Non-deleted items, or `undefined` while they are still loading
 * @returns Counts, or `undefined` when items are not loaded yet so callers can
 *          render nothing instead of flashing a misleading zero
 */
export function useItemCounts(
	items: DecryptedItem[] | undefined,
): VaultItemCounts | undefined {
	return useMemo(() => {
		if (!items) return undefined;

		const byVault: Record<string, number> = {};
		let favorites = 0;

		for (const item of items) {
			byVault[item.vaultId] = (byVault[item.vaultId] ?? 0) + 1;
			if (item.favorite) favorites++;
		}

		return { total: items.length, favorites, byVault };
	}, [items]);
}
