/**
 * usePermanentDeleteItem Hook
 *
 * Permanently deletes a vault item from trash.
 * Returns a React Query mutation - apps handle success/error UI.
 * Automatically handles multi-account mode.
 */

import { useTRPCClient } from "@bittery/shared/trpc";
import { useMutation } from "@tanstack/react-query";
import {
	usePlatformStorage,
	useQueryInvalidator,
} from "../../context/platform-context";
import {
	findAccountEmailForItem,
	getTRPCClientForAccount,
} from "../../utils/account-helper";
import { useAllDeletedItems } from "../use-all-deleted-items";

/**
 * Input for permanently deleting an item
 */
export interface PermanentDeleteItemInput {
	/** ID of the item to permanently delete */
	itemId: string;
	/** ID of the vault containing the item */
	vaultId: string;
}

/**
 * Hook for permanently deleting an item from trash.
 *
 * This action is irreversible - the item data will be permanently deleted.
 *
 * Handles:
 * - Permanently deleting the item via API
 * - Invalidating deleted items queries
 * - Multi-account mode (automatically uses correct account's client)
 *
 * Does NOT handle:
 * - Toast notifications (app responsibility)
 * - Confirmation dialog (app responsibility - STRONGLY RECOMMENDED)
 *
 * @example
 * ```tsx
 * const permanentDeleteItem = usePermanentDeleteItem();
 *
 * const handlePermanentDelete = async () => {
 *   // IMPORTANT: Show confirmation dialog first!
 *   const confirmed = await showConfirmDialog("Permanently delete this item?");
 *   if (!confirmed) return;
 *
 *   try {
 *     await permanentDeleteItem.mutateAsync({ itemId, vaultId });
 *     toast.success("Item permanently deleted");
 *   } catch (error) {
 *     toast.error(error.message);
 *   }
 * };
 * ```
 */
export function usePermanentDeleteItem() {
	const { items: deletedItems } = useAllDeletedItems();
	const defaultClient = useTRPCClient();
	const storage = usePlatformStorage();
	const invalidator = useQueryInvalidator();

	return useMutation({
		mutationFn: async (
			input: PermanentDeleteItemInput,
		): Promise<{ _accountEmail: string | undefined }> => {
			const accountEmail = findAccountEmailForItem(input.itemId, deletedItems);
			const client = await getTRPCClientForAccount(
				storage,
				defaultClient,
				accountEmail,
			);

			await client.vault.permanentlyDeleteItem.mutate({
				itemId: input.itemId,
			});
			return { _accountEmail: accountEmail };
		},
		onSuccess: async (data, variables) => {
			// Remove from local cache entirely
			if (storage.supportsItemCache) {
				storage.removeCachedItem?.(variables.itemId, data._accountEmail);
			}
			await invalidator.invalidateDeletedItems(variables.vaultId);
		},
	});
}
