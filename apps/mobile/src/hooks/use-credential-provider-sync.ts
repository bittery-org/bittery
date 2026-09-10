/**
 * When the Android credential replica is asked to catch up.
 *
 * *What* is projected, *how* it is serialized and *when* a generation is sent again
 * all live in `@/lib/credential-replica`. This hook is the subscription half: it
 * probes what the device supports, watches the runtime for changes, asks the
 * projection to run a pass, reports readiness and errors, and tears its listeners
 * down. It builds no payload and knows no field the native side reads.
 *
 * Two platform notes survive from the Expo port, because getting either wrong is
 * silent:
 *
 * **Every credential-provider call is `await`ed.** Six were synchronous in Expo; a
 * `Promise` in a condition is always truthy, so a missed `await` inverts the guard.
 * `pnpm lint:promises` (Biome `nursery/noMisusedPromises`, chained onto `check-types`)
 * is the mechanical check.
 *
 * **`Platform.OS !== "android"` is gone, with no replacement.** It guarded the
 * *plugin*, not the OS, and the plugin only exists in the Android build — a
 * non-Android host fails the availability probe, so `isAvailable` already carries
 * that fact.
 *
 * React Native's `AppState` became `document.visibilityState`: `"active"` maps to
 * `"visible"`, and `AppState.addEventListener("change", …)` to a `visibilitychange`
 * listener. Same two questions, same two answers.
 */

import {
	useAccountsInfo,
	useItems,
	usePlatformSync,
} from "@bittery/core/hooks";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { credentialProvider as CredentialProvider } from "@/lib/credential-provider";
import {
	credentialProjection,
	credentialSyncDebugLog as debugLog,
	fingerprintLoginItems,
} from "@/lib/credential-replica";

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
 * Keep the Android credential replica in step with the vault.
 *
 * Note: the Credential Manager API needs Android 14+ (API 34+); autofill and MUK
 * escrow work from API 26.
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

	const loginItems = useMemo(
		() => items.filter((item) => item.category === "login"),
		[items],
	);

	// What the device supports. Both answers are promises, so the effect resolves
	// them and drops a late answer that arrives after `enabled` flipped.
	useEffect(() => {
		if (!enabled) {
			setIsAvailable(false);
			setIsBiometricAvailable(false);
			return;
		}

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
	 * Hand provider-made passkey writes to the outbound sync queue.
	 *
	 * This runs native → server, not native → app: the projection enqueues the
	 * command and the app refetches only once the queue accepted one, so the
	 * server's answer arrives through normal sync.
	 */
	const flushQueuedVaultWrites = useCallback(async () => {
		if (!enabled || !isAvailable) {
			return { applied: 0, failed: 0, discarded: 0 };
		}

		const result = await credentialProjection.flushQueuedVaultWrites({
			accounts: accountsInfo,
			outbound: platformSync,
		});
		if (result.applied > 0) {
			await refetchItems();
		}
		return result;
	}, [enabled, isAvailable, accountsInfo, platformSync, refetchItems]);

	/**
	 * Ask for a pass. The projection runs one at a time and folds a request that
	 * arrives mid-pass into the pass already running, with the items this request
	 * carries.
	 */
	const sync = useCallback(async (): Promise<{
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

		// No device authentication means no way to protect what the replica serves.
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
			const { projected } = await credentialProjection.runLatestPass({
				accounts: accountsInfo,
				loginItems,
				outbound: platformSync,
				onQueuedWritesApplied: async () => {
					await refetchItems();
				},
			});

			const result = projected
				? { synced: projected.items, deleted: 0 }
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
		accountsInfo,
		loginItems,
		platformSync,
		refetchItems,
	]);

	// Flush provider-made passkey writes while the app runs, so a passkey created
	// in the credential provider reaches the server without an app restart.
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
				const result = await flushQueuedVaultWrites();
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
	}, [enabled, isAvailable, flushQueuedVaultWrites]);

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

		const currentHash = fingerprintLoginItems(loginItems);
		if (currentHash === lastItemsHashRef.current) {
			debugLog("[CredentialProviderSync] Items haven't changed, skipping sync");
			return;
		}

		debugLog("[CredentialProviderSync] Items changed, scheduling sync...");
		lastItemsHashRef.current = currentHash;

		if (debounceTimerRef.current) {
			clearTimeout(debounceTimerRef.current);
		}

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
		loginItems,
		sync,
		debounceMs,
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
