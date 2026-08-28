import { describe, expect, test } from "bun:test";
import {
	RuntimeRequestError,
	type RuntimeTeardown,
} from "@bittery/client-runtime/client";
import {
	type AccountDeletionIncomplete,
	type AccountRemovalDeps,
	type AccountRemovalIncomplete,
	clearBrowserStoredDataOnly,
	forgetBrowserSessionOnly,
	removeAccountFromDevice,
	retireAccountSession,
	retryCannotFinish,
	type SessionRetirementDeps,
	type SessionRetirementIncomplete,
	type SessionRetirementResult,
} from "./account-removal";

function teardown(
	accountId: string,
	failures: RuntimeTeardown["failures"] = [],
): RuntimeTeardown {
	return {
		scope: { type: "account", accountId },
		status: failures.length === 0 ? "complete" : "incomplete",
		failures,
	};
}

interface Recorder extends AccountRemovalDeps {
	readonly removed: string[];
	readonly selected: (string | null)[];
	readonly cleared: (string | null)[];
	readonly forgotten: number[];
	readonly order: string[];
	readonly markerClears: number[];
}

function recorder(overrides: Partial<AccountRemovalDeps> = {}): Recorder {
	const removed: string[] = [];
	const selected: (string | null)[] = [];
	const cleared: (string | null)[] = [];
	const forgotten: number[] = [];
	const order: string[] = [];
	const markerClears: number[] = [];
	let tick = 0;
	const base: AccountRemovalDeps = {
		resolveRuntimeAccountId() {
			return "account-1";
		},
		async resolveTransitionalAccountId() {
			return "web-account-1";
		},
		async removeAccount(accountId) {
			removed.push(accountId);
			order.push("removeAccount");
			return teardown(accountId);
		},
		selectAccount(accountId) {
			selected.push(accountId);
			order.push(`selectAccount:${tick++}`);
		},
		async clearTransitionalAccountData(accountId) {
			cleared.push(accountId);
			order.push(`clear:${tick++}`);
			return { failures: [] };
		},
		forgetTransitionalAccountId() {
			forgotten.push(tick++);
			order.push("forget");
		},
		clearAccountDeletionMarker() {
			markerClears.push(markerClears.length);
			order.push("clearDeletionMarker");
		},
	};
	return {
		...base,
		...overrides,
		removed,
		selected,
		cleared,
		forgotten,
		order,
		markerClears,
	};
}

/** The report an identical retry is driven from. */
function report(result: { status: string }): AccountRemovalIncomplete {
	if (result.status !== "incomplete") {
		throw new Error(`expected an incomplete log out, got ${result.status}`);
	}
	return result as AccountRemovalIncomplete;
}

/**
 * Models the real transitional store.
 *
 * `account-store.ts:1070` writes the active pointer to `null` before it sweeps
 * `ACCOUNT_VALUES`, and the Web transitional cleanup records a failed step rather than
 * rethrowing.
 * So a half-failed clear leaves no active account and every value in place.
 */
function transitionalStoreDouble() {
	let activeAccountId: string | null = "web-account-1";
	const values = new Set([
		"secret_key",
		"session_data",
		"vault_keys",
		"jwt_token",
	]);
	let failNextSweep = true;
	return {
		surviving: () => [...values],
		resolve: async () => activeAccountId,
		clear: async (accountId: string | null) => {
			// `clearActiveAccountData` on an empty pointer destroys nothing and reports no
			// failure, so a caller that asked would be told it succeeded. Nobody may ask.
			if (accountId === null) {
				throw new Error("swept the transitional store with no account named");
			}
			if (activeAccountId === accountId) {
				activeAccountId = null;
			}
			if (failNextSweep) {
				failNextSweep = false;
				return { failures: [{ step: "clear_account_data" }] };
			}
			values.clear();
			return { failures: [] };
		},
	};
}

