import { describe, expect, test } from "bun:test";
import type { AccountMetadata } from "@bittery/storage";
import {
	clearTransitionalAccount,
	forgetTransitionalSession,
	lockRejectedTransitionalSession,
	type TransitionalAccountCleanupDeps,
} from "./transitional-account-cleanup";

const ACCOUNT: AccountMetadata = {
	accountId: "login-account",
	email: "user@example.com",
	userId: "user-1",
	name: "User",
	serverUrl: "https://example.com",
	secretKeyHint: "A3-TEST",
	addedAt: 1,
	lastActiveAt: 2,
	biometricEnabled: false,
	insecureTransportConfirmed: false,
};

function cleanupDeps(): TransitionalAccountCleanupDeps & {
	readonly calls: string[];
} {
	const calls: string[] = [];
	return {
		calls,
		storage: {
			async getAccountsList() {
				calls.push("accounts");
				return [ACCOUNT];
			},
			async getActiveAccount() {
				calls.push("active");
				return ACCOUNT.accountId;
			},
			async clearSession(accountId) {
				calls.push(`clearSession:${accountId}`);
			},
			async forgetSession(accountId) {
				calls.push(`forgetSession:${accountId}`);
			},
			async clearAllStoredData(accountId) {
				calls.push(`clearAllStoredData:${accountId}`);
			},
			async setActiveAccount(accountId) {
				calls.push(`setActiveAccount:${accountId}`);
			},
		},
		itemCache: {
			async clearItemCache(accountId) {
				calls.push(`clearItemCache:${accountId}`);
			},
		},
	};
}

