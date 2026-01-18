/**
 * Vault Handlers
 * Handles vault and vault item operations
 */

import { chromeStorage, decrypt } from "@bittery/crypto";
import { updateActivity } from "./session-manager";
import { trpcClient } from "./trpc-client";
import type { MessageResponse } from "./types";

/**
 * Helper function to decrypt all vault items
 */
async function decryptVaultItems() {
	const vaultKeys = await chromeStorage.getVaultKeys();

	if (!vaultKeys || vaultKeys.length === 0) {
		return [];
	}

	const vaults = await trpcClient.vault.list.query();

	const decryptedVaultKeys: Record<string, Uint8Array> = {};

	await Promise.all(
		vaultKeys.map(async (vk) => {
			decryptedVaultKeys[vk.vaultId] = await chromeStorage.decryptVaultKey(
				vk.encryptedVaultKey,
			);
		}),
	);

	const allVaultItems = await Promise.all(
		vaults.map(async (vault) => {
			try {
				const decryptedItems = await Promise.all(
					vault.items.map(async (item) => {
						try {
							const vaultKey = decryptedVaultKeys[vault.id];
							if (!vaultKey) throw new Error("Vault key not found");

							const decrypted = await decrypt(
								{
									algorithm: item.encryptionAlgorithm,
									iv: item.encryptionIv,
									ciphertext: item.encryptedData,
								},
								vaultKey,
							);

							const data = JSON.parse(decrypted);
							return { ...item, ...data };
						} catch (error) {
							console.error("Failed to decrypt item:", item.id, error);
							return null;
						}
					}),
				);

				return decryptedItems.filter((item) => item !== null);
			} catch (_error) {
				console.log(_error);
				return [];
			}
		}),
	);

	// Flatten the array of arrays
	return allVaultItems.flat();
}

/**
 * Handle GET_VAULT_ITEMS message - Get all vault items
 */
export async function handleGetVaultItems(): Promise<MessageResponse> {
	updateActivity();

	const items = await decryptVaultItems();

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

	// Get vault keys
	const vaultKeys = await chromeStorage.getVaultKeys();
	if (!vaultKeys || vaultKeys.length === 0) {
		return { success: true, item: null };
	}

	// Get item
	const item = await trpcClient.vault.getItem.query({ itemId });

	if (!item) {
		return { success: true, item: null };
	}

	// Find vault key for this item
	const vaultKeyData = vaultKeys.find((vk) => vk.vaultId === item.vaultId);
	if (!vaultKeyData) {
		return { success: true, item: null };
	}

	// Decrypt item
	const vaultKey = await chromeStorage.decryptVaultKey(
		vaultKeyData.encryptedVaultKey,
	);

	const decrypted = await decrypt(
		{
			algorithm: item.encryptionAlgorithm,
			iv: item.encryptionIv,
			ciphertext: item.encryptedData,
		},
		vaultKey,
	);

	const data = JSON.parse(decrypted);

	return { success: true, item: { ...item, ...data } };
}

/**
 * Handle GET_WRITABLE_VAULTS message - Get vaults the user can write to
 */
export async function handleGetWritableVaults(): Promise<MessageResponse> {
	updateActivity();

	// Fetch all vaults
	const vaults = await trpcClient.vault.list.query();

	// Filter out read-only vaults (only return vaults user can write to)
	const writableVaults = vaults.filter((vault) => vault.role !== "read-only");

	return {
		success: true,
		vaults: writableVaults.map((v) => ({
			id: v.id,
			name: v.name,
			type: v.type,
			role: v.role,
		})),
	};
}
