import type { QueryClient } from "@tanstack/react-query";
import type { SyncEvent, SyncEventType } from "./types";
import { getTypedMetadata } from "./types";

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
	trpc: QueryKeyHelpers;
	event: SyncEvent;
}

/**
 * Options for creating a query invalidator
 */
export interface QueryInvalidatorOptions {
	queryClient: QueryClient;
	trpc: QueryKeyHelpers;
}

/**
 * Get query keys to invalidate based on sync event type
 */
export function getQueryKeysForEvent(
	trpc: QueryKeyHelpers,
	event: SyncEvent,
): unknown[][] {
	const keys: unknown[][] = [];
	const { type, entityId, vaultId } = event;

	switch (type) {
		case "item_created":
			keys.push(trpc.vault.listAllItems.queryKey());
			// Invalidate unified items queries (for "All Objects" view)
			keys.push(["items"]);
			if (vaultId) {
				keys.push(trpc.vault.listItems.queryKey({ vaultId }));
				// Invalidate useVaultItems queries for this vault (prefix match)
				keys.push(["vault-items", vaultId]);
			}
			// Invalidate all decrypted items (prefix match)
			keys.push(["decrypted-item"]);
			break;

		case "item_updated":
			keys.push(trpc.vault.listAllItems.queryKey());
			// Invalidate unified items queries
			keys.push(["items"]);
			if (vaultId) {
				keys.push(trpc.vault.listItems.queryKey({ vaultId }));
				// Invalidate useVaultItems queries for this vault (prefix match)
				keys.push(["vault-items", vaultId]);
			}
			keys.push(trpc.vault.getItem.queryKey({ itemId: entityId }));
			// Invalidate single item queries (prefix match)
			keys.push(["vault-item", entityId]);
			// Invalidate all decrypted items (prefix match)
			keys.push(["decrypted-item"]);
			break;

		case "item_deleted":
			keys.push(trpc.vault.listAllItems.queryKey());
			keys.push(trpc.vault.listAllDeletedItems.queryKey());
			// Invalidate unified queries
			keys.push(["items"]);
			keys.push(["deleted-items"]);
			if (vaultId) {
				keys.push(trpc.vault.listItems.queryKey({ vaultId }));
				keys.push(trpc.vault.listDeletedItems.queryKey({ vaultId }));
				// Invalidate useVaultItems queries for this vault (prefix match)
				keys.push(["vault-items", vaultId]);
			}
			// Invalidate all decrypted items (prefix match)
			keys.push(["decrypted-item"]);
			break;

		case "item_permanently_deleted":
			keys.push(trpc.vault.listAllItems.queryKey());
			keys.push(trpc.vault.listAllDeletedItems.queryKey());
			keys.push(["items"]);
			keys.push(["deleted-items"]);
			if (vaultId) {
				keys.push(trpc.vault.listItems.queryKey({ vaultId }));
				keys.push(trpc.vault.listDeletedItems.queryKey({ vaultId }));
				keys.push(["vault-items", vaultId]);
			}
			keys.push(trpc.vault.getItem.queryKey({ itemId: entityId }));
			keys.push(["vault-item", entityId]);
			keys.push(["decrypted-item"]);
			break;

		case "item_restored":
			keys.push(trpc.vault.listAllItems.queryKey());
			keys.push(trpc.vault.listAllDeletedItems.queryKey());
			// Invalidate unified queries
			keys.push(["items"]);
			keys.push(["deleted-items"]);
			if (vaultId) {
				keys.push(trpc.vault.listItems.queryKey({ vaultId }));
				keys.push(trpc.vault.listDeletedItems.queryKey({ vaultId }));
				// Invalidate useVaultItems queries for this vault (prefix match)
				keys.push(["vault-items", vaultId]);
			}
			// Invalidate all decrypted items (prefix match)
			keys.push(["decrypted-item"]);
			break;

		case "item_moved": {
			keys.push(trpc.vault.listAllItems.queryKey());
			keys.push(trpc.vault.getItem.queryKey({ itemId: entityId }));
			// Invalidate unified items queries
			keys.push(["items"]);
			// Invalidate single item queries (prefix match)
			keys.push(["vault-item", entityId]);
			// Target vault (vaultId is the target)
			if (vaultId) {
				keys.push(trpc.vault.listItems.queryKey({ vaultId }));
				// Invalidate useVaultItems queries for target vault (prefix match)
				keys.push(["vault-items", vaultId]);
			}
			// Source vault from metadata
			const movedMeta = getTypedMetadata(
				event as SyncEvent & { type: "item_moved" },
			);
			if (movedMeta?.sourceVaultId) {
				const sourceVaultId = movedMeta.sourceVaultId;
				keys.push(trpc.vault.listItems.queryKey({ vaultId: sourceVaultId }));
				// Invalidate useVaultItems queries for source vault (prefix match)
				keys.push(["vault-items", sourceVaultId]);
			}
			// Invalidate all decrypted items (prefix match)
			keys.push(["decrypted-item"]);
			break;
		}

		case "vault_created":
			keys.push(trpc.vault.list.queryKey());
			// Also invalidate vault-keys for the new vault
			keys.push(["vault-keys"]);
			keys.push(["all-vault-keys"]);
			break;

		case "vault_updated":
			keys.push(trpc.vault.get.queryKey({ vaultId: entityId }));
			// Vault metadata (name, icon, image) may have changed
			keys.push(trpc.vault.list.queryKey());
			keys.push(["vault-keys"]);
			keys.push(["all-vault-keys"]);
			break;

		case "vault_deleted":
			keys.push(trpc.vault.list.queryKey());
			keys.push(["vault-keys"]);
			keys.push(["all-vault-keys"]);
			keys.push(trpc.vault.listAllItems.queryKey());
			break;

		case "vault_access_revoked": {
			keys.push(trpc.vault.list.queryKey());
			keys.push(["vault-keys"]);
			keys.push(["all-vault-keys"]);
			keys.push(trpc.vault.listAllItems.queryKey());
			const affectedVaultId = vaultId ?? entityId;
			keys.push(trpc.vault.listItems.queryKey({ vaultId: affectedVaultId }));
			keys.push(
				trpc.vault.listDeletedItems.queryKey({ vaultId: affectedVaultId }),
			);
			keys.push(["vault-items", affectedVaultId]);
			keys.push(["deleted-items"]);
			keys.push(["decrypted-item"]);
			break;
		}

		case "vault_member_added":
		case "vault_member_removed":
			if (vaultId) {
				keys.push(trpc.vault.members.list.queryKey({ vaultId }));
			}
			// Vault keys may have changed
			keys.push(["vault-keys"]);
			keys.push(["all-vault-keys"]);
			break;

		case "vault_key_rotated":
			keys.push(["vault-keys"]);
			keys.push(["all-vault-keys"]);
			if (vaultId) {
				// Items need to be re-decrypted with new key
				keys.push(trpc.vault.listItems.queryKey({ vaultId }));
			}
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
	const keys = getQueryKeysForEvent(ctx.trpc, ctx.event);

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
				trpc: options.trpc,
				event: syntheticEvent,
			});
		},

		/**
		 * Invalidate item-related queries
		 */
		invalidateItem: async (itemId: string, vaultId: string): Promise<void> => {
			const { queryClient, trpc } = options;
			await Promise.all([
				queryClient.invalidateQueries({
					queryKey: trpc.vault.listItems.queryKey({ vaultId }),
				}),
				queryClient.invalidateQueries({
					queryKey: trpc.vault.getItem.queryKey({ itemId }),
				}),
				queryClient.invalidateQueries({
					queryKey: trpc.vault.listAllItems.queryKey(),
				}),
				// Invalidate unified items queries (used by useItems hook)
				queryClient.invalidateQueries({
					queryKey: ["items"],
				}),
				// Invalidate useVaultItems queries for this vault (prefix match)
				queryClient.invalidateQueries({
					queryKey: ["vault-items", vaultId],
				}),
				// Invalidate single item queries (prefix match for both account and non-account versions)
				queryClient.invalidateQueries({
					queryKey: ["vault-item", itemId],
				}),
				queryClient.invalidateQueries({
					queryKey: ["vault-item-account", itemId],
				}),
				// Invalidate decrypted item queries (prefix match)
				queryClient.invalidateQueries({
					queryKey: ["decrypted-item", itemId],
				}),
				queryClient.invalidateQueries({
					queryKey: ["decrypted-item-account", itemId],
				}),
			]);
		},

		/**
		 * Invalidate vault list queries
		 */
		invalidateVaultList: async (vaultId: string): Promise<void> => {
			const { queryClient, trpc } = options;
			await Promise.all([
				queryClient.invalidateQueries({
					queryKey: trpc.vault.listItems.queryKey({ vaultId }),
				}),
				// Invalidate "All Objects" tRPC query
				queryClient.invalidateQueries({
					queryKey: trpc.vault.listAllItems.queryKey(),
				}),
				// Invalidate unified items queries (used by useItems hook)
				queryClient.invalidateQueries({
					queryKey: ["items"],
				}),
				// Invalidate useVaultItems queries for this vault (prefix match)
				queryClient.invalidateQueries({
					queryKey: ["vault-items", vaultId],
				}),
			]);
		},

		/**
		 * Invalidate deleted items list
		 */
		invalidateDeletedItems: async (vaultId: string): Promise<void> => {
			const { queryClient, trpc } = options;
			await Promise.all([
				queryClient.invalidateQueries({
					queryKey: trpc.vault.listDeletedItems.queryKey({ vaultId }),
				}),
				queryClient.invalidateQueries({
					queryKey: trpc.vault.listAllDeletedItems.queryKey(),
				}),
				// Invalidate unified deleted items queries (used by useDeletedItems hook)
				queryClient.invalidateQueries({
					queryKey: ["deleted-items"],
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
				// Also invalidate all-vault-keys (used by useAllVaultKeys hook)
				queryClient.invalidateQueries({ queryKey: ["all-vault-keys"] }),
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
			const { queryClient, trpc } = options;
			await queryClient.invalidateQueries({
				queryKey: trpc.vault.members.list.queryKey({ vaultId }),
			});
		},

		/**
		 * Invalidate all account-related data
		 * Use this when switching accounts to clear all cached data from the previous account
		 */
		invalidateAllAccountData: async (): Promise<void> => {
			const { queryClient, trpc } = options;

			// Remove tRPC API queries entirely to prevent automatic refetch attempts
			// This is important when switching to "All Accounts" mode where there's no auth token
			queryClient.removeQueries({
				queryKey: trpc.vault.list.queryKey(),
			});
			queryClient.removeQueries({
				queryKey: trpc.vault.listAllItems.queryKey(),
			});
			queryClient.removeQueries({
				queryKey: trpc.vault.listAllDeletedItems.queryKey(),
			});

			// Invalidate (not remove) local storage queries - these should refetch from storage
			await Promise.all([
				// Invalidate vault keys
				queryClient.invalidateQueries({ queryKey: ["vault-keys"] }),
				queryClient.invalidateQueries({ queryKey: ["all-vault-keys"] }),

				// NEW: Account-related queries using new structure
				queryClient.invalidateQueries({ queryKey: ["accounts", "active"] }),
				queryClient.invalidateQueries({ queryKey: ["accounts", "info"] }),

				// NEW: Unified items queries (replaces old keys)
				queryClient.invalidateQueries({ queryKey: ["items"] }),
				queryClient.invalidateQueries({
					queryKey: ["deleted-items"],
				}),

				// Keep existing decrypted item caches
				queryClient.invalidateQueries({
					queryKey: ["decrypted-items"],
				}),
				queryClient.invalidateQueries({
					queryKey: ["decrypted-item"],
				}),

				// Keep vault-specific queries
				queryClient.invalidateQueries({
					queryKey: ["vault-items-raw"],
				}),
				queryClient.invalidateQueries({
					queryKey: ["vault-owner"],
				}),

				// Team queries
				queryClient.invalidateQueries({ queryKey: ["team"] }),
			]);

			// OLD KEYS REMOVED (no longer used):
			// - ["accounts", "unlocked"] -> replaced by ["accounts", "info"]
			// - ["accounts", "metadata"] -> replaced by ["accounts", "info"]
			// - ["all-accounts-items"] -> replaced by ["items"]
			// - ["all-decrypted-items"] -> replaced by ["items"]
			// - ["all-deleted-items"] -> replaced by ["deleted-items"]
			// - ["all-accounts-deleted-items"] -> replaced by ["deleted-items"]
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
