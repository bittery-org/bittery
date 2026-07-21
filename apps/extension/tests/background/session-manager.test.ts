import { beforeEach, describe, expect, mock, test } from "bun:test";
import path from "node:path";

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

mock.module(path.join(libDir, "storage.ts"), () => ({
	// -1 is "never auto-lock", so the timeout branch can't mask the desktop check.
	DEFAULT_AUTO_LOCK_TIMEOUT_MS: -1,
	storage: {
		lockAllAccounts: async () => {
			lockAllAccountsCalls++;
		},
		getAutoLockTimeout: async () => -1,
	},
}));

(globalThis as { chrome?: unknown }).chrome = {
	action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {} },
	alarms: { clear: () => {}, create: () => {} },
	runtime: { sendMessage: () => Promise.resolve() },
};

const { isUnlocked, setMasterUnlockKey, setDesktopModeSentinel } = await import(
	path.join(bgDir, "session-manager.ts")
);

beforeEach(() => {
	desktopStatus = null;
	lockAllAccountsCalls = 0;
});

describe("isUnlocked with a desktop app connected", () => {
	test("locks a locally unlocked extension when the desktop is locked", async () => {
		// A real MUK means standalone mode — the branch that used to skip the
		// desktop check entirely.
		setMasterUnlockKey(new Uint8Array(32).fill(7));
		desktopStatus = { available: true, locked: true };

		expect(isUnlocked()).toBe(false);
		// The lock is fired-and-forgotten, so let it settle before asserting.
		await Promise.resolve();
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
		await Promise.resolve();
		expect(lockAllAccountsCalls).toBe(1);
	});
});
