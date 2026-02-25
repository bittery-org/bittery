/**
 * useUpdateItem Hook
 *
 * Updates an existing vault item with local-first persistence when sync queue is available.
 */

import type { DecryptedItemData } from "@bittery/shared/types";
import { useMutation } from "@tanstack/react-query";
import {
	enqueueItemMutation,
	extractDecryptedItemData,
	requireLocalItemMutationContext,
	toQueueEncryptedPayload,
	useItemMutationRuntime,
} from "./mutation-utils";

/**
 * Input for updating an item
 */
export interface UpdateItemInput {
	itemId: string;
	vaultId: string;
	data: Partial<DecryptedItemData>;
}

/**
 * Hook for updating a vault item.
 */
export function useUpdateItem() {
	const { core, queue } = useItemMutationRuntime();

	return useMutation({
		mutationFn: async (input: UpdateItemInput) => {
			const context = requireLocalItemMutationContext(
				core,
				input.itemId,
			);
			const existing = context.item;

			const mergedData = core.items.mergeItemUpdate(
				extractDecryptedItemData(existing),
				input.data,
				existing.category,
			);

			const encrypted = await context.repo.encryptWithVaultKey(
				existing.vaultId,
				mergedData,
			);

			await context.repo.upsertLocal(
				{
					...existing,
					...mergedData,
					updatedAt: new Date().toISOString(),
				},
				encrypted,
			);

			enqueueItemMutation(queue, context, {
				type: "update",
				entityId: input.itemId,
				vaultId: existing.vaultId,
				encryptedPayload: toQueueEncryptedPayload(encrypted),
			});

			return {
				_encryptedData: encrypted,
				_accountEmail: context.accountEmail,
			};
		},
	});
}