describe("log out destroys the Account through the Runtime", () => {
	test("a complete teardown clears the transitional store and both pointers", async () => {
		const deps = recorder();

		const result = await removeAccountFromDevice(null, deps);

		expect(result).toEqual({ status: "removed" });
		expect(deps.removed).toEqual(["account-1"]);
		expect(deps.cleared).toEqual(["web-account-1"]);
		expect(deps.order).toEqual([
			"removeAccount",
			"clear:0",
			"forget",
			"selectAccount:2",
			"clearDeletionMarker",
		]);
		// An abandoned deletion leaves the record behind, and nothing else drops it. A log
		// out destroys everything this browser knows about the Account, so it takes that
		// record with it and leaves no stray `bittery_*` key.
		expect(deps.markerClears).toHaveLength(1);
	});

	test("an incomplete teardown keeps every pointer and names the failed phases", async () => {
		const deps = recorder({
			async removeAccount(accountId) {
				return teardown(accountId, ["hostCleanup", "replica"]);
			},
		});

		const result = await removeAccountFromDevice(null, deps);

		expect(result).toMatchObject({
			status: "incomplete",
			target: {
				runtimeAccountId: "account-1",
				transitionalAccountId: "web-account-1",
			},
			attempts: 1,
			areas: ["replica", "hostCleanup"],
			code: null,
			canClearBrowserDataOnly: false,
		});
		expect(deps.cleared).toEqual([]);
		expect(deps.forgotten).toEqual([]);
		expect(deps.selected).toEqual([]);
	});

	test("a transitional store that kept data holds the pointers back too", async () => {
		const deps = recorder({
			async clearTransitionalAccountData() {
				return { failures: [{ step: "clear_item_cache" }] };
			},
		});

		const result = await removeAccountFromDevice(null, deps);

		expect(result).toMatchObject({
			status: "incomplete",
			areas: ["transitionalStore"],
			code: null,
		});
		expect(deps.forgotten).toEqual([]);
		expect(deps.selected).toEqual([]);
	});

	test("a refused request is reported with its code, not swallowed", async () => {
		const deps = recorder({
			async removeAccount() {
				throw new RuntimeRequestError(
					"RUNTIME_CLOSED",
					"worker gone at owner.ts:88",
				);
			},
		});

		const result = await removeAccountFromDevice(null, deps);

		expect(result).toMatchObject({
			status: "incomplete",
			areas: [],
			code: "RUNTIME_CLOSED",
		});
		expect(deps.cleared).toEqual([]);
		expect(deps.selected).toEqual([]);
	});

	// A teardown-fenced Runtime answers ACCOUNT_MISSING while the removal is still in
	// progress. It must never read as "this Account does not exist".
	test("ACCOUNT_MISSING stays a retryable teardown failure", async () => {
		const deps = recorder({
			async removeAccount() {
				throw new RuntimeRequestError("ACCOUNT_MISSING", "fenced");
			},
		});

		const result = await removeAccountFromDevice(null, deps);

		expect(result).toMatchObject({
			status: "incomplete",
			code: "ACCOUNT_MISSING",
		});
	});

	// A platform-namespace failure forbids the Replica phase, so a Device can need three
	// attempts. Retry also has to name the Account the first attempt named: once catalog
	// detachment succeeds the observed catalog no longer resolves it, and a re-resolved
	// pointer would answer `null` and quietly skip the Runtime.
	test("an identical retry converges on the third attempt", async () => {
		const answers: RuntimeTeardown["failures"][] = [
			["platformStorage", "replica"],
			["replica"],
			[],
		];
		const deps = recorder({
			resolveRuntimeAccountId() {
				// Only the first attempt may ask.
				return deps.removed.length === 0 ? "account-1" : null;
			},
			async removeAccount(accountId) {
				deps.removed.push(accountId);
				return teardown(accountId, answers.shift() ?? []);
			},
		});

		let result = await removeAccountFromDevice(null, deps);
		expect(result).toMatchObject({
			status: "incomplete",
			areas: ["replica", "platformStorage"],
			attempts: 1,
		});

		while (result.status === "incomplete") {
			result = await removeAccountFromDevice(report(result), deps);
		}

		expect(result).toEqual({ status: "removed" });
		expect(deps.removed).toEqual(["account-1", "account-1", "account-1"]);
	});

	test("a Device with no Runtime Account still clears the transitional store", async () => {
		const deps = recorder({
			resolveRuntimeAccountId() {
				return null;
			},
		});

		const result = await removeAccountFromDevice(null, deps);

		expect(result).toEqual({ status: "removed" });
		expect(deps.removed).toEqual([]);
		expect(deps.cleared).toEqual(["web-account-1"]);
		expect(deps.selected).toEqual([null]);
	});
});

