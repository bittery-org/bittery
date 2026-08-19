/**
 * Ported from `apps/mobile/src/services/credential-provider-master-unlock-key.ts`.
 *
 * One behavioural difference, forced by the bridge: `isAvailable()` and
 * `setMasterUnlockKey()` are `Promise`s here (see the module comment on
 * `./credential-provider`). The Expo original read `CredentialProvider.isAvailable()` as
 * a boolean and fired `setMasterUnlockKey` without awaiting it; both are `await`ed now,
 * so an absent plugin really does skip the loop and a rejected write really does reach
 * the caller.
 *
 * `Platform.OS !== "android"` is gone with no replacement check. It was never the real
 * question — the plugin only exists in the Android build, so a non-Android host fails the
 * probe and `isAvailable()` answers `false`. One guard now covers both cases.
 */

import { arrayBufferToBase64 } from "@bittery/shared/crypto";
import { credentialProvider as CredentialProvider } from "./credential-provider";
import { crypto } from "./crypto";
import { storage } from "./storage";

/**
 * Mirrors borrowed unlocked keys into the native live store, so Android's
 * credential provider and autofill services can decrypt while the app is
 * unlocked. Live only — the native side keeps nothing on disk, so this has to
 * run again after every unlock.
 */
export async function mirrorBorrowedMasterUnlockKeysToCredentialProvider(
	accountIds: readonly string[],
): Promise<void> {
	if (!(await CredentialProvider.isAvailable())) {
		return;
	}

	for (const accountId of accountIds) {
		const [masterUnlockKey, sessionData, autoLockTimeoutMs] = await Promise.all(
			[
				storage.getMasterUnlockKey(accountId),
				storage.getStoredSessionData(accountId),
				storage.getAutoLockTimeoutOrDefault(accountId),
			],
		);
		if (!masterUnlockKey || !sessionData?.userId) {
			continue;
		}

		// The native bridge cannot receive a KeyRef; it accepts base64.
		//
		// Both ids travel. The native side keys live unlock state by `accountId`,
		// the same key everything above uses, and stamps its local cache rows with
		// the server `userId`. Resolving the pair here is what keeps a placeholder
		// id out of native storage.
		const exported = await crypto.exportKey(masterUnlockKey);
		try {
			await CredentialProvider.setMasterUnlockKey(
				arrayBufferToBase64(exported),
				accountId,
				sessionData.userId,
				autoLockTimeoutMs,
			);
		} finally {
			exported.fill(0);
		}
	}
}
