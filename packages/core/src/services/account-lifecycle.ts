/**
 * The one place that sequences the destructive account operations: lock, end a
 * session, remove an account, wipe the device.
 *
 * `AccountStore` and `ItemCache` are siblings that cannot reach each other
 * (packages/storage/CONTEXT.md §3), so §4.2 makes the *caller* responsible for
 * dropping both together. This module is that caller, once, for every platform;
 * apps state intent and apply their own UI, navigation and process effects
 * around it.
 *
 * Three binding rules:
 *
 * - Every per-account entry point takes a **required** `accountId` (§4.1).
 * - Nothing here throws. A failed step is recorded in `failures` and the next
 *   step still runs, so a half-failed sequence never strands ciphertext whose
 *   keys are gone. `failures.length === 0` is the success test.
 * - Every operation is idempotent, and a weaker operation after a stronger one
 *   (a lock after a removal) is a no-op rather than an error.
 *
 * ⚠️ `lockAllAccounts` is deliberately weaker than N × `lockAccount`:
 * `storage.clearSession` deletes the JWT, `storage.lockAllAccounts` keeps it.
 * Unifying upward would delete every JWT on every autolock and turn
 * quick-unlock into re-login, so the asymmetry stays.
 *
 * Plain functions over an explicit deps object — no class, no singleton, no
 * React — so an extension background service worker and the RN/desktop hooks
 * run the identical flow.
 */

import type { AccountStore, ItemCache } from "@bittery/storage";
import { findAccountById } from "@bittery/storage/account-id";
import type { AccountMetadata, ActiveAccountId } from "@bittery/storage/types";
import { selectActiveAccountAfterRemoval } from "./select-active-account";

/**
 * Machine-readable codes rather than messages: consumers only count failures
 * and decide whether to report one, and a code needs no translation here.
 */
export type LifecycleStep =
	// Callers treat a rejection as unrecoverable, so reads report like every other
	// step instead of escaping (a desktop keychain throw, CONTEXT.md §4.4).
	| "read_account_state"
	| "purge_credential_mirror"
	| "clear_item_cache"
	| "clear_session"
	| "forget_session"
	| "lock_all_accounts"
	| "clear_account_data"
	| "set_active_account"
	| "delete_server_account";

export interface LifecycleStepFailure {
	/** `null` for a device-scoped step that belongs to no single account. */
	accountId: string | null;
	step: LifecycleStep;
	/** The infrastructure throw, unclassified — this module does not interpret it. */
	cause: unknown;
}

/** Complete enough that no caller re-reads storage after the call. */
export interface LifecycleOutcome {
	/** Metadata, not ids — callers need `email`. Empty for an unknown target. */
	affected: AccountMetadata[];
	activeAccountId: string | undefined;
	activeAccount: AccountMetadata | null;
	/** Whether a targeted account was the active one when the call started. */
	wasActive: boolean;
	/** Accounts still on the device afterwards. */
	remaining: AccountMetadata[];
	/** Empty means every step completed. */
	failures: LifecycleStepFailure[];
}

export interface SessionCredentialRef {
	accountId: string;
	authToken: string | null;
	serverUrl: string | null;
}

/**
 * Copies of key material or bearer tokens this process handed outside
 * `AccountStore` — the Android autofill MUK mirror, the API client cache.
 * May drop more than asked (platforms without per-account granularity), never
 * less.
 */
export interface CredentialMirror {
	purge(refs: SessionCredentialRef[]): Promise<void>;
}

/** The explicit "this platform mirrors nothing" answer. */
export const NO_CREDENTIAL_MIRROR: CredentialMirror = {
	async purge(): Promise<void> {},
};

export interface LifecycleDeps {
	storage: AccountStore;
	itemCache: ItemCache;
	/**
	 * Required, not optional: CONTEXT.md §2 bans optional members at a seam, so
	 * no platform can silently forget to answer. Pass `NO_CREDENTIAL_MIRROR`.
	 */
	credentialMirror: CredentialMirror;
}

