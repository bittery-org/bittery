import { beforeEach, describe, expect, mock, test } from "bun:test";
import path from "node:path";
import { selectActiveAccountAfterUnlock } from "@bittery/core/services/select-active-account";
import type { ActiveAccountId } from "@bittery/storage/types";

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
let activeAccount: ActiveAccountId = null;
/** `null` unlocks every account; otherwise only the listed accountIds unlock. */
let unlockableAccountIds: string[] | null = null;
const setActiveAccountCalls: unknown[] = [];
const getMasterUnlockKeyCalls: (string | undefined)[] = [];
const setMasterUnlockKeyCalls: unknown[] = [];
const forgetSessionCalls: (string | undefined)[] = [];
const clearItemCacheCalls: (string | undefined)[] = [];
let forgetSessionError: Error | null = null;

// resolveAccountIdFromEmail only matches on email; for an accountId (UUID) it
// resolves to undefined. This mirrors the real behavior that exposed the bug.
mock.module(path.join(bgDir, "services/account-resolution.ts"), () => ({
	resolveEmailFromAccountId: async (accountId: string) =>
		accounts.find((a) => a.accountId === accountId)?.email,
	resolveAccountIdFromEmail: async (email: string) =>
		accounts.find((a) => a.email === email)?.accountId,
}));

const storageMock = {
	getAccountsList: async () => accounts,
	hasStoredSecretKey: async () => true,
	getAuthToken: async () => "token",
	getServerUrl: async () => "http://localhost:3000",
	getActiveAccount: async () => activeAccount,
	setActiveAccount: async (value: unknown) => {
		setActiveAccountCalls.push(value);
	},
	getMasterUnlockKey: async (accountId?: string) => {
		getMasterUnlockKeyCalls.push(accountId);
		return new Uint8Array([9]);
	},
	forgetSession: async (accountId?: string) => {
		if (forgetSessionError) {
			throw forgetSessionError;
		}
		forgetSessionCalls.push(accountId);
	},
};

mock.module(path.join(libDir, "storage.ts"), () => ({
	storage: storageMock,
	// Sibling of `storage`; the handlers now sequence both (packages/storage/CONTEXT.md §4.2).
	itemCache: {
		clearItemCache: async (accountId?: string) => {
			clearItemCacheCalls.push(accountId);
		},
	},
}));

// Stands in for the SRP/network half of `unlockAllWithPassword` only. The active-account
// selection and the write it performs are the real ones, because that is the
// part of the contract the handler leans on.
mock.module("@bittery/core/services/unlock", () => ({
	unlockAllWithPassword: async () => {
		const previousActive = activeAccount;
		const unlocked = accounts
			.map((account) => account.accountId)
			.filter((accountId) => unlockableAccountIds?.includes(accountId) ?? true);
		const failed = accounts
			.filter((account) => !unlocked.includes(account.accountId))
			.map((account) => ({
				accountId: account.accountId,
				email: account.email,
				reason: "credential_rejected" as const,
			}));

		if (unlocked.length === 0) {
			return { activeAccountId: undefined, unlocked, failed };
		}

		const activeAccountId = selectActiveAccountAfterUnlock({
			previousActive,
			unlockedAccountIds: unlocked,
			accounts,
		});
		if (activeAccountId) {
			await storageMock.setActiveAccount(activeAccountId);
		}
		return { activeAccountId, unlocked, failed };
	},
}));

mock.module(path.join(libDir, "crypto.ts"), () => ({
	crypto: {},
}));

mock.module(path.join(bgDir, "api-client.ts"), () => ({
	apiClient: {},
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
	setDesktopModeSentinel: () => {},
	setMasterUnlockKey: (value: unknown) => {
		setMasterUnlockKeyCalls.push(value);
	},
	updateActivity: () => {},
}));

mock.module("@bittery/core/services/auth-service", () => ({
	performSRPUnlock: async () => ({ masterUnlockKey: new Uint8Array([1]) }),
	storeUnlockSession: async () => {},
	storeUnlockSessionOwned: async () => {},
	performSRPLogin: async () => ({}),
	storeLoginSessionOwned: async () => {},
}));

mock.module("@bittery/core/services/account-session-manager", () => ({
	peekAccountSessionManager: () => null,
	getAccountSessionManager: () => ({
		unlockAccount: async () => true,
	}),
}));

