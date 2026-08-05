/**
 * Mobile Storage Service
 *
 * Two sibling singletons built over the two React Native ports:
 *   - `storage` (`AccountStore`) over the `PlatformPort` and `CryptoPort`
 *   - `itemCache` (`ItemCache`) over the `RecordPort` (sqlite `records`, one row per record)
 *
 * They are siblings, not parent/child: `AccountStore` can never reach the cache, so every
 * flow that has to drop both (sign-out, account removal)
 * sequences them from the app.
 */

import {
	type AccountStore,
	createAccountStore,
	createItemCache,
	type ItemCache,
} from "@bittery/storage";
import {
	createReactNativePlatformPort,
	createReactNativeRecordPort,
} from "@bittery/storage/adapters/react-native";
import { crypto } from "../lib/crypto";

const platformPort = createReactNativePlatformPort();
const recordPort = createReactNativeRecordPort();

export const storage: AccountStore = createAccountStore({
	port: platformPort,
	crypto,
});

export const itemCache: ItemCache = createItemCache({ port: recordPort });

let initializePromise: Promise<void> | null = null;

/**
 * Initialize both stores. Must be awaited before any storage use — it opens the sqlite
 * database and the secure store behind the ports and asserts the port honours the tier
 * table.
 *
 * Safe to call any number of times; subsequent calls await the same promise.
 */
export async function initializeStorage(): Promise<void> {
	initializePromise ??= (async () => {
		await storage.initialize();
		await itemCache.initialize();
	})();
	return initializePromise;
}

// Re-export types and constants for convenience
export type {
	AccountMetadata,
	AccountStore,
	ActiveAccountId,
	BiometricAuthResult,
	BiometricErrorType,
	ItemCache,
	StoredSessionData,
	VaultKeyData,
} from "@bittery/storage";

export {
	BIOMETRIC_GRACE_PERIOD_MS,
	DEFAULT_AUTO_LOCK_TIMEOUT_MS,
	DEFAULT_SESSION_EXPIRY_MS,
} from "@bittery/storage";
