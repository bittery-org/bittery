import { describe, expect, test } from "bun:test";
import { createPopupAccountRuntimeBridge } from "../../src/lib/popup-account-runtime-bridge";

const deferred = () => {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
};

describe("popup account runtime bridge", () => {
	test("one worker account event performs one runtime reconciliation", async () => {
		let refreshes = 0;
		const bridge = createPopupAccountRuntimeBridge({
			reconcileFromStorage: async () => {
				refreshes++;
			},
		});

		await bridge.handleBackgroundEvent({
			type: "ACTIVE_ACCOUNT_CHANGED",
			accountId: "account-b",
		});

		expect(refreshes).toBe(1);
	});

	test("an in-flight burst schedules exactly one trailing reconciliation", async () => {
		const firstPending = deferred();
		let refreshes = 0;
		const bridge = createPopupAccountRuntimeBridge({
			reconcileFromStorage: async () => {
				refreshes++;
				if (refreshes === 1) await firstPending.promise;
			},
		});
		const event = {
			type: "DESKTOP_UNLOCKED",
			accounts: ["account-b"],
		} as const;

		const first = bridge.handleBackgroundEvent(event);
		const duplicate = bridge.handleBackgroundEvent(event);
		const burst = bridge.handleBackgroundEvent({
			type: "VAULT_LOCKED",
			accountId: "account-b",
		});
		expect(refreshes).toBe(1);
		expect(duplicate).toBe(first);
		expect(burst).toBe(first);
		firstPending.resolve();
		await first;
		expect(refreshes).toBe(2);
	});

	test("re-reads storage after a distinct generation arrives in flight", async () => {
		const firstPending = deferred();
		let generation = "account-b";
		const observed: string[] = [];
		const bridge = createPopupAccountRuntimeBridge({
			reconcileFromStorage: async () => {
				observed.push(generation);
				if (observed.length === 1) await firstPending.promise;
			},
		});

		const reconciliation = bridge.handleBackgroundEvent({
			type: "ACTIVE_ACCOUNT_CHANGED",
			accountId: "account-b",
		});
		generation = "account-c";
		bridge.handleBackgroundEvent({
			type: "ACTIVE_ACCOUNT_CHANGED",
			accountId: "account-c",
		});
		firstPending.resolve();
		await reconciliation;

		expect(observed).toEqual(["account-b", "account-c"]);
	});

	test("ignores worker events unrelated to account state", () => {
		let refreshes = 0;
		const bridge = createPopupAccountRuntimeBridge({
			reconcileFromStorage: async () => {
				refreshes++;
			},
		});

		expect(
			bridge.handleBackgroundEvent({
				type: "SYNC_STATUS_CHANGED",
				status: "connected",
			}),
		).toBeUndefined();
		expect(refreshes).toBe(0);
	});
});
