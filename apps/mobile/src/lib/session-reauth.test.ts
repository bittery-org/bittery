import { describe, expect, it, mock } from "bun:test";
import type { LifecycleOutcome } from "@bittery/core/services/account-lifecycle";
import { reauthenticateMobileSession } from "./session-reauth";

function outcome(failed = false): LifecycleOutcome {
	return {
		affected: [],
		activeAccountId: undefined,
		activeAccount: null,
		wasActive: true,
		remaining: [],
		failures: failed
			? [{ accountId: "account-a", step: "clear_session", cause: "failed" }]
			: [],
	};
}

describe("reauthenticateMobileSession", () => {
	it("applies the expired-session effects after a complete lock", async () => {
		const clearQueries = mock(() => {});
		const notifyExpired = mock(() => {});
		const navigate = mock((_wasActive: boolean) => {});

		await reauthenticateMobileSession(async () => outcome(), {
			clearQueries,
			notifyExpired,
			navigate,
		});

		expect(clearQueries).toHaveBeenCalledTimes(1);
		expect(notifyExpired).toHaveBeenCalledTimes(1);
		expect(navigate).toHaveBeenCalledWith(true);
	});

	it("surfaces an incomplete lock before clearing or navigating", async () => {
		const clearQueries = mock(() => {});
		const notifyExpired = mock(() => {});
		const navigate = mock((_wasActive: boolean) => {});

		expect(
			reauthenticateMobileSession(async () => outcome(true), {
				clearQueries,
				notifyExpired,
				navigate,
			}),
		).rejects.toThrow("safely lock");
		expect(clearQueries).not.toHaveBeenCalled();
		expect(notifyExpired).not.toHaveBeenCalled();
		expect(navigate).not.toHaveBeenCalled();
	});
});
