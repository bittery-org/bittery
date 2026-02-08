/**
 * Delta sync: fetch only changed entities and update local cache
 * Extracted for reuse in both React hooks and non-React contexts (e.g., extension service worker)
 */

import type { CachedEncryptedItem, CachedVaultMetadata } from "@bittery/types";
import type { ItemCacheAdapter, SyncEvent } from "./types";

/**
 * Minimal tRPC client interface required for delta sync operations.
 * Both the extension's createTRPCClient<AppRouter> and the desktop's useTRPCClient() satisfy this.
 */
export interface DeltaSyncClient {
	vault: {
		getItem: {
			query: (input: { itemId: string }) => Promise<{
				id: string;
				vaultId: string;
				category: string;
				favorite: boolean;
				encryptedData: string;
				encryptionIv: string;
				encryptionAlgorithm: string;
				version: number;
				lastModifiedBy: string | null;
				createdAt: Date | string;
				updatedAt: Date | string;
				deletedAt: Date | string | null;
			}>;
		};
		get: {
			query: (input: { vaultId: string }) => Promise<{
				id: string;
				name: string;
				type: string;
				icon: string | null;
				imageUrl: string | null;
			}>;
		};
	};
}

/**
 * Perform a delta fetch for a single sync event and update the local cache.
 * This function is platform-agnostic and can be used from React hooks or service workers.
 */
export async function performDeltaSync(
	trpcClient: DeltaSyncClient,
	cache: ItemCacheAdapter,
	event: SyncEvent,
	accountEmail?: string,
): Promise<void> {
	switch (event.type) {
		case "item_created":
		case "item_updated":
		case "item_restored":
		case "item_moved": {
			const item = await trpcClient.vault.getItem.query({
				itemId: event.entityId,
			});
			await cache.upsertCachedItem?.({
				id: item.id,
				vaultId: item.vaultId,
				category: item.category,
				favorite: item.favorite,
				encryptedData: item.encryptedData,
				encryptionIv: item.encryptionIv,
				encryptionAlgorithm: item.encryptionAlgorithm,
				version: item.version,
				lastModifiedBy: item.lastModifiedBy,
				createdAt: String(item.createdAt),
				updatedAt: String(item.updatedAt),
				deletedAt: item.deletedAt ? String(item.deletedAt) : null,
			} as CachedEncryptedItem, accountEmail);
			break;
		}
		case "item_deleted": {
			try {
				const item = await trpcClient.vault.getItem.query({
					itemId: event.entityId,
				});
				await cache.upsertCachedItem?.({
					id: item.id,
					vaultId: item.vaultId,
					category: item.category,
					favorite: item.favorite,
					encryptedData: item.encryptedData,
					encryptionIv: item.encryptionIv,
					encryptionAlgorithm: item.encryptionAlgorithm,
					version: item.version,
					lastModifiedBy: item.lastModifiedBy,
					createdAt: String(item.createdAt),
					updatedAt: String(item.updatedAt),
					deletedAt: item.deletedAt ? String(item.deletedAt) : null,
				} as CachedEncryptedItem, accountEmail);
			} catch {
				// Item might be permanently deleted, remove from cache
				await cache.removeCachedItem?.(event.entityId, accountEmail);
			}
			break;
		}
		case "vault_created":
		case "vault_updated": {
			const vault = await trpcClient.vault.get.query({
				vaultId: event.entityId,
			});
			await cache.upsertCachedVault?.({
				id: vault.id,
				name: vault.name,
				type: vault.type,
				icon: vault.icon,
				imageUrl: vault.imageUrl,
			} as CachedVaultMetadata, accountEmail);
			break;
		}
		case "vault_deleted":
			await cache.removeCachedVault?.(event.entityId, accountEmail);
			break;
		// vault_key_rotated, vault_member_added, vault_member_removed: no cache changes needed
	}
}
