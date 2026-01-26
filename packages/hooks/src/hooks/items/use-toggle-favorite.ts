/**
 * useToggleFavorite Hook
 *
 * Toggles the favorite status of a vault item.
 * Returns a React Query mutation - apps handle success/error UI.
 */

import { useTRPCClient } from "@bittery/shared/trpc";
import { useMutation } from "@tanstack/react-query";
import { useQueryInvalidator } from "../../context/platform-context";

/**
 * Input for toggling favorite status
 */
export interface ToggleFavoriteInput {
	/** ID of the item to toggle */
	itemId: string;
	/** ID of the vault containing the item */
	vaultId: string;
	/** New favorite status */
	favorite: boolean;
}

/**
 * Hook for toggling an item's favorite status.
 *
 * Handles:
 * - Updating favorite status via API
 * - Invalidating relevant queries
 *
 * Does NOT handle:
 * - Toast notifications (app responsibility)
 *
 * @example
 * ```tsx
 * const toggleFavorite = useToggleFavorite();
 *
 * const handleToggle = async () => {
 *   try {
 *     await toggleFavorite.mutateAsync({
 *       itemId,
 *       vaultId,
 *       favorite: !currentFavorite,
 *     });
 *     toast.success(newFavorite ? "Added to favorites" : "Removed from favorites");
 *   } catch (error) {
 *     toast.error(error.message);
 *   }
 * };
 * ```
 */
export function useToggleFavorite() {
	const trpcClient = useTRPCClient();
	const invalidator = useQueryInvalidator();

	return useMutation({
		mutationFn: async (input: ToggleFavoriteInput): Promise<void> => {
			await trpcClient.vault.toggleFavorite.mutate({
				itemId: input.itemId,
				favorite: input.favorite,
			});
		},
		onSuccess: async (_data, variables) => {
			await invalidator.invalidateItem(variables.itemId, variables.vaultId);
		},
	});
}
