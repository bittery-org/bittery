/**
 * useDeleteItem Hook
 *
 * Soft-deletes a vault item (moves to trash).
 */

import { useTRPCClient } from "@bittery/shared/trpc";
import { useMutation } from "@tanstack/react-query";
import {
	useCoreContext,
	useQueryInvalidator,
} from "../../context/platform-context";
import { useItems } from "../use-items";

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
	const { items } = useItems();
	const defaultClient = useTRPCClient();
	const core = useCoreContext();
	const invalidator = useQueryInvalidator();

	return useMutation({
		mutationFn: async (input: DeleteItemInput) => {
			const accountEmail = core.accounts.findAccountForItem(
				input.itemId,
				items,
			);
			return core.items.deleteItem(input.itemId, defaultClient, accountEmail);
		},
		onSuccess: async (data, variables) => {
			await core.cache.onItemDeleted({
				itemId: variables.itemId,
				accountEmail: data._accountEmail,
			});
			await invalidator.invalidateVaultList(variables.vaultId);
			await invalidator.invalidateDeletedItems(variables.vaultId);
		},
	});
}
