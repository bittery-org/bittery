import type { UnifiedItem } from "@bittery/core/hooks";
import type { DecryptedItem } from "@bittery/shared/types";

/**
 * A vault item as the mobile UI displays it: either the single-vault shape
 * from `useVaultItems` or the multi-account shape from `useItems`.
 */
export type Item = DecryptedItem | UnifiedItem;
