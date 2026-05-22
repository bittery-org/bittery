/**
 * Vault Handlers
 * Handles vault and vault item operations.
 */

import type { DecryptedItem } from "@bittery/shared/types";
import { rpcClient } from "./rpc-client";
import { updateActivity } from "./session-manager";
import type { MessageResponse } from "./types";
import { getDecryptedItemsForCurrentMode } from "./vault-utils";

async function getAllDecryptedItems(): Promise<Array<DecryptedItem | null>> {
	return getDecryptedItemsForCurrentMode();
}

/**
 * Handle GET_VAULT_ITEMS message - Get all vault items
 */
export async function handleGetVaultItems(): Promise<MessageResponse> {
	updateActivity();

	const items = await getAllDecryptedItems();
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
	const items = await getAllDecryptedItems();
	const item = items.find((candidate) => candidate?.id === itemId) ?? null;
	return { success: true, item };
}

/**
 * Handle GET_WRITABLE_VAULTS message - Get vaults the user can write to
 */
export async function handleGetWritableVaults(): Promise<MessageResponse> {
	updateActivity();

	try {
		const vaults = await rpcClient.vault.list.query();
		const writableVaults = vaults.filter((vault) => vault.role !== "read-only");

		return {
			success: true,
			vaults: writableVaults.map((vault) => ({
				id: vault.id,
				name: vault.name,
				type: vault.vaultType,
				role: vault.role,
			})),
		};
	} catch (error) {
		console.error("[vault-handlers] GET_WRITABLE_VAULTS failed:", error);
		return { success: false, error: String(error) };
	}
}
