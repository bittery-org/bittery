/**
 * The three Web gestures that take an Account away, and the one set of rules they share.
 *
 * - `removeAccountFromDevice` is the sidebar's "Log out", which on this platform means
 *   "remove this Account from this Device".
 * - `retireAccountSession` is the sign-in screen's "Use a different account". It retires
 *   the Session and keeps the Account, because that screen cannot prove who is pressing it.
 * - `deleteAccountEverywhereFromDevice` is the Danger Zone. It deletes on the Server first,
 *   then destroys this Device's copy exactly as a log out does.
 *
 * Two independent stores hold Account material in a browser, and they name the Account
 * differently. The Runtime knows it by its `AccountId` and owns the Replica, the platform
 * namespace, the Attachment artifacts and the OPFS spool. The transitional store knows it by
 * whichever id `AccountStore` is currently pointed at — before the first sign-in the
 * synthetic `bittery_web_account_id` from `storage.ts`, and after one the id
 * `resolveOrCreateAccountId` minted or reused for that (server, user) pair. It owns the
 * `bittery_account_*` keys and the cached ciphertext. Neither store can destroy the other's
 * material, so every gesture here drives both and reports the union.
 *
 * The Runtime goes first, because it is the authority. Nothing else is destroyed and no
 * pointer moves until it answers `complete`: a host that cleared its own keys over a
 * surviving Replica would look signed out while named data remained, which is exactly the
 * lie the closed teardown outcome exists to prevent.
 *
 * Both names are resolved once, at the gesture, and carried on every retry. Re-resolving is
 * unsafe in both stores: the Runtime's observed catalog stops answering once catalog
 * detachment succeeds, and the transitional store writes its active pointer to `null` before
 * it sweeps the values, so a re-resolving retry would find no account, destroy nothing, and
 * report success over surviving `secret_key` material. A transitional id that resolves to
 * `null` is that half-removal, so it is reported as one and never cleared under.
 *
 * A wedged Runtime refuses its side forever, so two gestures carry one bounded escape
 * each, offered only after repeated refusal: `clearBrowserStoredDataOnly` for the log out
 * and `forgetBrowserSessionOnly` for the retirement. Both touch the transitional store
 * alone, both report what the Runtime kept, and neither calls itself a removal. The Danger
 * Zone deletion has no escape yet.
 *
 * Every decision lives here rather than in a component, so a unit test can reach it.
 */

import {
	type RuntimeTeardown,
	transportErrorCode,
} from "@bittery/client-runtime/client";
import type {
	RuntimeErrorCode,
	TeardownPhase,
} from "@bittery/client-runtime/protocol";

/**
 * A place that still holds Account material after a teardown asked it to let go.
 *
 * The Runtime's own phases, plus the three this Web host owns: the transitional browser
 * store, the Runtime's live access for an Account it keeps (a retirement, not a removal),
 * and the Server's copy of the Account (a deletion, not a removal).
 */
export type AccountRemovalArea =
	| TeardownPhase
	| "transitionalStore"
	| "runtimeSession"
	| "serverAccount";

/**
 * What the transitional store answers, structurally.
 *
 * Declared here rather than imported as `LifecycleOutcome` so this module names no
 * transitional lifecycle type. An empty `failures` list is that module's own success test.
 */
export interface TransitionalClearOutcome {
	readonly failures: readonly unknown[];
}

/** The two names one Account answers to on this Device, resolved once per gesture. */
export interface AccountRemovalTarget {
	/** The Runtime's `AccountId`, or `null` when the Runtime holds no Account. */
	readonly runtimeAccountId: string | null;
	/** The transitional store's active account id. Not the Runtime's `AccountId`. */
	readonly transitionalAccountId: string | null;
}

