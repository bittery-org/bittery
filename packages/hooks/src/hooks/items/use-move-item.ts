/**
 * useMoveItem Hook
 *
 * Moves a vault item to a different vault with re-encryption.
 */

import { useTRPCClient } from "@bittery/shared/trpc";
import type { DecryptedItemData, ItemCategory } from "@bittery/shared/types";
import { useMutation } from "@tanstack/react-query";
import {
	useCoreContext,
	useQueryInvalidator,
} from "../../context/platform-context";
import { useItems } from "../use-items";

/**
 * Input for moving an item to another vault
 */
export interface MoveItemInput {
	itemId: string;
	sourceVaultId: string;
	targetVaultId: string;
	category: ItemCategory;
	decryptedData: DecryptedItemData;
	targetAccountEmail?: string;
}

/**
 * Hook for moving an item to a different vault.
 */
export function useMoveItem() {
	const { items } = useItems();
	const defaultClient = useTRPCClient();
	const core = useCoreContext();
	const invalidator = useQueryInvalidator();

	return useMutation({
		mutationFn: async (input: MoveItemInput) => {
			const sourceAccountEmail = core.accounts.findAccountForItem(
				input.itemId,
				items,
			);

			return core.items.moveItem(
				{
					...input,
					sourceAccountEmail,
				},
				defaultClient,
			);
		},
		onSuccess: async (data, variables) => {
			await core.cache.onItemMoved({
				itemId: variables.itemId,
				sourceVaultId: variables.sourceVaultId,
				targetVaultId: variables.targetVaultId,
				category: variables.category,
				crossAccount: data.crossAccount,
				newItemId: data.newItemId,
				encryptedData: data._encryptedData,
				sourceAccountEmail: data._sourceAccountEmail,
				targetAccountEmail: data._targetAccountEmail,
			});

			await invalidator.invalidateVaultList(variables.sourceVaultId);
			await invalidator.invalidateVaultList(variables.targetVaultId);

			if (data.crossAccount) {
				await invalidator.invalidateDeletedItems(variables.sourceVaultId);
			}

			await invalidator.invalidateVaultKeys();
		},
	});
}
