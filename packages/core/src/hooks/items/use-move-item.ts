/**
 * useMoveItem Hook
 *
 * Moves a vault item to a different vault with re-encryption.
 */

import type { DecryptedItemData, ItemCategory } from "@bittery/shared/types";
import { useMutation } from "@tanstack/react-query";
import {
	refreshRepositoriesFromServer,
	useItemMutationRuntime,
} from "./mutation-utils";

/**
 * Input for moving an item to another vault
 */
export interface MoveItemInput {
	itemId: string;
	sourceVaultId: string;
	targetVaultId: string;
	category: ItemCategory;
	decryptedData: DecryptedItemData;
	targetAccountId?: string;
	targetAccountEmail?: string;
}

/**
 * Hook for moving an item to a different vault.
 */
export function useMoveItem() {
	const { commands, core, invalidator } = useItemMutationRuntime();

	return useMutation({
		mutationFn: (input: MoveItemInput) =>
			commands.execute({ type: "move", ...input }),
		onSuccess: async (data, variables) => {
			if (!data.crossAccount) {
				return;
			}
			await refreshRepositoriesFromServer(core);

			await invalidator.invalidateVaultList(variables.sourceVaultId);
			await invalidator.invalidateVaultList(variables.targetVaultId);

			await invalidator.invalidateDeletedItems(variables.sourceVaultId);

			await invalidator.invalidateVaultKeys();
		},
	});
}
