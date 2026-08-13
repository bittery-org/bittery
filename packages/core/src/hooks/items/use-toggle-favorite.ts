/**
 * useToggleFavorite Hook
 *
 * Toggles the favorite status of a vault item.
 */

import { useMutation } from "@tanstack/react-query";
import { useItemMutationRuntime } from "./mutation-utils";

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
	const { commands } = useItemMutationRuntime();

	return useMutation({
		mutationFn: (input: ToggleFavoriteInput) =>
			commands.execute({ type: "toggle_favorite", ...input }),
	});
}
