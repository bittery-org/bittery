/**
 * useToggleFavorite Hook
 *
 * Toggles the favorite status of a vault item.
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
 * Input for toggling favorite status
 */
export interface ToggleFavoriteInput {
	/** ID of the item to toggle */
	itemId: string;
	/** ID of the vault containing the item */
	vaultId: string;
	/** New favorite status */
	favorite: boolean;
}

/**
 * Hook for toggling an item's favorite status.
 *
 * Handles:
 * - Updating favorite status via API
 * - Invalidating relevant queries
 * - Multi-account mode (automatically uses correct account's client)
 *
 * Does NOT handle:
 * - Toast notifications (app responsibility)
 *
 * @example
 * ```tsx
 * const toggleFavorite = useToggleFavorite();
 *
 * const handleToggle = async () => {
 *   try {
 *     await toggleFavorite.mutateAsync({
 *       itemId,
 *       vaultId,
 *       favorite: !currentFavorite,
 *     });
 *     toast.success(newFavorite ? "Added to favorites" : "Removed from favorites");
 *   } catch (error) {
 *     toast.error(error.message);
 *   }
 * };
 * ```
 */
export function useToggleFavorite() {
	const { items } = useItems();
	const defaultClient = useTRPCClient();
	const storage = usePlatformStorage();
	const invalidator = useQueryInvalidator();

	return useMutation({
		mutationFn: async (input: ToggleFavoriteInput): Promise<void> => {
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

			await client.vault.toggleFavorite.mutate({
				itemId: input.itemId,
				favorite: input.favorite,
			});
		},
		onSuccess: async (_data, variables) => {
			await invalidator.invalidateItem(variables.itemId, variables.vaultId);
		},
	});
}