mock.module("@bittery/shared/api-client-factory", () => ({
	createAccountApiClient: () => ({}),
	// The lifecycle `CredentialMirror` drops cached clients holding a revoked token.
	clearAccountApiClient: () => {},
}));

const { handleLogout, handleQuickUnlockAll } = await import(
	path.join(bgDir, "auth-handlers.ts")
);

beforeEach(() => {
	accounts = [];
	activeAccount = null;
	unlockableAccountIds = null;
	setActiveAccountCalls.length = 0;
	getMasterUnlockKeyCalls.length = 0;
	setMasterUnlockKeyCalls.length = 0;
	forgetSessionCalls.length = 0;
	clearItemCacheCalls.length = 0;
	forgetSessionError = null;
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
		expect(setActiveAccountCalls).toEqual(["acc-uuid-1"]);
		// MUK lookup must use the accountId directly.
		expect(getMasterUnlockKeyCalls).toEqual(["acc-uuid-1"]);
		expect(setMasterUnlockKeyCalls.length).toBe(1);
	});

	test("multiple accounts: falls back to the first unlocked account as active", async () => {
		accounts = [
			{ accountId: "acc-uuid-1", email: "a@example.com" },
			{ accountId: "acc-uuid-2", email: "b@example.com" },
		];

		const response = await handleQuickUnlockAll({ password: "pw" });

		expect(response.success).toBe(true);
		// All accounts stay unlocked, but the active pointer is a single account.
		expect(setActiveAccountCalls).toEqual(["acc-uuid-1"]);
		// MUK is seeded from the first unlocked accountId.
		expect(getMasterUnlockKeyCalls).toEqual(["acc-uuid-1"]);
	});

	test("multiple accounts: returns the user to the account they were last using", async () => {
		accounts = [
			{ accountId: "acc-uuid-1", email: "a@example.com" },
			{ accountId: "acc-uuid-2", email: "b@example.com" },
		];
		activeAccount = "acc-uuid-2";

		await handleQuickUnlockAll({ password: "pw" });

		expect(setActiveAccountCalls).toEqual(["acc-uuid-2"]);
		expect(getMasterUnlockKeyCalls).toEqual(["acc-uuid-2"]);
	});

	test("skips a previously active account that did not unlock", async () => {
		accounts = [
			{ accountId: "acc-uuid-1", email: "a@example.com" },
			{ accountId: "acc-uuid-2", email: "b@example.com" },
		];
		activeAccount = "acc-uuid-2";
		unlockableAccountIds = ["acc-uuid-1"];

		const response = await handleQuickUnlockAll({ password: "pw" });

		expect(response.result).toEqual({
			unlocked: ["acc-uuid-1"],
			failed: [
				{
					accountId: "acc-uuid-2",
					email: "b@example.com",
					reason: "credential_rejected",
				},
			],
		});
		expect(setActiveAccountCalls).toEqual(["acc-uuid-1"]);
	});

	test("fails when no account unlocks", async () => {
		accounts = [{ accountId: "acc-uuid-1", email: "a@example.com" }];
		unlockableAccountIds = [];

		await expect(handleQuickUnlockAll({ password: "pw" })).rejects.toThrow(
			"Failed to unlock any accounts",
		);
		expect(setActiveAccountCalls).toEqual([]);
	});
});

describe("handleLogout", () => {
	test("drops the session and its item cache together", async () => {
		accounts = [{ accountId: "acc-uuid-1", email: "a@example.com" }];
		activeAccount = "acc-uuid-1";

		const response = await handleLogout();

		expect(response).toEqual({ success: true });
		expect(clearItemCacheCalls).toEqual(["acc-uuid-1"]);
		expect(forgetSessionCalls).toEqual(["acc-uuid-1"]);
	});

	test("reports a failed storage step instead of claiming success", async () => {
		accounts = [{ accountId: "acc-uuid-1", email: "a@example.com" }];
		activeAccount = "acc-uuid-1";
		forgetSessionError = new Error("chrome.storage unavailable");

		const response = await handleLogout();

		expect(response.success).toBe(false);
		// Best effort is the module's contract: the ciphertext goes even when the
		// record that names its keys survives.
		expect(clearItemCacheCalls).toEqual(["acc-uuid-1"]);
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
