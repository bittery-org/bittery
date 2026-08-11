/**
 * The extension `LifecycleDeps`, built once over the two storage singletons.
 *
 * Every destructive background flow (lock, sign-out) states its intent through
 * `@bittery/core/services/account-lifecycle` with these deps, so the
 * `AccountStore`/`ItemCache` sequencing lives in one place for all platforms.
 *
 * Imported by the MV3 service worker, so nothing here may touch React, the DOM,
 * or run work at module scope beyond building the object.
 */

import type { LifecycleDeps } from "@bittery/core/services/account-lifecycle";
import { NO_CREDENTIAL_MIRROR } from "@bittery/core/services/account-lifecycle";
import { itemCache, storage } from "../lib/storage";

export const lifecycleDeps: LifecycleDeps = {
	storage,
	itemCache,
	credentialMirror: NO_CREDENTIAL_MIRROR,
};
