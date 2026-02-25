/**
 * usePermanentDeleteItem Hook
 *
 * Permanently deletes a vault item from trash.
 */

import { useMutation } from "@tanstack/react-query";
import {
	enqueueItemMutation,
	requireLocalItemMutationContext,
	useItemMutationRuntime,
} from "./mutation-utils";

/**
 * Input for permanently deleting an item
 */
export interface PermanentDeleteItemInput {
	itemId: string;
	vaultId: string;
}

/**
 * Hook for permanently deleting an item from trash.
 */
export function usePermanentDeleteItem() {
	const { core, queue } = useItemMutationRuntime();

	return useMutation({
		mutationFn: async (input: PermanentDeleteItemInput) => {
			const context = requireLocalItemMutationContext(
				core,
				input.itemId,
			);
			await context.repo.removeItem(input.itemId);
			enqueueItemMutation(queue, context, {
				type: "permanent_delete",
				entityId: input.itemId,
				vaultId: input.vaultId,
			});

			return {
				_accountEmail: context.accountEmail,
			};
		},
	});
}
