/**
 * Mobile Autolock Service
 *
 * Implements IAutolockService for React Native using:
 * - AppState API for background/foreground detection
 * - Background timestamp for tracking time spent in background
 *
 * Note: This service uses React Native's AppState which must be imported
 * dynamically since this package may be bundled for web as well.
 * Types are defined inline to avoid requiring react-native as a dependency.
 */

import type { AccountStore } from "@bittery/storage";
import type { IAutolockService } from "@bittery/types";

/**
 * Should the app re-authenticate after coming back from the background?
 *
 * This is autolock *policy*, so it lives here rather than in storage: `AccountStore`
 * supplies the two facts (when we went to background, and the account's auto-lock
 * timeout) and this function decides, including the two fail-open cases:
 *
 *  - no background timestamp recorded -> never require re-auth;
 *  - a timeout of `-1` means "Never", so it never requires re-auth however long the app
 *    was backgrounded.
 */
async function shouldRequireAuthAfterBackground(
	storage: AccountStore,
	accountId?: string,
): Promise<boolean> {
	const backgroundTimestamp = await storage.getBackgroundTimestamp(accountId);
	if (!backgroundTimestamp) return false;

	const autoLockTimeout = await storage.getAutoLockTimeoutOrDefault(accountId);
	if (autoLockTimeout === -1) return false;

	return Date.now() - backgroundTimestamp > autoLockTimeout;
}

/**
 * App state type matching React Native's AppStateStatus
 * Defined inline to avoid requiring react-native types
 */
type AppStateStatus =
	| "active"
	| "background"
	| "inactive"
	| "unknown"
	| "extension";

/**
 * Minimal AppState interface for type safety
 * Matches React Native's AppState module
 */
interface AppStateModule {
	currentState: AppStateStatus;
	addEventListener(
		type: "change",
		handler: (state: AppStateStatus) => void,
	): { remove: () => void };
}

/**
 * Options for creating the mobile autolock service
 */
export interface MobileAutolockOptions {
	/** Account store; the background-timestamp methods are total on every platform. */
	storage: AccountStore;
	/** Optional: Get the active account email for multi-account support */
	getActiveAccountId?: () => Promise<string | undefined>;
}

/**
 * Create a mobile autolock service instance
 *
 * @param options - Configuration options including storage adapter
 * @returns IAutolockService instance
 */
export function createMobileAutolockService(
	options: MobileAutolockOptions,
): IAutolockService {
	const { storage, getActiveAccountId } = options;

	let isInitialized = false;
	let isDisposed = false;
	let currentAppState: AppStateStatus = "active";
	let appStateSubscription: { remove: () => void } | null = null;
	const lockCallbacks: Set<() => void> = new Set();

	// Get the account scope to use for storage operations
	const getAccountId = async (): Promise<string | undefined> => {
		if (getActiveAccountId) {
			return getActiveAccountId();
		}
		const active = await storage.getActiveAccount();
		return active ?? undefined;
	};

	const clearBackgroundTimestamps = async (): Promise<void> => {
		const accountId = await getAccountId();
		await storage.clearBackgroundTimestamp(accountId);
	};

	// Handle app state changes
	const handleAppStateChange = async (nextAppState: AppStateStatus) => {
		if (isDisposed) return;

		// App is going to background
		if (
			currentAppState === "active" &&
			(nextAppState === "background" || nextAppState === "inactive")
		) {
			const accountId = await getAccountId();
			await storage.storeBackgroundTimestamp(accountId);
		}

		// App is coming back to foreground
		if (
			(currentAppState === "background" || currentAppState === "inactive") &&
			nextAppState === "active"
		) {
			const shouldLockNow = await shouldLock();
			if (shouldLockNow) {
				await lock();
			}
			// Clear the background timestamp after handling
			await clearBackgroundTimestamps();
		}

		currentAppState = nextAppState;
	};

	// Check if lock is required
	const shouldLock = async (): Promise<boolean> => {
		if (isDisposed) return false;
		const accountId = await getAccountId();
		return shouldRequireAuthAfterBackground(storage, accountId);
	};

	// Execute lock
	const lock = async (): Promise<void> => {
		if (isDisposed) return;

		const accountId = await getAccountId();
		await storage.clearMasterUnlockKey(accountId);
		await storage.clearBackgroundTimestamp(accountId);

		// Notify all callbacks
		for (const callback of lockCallbacks) {
			try {
				callback();
			} catch (error) {
				console.error("Error in lock callback:", error);
			}
		}
	};

	return {
		async initialize(): Promise<void> {
			if (isInitialized || isDisposed) return;

			isInitialized = true;

			// Dynamically require React Native AppState
			// This allows the service to be bundled without React Native being present
			// Using globalThis check and dynamic require to avoid bundler issues
			try {
				// Check if we're in a React Native environment
				const requireFn = (globalThis as any).require;
				if (typeof requireFn === "function") {
					const reactNative = requireFn("react-native") as any;
					const AppState = reactNative?.AppState as AppStateModule | undefined;
					if (AppState) {
						currentAppState = AppState.currentState;

						// Subscribe to app state changes
						appStateSubscription = AppState.addEventListener(
							"change",
							handleAppStateChange,
						);
					}
				}
			} catch {
				// React Native not available (running in web context)
				console.warn(
					"Mobile autolock service: React Native AppState not available",
				);
			}
		},

		recordActivity(): void {
			// No-op for mobile - we track background time, not activity
			// Mobile uses background timestamp pattern instead of activity-based timeout
		},

		shouldLock,

		lock,

		onLock(callback: () => void): () => void {
			lockCallbacks.add(callback);
			return () => {
				lockCallbacks.delete(callback);
			};
		},

		async getTimeout(): Promise<number> {
			return storage.getAutoLockTimeoutOrDefault();
		},

		async setTimeout(ms: number): Promise<void> {
			await storage.storeAutoLockTimeout(ms);
		},

		dispose(): void {
			if (isDisposed) return;
			isDisposed = true;

			// Remove app state listener
			if (appStateSubscription) {
				appStateSubscription.remove();
				appStateSubscription = null;
			}

			// Clear callbacks
			lockCallbacks.clear();
		},
	};
}
