import { useAccountsInfo, useItems } from "@bittery/core/hooks";
import { arrayBufferToBase64 } from "@bittery/shared/crypto";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Platform } from "react-native";
import { storage } from "@/services/storage";
import type {
	PendingPasskeyMutation,
	SaveCredentialParams,
} from "../../modules/credential-provider";
import CredentialProvider from "../../modules/credential-provider";

const MAX_PENDING_PASSKEY_ATTEMPTS = 5;
const MAX_PENDING_PASSKEY_AGE_MS = 7 * 24 * 60 * 60 * 1000;

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

	const {
		items,
		isLoading: isLoadingItems,
		refetch: refetchItems,
	} = useItems();
	const { accountsInfo, isAllAccountsMode } = useAccountsInfo();

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
			const unlockedEmails = (await storage.getUnlockedAccounts?.()) ?? [];
			console.log("[CredentialProviderSync] ensureNativeMukSet: unlockedEmails=", unlockedEmails);
			if (unlockedEmails.length === 0) {
				console.warn("[CredentialProviderSync] ensureNativeMukSet: No unlocked accounts found in RN storage!");
				return;
			}

			for (const email of unlockedEmails) {
				const muk = await storage.getMasterUnlockKey(email);
				const sessionData = await storage.getStoredSessionData(email);
				const autoLockTimeoutMs =
					await storage.getAutoLockTimeoutOrDefault(email);
				console.log(`[CredentialProviderSync] ensureNativeMukSet: email=${email}, hasMuk=${!!muk}, hasSessionData=${!!sessionData}, userId=${sessionData?.userId ?? "null"}`);
				if (muk && sessionData?.userId) {
					const mukBase64 = arrayBufferToBase64(muk);
					CredentialProvider.setMasterUnlockKey(
						mukBase64,
						sessionData.userId,
						autoLockTimeoutMs,
					);
					console.log(`[CredentialProviderSync] ensureNativeMukSet: Set native MUK for userId=${sessionData.userId}`);
				} else {
					console.warn(`[CredentialProviderSync] ensureNativeMukSet: SKIPPING email=${email} (muk=${!!muk}, userId=${sessionData?.userId ?? "null"})`);
				}
			}

			console.log("[CredentialProviderSync] Native MUKs set from RN storage");
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

			if (accountsInfo.length === 0) {
				console.warn(
					"[CredentialProviderSync] No accounts available, skipping vault sync",
				);
				return null;
			}

			const totals = {
				vaultKeys: 0,
				items: 0,
				domains: 0,
			};

			for (const account of accountsInfo) {
				const vaultKeys = await storage.getVaultKeys(account.email);
				if (!vaultKeys || vaultKeys.length === 0) {
					continue;
				}

				const vaultIdsWithKeys = new Set(vaultKeys.map((vk) => vk.vaultId));

				const loginItems = items.filter((item) => {
					if (item.category !== "login") return false;
					if (!vaultIdsWithKeys.has(item.vaultId)) return false;
					if (!isAllAccountsMode) return true;
					return (
						item.account?.email?.toLowerCase() === account.email.toLowerCase()
					);
				});

				const itemsData = loginItems
					.filter((item) => item._encrypted)
					.map((item) => {
						const urlSet = new Set<string>();
						const addUrl = (value: unknown) => {
							if (typeof value === "string" && value.trim().length > 0) {
								urlSet.add(value.trim());
							}
						};
						addUrl(item.url);
						if (item.urls && Array.isArray(item.urls)) {
							for (const value of item.urls) {
								addUrl(value);
							}
						}
						// Passkey-only items may not always carry explicit url/urls fields.
						// Backfill domains into sync payload from stored passkey rpIds.
						const passkeys = (item as { passkeys?: unknown }).passkeys;
						if (Array.isArray(passkeys)) {
							for (const passkey of passkeys) {
								const rpId =
									typeof passkey === "object" &&
									passkey !== null &&
									"rpId" in passkey &&
									typeof (passkey as { rpId?: unknown }).rpId === "string"
										? ((passkey as { rpId: string }).rpId || "").trim()
										: "";
								if (rpId) {
									addUrl(`https://${rpId}`);
								}
							}
						}
						const urls = Array.from(urlSet);

						const encrypted = item._encrypted as {
							data: string;
							iv: string;
							algorithm: string;
						};

						return {
							id: item.id,
							vaultId: item.vaultId,
							userId: account.userId,
							category: item.category,
							displayTitle: item.title || "",
							encryptedData: encrypted.data,
							encryptionIv: encrypted.iv,
							encryptionAlgorithm: encrypted.algorithm,
							username: item.username || item.email || null,
							urls,
							iconUrl: null,
							lastUsedAt: 0,
							createdAt: new Date(item.createdAt).getTime(),
							updatedAt: new Date(item.updatedAt).getTime(),
							isFavorite: item.favorite || false,
						};
					});

				const vaultKeysData = vaultKeys.map((vaultKey) => {
					let encryptedKey: string;
					let encryptionIv: string;
					let encryptionAlgorithm: string;

					try {
						const parsed = JSON.parse(vaultKey.encryptedVaultKey);
						encryptedKey = parsed.ciphertext;
						encryptionIv = parsed.iv;
						encryptionAlgorithm = parsed.algorithm || "AES-GCM";
					} catch {
						encryptedKey = vaultKey.encryptedVaultKey;
						encryptionIv = "";
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

				const syncData = {
					userId: account.userId,
					vaultKeys: vaultKeysData,
					items: itemsData,
				};

				const result = await CredentialProvider.syncVaultData(
					JSON.stringify(syncData),
				);

				totals.vaultKeys += result?.vaultKeys ?? vaultKeysData.length;
				totals.items += result?.items ?? itemsData.length;
				totals.domains += result?.domains ?? 0;
			}

			console.log("[CredentialProviderSync] Vault sync totals:", totals);
			return totals;
		} catch (err) {
			console.error("[CredentialProviderSync] Vault sync failed:", err);
			return null;
		}
	}, [accountsInfo, ensureNativeMukSet, isAvailable, isAllAccountsMode, items]);

	/**
	 * Flush provider-side passkey mutations to server before inbound vault sync.
	 * This prevents local passkey writes from being overwritten by pull sync.
	 */
	const flushPendingPasskeyMutations = useCallback(async (): Promise<{
		applied: number;
		failed: number;
		discarded: number;
	}> => {
		if (!isAvailable || Platform.OS !== "android") {
			return { applied: 0, failed: 0, discarded: 0 };
		}

		if (accountsInfo.length === 0) {
			return { applied: 0, failed: 0, discarded: 0 };
		}

		const pending = await CredentialProvider.getPendingPasskeyMutations("");
		if (!pending || pending.length === 0) {
			return { applied: 0, failed: 0, discarded: 0 };
		}

		const accountByUserId = new Map(
			accountsInfo.map((account) => [account.userId, account] as const),
		);

		const appliedIds: string[] = [];
		const discardedIds: string[] = [];
		const failedByError = new Map<string, string[]>();

		const getErrorMessage = (error: unknown): string => {
			if (typeof error === "string") return error;
			if (error instanceof Error) return error.message;
			if (error && typeof error === "object") {
				const maybe = error as {
					message?: string;
					data?: { code?: string };
					shape?: { message?: string };
				};
				return (
					maybe.shape?.message ||
					maybe.message ||
					maybe.data?.code ||
					"Unknown passkey mutation flush error"
				);
			}
			return "Unknown passkey mutation flush error";
		};

		const isNonRetriableFailure = (
			mutation: PendingPasskeyMutation,
			errorMessage: string,
		): boolean => {
			const normalized = errorMessage.toLowerCase();
			if (
				normalized.includes("item not found") ||
				normalized.includes("access denied") ||
				normalized.includes("read-only") ||
				normalized.includes("forbidden") ||
				normalized.includes("unauthorized") ||
				normalized.includes("unsupported passkey mutation operation")
			) {
				return true;
			}

			// Local placeholder IDs cannot be updated remotely; once they fail, drop them.
			if (
				mutation.operation === "update_item" &&
				mutation.itemId.startsWith("local_passkey_")
			) {
				return true;
			}
			return false;
		};

		const recordFailure = (mutationId: string, error: unknown) => {
			const message = getErrorMessage(error);
			const ids = failedByError.get(message) ?? [];
			ids.push(mutationId);
			failedByError.set(message, ids);
		};

		for (const mutation of pending as PendingPasskeyMutation[]) {
			const ageMs = Date.now() - mutation.createdAt;
			if (
				mutation.attemptCount >= MAX_PENDING_PASSKEY_ATTEMPTS ||
				ageMs > MAX_PENDING_PASSKEY_AGE_MS
			) {
				discardedIds.push(mutation.id);
				continue;
			}

			const account = accountByUserId.get(mutation.userId);
			if (!account) {
				console.log(
					"[CredentialProviderSync] Skipping passkey mutation flush (account locked or missing):",
					mutation.id,
				);
				continue;
			}

			try {
				if (mutation.operation === "update_item") {
					await account.trpcClient.vault.updateItem.mutate({
						itemId: mutation.itemId,
						encryptedData: mutation.encryptedData,
						encryptionIv: mutation.encryptionIv,
					});
				} else if (mutation.operation === "create_item") {
					await account.trpcClient.vault.createItem.mutate({
						vaultId: mutation.vaultId,
						category: "login",
						encryptedData: mutation.encryptedData,
						encryptionIv: mutation.encryptionIv,
						encryptionAlgorithm: mutation.encryptionAlgorithm || "AES-GCM",
					});
				} else {
					throw new Error(
						`Unsupported passkey mutation operation: ${mutation.operation}`,
					);
				}

				appliedIds.push(mutation.id);
			} catch (error) {
				const message = getErrorMessage(error);
				if (isNonRetriableFailure(mutation, message)) {
					discardedIds.push(mutation.id);
					console.warn(
						"[CredentialProviderSync] Discarding non-retriable passkey mutation:",
						{
							id: mutation.id,
							operation: mutation.operation,
							itemId: mutation.itemId,
							error: message,
						},
					);
				} else {
					recordFailure(mutation.id, message);
				}
			}
		}

		const idsToDelete = [...appliedIds, ...discardedIds];
		if (idsToDelete.length > 0) {
			await CredentialProvider.markPendingPasskeyMutationsApplied(idsToDelete);
		}

		for (const [errorMessage, ids] of failedByError) {
			await CredentialProvider.markPendingPasskeyMutationsFailed(
				ids,
				errorMessage,
			);
		}

		return {
			applied: appliedIds.length,
			failed: Array.from(failedByError.values()).reduce(
				(total, ids) => total + ids.length,
				0,
			),
			discarded: discardedIds.length,
		};
	}, [accountsInfo, isAvailable]);

	const flushPendingPasskeyMutationsAndRefresh = useCallback(async () => {
		const result = await flushPendingPasskeyMutations();
		if (result.applied > 0) {
			await refetchItems();
		}
		return result;
	}, [flushPendingPasskeyMutations, refetchItems]);

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
			const flushResult = await flushPendingPasskeyMutationsAndRefresh();
			if (flushResult.applied > 0 || flushResult.failed > 0) {
				console.log(
					"[CredentialProviderSync] Flushed pending passkey mutations:",
					flushResult,
				);
			}

			// Sync vault data (new unified storage approach)
			console.log("[CredentialProviderSync] Starting vault data sync...");
			const vaultResult = await syncVaultData();
			if (vaultResult) {
				console.log(
					"[CredentialProviderSync] Vault sync complete:",
					vaultResult,
				);
			}

			// Skip legacy credential sync when vault-based sync succeeded.
			// Legacy sync triggers a separate native BiometricPrompt ("Sync Passwords")
			// which causes a redundant second biometric prompt on app startup.
			if (vaultResult) {
				setLastSyncResult({ synced: 0, deleted: 0 });
				return { synced: 0, deleted: 0 };
			}

			// Fallback to legacy sync only when vault sync failed
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
		flushPendingPasskeyMutationsAndRefresh,
	]);

	// Flush provider-generated passkey mutations while app is running.
	// This avoids requiring an app restart before passkey-created items appear and sync remotely.
	useEffect(() => {
		if (!isAvailable || Platform.OS !== "android") {
			return;
		}

		let disposed = false;
		let inFlight = false;

		const flushNow = async (reason: string) => {
			if (disposed || inFlight) return;
			inFlight = true;
			try {
				const result = await flushPendingPasskeyMutationsAndRefresh();
				if (result.applied > 0 || result.failed > 0) {
					console.log(
						`[CredentialProviderSync] Background passkey flush (${reason}):`,
						result,
					);
				}
			} catch (error) {
				console.warn(
					"[CredentialProviderSync] Background passkey flush failed:",
					error,
				);
			} finally {
				inFlight = false;
			}
		};

		void flushNow("mount");

		const appStateSubscription = AppState.addEventListener(
			"change",
			(nextState) => {
				if (nextState === "active") {
					void flushNow("app_active");
				}
			},
		);

		const intervalId = setInterval(() => {
			void flushNow("interval");
		}, 15000);

		return () => {
			disposed = true;
			appStateSubscription.remove();
			clearInterval(intervalId);
		};
	}, [isAvailable, flushPendingPasskeyMutationsAndRefresh]);

	/**
	 * Calculate a hash of items to detect changes
	 */
	const calculateItemsHash = useCallback((): string => {
		const loginItems = items.filter((item) => item.category === "login");
		// Create a simple hash based on item IDs, usernames, passwords, and URLs
		const hashData = loginItems.map((item) => ({
			id: item.id,
			account: item.account?.email,
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
