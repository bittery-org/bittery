import { describe, expect, test } from "bun:test";
import {
	RuntimeRequestError,
	type RuntimeTeardown,
} from "@bittery/client-runtime/client";
import {
	type AccountRemovalDeps,
	type AccountRemovalIncomplete,
	clearBrowserStoredDataOnly,
	removeAccountFromDevice,
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
}

function recorder(overrides: Partial<AccountRemovalDeps> = {}): Recorder {
	const removed: string[] = [];
	const selected: (string | null)[] = [];
	const cleared: (string | null)[] = [];
	const forgotten: number[] = [];
	const order: string[] = [];
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
	};
	return {
		...base,
		...overrides,
		removed,
		selected,
		cleared,
		forgotten,
		order,
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
 * `ACCOUNT_VALUES`, and `account-lifecycle.ts` records a failed step rather than rethrowing.
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
		]);
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
