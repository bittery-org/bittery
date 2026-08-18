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

/** Mirrors borrowed unlocked keys into Android's separate credential-provider process. */
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

		// The separate Android process cannot receive a KeyRef; its frozen bridge accepts base64.
		const exported = await crypto.exportKey(masterUnlockKey);
		try {
			await CredentialProvider.setMasterUnlockKey(
				arrayBufferToBase64(exported),
				sessionData.userId,
				autoLockTimeoutMs,
			);
		} finally {
			exported.fill(0);
		}
	}
}
