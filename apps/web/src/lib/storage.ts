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
	type LifecycleOutcome,
	lockInvalidSession,
	removeAccount,
	signOutAccount,
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
import { crypto } from "./crypto";
import { lifecycleDeps } from "./lifecycle";

const platformPort = createWebPlatformPort();
const recordPort = createWebRecordPort();

export const storage: AccountStore = createAccountStore({
	port: platformPort,
	crypto,
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

/**
 * Forget the synthetic pre-login id.
 *
 * This id is the active account only until a sign-in: `resolveOrCreateAccountId` then mints
 * or reuses an id for the (server, user) pair and `setActiveAccount` points the store at
 * that one instead. So for a signed-in user this key is a stale seed, and
 * `clearActiveAccountData` has already destroyed the `bittery_account_*` keys under the
 * login id. Dropping it leaves no stray `bittery_*` key behind; the next sign-in mints again.
 *
 * Still only ever call it after a removal reported no failures. On a browser that never
 * signed in, this id is the sole name for those keys, and dropping it first would orphan
 * whatever survived.
 */
export function forgetWebAccountId(): void {
	if (typeof window === "undefined") {
		return;
	}
	localStorage.removeItem(WEB_ACCOUNT_ID_KEY);
}

/**
 * Which account the transitional store is pointed at right now.
 *
 * Read once, at the gesture that destroys it. `removeAccount` writes the active pointer to
 * `null` before it sweeps the values, so a second read after a half-failed clear answers
 * `null` and would let a caller destroy nothing and call it success.
 */
export async function getTransitionalAccountId(): Promise<string | null> {
	await initializeStorage();
	return storage.getActiveAccount();
}

/** Reconcile direct storage ceremonies with the process-owned account runtime. */
export type RefreshAccountRuntime = () => void | Promise<void>;

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
		})();
	}
	return initializePromise;
}

// ---------------------------------------------------------------------------
// Destructive flows — web platform adapters
//
// The sequencing lives in `@bittery/core/services/account-lifecycle`; what stays here is
// the web-only reactivity around it: `initializeStorage()` first, because every
// account-scoped call needs the synthetic account to exist. Direct storage ceremonies
// refresh the AccountSessionManager so AccountVaultRuntime publishes their new scope.
// ---------------------------------------------------------------------------

/** Sign out of the active account: no quick-unlock offer and no cached ciphertext survive. */
export async function forgetActiveSession(
	refresh?: RefreshAccountRuntime,
): Promise<void> {
	await initializeStorage();
	const accountId = await storage.getActiveAccount();
	if (accountId) {
		await signOutAccount(accountId, lifecycleDeps);
	}
	await refresh?.();
}

/**
 * Lock after a rejected or expired Server Session. Session-bound credentials are cleared,
 * while Device-bound Quick Unlock inputs remain available for online reauthentication.
 */
export async function lockRejectedAccountSession(
	accountId: string,
	refresh?: RefreshAccountRuntime,
): Promise<LifecycleOutcome> {
	await initializeStorage();
	const outcome = await lockInvalidSession({ accountId }, lifecycleDeps);
	await refresh?.();
	return outcome;
}

/**
 * Wipe everything the transitional store holds for one named account, including its
 * encrypted item cache.
 *
 * The id is a transitional-store id, not the Runtime's `AccountId`. Before the first sign-in
 * that is the synthetic `bittery_web_account_id`; afterwards it is the id
 * `resolveOrCreateAccountId` minted for the (server, user) pair. This clears the
 * `bittery_account_${id}_*` keys, the accounts list, `device_key` once the list empties, and
 * the cached ciphertext. It reaches no Replica and no Runtime platform state.
 *
 * The caller names the account rather than letting this re-resolve it: `removeAccount`
 * clears the active pointer before it sweeps the values, so a retry that resolved again
 * would find nothing and report a success over surviving data.
 *
 * The name is required, and the type says so. An unnamed sweep destroys nothing and reports
 * no failure, which every caller reads as success. `account-removal.ts` reports a pointer
 * that resolved to `null` as the half-removal it is, and never asks for a sweep under it.
 *
 * The outcome is returned rather than dropped: a caller that navigates away on a half-failed
 * removal would claim a teardown that did not happen. `failures.length === 0` is success.
 */
export async function clearActiveAccountData(
	accountId: string,
	refresh?: RefreshAccountRuntime,
): Promise<LifecycleOutcome> {
	await initializeStorage();
	const outcome = await removeAccount(accountId, lifecycleDeps);
	await refresh?.();
	return outcome;
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
