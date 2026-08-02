/**
 * Web App Storage Module
 *
 * Two sibling singletons built over the two web ports:
 *   - `storage` (`AccountStore`) over the `PlatformPort`
 *   - `itemCache` (`ItemCache`) over the `RecordPort`
 *
 * They are siblings, not parent/child: `AccountStore` holds only a `PlatformPort` and can
 * never reach the cache, so every flow that has to drop both (sign-out, account removal)
 * sequences them from the app.
 */

import {
	invalidateAccountSession,
	removeAccount,
} from "@bittery/core/services/account-lifecycle";
import {
	type AccountStore,
	createAccountStore,
	createItemCache,
	type ItemCache,
} from "@bittery/storage";
import { generateAccountId } from "@bittery/storage/account-id";
import {
	createWebPlatformPort,
	createWebRecordPort,
} from "@bittery/storage/adapters/web";
import type { KdfProfile } from "@bittery/types";
import { lifecycleDeps } from "./lifecycle";
import {
	decrypt,
	decryptKeyHandleWithWrappingKey,
	decryptWithKeyHandle,
	destroyKeyHandle,
	encrypt,
	encryptKeyHandleWithWrappingKey,
	encryptWithKeyHandle,
	exportKeyHandle,
	rsaDecrypt,
} from "./wasm-crypto";

// Create crypto provider from WASM crypto wrapper. Web is the only platform that uses the
// non-extractable key-handle path, so all nine methods are supplied here.
const cryptoProvider = {
	encrypt,
	decrypt,
	rsaDecrypt,
	encryptWithKeyHandle,
	decryptWithKeyHandle,
	encryptKeyHandleWithWrappingKey,
	decryptKeyHandleWithWrappingKey,
	exportKeyHandle,
	destroyKeyHandle,
};

const platformPort = createWebPlatformPort();
const recordPort = createWebRecordPort();

export const storage: AccountStore = createAccountStore({
	port: platformPort,
	crypto: cryptoProvider,
});

export const itemCache: ItemCache = createItemCache({ port: recordPort });

/**
 * Stable local account id for a browser profile that has never signed in.
 *
 * `AccountStore` keys every value by accountId on all four platforms, so web needs an
 * active account before the first account-scoped write. The port cannot mint one — a port
 * must not know what an account is — so the id lives here in `localStorage`.
 */
const WEB_ACCOUNT_ID_KEY = "bittery_web_account_id";

function getOrCreateWebAccountId(): string {
	const stored = localStorage.getItem(WEB_ACCOUNT_ID_KEY);
	if (stored) {
		return stored;
	}
	const accountId = generateAccountId();
	localStorage.setItem(WEB_ACCOUNT_ID_KEY, accountId);
	return accountId;
}

// ---------------------------------------------------------------------------
// Active account id — a synchronous snapshot for `useSyncExternalStore`
// ---------------------------------------------------------------------------

let activeAccountIdSnapshot: string | null = null;
const activeAccountListeners = new Set<() => void>();

/**
 * Re-read the active account and publish it to subscribers.
 *
 * Called after initialization, whenever the unlocked set changes (login, lock, sign-out)
 * and explicitly after a login, because `storeLoginSession` sets the master unlock key
 * *before* it moves the active-account pointer.
 */
export async function refreshActiveAccountId(): Promise<void> {
	const active = await storage.getActiveAccount();
	const next = active ?? null;
	if (next === activeAccountIdSnapshot) {
		return;
	}
	activeAccountIdSnapshot = next;
	for (const listener of activeAccountListeners) {
		listener();
	}
}

storage.onUnlockStateChanged(() => {
	void refreshActiveAccountId();
});

export function subscribeActiveAccountId(listener: () => void): () => void {
	activeAccountListeners.add(listener);
	return () => {
		activeAccountListeners.delete(listener);
	};
}

export function getActiveAccountIdSnapshot(): string | null {
	return activeAccountIdSnapshot;
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

let initializePromise: Promise<void> | null = null;

/**
 * Initialize both stores and make sure an active account exists.
 *
 * Must be awaited before the first account-scoped call — every write on `AccountStore`
 * throws when no account resolves. Awaited from the root route's `beforeLoad`, which runs
 * ahead of every other route guard, loader and component, and from the sync hook's own
 * async callbacks because `SyncProvider` mounts outside the router's match tree.
 *
 * Safe to call any number of times; subsequent calls await the same promise.
 *
 * A no-op without `window`: TanStack Start renders the SPA shell (dev request and the
 * prerendered `index.html`) in Node, where the root `beforeLoad` reaches this and every
 * browser store is undefined. Nothing rendered there is account-scoped, and the promise is
 * deliberately not memoised so the browser still initialises for real.
 */
export async function initializeStorage(): Promise<void> {
	if (typeof window === "undefined") {
		return;
	}
	if (!initializePromise) {
		initializePromise = (async () => {
			await storage.initialize();
			await itemCache.initialize();

			if ((await storage.getActiveAccount()) === null) {
				await storage.setActiveAccount(getOrCreateWebAccountId());
			}

			await refreshActiveAccountId();
		})();
	}
	return initializePromise;
}

// ---------------------------------------------------------------------------
// Destructive flows — web platform adapters
//
// The sequencing lives in `@bittery/core/services/account-lifecycle`; what stays here is
// the web-only reactivity around it: `initializeStorage()` first, because every
// account-scoped call needs the synthetic account to exist, and `refreshActiveAccountId()`
// after, to republish the `useSyncExternalStore` snapshot.
// ---------------------------------------------------------------------------

/** Sign out of the active account: no quick-unlock offer and no cached ciphertext survive. */
export async function forgetActiveSession(): Promise<void> {
	await initializeStorage();
	await invalidateAccountSession("active", lifecycleDeps);
	await refreshActiveAccountId();
}

/** Wipe everything stored for the active account, including its encrypted item cache. */
export async function clearActiveAccountData(): Promise<void> {
	await initializeStorage();
	const accountId = await storage.getActiveAccount();
	if (accountId) {
		await removeAccount(accountId, lifecycleDeps);
	}
	await refreshActiveAccountId();
}

/**
 * Resolves the KDF params pinned for the active account at login. Flows that
 * re-derive the *existing* account's keys (e.g. verifying the current password
 * before a change) must use these params rather than the current crypto-core
 * default, otherwise an account keyed at an older iteration count fails to
 * decrypt its own data (issue #32). Returns `undefined` when no pin exists so
 * callers fall back to the default.
 */
export async function getActiveAccountKdfProfile(): Promise<{
	accountId: string;
	profile: KdfProfile;
}> {
	const active = await storage.getActiveAccount();
	if (!active) {
		throw new Error("No active account");
	}
	const profile = await storage.getPinnedKdfProfile(active);
	if (!profile) {
		throw new Error("Pinned KDF profile missing; sign in again");
	}
	return { accountId: active, profile };
}

// Re-export types for convenience
export type {
	AccountMetadata,
	AccountStore,
	ActiveAccountId,
	ItemCache,
	StoredSessionData,
	VaultKeyData,
} from "@bittery/storage";
