/**
 * useToggleFavorite Hook
 *
 * Toggles the favorite status of a vault item.
 */

import { useMutation } from "@tanstack/react-query";
import {
	enqueueItemMutation,
	requireLocalItemMutationContext,
	useItemMutationRuntime,
} from "./mutation-utils";

/**
 * Input for toggling favorite status
 */
export interface ToggleFavoriteInput {
	itemId: string;
	vaultId: string;
	favorite: boolean;
}

/**
 * Hook for toggling an item's favorite status.
 */
export function useToggleFavorite() {
	const { core, queue } = useItemMutationRuntime();

	return useMutation({
		mutationFn: async (input: ToggleFavoriteInput) => {
			const context = requireLocalItemMutationContext(core, input.itemId);
			await context.repo.updateFavorite(input.itemId, input.favorite);
			enqueueItemMutation(queue, context, {
				type: "toggle_favorite",
				entityId: input.itemId,
				vaultId: input.vaultId,
				favorite: input.favorite,
			});

			return {
				_accountEmail: context.accountEmail,
			};
		},
	});
}