/** What every gesture here needs first: the two names this Device knows the Account by. */
export interface AccountNameDeps {
	/** The Runtime's active Account. Read once; a later read can answer `null`. */
	resolveRuntimeAccountId(): string | null;
	/** The transitional store's active account. Read once, for the same reason. */
	resolveTransitionalAccountId(): Promise<string | null>;
	/** Moves the host's active-Account pointer, `bittery_runtime_account_id`. */
	selectAccount(accountId: string | null): void;
}

export interface AccountRemovalDeps extends AccountNameDeps {
	/** Destroys one named Account inside the Runtime and answers the whole outcome. */
	removeAccount(accountId: string): Promise<RuntimeTeardown>;
	/**
	 * Destroys the named transitional account's data and its cached ciphertext.
	 *
	 * Named, never `null`: a sweep with no name destroys nothing and reports no failure.
	 */
	clearTransitionalAccountData(
		accountId: string,
	): Promise<TransitionalClearOutcome>;
	/** Forgets the synthetic pre-login id. */
	forgetTransitionalAccountId(): void;
	/**
	 * Records the transitional name of an Account whose Server copy is already deleted, or
	 * clears the record with `null`. See `AccountDeletionIncomplete`.
	 *
	 * Every removal needs the clear, not only the deletion that writes it. A deletion the
	 * user abandoned leaves the record behind, and nothing else on this Device drops it.
	 */
	writeDeletedServerAccountId(accountId: string | null): void;
}

/**
 * A log out that did not finish, and everything an identical retry needs.
 *
 * There is deliberately one failure shape and it is always retryable. A teardown-fenced
 * Runtime answers `ACCOUNT_MISSING`, which reads like "no such Account" and is not: it is a
 * removal that is still in progress. Giving that code its own arm would invite a screen that
 * tells the user their Account is gone while its Replica rows are still on the Device.
 */
export interface TeardownIncomplete {
	readonly status: "incomplete";
	/** The names a retry must reuse. `null` when resolving them is what failed. */
	readonly target: AccountRemovalTarget | null;
	/** Attempts made so far, this one included. */
	readonly attempts: number;
	/** Every store that still holds material, in a stable order. */
	readonly areas: readonly AccountRemovalArea[];
	/** The Runtime's refusal code, when it refused instead of answering. */
	readonly code: RuntimeErrorCode | null;
}

export interface AccountRemovalIncomplete extends TeardownIncomplete {
	/** Whether to offer the browser-only escape hatch. See `clearBrowserStoredDataOnly`. */
	readonly canClearBrowserDataOnly: boolean;
}

/**
 * Log out either destroyed everything it named, cleared this browser only, or did neither.
 *
 * `browserDataCleared` is never a removal. It says one store let go and says nothing about
 * the Account, which may still exist on this Device and on the Server.
 */
export type AccountRemovalResult =
	| { readonly status: "removed" }
	| { readonly status: "browserDataCleared" }
	| AccountRemovalIncomplete;

/**
 * The order a report lists surviving stores in, widest first.
 *
 * The Runtime's `failures` list carries no order of its own, so a fixed one here keeps the
 * same partial failure reading the same way on every attempt.
 */
const AREA_ORDER: readonly AccountRemovalArea[] = [
	"serverAccount",
	"replica",
	"platformStorage",
	"attachmentArtifacts",
	"hostCleanup",
	"runtimeSession",
	"transitionalStore",
];

function ordered(
	areas: readonly AccountRemovalArea[],
): readonly AccountRemovalArea[] {
	return AREA_ORDER.filter((area) => areas.includes(area));
}

/**
 * Failed attempts before the browser-only escape hatch appears.
 *
 * One failure is ordinary: a platform-namespace failure forbids the Replica phase, so a
 * converging Device needs a second attempt and sometimes a third. Two failures mean the
 * Runtime is not converging, and on a wedged Device account-scope `RemoveAccount` keeps its
 * `ensure_open()` precondition and will refuse every time.
 */
const ATTEMPTS_BEFORE_BROWSER_ESCAPE = 2;