describe("a retry names the same account in both stores", () => {
	// The transitional store nulls its active pointer before it sweeps the values, so a
	// retry that re-resolved would find nothing to remove, report no failure, and let the
	// app call the log out `removed` while `secret_key` was still in `localStorage`.
	test("a retry never reports removed while transitional values survive", async () => {
		const store = transitionalStoreDouble();
		const deps = recorder({
			resolveTransitionalAccountId: store.resolve,
			clearTransitionalAccountData: store.clear,
		});

		let result = await removeAccountFromDevice(null, deps);
		for (
			let attempt = 0;
			attempt < 4 && result.status === "incomplete";
			attempt++
		) {
			result = await removeAccountFromDevice(report(result), deps);
		}

		expect({ status: result.status, surviving: store.surviving() }).toEqual({
			status: "removed",
			surviving: [],
		});
	});

	test("both names are resolved once, however many attempts it takes", async () => {
		let runtimeReads = 0;
		let transitionalReads = 0;
		const deps = recorder({
			resolveRuntimeAccountId() {
				runtimeReads++;
				return "account-1";
			},
			async resolveTransitionalAccountId() {
				transitionalReads++;
				return "web-account-1";
			},
			async removeAccount(accountId) {
				deps.removed.push(accountId);
				return teardown(accountId, deps.removed.length < 3 ? ["replica"] : []);
			},
		});

		let result = await removeAccountFromDevice(null, deps);
		while (result.status === "incomplete") {
			result = await removeAccountFromDevice(report(result), deps);
		}

		expect(result).toEqual({ status: "removed" });
		expect([runtimeReads, transitionalReads]).toEqual([1, 1]);
	});

	// A resolve that throws has destroyed nothing and knows no name, so the report carries
	// no target and the next attempt resolves again.
	test("a failed resolve reports no target and never converges on nothing", async () => {
		let calls = 0;
		const deps = recorder({
			async resolveTransitionalAccountId() {
				calls++;
				if (calls === 1) throw new Error("IndexedDB is blocked");
				return "web-account-1";
			},
		});

		const first = report(await removeAccountFromDevice(null, deps));
		expect(first.target).toBeNull();
		expect(first.canClearBrowserDataOnly).toBe(false);
		expect(deps.removed).toEqual([]);

		const second = await removeAccountFromDevice(first, deps);

		expect(second).toEqual({ status: "removed" });
		expect(deps.cleared).toEqual(["web-account-1"]);
	});
});

describe("a throw anywhere in log out is reported, never left to reject", () => {
	test("a transitional clear that throws becomes a retryable report", async () => {
		const deps = recorder({
			async clearTransitionalAccountData() {
				// `clearActiveAccountData` awaits `manager.refresh()`, which reads storage
				// and emits, outside any step guard.
				throw new Error("manager.refresh() blew up");
			},
		});

		const result = await removeAccountFromDevice(null, deps);

		expect(result).toMatchObject({
			status: "incomplete",
			areas: ["transitionalStore"],
			code: "INVARIANT_VIOLATION",
		});
	});

	test("a pointer write that throws becomes a retryable report", async () => {
		const deps = recorder({
			forgetTransitionalAccountId() {
				throw new Error("localStorage is denied");
			},
		});

		const result = await removeAccountFromDevice(null, deps);

		expect(result).toMatchObject({
			status: "incomplete",
			areas: ["transitionalStore"],
			code: "INVARIANT_VIOLATION",
		});
		expect(deps.selected).toEqual([]);
	});
});

