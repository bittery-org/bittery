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
import { credentialProvider as CredentialProvider } from "./credential-provider";
import { itemCache, storage } from "./storage";

/**
 * Mobile is the only platform with a second live copy of the master unlock key: the
 * Android credential-provider mirror that autofill reads without going through the JS
 * side. Leaving it behind lets another app keep filling credentials while the UI says
 * locked, so it is purged before `AccountStore` drops its own copy.
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
		// `clearAllMasterUnlockKeys` is device-wide, not per-account. The port allows
		// dropping more than asked — never less — so over-purging is correct here.
		if (await CredentialProvider.isAvailable()) {
			await CredentialProvider.clearAllMasterUnlockKeys();
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
