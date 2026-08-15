/**
 * Ported line for line from `apps/mobile/src/hooks/use-credential-provider-sync.ts`.
 *
 * The signature functions, the per-account bookkeeping, the ordering of every guard, the
 * passkey writeback loop and the error handling are unchanged: this hook decides what key
 * material reaches a *separate Android process*, so a behaviour change here is a security
 * change. Only the platform seams were rewritten, and they are all listed here.
 *
 * **Every credential-provider call is now `await`ed.** Six of them were synchronous in
 * Expo (`isAvailable`, `isBiometricAvailable`, and their siblings on the read-only
 * surface); a `Promise` in a condition is always truthy, so a missed `await` inverts the
 * guard silently. `pnpm lint:promises` (Biome `nursery/noMisusedPromises`, chained onto
 * `check-types`) is the mechanical check that none were missed.
 *
 * **`Platform.OS !== "android"` is gone, with no replacement.** It guarded the *plugin*,
 * not the OS, and the plugin only exists in the Android build — a non-Android host fails
 * the availability probe and `isAvailable()` answers `false`. The `isAvailable` state
 * below already carries that fact, so every `Platform.OS !== "android" || !isAvailable`
 * pair collapses to `!isAvailable`.
 *
 * **React Native's `AppState` became `document.visibilityState`.** `"active"` maps to
 * `"visible"`, and `AppState.addEventListener("change", …)` to a `visibilitychange`
 * listener. Same two questions, same two answers.
 *
 * **`InteractionManager.runAfterInteractions` became `requestIdleCallback`.** Both mean
 * "not while the user is mid-gesture"; neither is load-bearing for correctness.
 *
 * **`syncVaultData` throwing is now a real outcome.** The bridge's mutating commands
 * reject when the plugin is absent instead of fabricating a zero-count success. The
 * signature is recorded only *after* the await resolves, so a throw leaves the account
 * unrecorded and the next pass retries it — which is the whole reason the bridge throws.
 */

import {
	useAccountsInfo,
	useItems,
	usePlatformSync,
} from "@bittery/core/hooks";
import { createNativeItemSyncCommand } from "@bittery/sync";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	credentialProvider as CredentialProvider,
	type PendingPasskeyMutation,
} from "@/lib/credential-provider";
import { mirrorBorrowedMasterUnlockKeysToCredentialProvider } from "@/lib/credential-provider-master-unlock-key";
import { storage } from "@/lib/storage";

const MAX_PENDING_PASSKEY_ATTEMPTS = 5;
const MAX_PENDING_PASSKEY_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Expo gated this on `__DEV__ && EXPO_PUBLIC_CREDENTIAL_SYNC_DEBUG === "true"`. Vite has
 * no `__DEV__`, and `import.meta.env.DEV` is false in the `--debug` APK — that build still
 * runs `vite build` in production mode — so the `&&` would make these logs unreachable on
 * a device. The opt-in half is what mattered: off unless someone builds with the flag.
 */
const CREDENTIAL_SYNC_DEBUG =
	import.meta.env.VITE_CREDENTIAL_SYNC_DEBUG === "true";

function hashString(input: string): number {
	let hash = 0;
	for (let i = 0; i < input.length; i++) {
		hash = (hash * 31 + input.charCodeAt(i)) | 0;
	}
	return hash;
}

function buildLoginItemsSignature(
	loginItems: Array<{
		id: string;
		vaultId: string;
		updatedAt: string | number | Date;
		version?: number;
	}>,
): string {
	let idHash = 0;
	let vaultHash = 0;
	let updatedAtHash = 0;
	let versionSum = 0;

	for (const item of loginItems) {
		idHash ^= hashString(item.id);
		vaultHash ^= hashString(item.vaultId);
		updatedAtHash ^= hashString(String(item.updatedAt));
		versionSum += item.version ?? 1;
	}

	return `${loginItems.length}:${idHash}:${vaultHash}:${updatedAtHash}:${versionSum}`;
}

