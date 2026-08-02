/**
 * The one wrapper around the unlock primitives: turn a credential into unlocked
 * sessions, verify travel mode per account, and pick the account to make active.
 *
 * Plain functions over an explicit deps object — deliberately no class, no
 * singleton and no React — so an extension background service worker and the
 * RN/desktop hooks run the identical flow.
 */

import { getDefaultServerUrl } from "@bittery/shared/rpc-client-factory";
import type {
	AccountStore,
	BiometricErrorType,
	ItemCache,
} from "@bittery/storage";
import { findAccountById } from "@bittery/storage/account-id";
import type { AccountMetadata, ActiveAccountId } from "@bittery/storage/types";
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

/**
 * Machine-readable codes rather than messages: every consumer only counts
 * failures, and a code needs no translation at the point it is produced.
 */
export type UnlockFailureReason =
	| "no_stored_secret_key"
	| "no_auth_token"
	| "credential_rejected"
	| "travel_mode_unverified";

/**
 * Why the OS said no, kept structured so the UI can tell "not enrolled" from
 * "locked out" from "your password is due again" — `credential_rejected` alone
 * cannot. Deliberately shaped like the mobile `BiometricErrorDetail` renderer so
 * it can be handed straight to it.
 */
export interface BiometricFailureDetail {
	error: BiometricErrorType;
	masterPasswordReentryPeriodMs?: number;
}

export interface UnlockFailure {
	accountId: string;
	email: string;
	reason: UnlockFailureReason;
	/** Only ever set alongside `credential_rejected` on a biometric unlock. */
	biometric?: BiometricFailureDetail;
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
}

/** Only the SRP (password) path derives keys, so only it takes an `ICrypto`. */
export interface PasswordUnlockDeps extends UnlockDeps {
	crypto: ICrypto;
}

export interface UnlockOptions {
	/**
	 * `false` skips the active-account write entirely (desktop key-material path).
	 * The account that would have been chosen is still reported.
	 */
	setActive?: boolean;
}

/** An account whose secrets are restored, ready for the shared finish step. */
interface UnlockCandidate {
	account: AccountMetadata;
	rpcClient: TravelModeRpcClient | null;
	/**
	 * Whether the acquire step already verified travel mode. Only the password
	 * path has, through `storeUnlockSession`; re-verifying would cost a second
	 * server round trip and a second purge per account.
	 */
	verified: boolean;
}

interface AcquireResult {
	candidates: UnlockCandidate[];
	failed: UnlockFailure[];
}

/** What the accounts to unlock are, and what the unlock has to restore afterwards. */
interface UnlockPlan {
	/** Every account, ranked by `selectActiveAccountAfterUnlock`. */
	accounts: AccountMetadata[];
	targets: AccountMetadata[];
	/**
	 * Read before the credential is spent: the account the user was last using is
	 * the answer, and acquiring can move the stored pointer.
	 */
	previousActive: ActiveAccountId;
}

async function planAll(
	storage: AccountStore,
	emails: string[] | undefined,
): Promise<UnlockPlan> {
	const accounts = await storage.getAccountsList();
	const targets = emails
		? accounts.filter((account) => emails.includes(account.email))
		: accounts;
	return {
		accounts,
		targets,
		previousActive: await storage.getActiveAccount(),
	};
}

/** `null` for an account this device does not know. */
async function planOne(
	storage: AccountStore,
	accountId: string,
): Promise<(UnlockPlan & { target: AccountMetadata }) | null> {
	const accounts = await storage.getAccountsList();
	const account = findAccountById(accounts, accountId);
	if (!account) {
		return null;
	}
	return {
		accounts,
		targets: [account],
		target: account,
		previousActive: await storage.getActiveAccount(),
	};
}

function unknownAccountOutcome(accountId: string): UnlockOutcome {
	return {
		activeAccountId: undefined,
		unlocked: [],
		failed: [{ accountId, email: "", reason: "no_stored_secret_key" }],
	};
}

async function acquireWithPassword(
	targets: AccountMetadata[],
	password: string,
	{ storage, itemCache, crypto }: PasswordUnlockDeps,
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

			candidates.push({ account, rpcClient, verified: true });
		} catch (error) {
			// The credential was accepted before travel mode is verified, so a
			// verification failure must not be reported as a rejected password.
			if (error instanceof TravelModeVerificationError) {
				// Fail closed: a `local`-mode unlock writes nothing before verifying,
				// so any session already on disk would survive unverified.
				await storage.clearSession(accountId);
				failed.push({ accountId, email, reason: "travel_mode_unverified" });
				continue;
			}
			failed.push({ accountId, email, reason: "credential_rejected" });
		}
	}

	return { candidates, failed };
}

function biometricFailure(
	{ accountId, email }: AccountMetadata,
	detail: BiometricFailureDetail,
): UnlockFailure {
	return { accountId, email, reason: "credential_rejected", biometric: detail };
}

