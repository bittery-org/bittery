/**
 * usePermanentDeleteItem Hook
 *
 * Permanently deletes a vault item from trash.
 */

import { useTRPCClient } from "@bittery/shared/trpc";
import { useMutation } from "@tanstack/react-query";
import {
	useCoreContext,
	useQueryInvalidator,
} from "../../context/platform-context";
import { useDeletedItems } from "../use-deleted-items";

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
	const { items: deletedItems } = useDeletedItems();
	const defaultClient = useTRPCClient();
	const core = useCoreContext();
	const invalidator = useQueryInvalidator();

	return useMutation({
		mutationFn: async (input: PermanentDeleteItemInput) => {
			const accountEmail = core.accounts.findAccountForItem(
				input.itemId,
				deletedItems,
			);
			return core.items.permanentDeleteItem(
				input.itemId,
				defaultClient,
				accountEmail,
			);
		},
		onSuccess: async (data, variables) => {
			await core.cache.onItemPermanentlyDeleted({
				itemId: variables.itemId,
				accountEmail: data._accountEmail,
			});
			await invalidator.invalidateDeletedItems(variables.vaultId);
		},
	});
}
