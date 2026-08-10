import { beforeEach, describe, expect, mock, test } from "bun:test";
import path from "node:path";

// Acceptance coverage for "a popup-initiated lock provably stops autofill".
// The router seam is the only boundary where that is provable here: the popup's
// own `AccountStore` MUK cache is per-context (packages/storage/CONTEXT.md §4.5),
// so locking there left the service worker — the context autofill actually reads
// — unlocked. These cases drive the real `LOCK` route end to end.

const bgDir = path.resolve(import.meta.dir, "../../src/background");
const libDir = path.resolve(import.meta.dir, "../../src/lib");

/** `null` means the native host did not answer, i.e. no desktop app. */
let desktopStatus: {
	available: boolean;
	locked: boolean;
	unlockedAccounts?: string[];
} | null = null;

let lockAllAccountsCalls = 0;
const syncDisconnects: string[] = [];

const ACCOUNTS = [{ accountId: "acc-1", email: "a@example.com" }];
const RESTORED_MUK = new Uint8Array(32).fill(7);

mock.module(path.join(libDir, "storage.ts"), () => ({
	DEFAULT_AUTO_LOCK_TIMEOUT_MS: 10 * 60 * 1000,
	initializeStorage: async () => {},
	storage: {
		getAccountsList: async () => ACCOUNTS,
		getActiveAccount: async () => "acc-1",
		getAuthToken: async () => "token",
		getServerUrl: async () => "http://localhost:3000",
		isAuthenticated: async () => true,
		getMasterUnlockKey: async () => RESTORED_MUK,
		getAutoLockTimeout: async () => 10 * 60 * 1000,
		getAutoLockTimeoutOrDefault: async () => 10 * 60 * 1000,
		lockAllAccounts: async () => {
			lockAllAccountsCalls++;
		},
		// The vault repositories follow this to drop their plaintext on lock; this test
		// never locks through the store, so the subscription only has to exist.
		onUnlockStateChanged: () => () => {},
	},
	itemCache: {
		clearItemCache: async () => {},
	},
}));

mock.module(path.join(bgDir, "desktop-sync.ts"), () => ({
	desktopSync: {
		getLastStatus: () => desktopStatus,
		checkDesktopStatus: async () => desktopStatus,
		isDesktopAvailable: () => desktopStatus !== null,
		initialize: async () => {},
	},
}));

// Recorded rather than executed so a lock that never happened cannot silently
// tear the SSE stream down.
mock.module(path.join(bgDir, "sync-manager.ts"), () => ({
	connect: async () => {},
	cleanupSync: async () => {},
	disconnect: (reason: string) => {
		syncDisconnects.push(reason);
	},
	getClientId: async () => "client-1",
	getStatus: () => "disconnected",
	initializeSync: async () => {},
	handleSyncReconnectAlarm: async () => {},
}));

// A cold worker restores its unlocked accounts from storage before any message
// is routed; the key it reports is what bootstrap hands the vault session.
let restoreCalls = 0;
mock.module(path.join(bgDir, "services/session-restore.ts"), () => ({
	restoreUnlockedSessions: async () => {
		restoreCalls++;
		return { accountIds: ["acc-1"], muk: RESTORED_MUK };
	},
}));

(globalThis as { chrome?: unknown }).chrome = {
	action: {
		setIcon: () => {},
		setBadgeText: () => {},
		setBadgeBackgroundColor: () => {},
	},
	alarms: {
		clear: () => {},
		create: () => {},
	},
	runtime: {
		getURL: (value: string) => value,
		sendMessage: () => Promise.resolve(),
	},
};

const { routeRuntimeMessage } = await import(
	path.join(bgDir, "router/index.ts")
);
const { handleCheckAutofillAuth } = await import(
	path.join(bgDir, "autofill-handlers.ts")
);
const { isUnlocked, setMasterUnlockKey } = await import(
	path.join(bgDir, "session-manager.ts")
);
const { setSyncPort } = await import(
	path.join(bgDir, "vault-session/index.ts")
);
const { initializeBackgroundServices } = await import(
	path.join(bgDir, "services/service-worker-lifecycle.ts")
);

// Mirrors sync-manager's own module-scope registration, which the mock above
// replaces — without it the reducer's `disconnect_sync` effect goes nowhere.
setSyncPort({
	disconnect: (reason) => {
		syncDisconnects.push(reason);
	},
});

/** Locks are fired-and-forgotten from `isUnlocked`; let the chain settle. */
async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(async () => {
	// The vault-session machine is a module singleton, so every test starts from
	// an explicitly locked, desktop-free world rather than the previous state.
	desktopStatus = null;
	await routeRuntimeMessage({ type: "LOCK" });
	await settle();
	lockAllAccountsCalls = 0;
	syncDisconnects.length = 0;
	restoreCalls = 0;
});

describe("LOCK route without a desktop app", () => {
	test("locks the service worker and stops autofill", async () => {
		setMasterUnlockKey(new Uint8Array(32).fill(3));
		expect(isUnlocked()).toBe(true);

		const response = await routeRuntimeMessage({ type: "LOCK" });

		expect(response).toEqual({ success: true });
		expect(isUnlocked()).toBe(false);
		// The context autofill actually reads must agree, not just the popup's.
		expect(await handleCheckAutofillAuth()).toMatchObject({
			unlocked: false,
			authenticated: false,
		});
		expect(lockAllAccountsCalls).toBe(1);
		expect(syncDisconnects).toEqual(["manual"]);
	});
});

describe("LOCK route with the desktop app reachable", () => {
	test("refuses with a code and leaves the session and its sync stream alone", async () => {
		desktopStatus = {
			available: true,
			locked: false,
			unlockedAccounts: ["acc-1"],
		};
		setMasterUnlockKey(new Uint8Array(32).fill(3));
		// What the popup's session-status poll does; it is what makes the machine
		// observe the desktop before the click arrives.
		expect(
			await routeRuntimeMessage({ type: "GET_SESSION_STATUS" }),
		).toMatchObject({ unlocked: true });

		const response = await routeRuntimeMessage({ type: "LOCK" });

		expect(response).toEqual({ success: false, code: "desktop_owns_lock" });
		expect(isUnlocked()).toBe(true);
		expect(lockAllAccountsCalls).toBe(0);
		// The regression the deleted `before` hook caused: a refused lock killed
		// the SSE stream anyway.
		expect(syncDisconnects).toEqual([]);
	});
});

describe("LOCK route on a cold service worker", () => {
	test("locks a session that bootstrap had just restored", async () => {
		await initializeBackgroundServices();

		expect(restoreCalls).toBe(1);
		expect(isUnlocked()).toBe(true);

		const response = await routeRuntimeMessage({ type: "LOCK" });

		expect(response).toEqual({ success: true });
		expect(isUnlocked()).toBe(false);
		expect(await handleCheckAutofillAuth()).toMatchObject({ unlocked: false });
		expect(lockAllAccountsCalls).toBe(1);
	});
});
