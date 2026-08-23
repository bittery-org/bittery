import { describe, expect, it, mock } from "bun:test";
import type { LifecycleOutcome } from "@bittery/core/services/account-lifecycle";
import type { AccountMetadata } from "@bittery/storage/types";
import { reauthenticateDesktopSession } from "./session-reauth";

function outcome(failures: LifecycleOutcome["failures"]): LifecycleOutcome {
	return {
		affected: [
			{ accountId: "account-a", email: "a@example.com" } as AccountMetadata,
		],
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
		const lockedAccounts: string[] = [];

		await reauthenticateDesktopSession(
			"account-a",
			async (accountId) => {
				lockedAccounts.push(accountId);
				return outcome([]);
			},
			{ clearQueries, notify, navigateToUnlock },
		);

		expect(lockedAccounts).toEqual(["account-a"]);
		expect(clearQueries).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledTimes(1);
		expect(navigateToUnlock).toHaveBeenCalledTimes(1);
	});

	it("surfaces an incomplete lock before clearing or navigating", async () => {
		const clearQueries = mock(() => {});
		const navigateToUnlock = mock(() => {});

		await expect(
			reauthenticateDesktopSession(
				"account-a",
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
		).rejects.toThrow("did not complete safely");
		expect(clearQueries).not.toHaveBeenCalled();
		expect(navigateToUnlock).not.toHaveBeenCalled();
	});

	it("rejects an unresolved Account before applying host effects", async () => {
		const clearQueries = mock(() => {});
		const unresolved = { ...outcome([]), affected: [] };

		await expect(
			reauthenticateDesktopSession("account-a", async () => unresolved, {
				clearQueries,
				notify: () => {},
				navigateToUnlock: () => {},
			}),
		).rejects.toThrow("did not complete safely");
		expect(clearQueries).not.toHaveBeenCalled();
	});
});