function baseReport(
	target: AccountRemovalTarget | null,
	attempts: number,
	areas: readonly AccountRemovalArea[],
	code: RuntimeErrorCode | null,
): TeardownIncomplete {
	return {
		status: "incomplete",
		target,
		attempts,
		areas: ordered(areas),
		code,
	};
}

/**
 * Whether a browser-only escape can be offered yet.
 *
 * Nothing to offer without a transitional name: the escape would clear nothing and still
 * have to call itself a success. That covers an unresolved target and a target whose
 * transitional id came back `null`.
 */
function canOfferBrowserEscape(
	target: AccountRemovalTarget | null,
	attempts: number,
): boolean {
	return (
		target !== null &&
		target.transitionalAccountId !== null &&
		attempts >= ATTEMPTS_BEFORE_BROWSER_ESCAPE
	);
}

/**
 * Whether an identical retry can still finish, or only this page load stands in the way.
 *
 * A transitional pointer that resolved to `null` is refused on every attempt, because
 * nothing re-seeds it before a reload. A screen that offers "Try again" there promises
 * something that cannot happen, however many times the user presses it.
 */
export function retryCannotFinish(report: TeardownIncomplete): boolean {
	return report.target !== null && report.target.transitionalAccountId === null;
}

function incomplete(
	target: AccountRemovalTarget | null,
	attempts: number,
	areas: readonly AccountRemovalArea[],
	code: RuntimeErrorCode | null,
): AccountRemovalIncomplete {
	return {
		...baseReport(target, attempts, areas, code),
		canClearBrowserDataOnly: canOfferBrowserEscape(target, attempts),
	};
}

/** A target whose transitional name is known. Nothing is destroyed without one. */
interface NamedAccountTarget {
	readonly runtimeAccountId: string | null;
	readonly transitionalAccountId: string;
}

/** One step that did not finish: what still holds material, and why, when the Runtime said. */
interface StepFailure {
	readonly areas: readonly AccountRemovalArea[];
	readonly code: RuntimeErrorCode | null;
}

type TargetResolution =
	| {
			readonly named: NamedAccountTarget;
			readonly target: AccountRemovalTarget;
	  }
	| (StepFailure & {
			readonly named: null;
			readonly target: AccountRemovalTarget | null;
	  });

/**
 * Both names, resolved once per gesture and carried on every retry.
 *
 * Shared by all three gestures because the hazard is shared: re-resolving can answer for a
 * different Account, or for none, over material that is still there.
 */
async function resolveNamedTarget(
	previous: TeardownIncomplete | null,
	deps: AccountNameDeps,
): Promise<TargetResolution> {
	let target = previous?.target ?? null;
	if (target === null) {
		try {
			target = {
				runtimeAccountId: deps.resolveRuntimeAccountId(),
				transitionalAccountId: await deps.resolveTransitionalAccountId(),
			};
		} catch (error) {
			// Reported with no target, so the retry resolves again. Nothing was destroyed.
			return {
				named: null,
				target: null,
				areas: [],
				code: transportErrorCode(error),
			};
		}
	}

	// After `initializeStorage()` the transitional pointer is never legitimately null in a
	// browser: the store seeds it with the synthetic id. So `null` means the store emptied
	// its own pointer during a half-failed sweep, over values that survived, and nothing
	// re-seeds it in this page load. Acting under that name would destroy nothing and
	// report success over a `secret_key` that is still in `localStorage`.
	if (target.transitionalAccountId === null) {
		return { named: null, target, areas: ["transitionalStore"], code: null };
	}

	return {
		named: {
			runtimeAccountId: target.runtimeAccountId,
			transitionalAccountId: target.transitionalAccountId,
		},
		target,
	};
}

/**
 * Destroy one named Account in both stores. `null` means every store let go.
 *
 * The Runtime goes first, because it is the authority. Nothing else is destroyed and no
 * pointer moves until it answers `complete`.
 */
