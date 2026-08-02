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

import type {
	CredentialMirror,
	LifecycleDeps,
} from "@bittery/core/services/account-lifecycle";
import { clearAccountRpcClient } from "@bittery/shared/rpc-client-factory";
import { itemCache, storage } from "../lib/storage";

/**
 * The extension keeps no MUK mirror outside `AccountStore`, but the shared RPC
 * client cache holds live clients bound to the bearer token — dropping the token
 * without dropping the client leaves a cached client still sending a revoked
 * credential.
 */
const rpcClientCacheMirror: CredentialMirror = {
	async purge(refs) {
		for (const ref of refs) {
			if (!ref.authToken) {
				continue;
			}
			clearAccountRpcClient(ref.authToken, ref.serverUrl);
		}
	},
};

export const lifecycleDeps: LifecycleDeps = {
	storage,
	itemCache,
	credentialMirror: rpcClientCacheMirror,
};
