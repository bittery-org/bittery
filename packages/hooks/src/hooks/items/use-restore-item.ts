/**
 * useRestoreItem Hook
 *
 * Restores a soft-deleted vault item from trash.
 * Returns a React Query mutation - apps handle success/error UI.
 * Automatically handles multi-account mode.
 */

import { useTRPCClient } from "@bittery/shared/trpc";
import { createAccountTrpcClient } from "@bittery/shared/trpc-client-factory";
import { useMutation } from "@tanstack/react-query";
import {
	usePlatformStorage,
	useQueryInvalidator,
} from "../../context/platform-context";
import { findAccountEmailForItem } from "../../utils/account-helper";
import { useAllDeletedItems } from "../use-all-deleted-items";

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
 * - Multi-account mode (automatically uses correct account's client)
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
	const { items: deletedItems } = useAllDeletedItems();
	const defaultClient = useTRPCClient();
	const storage = usePlatformStorage();
	const invalidator = useQueryInvalidator();

	return useMutation({
		mutationFn: async (input: RestoreItemInput): Promise<void> => {
			// Find which account this item belongs to (if in "All Accounts" mode)
			const accountEmail = findAccountEmailForItem(input.itemId, deletedItems);

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

			await client.vault.restoreItem.mutate({ itemId: input.itemId });
		},
		onSuccess: async (_data, variables) => {
			await invalidator.invalidateVaultList(variables.vaultId);
			await invalidator.invalidateDeletedItems(variables.vaultId);
		},
	});
}
