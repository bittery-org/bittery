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

import type { IStorageAdapter } from "@bittery/storage/adapter";
import type { IAutolockService } from "../types";

/**
 * Extended storage adapter interface for mobile-specific methods
 * These methods are available on ReactNativeStorageAdapter
 */
interface MobileStorageAdapter extends IStorageAdapter {
	storeBackgroundTimestamp(email?: string): Promise<void>;
	getBackgroundTimestamp(email?: string): Promise<number | null>;
	clearBackgroundTimestamp(email?: string): Promise<void>;
	shouldRequireAuthAfterBackground(email?: string): Promise<boolean>;
}

/**
 * App state type matching React Native's AppStateStatus
 * Defined inline to avoid requiring react-native types
 */
type AppStateStatus = "active" | "background" | "inactive" | "unknown" | "extension";

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
	/** Storage adapter with mobile-specific methods */
	storage: MobileStorageAdapter;
	/** Optional: Get the active account email for multi-account support */
	getActiveEmail?: () => Promise<string | undefined>;
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
	const { storage, getActiveEmail } = options;

	let isInitialized = false;
	let isDisposed = false;
	let currentAppState: AppStateStatus = "active";
	let appStateSubscription: { remove: () => void } | null = null;
	const lockCallbacks: Set<() => void> = new Set();

	// Get the email to use for storage operations
	const getEmail = async (): Promise<string | undefined> => {
		if (getActiveEmail) {
			return getActiveEmail();
		}
		return undefined;
	};

	// Handle app state changes
	const handleAppStateChange = async (nextAppState: AppStateStatus) => {
		if (isDisposed) return;

		const email = await getEmail();

		// App is going to background
		if (
			currentAppState === "active" &&
			(nextAppState === "background" || nextAppState === "inactive")
		) {
			await storage.storeBackgroundTimestamp(email);
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
			await storage.clearBackgroundTimestamp(email);
		}

		currentAppState = nextAppState;
	};

	// Check if lock is required
	const shouldLock = async (): Promise<boolean> => {
		if (isDisposed) return false;
		const email = await getEmail();
		return storage.shouldRequireAuthAfterBackground(email);
	};

	// Execute lock
	const lock = async (): Promise<void> => {
		if (isDisposed) return;

		const email = await getEmail();

		// Clear MUK from storage
		await storage.clearMasterUnlockKey(email);

		// Clear background timestamp
		await storage.clearBackgroundTimestamp(email);

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
				// biome-ignore lint/suspicious/noExplicitAny: Dynamic require for RN compatibility
				const requireFn = (globalThis as any).require;
				if (typeof requireFn === "function") {
					// biome-ignore lint/suspicious/noExplicitAny: Dynamic require for RN compatibility
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
