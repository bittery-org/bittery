import type { QueryClient } from "@tanstack/react-query";

/**
 * Simple query invalidation utilities for the extension
 * This mirrors the sync package's invalidator API for consistency
 */
export function createExtensionInvalidator(queryClient: QueryClient) {
	return {
		/**
		 * Invalidate a specific vault item and the items list
		 */
		invalidateItem: async (itemId: string): Promise<void> => {
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["vault-item", itemId] }),
				queryClient.invalidateQueries({ queryKey: ["vault-items"] }),
			]);
		},

		/**
		 * Invalidate the vault items list
		 */
		invalidateVaultItems: async (): Promise<void> => {
			await queryClient.invalidateQueries({ queryKey: ["vault-items"] });
		},

		/**
		 * Invalidate all account-related data
		 * Use this when switching accounts to clear all cached data from the previous account
		 */
		invalidateAllAccountData: async (): Promise<void> => {
			await Promise.all([
				// Invalidate vault items
				queryClient.invalidateQueries({ queryKey: ["vault-items"] }),
				queryClient.invalidateQueries({ queryKey: ["vault-item"] }),

				// Invalidate account-related queries
				queryClient.invalidateQueries({ queryKey: ["accounts", "unlocked"] }),
				queryClient.invalidateQueries({ queryKey: ["accounts", "metadata"] }),
				queryClient.invalidateQueries({ queryKey: ["accounts", "active"] }),
			]);
		},
	};
}

export type ExtensionInvalidator = ReturnType<
	typeof createExtensionInvalidator
>;