/** Only the deletion path talks to a server, so only it takes a client. */
export interface LifecycleServerClient {
	deleteAccount(input: { confirmEmail: string }): Promise<void>;
}

export interface AccountDeletionDeps extends LifecycleDeps {
	server: LifecycleServerClient;
}

export type InvalidationTarget =
	| "active"
	| { accountId: string }
	| { email: string }
	| { sessionId: string };

/**
 * Accounts and pointer as they were before anything was destroyed. The
 * successor and `wasActive` are both computed from this, never from a re-read.
 */
interface LifecyclePreState {
	accounts: AccountMetadata[];
	previousActive: ActiveAccountId;
}

async function readPreState(
	storage: AccountStore,
	failures: LifecycleStepFailure[],
): Promise<LifecyclePreState> {
	// Empty fallbacks, never a rethrow: an unreadable list means we cannot
	// enumerate, not that we refuse to destroy the id we were handed.
	const accounts = await step(failures, null, "read_account_state", () =>
		storage.getAccountsList(),
	);
	const previousActive = await step(failures, null, "read_account_state", () =>
		storage.getActiveAccount(),
	);
	return {
		accounts: accounts ?? [],
		previousActive: previousActive ?? null,
	};
}

async function step<T>(
	failures: LifecycleStepFailure[],
	accountId: string | null,
	name: LifecycleStep,
	run: () => Promise<T>,
): Promise<T | undefined> {
	try {
		return await run();
	} catch (cause) {
		failures.push({ accountId, step: name, cause });
		return undefined;
	}
}

/**
 * Read before anything is deleted: a mirror keyed by a token we already dropped
 * cannot be purged, and reading afterwards silently skips it.
 */
async function snapshotCredentials(
	storage: AccountStore,
	accountId: string,
	failures: LifecycleStepFailure[],
): Promise<SessionCredentialRef> {
	const authToken = await step(failures, accountId, "read_account_state", () =>
		storage.getAuthToken(accountId),
	);
	const serverUrl = await step(failures, accountId, "read_account_state", () =>
		storage.getServerUrl(accountId),
	);
	return {
		accountId,
		authToken: authToken ?? null,
		serverUrl: serverUrl ?? null,
	};
}

/**
 * Mirror before our own copy: dropping ours first and then failing leaves
 * Android autofill serving credentials while the UI says locked.
 */
async function purgeMirror(
	refs: SessionCredentialRef[],
	accountId: string | null,
	{ credentialMirror }: LifecycleDeps,
	failures: LifecycleStepFailure[],
): Promise<void> {
	await step(failures, accountId, "purge_credential_mirror", () =>
		credentialMirror.purge(refs),
	);
}

async function lockOne(
	accountId: string,
	deps: LifecycleDeps,
	failures: LifecycleStepFailure[],
): Promise<void> {
	const ref = await snapshotCredentials(deps.storage, accountId, failures);
	await purgeMirror([ref], accountId, deps, failures);
	// The item cache survives: it is ciphertext under `vault_keys`, which this
	// step deletes, so re-syncing it costs bandwidth and buys nothing.
	await step(failures, accountId, "clear_session", () =>
		deps.storage.clearSession(accountId),
	);
}

async function lockAll(
	accounts: AccountMetadata[],
	deps: LifecycleDeps,
	failures: LifecycleStepFailure[],
): Promise<void> {
	const refs: SessionCredentialRef[] = [];
	for (const account of accounts) {
		refs.push(
			await snapshotCredentials(deps.storage, account.accountId, failures),
		);
	}
	await purgeMirror(refs, null, deps, failures);
	await step(failures, null, "lock_all_accounts", () =>
		deps.storage.lockAllAccounts(),
	);
}

