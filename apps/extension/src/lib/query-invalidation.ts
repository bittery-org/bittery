import type { IQueryInvalidator } from "@bittery/types";
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
		invalidateItem: async (
			_itemId: string,
			_vaultId: string,
		): Promise<void> => {
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["vault-item"] }),
				queryClient.invalidateQueries({ queryKey: ["vault-items"] }),
				queryClient.invalidateQueries({ queryKey: ["items"] }),
			]);
		},

		/**
		 * Invalidate vault list (items in vault) queries
		 */
		invalidateVaultList: async (_vaultId: string): Promise<void> => {
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["vault-items"] }),
				queryClient.invalidateQueries({ queryKey: ["items"] }),
			]);
		},

		/**
		 * Invalidate vault keys cache
		 */
		invalidateVaultKeys: async (): Promise<void> => {
			await queryClient.invalidateQueries({ queryKey: ["vault-keys"] });
		},

		/**
		 * Invalidate deleted items list queries
		 */
		invalidateDeletedItems: async (_vaultId: string): Promise<void> => {
			await queryClient.invalidateQueries({ queryKey: ["deleted-items"] });
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
