/**
 * The web `LifecycleDeps`, built once beside the storage singletons it wraps.
 *
 * Every destructive web flow (forced sign-out, account removal, account deletion)
 * states its intent through `@bittery/core/services/account-lifecycle` with these
 * deps, so the `AccountStore`/`ItemCache` sequencing lives in one place for all
 * platforms.
 */

import type {
	CredentialMirror,
	LifecycleDeps,
} from "@bittery/core/services/account-lifecycle";
import { clearAccountApiClient } from "@bittery/shared/api-client-factory";
import { itemCache, storage } from "./storage";

/**
 * Web keeps no MUK mirror, but the shared API client cache holds live clients bound
 * to the bearer token — dropping the token without dropping the client leaves a
 * cached client still sending a revoked credential.
 */
const apiClientCacheMirror: CredentialMirror = {
	async purge(refs) {
		for (const ref of refs) {
			if (!ref.authToken) {
				continue;
			}
			clearAccountApiClient(ref.authToken, ref.serverUrl);
		}
	},
};

// Accessors, not values: `storage.ts` imports these deps back for its own platform
// adapters, so an eager read would hit the singletons' TDZ under that import cycle.
export const lifecycleDeps: LifecycleDeps = {
	get storage() {
		return storage;
	},
	get itemCache() {
		return itemCache;
	},
	credentialMirror: apiClientCacheMirror,
};
