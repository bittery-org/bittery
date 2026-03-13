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
	requireRepositoryForVault,
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
			const sourceContext = requireLocalItemMutationContext(core, input.itemId);
			const sourceRepoTargetVault = sourceContext.repo.getVaultById(
				input.targetVaultId,
			);
			const targetAccountHint =
				input.targetAccountEmail ?? sourceRepoTargetVault?.accountEmail;
			const { accountEmail: targetAccountEmail } = requireRepositoryForVault(
				core,
				input.targetVaultId,
				targetAccountHint,
			);

			if (sourceContext.accountEmail !== targetAccountEmail) {
				return core.items.moveItem(
					{
						...input,
						sourceAccountEmail: sourceContext.accountEmail,
						targetAccountEmail,
					},
					defaultClient,
				);
			}

			const resolvedAccounts = await core.accounts.resolveAccounts({
				type: "single",
				email: sourceContext.accountEmail,
			});
			const sourceAccount = resolvedAccounts.accountsInfo.find(
				(account) =>
					account.email.toLowerCase() ===
					sourceContext.accountEmail.toLowerCase(),
			);
			const contextUserId =
				sourceAccount?.userId ??
				sourceContext.item.lastModifiedBy ??
				"unknown-user";

			const encryptedData = await core.items.reEncryptForVault(
				input.decryptedData,
				await sourceContext.repo.decryptVaultKey(input.targetVaultId),
				{
					vaultId: input.targetVaultId,
					entityId: input.itemId,
					entityType: "item",
					version: sourceContext.item.version + 1,
					userId: contextUserId,
				},
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
				_targetAccountEmail: targetAccountEmail,
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
