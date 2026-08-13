/**
 * useUpdateItem Hook
 *
 * Updates an existing vault item with local-first persistence when sync queue is available.
 */

import type { DecryptedItemData } from "@bittery/shared/types";
import { useMutation } from "@tanstack/react-query";
import { useItemMutationRuntime } from "./mutation-utils";

/**
 * Input for updating an item
 */
export interface UpdateItemInput {
	itemId: string;
	vaultId: string;
	data: Partial<DecryptedItemData>;
}

/**
 * Hook for updating a vault item.
 */
export function useUpdateItem() {
	const { commands } = useItemMutationRuntime();

	return useMutation({
		mutationFn: (input: UpdateItemInput) =>
			commands.execute({ type: "update", ...input }),
	});
}
