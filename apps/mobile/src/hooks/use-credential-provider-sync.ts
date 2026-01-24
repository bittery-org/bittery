import { arrayBufferToBase64 } from "@bittery/crypto/key-derivation";
import * as storage from "@bittery/crypto/storage-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";

import CredentialProvider from "../../modules/credential-provider";
import type { SaveCredentialParams } from "../../modules/credential-provider";
import { useAllDecryptedItems } from "./use-all-decrypted-items";

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

	const { items, isLoading: isLoadingItems } = useAllDecryptedItems();

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
		console.log("[CredentialProviderSync] extractCredentials:", {
			totalItems: items.length,
			loginItems: loginItems.length,
		});

		const credentials: SaveCredentialParams[] = [];

		for (const item of loginItems) {
			// Get domain from primary URL or first of multiple URLs
			const primaryUrl = item.url || item.urls?.[0];
			const domain = extractDomain(primaryUrl);

			console.log("[CredentialProviderSync] Processing item:", {
				id: item.id,
				title: item.title,
				url: primaryUrl,
				domain,
				hasUsername: !!item.username,
				hasPassword: !!item.password,
			});

			// Skip items without valid domain or credentials
			if (!domain || !item.username || !item.password) {
				console.log("[CredentialProviderSync] Skipping item - missing data");
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
							displayName: item.title || `${item.username} @ ${additionalDomain}`,
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
	 * Perform the sync operation.
	 *
	 * This syncs decrypted credentials to the credential provider storage.
	 * The native side re-encrypts passwords with BiometricKeyManager.
	 *
	 * TODO: Future optimization - Unified Storage:
	 * Instead of syncing decrypted credentials, sync encrypted server data
	 * directly to ItemEntity/VaultKeyEntity. This eliminates double-encryption
	 * and allows the credential provider to decrypt on-demand using the MUK.
	 * This would require:
	 * 1. Access to raw encrypted server responses
	 * 2. New native sync function for ItemEntity/VaultKeyEntity
	 * 3. Domain/username extraction happens here (denormalization)
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
			console.log("[CredentialProviderSync] Sync skipped: not available or not Android");
			return null;
		}

		// Check if biometric or device credential auth is available
		if (!isBiometricAvailable) {
			const authError = new Error(
				"Authentication not available. Please set up a PIN, pattern, password, or biometric on your device to use autofill.",
			);
			setError(authError);
			console.warn("[CredentialProviderSync] Sync skipped: no authentication method available");
			return null;
		}

		setIsSyncing(true);
		setError(null);

		try {
			// Ensure MUK is available in native for unified storage decryption
			await ensureNativeMukSet();

			const credentials = extractCredentials();
			console.log("[CredentialProviderSync] Credentials to sync:", {
				count: credentials.length,
				credentials: credentials.map(c => ({
					domain: c.domain,
					username: c.username,
					itemId: c.itemId,
				})),
			});

			if (credentials.length === 0) {
				console.log("[CredentialProviderSync] No credentials to sync");
				setLastSyncResult({ synced: 0, deleted: 0 });
				return { synced: 0, deleted: 0 };
			}

			console.log("[CredentialProviderSync] Calling CredentialProvider.syncCredentials...");
			const result = await CredentialProvider.syncCredentials(credentials);
			console.log("[CredentialProviderSync] Sync result:", result);

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
	}, [isAvailable, isBiometricAvailable, extractCredentials, ensureNativeMukSet]);

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
			console.log("[CredentialProviderSync] Auto-sync skipped due to conditions");
			return;
		}

		const currentHash = calculateItemsHash();

		// Skip if items haven't changed
		if (currentHash === lastItemsHashRef.current) {
			console.log("[CredentialProviderSync] Items haven't changed, skipping sync");
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
			console.log("[CredentialProviderSync] Debounce timer fired, starting sync");
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
