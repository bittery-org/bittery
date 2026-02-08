import type { SyncEvent } from "@bittery/sync";
import type { IQueryInvalidator } from "@bittery/types";

/**
 * Apply extension query invalidation for a background sync event.
 *
 * This mirrors the previous provider behavior exactly so user-visible refresh
 * semantics remain unchanged while centralizing the mapping in one place.
 */
export async function invalidateExtensionQueriesForSyncEvent(
	invalidator: IQueryInvalidator,
	event: SyncEvent,
): Promise<void> {
	switch (event.type) {
		case "item_created":
		case "item_updated":
		case "item_moved":
			if (event.vaultId) {
				await invalidator.invalidateVaultList(event.vaultId);
			}
			if (event.entityId && event.vaultId) {
				await invalidator.invalidateItem(event.entityId, event.vaultId);
			}
			return;

		case "item_deleted":
		case "item_restored":
			if (event.vaultId) {
				await invalidator.invalidateVaultList(event.vaultId);
				await invalidator.invalidateDeletedItems(event.vaultId);
			}
			return;

		case "vault_created":
		case "vault_updated":
		case "vault_deleted":
			await invalidator.invalidateVaultKeys();
			return;

		case "vault_member_added":
		case "vault_member_removed":
			if (event.vaultId) {
				await invalidator.invalidateVaultMembers(event.vaultId);
			}
			await invalidator.invalidateVaultKeys();
			return;

		case "vault_key_rotated":
			await invalidator.invalidateVaultKeys();
			if (event.vaultId) {
				await invalidator.invalidateVaultList(event.vaultId);
			}
			return;
	}
}
