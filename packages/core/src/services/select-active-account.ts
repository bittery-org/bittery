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

export interface SelectActiveAccountAfterRemovalInput {
	removedAccountId: string;
	/** Active account as persisted before the removal, from `getActiveAccount()`. */
	previousActive: ActiveAccount;
	/** Accounts as they were *before* the removal — the removed one still included. */
	accounts: AccountMetadata[];
}

/**
 * Pick the account to make active once an account is removed.
 *
 * Only the removal of the active account may move the pointer; removing any
 * other account leaves the user where they were. `undefined` therefore means
 * "leave the pointer alone" when a non-active account went away, and "no
 * account left to point at" when the last one did.
 */
export function selectActiveAccountAfterRemoval({
	removedAccountId,
	previousActive,
	accounts,
}: SelectActiveAccountAfterRemovalInput): string | undefined {
	if (previousActive?.accountId !== removedAccountId) {
		return undefined;
	}

	return accounts.find((account) => account.accountId !== removedAccountId)
		?.accountId;
}
