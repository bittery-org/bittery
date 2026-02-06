/**
 * Vault Utilities
 * Shared utility functions for vault operations
 */

import { createAccountTrpcClient } from "@bittery/shared/trpc-client-factory";
import type { CachedEncryptedItem, CachedVaultMetadata } from "@bittery/types";
import { storage } from "../lib/storage";
import { decrypt } from "../lib/wasm-crypto";
import { desktopClient } from "./desktop-client";
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
	console.log(
		`[vault-utils] decryptVaultItemsForAccountViaDesktop - email: ${email}`,
	);

	// Fetch vaults from API (using desktop's auth token)
	const authToken = await desktopClient.getAuthToken(email);
	if (!authToken) {
		console.warn(
			`[vault-utils] No auth token available from desktop for ${email}`,
		);
		return [];
	}

	// Create account-specific tRPC client
	const serverUrl =
		(await storage.getServerUrl(email)) || "http://localhost:3000";
	const accountClient = createAccountTrpcClient(authToken, serverUrl);

	// Fetch vaults for this account
	console.log(
		`[vault-utils] Fetching vaults for ${email} from ${serverUrl}...`,
	);
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
			// Skip deleted items (items in trash)
			if (item.deletedAt) continue;

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
	console.log(
		`[vault-utils] Decrypting ${allItems.length} items via desktop for ${email}`,
	);
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
	console.log(
		"[vault-utils] decryptVaultItemsViaDesktop - active account:",
		activeAccount,
	);

	// If active account is "all", fetch from all unlocked accounts
	if (activeAccount?.type === "all") {
		// Get unlocked accounts from desktop
		const sessionData = await desktopClient.getSessionData();
		if (!sessionData || sessionData.accounts.length === 0) {
			console.log("[vault-utils] No unlocked accounts found from desktop");
			return [];
		}

		console.log(
			`[vault-utils] Fetching items for ${sessionData.accounts.length} accounts via desktop`,
		);

		// Fetch items from all unlocked accounts
		const allAccountItems = await Promise.all(
			sessionData.accounts.map(async (account) => {
				try {
					console.log(
						`[vault-utils] Fetching items for ${account.email} via desktop...`,
					);
					// Get account metadata
					const accountMeta = await storage.getAccountMetadata?.(account.email);
					if (!accountMeta) {
						console.warn(
							`[vault-utils] No metadata found for ${account.email}`,
						);
						return [];
					}

					const items = await decryptVaultItemsForAccountViaDesktop(
						account.email,
						accountMeta,
					);
					console.log(
						`[vault-utils] Got ${items.length} items for ${account.email}`,
					);
					return items;
				} catch (error) {
					console.error(
						`[vault-utils] Failed to fetch items for ${account.email}:`,
						error,
					);
					return [];
				}
			}),
		);

		// Flatten and return
		const flattened = allAccountItems.flat();
		console.log(
			`[vault-utils] Total items from all accounts: ${flattened.length}`,
		);
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
					vault.items
						// Skip deleted items (items in trash)
						.filter((item) => !item.deletedAt)
						.map(async (item) => {
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

// ============================================================================
// Cache-first helpers
// ============================================================================

/**
 * Populate cache from a vault.list server response.
 * Converts the nested vault→items structure into flat CachedEncryptedItem[] + CachedVaultMetadata[].
 */
export async function populateCacheFromServerResponse(
	vaults: Array<{
		id: string;
		name: string;
		type: string;
		icon: string | null;
		imageUrl: string | null;
		items: Array<{
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
	}>,
	email?: string,
): Promise<void> {
	if (!storage.supportsItemCache) return;

	const cachedVaults: CachedVaultMetadata[] = vaults.map((v) => ({
		id: v.id,
		name: v.name,
		type: v.type,
		icon: v.icon,
		imageUrl: v.imageUrl,
	}));

	const cachedItems: CachedEncryptedItem[] = [];
	for (const vault of vaults) {
		for (const item of vault.items) {
			cachedItems.push({
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
			});
		}
	}

	await storage.setCachedItems?.(cachedItems, email);
	await storage.setCachedVaults?.(cachedVaults, email);
	await storage.setItemCacheMetadata?.(
		{
			lastFullSyncAt: Date.now(),
			itemCount: cachedItems.length,
			cacheVersion: 1,
		},
		email,
	);

	console.log(
		`[vault-utils] Cache populated: ${cachedItems.length} items, ${cachedVaults.length} vaults`,
	);
}

/**
 * Decrypt cached items using WASM crypto (standalone mode).
 */
async function decryptCachedItemsViaWasm(
	items: CachedEncryptedItem[],
	vaults: CachedVaultMetadata[],
	email?: string,
) {
	const vaultKeys = await storage.getVaultKeys(email);
	if (!vaultKeys || vaultKeys.length === 0) return [];

	const decryptedVaultKeys: Record<string, Uint8Array> = {};
	await Promise.all(
		vaultKeys.map(async (vk) => {
			decryptedVaultKeys[vk.vaultId] = await storage.decryptVaultKey(
				vk.encryptedVaultKey,
				email,
			);
		}),
	);

	// Build vault metadata map
	const vaultMap = new Map(vaults.map((v) => [v.id, v]));

	const decryptedItems = await Promise.all(
		items
			.filter((item) => !item.deletedAt)
			.map(async (item) => {
				try {
					const vaultKey = decryptedVaultKeys[item.vaultId];
					if (!vaultKey) return null;

					const decrypted = await decrypt(
						{
							algorithm: item.encryptionAlgorithm,
							iv: item.encryptionIv,
							ciphertext: item.encryptedData,
						},
						vaultKey,
					);

					const data = JSON.parse(decrypted);
					const vault = vaultMap.get(item.vaultId);
					return {
						...item,
						...data,
						vault: vault
							? {
									id: vault.id,
									name: vault.name,
									type: vault.type,
									icon: vault.icon,
									imageUrl: vault.imageUrl,
								}
							: undefined,
					};
				} catch (error) {
					console.error(
						"[vault-utils] Failed to decrypt cached item:",
						item.id,
						error,
					);
					return null;
				}
			}),
	);

	return decryptedItems.filter((item) => item !== null);
}

/**
 * Decrypt cached items using desktop crypto.
 */
async function decryptCachedItemsViaDesktop(
	items: CachedEncryptedItem[],
	vaults: CachedVaultMetadata[],
	email: string,
) {
	const nonDeleted = items.filter((item) => !item.deletedAt);
	if (nonDeleted.length === 0) return [];

	const vaultMap = new Map(vaults.map((v) => [v.id, v]));

	const decryptedItems = await desktopClient.decryptItems(
		email,
		nonDeleted.map((item) => ({
			id: item.id,
			vaultId: item.vaultId,
			encryptedData: item.encryptedData,
			encryptionIv: item.encryptionIv,
			encryptionAlgorithm: item.encryptionAlgorithm,
		})),
	);

	return decryptedItems
		.map((decrypted) => {
			const original = nonDeleted.find((item) => item.id === decrypted.id);
			if (!original) return null;

			try {
				const data = JSON.parse(decrypted.decrypted_data);
				const vault = vaultMap.get(original.vaultId);
				return {
					...original,
					...data,
					vault: vault
						? {
								id: vault.id,
								name: vault.name,
								type: vault.type,
								icon: vault.icon,
								imageUrl: vault.imageUrl,
							}
						: undefined,
				};
			} catch (error) {
				console.error(
					"[vault-utils] Failed to parse desktop-decrypted data:",
					decrypted.id,
					error,
				);
				return null;
			}
		})
		.filter((item) => item !== null);
}

/**
 * Get decrypted vault items using cache-first strategy.
 * 1. Try cache → decrypt from cached encrypted data
 * 2. Cache miss → fetch from server → populate cache → decrypt
 *
 * Works for single-account mode. "All accounts" mode falls back to non-cached paths.
 */
export async function getDecryptedItemsCacheFirst(
	useDesktop: boolean,
	email?: string,
): Promise<Array<any>> {
	// Resolve email for cache operations
	const resolvedEmail = email || (await resolveEmail());
	if (!resolvedEmail) {
		// No single email resolved — fall back to non-cached path
		return useDesktop ? decryptVaultItemsViaDesktop() : decryptVaultItems();
	}

	// Try cache first
	if (storage.supportsItemCache) {
		const cachedItems = await storage.getCachedItems?.(resolvedEmail);
		const cachedVaults = await storage.getCachedVaults?.(resolvedEmail);

		if (cachedItems && cachedItems.length > 0 && cachedVaults) {
			console.log(
				`[vault-utils] Cache hit: ${cachedItems.length} items, ${cachedVaults.length} vaults`,
			);

			try {
				if (useDesktop) {
					return await decryptCachedItemsViaDesktop(
						cachedItems,
						cachedVaults,
						resolvedEmail,
					);
				}
				return await decryptCachedItemsViaWasm(
					cachedItems,
					cachedVaults,
					resolvedEmail,
				);
			} catch (error) {
				console.warn(
					"[vault-utils] Cache decryption failed (key rotation?), falling back to server fetch:",
					error,
				);
				// Fall through to server fetch + cache repopulation
			}
		}
	}

	// Cache miss or decryption failure: fetch from server
	console.log("[vault-utils] Cache miss, fetching from server");

	if (useDesktop) {
		// Desktop mode: fetch from server, populate cache, then decrypt via desktop
		const authToken = await desktopClient.getAuthToken(resolvedEmail);
		if (!authToken) return decryptVaultItemsViaDesktop();

		const serverUrl =
			(await storage.getServerUrl(resolvedEmail)) || "http://localhost:3000";
		const accountClient = createAccountTrpcClient(authToken, serverUrl);
		const vaults = await accountClient.vault.list.query();

		// Populate cache
		await populateCacheFromServerResponse(vaults, resolvedEmail);

		// Now decrypt from the fresh cache
		const cachedItems = await storage.getCachedItems?.(resolvedEmail);
		const cachedVaults = await storage.getCachedVaults?.(resolvedEmail);
		if (cachedItems && cachedVaults) {
			return decryptCachedItemsViaDesktop(
				cachedItems,
				cachedVaults,
				resolvedEmail,
			);
		}
		return [];
	}

	// WASM mode: fetch from server, populate cache, then decrypt via WASM
	const authToken = await storage.getAuthToken(resolvedEmail);
	if (!authToken) return decryptVaultItems();

	const serverUrl =
		(await storage.getServerUrl(resolvedEmail)) || "http://localhost:3000";
	const accountClient = createAccountTrpcClient(authToken, serverUrl);
	const vaults = await accountClient.vault.list.query();

	// Populate cache
	await populateCacheFromServerResponse(vaults, resolvedEmail);

	// Now decrypt from the fresh cache
	const cachedItems = await storage.getCachedItems?.(resolvedEmail);
	const cachedVaults = await storage.getCachedVaults?.(resolvedEmail);
	if (cachedItems && cachedVaults) {
		return decryptCachedItemsViaWasm(cachedItems, cachedVaults, resolvedEmail);
	}
	return [];
}

/**
 * Resolve active account email for cache operations
 */
async function resolveEmail(): Promise<string | null> {
	const account = await storage.getActiveAccount();
	if (!account || account.type === "all") return null;
	return account.email;
}
