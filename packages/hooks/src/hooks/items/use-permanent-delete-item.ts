/**
 * usePermanentDeleteItem Hook
 *
 * Permanently deletes a vault item from trash.
 * Returns a React Query mutation - apps handle success/error UI.
 */

import { useTRPCClient } from "@bittery/shared/trpc";
import { useMutation } from "@tanstack/react-query";
import { useQueryInvalidator } from "../../context/platform-context";

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
	const trpcClient = useTRPCClient();
	const invalidator = useQueryInvalidator();

	return useMutation({
		mutationFn: async (input: PermanentDeleteItemInput): Promise<void> => {
			await trpcClient.vault.permanentlyDeleteItem.mutate({
				itemId: input.itemId,
			});
		},
		onSuccess: async (_data, variables) => {
			await invalidator.invalidateDeletedItems(variables.vaultId);
		},
	});
}
