import type { RuntimeClient } from "@bittery/client-runtime/client";
import { runtimeImportParking } from "@/hooks/runtime-import-parking";

/**
 * Web owns the temporary decrypted Import presentation, so it composes cleanup
 * immediately above the shared Runtime client instead of teaching Runtime about
 * an app-private store. Lock deliberately does not clear it: Lock retains cached
 * Account state, while Sign out, Remove, and Wipe retire that state in CONTEXT.
 */
export function withRuntimeImportParkingLifecycle(
	client: RuntimeClient,
): RuntimeClient {
	return {
		...client,
		async signOut(accountId, options) {
			try {
				return await client.signOut(accountId, options);
			} finally {
				runtimeImportParking.retire(accountId);
			}
		},
		async removeAccount(accountId, options) {
			try {
				return await client.removeAccount(accountId, options);
			} finally {
				runtimeImportParking.retire(accountId);
			}
		},
		async wipe(options) {
			try {
				return await client.wipe(options);
			} finally {
				runtimeImportParking.retireAll();
			}
		},
	};
}
