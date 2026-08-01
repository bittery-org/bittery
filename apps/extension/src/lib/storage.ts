/**
 * Extension Storage Module
 *
 * Two sibling singletons built over the two chrome ports:
 *   - `storage` (`AccountStore`) over the `PlatformPort` (`chrome.storage.local` /
 *     `chrome.storage.session`)
 *   - `itemCache` (`ItemCache`) over the `RecordPort` (IndexedDB `bittery_records`)
 *
 * They are siblings, not parent/child: `AccountStore` holds only a `PlatformPort` and can
 * never reach the cache, so every flow that has to drop both (sign-out, account removal)
 * sequences them from the app.
 *
 * **Behaviour change to be aware of at every call site:** the chrome port declares
 * `sessionSurvivesRestart: false`, so the session-bound values (`jwt_token`, `vault_keys`,
 * `encrypted_private_key`) live in `chrome.storage.session`. That store survives a *service
 * worker* restart but not a *browser* restart. `session_data` and `secret_key` are
 * device-bound and live in `chrome.storage.local`, so quick-unlock still works after the
 * browser restarts — see `handleCanQuickUnlock` in `background/auth-handlers.ts`.
 *
 * This module is imported from both the service worker and the popup. Each JS context gets
 * its own `AccountStore`, and therefore its own in-memory master-unlock-key cache. That is
 * safe here because every unlock in this extension is routed through the service worker via
 * `chrome.runtime.sendMessage` — the popup only ever reads.
 */

import {
	type AccountStore,
	createAccountStore,
	createItemCache,
	type ItemCache,
} from "@bittery/storage";
import {
	createChromePlatformPort,
	createChromeRecordPort,
} from "@bittery/storage/adapters/chrome";
import { decrypt, encrypt, rsaDecrypt } from "./wasm-crypto";

// The extension has no key-handle crypto backend, so the three required methods are the
// whole provider. Everything else on `CryptoProvider` is genuinely absent here.
const cryptoProvider = { encrypt, decrypt, rsaDecrypt };

const platformPort = createChromePlatformPort();
const recordPort = createChromeRecordPort();

export const storage: AccountStore = createAccountStore({
	port: platformPort,
	crypto: cryptoProvider,
});

export const itemCache: ItemCache = createItemCache({ port: recordPort });

let initializePromise: Promise<void> | null = null;

/**
 * Initialize both stores exactly once per JS context.
 *
 * Awaited from the background bootstrap (`services/service-worker-lifecycle.ts`) and from
 * the popup's root route, which runs ahead of every other route guard and loader. Safe to
 * call any number of times; subsequent calls await the same promise. MV3 tears the service
 * worker's module state down on recycle, so this legitimately runs again on every wake.
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
	ItemCache,
	StoredSessionData,
	VaultKeyData,
} from "@bittery/storage";

export { DEFAULT_AUTO_LOCK_TIMEOUT_MS } from "@bittery/storage";
