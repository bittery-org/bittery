import type { AccountSessionManager } from "@bittery/core/services/account-session-manager";
import type { IAutolockService } from "@bittery/core/services/autolock";
import type { AccountStore } from "@bittery/storage";
import { borrowLiveMasterUnlockKey } from "./credential-provider";
import type { LiveMasterUnlockKeyBorrower } from "./credential-provider.types";

export type VaultRouteAccess = "login" | "unlock" | "ready";

/** Everything the decision reads, and the two things it is allowed to move. */
export type VaultRouteAccessManager = Pick<
	AccountSessionManager,
	| "getAccounts"
	| "getActiveAccount"
	| "switchAccount"
	| "isInitialized"
	| "isUnlocked"
	| "unlockAccount"
	| "acceptBorrowedMasterUnlockKey"
>;

export type VaultRouteAccessStorage = Pick<
	AccountStore,
	"getStoredSecretKey" | "isSessionValid"
>;

/**
 * The native step, on its own: adopt a master unlock key the credential provider is
 * holding live right now, or answer `false` and change nothing.
 *
 * Kept separate because it is the *only* part of the guard that may run on resume. See
 * {@link resolveResumeAccess}.
 */
async function adoptLiveNativeMasterUnlockKey(
	manager: Pick<
		VaultRouteAccessManager,
		| "getActiveAccount"
		| "isInitialized"
		| "isUnlocked"
		| "acceptBorrowedMasterUnlockKey"
	>,
	storage: VaultRouteAccessStorage,
	credentialProvider: LiveMasterUnlockKeyBorrower,
): Promise<boolean> {
	const activeAccount = manager.getActiveAccount();
	if (!activeAccount) {
		return false;
	}
	if (manager.isInitialized() && manager.isUnlocked(activeAccount)) {
		return false;
	}
	const [hasSecretKey, sessionValid] = await Promise.all([
		storage.getStoredSecretKey(activeAccount),
		storage.isSessionValid(activeAccount),
	]);
	if (!hasSecretKey || !sessionValid) {
		return false;
	}

	const nativeMuk =
		await credentialProvider.borrowLiveMasterUnlockKey(activeAccount);
	if (!nativeMuk) {
		return false;
	}
	return manager.acceptBorrowedMasterUnlockKey(activeAccount, nativeMuk);
}

/**
 * The account this decision is about.
 *
 * Mobile is single-account by default, so "there are accounts but the pointer names
 * none of them" is a state the app has to walk out of rather than a reason to show the
 * login screen: a fresh device pointer, or an account removed by another surface
 * (`AccountSessionManager.refresh` drops a pointer it cannot resolve). `/` and `/login`
 * each carried their own copy of this step; it belongs with the rest of the decision.
 *
 * `switchAccount` is the only write here, and it is the same one those copies made — it
 * persists the pointer and, for a locked account, tries the prompt-free restore on its
 * own. Answering `null` therefore means the device really has no account.
 */
async function resolveSubjectAccount(
	manager: Pick<
		VaultRouteAccessManager,
		"getAccounts" | "getActiveAccount" | "switchAccount"
	>,
): Promise<string | null> {
	const activeAccount = manager.getActiveAccount();
	if (activeAccount) {
		return activeAccount;
	}
	const [firstAccount] = manager.getAccounts();
	if (!firstAccount) {
		return null;
	}
	await manager.switchAccount(firstAccount.accountId);
	return firstAccount.accountId;
}

