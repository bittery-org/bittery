import { useItems } from "@bittery/hooks";
import { arrayBufferToBase64 } from "@bittery/shared/crypto";
import { useCallback, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import { storage } from "@/services/storage";
import type { SaveCredentialParams } from "../../modules/credential-provider";
import CredentialProvider from "../../modules/credential-provider";

/**
 * Extracts the domain from a URL string
 */
function extractDomain(url: string | undefined): string | null {
	if (!url) return null;

	try {
		// Add protocol if missing
		let urlWithProtocol = url;
		if (!url.startsWith("http://") && !url.startsWith("https://")) {
			urlWithProtocol = `https://${url}`;
		}

		const parsedUrl = new URL(urlWithProtocol);
		return parsedUrl.hostname.replace(/^www\./, "");
	} catch {
		// If URL parsing fails, try to extract domain directly
		const match = url.match(/^(?:https?:\/\/)?(?:www\.)?([^/]+)/i);
		return match ? match[1] : null;
	}
}

/**
 * Hook options for credential provider sync
 */
export interface UseCredentialProviderSyncOptions {
	/** Whether to automatically sync when items change (default: true) */
	autoSync?: boolean;
	/** Debounce delay in milliseconds for auto-sync (default: 2000) */
	debounceMs?: number;
	/** Whether sync is enabled (default: true on Android) */
	enabled?: boolean;
}

/**
 * Hook to sync vault login items to the Android Credential Provider.
 * This enables autofill functionality for passwords across other apps.
 *
 * The hook:
 * - Watches decrypted vault items via React Query
 * - Extracts login items with domain/username/password
 * - Syncs them to the credential provider storage (encrypted with biometric key)
 * - Automatically syncs when items change (debounced)
 *
 * Note: Credential Provider is only available on Android 14+ (API 34+)
 */
export function useCredentialProviderSync(
	options: UseCredentialProviderSyncOptions = {},
) {
	const { autoSync = true, debounceMs = 2000, enabled = true } = options;

	const { items, isLoading: isLoadingItems } = useItems();

	const [isSyncing, setIsSyncing] = useState(false);
	const [lastSyncResult, setLastSyncResult] = useState<{
		synced: number;
		deleted: number;
	} | null>(null);
	const [error, setError] = useState<Error | null>(null);
	const [isAvailable, setIsAvailable] = useState(false);
	const [isBiometricAvailable, setIsBiometricAvailable] = useState(false);

	const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const lastItemsHashRef = useRef<string>("");

	// Check if credential provider and biometric/device auth are available
	useEffect(() => {
		if (Platform.OS !== "android") {
			console.log("[CredentialProviderSync] Not Android, skipping");
			setIsAvailable(false);
			setIsBiometricAvailable(false);
			return;
		}

		const credentialProviderAvailable = CredentialProvider.isAvailable();
		const biometricAvailable = CredentialProvider.isBiometricAvailable();
		const keyAvailable = CredentialProvider.isKeyAvailable();

		console.log("[CredentialProviderSync] Availability check:", {
			credentialProviderAvailable,
			biometricAvailable,
			keyAvailable,
			sdkVersion: Platform.Version,
		});

		setIsAvailable(credentialProviderAvailable);
		setIsBiometricAvailable(biometricAvailable);
	}, []);

	/**
	 * Extract credentials from decrypted login items
	 */
	const extractCredentials = useCallback((): SaveCredentialParams[] => {
		const loginItems = items.filter((item) => item.category === "login");

		const credentials: SaveCredentialParams[] = [];

		for (const item of loginItems) {
			// Get domain from primary URL or first of multiple URLs
			const primaryUrl = item.url || item.urls?.[0];
			const domain = extractDomain(primaryUrl);

			// Skip items without valid domain or credentials
			if (!domain || !item.username || !item.password) {
				continue;
			}

			credentials.push({
				vaultId: item.vaultId,
				itemId: item.id,
				domain,
				username: item.username,
				password: item.password,
				displayName: item.title || `${item.username} @ ${domain}`,
			});

			// Also add credentials for additional URLs if they have different domains
			if (item.urls && item.urls.length > 1) {
				for (let i = 1; i < item.urls.length; i++) {
					const additionalUrl = item.urls[i];
					if (!additionalUrl) continue;
					const additionalDomain = extractDomain(additionalUrl);
					if (additionalDomain && additionalDomain !== domain) {
						credentials.push({
							vaultId: item.vaultId,
							itemId: `${item.id}_url_${i}`, // Unique ID for additional URLs
							domain: additionalDomain,
							username: item.username,
							password: item.password,
							displayName:
								item.title || `${item.username} @ ${additionalDomain}`,
						});
					}
				}
			}
		}

		return credentials;
	}, [items]);

	/**
	 * Ensure the MUK is set in the native VaultStateManager.
	 * This enables on-demand decryption in the credential provider service.
	 */
	const ensureNativeMukSet = useCallback(async () => {
		if (Platform.OS !== "android" || !isAvailable) return;

		try {
			// Check if already set
			if (CredentialProvider.isVaultUnlocked()) {
				console.log("[CredentialProviderSync] Native MUK already set");
				return;
			}

			// Get MUK from React Native storage
			const muk = await storage.getMasterUnlockKey();
			if (muk) {
				const mukBase64 = arrayBufferToBase64(muk);
				CredentialProvider.setMasterUnlockKey(mukBase64);
				console.log("[CredentialProviderSync] Native MUK set from RN storage");
			}
		} catch (err) {
			console.warn("[CredentialProviderSync] Failed to set native MUK:", err);
		}
	}, [isAvailable]);

	/**
	 * Sync vault data (vault keys + encrypted items) to native database.
	 * This is the new unified storage approach that:
	 * - Stores encrypted server data directly (no double-encryption)
	 * - Uses MUK for on-demand decryption (no biometric auth required)
	 * - Enables inline autofill suggestions
	 */
	const syncVaultData = useCallback(async (): Promise<{
		vaultKeys: number;
		items: number;
		domains: number;
	} | null> => {
		console.log("[CredentialProviderSync] syncVaultData() called");

		if (!isAvailable || Platform.OS !== "android") {
			console.log("[CredentialProviderSync] Vault sync skipped: not available");
			return null;
		}

		try {
			// Ensure MUK is available in native
			await ensureNativeMukSet();

			// Get current active account
			const activeAccount = await storage.getActiveAccount();
			if (!activeAccount || activeAccount.type !== "single") {
				console.warn("[CredentialProviderSync] No single active account, skipping vault sync");
				return null;
			}
			const email = activeAccount.email;

			// Get user ID
			const userId = await storage.getActiveAccountUserId();
			if (!userId) {
				console.warn("[CredentialProviderSync] No user ID found, skipping vault sync");
				return null;
			}

			// Get vault keys from storage
			const vaultKeys = await storage.getVaultKeys(email);
			if (!vaultKeys || vaultKeys.length === 0) {
				console.warn("[CredentialProviderSync] No vault keys found, skipping vault sync");
				return null;
			}

			// Create a set of vault IDs we have keys for
			const vaultIdsWithKeys = new Set(vaultKeys.map(vk => vk.vaultId));
			console.log("[CredentialProviderSync] Vault IDs with keys:", Array.from(vaultIdsWithKeys));

			// Use items already fetched and decrypted by useItems()
			// Filter to: login items only + items from vaults we have keys for
			const loginItems = items.filter(
				item => item.category === "login" && vaultIdsWithKeys.has(item.vaultId)
			);
			console.log(`[CredentialProviderSync] Processing ${loginItems.length} login items from ${vaultIdsWithKeys.size} vaults`);
			console.log("[CredentialProviderSync] Sample item vaultId:", loginItems[0]?.vaultId, "is in keys:", vaultIdsWithKeys.has(loginItems[0]?.vaultId));

			// Prepare items data with encrypted fields and denormalized metadata
			const itemsData = loginItems
				.filter(item => item._encrypted) // Only items with encrypted data
				.map(item => {
					// Extract URLs for domain mapping
					const urls: string[] = [];
					if (item.url) urls.push(item.url);
					if (item.urls && Array.isArray(item.urls)) {
						urls.push(...item.urls);
					}

					// _encrypted is guaranteed to exist due to filter above
					const encrypted = item._encrypted as { data: string; iv: string; algorithm: string };

					return {
						id: item.id,
						vaultId: item.vaultId,
						userId,
						category: item.category,
						displayTitle: item.title || "",
						encryptedData: encrypted.data,
						encryptionIv: encrypted.iv,
						encryptionAlgorithm: encrypted.algorithm,
						username: item.username || item.email || null,
						urls,
						iconUrl: null, // TODO: Add icon support
						lastUsedAt: 0,
						createdAt: new Date(item.createdAt).getTime(),
						updatedAt: new Date(item.updatedAt).getTime(),
						isFavorite: item.favorite || false,
					};
				});

			// Prepare vault keys data
			const vaultKeysData = vaultKeys.map(vaultKey => {
				// Parse encrypted vault key (it's stored as EncryptedData JSON or just base64)
				let encryptedKey: string;
				let encryptionIv: string;
				let encryptionAlgorithm: string;

				try {
					// Try parsing as EncryptedData JSON
					const parsed = JSON.parse(vaultKey.encryptedVaultKey);
					encryptedKey = parsed.ciphertext;
					encryptionIv = parsed.iv;
					encryptionAlgorithm = parsed.algorithm || "AES-GCM";
				} catch {
					// Assume it's just base64 ciphertext (fallback)
					encryptedKey = vaultKey.encryptedVaultKey;
					encryptionIv = ""; // Will need to handle this case
					encryptionAlgorithm = "AES-GCM";
				}

				return {
					vaultId: vaultKey.vaultId,
					vaultName: vaultKey.vaultName,
					vaultType: vaultKey.vaultType,
					encryptedKey,
					encryptionIv,
					encryptionAlgorithm,
					role: vaultKey.role,
				};
			});

			console.log(`[CredentialProviderSync] Syncing ${vaultKeysData.length} vault keys, ${itemsData.length} items`);

			// Log sample data for debugging
			console.log("[CredentialProviderSync] Sample vault key:", vaultKeysData[0]);
			console.log("[CredentialProviderSync] Sample item:", itemsData[0]);

			// Call native sync function with JSON string
			const syncData = {
				userId,
				vaultKeys: vaultKeysData,
				items: itemsData,
			};

			const result = await CredentialProvider.syncVaultData(JSON.stringify(syncData));

			console.log("[CredentialProviderSync] Vault sync result:", result);
			return result;
		} catch (err) {
			console.error("[CredentialProviderSync] Vault sync failed:", err);
			return null;
		}
	}, [isAvailable, items]);

	/**
	 * Perform the legacy sync operation.
	 *
	 * This syncs decrypted credentials to the credential provider storage.
	 * The native side re-encrypts passwords with BiometricKeyManager.
	 */
	const sync = useCallback(async (): Promise<{
		synced: number;
		deleted: number;
	} | null> => {
		console.log("[CredentialProviderSync] sync() called", {
			isAvailable,
			isBiometricAvailable,
			platform: Platform.OS,
		});

		if (!isAvailable || Platform.OS !== "android") {
			console.log(
				"[CredentialProviderSync] Sync skipped: not available or not Android",
			);
			return null;
		}

		// Check if biometric or device credential auth is available
		if (!isBiometricAvailable) {
			const authError = new Error(
				"Authentication not available. Please set up a PIN, pattern, password, or biometric on your device to use autofill.",
			);
			setError(authError);
			console.warn(
				"[CredentialProviderSync] Sync skipped: no authentication method available",
			);
			return null;
		}

		setIsSyncing(true);
		setError(null);

		try {
			// Sync vault data (new unified storage approach)
			console.log("[CredentialProviderSync] Starting vault data sync...");
			const vaultResult = await syncVaultData();
			if (vaultResult) {
				console.log("[CredentialProviderSync] Vault sync complete:", vaultResult);
			}

			// Also sync legacy credentials for backwards compatibility
			// (This can be removed once all autofill flows use vault-based storage)
			const credentials = extractCredentials();

			if (credentials.length === 0) {
				console.log("[CredentialProviderSync] No legacy credentials to sync");
				setLastSyncResult({ synced: 0, deleted: 0 });
				return { synced: 0, deleted: 0 };
			}

			console.log(
				"[CredentialProviderSync] Calling CredentialProvider.syncCredentials...",
			);
			const result = await CredentialProvider.syncCredentials(credentials);
			console.log("[CredentialProviderSync] Legacy sync result:", result);

			setLastSyncResult(result);
			return result;
		} catch (err) {
			const error =
				err instanceof Error ? err : new Error("Failed to sync credentials");
			setError(error);
			console.error("[CredentialProviderSync] Sync failed:", error);
			return null;
		} finally {
			setIsSyncing(false);
		}
	}, [
		isAvailable,
		isBiometricAvailable,
		extractCredentials,
		syncVaultData,
	]);

	/**
	 * Calculate a hash of items to detect changes
	 */
	const calculateItemsHash = useCallback((): string => {
		const loginItems = items.filter((item) => item.category === "login");
		// Create a simple hash based on item IDs, usernames, passwords, and URLs
		const hashData = loginItems.map((item) => ({
			id: item.id,
			username: item.username,
			password: item.password,
			url: item.url,
			urls: item.urls,
			updatedAt: item.updatedAt,
		}));
		return JSON.stringify(hashData);
	}, [items]);

	// Auto-sync when items change (debounced)
	useEffect(() => {
		console.log("[CredentialProviderSync] Auto-sync effect triggered", {
			enabled,
			autoSync,
			isAvailable,
			isBiometricAvailable,
			isLoadingItems,
			platform: Platform.OS,
			itemCount: items.length,
		});

		if (
			!enabled ||
			!autoSync ||
			!isAvailable ||
			!isBiometricAvailable ||
			isLoadingItems ||
			Platform.OS !== "android"
		) {
			console.log(
				"[CredentialProviderSync] Auto-sync skipped due to conditions",
			);
			return;
		}

		const currentHash = calculateItemsHash();

		// Skip if items haven't changed
		if (currentHash === lastItemsHashRef.current) {
			console.log(
				"[CredentialProviderSync] Items haven't changed, skipping sync",
			);
			return;
		}

		console.log("[CredentialProviderSync] Items changed, scheduling sync...");
		lastItemsHashRef.current = currentHash;

		// Clear existing timer
		if (debounceTimerRef.current) {
			clearTimeout(debounceTimerRef.current);
		}

		// Set debounced sync
		debounceTimerRef.current = setTimeout(() => {
			console.log(
				"[CredentialProviderSync] Debounce timer fired, starting sync",
			);
			sync();
		}, debounceMs);

		return () => {
			if (debounceTimerRef.current) {
				clearTimeout(debounceTimerRef.current);
			}
		};
	}, [
		enabled,
		autoSync,
		isAvailable,
		isBiometricAvailable,
		isLoadingItems,
		calculateItemsHash,
		sync,
		debounceMs,
		items.length,
	]);

	return {
		/** Whether the credential provider API is available (Android 14+) */
		isAvailable,
		/** Whether biometric or device credential authentication is available */
		isBiometricAvailable,
		/** Whether a sync is currently in progress */
		isSyncing,
		/** Result of the last sync operation */
		lastSyncResult,
		/** Any error that occurred during sync */
		error,
		/** Manually trigger a sync */
		sync,
		/** Get the credentials that would be synced */
		getCredentialsToSync: extractCredentials,
	};
}
