/**
 * The desktop `LifecycleDeps`, built once beside the storage singletons it wraps.
 *
 * Every destructive desktop flow (forced sign-out, account removal, reset) states
 * its intent through `@bittery/core/services/account-lifecycle` with these deps, so
 * the `AccountStore`/`ItemCache` sequencing lives in one place for all platforms.
 */

import type {
	CredentialMirror,
	LifecycleDeps,
} from "@bittery/core/services/account-lifecycle";
import { clearAccountRpcClient } from "@bittery/shared/rpc-client-factory";
import { itemCache, storage } from "./storage";

/**
 * Desktop keeps no MUK mirror, but the shared RPC client cache holds live clients
 * bound to the bearer token — dropping the token without dropping the client leaves
 * a cached client still sending a revoked credential.
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
