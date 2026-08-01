/**
 * Mobile Storage Service
 *
 * Two sibling singletons built over the two React Native ports:
 *   - `storage` (`AccountStore`) over the `PlatformPort` (expo-secure-store + sqlite `kv_store`)
 *   - `itemCache` (`ItemCache`) over the `RecordPort` (sqlite `records`, one row per record)
 *
 * They are siblings, not parent/child: `AccountStore` holds only a `PlatformPort` and can
 * never reach the cache, so every flow that has to drop both (sign-out, account removal)
 * sequences them from the app.
 */

// `AccountStore` mints the 32-byte `device_key` with `globalThis.crypto.getRandomValues`.
// Hermes does not implement WebCrypto, React Native 0.81 installs no `crypto` global, and
// Expo SDK 54's winter runtime (`expo/src/winter/runtime.native.ts`) installs `TextDecoder`,
// `URL`, `structuredClone` and friends but **not** `crypto`. Without this polyfill the very
// first session write on a real device throws
// `TypeError: Cannot read property 'getRandomValues' of undefined`.
//
// The import must stay above the `@bittery/storage` import: it installs the global as a side
// effect, and `createAccountStore` is called at module scope below.
import "react-native-get-random-values";

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
import { decrypt, encrypt, rsaDecrypt } from "../lib/crypto/native-crypto";

// The mobile crypto backend has no key handles, so the three required methods are the whole
// provider. Everything else on `CryptoProvider` is genuinely absent here.
const cryptoProvider = { encrypt, decrypt, rsaDecrypt };

const platformPort = createReactNativePlatformPort();
const recordPort = createReactNativeRecordPort();

export const storage: AccountStore = createAccountStore({
	port: platformPort,
	crypto: cryptoProvider,
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
	ActiveAccount,
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
