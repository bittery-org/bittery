import { describe, expect, it } from "bun:test";
import type { AccountMetadata } from "@bittery/storage/types";
import {
	selectActiveAccountAfterRemoval,
	selectActiveAccountAfterUnlock,
} from "./select-active-account";

function account(accountId: string): AccountMetadata {
	return {
		accountId,
		email: `${accountId}@test.com`,
		userId: `user-${accountId}`,
		name: accountId,
		serverUrl: "https://app.bittery.io",
		secretKeyHint: "ABCD••••",
		addedAt: 1,
		lastActiveAt: 1,
		biometricEnabled: false,
	};
}

const accounts = [account("acc-1"), account("acc-2"), account("acc-3")];

describe("selectActiveAccountAfterUnlock", () => {
	it("keeps the previously active account when it was unlocked", () => {
		expect(
			selectActiveAccountAfterUnlock({
				previousActive: { type: "single", accountId: "acc-2" },
				unlockedAccountIds: ["acc-1", "acc-2"],
				accounts,
			}),
		).toBe("acc-2");
	});

	it("falls back to the first unlocked account when the previous one failed to unlock", () => {
		expect(
			selectActiveAccountAfterUnlock({
				previousActive: { type: "single", accountId: "acc-2" },
				unlockedAccountIds: ["acc-3"],
				accounts,
			}),
		).toBe("acc-3");
	});

	it("falls back to the first unlocked account when there was no previous active account", () => {
		expect(
			selectActiveAccountAfterUnlock({
				previousActive: null,
				unlockedAccountIds: ["acc-3", "acc-1"],
				accounts,
			}),
		).toBe("acc-3");
	});

	it("falls back when the previously active account no longer exists", () => {
		expect(
			selectActiveAccountAfterUnlock({
				previousActive: { type: "single", accountId: "removed" },
				unlockedAccountIds: ["acc-2"],
				accounts,
			}),
		).toBe("acc-2");
	});

	it("ignores a previously active value that is an email rather than an accountId", () => {
		expect(
			selectActiveAccountAfterUnlock({
				previousActive: { type: "single", accountId: "acc-2@test.com" },
				unlockedAccountIds: ["acc-1", "acc-2"],
				accounts,
			}),
		).toBe("acc-1");
	});

	it("falls back to the first known account when nothing unlocked", () => {
		expect(
			selectActiveAccountAfterUnlock({
				previousActive: null,
				unlockedAccountIds: [],
				accounts,
			}),
		).toBe("acc-1");
	});

	it("returns undefined when there are no accounts at all", () => {
		expect(
			selectActiveAccountAfterUnlock({
				previousActive: null,
				unlockedAccountIds: [],
				accounts: [],
			}),
		).toBeUndefined();
	});
});

describe("selectActiveAccountAfterRemoval", () => {
	it("moves to the first remaining account when the active one is removed", () => {
		expect(
			selectActiveAccountAfterRemoval({
				removedAccountId: "acc-1",
				previousActive: { type: "single", accountId: "acc-1" },
				accounts,
			}),
		).toBe("acc-2");
	});

	it("returns undefined when the active account was the last one", () => {
		expect(
			selectActiveAccountAfterRemoval({
				removedAccountId: "acc-1",
				previousActive: { type: "single", accountId: "acc-1" },
				accounts: [account("acc-1")],
			}),
		).toBeUndefined();
	});

	it("leaves the pointer alone when a non-active account is removed", () => {
		expect(
			selectActiveAccountAfterRemoval({
				removedAccountId: "acc-3",
				previousActive: { type: "single", accountId: "acc-2" },
				accounts,
			}),
		).toBeUndefined();
	});

	it("leaves the pointer alone when there was no active account", () => {
		expect(
			selectActiveAccountAfterRemoval({
				removedAccountId: "acc-1",
				previousActive: null,
				accounts,
			}),
		).toBeUndefined();
	});

	it("leaves the pointer alone when the removed account is not in the list", () => {
		expect(
			selectActiveAccountAfterRemoval({
				removedAccountId: "unknown",
				previousActive: { type: "single", accountId: "acc-2" },
				accounts,
			}),
		).toBeUndefined();
	});
});
