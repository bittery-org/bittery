/**
 * useRestoreItem Hook
 *
 * Restores a soft-deleted vault item from trash.
 * Returns a React Query mutation - apps handle success/error UI.
 */

import { useTRPCClient } from "@bittery/shared/trpc";
import { useMutation } from "@tanstack/react-query";
import { useQueryInvalidator } from "../../context/platform-context";

/**
 * Input for restoring an item from trash
 */
export interface RestoreItemInput {
	/** ID of the item to restore */
	itemId: string;
	/** ID of the vault containing the item */
	vaultId: string;
}

/**
 * Hook for restoring a soft-deleted item from trash.
 *
 * Handles:
 * - Restoring the item via API
 * - Invalidating relevant queries (vault list + deleted items)
 *
 * Does NOT handle:
 * - Toast notifications (app responsibility)
 *
 * @example
 * ```tsx
 * const restoreItem = useRestoreItem();
 *
 * const handleRestore = async () => {
 *   try {
 *     await restoreItem.mutateAsync({ itemId, vaultId });
 *     toast.success("Item restored");
 *   } catch (error) {
 *     toast.error(error.message);
 *   }
 * };
 * ```
 */
export function useRestoreItem() {
	const trpcClient = useTRPCClient();
	const invalidator = useQueryInvalidator();

	return useMutation({
		mutationFn: async (input: RestoreItemInput): Promise<void> => {
			await trpcClient.vault.restoreItem.mutate({ itemId: input.itemId });
		},
		onSuccess: async (_data, variables) => {
			await invalidator.invalidateVaultList(variables.vaultId);
			await invalidator.invalidateDeletedItems(variables.vaultId);
		},
	});
}