async function destroyLocalAccount(
	named: NamedAccountTarget,
	deps: AccountRemovalDeps,
): Promise<StepFailure | null> {
	if (named.runtimeAccountId !== null) {
		let teardown: RuntimeTeardown;
		try {
			teardown = await deps.removeAccount(named.runtimeAccountId);
		} catch (error) {
			// A refusal names no phase, so nothing is known to have been destroyed. It is
			// reported and stays retryable rather than becoming a silent success.
			return { areas: [], code: transportErrorCode(error) };
		}
		if (teardown.status !== "complete") {
			return { areas: teardown.failures, code: null };
		}
	}

	try {
		const transitional = await deps.clearTransitionalAccountData(
			named.transitionalAccountId,
		);
		if (transitional.failures.length > 0) {
			return { areas: ["transitionalStore"], code: null };
		}
		// Last, and only here: the pre-login id can still name surviving data, and both
		// pointer writes touch storage that can throw.
		deps.forgetTransitionalAccountId();
		deps.selectAccount(null);
	} catch (error) {
		// The host duties throw for their own reasons — a `localStorage` write, a runtime
		// refresh that reads the store and emits. An unreported rejection would leave the
		// dialog running forever, so it becomes the same retryable report as everything else.
		return { areas: ["transitionalStore"], code: transportErrorCode(error) };
	}
	// Nothing local is left for the record to guard, and it is the last stray `bittery_*`
	// key a removal could leave behind. It swallows its own failure, so it cannot undo
	// any of the destruction above it.
	rememberServerAccountDeleted(null, deps);
	return null;
}

export async function removeAccountFromDevice(
	previous: AccountRemovalIncomplete | null,
	deps: AccountRemovalDeps,
): Promise<AccountRemovalResult> {
	const attempts = (previous?.attempts ?? 0) + 1;
	const resolved = await resolveNamedTarget(previous, deps);
	if (resolved.named === null) {
		return incomplete(resolved.target, attempts, resolved.areas, resolved.code);
	}

	const failure = await destroyLocalAccount(resolved.named, deps);
	if (failure !== null) {
		return incomplete(resolved.target, attempts, failure.areas, failure.code);
	}
	return { status: "removed" };
}

/**
 * The escape hatch: delete what this browser stored, and nothing else.
 *
 * Account-scope `RemoveAccount` keeps `ensure_open()`, so on a wedged Device the Runtime
 * refuses every attempt. Gating the transitional clear behind Runtime success would then
 * take away something the user had before this slice: dropping `secret_key` out of plain
 * `localStorage`. On a shared machine that is the whole point of the button.
 *
 * This touches no Runtime-owned state. It does not call `removeAccount`, and it leaves
 * `bittery_runtime_account_id` alone: the Runtime stays the single authority over its own
 * data. It is a legacy-store escape hatch, not a second deletion path.
 *
 * Its outcome is `browserDataCleared`, never `removed`, because the Account was not removed.
 */
export async function clearBrowserStoredDataOnly(
	previous: AccountRemovalIncomplete,
	deps: AccountRemovalDeps,
): Promise<AccountRemovalResult> {
	const attempts = previous.attempts + 1;
	const target = previous.target;
	if (target === null) {
		return incomplete(null, attempts, previous.areas, previous.code);
	}
	// The same empty pointer, and worse here: this outcome tells the user their Secret Key
	// is gone from this browser, which is the whole reason they pressed the button.
	if (target.transitionalAccountId === null) {
		return incomplete(
			target,
			attempts,
			[...previous.areas, "transitionalStore"],
			previous.code,
		);
	}
	try {
		const transitional = await deps.clearTransitionalAccountData(
			target.transitionalAccountId,
		);
		if (transitional.failures.length > 0) {
			return incomplete(
				target,
				attempts,
				[...previous.areas, "transitionalStore"],
				null,
			);
		}
		deps.forgetTransitionalAccountId();
	} catch (error) {
		return incomplete(
			target,
			attempts,
			[...previous.areas, "transitionalStore"],
			transportErrorCode(error),
		);
	}
	return { status: "browserDataCleared" };
}

