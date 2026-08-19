import { beforeEach, describe, expect, mock, test } from "bun:test";
import path from "node:path";

// Regression coverage for the inline autofill menu's locked state. The bug: when
// a connected desktop app held the lock, the menu offered "Open Bittery", which
// opens the extension popup — a surface that cannot unlock the desktop. Users
// unlocked the extension there and the desktop stayed locked behind it.
// `CHECK_AUTOFILL_AUTH` now reports which side is locked so the overlay can send
// the user to the desktop app instead.

const bgDir = path.resolve(import.meta.dir, "../../src/background");
const libDir = path.resolve(import.meta.dir, "../../src/lib");

let desktopStatus: {
	available: boolean;
	locked: boolean;
	unlockedAccounts?: string[];
} | null = null;

mock.module(path.join(bgDir, "desktop-sync.ts"), () => ({
	getDesktopSync: () => ({
		getLastStatus: () => desktopStatus,
		checkDesktopStatus: async () => desktopStatus,
	}),
}));

let extensionUnlocked = false;

mock.module(path.join(bgDir, "session-manager.ts"), () => ({
	getLastActivityTimestamp: () => Date.now(),
	isUnlocked: () => extensionUnlocked,
	setDesktopModeSentinel: () => {
		extensionUnlocked = true;
	},
	updateActivity: () => {},
}));

mock.module(path.join(libDir, "storage.ts"), () => ({
	storage: {
		isAuthenticated: async () => true,
	},
}));

mock.module(path.join(bgDir, "vault-utils.ts"), () => ({
	getDecryptedItemsForCurrentMode: async () => [],
}));

const { handleCheckAutofillAuth } = await import(
	path.join(bgDir, "autofill-handlers.ts")
);

beforeEach(() => {
	desktopStatus = null;
	extensionUnlocked = false;
});

describe("handleCheckAutofillAuth", () => {
	test("flags a connected-but-locked desktop as the thing holding the lock", async () => {
		desktopStatus = { available: true, locked: true };

		const response = await handleCheckAutofillAuth();

		expect(response).toEqual({
			success: true,
			authenticated: false,
			unlocked: false,
			desktopLocked: true,
		});
	});

	test("does not flag the desktop when the extension is locked on its own", async () => {
		desktopStatus = null;

		const response = await handleCheckAutofillAuth();

		expect(response.authenticated).toBe(false);
		expect(response.desktopLocked).toBe(false);
	});

	test("does not flag the desktop when it is present but unlocked", async () => {
		// A locked extension alongside an unlocked desktop is the service-worker
		// restart case: the sentinel is re-seeded rather than prompting at all.
		desktopStatus = {
			available: true,
			locked: false,
			unlockedAccounts: ["acc-1"],
		};

		const response = await handleCheckAutofillAuth();

		expect(response.authenticated).toBe(true);
		expect(response.unlocked).toBe(true);
	});
});
