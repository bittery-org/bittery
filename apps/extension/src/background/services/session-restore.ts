/**
 * Explicit unlock restore for the MV3 service worker.
 *
 * ## Why this exists
 *
 * `AccountStore.getUnlockedAccounts()` reports which accounts hold a master unlock key
 * **in memory**. MV3 kills and restarts the service worker constantly, and each restart
 * empties that in-memory cache. Without an explicit restore the extension would report zero
 * unlocked accounts after every recycle and autofill would stop working until the user
 * opened the popup.
 *
 * ## Why one routine instead of a restore at each reader
 *
 * Restoring inside `resolveAccountEmailForVault`, `desktop-sync`, `handleCheckAuth`, …
 * would spread the same responsibility over five call sites that each have to remember it.
 * This module is called once from the service-worker startup routine, before any runtime
 * message is routed (see `service-worker-lifecycle.ts`). Readers just read.
 *
 * ## Which restart cases it covers
 *
 * - **Service-worker restart** (the common MV3 recycle): `chrome.storage.session` survives,
 *   so `jwt_token`, `vault_keys` and `encrypted_private_key` are still present.
 *   `isSessionValid` passes and `tryRestoreSession` decrypts the MUK out of `session_data`
 *   (device-bound, `chrome.storage.local`) with `device_key`. The vault comes back unlocked
 *   with no user interaction.
 * - **Browser restart**: `chrome.storage.session` is cleared, so there is no `jwt_token`,
 *   `isSessionValid` is false, and `tryRestoreSession` correctly restores nothing. This
 *   reports zero unlocked accounts rather than pretending otherwise, and the popup routes
 *   to `/unlock` for a password quick-unlock, which re-authenticates against the server and
 *   re-issues both the token and the vault keys.
 */

import { getAccountSessionManager } from "@bittery/core/services/account-session-manager";
import { itemCache, storage } from "../../lib/storage";
import { setMasterUnlockKey, updateActivity } from "../session-manager";

/**
 * Bring every account whose stored session is still usable back to "unlocked".
 *
 * @returns the accountIds that were restored, newest-first is not guaranteed.
 */
export async function restoreUnlockedSessions(): Promise<string[]> {
	const restoredAccountIds: string[] = [];

	try {
		const accounts = await storage.getAccountsList();
		if (accounts.length === 0) {
			return restoredAccountIds;
		}

		const sessions = getAccountSessionManager({ storage, itemCache });

		for (const account of accounts) {
			try {
				if (await sessions.unlockAccount(account.accountId, false)) {
					restoredAccountIds.push(account.accountId);
				}
			} catch (error) {
				console.error(
					`[session-restore] Failed to restore session for ${account.email}:`,
					error,
				);
			}
		}

		const firstRestoredAccountId = restoredAccountIds[0];
		if (firstRestoredAccountId) {
			// Update the activity timestamp FIRST: `isUnlocked()` compares against it and
			// would otherwise see 0 and immediately auto-lock everything just restored.
			await updateActivity();

			const muk = await storage.getMasterUnlockKey(firstRestoredAccountId);
			if (muk) {
				setMasterUnlockKey(muk);
			}
		}
	} catch (error) {
		console.error("[session-restore] Failed to restore sessions:", error);
	}

	return restoredAccountIds;
}
