/**
 * Mobile App Storage Module
 *
 * Two sibling singletons built over the Tauri mobile storage ports and one shared CryptoPort:
 *   - `storage` (`AccountStore`) over the `PlatformPort` (`@tauri-apps/plugin-store` files)
 *   - `itemCache` (`ItemCache`) over the `RecordPort` (`@tauri-apps/plugin-sql` SQLite table)
 *
 * They are siblings, not parent/child: `AccountStore` cannot reach the cache, so every flow
 * that has to drop both (sign-out, account removal, reset) sequences them from the app.
 *
 * Unlike the desktop module this is modelled on, there is **no unlock-broadcast section**.
 * Desktop owns one because it has to tell the Chrome extension it is unlocked, over native
 * messaging. Mobile has no native messaging host and no extension to tell, so there is
 * nothing to broadcast — carrying that section here would not be an omission, it would be
 * dead code pointed at an IPC command that does not exist on this platform.
 */

import {
	type AccountStore,
	createAccountStore,
	createItemCache,
	type ItemCache,
} from "@bittery/storage";
import {
	createTauriMobilePlatformPort,
	createTauriMobileRecordPort,
} from "@bittery/storage/adapters/tauri-mobile";
import { crypto } from "./crypto";

const platformPort = createTauriMobilePlatformPort();
const recordPort = createTauriMobileRecordPort();

export const storage: AccountStore = createAccountStore({
	port: platformPort,
	crypto,
});

export const itemCache: ItemCache = createItemCache({ port: recordPort });

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

let initializePromise: Promise<void> | null = null;

/**
 * Initialize both stores. Must be awaited before any storage use — it loads the Tauri
 * plugins behind the ports and asserts the port honours the tier table.
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
	ItemCache,
	StoredSessionData,
	VaultKeyData,
} from "@bittery/storage";

export {
	BIOMETRIC_GRACE_PERIOD_MS,
	DEFAULT_AUTO_LOCK_TIMEOUT_MS,
	DEFAULT_SESSION_EXPIRY_MS,
} from "@bittery/storage";
