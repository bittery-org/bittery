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

export const lifecycleDeps: LifecycleDeps = {
	storage,
	itemCache,
	credentialMirror: NO_CREDENTIAL_MIRROR,
};
