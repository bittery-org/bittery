/**
 * useToggleFavorite Hook
 *
 * Toggles the favorite status of a vault item.
 */

import { useTRPCClient } from "@bittery/shared/trpc";
import { useMutation } from "@tanstack/react-query";
import {
	useCoreContext,
	useQueryInvalidator,
} from "../../context/platform-context";
import { useItems } from "../use-items";

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
	const { items } = useItems();
	const defaultClient = useTRPCClient();
	const core = useCoreContext();
	const invalidator = useQueryInvalidator();

	return useMutation({
		mutationFn: async (input: ToggleFavoriteInput) => {
			const accountEmail = core.accounts.findAccountForItem(
				input.itemId,
				items,
			);
			return core.items.toggleFavorite(
				input.itemId,
				input.favorite,
				defaultClient,
				accountEmail,
			);
		},
		onSuccess: async (data, variables) => {
			await core.cache.onFavoriteToggled({
				itemId: variables.itemId,
				favorite: variables.favorite,
				accountEmail: data._accountEmail,
			});
			await invalidator.invalidateItem(variables.itemId, variables.vaultId);
		},
	});
}
