/**
 * The one wrapper around the unlock primitives: turn a credential into unlocked
 * sessions, verify travel mode per account, and pick the account to make active.
 *
 * Plain functions over an explicit deps object — deliberately no class, no
 * singleton and no React — so an extension background service worker and the
 * RN/desktop hooks run the identical flow.
 */

import { getDefaultServerUrl } from "@bittery/shared/rpc-client-factory";
import type { AccountStore, ItemCache } from "@bittery/storage";
import { findAccountById } from "@bittery/storage/account-id";
import type { AccountMetadata } from "@bittery/storage/types";
import type { ICrypto } from "@bittery/types";
import { performSRPUnlock, storeUnlockSession } from "./auth-service";
import {
	createStaticStoredAccountRpcClient,
	createStoredAccountRpcClient,
} from "./rpc-client";
import { selectActiveAccountAfterUnlock } from "./select-active-account";
import {
	getTravelModeEnforcer,
	TravelModeVerificationError,
} from "./travel-mode-enforcer";
import type { TravelModeRpcClient } from "./travel-mode-service";

export type UnlockCredential =
	| { kind: "password"; password: string }
	| { kind: "biometric"; promptMessage: string };

/**
 * Machine-readable codes rather than messages: every consumer only counts
 * failures, and a code needs no translation at the point it is produced.
 */
export type UnlockFailureReason =
	| "no_stored_secret_key"
	| "no_auth_token"
	| "credential_rejected"
	| "travel_mode_unverified";

export interface UnlockFailure {
	accountId: string;
	email: string;
	reason: UnlockFailureReason;
}

export interface UnlockOutcome {
	/** Chosen active account, reported even when the write was skipped. */
	activeAccountId: string | undefined;
	/** Account ids that unlocked *and* passed travel mode — never emails. */
	unlocked: string[];
	failed: UnlockFailure[];
}

export interface UnlockDeps {
	storage: AccountStore;
	itemCache: ItemCache;
	crypto: ICrypto;
}

export interface UnlockOptions {
	/**
	 * `false` skips the active-account write entirely (desktop key-material path).
	 * The account that would have been chosen is still reported.
	 */
	setActive?: boolean;
}

/** An account whose secrets are restored but whose policy is not verified yet. */
interface UnlockCandidate {
	account: AccountMetadata;
	rpcClient: TravelModeRpcClient | null;
}

interface AcquireResult {
	candidates: UnlockCandidate[];
	failed: UnlockFailure[];
}

async function acquireWithPassword(
	targets: AccountMetadata[],
	password: string,
	{ storage, itemCache, crypto }: UnlockDeps,
): Promise<AcquireResult> {
	const candidates: UnlockCandidate[] = [];
	const failed: UnlockFailure[] = [];

	for (const account of targets) {
		const { accountId, email } = account;
		try {
			if (!(await storage.hasStoredSecretKey(accountId))) {
				failed.push({ accountId, email, reason: "no_stored_secret_key" });
				continue;
			}

			// Static client: an unlock runs before a session exists, so there is
			// nothing for a refreshing client to refresh against.
			const rpcClient = await createStaticStoredAccountRpcClient(
				storage,
				accountId,
			);
			if (!rpcClient) {
				failed.push({ accountId, email, reason: "no_auth_token" });
				continue;
			}

			const serverUrl =
				(await storage.getServerUrl(accountId)) || getDefaultServerUrl();
			const result = await performSRPUnlock(
				{ accountId, password },
				{ crypto, rpcClient, storage },
			);
			await storeUnlockSession(result, storage, itemCache, accountId, {
				travelModeRpcClient: rpcClient,
				serverUrl,
				setActive: false,
			});

			candidates.push({ account, rpcClient });
		} catch (error) {
			// The credential was accepted before travel mode is verified, so a
			// verification failure must not be reported as a rejected password.
			failed.push({
				accountId,
				email,
				reason:
					error instanceof TravelModeVerificationError
						? "travel_mode_unverified"
						: "credential_rejected",
			});
		}
	}

	return { candidates, failed };
}

