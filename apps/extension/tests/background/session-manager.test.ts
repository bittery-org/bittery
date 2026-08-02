import { beforeEach, describe, expect, mock, test } from "bun:test";
import path from "node:path";
import { AUTO_LOCK_ALARM_NAME } from "../../src/background/constants";

// Facade-level integration coverage for the extension staying unlocked next to a
// locked desktop app. `session-manager` is now a zero-state facade over the
// `vault-session` machine, so these cases exercise the reducer through the same
// entry points the eight importing background modules use.

const bgDir = path.resolve(import.meta.dir, "../../src/background");
const libDir = path.resolve(import.meta.dir, "../../src/lib");

/**
 * `null` means the native host did not answer. A payload with
 * `available: false` still means "reachable", which is why `connected` is
 * derived from reachability rather than from that field.
 */
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

let lockAllAccountsCalls = 0;
let lockAllAccountsError: Error | null = null;
const ACCOUNTS = [{ accountId: "acc-1", email: "a@example.com" }];

mock.module(path.join(libDir, "storage.ts"), () => ({
	// -1 is "never auto-lock", so the timeout branch can't mask the desktop check.
	DEFAULT_AUTO_LOCK_TIMEOUT_MS: -1,
	storage: {
		getAccountsList: async () => ACCOUNTS,
		getActiveAccount: async () => "acc-1",
		getAuthToken: async () => "token",
		getServerUrl: async () => "http://localhost:3000",
		lockAllAccounts: async () => {
			lockAllAccountsCalls++;
			if (lockAllAccountsError) {
				throw lockAllAccountsError;
			}
		},
		getAutoLockTimeout: async () => -1,
		getAutoLockTimeoutOrDefault: async () => -1,
	},
	// Sibling of `storage`; the lock sequence takes both (packages/storage/CONTEXT.md §4.2).
	itemCache: {
		clearItemCache: async () => {},
	},
}));

let alarmsClearCalls: string[] = [];

(globalThis as { chrome?: unknown }).chrome = {
	action: {
		setIcon: () => {},
		setBadgeText: () => {},
		setBadgeBackgroundColor: () => {},
	},
	alarms: {
		clear: (name: string) => {
			alarmsClearCalls.push(name);
		},
		create: () => {},
	},
	runtime: {
		getURL: (value: string) => value,
		sendMessage: () => Promise.resolve(),
	},
};

const { isUnlocked, setMasterUnlockKey, setDesktopModeSentinel } = await import(
	path.join(bgDir, "session-manager.ts")
);
const { vaultSession } = await import(
	path.join(bgDir, "vault-session/index.ts")
);

/** The lock is fired-and-forgotten from `isUnlocked`; let the whole chain settle. */
async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(async () => {
	desktopStatus = null;
	lockAllAccountsError = null;
	// The machine is a module singleton, so re-observe an absent desktop and let
	// any resulting lock settle before a test inherits the previous one's state.
	isUnlocked();
	await settle();
	lockAllAccountsCalls = 0;
	alarmsClearCalls = [];
});

describe("isUnlocked with a desktop app connected", () => {
	test("locks a locally unlocked extension when the desktop is locked", async () => {
		// A real MUK means local ownership — the branch that used to skip the
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
		// The native host stopped answering: that, not `available: false`, is what
		// a disconnected desktop looks like.
		desktopStatus = null;

		expect(isUnlocked()).toBe(false);
		await settle();
		expect(lockAllAccountsCalls).toBe(1);
	});

	test("locks when the native host answers but reports the app unavailable", async () => {
		setMasterUnlockKey(new Uint8Array(32).fill(7));
		// The host's fallback when it cannot reach the app. Reading `available`
		// here instead of reachability would leave the vault unlocked.
		desktopStatus = { available: false, locked: true };

		expect(isUnlocked()).toBe(false);
		await settle();
		expect(lockAllAccountsCalls).toBe(1);
	});
});

// The lifecycle module reports storage failures instead of throwing, so the
// service-worker lifetime effects must not be conditional on it succeeding —
// a lock that leaves the alarm armed and the keepalive running is not a lock.
describe("lock when the storage lock fails", () => {
	test("still clears the auto-lock alarm and never throws", async () => {
		setMasterUnlockKey(new Uint8Array(32).fill(7));
		expect(isUnlocked()).toBe(true);
		lockAllAccountsError = new Error("chrome.storage unavailable");

		await vaultSession.dispatch({
			type: "LOCK_REQUESTED",
			source: "popup",
			at: Date.now(),
		});

		expect(lockAllAccountsCalls).toBe(1);
		expect(alarmsClearCalls).toContain(AUTO_LOCK_ALARM_NAME);
		expect(isUnlocked()).toBe(false);
	});
});
