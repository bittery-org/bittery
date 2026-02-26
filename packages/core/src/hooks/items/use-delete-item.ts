/**
 * useDeleteItem Hook
 *
 * Soft-deletes a vault item (moves to trash).
 */

import { useMutation } from "@tanstack/react-query";
import {
	enqueueItemMutation,
	requireLocalItemMutationContext,
	useItemMutationRuntime,
} from "./mutation-utils";

/**
 * Input for deleting an item
 */
export interface DeleteItemInput {
	itemId: string;
	vaultId: string;
}

/**
 * Hook for soft-deleting a vault item.
 */
export function useDeleteItem() {
	const { core, queue } = useItemMutationRuntime();

	return useMutation({
		mutationFn: async (input: DeleteItemInput) => {
			const context = requireLocalItemMutationContext(core, input.itemId);
			await context.repo.softDelete(input.itemId);
			enqueueItemMutation(queue, context, {
				type: "delete",
				entityId: input.itemId,
				vaultId: input.vaultId,
			});

			return {
				_accountEmail: context.accountEmail,
			};
		},
	});
}
