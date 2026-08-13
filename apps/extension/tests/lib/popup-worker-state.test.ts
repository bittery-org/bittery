import { describe, expect, test } from "bun:test";
import { loadPopupWorkerState } from "../../src/lib/popup-worker-state";

describe("popup worker state", () => {
	test("settles worker requests independently", async () => {
		let recovered = false;
		const state = await loadPopupWorkerState({
			status: async () => {
				throw new Error("worker status unavailable");
			},
			clientId: async () => "device-1",
			commandSummary: async () => ({
				pending: 1,
				retrying: 0,
				conflicted: 0,
				failed: 0,
			}),
			recoverStaged: async () => {
				recovered = true;
			},
		});

		expect(state).toEqual({
			status: undefined,
			clientId: "device-1",
			commandSummary: {
				pending: 1,
				retrying: 0,
				conflicted: 0,
				failed: 0,
			},
		});
		expect(recovered).toBe(true);
	});
});
