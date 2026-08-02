import { beforeEach, describe, expect, mock, test } from "bun:test";
import path from "node:path";
import { AUTO_LOCK_ALARM_NAME } from "../../src/background/constants";

// Regression coverage for the extension staying unlocked next to a locked
// desktop app. `isUnlocked` only consulted the desktop while in desktop mode
// (sentinel MUK), so any locally derived MUK took the standalone branch and
// never reconciled — the two halves could sit diverged indefinitely.

const bgDir = path.resolve(import.meta.dir, "../../src/background");
const libDir = path.resolve(import.meta.dir, "../../src/lib");

let desktopStatus: { available: boolean; locked: boolean } | null = null;

mock.module(path.join(bgDir, "desktop-sync.ts"), () => ({
	desktopSync: {
		isDesktopAvailable: () => Boolean(desktopStatus?.available),
		getLastStatus: () => desktopStatus,
	},
}));

let lockAllAccountsCalls = 0;
let lockAllAccountsError: Error | null = null;
const ACCOUNTS = [{ accountId: "acc-1", email: "a@example.com" }];

mock.module(path.join(libDir, "storage.ts"), () => ({
	// -1 is "never auto-lock", so the timeout branch can't mask the desktop check.
	DEFAULT_AUTO_LOCK_TIMEOUT_MS: -1,
	storage: {
		getAccountsList: async () => ACCOUNTS,
		getActiveAccount: async () => ({
			type: "single" as const,
			accountId: "acc-1",
		}),
		getAuthToken: async () => "token",
		getServerUrl: async () => "http://localhost:3000",
		lockAllAccounts: async () => {
			lockAllAccountsCalls++;
			if (lockAllAccountsError) {
				throw lockAllAccountsError;
			}
		},
		getAutoLockTimeout: async () => -1,
	},
	// Sibling of `storage`; the lock sequence takes both (packages/storage/CONTEXT.md §4.2).
	itemCache: {
		clearItemCache: async () => {},
	},
}));

let alarmsClearCalls: string[] = [];

(globalThis as { chrome?: unknown }).chrome = {
	action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {} },
	alarms: {
		clear: (name: string) => {
			alarmsClearCalls.push(name);
		},
		create: () => {},
	},
	runtime: { sendMessage: () => Promise.resolve() },
};

const {
	_lockInternal,
	isUnlocked,
	setMasterUnlockKey,
	setDesktopModeSentinel,
} = await import(path.join(bgDir, "session-manager.ts"));

/** The lock is fired-and-forgotten from `isUnlocked`; let the whole chain settle. */
async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
	desktopStatus = null;
	lockAllAccountsCalls = 0;
	lockAllAccountsError = null;
	alarmsClearCalls = [];
});

describe("isUnlocked with a desktop app connected", () => {
	test("locks a locally unlocked extension when the desktop is locked", async () => {
		// A real MUK means standalone mode — the branch that used to skip the
		// desktop check entirely.
		setMasterUnlockKey(new Uint8Array(32).fill(7));
		desktopStatus = { available: true, locked: true };

		expect(isUnlocked()).toBe(false);
		await settle();
		expect(lockAllAccountsCalls).toBe(1);
	});

	test("leaves a locally unlocked extension alone when the desktop is unlocked", () => {
		setMasterUnlockKey(new Uint8Array(32).fill(7));
		desktopStatus = { available: true, locked: false };

		expect(isUnlocked()).toBe(true);
		expect(lockAllAccountsCalls).toBe(0);
	});

	test("leaves a standalone extension alone when no desktop is connected", () => {
		setMasterUnlockKey(new Uint8Array(32).fill(7));
		desktopStatus = null;

		expect(isUnlocked()).toBe(true);
		expect(lockAllAccountsCalls).toBe(0);
	});

	test("still locks desktop-mode sessions when the desktop disconnects", async () => {
		setDesktopModeSentinel();
		desktopStatus = { available: false, locked: false };

		expect(isUnlocked()).toBe(false);
		await settle();
		expect(lockAllAccountsCalls).toBe(1);
	});
});

// The lifecycle module reports storage failures instead of throwing, so the
// service-worker lifetime effects must not be conditional on it succeeding —
// a lock that leaves the alarm armed and the keepalive running is not a lock.
describe("_lockInternal when the storage lock fails", () => {
	test("still clears the auto-lock alarm and never throws", async () => {
		setMasterUnlockKey(new Uint8Array(32).fill(7));
		lockAllAccountsError = new Error("chrome.storage unavailable");

		await _lockInternal();

		expect(lockAllAccountsCalls).toBe(1);
		expect(alarmsClearCalls).toContain(AUTO_LOCK_ALARM_NAME);
		expect(isUnlocked()).toBe(false);
	});
});