// ---------------------------------------------------------------------------
// "Use a different account": retire the session, keep the Account
// ---------------------------------------------------------------------------

/**
 * The sign-in screen's own gesture, and deliberately the weaker one.
 *
 * It retires the Session and forgets what a Quick Unlock needs. It does not destroy the
 * Account. Two reasons, and both are about who is pressing the button. The screen it lives
 * on is the locked screen, so it runs before anybody proved they own the Account: an
 * irreversible `RemoveAccount` there would hand a passer-by a one-click way to destroy a
 * Replica that may still hold Operations this Device never sent. And a retirement loses
 * nothing that matters — `forgetSession` drops `secret_key`, `session_data` and the pinned
 * KDF profile, the Runtime drops the live master unlock key, and the item cache goes with
 * them. What stays is ciphertext under keys this Device no longer holds.
 *
 * "Log out" in the sidebar is the destroying gesture, it says so, and it asks first. This
 * one is reachable without an unlock, so it stays reversible by a full sign-in.
 *
 * `SessionRetirementDeps` cannot destroy anything: it has no `removeAccount`. That is the
 * guard, and it is a type error rather than a rule somebody has to remember.
 */
export interface SessionRetirementDeps extends AccountNameDeps {
	/** Retires live access in the Runtime. The Account stays installed. */
	signOutRuntimeAccount(accountId: string): Promise<void>;
	/**
	 * Drops this browser's Quick Unlock inputs, Session and cached ciphertext for one
	 * named account. Named, never `null`: an unnamed sign-out forgets nothing and reports
	 * no failure, which every caller reads as success.
	 */
	forgetTransitionalSession(
		accountId: string,
	): Promise<TransitionalClearOutcome>;
}

export interface SessionRetirementIncomplete extends TeardownIncomplete {
	/** Whether to offer the browser-only escape. See `forgetBrowserSessionOnly`. */
	readonly canForgetBrowserSessionOnly: boolean;
}

/**
 * The session was retired, this browser forgot its own sign-in, or neither.
 *
 * `browserSessionForgotten` is never a retirement. The Runtime kept live access to the
 * Account, and the outcome names that so no screen can quietly claim otherwise.
 */
export type SessionRetirementResult =
	| { readonly status: "retired" }
	| {
			readonly status: "browserSessionForgotten";
			/** What still holds Account material. Always the Runtime's live access. */
			readonly areas: readonly AccountRemovalArea[];
	  }
	| SessionRetirementIncomplete;

function retirementIncomplete(
	target: AccountRemovalTarget | null,
	attempts: number,
	areas: readonly AccountRemovalArea[],
	code: RuntimeErrorCode | null,
): SessionRetirementIncomplete {
	return {
		...baseReport(target, attempts, areas, code),
		canForgetBrowserSessionOnly: canOfferBrowserEscape(target, attempts),
	};
}

export async function retireAccountSession(
	previous: SessionRetirementIncomplete | null,
	deps: SessionRetirementDeps,
): Promise<SessionRetirementResult> {
	const attempts = (previous?.attempts ?? 0) + 1;
	const resolved = await resolveNamedTarget(previous, deps);
	if (resolved.named === null) {
		return retirementIncomplete(
			resolved.target,
			attempts,
			resolved.areas,
			resolved.code,
		);
	}
	const named = resolved.named;

	if (named.runtimeAccountId !== null) {
		try {
			await deps.signOutRuntimeAccount(named.runtimeAccountId);
		} catch (error) {
			// A Runtime that still holds live access keeps the Quick Unlock offer this
			// gesture exists to remove. Clearing the browser under it and moving the
			// pointer would show an empty sign-in screen over an unlocked vault. After
			// repeated refusals the user can still choose that trade, through
			// `forgetBrowserSessionOnly`. It is offered, labelled, and never silent.
			return retirementIncomplete(
				resolved.target,
				attempts,
				["runtimeSession"],
				transportErrorCode(error),
			);
		}
	}

	try {
		const transitional = await deps.forgetTransitionalSession(
			named.transitionalAccountId,
		);
		if (transitional.failures.length > 0) {
			return retirementIncomplete(
				resolved.target,
				attempts,
				["transitionalStore"],
				null,
			);
		}
		// Last: the pointer is what the screen reads, so it may only move once both
		// stores let go. `bittery_web_account_id` is deliberately left alone — the
		// Account is still installed and still needs its transitional name.
		deps.selectAccount(null);
	} catch (error) {
		return retirementIncomplete(
			resolved.target,
			attempts,
			["transitionalStore"],
			transportErrorCode(error),
		);
	}
	return { status: "retired" };
}

