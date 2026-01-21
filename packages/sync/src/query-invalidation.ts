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
      if (vaultId) {
        keys.push(trpc.vault.listItems.queryKey({ vaultId }));
      }
      break;

    case "item_updated":
      keys.push(trpc.vault.listAllItems.queryKey());
      if (vaultId) {
        keys.push(trpc.vault.listItems.queryKey({ vaultId }));
      }
      keys.push(trpc.vault.getItem.queryKey({ itemId: entityId }));
      break;

    case "item_deleted":
      keys.push(trpc.vault.listAllItems.queryKey());
      keys.push(trpc.vault.listAllDeletedItems.queryKey());
      if (vaultId) {
        keys.push(trpc.vault.listItems.queryKey({ vaultId }));
        keys.push(trpc.vault.listDeletedItems.queryKey({ vaultId }));
      }
      break;

    case "item_restored":
      keys.push(trpc.vault.listAllItems.queryKey());
      keys.push(trpc.vault.listAllDeletedItems.queryKey());
      if (vaultId) {
        keys.push(trpc.vault.listItems.queryKey({ vaultId }));
        keys.push(trpc.vault.listDeletedItems.queryKey({ vaultId }));
      }
      break;

    case "vault_created":
      keys.push(trpc.vault.list.queryKey());
      // Also invalidate vault-keys for the new vault
      keys.push(["vault-keys"]);
      break;

    case "vault_updated":
      keys.push(trpc.vault.get.queryKey({ vaultId: entityId }));
      break;

    case "vault_deleted":
      keys.push(trpc.vault.list.queryKey());
      keys.push(["vault-keys"]);
      keys.push(trpc.vault.listAllItems.queryKey());
      break;

    case "vault_member_added":
    case "vault_member_removed":
      if (vaultId) {
        keys.push(trpc.vault.members.list.queryKey({ vaultId }));
      }
      // Vault keys may have changed
      keys.push(["vault-keys"]);
      break;

    case "vault_key_rotated":
      keys.push(["vault-keys"]);
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
      ]);
    },

    /**
     * Invalidate vault list queries
     */
    invalidateVaultList: async (vaultId: string): Promise<void> => {
      const { queryClient, trpc } = options;
      await queryClient.invalidateQueries({
        queryKey: trpc.vault.listItems.queryKey({ vaultId }),
      });
    },

    /**
     * Invalidate deleted items list
     */
    invalidateDeletedItems: async (vaultId: string): Promise<void> => {
      const { queryClient, trpc } = options;
      await queryClient.invalidateQueries({
        queryKey: trpc.vault.listDeletedItems.queryKey({ vaultId }),
      });
      await queryClient.invalidateQueries({
        queryKey: trpc.vault.listAllDeletedItems.queryKey(),
      });
    },

    /**
     * Invalidate vault keys
     */
    invalidateVaultKeys: async (): Promise<void> => {
      const { queryClient } = options;
      await queryClient.invalidateQueries({ queryKey: ["vault-keys"] });
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
