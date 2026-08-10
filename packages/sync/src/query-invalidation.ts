import type { QueryClient } from "@tanstack/react-query";
import type { SyncEvent, SyncEventType } from "./types";

export const syncApiQueryKeys = {
	travelMode: ["api", "v1", "travel-mode"] as unknown[],
	vaults: {
		list: ["api", "v1", "vaults"] as unknown[],
		members: (vaultId: string) =>
			["api", "v1", "vaults", vaultId, "members"] as unknown[],
	},
	items: {
		all: ["api", "v1", "items"] as unknown[],
		get: (itemId: string) => ["api", "v1", "items", itemId] as unknown[],
		inVault: (vaultId: string) =>
			["api", "v1", "vaults", vaultId, "items"] as unknown[],
		trashed: ["api", "v1", "trashed-items"] as unknown[],
		trashedInVault: (vaultId: string) =>
			["api", "v1", "vaults", vaultId, "trashed-items"] as unknown[],
	},
};

/**
 * Invalidation context for a sync event
 */
export interface InvalidationContext {
	queryClient: QueryClient;
	event: SyncEvent;
}

/**
 * Options for creating a query invalidator
 */
export interface QueryInvalidatorOptions {
	queryClient: QueryClient;
}

/**
 * Get query keys to invalidate based on sync event type
 */
export function getQueryKeysForEvent(event: SyncEvent): unknown[][] {
	const keys: unknown[][] = [];
	const { type, vaultId } = event;

	switch (type) {
		case "item_created":
		case "item_updated":
		case "item_deleted":
		case "item_permanently_deleted":
		case "item_restored":
		case "item_moved":
			// Item data is local-first and updated through VaultRepository.
			break;

		case "vault_created":
			keys.push(["vault-keys"]);
			keys.push(syncApiQueryKeys.vaults.list);
			break;

		case "vault_updated":
			keys.push(["vault-keys"]);
			keys.push(syncApiQueryKeys.vaults.list);
			if (event.metadata?.reason === "bulk_import" && vaultId) {
				keys.push(syncApiQueryKeys.items.inVault(vaultId));
				keys.push(syncApiQueryKeys.items.all);
			}
			break;

		case "vault_deleted":
			keys.push(["vault-keys"]);
			keys.push(syncApiQueryKeys.vaults.list);
			break;

		case "vault_access_revoked": {
			keys.push(["vault-keys"]);
			keys.push(syncApiQueryKeys.vaults.list);
			break;
		}

		case "vault_member_added":
		case "vault_member_removed":
			if (vaultId) {
				keys.push(syncApiQueryKeys.vaults.members(vaultId));
			}
			keys.push(["vault-keys"]);
			keys.push(syncApiQueryKeys.vaults.list);
			break;

		case "vault_key_rotated":
			keys.push(["vault-keys"]);
			keys.push(syncApiQueryKeys.vaults.list);
			break;

		case "travel_mode_updated":
			keys.push(["travel-mode"]);
			keys.push(["all-vault-keys"]);
			keys.push(syncApiQueryKeys.travelMode);
			keys.push(syncApiQueryKeys.vaults.list);
			break;
	}

	return keys;
}

/**
 * Invalidate queries based on sync event
 */
export async function invalidateQueriesForEvent(
	ctx: InvalidationContext,
): Promise<void> {
	const keys = getQueryKeysForEvent(ctx.event);

	await Promise.all(
		keys.map((queryKey) => ctx.queryClient.invalidateQueries({ queryKey })),
	);
}

/**
 * Create a query invalidator function for use with mutations
 * This allows mutations to use the same invalidation logic as sync events
 */