/**
 * The retirement's escape: forget what this browser stored, and nothing else.
 *
 * `SignOut` reaches `retire_account_access`, which calls `ensure_open()`, so a wedged
 * Runtime refuses this gesture forever. Gating the browser clear behind that refusal takes
 * the whole screen away: the email field stays disabled while this browser still holds a
 * Quick Unlock, so the user cannot sign in as anybody else in this browser at all. Before
 * this slice the refusal was swallowed and the gesture always "worked", which was a lie of
 * a different kind — it reloaded over a Runtime that still held live access.
 *
 * This touches no Runtime-owned state. It does not call `signOutRuntimeAccount`, and it
 * leaves `bittery_runtime_account_id` alone: the Runtime stays the single authority over
 * its own access. So the outcome names `runtimeSession` as surviving, and the screen has to
 * say so — the Account is still installed and the Runtime may still hold it unlocked.
 */
export async function forgetBrowserSessionOnly(
	previous: SessionRetirementIncomplete,
	deps: SessionRetirementDeps,
): Promise<SessionRetirementResult> {
	const attempts = previous.attempts + 1;
	const target = previous.target;
	// The same empty pointer the gestures refuse, and worse here: this outcome tells the
	// user their Secret Key is gone from this browser, which is why they pressed it.
	if (target === null || target.transitionalAccountId === null) {
		return retirementIncomplete(
			target,
			attempts,
			target === null
				? previous.areas
				: [...previous.areas, "transitionalStore"],
			previous.code,
		);
	}
	try {
		const transitional = await deps.forgetTransitionalSession(
			target.transitionalAccountId,
		);
		if (transitional.failures.length > 0) {
			return retirementIncomplete(
				target,
				attempts,
				[...previous.areas, "transitionalStore"],
				null,
			);
		}
	} catch (error) {
		return retirementIncomplete(
			target,
			attempts,
			[...previous.areas, "transitionalStore"],
			transportErrorCode(error),
		);
	}
	return { status: "browserSessionForgotten", areas: ["runtimeSession"] };
}

// ---------------------------------------------------------------------------
// The Danger Zone deletion: the Server first, then this Device
// ---------------------------------------------------------------------------

export interface AccountDeletionDeps extends AccountRemovalDeps {
	/** Deletes the Account on the Server. Throws when the Server still holds it. */
	deleteServerAccount(): Promise<void>;
	/**
	 * The transitional name of an Account whose Server copy is already deleted, or `null`.
	 *
	 * Persisted outside this page load, because the page load is what loses it. See
	 * `AccountDeletionIncomplete`.
	 */
	readDeletedServerAccountId(): string | null;
}

/**
 * A deletion that did not finish, and the one fact a retry cannot re-derive.
 *
 * `serverAccountDeleted` is carried, not re-tested. Asking the Server a second time for an
 * Account it no longer has answers with an error, and reading that error as "the Server
 * still holds it" would block local destruction forever — the exact material this dialog
 * was pressed to destroy.
 *
 * Carrying it in memory is not enough. Once the Server has let go, the next authenticated
 * request answers 401 and `router.tsx` sends the document to `/login`, which takes every
 * React ref with it. So the fact is also written down, under the transitional name of the
 * Account it is about: that name cannot drift onto another Account, because
 * `resolveOrCreateAccountId` keys on (serverUrl, userId) and a re-registered user is a new
 * userId, which mints a new transitional name.
 */
