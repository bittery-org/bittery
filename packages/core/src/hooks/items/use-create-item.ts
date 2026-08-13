/**
 * useCreateItem Hook
 *
 * Creates a new vault item with local-first persistence when sync queue is available.
 */

import type { DecryptedItemData, ItemCategory } from "@bittery/shared/types";
import { useMutation } from "@tanstack/react-query";
import type { CreateItemCommandResult } from "../../services/item-commands";
import { useItemMutationRuntime } from "./mutation-utils";

/**
 * Input for creating a new item
 */
export interface CreateItemInput {
	vaultId: string;
	category: ItemCategory;
	data: DecryptedItemData;
	accountId?: string;
	accountEmail?: string;
}

/**
 * Result from item creation
 */
export type CreateItemResult = CreateItemCommandResult;

/**
 * Hook for creating a new vault item.
 */
export function useCreateItem() {
	const { commands } = useItemMutationRuntime();

	return useMutation({
		mutationFn: (input: CreateItemInput) =>
			commands.execute({
				type: "create",
				...input,
			}),
	});
}