describe("a wedged Runtime still lets this browser drop its own data", () => {
	test("a repeated failure offers an escape that clears this browser only", async () => {
		const deps = recorder({
			// The wedged Device slice 4b exists for: account scope keeps `ensure_open()`,
			// so `RemoveAccount` refuses every attempt.
			async removeAccount(accountId) {
				deps.removed.push(accountId);
				throw new RuntimeRequestError("RUNTIME_CLOSED", "open() threw");
			},
		});

		const first = report(await removeAccountFromDevice(null, deps));
		expect(first.canClearBrowserDataOnly).toBe(false);
		const second = report(await removeAccountFromDevice(first, deps));
		expect(second.canClearBrowserDataOnly).toBe(true);

		const escaped = await clearBrowserStoredDataOnly(second, deps);

		expect(escaped).toEqual({ status: "browserDataCleared" });
		// A legacy-store escape hatch, not a second deletion path for Runtime state.
		expect(deps.removed).toEqual(["account-1", "account-1"]);
		expect(deps.selected).toEqual([]);
		expect(deps.cleared).toEqual(["web-account-1"]);
		expect(deps.forgotten.length).toBe(1);
	});

	test("the escape clears the same account the failed attempts named", async () => {
		const store = transitionalStoreDouble();
		const deps = recorder({
			resolveTransitionalAccountId: store.resolve,
			clearTransitionalAccountData: store.clear,
			async removeAccount() {
				throw new RuntimeRequestError("ACCOUNT_MISSING", "fenced");
			},
		});

		let result = report(await removeAccountFromDevice(null, deps));
		result = report(await removeAccountFromDevice(result, deps));
		// The store's first sweep fails and nulls its own pointer, exactly as in a retry.
		result = report(await clearBrowserStoredDataOnly(result, deps));

		const escaped = await clearBrowserStoredDataOnly(result, deps);

		expect(escaped).toEqual({ status: "browserDataCleared" });
		expect(store.surviving()).toEqual([]);
	});

	test("an escape that fails stays incomplete and keeps naming the Runtime areas", async () => {
		const deps = recorder({
			async removeAccount(accountId) {
				return teardown(accountId, ["replica"]);
			},
			async clearTransitionalAccountData() {
				return { failures: [{ step: "clear_item_cache" }] };
			},
		});

		const first = report(await removeAccountFromDevice(null, deps));
		const second = report(await removeAccountFromDevice(first, deps));

		const escaped = await clearBrowserStoredDataOnly(second, deps);

		expect(escaped).toMatchObject({
			status: "incomplete",
			areas: ["replica", "transitionalStore"],
		});
		expect(deps.forgotten).toEqual([]);
	});
});