export function createQueryInvalidator(options: QueryInvalidatorOptions) {
	return {
		/**
		 * Invalidate queries as if a sync event was received
		 */
		invalidateForEvent: async (
			type: SyncEventType,
			entityId: string,
			vaultId?: string | null,
		): Promise<void> => {
			const syntheticEvent: SyncEvent = {
				id: `local_${Date.now()}`,
				type,
				entityId,
				entityType: getEntityTypeForEventType(type),
				vaultId: vaultId ?? null,
				version: 0,
				clientId: null,
				userId: "",
				timestamp: Date.now(),
			};

			await invalidateQueriesForEvent({
				queryClient: options.queryClient,
				event: syntheticEvent,
			});
		},

		/**
		 * Invalidate item-related queries
		 */
		invalidateItem: async (itemId: string, vaultId: string): Promise<void> => {
			const { queryClient } = options;
			await Promise.all([
				queryClient.invalidateQueries({
					queryKey: syncApiQueryKeys.items.inVault(vaultId),
				}),
				queryClient.invalidateQueries({
					queryKey: syncApiQueryKeys.items.get(itemId),
				}),
				queryClient.invalidateQueries({
					queryKey: syncApiQueryKeys.items.all,
				}),
			]);
		},

		/**
		 * Invalidate vault list queries
		 */
		invalidateVaultList: async (vaultId: string): Promise<void> => {
			const { queryClient } = options;
			await Promise.all([
				queryClient.invalidateQueries({
					queryKey: syncApiQueryKeys.items.inVault(vaultId),
				}),
				// The aggregate item view has its own cache entry outside a vault page.
				queryClient.invalidateQueries({
					queryKey: syncApiQueryKeys.items.all,
				}),
			]);
		},

		/**
		 * Invalidate deleted items list
		 */
		invalidateDeletedItems: async (vaultId: string): Promise<void> => {
			const { queryClient } = options;
			await Promise.all([
				queryClient.invalidateQueries({
					queryKey: syncApiQueryKeys.items.trashedInVault(vaultId),
				}),
				queryClient.invalidateQueries({
					queryKey: syncApiQueryKeys.items.trashed,
				}),
			]);
		},

		/**
		 * Invalidate vault keys
		 */
		invalidateVaultKeys: async (): Promise<void> => {
			const { queryClient } = options;
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["vault-keys"] }),
				queryClient.invalidateQueries({
					queryKey: syncApiQueryKeys.vaults.list,
				}),
			]);
		},

		/**
		 * Invalidate team-related queries
		 */
		invalidateTeam: async (): Promise<void> => {
			const { queryClient } = options;
			await queryClient.invalidateQueries({ queryKey: ["team"] });
		},

		/**
		 * Invalidate team invitations
		 */
		invalidateTeamInvitations: async (): Promise<void> => {
			const { queryClient } = options;
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["team"] }),
				queryClient.invalidateQueries({ queryKey: ["team", "invitations"] }),
			]);
		},

		/**
		 * Invalidate share-related queries
		 */
		invalidateShare: async (itemId?: string): Promise<void> => {
			const { queryClient } = options;
			if (itemId) {
				await queryClient.invalidateQueries({
					queryKey: ["share", "listByItem"],
				});
			} else {
				await queryClient.invalidateQueries({ queryKey: ["share"] });
			}
		},

		/**
		 * Invalidate vault member queries
		 */
		invalidateVaultMembers: async (vaultId: string): Promise<void> => {
			const { queryClient } = options;
			await queryClient.invalidateQueries({
				queryKey: syncApiQueryKeys.vaults.members(vaultId),
			});
		},

		/**
		 * Invalidate all account-related data
		 * Use this when switching accounts to clear all cached data from the previous account
		 */
		invalidateAllAccountData: async (): Promise<void> => {
			const { queryClient } = options;

			// Removing remote API queries prevents refetch without an account token.
			// This is important when switching to "All Accounts" mode where there's no auth token
			queryClient.removeQueries({
				queryKey: syncApiQueryKeys.vaults.list,
			});
			queryClient.removeQueries({
				queryKey: syncApiQueryKeys.items.all,
			});
			queryClient.removeQueries({
				queryKey: syncApiQueryKeys.items.trashed,
			});

			// Invalidate (not remove) local storage queries - these should refetch from storage
			await Promise.all([
				// Invalidate vault keys
				queryClient.invalidateQueries({ queryKey: ["vault-keys"] }),

				// NEW: Account-related queries using new structure
				queryClient.invalidateQueries({ queryKey: ["accounts", "active"] }),
				queryClient.invalidateQueries({ queryKey: ["accounts", "info"] }),

				// Team queries
				queryClient.invalidateQueries({ queryKey: ["team"] }),
			]);
		},
	};
}

/**
 * Get entity type from event type
 */
function getEntityTypeForEventType(
	type: SyncEventType,
): "item" | "vault" | "vault_member" | "vault_key" | "user" {
	if (type.startsWith("item_")) {
		return "item";
	}
	if (type.startsWith("vault_member_")) {
		return "vault_member";
	}
	if (type === "vault_key_rotated") {
		return "vault_key";
	}
	if (type === "travel_mode_updated") {
		return "user";
	}
	return "vault";
}

export type QueryInvalidator = ReturnType<typeof createQueryInvalidator>;
