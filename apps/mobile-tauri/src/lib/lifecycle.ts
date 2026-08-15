/**
 * The desktop `LifecycleDeps`, built once beside the storage singletons it wraps.
 *
 * Every destructive desktop flow (forced sign-out, account removal, reset) states
 * its intent through `@bittery/core/services/account-lifecycle` with these deps, so
 * the `AccountStore`/`ItemCache` sequencing lives in one place for all platforms.
 */

import type { LifecycleDeps } from "@bittery/core/services/account-lifecycle";
import { NO_CREDENTIAL_MIRROR } from "@bittery/core/services/account-lifecycle";
import { itemCache, storage } from "./storage";

// Eager values, unlike `apps/web`, which needs lazy getters. Desktop's
// `storage.ts` does not import this module back — its destructive-flow wrappers
// live in `lib/providers.tsx`, not in `storage.ts` — so there is no cycle and no
// TDZ to dodge. If a future change makes `storage.ts` import `lifecycleDeps`,
// these have to become getters; see the comment in `apps/web/src/lib/lifecycle.ts`
// for what the failure looks like. Traced 2026-08-14.
export const lifecycleDeps: LifecycleDeps = {
	storage,
	itemCache,
	credentialMirror: NO_CREDENTIAL_MIRROR,
};
