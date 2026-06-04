import type { QueryClient } from "@tanstack/react-query";
import type { SyncEvent, SyncEventType } from "./types";

/**
 * tRPC-like interface for generating query keys
 * This allows the sync package to be decoupled from the specific tRPC implementation
 */
export interface QueryKeyHelpers {
	vault: {
		listItems: { queryKey: (input: { vaultId: string }) => unknown[] };
		listAllItems: { queryKey: () => unknown[] };
		getItem: { queryKey: (input: { itemId: string }) => unknown[] };
		get: { queryKey: (input: { vaultId: string }) => unknown[] };
		list: { queryKey: () => unknown[] };
		listAllDeletedItems: { queryKey: () => unknown[] };
		listDeletedItems: { queryKey: (input: { vaultId: string }) => unknown[] };
		members: {
			list: { queryKey: (input: { vaultId: string }) => unknown[] };
		};
	};
}

/**
 * Invalidation context for a sync event
 */
export interface InvalidationContext {
	queryClient: QueryClient;
	rpc: QueryKeyHelpers;
	event: SyncEvent;
}

/**
 * Options for creating a query invalidator
 */
export interface QueryInvalidatorOptions {
	queryClient: QueryClient;
	rpc: QueryKeyHelpers;
}

/**
 * Get query keys to invalidate based on sync event type
 */
export function getQueryKeysForEvent(
	rpc: QueryKeyHelpers,
	event: SyncEvent,
): unknown[][] {
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
			keys.push(rpc.vault.list.queryKey());
			break;

		case "vault_updated":
			keys.push(["vault-keys"]);
			keys.push(rpc.vault.list.queryKey());
			if (event.metadata?.reason === "bulk_import" && vaultId) {
				keys.push(rpc.vault.listItems.queryKey({ vaultId }));
				keys.push(rpc.vault.listAllItems.queryKey());
			}
			break;

		case "vault_deleted":
			keys.push(["vault-keys"]);
			keys.push(rpc.vault.list.queryKey());
			break;

		case "vault_access_revoked": {
			keys.push(["vault-keys"]);
			keys.push(rpc.vault.list.queryKey());
			break;
		}

		case "vault_member_added":
		case "vault_member_removed":
			if (vaultId) {
				keys.push(rpc.vault.members.list.queryKey({ vaultId }));
			}
			keys.push(["vault-keys"]);
			keys.push(rpc.vault.list.queryKey());
			break;

		case "vault_key_rotated":
			keys.push(["vault-keys"]);
			keys.push(rpc.vault.list.queryKey());
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
	const keys = getQueryKeysForEvent(ctx.rpc, ctx.event);

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
				rpc: options.rpc,
				event: syntheticEvent,
			});
		},

		/**
		 * Invalidate item-related queries
		 */
		invalidateItem: async (itemId: string, vaultId: string): Promise<void> => {
			const { queryClient, rpc } = options;
			await Promise.all([
				queryClient.invalidateQueries({
					queryKey: rpc.vault.listItems.queryKey({ vaultId }),
				}),
				queryClient.invalidateQueries({
					queryKey: rpc.vault.getItem.queryKey({ itemId }),
				}),
				queryClient.invalidateQueries({
					queryKey: rpc.vault.listAllItems.queryKey(),
				}),
			]);
		},

		/**
		 * Invalidate vault list queries
		 */
		invalidateVaultList: async (vaultId: string): Promise<void> => {
			const { queryClient, rpc } = options;
			await Promise.all([
				queryClient.invalidateQueries({
					queryKey: rpc.vault.listItems.queryKey({ vaultId }),
				}),
				// Invalidate "All Objects" tRPC query
				queryClient.invalidateQueries({
					queryKey: rpc.vault.listAllItems.queryKey(),
				}),
			]);
		},

		/**
		 * Invalidate deleted items list
		 */
		invalidateDeletedItems: async (vaultId: string): Promise<void> => {
			const { queryClient, rpc } = options;
			await Promise.all([
				queryClient.invalidateQueries({
					queryKey: rpc.vault.listDeletedItems.queryKey({ vaultId }),
				}),
				queryClient.invalidateQueries({
					queryKey: rpc.vault.listAllDeletedItems.queryKey(),
				}),
			]);
		},

		/**
		 * Invalidate vault keys
		 */
		invalidateVaultKeys: async (): Promise<void> => {
			const { queryClient, rpc } = options;
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["vault-keys"] }),
				queryClient.invalidateQueries({
					queryKey: rpc.vault.list.queryKey(),
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
			const { queryClient, rpc } = options;
			await queryClient.invalidateQueries({
				queryKey: rpc.vault.members.list.queryKey({ vaultId }),
			});
		},

		/**
		 * Invalidate all account-related data
		 * Use this when switching accounts to clear all cached data from the previous account
		 */
		invalidateAllAccountData: async (): Promise<void> => {
			const { queryClient, rpc } = options;

			// Remove tRPC API queries entirely to prevent automatic refetch attempts
			// This is important when switching to "All Accounts" mode where there's no auth token
			queryClient.removeQueries({
				queryKey: rpc.vault.list.queryKey(),
			});
			queryClient.removeQueries({
				queryKey: rpc.vault.listAllItems.queryKey(),
			});
			queryClient.removeQueries({
				queryKey: rpc.vault.listAllDeletedItems.queryKey(),
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
): "item" | "vault" | "vault_member" | "vault_key" {
	if (type.startsWith("item_")) {
		return "item";
	}
	if (type.startsWith("vault_member_")) {
		return "vault_member";
	}
	if (type === "vault_key_rotated") {
		return "vault_key";
	}
	return "vault";
}

export type QueryInvalidator = ReturnType<typeof createQueryInvalidator>;