/**
 * Follows desktop's `resolveVaultRouteAccess` decision
 * (`apps/desktop/src/lib/vault-route-access.ts`) — same manager/storage contract, so `/vault`
 * gates access identically on both platforms. Duplicated rather than shared because apps cannot
 * import from one another (only from `packages/`); there is no layout here to duplicate, only
 * the access decision.
 *
 * One step is mobile's alone, and it is why the file is no longer a copy. On Android the
 * user can unlock inside Bittery's *own* autofill or credential-provider activity: those run
 * in this process, put the master unlock key in the Kotlin live store, and tell the app
 * nothing (`src-tauri/plugins/credential-provider/android/PROCESS-MODEL.md`). Without a read
 * of that store the app answers the biometric prompt the user just passed with its own lock
 * screen. So a locked-in-JavaScript account asks the native side for the live key before it
 * falls back to the explicit restore.
 *
 * The borrow is a claim and is checked like one:
 * {@link AccountSessionManager.acceptBorrowedMasterUnlockKey} proves the bytes are this
 * account's key, re-verifies Travel Mode and refuses silently otherwise. It never raises a
 * prompt, so it costs nothing on the path where there is no live key — the native side simply
 * answers `null`, which is also what a host with no plugin answers.
 *
 * Every mobile guard that has an opinion about the vault asks here — `/`, `/login` and
 * `/vault`. They differ only in what they do with the answer: `/` redirects on all
 * three, `/login` stays put on `"login"`, `/vault` stays put on `"ready"`. They used to
 * differ in the answer itself, which is how the launcher icon kept showing a lock screen
 * for a vault the autofill sheet had already opened.
 */
export async function resolveVaultRouteAccess(
	manager: VaultRouteAccessManager,
	storage: VaultRouteAccessStorage,
	credentialProvider: LiveMasterUnlockKeyBorrower = {
		borrowLiveMasterUnlockKey,
	},
): Promise<VaultRouteAccess> {
	const activeAccount = await resolveSubjectAccount(manager);
	if (!activeAccount) {
		return "login";
	}
	if (manager.isInitialized() && manager.isUnlocked(activeAccount)) {
		return "ready";
	}
	const [hasSecretKey, sessionValid] = await Promise.all([
		storage.getStoredSecretKey(activeAccount),
		storage.isSessionValid(activeAccount),
	]);
	if (!hasSecretKey || !sessionValid) {
		return "unlock";
	}

	// Re-reads the two facts above rather than passing them down. One copy of "when may
	// a borrow happen" is worth two cheap reads on the one path that reaches here — a
	// locked account with a live session, i.e. a cold start or a lock.
	if (
		await adoptLiveNativeMasterUnlockKey(manager, storage, credentialProvider)
	) {
		return "ready";
	}

	return (await manager.unlockAccount(activeAccount, true))
		? "ready"
		: "unlock";
}

/** What returning to the foreground turned out to mean. */
export type ResumeAccess = "locked" | "unlocked" | "unchanged";

/**
 * The same decision, re-asked when the app comes back to the foreground.
 *
 * It has to be re-asked at all because an unlock can happen behind the app's back: the
 * user leaves Bittery parked on `/unlock`, fills a password from Bittery's own autofill
 * sheet, authenticates there, and comes back to a lock screen for a vault that is
 * already open natively. Nothing in that sequence touches the router.
 *
 * It is deliberately **not** {@link resolveVaultRouteAccess}, and the difference is the
 * whole safety of the thing. That guard ends in `unlockAccount(id, true)`, which
 * restores the stored session with no prompt — correct on a cold start, and exactly
 * wrong on the screen an auto-lock has just navigated to, where it would re-open the
 * vault the app locked a moment ago. So resume:
 *
 * 1. lets the auto-lock answer first, and stops there if it locked. The native purge
 *    that follows a lock is asynchronous, so asking the bridge first could borrow a key
 *    that is on its way out;
 * 2. otherwise adopts a live native key and nothing else. A live key is the one fact
 *    that means the user really did authenticate.
 *
 * `"unchanged"` therefore covers both "nothing happened" and "we refused", which are
 * the same thing to the caller: stay where you are.
 */
export async function resolveResumeAccess(
	autolock: Pick<IAutolockService, "shouldLock" | "lock">,
	manager: Pick<
		VaultRouteAccessManager,
		| "getActiveAccount"
		| "isInitialized"
		| "isUnlocked"
		| "acceptBorrowedMasterUnlockKey"
	>,
	storage: VaultRouteAccessStorage,
	credentialProvider: LiveMasterUnlockKeyBorrower = {
		borrowLiveMasterUnlockKey,
	},
): Promise<ResumeAccess> {
	if (await autolock.shouldLock()) {
		await autolock.lock();
		return "locked";
	}
	return (await adoptLiveNativeMasterUnlockKey(
		manager,
		storage,
		credentialProvider,
	))
		? "unlocked"
		: "unchanged";
}
