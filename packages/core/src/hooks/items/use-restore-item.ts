/**
 * useRestoreItem Hook
 *
 * Restores a soft-deleted vault item from trash.
 */

import { useMutation } from "@tanstack/react-query";
import {
	enqueueItemMutation,
	requireLocalItemMutationContext,
	useItemMutationRuntime,
} from "./mutation-utils";

/**
 * Input for restoring an item from trash
 */
export interface RestoreItemInput {
	itemId: string;
	vaultId: string;
}

/**
 * Hook for restoring a soft-deleted item from trash.
 */
export function useRestoreItem() {
	const { core, queue } = useItemMutationRuntime();

	return useMutation({
		mutationFn: async (input: RestoreItemInput) => {
			const context = requireLocalItemMutationContext(core, input.itemId, {
				vaultId: input.vaultId,
				includeDeleted: true,
			});
			await context.repo.restore(input.itemId);
			enqueueItemMutation(queue, context, {
				type: "restore",
				entityId: input.itemId,
				vaultId: input.vaultId,
			});

			return {
				_accountEmail: context.accountEmail,
			};
		},
	});
}
