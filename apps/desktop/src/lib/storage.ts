/**
 * Desktop App Storage Module
 *
 * Two sibling singletons built over the two Tauri ports:
 *   - `storage` (`AccountStore`) over the `PlatformPort` (OS keychain + `store.json`)
 *   - `itemCache` (`ItemCache`) over the `RecordPort` (`store.json` `record:` keys)
 *
 * They are siblings, not parent/child: `AccountStore` holds only a `PlatformPort` and can
 * never reach the cache, so every flow that has to drop both (sign-out, account removal,
 * reset) sequences them from the app.
 *
 * This module also owns the **unlock broadcast**. `AccountStore` performs no IPC: it emits
 * `onUnlockStateChanged` and the desktop app does the `invoke("broadcast_unlock_event")`
 * itself.
 */

import { m } from "@bittery/i18n/paraglide/messages";
import {
	type AccountStore,
	createAccountStore,
	createItemCache,
	type ItemCache,
} from "@bittery/storage";
import {
	createTauriPlatformPort,
	createTauriRecordPort,
} from "@bittery/storage/adapters/tauri";
import { toast } from "@bittery/ui";
import { invoke } from "@tauri-apps/api/core";
import { decrypt, encrypt, rsaDecrypt } from "./tauri-crypto";

// The desktop crypto backend has no key handles, so the three required methods are the
// whole provider. Everything else on `CryptoProvider` is genuinely absent here.
const cryptoProvider = { encrypt, decrypt, rsaDecrypt };

const platformPort = createTauriPlatformPort();
const recordPort = createTauriRecordPort();

export const storage: AccountStore = createAccountStore({
	port: platformPort,
	crypto: cryptoProvider,
});

export const itemCache: ItemCache = createItemCache({ port: recordPort });

// ---------------------------------------------------------------------------
// Unlock broadcast
// ---------------------------------------------------------------------------

/**
 * The extension learns that the desktop app is unlocked over this IPC and nothing else, so
 * a failure is a real, user-visible degradation rather than a debug detail. It is reported
 * through the app's normal error channel (a toast) *and* logged with a distinct tag.
 */
function reportUnlockBroadcastFailure(error: unknown): void {
	console.error(
		'[storage] invoke("broadcast_unlock_event") failed; the browser extension will not learn about this unlock:',
		error,
	);
	toast.error(m.toast_desktop_unlock_broadcast_failed());
}

let unsubscribeUnlockBroadcast: (() => void) | null = null;

/**
 * Registered from the memoised initializer below, so it happens exactly once per module
 * instance and strictly before the first unlock can occur (`initializeStorage()` is awaited
 * in `main.tsx` ahead of the first render). `initialize()` itself never notifies listeners,
 * so subscribing first cannot produce a spurious broadcast.
 */
function subscribeUnlockBroadcast(): void {
	if (unsubscribeUnlockBroadcast) {
		return;
	}
	unsubscribeUnlockBroadcast = storage.onUnlockStateChanged((accounts) => {
		void invoke("broadcast_unlock_event", { accounts }).catch(
			reportUnlockBroadcastFailure,
		);
	});
}

// A hot replacement of this module mints a fresh `AccountStore`, so drop the old listener
// with the old module rather than leaving two broadcasters alive.
if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		unsubscribeUnlockBroadcast?.();
		unsubscribeUnlockBroadcast = null;
	});
}

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
		subscribeUnlockBroadcast();
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
