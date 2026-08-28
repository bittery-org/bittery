/**
 * The Web-only tail that clears the transitional AccountStore and ItemCache.
 *
 * The Rust Runtime owns Account lifecycle. These functions do not model another lifecycle:
 * they only compose the two sibling browser stores that the Runtime cannot reach. Web has no
 * credential mirror, so the cross-host transitional lifecycle module has no remaining role here.
 */

import type {
	AccountMetadata,
	AccountStore,
	ActiveAccountId,
	ItemCache,
} from "@bittery/storage";

type CleanupStorage = Pick<
	AccountStore,
	| "clearAllStoredData"
	| "clearSession"
	| "forgetSession"
	| "getAccountsList"
	| "getActiveAccount"
	| "setActiveAccount"
>;

type CleanupItemCache = Pick<ItemCache, "clearItemCache">;

export interface TransitionalAccountCleanupDeps {
	readonly storage: CleanupStorage;
	readonly itemCache: CleanupItemCache;
}

export type TransitionalAccountCleanupStep =
	| "readAccountState"
	| "clearItemCache"
	| "clearSession"
	| "forgetSession"
	| "clearAccountData"
	| "setActiveAccount";

export interface TransitionalAccountCleanupFailure {
	readonly accountId: string | null;
	readonly step: TransitionalAccountCleanupStep;
	readonly cause: unknown;
}

export interface TransitionalAccountCleanupOutcome {
	/** Whether the named transitional Account existed when cleanup began. */
	readonly targetPresent: boolean;
	readonly failures: readonly TransitionalAccountCleanupFailure[];
}

interface CleanupPreState {
	readonly accounts: readonly AccountMetadata[];
	readonly activeAccountId: ActiveAccountId;
}

async function attempt<T>(
	failures: TransitionalAccountCleanupFailure[],
	accountId: string | null,
	step: TransitionalAccountCleanupStep,
	run: () => Promise<T>,
): Promise<T | undefined> {
	try {
		return await run();
	} catch (cause) {
		failures.push({ accountId, step, cause });
		return undefined;
	}
}

async function readPreState(
	storage: CleanupStorage,
	failures: TransitionalAccountCleanupFailure[],
): Promise<CleanupPreState> {
	const accounts = await attempt(failures, null, "readAccountState", () =>
		storage.getAccountsList(),
	);
	const activeAccountId = await attempt(
		failures,
		null,
		"readAccountState",
		() => storage.getActiveAccount(),
	);
	return {
		accounts: accounts ?? [],
		activeAccountId: activeAccountId ?? null,
	};
}

async function finishCleanup(
	accountId: string,
	pre: CleanupPreState,
	storage: CleanupStorage,
	failures: TransitionalAccountCleanupFailure[],
): Promise<TransitionalAccountCleanupOutcome> {
	// Retain the old fail-closed postcondition reads without exporting their unused state.
	// If either store view is unreadable, a caller must not apply success effects.
	await attempt(failures, null, "readAccountState", () =>
		storage.getAccountsList(),
	);
	await attempt(failures, null, "readAccountState", () =>
		storage.getActiveAccount(),
	);
	return {
		targetPresent: pre.accounts.some(
			(account) => account.accountId === accountId,
		),
		failures,
	};
}

/** Lock only Session-bound transitional material after the Server rejects its Session. */
export async function lockRejectedTransitionalSession(
	accountId: string,
	deps: TransitionalAccountCleanupDeps,
): Promise<TransitionalAccountCleanupOutcome> {
	const failures: TransitionalAccountCleanupFailure[] = [];
	const pre = await readPreState(deps.storage, failures);
	await attempt(failures, accountId, "clearSession", () =>
		deps.storage.clearSession(accountId),
	);
	return finishCleanup(accountId, pre, deps.storage, failures);
}

/** Forget Quick Unlock inputs and cached ciphertext while retaining the Account row. */
export async function forgetTransitionalSession(
	accountId: string,
	deps: TransitionalAccountCleanupDeps,
): Promise<TransitionalAccountCleanupOutcome> {
	const failures: TransitionalAccountCleanupFailure[] = [];
	const pre = await readPreState(deps.storage, failures);
	await attempt(failures, accountId, "clearItemCache", () =>
		deps.itemCache.clearItemCache(accountId),
	);
	await attempt(failures, accountId, "forgetSession", () =>
		deps.storage.forgetSession(accountId),
	);
	return finishCleanup(accountId, pre, deps.storage, failures);
}

/** Destroy one named transitional Account, including its cached ciphertext. */
export async function clearTransitionalAccount(
	accountId: string,
	deps: TransitionalAccountCleanupDeps,
): Promise<TransitionalAccountCleanupOutcome> {
	const failures: TransitionalAccountCleanupFailure[] = [];
	const pre = await readPreState(deps.storage, failures);
	await attempt(failures, accountId, "clearItemCache", () =>
		deps.itemCache.clearItemCache(accountId),
	);
	await attempt(failures, accountId, "clearAccountData", () =>
		deps.storage.clearAllStoredData(accountId),
	);

	if (pre.activeAccountId === accountId) {
		const successor = pre.accounts.find(
			(account) => account.accountId !== accountId,
		)?.accountId;
		if (successor !== undefined) {
			await attempt(failures, accountId, "setActiveAccount", () =>
				deps.storage.setActiveAccount(successor),
			);
		}
	}

	return finishCleanup(accountId, pre, deps.storage, failures);
}
