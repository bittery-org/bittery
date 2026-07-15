import { beforeEach, describe, expect, mock, test } from "bun:test";
import path from "node:path";

// Regression coverage for the "Unlock All" password flow in the single-account
// case. The bug: the handler treated the entries of `unlocked` (which are
// accountIds) as emails and ran them back through `resolveAccountIdFromEmail`,
// which only matches on email. For a UUID accountId that always returned
// undefined and the handler threw "No unlocked accounts found".

const bgDir = path.resolve(import.meta.dir, "../../src/background");
const libDir = path.resolve(import.meta.dir, "../../src/lib");

interface StoredAccount {
	accountId: string;
	email: string;
}

let accounts: StoredAccount[] = [];
const setActiveAccountCalls: unknown[] = [];
const getMasterUnlockKeyCalls: (string | undefined)[] = [];
const setMasterUnlockKeyCalls: unknown[] = [];

// resolveAccountIdFromEmail only matches on email; for an accountId (UUID) it
// resolves to undefined. This mirrors the real behavior that exposed the bug.
mock.module(path.join(bgDir, "services/account-resolution.ts"), () => ({
	resolveEmailFromAccountId: async (accountId: string) =>
		accounts.find((a) => a.accountId === accountId)?.email,
	resolveAccountIdFromEmail: async (email: string) =>
		accounts.find((a) => a.email === email)?.accountId,
}));

mock.module(path.join(libDir, "storage.ts"), () => ({
	storage: {
		getAccountsList: async () => accounts,
		hasStoredSecretKey: async () => true,
		getAuthToken: async () => "token",
		getServerUrl: async () => "http://localhost:3000",
		setActiveAccount: async (value: unknown) => {
			setActiveAccountCalls.push(value);
		},
		getMasterUnlockKey: async (accountId?: string) => {
			getMasterUnlockKeyCalls.push(accountId);
			return new Uint8Array([9]);
		},
	},
}));

mock.module(path.join(libDir, "crypto-adapter.ts"), () => ({
	cryptoAdapter: {},
}));

mock.module(path.join(bgDir, "rpc-client.ts"), () => ({
	rpcClient: {},
}));

mock.module(path.join(bgDir, "desktop-sync.ts"), () => ({
	desktopSync: {
		getLastStatus: () => null,
		checkDesktopStatus: async () => null,
	},
}));

mock.module(path.join(bgDir, "session-manager.ts"), () => ({
	isUnlocked: () => false,
	lock: () => {},
	setDesktopModeSentinel: () => {},
	setMasterUnlockKey: (value: unknown) => {
		setMasterUnlockKeyCalls.push(value);
	},
	updateActivity: () => {},
}));

mock.module("@bittery/core", () => ({
	performSRPUnlock: async () => ({ masterUnlockKey: new Uint8Array([1]) }),
	storeUnlockSession: async () => {},
	performSRPLogin: async () => ({}),
	storeLoginSession: async () => {},
}));

mock.module("@bittery/core/services/account-session-manager", () => ({
	getAccountSessionManager: () => ({
		unlockAccount: async () => true,
	}),
}));

mock.module("@bittery/shared/rpc-client-factory", () => ({
	createAccountRpcClient: () => ({}),
}));

const { handleQuickUnlockAll } = await import(
	path.join(bgDir, "auth-handlers.ts")
);

beforeEach(() => {
	accounts = [];
	setActiveAccountCalls.length = 0;
	getMasterUnlockKeyCalls.length = 0;
	setMasterUnlockKeyCalls.length = 0;
});

describe("handleQuickUnlockAll", () => {
	test("single account: sets active account by accountId, not email round-trip", async () => {
		accounts = [{ accountId: "acc-uuid-1", email: "a@example.com" }];

		const response = await handleQuickUnlockAll({ password: "pw" });

		expect(response.success).toBe(true);
		expect(response.result).toEqual({
			unlocked: ["acc-uuid-1"],
			failed: [],
		});
		// The active account must be the unlocked accountId, not undefined.
		expect(setActiveAccountCalls).toEqual([
			{ type: "single", accountId: "acc-uuid-1" },
		]);
		// MUK lookup must use the accountId directly.
		expect(getMasterUnlockKeyCalls).toEqual(["acc-uuid-1"]);
		expect(setMasterUnlockKeyCalls.length).toBe(1);
	});

	test("multiple accounts: switches to all-accounts mode", async () => {
		accounts = [
			{ accountId: "acc-uuid-1", email: "a@example.com" },
			{ accountId: "acc-uuid-2", email: "b@example.com" },
		];

		const response = await handleQuickUnlockAll({ password: "pw" });

		expect(response.success).toBe(true);
		expect(setActiveAccountCalls).toEqual([{ type: "all" }]);
		// MUK is seeded from the first unlocked accountId.
		expect(getMasterUnlockKeyCalls).toEqual(["acc-uuid-1"]);
	});
});
