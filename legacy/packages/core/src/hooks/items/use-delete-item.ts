/**
 * useDeleteItem Hook
 *
 * Soft-deletes a vault item (moves to trash).
 */

import { useMutation } from "@tanstack/react-query";
import { useItemMutationRuntime } from "./mutation-utils";

/**
 * Input for deleting an item
 */
export interface DeleteItemInput {
	itemId: string;
	vaultId: string;
	accountId: string;
}

/**
 * Hook for soft-deleting a vault item.
 */
export function useDeleteItem() {
	const { commands } = useItemMutationRuntime();

	return useMutation({
		mutationFn: (input: DeleteItemInput) =>
			commands.execute({ type: "delete", ...input }),
	});
}
