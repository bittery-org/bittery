import { describe, expect, it, mock } from "bun:test";
import type { LifecycleOutcome } from "@bittery/core/services/account-lifecycle";
import { reauthenticateDesktopSession } from "./session-reauth";

function outcome(failures: LifecycleOutcome["failures"]): LifecycleOutcome {
	return {
		affected: [],
		activeAccountId: "account-a",
		activeAccount: null,
		wasActive: true,
		remaining: [],
		failures,
	};
}

describe("reauthenticateDesktopSession", () => {
	it("locks and routes a 401 to password-only unlock without a sign-in prefill", async () => {
		const clearQueries = mock(() => {});
		const notify = mock(() => {});
		const navigateToUnlock = mock(() => {});

		await reauthenticateDesktopSession(async () => outcome([]), {
			clearQueries,
			notify,
			navigateToUnlock,
		});

		expect(clearQueries).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledTimes(1);
		expect(navigateToUnlock).toHaveBeenCalledTimes(1);
	});

	it("surfaces an incomplete lock before clearing or navigating", async () => {
		const clearQueries = mock(() => {});
		const navigateToUnlock = mock(() => {});

		await expect(
			reauthenticateDesktopSession(
				async () =>
					outcome([
						{
							accountId: "account-a",
							step: "clear_session",
							cause: new Error("keychain unavailable"),
						},
					]),
				{
					clearQueries,
					notify: () => {},
					navigateToUnlock,
				},
			),
		).rejects.toThrow("reauthentication lock was incomplete");
		expect(clearQueries).not.toHaveBeenCalled();
		expect(navigateToUnlock).not.toHaveBeenCalled();
	});
});