/** Sign-out and forced invalidation are the same sequence under two names. */
async function endSession(
	accountId: string,
	deps: LifecycleDeps,
	failures: LifecycleStepFailure[],
): Promise<void> {
	const ref = await snapshotCredentials(deps.storage, accountId, failures);
	await purgeMirror([ref], accountId, deps, failures);
	await step(failures, accountId, "clear_item_cache", () =>
		deps.itemCache.clearItemCache(accountId),
	);
	await step(failures, accountId, "forget_session", () =>
		deps.storage.forgetSession(accountId),
	);
}

async function removeOne(
	accountId: string,
	pre: LifecyclePreState,
	deps: LifecycleDeps,
	failures: LifecycleStepFailure[],
): Promise<void> {
	const ref = await snapshotCredentials(deps.storage, accountId, failures);
	await purgeMirror([ref], accountId, deps, failures);
	// Cache before the row: the accountId is the only name for the
	// `${accountId}:items|vaults|meta` segments, so once the accounts list is
	// rewritten nothing can enumerate them again and the ciphertext is orphaned.
	await step(failures, accountId, "clear_item_cache", () =>
		deps.itemCache.clearItemCache(accountId),
	);
	// `clearAllStoredData`, not `removeAccount`: strictly more complete, it also
	// drops `device_key` once the last account is gone.
	await step(failures, accountId, "clear_account_data", () =>
		deps.storage.clearAllStoredData(accountId),
	);

	// Computed from the pre-removal pointer, so a repeat removal finds the
	// pointer already at the successor, writes nothing, and does not demote it.
	const successor = selectActiveAccountAfterRemoval({
		removedAccountId: accountId,
		previousActive: pre.previousActive,
		accounts: pre.accounts,
	});
	if (!successor) {
		return;
	}
	await step(failures, accountId, "set_active_account", () =>
		deps.storage.setActiveAccount(successor),
	);
}

/** `null` when nothing on this device matches; the caller then destroys nothing. */
async function resolveTarget(
	target: InvalidationTarget,
	{ accounts, previousActive }: LifecyclePreState,
	storage: AccountStore,
	failures: LifecycleStepFailure[],
): Promise<string | null> {
	if (target === "active") {
		return previousActive;
	}
	// An id the device does not know is still returned: a half-removed account
	// must stay cleanable, so the full destructive path runs anyway.
	if ("accountId" in target) {
		return target.accountId;
	}
	if ("email" in target) {
		const email = target.email.trim().toLowerCase();
		return (
			accounts.find((account) => account.email.trim().toLowerCase() === email)
				?.accountId ?? null
		);
	}

	// Only the stored session record names its server session, so this scans.
	for (const account of accounts) {
		const session = await step(
			failures,
			account.accountId,
			"read_account_state",
			() => storage.getStoredSessionData(account.accountId),
		);
		if (session?.sessionId === target.sessionId) {
			return account.accountId;
		}
	}
	return null;
}

function affectedOf(
	accounts: AccountMetadata[],
	accountId: string,
): AccountMetadata[] {
	const metadata = findAccountById(accounts, accountId);
	return metadata ? [metadata] : [];
}

async function buildOutcome(
	storage: AccountStore,
	pre: LifecyclePreState,
	affected: AccountMetadata[],
	failures: LifecycleStepFailure[],
): Promise<LifecycleOutcome> {
	const remaining =
		(await step(failures, null, "read_account_state", () =>
			storage.getAccountsList(),
		)) ?? [];
	const active = await step(failures, null, "read_account_state", () =>
		storage.getActiveAccount(),
	);
	const activeAccountId = active ?? undefined;

	return {
		affected,
		activeAccountId,
		activeAccount: activeAccountId
			? (findAccountById(remaining, activeAccountId) ?? null)
			: null,
		wasActive: affected.some(
			(account) => account.accountId === pre.previousActive,
		),
		remaining,
		failures,
	};
}

/** Lock one account: keeps `session_data` and the item cache, so quick-unlock survives. */
export async function lockAccount(
	accountId: string,
	deps: LifecycleDeps,
): Promise<LifecycleOutcome> {
	const failures: LifecycleStepFailure[] = [];
	const pre = await readPreState(deps.storage, failures);
	await lockOne(accountId, deps, failures);
	return buildOutcome(
		deps.storage,
		pre,
		affectedOf(pre.accounts, accountId),
		failures,
	);
}

