/**
 * Vault Utilities
 * Shared utility functions for vault operations
 */

import { createAccountTrpcClient } from "@bittery/shared/trpc-client-factory";
import { storage } from "../lib/storage";
import { desktopClient } from "./desktop-client";
import { decrypt } from "../lib/wasm-crypto";
import { trpcClient } from "./trpc-client";

/**
 * Helper function to get base domain from hostname
 */
export function getBaseDomain(host: string): string {
	const parts = host.split(".");
	if (parts.length <= 2) return host;
	return parts.slice(-2).join(".");
}

/**
 * Helper function to check if hostname matches
 */
export function hostnameMatches(
	itemUrl: string,
	targetHostname: string,
): boolean {
	if (!itemUrl) return false;

	try {
		const itemUrlObj = new URL(
			itemUrl.startsWith("http") ? itemUrl : `https://${itemUrl}`,
		);
		const itemHostname = itemUrlObj.hostname;

		// Exact match
		if (itemHostname === targetHostname) return true;

		// Check if one is a subdomain of the other
		if (
			itemHostname.endsWith(`.${targetHostname}`) ||
			targetHostname.endsWith(`.${itemHostname}`)
		) {
			return true;
		}

		// Base domain match
		const itemBaseDomain = getBaseDomain(itemHostname);
		const hostnameBaseDomain = getBaseDomain(targetHostname);

		return itemBaseDomain === hostnameBaseDomain;
	} catch {
		return false;
	}
}

/**
 * Helper function to decrypt vault items for a specific account using desktop crypto
 */
async function decryptVaultItemsForAccountViaDesktop(
	email: string,
	accountMeta?: { email: string; userId: string; name: string },
) {
	console.log(`[vault-utils] decryptVaultItemsForAccountViaDesktop - email: ${email}`);

	// Fetch vaults from API (using desktop's auth token)
	const authToken = await desktopClient.getAuthToken(email);
	if (!authToken) {
		console.warn(`[vault-utils] No auth token available from desktop for ${email}`);
		return [];
	}

	// Create account-specific tRPC client
	const serverUrl = (await storage.getServerUrl(email)) || "http://localhost:3000";
	const accountClient = createAccountTrpcClient(authToken, serverUrl);

	// Fetch vaults for this account
	console.log(`[vault-utils] Fetching vaults for ${email} from ${serverUrl}...`);
	const vaults = await accountClient.vault.list.query();
	console.log(`[vault-utils] Got ${vaults.length} vaults for ${email}`);

	// Prepare items for bulk decryption
	const allItems: Array<{
		id: string;
		vaultId: string;
		encryptedData: string;
		encryptionIv: string;
		encryptionAlgorithm: string;
		overview: any;
		vault: any;
	}> = [];

	for (const vault of vaults) {
		for (const item of vault.items) {
			allItems.push({
				id: item.id,
				vaultId: vault.id,
				encryptedData: item.encryptedData,
				encryptionIv: item.encryptionIv,
				encryptionAlgorithm: item.encryptionAlgorithm,
				overview: item,
				vault: {
					id: vault.id,
					name: vault.name,
					type: vault.type,
					icon: vault.icon,
					imageUrl: vault.imageUrl,
				},
			});
		}
	}

	if (allItems.length === 0) {
		return [];
	}

	// Bulk decrypt via desktop
	console.log(`[vault-utils] Decrypting ${allItems.length} items via desktop for ${email}`);
	const decryptedItems = await desktopClient.decryptItems(
		email,
		allItems.map((item) => ({
			id: item.id,
			vaultId: item.vaultId,
			encryptedData: item.encryptedData,
			encryptionIv: item.encryptionIv,
			encryptionAlgorithm: item.encryptionAlgorithm,
		})),
	);

	// Merge decrypted data with overview data
	const results = decryptedItems.map((decrypted) => {
		const original = allItems.find((item) => item.id === decrypted.id);
		if (!original) return null;

		try {
			const data = JSON.parse(decrypted.decrypted_data);
			const decryptedItem = { ...original.overview, ...data };

			// Add account metadata if provided (for "All Accounts" mode)
			if (accountMeta) {
				return {
					...decryptedItem,
					account: accountMeta,
					vault: original.vault,
				};
			}

			return decryptedItem;
		} catch (error) {
			console.error("Failed to parse decrypted data:", decrypted.id, error);
			return null;
		}
	});

	return results.filter((item) => item !== null);
}

/**
 * Helper function to decrypt all vault items using desktop crypto
 */
export async function decryptVaultItemsViaDesktop() {
	// Get active account
	const activeAccount = await storage.getActiveAccount();
	console.log("[vault-utils] decryptVaultItemsViaDesktop - active account:", activeAccount);

	// If active account is "all", fetch from all unlocked accounts
	if (activeAccount?.type === "all") {
		// Get unlocked accounts from desktop
		const sessionData = await desktopClient.getSessionData();
		if (!sessionData || sessionData.accounts.length === 0) {
			console.log("[vault-utils] No unlocked accounts found from desktop");
			return [];
		}

		console.log(`[vault-utils] Fetching items for ${sessionData.accounts.length} accounts via desktop`);

		// Fetch items from all unlocked accounts
		const allAccountItems = await Promise.all(
			sessionData.accounts.map(async (account) => {
				try {
					console.log(`[vault-utils] Fetching items for ${account.email} via desktop...`);
					// Get account metadata
					const accountMeta = await storage.getAccountMetadata?.(account.email);
					if (!accountMeta) {
						console.warn(`[vault-utils] No metadata found for ${account.email}`);
						return [];
					}

					const items = await decryptVaultItemsForAccountViaDesktop(account.email, accountMeta);
					console.log(`[vault-utils] Got ${items.length} items for ${account.email}`);
					return items;
				} catch (error) {
					console.error(`[vault-utils] Failed to fetch items for ${account.email}:`, error);
					return [];
				}
			}),
		);

		// Flatten and return
		const flattened = allAccountItems.flat();
		console.log(`[vault-utils] Total items from all accounts: ${flattened.length}`);
		return flattened;
	}

	// Single account mode - use active account
	if (!activeAccount || activeAccount.type !== "single") {
		console.log("[vault-utils] No active account for desktop decryption");
		return [];
	}

	return decryptVaultItemsForAccountViaDesktop(activeAccount.email);
}

/**
 * Helper function to decrypt all vault items (standalone mode - WASM)
 */
export async function decryptVaultItems() {
	const vaultKeys = await storage.getVaultKeys();

	if (!vaultKeys || vaultKeys.length === 0) {
		return [];
	}

	const vaults = await trpcClient.vault.list.query();

	const decryptedVaultKeys: Record<string, Uint8Array> = {};

	await Promise.all(
		vaultKeys.map(async (vk) => {
			decryptedVaultKeys[vk.vaultId] = await storage.decryptVaultKey(
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

	return allVaultItems.flat();
}