describe("Web transitional Account cleanup", () => {
	test("a rejected Session is locked without deleting Device-bound data", async () => {
		const deps = cleanupDeps();

		const outcome = await lockRejectedTransitionalSession(
			ACCOUNT.accountId,
			deps,
		);

		expect(outcome).toEqual({ targetPresent: true, failures: [] });
		expect(deps.calls).toEqual([
			"accounts",
			"active",
			`clearSession:${ACCOUNT.accountId}`,
			"accounts",
			"active",
		]);
	});

	test("Account removal clears cached ciphertext before the transitional row", async () => {
		const deps = cleanupDeps();

		const outcome = await clearTransitionalAccount(ACCOUNT.accountId, deps);

		expect(outcome.failures).toEqual([]);
		expect(deps.calls).toContain(`clearItemCache:${ACCOUNT.accountId}`);
		expect(
			deps.calls.indexOf(`clearItemCache:${ACCOUNT.accountId}`),
		).toBeLessThan(
			deps.calls.indexOf(`clearAllStoredData:${ACCOUNT.accountId}`),
		);
	});

	test("Account removal continues into named storage after a cache failure", async () => {
		const deps = cleanupDeps();
		deps.itemCache.clearItemCache = async (accountId) => {
			deps.calls.push(`clearItemCache:${accountId}`);
			throw new Error("cache unavailable");
		};

		const outcome = await clearTransitionalAccount(ACCOUNT.accountId, deps);

		expect(outcome.failures.map((failure) => failure.step)).toEqual([
			"clearItemCache",
		]);
		expect(deps.calls).toContain(`clearAllStoredData:${ACCOUNT.accountId}`);
	});

	test("a failed named storage clear still attempts the preselected successor", async () => {
		const deps = cleanupDeps();
		const successor = { ...ACCOUNT, accountId: "other-account" };
		deps.storage.getAccountsList = async () => {
			deps.calls.push("accounts");
			return [ACCOUNT, successor];
		};
		deps.storage.clearAllStoredData = async (accountId) => {
			deps.calls.push(`clearAllStoredData:${accountId}`);
			throw new Error("account values survived");
		};

		const outcome = await clearTransitionalAccount(ACCOUNT.accountId, deps);

		expect(outcome.failures.map((failure) => failure.step)).toEqual([
			"clearAccountData",
		]);
		expect(deps.calls).toContain(`setActiveAccount:${successor.accountId}`);
	});

	test("a failed successor write is part of the closed cleanup outcome", async () => {
		const deps = cleanupDeps();
		const successor = { ...ACCOUNT, accountId: "other-account" };
		deps.storage.getAccountsList = async () => [ACCOUNT, successor];
		deps.storage.setActiveAccount = async (accountId) => {
			deps.calls.push(`setActiveAccount:${accountId}`);
			throw new Error("pointer unavailable");
		};

		const outcome = await clearTransitionalAccount(ACCOUNT.accountId, deps);

		expect(outcome.failures.map((failure) => failure.step)).toEqual([
			"setActiveAccount",
		]);
	});

	test("pre- and post-state read failures cannot suppress named cleanup", async () => {
		const deps = cleanupDeps();
		deps.storage.getAccountsList = async () => {
			deps.calls.push("accounts:throw");
			throw new Error("accounts unavailable");
		};
		deps.storage.getActiveAccount = async () => {
			deps.calls.push("active:throw");
			throw new Error("pointer unavailable");
		};

		const outcome = await clearTransitionalAccount(ACCOUNT.accountId, deps);

		expect(outcome.targetPresent).toBe(false);
		expect(outcome.failures.map((failure) => failure.step)).toEqual([
			"readAccountState",
			"readAccountState",
			"readAccountState",
			"readAccountState",
		]);
		expect(deps.calls).toContain(`clearItemCache:${ACCOUNT.accountId}`);
		expect(deps.calls).toContain(`clearAllStoredData:${ACCOUNT.accountId}`);
	});

	test("removing a non-active Account leaves the pointer untouched", async () => {
		const deps = cleanupDeps();
		const active = { ...ACCOUNT, accountId: "active-account" };
		deps.storage.getAccountsList = async () => [ACCOUNT, active];
		deps.storage.getActiveAccount = async () => active.accountId;

		await clearTransitionalAccount(ACCOUNT.accountId, deps);

		expect(
			deps.calls.filter((call) => call.startsWith("setActiveAccount:")),
		).toEqual([]);
	});

	test("repeating removal never demotes the successor it already selected", async () => {
		const deps = cleanupDeps();
		const successor = { ...ACCOUNT, accountId: "other-account" };
		let accounts = [ACCOUNT, successor];
		let activeAccountId: string | null = ACCOUNT.accountId;
		deps.storage.getAccountsList = async () => [...accounts];
		deps.storage.getActiveAccount = async () => activeAccountId;
		deps.storage.clearAllStoredData = async (accountId) => {
			deps.calls.push(`clearAllStoredData:${accountId}`);
			accounts = accounts.filter((account) => account.accountId !== accountId);
			if (activeAccountId === accountId) activeAccountId = null;
		};
		deps.storage.setActiveAccount = async (accountId) => {
			deps.calls.push(`setActiveAccount:${accountId}`);
			activeAccountId = accountId;
		};

		await clearTransitionalAccount(ACCOUNT.accountId, deps);
		await clearTransitionalAccount(ACCOUNT.accountId, deps);

		expect(activeAccountId).toBe(successor.accountId);
		expect(
			deps.calls.filter((call) => call.startsWith("setActiveAccount:")),
		).toEqual([`setActiveAccount:${successor.accountId}`]);
	});

	test("Sign out attempts every browser store and reports a partial failure", async () => {
		const deps = cleanupDeps();
		deps.itemCache.clearItemCache = async (accountId) => {
			deps.calls.push(`clearItemCache:${accountId}`);
			throw new Error("cache unavailable");
		};

		const outcome = await forgetTransitionalSession(ACCOUNT.accountId, deps);

		expect(outcome.failures.map((failure) => failure.step)).toEqual([
			"clearItemCache",
		]);
		expect(deps.calls).toContain(`forgetSession:${ACCOUNT.accountId}`);
	});

	test("removing the active Account restores the pre-existing successor", async () => {
		const deps = cleanupDeps();
		const successor = { ...ACCOUNT, accountId: "other-account" };
		deps.storage.getAccountsList = async () => {
			deps.calls.push("accounts");
			return [ACCOUNT, successor];
		};

		await clearTransitionalAccount(ACCOUNT.accountId, deps);

		expect(deps.calls).toContain(`setActiveAccount:${successor.accountId}`);
	});
});
