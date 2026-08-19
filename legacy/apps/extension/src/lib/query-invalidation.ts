import type { IQueryInvalidator } from "@bittery/sync";
import type { QueryClient } from "@tanstack/react-query";

/**
 * Query invalidation utilities for the extension
 * Implements IQueryInvalidator interface for compatibility with shared hooks
 */
export function createExtensionInvalidator(
	queryClient: QueryClient,
): IQueryInvalidator {
	return {
		/**
		 * Invalidate a specific vault item and the items list
		 */
		invalidateItem: async (itemId: string, vaultId: string): Promise<void> => {
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["vault-item"] }),
				queryClient.invalidateQueries({ queryKey: ["vault-item", itemId] }),
				queryClient.invalidateQueries({
					queryKey: ["vault-item-account", itemId],
				}),
				queryClient.invalidateQueries({ queryKey: ["vault-items"] }),
				queryClient.invalidateQueries({ queryKey: ["vault-items", vaultId] }),
				queryClient.invalidateQueries({ queryKey: ["items"] }),
				queryClient.invalidateQueries({ queryKey: ["decrypted-item"] }),
				queryClient.invalidateQueries({ queryKey: ["decrypted-item", itemId] }),
				queryClient.invalidateQueries({
					queryKey: ["decrypted-item-account", itemId],
				}),
			]);
		},

		/**
		 * Invalidate vault list (items in vault) queries
		 */
		invalidateVaultList: async (_vaultId: string): Promise<void> => {
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["vault-items"] }),
				queryClient.invalidateQueries({ queryKey: ["items"] }),
				queryClient.invalidateQueries({ queryKey: ["decrypted-item"] }),
			]);
		},

		/**
		 * Invalidate vault keys cache
		 */
		invalidateVaultKeys: async (): Promise<void> => {
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["vault-keys"] }),
				queryClient.invalidateQueries({ queryKey: ["all-vault-keys"] }),
			]);
		},

		/**
		 * Invalidate deleted items list queries
		 */
		invalidateDeletedItems: async (_vaultId: string): Promise<void> => {
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["deleted-items"] }),
				queryClient.invalidateQueries({ queryKey: ["vault-items"] }),
				queryClient.invalidateQueries({ queryKey: ["items"] }),
			]);
		},

		/**
		 * Invalidate team-related queries
		 */
		invalidateTeam: async (): Promise<void> => {
			await queryClient.invalidateQueries({ queryKey: ["team"] });
		},

		/**
		 * Invalidate team invitations queries
		 */
		invalidateTeamInvitations: async (): Promise<void> => {
			await queryClient.invalidateQueries({ queryKey: ["team-invitations"] });
		},

		/**
		 * Invalidate share-related queries
		 */
		invalidateShare: async (itemId?: string): Promise<void> => {
			if (itemId) {
				await queryClient.invalidateQueries({ queryKey: ["share", itemId] });
			} else {
				await queryClient.invalidateQueries({ queryKey: ["share"] });
			}
		},

		/**
		 * Invalidate vault member queries
		 */
		invalidateVaultMembers: async (vaultId: string): Promise<void> => {
			await queryClient.invalidateQueries({
				queryKey: ["vault-members", vaultId],
			});
		},
	};
}
