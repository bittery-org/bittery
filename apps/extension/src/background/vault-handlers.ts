/**
 * Vault Handlers
 * Handles vault and vault item operations
 */

import { createAccountTrpcClient } from "@bittery/shared/trpc-client-factory";
import { storage } from "../lib/storage";
import { decrypt } from "../lib/wasm-crypto";
import { updateActivity } from "./session-manager";
import { trpcClient } from "./trpc-client";
import type { MessageResponse } from "./types";
import { desktopSync } from "./desktop-sync";
import { decryptVaultItemsViaDesktop } from "./vault-utils";

/**
 * Helper function to decrypt vault items for a specific account
 */
async function decryptVaultItemsForAccount(
	email: string,
	accountMeta?: { email: string; userId: string; name: string },
) {
	console.log(`[vault-handlers] decryptVaultItemsForAccount - email: ${email}`);
	const vaultKeys = await storage.getVaultKeys(email);
	console.log(
		`[vault-handlers] Vault keys for ${email}:`,
		vaultKeys?.length || 0,
	);

	if (!vaultKeys || vaultKeys.length === 0) {
		console.warn(`[vault-handlers] No vault keys for ${email}`);
		return [];
	}

	// Get auth token for this account
	const authToken = await storage.getAuthToken(email);
	if (!authToken) {
		console.warn(`[vault-handlers] No auth token for ${email}`);
		return [];
	}

	const serverUrl =
		(await storage.getServerUrl(email)) || "http://localhost:3000";
	const accountClient = createAccountTrpcClient(authToken, serverUrl);

	// Fetch vaults for this account
	console.log(
		`[vault-handlers] Fetching vaults for ${email} from ${serverUrl}...`,
	);
	const vaults = await accountClient.vault.list.query();
	console.log(`[vault-handlers] Got ${vaults.length} vaults for ${email}`);

	const decryptedVaultKeys: Record<string, Uint8Array> = {};

	await Promise.all(
		vaultKeys.map(async (vk) => {
			decryptedVaultKeys[vk.vaultId] = await storage.decryptVaultKey(
				vk.encryptedVaultKey,
				email,
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
							const decryptedItem = { ...item, ...data };

							// Add account metadata if provided (for "All Accounts" mode)
							if (accountMeta) {
								return {
									...decryptedItem,
									account: accountMeta,
									vault: {
										id: vault.id,
										name: vault.name,
										type: vault.type,
										icon: vault.icon,
										imageUrl: vault.imageUrl,
									},
								};
							}

							return decryptedItem;
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
 * Helper function to decrypt all vault items (single account or multi-account)
 */
async function decryptVaultItems() {
	const activeAccount = await storage.getActiveAccount();
	console.log(
		"[vault-handlers] decryptVaultItems - active account:",
		activeAccount,
	);

	// If active account is "all", fetch from all unlocked accounts
	if (activeAccount?.type === "all") {
		const unlockedEmails = await storage.getUnlockedAccounts?.();
		console.log(
			"[vault-handlers] Unlocked emails for 'all' mode:",
			unlockedEmails,
		);

		if (!unlockedEmails || unlockedEmails.length === 0) {
			console.log("[vault-handlers] No unlocked accounts found");
			return [];
		}

		// Fetch items from all unlocked accounts
		const allAccountItems = await Promise.all(
			unlockedEmails.map(async (email) => {
				try {
					console.log(`[vault-handlers] Fetching items for ${email}...`);
					// Get account metadata
					const accountMeta = await storage.getAccountMetadata?.(email);
					if (!accountMeta) {
						console.warn(`[vault-handlers] No metadata found for ${email}`);
						return [];
					}

					const items = await decryptVaultItemsForAccount(email, accountMeta);
					console.log(
						`[vault-handlers] Got ${items.length} items for ${email}`,
					);
					return items;
				} catch (error) {
					console.error(
						`[vault-handlers] Failed to fetch items for ${email}:`,
						error,
					);
					return [];
				}
			}),
		);

		// Flatten and return
		const flattened = allAccountItems.flat();
		console.log(
			`[vault-handlers] Total items from all accounts: ${flattened.length}`,
		);
		return flattened;
	}

	// Single account mode - use active account
	if (!activeAccount || activeAccount.type !== "single") {
		return [];
	}

	return decryptVaultItemsForAccount(activeAccount.email);
}

/**
 * Handle GET_VAULT_ITEMS message - Get all vault items
 */
export async function handleGetVaultItems(): Promise<MessageResponse> {
	updateActivity();

	// Check if desktop is available and we should use desktop mode
	const desktopStatus = desktopSync.getLastStatus();
	const desktopAvailable = desktopStatus?.available && !desktopStatus.locked;

	let items;
	if (desktopAvailable) {
		console.log("[vault-handlers] Using desktop mode for decryption (desktop available)");
		try {
			items = await decryptVaultItemsViaDesktop();
		} catch (error) {
			console.warn("[vault-handlers] Desktop decryption failed, falling back to WASM:", error);
			items = await decryptVaultItems();
		}
	} else {
		console.log("[vault-handlers] Using WASM mode for decryption (desktop not available)");
		items = await decryptVaultItems();
	}

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
	const vaultKeys = await storage.getVaultKeys();
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
	const vaultKey = await storage.decryptVaultKey(
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
