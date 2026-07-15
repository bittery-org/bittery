/**
 * Travel mode enforcement for "unlock all accounts" biometric flows.
 *
 * The storage adapter's `unlockAllAccountsWithBiometric()` decrypts stored
 * MUKs but does NOT re-verify travel mode against the server. Travel mode is a
 * security feature that MUST fail closed, so every account produced by an
 * all-accounts unlock has to be verified at the caller level before it is
 * treated as unlocked.
 *
 * For each account this:
 *  - builds a per-account RPC client (same as the single-account path)
 *  - calls the enforcer's `verifyForUnlock`
 *  - on failure, clears that account's session and drops it from the result
 *
 * Returns the subset of account IDs that passed verification.
 */
import { createStoredAccountRpcClient } from "@bittery/core/services/account-resolver";
import { getTravelModeEnforcer } from "@bittery/core/services/travel-mode-enforcer";
import { storage } from "../services/storage";

export async function enforceTravelModeForUnlockedAccounts(
	accountIds: string[],
): Promise<string[]> {
	const enforcer = getTravelModeEnforcer(storage);
	const verified: string[] = [];

	for (const accountId of accountIds) {
		try {
			const client = await createStoredAccountRpcClient(
				storage,
				accountId,
			).catch(() => null);
			await enforcer.verifyForUnlock(accountId, client);
			verified.push(accountId);
		} catch (error) {
			// Fail closed: a failed verification means we must not keep this
			// account unlocked.
			await storage.clearSession(accountId);
			console.error(
				"[TravelMode] Verification failed during all-accounts unlock:",
				error,
			);
		}
	}

	return verified;
}
