import { findAccountById } from "@bittery/storage/account-id";
import type { AccountMetadata, ActiveAccount } from "@bittery/storage/types";

export interface SelectActiveAccountAfterUnlockInput {
	/** Active account as persisted before the unlock, from `getActiveAccount()`. */
	previousActive: ActiveAccount;
	/** Account ids that are unlocked and usable — never emails. */
	unlockedAccountIds: string[];
	accounts: AccountMetadata[];
}

/**
 * Pick the account to make active once an unlock finishes.
 *
 * Unlocking should return the user to the account they were last using, so the
 * previously active account wins whenever it is still around and unlocked.
 * Callers that enforce a policy (e.g. travel mode) must pass only the accounts
 * that passed it, so a rejected account can never be selected here.
 */
export function selectActiveAccountAfterUnlock({
	previousActive,
	unlockedAccountIds,
	accounts,
}: SelectActiveAccountAfterUnlockInput): string | undefined {
	if (
		previousActive?.type === "single" &&
		unlockedAccountIds.includes(previousActive.accountId) &&
		findAccountById(accounts, previousActive.accountId)
	) {
		return previousActive.accountId;
	}

	return unlockedAccountIds[0] ?? accounts[0]?.accountId;
}
