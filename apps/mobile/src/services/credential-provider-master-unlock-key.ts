import { arrayBufferToBase64 } from "@bittery/shared/crypto";
import { Platform } from "react-native";
import CredentialProvider from "../../modules/credential-provider";
import { crypto } from "../lib/crypto";
import { storage } from "./storage";

/** Mirrors borrowed unlocked keys into Android's separate credential-provider process. */
export async function mirrorBorrowedMasterUnlockKeysToCredentialProvider(
	accountIds: readonly string[],
): Promise<void> {
	if (Platform.OS !== "android" || !CredentialProvider.isAvailable()) {
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
			CredentialProvider.setMasterUnlockKey(
				arrayBufferToBase64(exported),
				sessionData.userId,
				autoLockTimeoutMs,
			);
		} finally {
			exported.fill(0);
		}
	}
}
