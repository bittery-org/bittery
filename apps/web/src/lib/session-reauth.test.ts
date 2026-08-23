import { describe, expect, it } from "bun:test";
import type { LifecycleOutcome } from "@bittery/core/services/account-lifecycle";
import { requireCompleteSessionLock } from "./session-reauth";

function outcome(failures: LifecycleOutcome["failures"]): LifecycleOutcome {
	return {
		affected: [],
		activeAccountId: undefined,
		activeAccount: null,
		wasActive: false,
		remaining: [],
		failures,
	};
}

describe("requireCompleteSessionLock", () => {
	it("returns a complete lock outcome", () => {
		const complete = outcome([]);
		expect(requireCompleteSessionLock(complete)).toBe(complete);
	});

	it("fails closed when a lifecycle step did not complete", () => {
		expect(() =>
			requireCompleteSessionLock(
				outcome([
					{
						accountId: "account-a",
						step: "clear_session",
						cause: new Error("storage unavailable"),
					},
				]),
			),
		).toThrow("Session reauthentication lock was incomplete");
	});
});
