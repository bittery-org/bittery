/**
 * useCreateItem Hook
 *
 * Creates a new vault item with local-first persistence when sync queue is available.
 */

import type { DecryptedItemData, ItemCategory } from "@bittery/shared/types";
import { useMutation } from "@tanstack/react-query";
import {
	enqueueItemMutation,
	requireRepositoryForVault,
	toQueueEncryptedPayload,
	useItemMutationRuntime,
} from "./mutation-utils";

/**
 * Input for creating a new item
 */
export interface CreateItemInput {
	vaultId: string;
	category: ItemCategory;
	data: DecryptedItemData;
	accountEmail?: string;
}

/**
 * Result from item creation
 */
export interface CreateItemResult {
	itemId: string;
	_encryptedData?: {
		ciphertext: string;
		iv: string;
		algorithm: string;
	};
	_accountEmail?: string;
}

/**
 * Hook for creating a new vault item.
 */
export function useCreateItem() {
	const { core, queue } = useItemMutationRuntime();

	return useMutation({
		mutationFn: async (input: CreateItemInput): Promise<CreateItemResult> => {
			const { accountEmail, repo } = requireRepositoryForVault(
				core,
				input.vaultId,
				input.accountEmail,
			);
			const localItemId = await core.items.generateItemId();
			const encryptedData = await repo.encryptWithVaultKey(
				input.vaultId,
				input.data,
				{ itemId: localItemId, version: 1 },
			);
			const now = new Date().toISOString();

			await repo.upsertLocal(
				{
					id: localItemId,
					vaultId: input.vaultId,
					category: input.category,
					favorite: false,
					createdAt: now,
					updatedAt: now,
					...input.data,
				},
				encryptedData,
			);

			enqueueItemMutation(
				queue,
				{
					accountEmail,
					baseVersion: 0,
				},
				{
					type: "create",
					entityId: localItemId,
					vaultId: input.vaultId,
					category: input.category,
					encryptedPayload: toQueueEncryptedPayload(encryptedData),
				},
			);

			return {
				itemId: localItemId,
				_encryptedData: encryptedData,
				_accountEmail: accountEmail,
			};
		},
	});
}
