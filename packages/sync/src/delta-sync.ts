/**
 * Delta sync: fetch only changed entities and update local cache
 * Extracted for reuse in both React hooks and non-React contexts (e.g., extension service worker)
 */

import {
	type AppApiClient,
	isApiErrorStatus,
} from "@bittery/shared/api-client";
import { toCachedItem } from "@bittery/shared/item-mapping";
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

	const reconcileCurrentItem = async (itemId: string) => {
		try {
			const { data: item } = await apiClient.items.get(itemId);
			await upsertItem(
				toCachedItem(item, { accountEmail: itemAccountEmail, serverUrl }),
			);
		} catch (error) {
			if (!isApiErrorStatus(error, 404)) throw error;
			await removeItem(itemId);
		}
	};

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
			await reconcileCurrentItem(event.entityId);
			break;
		}
		case "item_deleted": {
			await reconcileCurrentItem(event.entityId);
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
					await upsertItem(
						toCachedItem(vaultItem, {
							accountEmail: itemAccountEmail,
							serverUrl,
						}),
					);
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
		case "vault_key_rotated": {
			const targetVaultId = event.vaultId ?? event.entityId;
			const { data: items } = await apiClient.items.listInVault(targetVaultId);
			for (const vaultItem of items) {
				await upsertItem(
					toCachedItem(vaultItem, {
						accountEmail: itemAccountEmail,
						serverUrl,
					}),
				);
			}
			break;
		}
		case "vault_access_revoked":
			// The Vault ID lets the client evict data it can no longer read.
			await removeVault(event.entityId);
			break;
		// vault_member_added, vault_member_removed:
		// vault keys are already refreshed above.
	}
}