async function acquireWithBiometric(
	targets: AccountMetadata[],
	promptMessage: string,
	{ storage }: UnlockDeps,
): Promise<AcquireResult> {
	// One OS prompt for every account; it restores the stored MUKs but does not
	// verify travel mode, which is why the caller below still has to.
	const { unlocked } =
		await storage.unlockAllAccountsWithBiometric(promptMessage);
	const restored = new Set(unlocked);

	const candidates: UnlockCandidate[] = [];
	const failed: UnlockFailure[] = [];

	for (const account of targets) {
		const { accountId, email } = account;
		if (!restored.has(accountId)) {
			failed.push({ accountId, email, reason: "credential_rejected" });
			continue;
		}
		// Refreshing client: the biometric restore already produced a live session.
		// A missing token is not fatal here — the enforcer then verifies offline.
		const rpcClient = await createStoredAccountRpcClient(
			storage,
			accountId,
		).catch(() => null);
		candidates.push({ account, rpcClient });
	}

	return { candidates, failed };
}

async function runUnlock(
	targets: AccountMetadata[],
	accounts: AccountMetadata[],
	credential: UnlockCredential,
	deps: UnlockDeps,
	opts?: UnlockOptions,
): Promise<UnlockOutcome> {
	const { storage, itemCache } = deps;
	// Read before anything unlocks: the account the user was last using is the
	// answer, and the acquire step below can move the stored pointer.
	const previousActive = await storage.getActiveAccount();

	const { candidates, failed } =
		credential.kind === "password"
			? await acquireWithPassword(targets, credential.password, deps)
			: await acquireWithBiometric(targets, credential.promptMessage, deps);

	const enforcer = getTravelModeEnforcer(storage, itemCache);
	const unlocked: string[] = [];
	for (const { account, rpcClient } of candidates) {
		if (await enforcer.verifyOrClear(account.accountId, rpcClient)) {
			unlocked.push(account.accountId);
			continue;
		}
		failed.push({
			accountId: account.accountId,
			email: account.email,
			reason: "travel_mode_unverified",
		});
	}

	// Nothing survived: leave the stored pointer alone rather than promoting an
	// account that never unlocked or that failed travel mode.
	if (unlocked.length === 0) {
		return { activeAccountId: undefined, unlocked, failed };
	}

	const activeAccountId = selectActiveAccountAfterUnlock({
		previousActive,
		unlockedAccountIds: unlocked,
		accounts,
	});
	if (activeAccountId && opts?.setActive !== false) {
		await storage.setActiveAccount({
			type: "single",
			accountId: activeAccountId,
		});
	}

	return { activeAccountId, unlocked, failed };
}

/** Unlock every account (optionally narrowed to `emails`) with one credential. */
export async function unlockAll(
	input: { credential: UnlockCredential; emails?: string[] },
	deps: UnlockDeps,
	opts?: UnlockOptions,
): Promise<UnlockOutcome> {
	const { credential, emails } = input;
	const accounts = await deps.storage.getAccountsList();
	const targets = emails
		? accounts.filter((account) => emails.includes(account.email))
		: accounts;
	return runUnlock(targets, accounts, credential, deps, opts);
}

/** Unlock a single account through the same policy and selection path. */
export async function unlockAccount(
	input: { accountId: string; credential: UnlockCredential },
	deps: UnlockDeps,
	opts?: UnlockOptions,
): Promise<UnlockOutcome> {
	const { accountId, credential } = input;
	const accounts = await deps.storage.getAccountsList();
	const account = findAccountById(accounts, accountId);
	if (!account) {
		return {
			activeAccountId: undefined,
			unlocked: [],
			failed: [{ accountId, email: "", reason: "no_stored_secret_key" }],
		};
	}
	return runUnlock([account], accounts, credential, deps, opts);
}
