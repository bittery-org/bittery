/**
 * The web `LifecycleDeps`, built once beside the storage singletons it wraps.
 *
 * Every destructive web flow (forced sign-out, account removal, account deletion)
 * states its intent through `@bittery/core/services/account-lifecycle` with these
 * deps, so the `AccountStore`/`ItemCache` sequencing lives in one place for all
 * platforms.
 */

import type { LifecycleDeps } from "@bittery/core/services/account-lifecycle";
import { NO_CREDENTIAL_MIRROR } from "@bittery/core/services/account-lifecycle";
import { itemCache, storage } from "./storage";

// Accessors, not values, and this is load-bearing — do not "simplify" it to eager
// values to match the other apps.
//
// The cause is that web puts its destructive-flow wrappers (`forgetAccountSession`,
// `clearActiveAccountData`) inside `storage.ts`, so `storage.ts` imports
// `lifecycleDeps` back. `router.tsx` reaches `./lib/storage` first, so this module
// is evaluated from partway down `storage.ts` — above the `export const storage`
// and `export const itemCache` declarations, which are therefore in their TDZ.
// desktop, mobile and the extension are eager because none of their `storage.ts`
// has that back-edge; theirs live elsewhere. Traced 2026-08-14.
//
// The failure mode is asymmetric, which is why this comment is long: under native
// ESM (`vite dev`, and the SSR/prerender pass) it throws "Cannot access 'storage'
// before initialization" immediately, but Rollup hoists the cycle into one scope
// and rewrites `const` to `var`, so a production build silently yields
// `lifecycleDeps.storage === undefined` and fails somewhere else entirely.
export const lifecycleDeps: LifecycleDeps = {
	get storage() {
		return storage;
	},
	get itemCache() {
		return itemCache;
	},
	credentialMirror: NO_CREDENTIAL_MIRROR,
};