/** Lock every account. Deliberately weaker than N × `lockAccount` — see the header. */
export async function lockAllAccounts(
	deps: LifecycleDeps,
): Promise<LifecycleOutcome> {
	const failures: LifecycleStepFailure[] = [];
	const pre = await readPreState(deps.storage, failures);
	await lockAll(pre.accounts, deps, failures);
	return buildOutcome(deps.storage, pre, pre.accounts, failures);
}

/** The user asked to sign out: the session and its item cache go, the account stays. */
export async function signOutAccount(
	accountId: string,
	deps: LifecycleDeps,
): Promise<LifecycleOutcome> {
	const failures: LifecycleStepFailure[] = [];
	const pre = await readPreState(deps.storage, failures);
	await endSession(accountId, deps, failures);
	return buildOutcome(
		deps.storage,
		pre,
		affectedOf(pre.accounts, accountId),
		failures,
	);
}

/**
 * The server rejected this account's credentials. Same sequence as
 * `signOutAccount` under the name of its trigger, plus target resolution.
 */
export async function invalidateAccountSession(
	target: InvalidationTarget,
	deps: LifecycleDeps,
): Promise<LifecycleOutcome> {
	const failures: LifecycleStepFailure[] = [];
	const pre = await readPreState(deps.storage, failures);
	const accountId = await resolveTarget(target, pre, deps.storage, failures);
	if (!accountId) {
		return buildOutcome(deps.storage, pre, [], failures);
	}
	await endSession(accountId, deps, failures);
	return buildOutcome(
		deps.storage,
		pre,
		affectedOf(pre.accounts, accountId),
		failures,
	);
}

/** Remove an account from this device and promote a successor if it was active. */
export async function removeAccount(
	accountId: string,
	deps: LifecycleDeps,
): Promise<LifecycleOutcome> {
	const failures: LifecycleStepFailure[] = [];
	const pre = await readPreState(deps.storage, failures);
	await removeOne(accountId, pre, deps, failures);
	return buildOutcome(
		deps.storage,
		pre,
		affectedOf(pre.accounts, accountId),
		failures,
	);
}

/** Remove every account and the device-scoped material behind them. */
export async function wipeDevice(
	deps: LifecycleDeps,
): Promise<LifecycleOutcome> {
	const failures: LifecycleStepFailure[] = [];
	const pre = await readPreState(deps.storage, failures);

	for (const account of pre.accounts) {
		await removeOne(account.accountId, pre, deps, failures);
	}

	// Device-scoped pass so an already-empty device still drops `device_key`,
	// which only becomes droppable once no account is left to unwrap.
	await step(failures, null, "clear_account_data", () =>
		deps.storage.clearAllStoredData(),
	);

	return buildOutcome(deps.storage, pre, pre.accounts, failures);
}

/** Delete the account on the server, then remove every trace of it locally. */
export async function deleteAccountEverywhere(
	input: { accountId: string; confirmEmail: string },
	deps: AccountDeletionDeps,
): Promise<LifecycleOutcome> {
	const { accountId, confirmEmail } = input;
	const failures: LifecycleStepFailure[] = [];
	const pre = await readPreState(deps.storage, failures);

	const deleted = await step(
		failures,
		accountId,
		"delete_server_account",
		async () => {
			await deps.server.deleteAccount({ confirmEmail });
			return true;
		},
	);
	// The only step allowed to stop a sequence: destroying local data for an
	// account the server still holds is worse than doing nothing.
	if (!deleted) {
		return buildOutcome(
			deps.storage,
			pre,
			affectedOf(pre.accounts, accountId),
			failures,
		);
	}

	await removeOne(accountId, pre, deps, failures);
	return buildOutcome(
		deps.storage,
		pre,
		affectedOf(pre.accounts, accountId),
		failures,
	);
}