export interface AccountDeletionIncomplete extends TeardownIncomplete {
	readonly serverAccountDeleted: boolean;
}

export type AccountDeletionResult =
	| { readonly status: "deleted" }
	| AccountDeletionIncomplete;

/**
 * Delete the Account on the Server, then destroy this Device's copy through the Runtime.
 *
 * The Server goes first and its failure stops everything. That ordering is the one thing
 * the Runtime cannot express: it knows nothing about a Server Account, and destroying the
 * local copy of an Account the Server still holds leaves a user locked out of an Account
 * that still exists. Once the Server has let go the order inverts and the Runtime becomes
 * the authority again, exactly as it is for "Log out".
 *
 * Both names are resolved before the Server is asked. An Account this Device cannot name
 * is one whose local copy nothing could destroy afterwards, so nothing is deleted anywhere.
 */
export async function deleteAccountEverywhereFromDevice(
	previous: AccountDeletionIncomplete | null,
	deps: AccountDeletionDeps,
): Promise<AccountDeletionResult> {
	const attempts = (previous?.attempts ?? 0) + 1;

	const resolved = await resolveNamedTarget(previous, deps);
	if (resolved.named === null) {
		return {
			...baseReport(resolved.target, attempts, resolved.areas, resolved.code),
			// Nothing was named, so the written record cannot be matched against
			// anything. Only the carried report can answer here.
			serverAccountDeleted: previous?.serverAccountDeleted ?? false,
		};
	}
	const named = resolved.named;
	const serverAccountDeleted =
		previous?.serverAccountDeleted ??
		wasServerAccountDeleted(named.transitionalAccountId, deps);

	if (!serverAccountDeleted) {
		try {
			await deps.deleteServerAccount();
		} catch {
			// No `code`: this is the Server refusing, and `RuntimeErrorCode` is the
			// Runtime's vocabulary. Nothing local has been touched.
			return {
				...baseReport(resolved.target, attempts, ["serverAccount"], null),
				serverAccountDeleted: false,
			};
		}
		// Written before the first local step, and before the 401 that the deleted
		// Account now answers every request with can replace this document.
		rememberServerAccountDeleted(named.transitionalAccountId, deps);
	}

	const failure = await destroyLocalAccount(named, deps);
	if (failure !== null) {
		return {
			...baseReport(resolved.target, attempts, failure.areas, failure.code),
			serverAccountDeleted: true,
		};
	}
	// The record outlived every step it guarded, and `destroyLocalAccount` cleared it in
	// the tail every removal runs. So a log out sweeps an abandoned deletion's record too.
	return { status: "deleted" };
}

/**
 * Whether the Server already let go of the Account this Device knows by that name.
 *
 * A record for another name says nothing about this Account, so it is not read as one.
 */
function wasServerAccountDeleted(
	transitionalAccountId: string,
	deps: AccountDeletionDeps,
): boolean {
	try {
		return deps.readDeletedServerAccountId() === transitionalAccountId;
	} catch {
		// A record this browser cannot read is no record. The Server step runs again and
		// reports its own answer, which is the honest place for that failure to appear.
		return false;
	}
}

function rememberServerAccountDeleted(
	transitionalAccountId: string | null,
	deps: AccountRemovalDeps,
): void {
	try {
		deps.writeDeletedServerAccountId(transitionalAccountId);
	} catch {
		// Deliberately swallowed, and only here. The Server has already let go, so the
		// Account's local copy must still be destroyed; a `localStorage` write that was
		// refused may not stand in the way of that. It costs the carry across a reload,
		// which is where it started.
	}
}
