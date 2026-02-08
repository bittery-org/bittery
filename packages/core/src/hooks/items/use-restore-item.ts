/**
 * useRestoreItem Hook
 *
 * Restores a soft-deleted vault item from trash.
 */

import { useTRPCClient } from "@bittery/shared/trpc";
import { useMutation } from "@tanstack/react-query";
import {
	useCoreContext,
	useQueryInvalidator,
} from "../../context/platform-context";
import { useDeletedItems } from "../use-deleted-items";

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
	const { items: deletedItems } = useDeletedItems();
	const defaultClient = useTRPCClient();
	const core = useCoreContext();
	const invalidator = useQueryInvalidator();

	return useMutation({
		mutationFn: async (input: RestoreItemInput) => {
			const accountEmail = core.accounts.findAccountForItem(
				input.itemId,
				deletedItems,
			);
			return core.items.restoreItem(input.itemId, defaultClient, accountEmail);
		},
		onSuccess: async (data, variables) => {
			await core.cache.onItemRestored({
				itemId: variables.itemId,
				accountEmail: data._accountEmail,
			});
			await invalidator.invalidateVaultList(variables.vaultId);
			await invalidator.invalidateDeletedItems(variables.vaultId);
		},
	});
}