describe("a half-removal that emptied the transitional pointer is never a success", () => {
	// The dialog can be closed on an incomplete report — "Not now", or Escape while the
	// request is not running — and the next gesture then resolves both names again. The
	// transitional store answers `null`, because it emptied its own pointer before the
	// failed sweep and `initializeStorage()` is memoised: nothing re-seeds it in this page
	// load. `null` names no account, so it can only mean a half-removal already happened.
	test("the transitional id resolves to `null`", async () => {
		const store = transitionalStoreDouble();
		const deps: Recorder = recorder({
			resolveTransitionalAccountId: store.resolve,
			// Recorded as well as modelled: the name every clear was asked for is the
			// evidence that nothing was swept under an empty pointer.
			clearTransitionalAccountData: async (accountId) => {
				deps.cleared.push(accountId);
				return store.clear(accountId);
			},
		});

		// The first gesture: the Runtime answers `complete`, the sweep fails, and the store
		// empties its pointer over surviving values.
		const first = report(await removeAccountFromDevice(null, deps));
		expect(first.areas).toEqual(["transitionalStore"]);
		expect(await store.resolve()).toBeNull();

		// The report is discarded with the dialog, so this gesture resolves again.
		const second = await removeAccountFromDevice(null, deps);

		expect({
			status: second.status,
			surviving: store.surviving(),
			cleared: deps.cleared,
		}).toEqual({
			status: "incomplete",
			surviving: ["secret_key", "session_data", "vault_keys", "jwt_token"],
			cleared: ["web-account-1"],
		});
		expect(second).toMatchObject({
			areas: ["transitionalStore"],
			attempts: 1,
		});
		expect(deps.forgotten).toEqual([]);
		expect(deps.selected).toEqual([]);

		// One failure is ordinary, so a first attempt never offers the hatch and says
		// nothing about the empty pointer. The retry carries the count past the threshold,
		// and there the unnamed target is the only thing left holding the hatch back: the
		// hatch would sweep nothing and still report the Secret Key gone.
		const third = report(await removeAccountFromDevice(report(second), deps));
		expect(third).toMatchObject({
			areas: ["transitionalStore"],
			attempts: 2,
			canClearBrowserDataOnly: false,
		});
		expect(deps.cleared).toEqual(["web-account-1"]);
	});

	// Worse here than in log out: `browserDataCleared` tells the user their Secret Key is
	// gone from this browser, and on a shared machine that is why they pressed it.
	test("the escape hatch refuses a target it cannot name", async () => {
		const store = transitionalStoreDouble();
		// The name every sweep was asked for, recorded: the store double refuses an empty
		// pointer, but a refusal reads as an ordinary failed sweep. Only the recorded names
		// show that the module itself never asked.
		const deps: Recorder = recorder({
			resolveTransitionalAccountId: store.resolve,
			clearTransitionalAccountData: async (accountId) => {
				deps.cleared.push(accountId);
				return store.clear(accountId);
			},
		});
		await removeAccountFromDevice(null, deps);
		expect(await store.resolve()).toBeNull();

		// The report a user would be looking at when the hatch appears: attempts enough to
		// offer it, and a target the re-resolve could not name.
		const stale: AccountRemovalIncomplete = {
			status: "incomplete",
			target: { runtimeAccountId: "account-1", transitionalAccountId: null },
			attempts: 2,
			areas: ["transitionalStore"],
			code: null,
			canClearBrowserDataOnly: true,
		};

		const escaped = await clearBrowserStoredDataOnly(stale, deps);

		// `cleared` and `code` are what only the hatch's own guard can produce. A hatch that
		// asked anyway records the empty name and reports the store double's refusal as
		// `INVARIANT_VIOLATION`; the guard refuses first, so the only name ever swept is the
		// one the first attempt resolved, and the report still carries the code it was given.
		expect({
			status: escaped.status,
			code: report(escaped).code,
			surviving: store.surviving(),
			cleared: deps.cleared,
		}).toEqual({
			status: "incomplete",
			code: null,
			surviving: ["secret_key", "session_data", "vault_keys", "jwt_token"],
			cleared: ["web-account-1"],
		});
		expect(deps.forgotten).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// "Use a different account" — retiring the session, not destroying the Account
// ---------------------------------------------------------------------------

interface RetirementRecorder extends SessionRetirementDeps {
	readonly signedOut: string[];
	readonly forgotten: string[];
	readonly selected: (string | null)[];
	readonly order: string[];
}

function retirementRecorder(
	overrides: Partial<SessionRetirementDeps> = {},
): RetirementRecorder {
	const signedOut: string[] = [];
	const forgotten: string[] = [];
	const selected: (string | null)[] = [];
	const order: string[] = [];
	const base: SessionRetirementDeps = {
		resolveRuntimeAccountId() {
			return "account-1";
		},
		async resolveTransitionalAccountId() {
			return "web-account-1";
		},
		async signOutRuntimeAccount(accountId) {
			signedOut.push(accountId);
			order.push("signOutRuntimeAccount");
		},
		async forgetTransitionalSession(accountId) {
			forgotten.push(accountId);
			order.push("forgetTransitionalSession");
			return { failures: [] };
		},
		selectAccount(accountId) {
			selected.push(accountId);
			order.push("selectAccount");
		},
	};
	return { ...base, ...overrides, signedOut, forgotten, selected, order };
}

/** The report an identical retry is driven from. */
function retirementReport(
	result: SessionRetirementResult,
): SessionRetirementIncomplete {
	if (result.status !== "incomplete") {
		throw new Error(`expected an incomplete retirement, got ${result.status}`);
	}
	return result;
}

describe("switching account retires the session and never lies about it", () => {
	test("a Runtime that refuses to sign out is reported, not swallowed", async () => {
		const deps = retirementRecorder({
			async signOutRuntimeAccount() {
				throw new RuntimeRequestError("RUNTIME_CLOSED", "closed");
			},
		});

		const result = await retireAccountSession(null, deps);

		expect(result.status).toBe("incomplete");
		expect(retirementReport(result).areas).toEqual(["runtimeSession"]);
		expect(retirementReport(result).code).toBe("RUNTIME_CLOSED");
		// The Runtime still holds live access, so nothing local may follow and the
		// pointer may not move: the screen would offer no account over an unlocked one.
		expect(deps.forgotten).toEqual([]);
		expect(deps.selected).toEqual([]);
	});

	test("a transitional store that kept the Secret Key is reported", async () => {
		const deps = retirementRecorder({
			async forgetTransitionalSession() {
				return { failures: [{ step: "forget_session" }] };
			},
		});

		const result = await retireAccountSession(null, deps);

		expect(result.status).toBe("incomplete");
		expect(retirementReport(result).areas).toEqual(["transitionalStore"]);
		expect(deps.selected).toEqual([]);
	});

	test("a throw becomes a retryable report, never a rejection", async () => {
		const deps = retirementRecorder({
			async forgetTransitionalSession() {
				throw new Error("localStorage is full");
			},
		});

		const result = await retireAccountSession(null, deps);

		expect(result.status).toBe("incomplete");
		expect(retirementReport(result).areas).toEqual(["transitionalStore"]);
	});

	test("a retirement runs the Runtime first and moves the pointer last", async () => {
		const deps = retirementRecorder();

		const result = await retireAccountSession(null, deps);

		expect(result).toEqual({ status: "retired" });
		expect(deps.order).toEqual([
			"signOutRuntimeAccount",
			"forgetTransitionalSession",
			"selectAccount",
		]);
		expect(deps.signedOut).toEqual(["account-1"]);
		expect(deps.forgotten).toEqual(["web-account-1"]);
		expect(deps.selected).toEqual([null]);
	});

	test("a transitional id that resolves to null is a half-removal, not a sign-out", async () => {
		const deps = retirementRecorder({
			async resolveTransitionalAccountId() {
				return null;
			},
		});

		const result = await retireAccountSession(null, deps);

		// A sign-out under no name forgets nothing and reports no failure, so the screen
		// would say the Secret Key is gone while it is still in `localStorage`.
		expect(result.status).toBe("incomplete");
		expect(retirementReport(result).areas).toEqual(["transitionalStore"]);
		expect(deps.forgotten).toEqual([]);
		expect(deps.signedOut).toEqual([]);
	});

	test("a retry reuses the names the first attempt resolved", async () => {
		let transitional: string | null = "web-account-1";
		let failNext = true;
		const named: string[] = [];
		const deps = retirementRecorder({
			async resolveTransitionalAccountId() {
				return transitional;
			},
			async forgetTransitionalSession(accountId) {
				named.push(accountId);
				if (failNext) {
					failNext = false;
					// The real store empties its own pointer part-way through a sweep.
					transitional = null;
					return { failures: [{ step: "forget_session" }] };
				}
				return { failures: [] };
			},
		});

		const first = retirementReport(await retireAccountSession(null, deps));
		const second = await retireAccountSession(first, deps);

		expect(second).toEqual({ status: "retired" });
		expect(first.attempts).toBe(1);
		// The second attempt named the same account, although the store now answers `null`.
		expect(named).toEqual(["web-account-1", "web-account-1"]);
	});

	test("a failed resolve reports no target and touches nothing", async () => {
		const deps = retirementRecorder({
			async resolveTransitionalAccountId() {
				throw new Error("storage is unavailable");
			},
		});

		const result = await retireAccountSession(null, deps);

		expect(retirementReport(result).target).toBeNull();
		expect(deps.signedOut).toEqual([]);
		expect(deps.selected).toEqual([]);
	});
});

/** What this browser holds for a Quick Unlock, and what a retirement drops. */
function transitionalSessionDouble() {
	const values = new Set(["secret_key", "session_data", "kdf_profile"]);
	return {
		surviving: () => [...values],
		forget: async (accountId: string) => {
			if (accountId === null) {
				throw new Error("signed out with no account named");
			}
			values.clear();
			return { failures: [] };
		},
	};
}

describe("a wedged Runtime still lets this browser forget its own sign-in", () => {
	// `SignOut` reaches `retire_account_access`, which calls `ensure_open()`, and a wedged
	// Runtime refuses that forever. Without an escape this screen has no way out at all:
	// the email field stays disabled while this browser still holds a Quick Unlock, so the
	// user cannot sign in as anybody else in this browser.
	test("a repeated refusal offers an escape that forgets this browser only", async () => {
		const session = transitionalSessionDouble();
		const deps = retirementRecorder({
			async signOutRuntimeAccount() {
				throw new RuntimeRequestError(
					"RUNTIME_CLOSED",
					"ensure_open() refused",
				);
			},
			forgetTransitionalSession: session.forget,
		});

		const first = retirementReport(await retireAccountSession(null, deps));
		// One refusal is ordinary. Two mean the Runtime is not converging.
		expect(first.canForgetBrowserSessionOnly).toBe(false);
		const second = retirementReport(await retireAccountSession(first, deps));
		expect(second.canForgetBrowserSessionOnly).toBe(true);
		// Nothing was forgotten while the offer was held back, so the Secret Key this
		// gesture exists to drop is still in `localStorage`.
		expect(session.surviving()).toEqual([
			"secret_key",
			"session_data",
			"kdf_profile",
		]);

		const escaped = await forgetBrowserSessionOnly(second, deps);

		// Never `retired`, and it says what survived: the Runtime kept live access to an
		// Account that is still installed on this Device.
		expect(escaped).toEqual({
			status: "browserSessionForgotten",
			areas: ["runtimeSession"],
		});
		expect(session.surviving()).toEqual([]);
		// It reaches no Runtime state, and it leaves the Runtime's own pointer alone.
		expect(deps.signedOut).toEqual([]);
		expect(deps.selected).toEqual([]);
	});

	test("the escape forgets the same account the failed attempts named", async () => {
		let transitional: string | null = "web-account-1";
		const deps = retirementRecorder({
			async resolveTransitionalAccountId() {
				return transitional;
			},
			async signOutRuntimeAccount() {
				// The real store empties its own pointer part-way through a failed sweep.
				transitional = null;
				throw new RuntimeRequestError("RUNTIME_CLOSED", "closed");
			},
		});

		const first = retirementReport(await retireAccountSession(null, deps));
		const second = retirementReport(await retireAccountSession(first, deps));

		expect(await forgetBrowserSessionOnly(second, deps)).toMatchObject({
			status: "browserSessionForgotten",
		});
		expect(deps.forgotten).toEqual(["web-account-1"]);
	});

	test("the escape refuses a target it cannot name", async () => {
		const deps = retirementRecorder();
		const stale: SessionRetirementIncomplete = {
			status: "incomplete",
			target: { runtimeAccountId: "account-1", transitionalAccountId: null },
			attempts: 2,
			areas: ["runtimeSession"],
			code: "RUNTIME_CLOSED",
			canForgetBrowserSessionOnly: true,
		};

		const result = await forgetBrowserSessionOnly(stale, deps);

		// A sign-out under no name forgets nothing and reports no failure, so this would
		// tell the user their Secret Key is gone while it is still in `localStorage`.
		expect(result.status).toBe("incomplete");
		expect(retirementReport(result).areas).toEqual([
			"runtimeSession",
			"transitionalStore",
		]);
		expect(deps.forgotten).toEqual([]);
	});

	test("a failed escape stays incomplete and keeps naming the Runtime", async () => {
		const deps = retirementRecorder({
			async signOutRuntimeAccount() {
				throw new RuntimeRequestError("RUNTIME_CLOSED", "closed");
			},
			async forgetTransitionalSession() {
				return { failures: [{ step: "forget_session" }] };
			},
		});

		const first = retirementReport(await retireAccountSession(null, deps));
		const second = retirementReport(await retireAccountSession(first, deps));

		const result = await forgetBrowserSessionOnly(second, deps);

		expect(retirementReport(result).areas).toEqual([
			"runtimeSession",
			"transitionalStore",
		]);
		expect(retirementReport(result).canForgetBrowserSessionOnly).toBe(true);
	});
});

describe("a retry that cannot finish is never offered as one", () => {
	// The transitional store empties its own pointer before a failed sweep, and nothing
	// re-seeds it in this page load. Every later attempt is refused under that same empty
	// name, so "Try again" is a promise the page cannot keep.
	test("an empty transitional pointer strands the retry", async () => {
		const store = transitionalStoreDouble();
		const deps = recorder({
			resolveTransitionalAccountId: store.resolve,
			clearTransitionalAccountData: store.clear,
		});

		const first = report(await removeAccountFromDevice(null, deps));
		expect(retryCannotFinish(first)).toBe(false);

		// The dialog was closed and reopened, so this gesture resolves again — and the
		// store now answers `null`.
		const stranded = report(await removeAccountFromDevice(null, deps));

		expect(retryCannotFinish(stranded)).toBe(true);
	});

	test("an ordinary failure and an unresolved target both stay retryable", async () => {
		const failed = report(
			await removeAccountFromDevice(
				null,
				recorder({
					async removeAccount(accountId) {
						return teardown(accountId, ["replica"]);
					},
				}),
			),
		);
		expect(retryCannotFinish(failed)).toBe(false);

		// A resolve that threw knows no name at all, so the next attempt resolves again.
		const unresolved = report(
			await removeAccountFromDevice(
				null,
				recorder({
					async resolveTransitionalAccountId() {
						throw new Error("IndexedDB is blocked");
					},
				}),
			),
		);
		expect(retryCannotFinish(unresolved)).toBe(false);
	});
});

describe("the Danger Zone browser escape trusts only an authoritative Server outcome", () => {
	const deletionReport = (
		serverAccountDeleted: boolean,
	): AccountDeletionIncomplete => ({
		status: "incomplete",
		target: {
			runtimeAccountId: "account-1",
			transitionalAccountId: "web-account-1",
		},
		attempts: 2,
		areas: [serverAccountDeleted ? "replica" : "serverAccount"],
		code: null,
		serverAccountDeleted,
		canClearBrowserDataOnly: serverAccountDeleted,
	});

	test("a non-authoritative Server outcome cannot clear local data", async () => {
		const deps = recorder();
		const previous = deletionReport(false);

		expect(await clearBrowserStoredDataOnly(previous, deps)).toBe(previous);
		expect(deps.cleared).toEqual([]);
		expect(deps.forgotten).toEqual([]);
	});

	test("serverDeleted permits only the browser-owned local tail", async () => {
		const deps = recorder();

		expect(
			await clearBrowserStoredDataOnly(deletionReport(true), deps),
		).toEqual({ status: "browserDataCleared" });
		expect(deps.removed).toEqual([]);
		expect(deps.selected).toEqual([]);
		expect(deps.cleared).toEqual(["web-account-1"]);
		expect(deps.forgotten).toHaveLength(1);
	});
});