/**
 * The narrowed acquire: one account's prompt, one account's key. The batched
 * call below cannot express that, because its single prompt covers the device.
 */
async function acquireOneWithBiometric(
	account: AccountMetadata,
	promptMessage: string,
	{ storage }: UnlockDeps,
): Promise<AcquireResult> {
	const { accountId } = account;

	const result = await storage.authenticateWithBiometricEnhanced(
		promptMessage,
		accountId,
	);
	if (!result.success) {
		const detail: BiometricFailureDetail = { error: result.error ?? "unknown" };
		if (result.masterPasswordReentryPeriodMs !== undefined) {
			detail.masterPasswordReentryPeriodMs =
				result.masterPasswordReentryPeriodMs;
		}
		return { candidates: [], failed: [biometricFailure(account, detail)] };
	}

	// The prompt normally does not re-appear here — the call above just refreshed
	// the grace window — but the reason is threaded through so that if it ever
	// does, the OS shows the caller's translated copy over the English fallback.
	if (!(await storage.unlockWithBiometric(accountId, promptMessage))) {
		return {
			candidates: [],
			failed: [biometricFailure(account, { error: "authentication_failed" })],
		};
	}

	// A missing token is not fatal: the enforcer then verifies offline.
	const rpcClient = await createStoredAccountRpcClient(
		storage,
		accountId,
	).catch(() => null);
	return { candidates: [{ account, rpcClient, verified: false }], failed: [] };
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
	const requested = new Set(targets.map(({ accountId }) => accountId));

	// The prompt covers the device, the caller's narrowing does not, so anything
	// it restored outside `targets` would sit unlocked with travel mode never
	// verified. Lock it rather than `clearSession`: the user asked for a narrower
	// unlock, not to discard these accounts' vault keys and auth token.
	for (const accountId of restored) {
		if (!requested.has(accountId)) {
			await storage.clearMasterUnlockKey(accountId);
		}
	}

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
		candidates.push({ account, rpcClient, verified: false });
	}

	return { candidates, failed };
}

/**
 * Everything after the credential is spent — only the acquire step differs
 * between the credential kinds, so both paths finish here.
 */
async function runUnlock(
	{ candidates, failed }: AcquireResult,
	{ accounts, previousActive }: UnlockPlan,
	{ storage, itemCache }: UnlockDeps,
	opts?: UnlockOptions,
): Promise<UnlockOutcome> {
	const enforcer = getTravelModeEnforcer(storage, itemCache);
	const unlocked: string[] = [];
	for (const { account, rpcClient, verified } of candidates) {
		if (
			verified ||
			(await enforcer.verifyOrClear(account.accountId, rpcClient))
		) {
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
		await storage.setActiveAccount(activeAccountId);
	}

	return { activeAccountId, unlocked, failed };
}

/** Unlock every account (optionally narrowed to `emails`) with one password. */
export async function unlockAllWithPassword(
	input: { password: string; emails?: string[] },
	deps: PasswordUnlockDeps,
	opts?: UnlockOptions,
): Promise<UnlockOutcome> {
	const plan = await planAll(deps.storage, input.emails);
	const acquired = await acquireWithPassword(
		plan.targets,
		input.password,
		deps,
	);
	return runUnlock(acquired, plan, deps, opts);
}

/** Unlock every account (optionally narrowed to `emails`) with one OS prompt. */
export async function unlockAllWithBiometric(
	input: { promptMessage: string; emails?: string[] },
	deps: UnlockDeps,
	opts?: UnlockOptions,
): Promise<UnlockOutcome> {
	const plan = await planAll(deps.storage, input.emails);
	const acquired = await acquireWithBiometric(
		plan.targets,
		input.promptMessage,
		deps,
	);
	return runUnlock(acquired, plan, deps, opts);
}

/** Unlock a single account through the same policy and selection path. */
export async function unlockAccountWithPassword(
	input: { accountId: string; password: string },
	deps: PasswordUnlockDeps,
	opts?: UnlockOptions,
): Promise<UnlockOutcome> {
	const plan = await planOne(deps.storage, input.accountId);
	if (!plan) {
		return unknownAccountOutcome(input.accountId);
	}
	const acquired = await acquireWithPassword(
		plan.targets,
		input.password,
		deps,
	);
	return runUnlock(acquired, plan, deps, opts);
}

/** Unlock a single account through the same policy and selection path. */
export async function unlockAccountWithBiometric(
	input: { accountId: string; promptMessage: string },
	deps: UnlockDeps,
	opts?: UnlockOptions,
): Promise<UnlockOutcome> {
	const plan = await planOne(deps.storage, input.accountId);
	if (!plan) {
		return unknownAccountOutcome(input.accountId);
	}
	const acquired = await acquireOneWithBiometric(
		plan.target,
		input.promptMessage,
		deps,
	);
	return runUnlock(acquired, plan, deps, opts);
}
