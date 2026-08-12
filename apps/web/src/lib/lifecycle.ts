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

// Accessors, not values: `storage.ts` imports these deps back for its own platform
// adapters, so an eager read would hit the singletons' TDZ under that import cycle.
export const lifecycleDeps: LifecycleDeps = {
	get storage() {
		return storage;
	},
	get itemCache() {
		return itemCache;
	},
	credentialMirror: NO_CREDENTIAL_MIRROR,
};
