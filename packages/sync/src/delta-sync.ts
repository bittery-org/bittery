/**
 * Delta sync: fetch only changed entities and update local cache
 * Extracted for reuse in both React hooks and non-React contexts (e.g., extension service worker)
 */

import type { AppApiClient } from "@bittery/shared/api-client";
import {
	type ServerVaultListEntry,
	type ServerVaultSummary,
	toCachedVaultFields,
	toVaultKeyEntry,
} from "@bittery/shared/vault-mapping";
import type { CachedEncryptedItem, CachedVaultMetadata } from "@bittery/types";
import type { SyncEvent, SyncItemCache } from "./types";

export type DeltaSyncApiClient = Pick<AppApiClient, "items" | "vaults">;

function normalizeVaultSummary(
	vault: Awaited<ReturnType<AppApiClient["vaults"]["get"]>>["data"],
): ServerVaultSummary {
	return {
		...vault,
		icon: vault.icon ?? null,
		imageUrl: vault.imageUrl ?? null,
	};
}

function normalizeVaultListEntry(
	vault: Awaited<ReturnType<AppApiClient["vaults"]["list"]>>["data"][number],
): ServerVaultListEntry {
	return {
		...vault,
		icon: vault.icon ?? null,
		imageUrl: vault.imageUrl ?? null,
	};
}

/**
 * Perform a delta fetch for a single sync event and update the local cache.
 * This function is platform-agnostic and can be used from React hooks or service workers.
 */
export async function performDeltaSync(
	apiClient: DeltaSyncApiClient,
	cache: SyncItemCache,
	event: SyncEvent,
	accountScope: string,
	serverUrl?: string,
	accountEmail?: string | null,
): Promise<void> {
	if (event.type === "travel_mode_updated") {
		return;
	}

	const itemAccountEmail = accountEmail ?? accountScope;

	const upsertItem = (item: CachedEncryptedItem) =>
		cache.upsertCachedItem(item, accountScope);

	const removeItem = (itemId: string) =>
		cache.removeCachedItem(itemId, accountScope);

	const upsertVault = (vault: CachedVaultMetadata) =>
		cache.upsertCachedVault(vault, accountScope);

	const removeVault = (vaultId: string) =>
		cache.removeCachedVault(vaultId, accountScope);

	const syncVaultKeysFromServer = async () => {
		const { data: vaults } = await apiClient.vaults.list();
		await cache.syncVaultKeys(
			vaults.map((vault) => toVaultKeyEntry(normalizeVaultListEntry(vault))),
			accountScope,
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
			const { data: item } = await apiClient.items.get(event.entityId);
			await upsertItem({
				id: item.id,
				vaultId: item.vaultId,
				accountEmail: itemAccountEmail,
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
				attachments: item.attachments ? [...item.attachments] : undefined,
			} as CachedEncryptedItem);
			break;
		}
		case "item_deleted": {
			try {
				const { data: item } = await apiClient.items.get(event.entityId);
				await upsertItem({
					id: item.id,
					vaultId: item.vaultId,
					accountEmail: itemAccountEmail,
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
					attachments: item.attachments ? [...item.attachments] : undefined,
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
				const { data: items } =
					await apiClient.items.listInVault(targetVaultId);

				for (const vaultItem of items) {
					await upsertItem({
						id: vaultItem.id,
						vaultId: vaultItem.vaultId,
						accountEmail: itemAccountEmail,
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
						attachments: vaultItem.attachments
							? [...vaultItem.attachments]
							: undefined,
					} as CachedEncryptedItem);
				}
			}

			const { data: rawVault } = await apiClient.vaults.get(event.entityId);
			const vault = normalizeVaultSummary(rawVault);
			await upsertVault({
				...toCachedVaultFields(vault),
				accountEmail: itemAccountEmail,
				serverUrl,
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
