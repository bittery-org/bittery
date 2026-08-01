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
	// Sibling of `storage`; the handlers now sequence both (CONTRACT.md §12.3).
	itemCache: {
		clearItemCache: async () => {},
	},
}));

mock.module(path.join(libDir, "crypto-adapter.ts"), () => ({
	cryptoAdapter: {},
}));

mock.module(path.join(bgDir, "rpc-client.ts"), () => ({
	rpcClient: {},
}));

let desktopStatus: {
	available: boolean;
	locked: boolean;
	unlockedAccounts?: string[];
} | null = null;

mock.module(path.join(bgDir, "desktop-sync.ts"), () => ({
	desktopSync: {
		getLastStatus: () => desktopStatus,
		checkDesktopStatus: async () => desktopStatus,
	},
}));

let triggerDesktopUnlockResult = true;
let triggerDesktopUnlockCalls = 0;

mock.module(path.join(bgDir, "desktop-client.ts"), () => ({
	desktopClient: {
		triggerDesktopUnlock: async () => {
			triggerDesktopUnlockCalls++;
			return triggerDesktopUnlockResult;
		},
	},
}));

mock.module(path.join(bgDir, "session-manager.ts"), () => ({
	getAutoLockTimeoutCached: () => -1,
	getLastActivityTimestamp: () => Date.now(),
	isDesktopMode: () => false,
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
	desktopStatus = null;
	triggerDesktopUnlockResult = true;
	triggerDesktopUnlockCalls = 0;
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

	test("multiple accounts: selects the first unlocked account as active", async () => {
		accounts = [
			{ accountId: "acc-uuid-1", email: "a@example.com" },
			{ accountId: "acc-uuid-2", email: "b@example.com" },
		];

		const response = await handleQuickUnlockAll({ password: "pw" });

		expect(response.success).toBe(true);
		// All accounts stay unlocked, but the active pointer is a single account.
		expect(setActiveAccountCalls).toEqual([
			{ type: "single", accountId: "acc-uuid-1" },
		]);
		// MUK is seeded from the first unlocked accountId.
		expect(getMasterUnlockKeyCalls).toEqual(["acc-uuid-1"]);
	});
});

// Regression coverage for the extension and the desktop app drifting apart.
// The bug: with the desktop app connected but locked, a password unlock in the
// popup ran a plain SRP unlock and seeded a real MUK. The extension came up
// unlocked while the desktop stayed locked, and nothing ever reconciled them —
// the protocol has no extension -> desktop unlock message.
describe("handleQuickUnlockAll with a connected desktop app", () => {
	test("hands the unlock to a locked desktop instead of unlocking locally", async () => {
		accounts = [{ accountId: "acc-uuid-1", email: "a@example.com" }];
		desktopStatus = { available: true, locked: true };

		const response = await handleQuickUnlockAll({ password: "pw" });

		expect(response).toEqual({
			success: true,
			status: "pending-desktop-unlock",
			desktopReachable: true,
		});
		expect(triggerDesktopUnlockCalls).toBe(1);
		// Nothing was unlocked on this side, so no session was seeded.
		expect(setMasterUnlockKeyCalls.length).toBe(0);
		expect(setActiveAccountCalls.length).toBe(0);
	});

	test("still refuses to unlock locally when the desktop is wedged", async () => {
		accounts = [{ accountId: "acc-uuid-1", email: "a@example.com" }];
		desktopStatus = { available: true, locked: true };
		triggerDesktopUnlockResult = false;

		const response = await handleQuickUnlockAll({ password: "pw" });

		// Falling back to a local unlock here is exactly the divergence bug: the
		// desktop is still reachable and still locked. Report it instead.
		expect(response).toEqual({
			success: true,
			status: "pending-desktop-unlock",
			desktopReachable: false,
		});
		expect(setMasterUnlockKeyCalls.length).toBe(0);
	});

	test("unlocks locally when the connected desktop is already unlocked", async () => {
		accounts = [{ accountId: "acc-uuid-1", email: "a@example.com" }];
		desktopStatus = {
			available: true,
			locked: false,
			unlockedAccounts: ["acc-uuid-1"],
		};

		const response = await handleQuickUnlockAll({ password: "pw" });

		expect(triggerDesktopUnlockCalls).toBe(0);
		expect(response.success).toBe(true);
		expect(setMasterUnlockKeyCalls.length).toBe(1);
	});
});
