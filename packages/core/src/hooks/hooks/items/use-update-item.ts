/**
 * useUpdateItem Hook
 *
 * Updates an existing vault item with encryption.
 */

import { useTRPCClient } from "@bittery/shared/trpc";
import type { DecryptedItemData } from "@bittery/shared/types";
import { useMutation } from "@tanstack/react-query";
import {
	useCoreContext,
	useQueryInvalidator,
} from "../../context/platform-context";
import { useItems } from "../use-items";

/**
 * Input for updating an item
 */
export interface UpdateItemInput {
	itemId: string;
	vaultId: string;
	data: DecryptedItemData;
}

/**
 * Hook for updating a vault item.
 */
export function useUpdateItem() {
	const { items } = useItems();
	const defaultClient = useTRPCClient();
	const core = useCoreContext();
	const invalidator = useQueryInvalidator();

	return useMutation({
		mutationFn: async (input: UpdateItemInput) => {
			const accountEmail = core.accounts.findAccountForItem(
				input.itemId,
				items,
			);
			return core.items.updateItem({ ...input, accountEmail }, defaultClient);
		},
		onSuccess: async (data, variables) => {
			await core.cache.onItemUpdated({
				itemId: variables.itemId,
				encryptedData: data._encryptedData,
				accountEmail: data._accountEmail,
			});
			await invalidator.invalidateItem(variables.itemId, variables.vaultId);
		},
	});
}
