/**
 * Vault Handlers
 * Handles vault and vault item operations.
 */

import { toVaultKeyEntry } from "@bittery/shared/vault-mapping";
import { apiClient } from "./api-client";
import { publishOpenedItemEncryptionContextMigration } from "./outbound-drain";
import { updateActivity } from "./session-manager";
import type { MessageResponse } from "./types";
import { getDecryptedItemsForCurrentMode } from "./vault-utils";

/**
 * Handle GET_VAULT_ITEMS message - Get all vault items
 */
export async function handleGetVaultItems(): Promise<MessageResponse> {
	updateActivity();

	const items = await getDecryptedItemsForCurrentMode();
	return {
		success: true,
		items,
	};
}

/**
 * Handle GET_VAULT_ITEM message - Get a specific vault item
 */
export async function handleGetVaultItem(payload: {
	itemId: string;
}): Promise<MessageResponse> {
	updateActivity();

	const { itemId } = payload;
	const items = await getDecryptedItemsForCurrentMode();
	const item = items.find((candidate) => candidate?.id === itemId) ?? null;
	if (item) {
		await publishOpenedItemEncryptionContextMigration(itemId);
	}
	return { success: true, item };
}

/**
 * Handle GET_WRITABLE_VAULTS message - Get vaults the user can write to
 */
export async function handleGetWritableVaults(): Promise<MessageResponse> {
	updateActivity();

	try {
		const { data: vaultData } = await apiClient.vaults.list();
		const vaults = vaultData.map((vault) =>
			toVaultKeyEntry({
				...vault,
				icon: vault.icon ?? null,
				imageUrl: vault.imageUrl ?? null,
			}),
		);
		const writableVaults = vaults.filter((vault) => vault.role !== "read-only");

		return {
			success: true,
			vaults: writableVaults.map((vault) => ({
				id: vault.vaultId,
				name: vault.vaultName,
				type: vault.vaultType,
				role: vault.role,
			})),
		};
	} catch (error) {
		console.error("[vault-handlers] GET_WRITABLE_VAULTS failed:", error);
		return { success: false, error: String(error) };
	}
}