function buildVaultKeysSignature(
	vaultKeys: Array<{
		vaultId: string;
		encryptedVaultKey: string;
		role: string;
	}>,
): string {
	let vaultIdHash = 0;
	let keyHash = 0;
	let roleHash = 0;

	for (const vaultKey of vaultKeys) {
		vaultIdHash ^= hashString(vaultKey.vaultId);
		keyHash ^= hashString(vaultKey.encryptedVaultKey);
		roleHash ^= hashString(vaultKey.role);
	}

	return `${vaultKeys.length}:${vaultIdHash}:${keyHash}:${roleHash}`;
}

function debugLog(message: string, payload?: unknown) {
	if (!CREDENTIAL_SYNC_DEBUG) {
		return;
	}
	if (typeof payload === "undefined") {
		console.log(message);
		return;
	}
	console.log(message, payload);
}

/** The `AppState.currentState === "active"` question, asked of a WebView. */
function isAppForegrounded(): boolean {
	return (
		typeof document === "undefined" || document.visibilityState === "visible"
	);
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
	} = useItems({ enabled });
	const { accountsInfo } = useAccountsInfo({ enabled });
	const platformSync = usePlatformSync();

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
	const syncInFlightRef = useRef(false);
	const pendingSyncRef = useRef(false);
	const lastVaultSyncSignatureByAccountRef = useRef<Map<string, string>>(
		new Map(),
	);

	const loginItems = useMemo(
		() => items.filter((item) => item.category === "login"),
		[items],
	);

	// Check if credential provider and biometric/device auth are available
	useEffect(() => {
		if (!enabled) {
			setIsAvailable(false);
			setIsBiometricAvailable(false);
			return;
		}

		// The Expo version answered both questions synchronously and short-circuited on
		// `Platform.OS !== "android"` first. Both answers are promises now, so the effect
		// resolves them and drops a late answer that arrives after `enabled` flipped.
		let cancelled = false;
		void (async () => {
			const [credentialProviderAvailable, biometricAvailable] =
				await Promise.all([
					CredentialProvider.isAvailable(),
					CredentialProvider.isBiometricAvailable(),
				]);
			if (cancelled) {
				return;
			}
			debugLog("[CredentialProviderSync] Availability check:", {
				credentialProviderAvailable,
				biometricAvailable,
			});

			setIsAvailable(credentialProviderAvailable);
			setIsBiometricAvailable(biometricAvailable);
		})();

		return () => {
			cancelled = true;
		};
	}, [enabled]);

	/**
	 * Ensure the MUK is set in the native VaultStateManager.
	 * This enables on-demand decryption in the credential provider service.
	 */
	const ensureNativeMukSet = useCallback(async () => {
		if (!enabled || !isAvailable) return;

		try {
			const unlockedAccountIds = await storage.getUnlockedAccounts();
			debugLog(
				"[CredentialProviderSync] ensureNativeMukSet: unlockedAccountIds=",
				unlockedAccountIds,
			);
			if (unlockedAccountIds.length === 0) {
				console.warn(
					"[CredentialProviderSync] ensureNativeMukSet: No unlocked accounts found in RN storage!",
				);
				return;
			}

			await mirrorBorrowedMasterUnlockKeysToCredentialProvider(
				unlockedAccountIds,
			);

			debugLog("[CredentialProviderSync] Native MUKs set from RN storage");
		} catch (err) {
			console.warn("[CredentialProviderSync] Failed to set native MUK:", err);
		}
	}, [enabled, isAvailable]);

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
		debugLog("[CredentialProviderSync] syncVaultData() called");

		if (!enabled || !isAvailable) {
			debugLog("[CredentialProviderSync] Vault sync skipped: not available");
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
			const seenAccountIds = new Set<string>();

			for (const account of accountsInfo) {
				seenAccountIds.add(account.accountId);
				const [vaultKeys, secretKey, kdfProfile] = await Promise.all([
					storage.getVaultKeys(account.accountId),
					storage.getStoredSecretKey(account.accountId),
					storage.getPinnedKdfProfile(account.accountId),
				]);
				if (!vaultKeys || vaultKeys.length === 0) {
					lastVaultSyncSignatureByAccountRef.current.delete(account.accountId);
					continue;
				}
				if (!secretKey || !kdfProfile) {
					throw new Error(
						`Credential-provider sync requires reauthentication for account ${account.accountId}`,
					);
				}

				const vaultIdsWithKeys = new Set(vaultKeys.map((vk) => vk.vaultId));

				const accountLoginItems = loginItems.filter(
					(item) =>
						item.accountId === account.accountId &&
						vaultIdsWithKeys.has(item.vaultId),
				);

				const vaultKeysSignature = buildVaultKeysSignature(vaultKeys);
				const accountItemsSignature =
					buildLoginItemsSignature(accountLoginItems);
				const nextSignature = `${vaultKeysSignature}|${accountItemsSignature}|${kdfProfile.schemaVersion}:${kdfProfile.algorithm}:${kdfProfile.iterations}`;
				const previousSignature =
					lastVaultSyncSignatureByAccountRef.current.get(account.accountId);

				if (previousSignature === nextSignature) {
					continue;
				}

				const itemsData = accountLoginItems
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
							version: item.version,
							lastModifiedBy: item.lastModifiedBy ?? null,
							encryptionVersion: item.encryptionVersion,
							encryptedByUserId: item.encryptedByUserId,
						};
					});

				const vaultKeysData = vaultKeys.map((vaultKey) => {
					if (!vaultKey.encryptedVaultKey.startsWith("{")) {
						return {
							vaultId: vaultKey.vaultId,
							vaultName: vaultKey.vaultName,
							vaultType: vaultKey.vaultType,
							encryptedKey: vaultKey.encryptedVaultKey,
							encryptionIv: "",
							encryptionAlgorithm: "RSA-OAEP",
							role: vaultKey.role,
							keyVersion: 1,
						};
					}

					const parsed = JSON.parse(vaultKey.encryptedVaultKey) as {
						ciphertext?: unknown;
						iv?: unknown;
						algorithm?: unknown;
						context?: {
							vaultId?: unknown;
							userId?: unknown;
							keyVersion?: unknown;
							purpose?: unknown;
						};
					};
					if (
						typeof parsed.ciphertext !== "string" ||
						typeof parsed.iv !== "string" ||
						parsed.algorithm !== "AES-GCM-AAD-V1" ||
						parsed.context?.vaultId !== vaultKey.vaultId ||
						parsed.context.userId !== account.userId ||
						parsed.context.purpose !== "vault-key-wrap" ||
						typeof parsed.context.keyVersion !== "number" ||
						!Number.isInteger(parsed.context.keyVersion) ||
						parsed.context.keyVersion < 1
					) {
						throw new Error(
							`Invalid wrapped vault key for ${vaultKey.vaultId}`,
						);
					}

					return {
						vaultId: vaultKey.vaultId,
						vaultName: vaultKey.vaultName,
						vaultType: vaultKey.vaultType,
						encryptedKey: parsed.ciphertext,
						encryptionIv: parsed.iv,
						encryptionAlgorithm: parsed.algorithm,
						role: vaultKey.role,
						keyVersion: parsed.context.keyVersion,
					};
				});

				const syncData = {
					userId: account.userId,
					email: account.email,
					secretKey,
					kdfProfile,
					vaultKeys: vaultKeysData,
					items: itemsData,
				};

				// The signature is recorded *after* this resolves, never before. An absent
				// plugin rejects here rather than fabricating `{vaultKeys: 0, items: 0}`,
				// and the throw must leave this account unrecorded so the next pass retries.
				const result = await CredentialProvider.syncVaultData(
					JSON.stringify(syncData),
				);
				lastVaultSyncSignatureByAccountRef.current.set(
					account.accountId,
					nextSignature,
				);

				totals.vaultKeys += result?.vaultKeys ?? vaultKeysData.length;
				totals.items += result?.items ?? itemsData.length;
				totals.domains += result?.domains ?? 0;
			}

			for (const accountId of Array.from(
				lastVaultSyncSignatureByAccountRef.current.keys(),
			)) {
				if (!seenAccountIds.has(accountId)) {
					lastVaultSyncSignatureByAccountRef.current.delete(accountId);
				}
			}

			debugLog("[CredentialProviderSync] Vault sync totals:", totals);
			return totals;
		} catch (err) {
			console.error("[CredentialProviderSync] Vault sync failed:", err);
			return null;
		}
	}, [enabled, accountsInfo, ensureNativeMukSet, isAvailable, loginItems]);

	/**
	 * Flush provider-side passkey mutations to server before inbound vault sync.
	 * This prevents local passkey writes from being overwritten by pull sync.
	 */
	const flushPendingPasskeyMutations = useCallback(async (): Promise<{
		applied: number;
		failed: number;
		discarded: number;
	}> => {
		if (!enabled || !isAvailable) {
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

		for (const mutation of pending) {
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
				debugLog(
					"[CredentialProviderSync] Skipping passkey mutation flush (account locked or missing):",
					mutation.id,
				);
				continue;
			}

			try {
				if (!platformSync) {
					throw new Error("Item sync engine is unavailable");
				}
				const command = createNativeItemSyncCommand(mutation, {
					accountId: account.accountId,
					accountEmail: account.email,
				});
				await platformSync.outboundQueue.enqueue(command);
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
	}, [enabled, accountsInfo, isAvailable, platformSync]);

	const flushPendingPasskeyMutationsAndRefresh = useCallback(async () => {
		const result = await flushPendingPasskeyMutations();
		if (result.applied > 0) {
			await refetchItems();
		}
		return result;
	}, [flushPendingPasskeyMutations, refetchItems]);

	const waitForInteractionsToFinish = useCallback(async () => {
		await new Promise<void>((resolve) => {
			// `InteractionManager.runAfterInteractions` has no WebView equivalent;
			// `requestIdleCallback` carries the same intent — don't start heavy work while
			// the main thread is busy — and falls back to a macrotask where it is missing.
			if (typeof requestIdleCallback === "function") {
				requestIdleCallback(() => resolve(), { timeout: 500 });
				return;
			}
			setTimeout(resolve, 0);
		});
	}, []);

	/** Sync encrypted vault data and flush provider-originated passkey writes. */
	const syncOnce = useCallback(async (): Promise<{
		synced: number;
		deleted: number;
	} | null> => {
		debugLog("[CredentialProviderSync] sync() called", {
			isAvailable,
			isBiometricAvailable,
		});

		if (!enabled || !isAvailable) {
			debugLog(
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
			// Defer heavy sync work until gestures/animations settle to keep UI smooth.
			await waitForInteractionsToFinish();

			const flushResult = await flushPendingPasskeyMutationsAndRefresh();
			if (flushResult.applied > 0 || flushResult.failed > 0) {
				debugLog(
					"[CredentialProviderSync] Flushed pending passkey mutations:",
					flushResult,
				);
			}

			// Sync vault data (new unified storage approach)
			debugLog("[CredentialProviderSync] Starting vault data sync...");
			const vaultResult = await syncVaultData();
			if (vaultResult) {
				debugLog("[CredentialProviderSync] Vault sync complete:", vaultResult);
			}

			const result = vaultResult
				? { synced: vaultResult.items, deleted: 0 }
				: { synced: 0, deleted: 0 };
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
		enabled,
		isAvailable,
		isBiometricAvailable,
		syncVaultData,
		flushPendingPasskeyMutationsAndRefresh,
		waitForInteractionsToFinish,
	]);

	const sync = useCallback(async (): Promise<{
		synced: number;
		deleted: number;
	} | null> => {
		if (syncInFlightRef.current) {
			pendingSyncRef.current = true;
			return null;
		}

		syncInFlightRef.current = true;
		let latestResult: { synced: number; deleted: number } | null = null;

		try {
			do {
				pendingSyncRef.current = false;
				latestResult = await syncOnce();
			} while (pendingSyncRef.current);

			return latestResult;
		} finally {
			syncInFlightRef.current = false;
		}
	}, [syncOnce]);

	// Flush provider-generated passkey mutations while app is running.
	// This avoids requiring an app restart before passkey-created items appear and sync remotely.
	useEffect(() => {
		if (!enabled || !isAvailable) {
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
					debugLog(
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

		const handleVisibilityChange = () => {
			if (isAppForegrounded()) {
				void flushNow("app_active");
			}
		};
		document.addEventListener("visibilitychange", handleVisibilityChange);

		const intervalMs = import.meta.env.DEV ? 120000 : 60000;
		const intervalId = setInterval(() => {
			void flushNow("interval");
		}, intervalMs);

		return () => {
			disposed = true;
			document.removeEventListener("visibilitychange", handleVisibilityChange);
			clearInterval(intervalId);
		};
	}, [enabled, isAvailable, flushPendingPasskeyMutationsAndRefresh]);

	/**
	 * Calculate a hash of items to detect changes
	 */
	const calculateItemsHash = useCallback((): string => {
		return buildLoginItemsSignature(loginItems);
	}, [loginItems]);

	// Auto-sync when items change (debounced)
	useEffect(() => {
		debugLog("[CredentialProviderSync] Auto-sync effect triggered", {
			enabled,
			autoSync,
			isAvailable,
			isBiometricAvailable,
			isLoadingItems,
			itemCount: loginItems.length,
			foregrounded: isAppForegrounded(),
		});

		if (
			!enabled ||
			!autoSync ||
			!isAvailable ||
			!isBiometricAvailable ||
			isLoadingItems ||
			!isAppForegrounded()
		) {
			debugLog("[CredentialProviderSync] Auto-sync skipped due to conditions");
			return;
		}

		const currentHash = calculateItemsHash();

		// Skip if items haven't changed
		if (currentHash === lastItemsHashRef.current) {
			debugLog("[CredentialProviderSync] Items haven't changed, skipping sync");
			return;
		}

		debugLog("[CredentialProviderSync] Items changed, scheduling sync...");
		lastItemsHashRef.current = currentHash;

		// Clear existing timer
		if (debounceTimerRef.current) {
			clearTimeout(debounceTimerRef.current);
		}

		// Set debounced sync
		debounceTimerRef.current = setTimeout(() => {
			debugLog("[CredentialProviderSync] Debounce timer fired, starting sync");
			void sync();
		}, debounceMs);

		// No cleanup that clears the timer. The Expo original returned one, and on this
		// platform it starves the sync outright — measured on the emulator: the effect
		// schedules the timer, `accountsInfo` resolves a few hundred ms later with a new
		// array identity (`useAccountsInfo` sets `structuralSharing: false`, so every
		// resolution is a new reference), that re-runs the effect, React fires the cleanup
		// and cancels the pending timer, and the re-run hits `currentHash ===
		// lastItemsHashRef.current` and returns without scheduling a replacement. The
		// debounce never fires and nothing ever reaches the provider.
		//
		// Debounce coalescing is unaffected: the `clearTimeout` above still collapses
		// repeat schedules into one. Only the unmount clear is needed, and it is its own
		// effect below.
	}, [
		enabled,
		autoSync,
		isAvailable,
		isBiometricAvailable,
		isLoadingItems,
		calculateItemsHash,
		sync,
		debounceMs,
		loginItems.length,
	]);

	// Drop a pending debounce when the hook goes away, and only then.
	useEffect(
		() => () => {
			if (debounceTimerRef.current) {
				clearTimeout(debounceTimerRef.current);
			}
		},
		[],
	);

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
	};
}
