/**
 * The mobile `LifecycleDeps`, built once beside the storage singletons it wraps.
 *
 * Every destructive mobile flow (lock, sign-out, account removal, session-expired
 * wipe) states its intent through `@bittery/core/services/account-lifecycle` with
 * these deps, so the `AccountStore`/`ItemCache` sequencing — and the ordering of the
 * native MUK purge against it — lives in one place for all platforms.
 */

import type {
	CredentialMirror,
	LifecycleDeps,
} from "@bittery/core/services/account-lifecycle";
import { credentialProvider } from "./credential-provider";
import { credentialReplica } from "./credential-replica";
import { itemCache, storage } from "./storage";

/**
 * Mobile is the only platform with a second live copy of the master unlock key: the
 * Android credential-provider mirror that autofill reads without going through the JS
 * side. Leaving it behind lets another app keep filling credentials while the UI says
 * locked, so it is purged before `AccountStore` drops its own copy.
 *
 * The purge is `CredentialReplica.clearAll`, which drops the live keys *and* the
 * published generations: the replica rows are ciphertext, so losing the keys is what
 * makes them unreadable, and forgetting the generations makes the next sign-in publish
 * again rather than trust what a signed-out session left behind.
 *
 * Ported from `apps/mobile/src/services/lifecycle.ts`, where the guard read
 * `Platform.OS === "android" && CredentialProvider.isAvailable()` and the purge itself
 * was fired without an `await`. Both halves are promises here: without the `await` on
 * `isAvailable()` the condition would be a truthy `Promise` and the purge would run —
 * and then throw `PLUGIN_UNAVAILABLE` — on every non-Android host. The `Platform.OS`
 * half is gone entirely: the plugin only exists in the Android build, so a failed probe
 * already answers the same question.
 */
const nativeMukMirror: CredentialMirror = {
	async purge(): Promise<void> {
		await credentialReplica.clearAll();
	},

	/**
	 * The biometric escrow, which `purge` deliberately leaves alone.
	 *
	 * The escrow is what a lock is meant to be undone by, so only the flows that
	 * promise a full sign-in reach here. It is a **single slot** on this platform:
	 * one account's wrapped key, not a map. So a named scope asks the native side
	 * whether the slot is that account's — signing one account out must not cost
	 * another the biometric unlock it enrolled — and only `"device"` clears it
	 * whoever it belongs to. Which account holds the slot never leaves the provider
	 * process; the comparison happens there.
	 *
	 * The availability probe is the whole of the platform check, as it is for
	 * `purge`: these commands throw where the plugin does not exist.
	 */
	async forgetQuickUnlock(scope): Promise<void> {
		if (!(await credentialProvider.isAvailable())) {
			return;
		}
		if (scope === "device") {
			await credentialProvider.clearEscrow();
			return;
		}
		for (const ref of scope) {
			await credentialProvider.clearEscrowForAccount(ref.accountId);
		}
	},
};

// Eager values, unlike `apps/web`, which needs lazy getters. Mobile's `storage.ts`
// does not import this module back — its destructive-flow wrappers live in
// `lib/providers.tsx`, not in `storage.ts` — so there is no cycle and no TDZ to
// dodge. If a future change makes `storage.ts` import `lifecycleDeps`, these have to
// become getters; see the comment in `apps/web/src/lib/lifecycle.ts` for what the
// failure looks like. Traced 2026-08-14.
export const lifecycleDeps: LifecycleDeps = {
	storage,
	itemCache,
	credentialMirror: nativeMukMirror,
};
