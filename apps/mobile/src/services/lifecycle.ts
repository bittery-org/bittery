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
import { clearAccountApiClient } from "@bittery/shared/api-client-factory";
import { Platform } from "react-native";
import CredentialProvider from "../../modules/credential-provider";
import { itemCache, storage } from "./storage";

/**
 * Mobile is the only platform with a second live copy of the master unlock key: the
 * Android `CredentialProvider` mirror that autofill reads without going through the
 * JS side. Leaving it behind lets another app keep filling credentials while the UI
 * says locked, so it is purged before `AccountStore` drops its own copy.
 */
const nativeMukAndApiClientMirror: CredentialMirror = {
	async purge(refs) {
		// `clearAllMasterUnlockKeys` is device-wide, not per-account. The port allows
		// dropping more than asked — never less — so over-purging is correct here.
		if (Platform.OS === "android" && CredentialProvider.isAvailable()) {
			CredentialProvider.clearAllMasterUnlockKeys();
		}

		for (const ref of refs) {
			if (!ref.authToken) {
				continue;
			}
			clearAccountApiClient(ref.authToken, ref.serverUrl);
		}
	},
};

export const lifecycleDeps: LifecycleDeps = {
	storage,
	itemCache,
	credentialMirror: nativeMukAndApiClientMirror,
};
