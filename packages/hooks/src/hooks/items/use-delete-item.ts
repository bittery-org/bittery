/**
 * useDeleteItem Hook
 *
 * Soft-deletes a vault item (moves to trash).
 * Returns a React Query mutation - apps handle success/error UI.
 */

import { useTRPCClient } from "@bittery/shared/trpc";
import { useMutation } from "@tanstack/react-query";
import { useQueryInvalidator } from "../../context/platform-context";

/**
 * Input for deleting an item
 */
export interface DeleteItemInput {
	/** ID of the item to delete */
	itemId: string;
	/** ID of the vault containing the item */
	vaultId: string;
}

/**
 * Hook for soft-deleting a vault item.
 *
 * Soft delete moves the item to trash where it can be restored or permanently deleted.
 *
 * Handles:
 * - Soft-deleting the item via API
 * - Invalidating relevant queries (vault list + deleted items)
 *
 * Does NOT handle:
 * - Toast notifications (app responsibility)
 * - Navigation after deletion (app responsibility)
 * - Confirmation dialog (app responsibility)
 *
 * @example
 * ```tsx
 * const deleteItem = useDeleteItem();
 *
 * const handleDelete = async () => {
 *   try {
 *     await deleteItem.mutateAsync({ itemId, vaultId });
 *     toast.success("Item moved to trash");
 *     navigate({ to: "/vault/$id", params: { id: vaultId } });
 *   } catch (error) {
 *     toast.error(error.message);
 *   }
 * };
 * ```
 */
export function useDeleteItem() {
	const trpcClient = useTRPCClient();
	const invalidator = useQueryInvalidator();

	return useMutation({
		mutationFn: async (input: DeleteItemInput): Promise<void> => {
			await trpcClient.vault.deleteItem.mutate({ itemId: input.itemId });
		},
		onSuccess: async (_data, variables) => {
			await invalidator.invalidateVaultList(variables.vaultId);
			await invalidator.invalidateDeletedItems(variables.vaultId);
		},
	});
}
