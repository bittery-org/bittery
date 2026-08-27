/**
 * Web "Log out", which on this platform means "remove this Account from this Device".
 *
 * Two independent stores hold Account material in a browser, and they name the Account
 * differently. The Runtime knows it by its `AccountId` and owns the Replica, the platform
 * namespace, the Attachment artifacts and the OPFS spool. The transitional store knows it by
 * whichever id `AccountStore` is currently pointed at — before the first sign-in the
 * synthetic `bittery_web_account_id` from `storage.ts`, and after one the id
 * `resolveOrCreateAccountId` minted or reused for that (server, user) pair. It owns the
 * `bittery_account_*` keys and the cached ciphertext. Neither store can destroy the other's
 * material, so log out drives both and reports the union.
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
 * Every decision lives here rather than in the component, so a unit test can reach it.
 */

import {
	type RuntimeTeardown,
	transportErrorCode,
} from "@bittery/client-runtime/client";
import type {
	RuntimeErrorCode,
	TeardownPhase,
} from "@bittery/client-runtime/protocol";

/** A store that still holds Account material after log out asked it to let go. */
export type AccountRemovalArea = TeardownPhase | "transitionalStore";

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

export interface AccountRemovalDeps {
	/** The Runtime's active Account. Read once; a later read can answer `null`. */
	resolveRuntimeAccountId(): string | null;
	/** The transitional store's active account. Read once, for the same reason. */
	resolveTransitionalAccountId(): Promise<string | null>;
	/** Destroys one named Account inside the Runtime and answers the whole outcome. */
	removeAccount(accountId: string): Promise<RuntimeTeardown>;
	/** Moves the host's active-Account pointer, `bittery_runtime_account_id`. */
	selectAccount(accountId: string | null): void;
	/**
	 * Destroys the named transitional account's data and its cached ciphertext.
	 *
	 * Named, never `null`: a sweep with no name destroys nothing and reports no failure.
	 */
	clearTransitionalAccountData(
		accountId: string,
	): Promise<TransitionalClearOutcome>;
	/** Forgets the synthetic pre-login id, the last stray `bittery_*` key. */
	forgetTransitionalAccountId(): void;
}

/**
 * A log out that did not finish, and everything an identical retry needs.
 *
 * There is deliberately one failure shape and it is always retryable. A teardown-fenced
 * Runtime answers `ACCOUNT_MISSING`, which reads like "no such Account" and is not: it is a
 * removal that is still in progress. Giving that code its own arm would invite a screen that
 * tells the user their Account is gone while its Replica rows are still on the Device.
 */
export interface AccountRemovalIncomplete {
	readonly status: "incomplete";
	/** The names a retry must reuse. `null` when resolving them is what failed. */
	readonly target: AccountRemovalTarget | null;
	/** Attempts made so far, this one included. */
	readonly attempts: number;
	/** Every store that still holds material, in a stable order. */
	readonly areas: readonly AccountRemovalArea[];
	/** The Runtime's refusal code, when it refused instead of answering. */
	readonly code: RuntimeErrorCode | null;
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
	"replica",
	"platformStorage",
	"attachmentArtifacts",
	"hostCleanup",
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

function incomplete(
	target: AccountRemovalTarget | null,
	attempts: number,
	areas: readonly AccountRemovalArea[],
	code: RuntimeErrorCode | null,
): AccountRemovalIncomplete {
	return {
		status: "incomplete",
		target,
		attempts,
		areas: ordered(areas),
		code,
		// Nothing to offer without a transitional name: the hatch would clear nothing and
		// still have to call itself a success. That covers an unresolved target and a
		// target whose transitional id came back `null`.
		canClearBrowserDataOnly:
			target !== null &&
			target.transitionalAccountId !== null &&
			attempts >= ATTEMPTS_BEFORE_BROWSER_ESCAPE,
	};
}

export async function removeAccountFromDevice(
	previous: AccountRemovalIncomplete | null,
	deps: AccountRemovalDeps,
): Promise<AccountRemovalResult> {
	const attempts = (previous?.attempts ?? 0) + 1;

	let target = previous?.target ?? null;
	if (target === null) {
		try {
			target = {
				runtimeAccountId: deps.resolveRuntimeAccountId(),
				transitionalAccountId: await deps.resolveTransitionalAccountId(),
			};
		} catch (error) {
			// Reported with no target, so the retry resolves again. Nothing was destroyed.
			return incomplete(null, attempts, [], transportErrorCode(error));
		}
	}

	// After `initializeStorage()` the transitional pointer is never legitimately null in a
	// browser: the store seeds it with the synthetic id. So `null` means the store emptied
	// its own pointer during a half-failed sweep, over values that survived, and nothing
	// re-seeds it in this page load. Clearing under that name would destroy nothing and
	// report `removed` over a `secret_key` that is still in `localStorage`.
	if (target.transitionalAccountId === null) {
		return incomplete(target, attempts, ["transitionalStore"], null);
	}

	if (target.runtimeAccountId !== null) {
		let teardown: RuntimeTeardown;
		try {
			teardown = await deps.removeAccount(target.runtimeAccountId);
		} catch (error) {
			// A refusal names no phase, so nothing is known to have been destroyed. It is
			// reported and stays retryable rather than becoming a silent success.
			return incomplete(target, attempts, [], transportErrorCode(error));
		}
		if (teardown.status !== "complete") {
			return incomplete(target, attempts, teardown.failures, null);
		}
	}

	try {
		const transitional = await deps.clearTransitionalAccountData(
			target.transitionalAccountId,
		);
		if (transitional.failures.length > 0) {
			return incomplete(target, attempts, ["transitionalStore"], null);
		}
		// Last, and only here: the pre-login id can still name surviving data, and both
		// pointer writes touch storage that can throw.
		deps.forgetTransitionalAccountId();
		deps.selectAccount(null);
	} catch (error) {
		// The host duties throw for their own reasons — a `localStorage` write, a runtime
		// refresh that reads the store and emits. An unreported rejection would leave the
		// dialog running forever, so it becomes the same retryable report as everything else.
		return incomplete(
			target,
			attempts,
			["transitionalStore"],
			transportErrorCode(error),
		);
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
