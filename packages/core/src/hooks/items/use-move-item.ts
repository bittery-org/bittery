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
	targetAccountId?: string;
	targetAccountEmail?: string;
}

/**
 * Hook for moving an item to a different vault.
 */
export function useMoveItem() {
	const { core, invalidator, queue } = useItemMutationRuntime();

	return useMutation({
		mutationFn: async (input: MoveItemInput) => {
			const sourceContext = requireLocalItemMutationContext(core, input.itemId);
			const sourceRepoTargetVault = sourceContext.repo.getVaultById(
				input.targetVaultId,
			);
			const targetAccountHint =
				input.targetAccountEmail ?? sourceRepoTargetVault?.accountEmail;
			const { accountId: targetAccountId, accountEmail: targetAccountEmail } =
				requireRepositoryForVault(
					core,
					input.targetVaultId,
					input.targetAccountId ?? sourceRepoTargetVault?.accountId,
					targetAccountHint,
				);

			if (sourceContext.accountId !== targetAccountId) {
				const targetItemId = await core.items.generateItemId();
				const encryptedData = await requireRepositoryForVault(
					core,
					input.targetVaultId,
					targetAccountId,
					targetAccountEmail,
				).repo.encryptWithVaultKey(input.targetVaultId, input.decryptedData, {
					itemId: targetItemId,
					version: 1,
				});
				await enqueueItemMutation(queue, sourceContext, {
					type: "cross_account_move",
					entityId: input.itemId,
					vaultId: input.sourceVaultId,
					targetVaultId: input.targetVaultId,
					targetAccountId,
					targetAccountEmail,
					targetItemId,
					category: input.category,
					encryptedPayload: toQueueEncryptedPayload(encryptedData),
				});
				return {
					crossAccount: true,
					newItemId: targetItemId,
					_encryptedData: encryptedData,
					_sourceAccountEmail: sourceContext.accountEmail,
					_targetAccountEmail: targetAccountEmail,
				};
			}

			// Matched on accountId: `accountEmail` falls back to the account id when
			// the sync source supplies no email, so an email match never hits.
			const resolvedAccounts = await core.accounts.resolveAccounts();
			const sourceAccount = resolvedAccounts.accountsInfo.find(
				(account) => account.accountId === sourceContext.accountId,
			);
			if (!sourceAccount) {
				throw new Error("Source account not found");
			}
			const contextUserId = sourceAccount.userId;

			const encryptedData = await sourceContext.repo.encryptWithVaultKey(
				input.targetVaultId,
				input.decryptedData,
				{
					itemId: input.itemId,
					version: sourceContext.item.version + 1,
					userId: contextUserId,
				},
			);
			await enqueueItemMutation(queue, sourceContext, {
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
