/**
 * useDeleteItem Hook
 *
 * Soft-deletes a vault item (moves to trash).
 * Returns a React Query mutation - apps handle success/error UI.
 * Automatically handles multi-account mode.
 */

import { useTRPCClient } from "@bittery/shared/trpc";
import { createAccountTrpcClient } from "@bittery/shared/trpc-client-factory";
import { useMutation } from "@tanstack/react-query";
import {
	useQueryInvalidator,
	usePlatformStorage,
} from "../../context/platform-context";
import { useItems } from "../use-items";
import { findAccountEmailForItem } from "../../utils/account-helper";

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
 * - Multi-account mode (automatically uses correct account's client)
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
	const { items } = useItems();
	const defaultClient = useTRPCClient();
	const storage = usePlatformStorage();
	const invalidator = useQueryInvalidator();

	return useMutation({
		mutationFn: async (input: DeleteItemInput): Promise<void> => {
			// Find which account this item belongs to (if in "All Accounts" mode)
			const accountEmail = findAccountEmailForItem(input.itemId, items);

			// Get the correct tRPC client for this account
			let client = defaultClient;
			if (accountEmail) {
				const authToken = await storage.getAuthToken(accountEmail);
				const serverUrl = await storage.getServerUrl(accountEmail);
				if (authToken) {
					client = createAccountTrpcClient(
						authToken,
						serverUrl || "http://localhost:3000",
					);
				}
			}

			await client.vault.deleteItem.mutate({ itemId: input.itemId });
		},
		onSuccess: async (_data, variables) => {
			await invalidator.invalidateVaultList(variables.vaultId);
			await invalidator.invalidateDeletedItems(variables.vaultId);
		},
	});
}
