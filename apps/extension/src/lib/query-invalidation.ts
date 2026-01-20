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
	};
}

export type ExtensionInvalidator = ReturnType<typeof createExtensionInvalidator>;
