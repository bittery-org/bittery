/**
 * useMoveItem Hook
 *
 * Moves a vault item to a different vault with re-encryption.
 */

import type { DecryptedItemData, ItemCategory } from "@bittery/shared/types";
import { useMutation } from "@tanstack/react-query";
import {
	enqueueItemMutation,
	refreshRepositoriesFromServer,
	requireLocalItemMutationContext,
	toQueueEncryptedPayload,
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
	targetAccountEmail?: string;
}

/**
 * Hook for moving an item to a different vault.
 */
export function useMoveItem() {
	const { core, defaultClient, invalidator, queue } = useItemMutationRuntime();

	return useMutation({
		mutationFn: async (input: MoveItemInput) => {
			const sourceContext = requireLocalItemMutationContext(
				core,
				input.itemId,
			);
			const targetAccount = input.targetAccountEmail
				? {
						email: input.targetAccountEmail,
						repo: core.vaultCoordinator.getRepositoryForEmail(
							input.targetAccountEmail,
						),
					}
				: core.vaultCoordinator.findAccountForVault(input.targetVaultId);

			if (!targetAccount) {
				throw new Error(
					`No account repository found for target vault ${input.targetVaultId}`,
				);
			}

			if (sourceContext.accountEmail !== targetAccount.email) {
				return core.items.moveItem(
					{
						...input,
						sourceAccountEmail: sourceContext.accountEmail,
						targetAccountEmail: targetAccount.email,
					},
					defaultClient,
				);
			}

			const encryptedData = await core.items.reEncryptForVault(
				input.decryptedData,
				await sourceContext.repo.decryptVaultKey(input.targetVaultId),
			);
			await sourceContext.repo.moveItem(
				input.itemId,
				input.targetVaultId,
				encryptedData,
			);

			enqueueItemMutation(queue, sourceContext, {
				type: "move",
				entityId: input.itemId,
				vaultId: input.sourceVaultId,
				targetVaultId: input.targetVaultId,
				encryptedPayload: toQueueEncryptedPayload(encryptedData),
			});

			return {
				crossAccount: false,
				_encryptedData: encryptedData,
				_sourceAccountEmail: sourceContext.accountEmail,
				_targetAccountEmail: targetAccount.email,
			};
		},
		onSuccess: async (data: any, variables) => {
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
