/**
 * Delta sync: fetch only changed entities and update local cache
 * Extracted for reuse in both React hooks and non-React contexts (e.g., extension service worker)
 */

import type {
	CachedAttachment,
	CachedEncryptedItem,
	CachedVaultMetadata,
} from "@bittery/types";
import type { ItemCacheAdapter, SyncEvent } from "./types";

/**
 * Minimal tRPC client interface required for delta sync operations.
 * Both the extension's createTRPCClient<AppRouter> and the desktop's useRPCClient() satisfy this.
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
				attachments?: CachedAttachment[];
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
		listItems: {
			query: (input: { vaultId: string }) => Promise<
				Array<{
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
					attachments?: CachedAttachment[];
				}>
			>;
		};
		list: {
			query: () => Promise<
				Array<{
					id: string;
					name: string;
					type: "personal" | "team";
					icon: string | null;
					imageUrl: string | null;
					encryptedVaultKey: string;
					role: "owner" | "admin" | "member" | "read-only";
				}>
			>;
		};
	};
}

/**
 * Perform a delta fetch for a single sync event and update the local cache.
 * This function is platform-agnostic and can be used from React hooks or service workers.
 */
export async function performDeltaSync(
	rpcClient: DeltaSyncClient,
	cache: ItemCacheAdapter,
	event: SyncEvent,
	accountEmail?: string,
	serverUrl?: string,
): Promise<void> {
	const upsertItem = async (item: CachedEncryptedItem) => {
		if (cache.upsertEncrypted) {
			await cache.upsertEncrypted(item, accountEmail);
			return;
		}
		await cache.upsertCachedItem?.(item, accountEmail);
	};

	const removeItem = async (itemId: string) => {
		if (cache.removeItem) {
			await cache.removeItem(itemId, accountEmail);
			return;
		}
		await cache.removeCachedItem?.(itemId, accountEmail);
	};

	const upsertVault = async (vault: CachedVaultMetadata) => {
		if (cache.upsertVault) {
			await cache.upsertVault(vault, accountEmail);
			return;
		}
		await cache.upsertCachedVault?.(vault, accountEmail);
	};

	const removeVault = async (vaultId: string) => {
		if (cache.removeVault) {
			await cache.removeVault(vaultId, accountEmail);
			return;
		}
		await cache.removeCachedVault?.(vaultId, accountEmail);
	};

	const syncVaultKeysFromServer = async () => {
		if (!cache.syncVaultKeys) {
			return;
		}

		const vaults = await rpcClient.vault.list.query();
		await cache.syncVaultKeys(
			vaults.map((vault) => ({
				vaultId: vault.id,
				vaultName: vault.name,
				vaultType: vault.type,
				vaultIcon: vault.icon,
				vaultImageUrl: vault.imageUrl,
				encryptedVaultKey: vault.encryptedVaultKey,
				role: vault.role,
			})),
			accountEmail,
		);
	};

	if (
		event.type === "vault_created" ||
		event.type === "vault_deleted" ||
		event.type === "vault_access_revoked" ||
		event.type === "vault_member_added" ||
		event.type === "vault_member_removed" ||
		(event.type === "vault_updated" &&
			event.metadata?.reason === "bulk_import") ||
		event.type === "vault_key_rotated"
	) {
		await syncVaultKeysFromServer();
	}

	switch (event.type) {
		case "item_created":
		case "item_updated":
		case "item_restored":
		case "item_moved": {
			const item = await rpcClient.vault.getItem.query({
				itemId: event.entityId,
			});
			await upsertItem({
				id: item.id,
				vaultId: item.vaultId,
				accountEmail,
				serverUrl,
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
				attachments: item.attachments,
			} as CachedEncryptedItem);
			break;
		}
		case "item_deleted": {
			try {
				const item = await rpcClient.vault.getItem.query({
					itemId: event.entityId,
				});
				await upsertItem({
					id: item.id,
					vaultId: item.vaultId,
					accountEmail,
					serverUrl,
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
					attachments: item.attachments,
				} as CachedEncryptedItem);
			} catch {
				// Item might be permanently deleted, remove from cache
				await removeItem(event.entityId);
			}
			break;
		}
		case "item_permanently_deleted":
			await removeItem(event.entityId);
			break;
		case "vault_created":
		case "vault_updated": {
			// Bulk imports emit a vault-level sync event to avoid one SSE event per item.
			// In that case, refresh the vault's items in one query.
			if (
				event.type === "vault_updated" &&
				event.metadata?.reason === "bulk_import"
			) {
				const targetVaultId = event.vaultId ?? event.entityId;
				const items = await rpcClient.vault.listItems.query({
					vaultId: targetVaultId,
				});

				for (const vaultItem of items) {
					await upsertItem({
						id: vaultItem.id,
						vaultId: vaultItem.vaultId,
						accountEmail,
						serverUrl,
						category: vaultItem.category,
						favorite: vaultItem.favorite,
						encryptedData: vaultItem.encryptedData,
						encryptionIv: vaultItem.encryptionIv,
						encryptionAlgorithm: vaultItem.encryptionAlgorithm,
						version: vaultItem.version,
						lastModifiedBy: vaultItem.lastModifiedBy,
						createdAt: String(vaultItem.createdAt),
						updatedAt: String(vaultItem.updatedAt),
						deletedAt: vaultItem.deletedAt ? String(vaultItem.deletedAt) : null,
						attachments: vaultItem.attachments,
					} as CachedEncryptedItem);
				}
			}

			const vault = await rpcClient.vault.get.query({
				vaultId: event.entityId,
			});
			await upsertVault({
				id: vault.id,
				accountEmail,
				serverUrl,
				name: vault.name,
				type: vault.type,
				icon: vault.icon,
				imageUrl: vault.imageUrl,
			} as CachedVaultMetadata);
			break;
		}
		case "vault_deleted":
			await removeVault(event.entityId);
			break;
		case "vault_access_revoked":
			// entityId is the affected vault id
			await removeVault(event.entityId);
			break;
		// vault_key_rotated, vault_member_added, vault_member_removed:
		// vault keys are already refreshed above.
	}
}
