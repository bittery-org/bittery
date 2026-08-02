import { beforeEach, describe, expect, mock, test } from "bun:test";
import path from "node:path";

// Regression coverage for packages/storage/CONTEXT.md §4.3.
//
// `AccountStore.getUnlockedAccounts()` reports which accounts hold a master unlock key in
// memory. MV3 empties that in-memory cache on every service-worker recycle, so the restore
// has to happen explicitly at startup — otherwise autofill silently stops working after a
// recycle.
//
// The two restart cases behave differently on purpose:
//   - service-worker restart: `chrome.storage.session` survives, so `jwt_token` is still
//     there, the session is valid and the MUK is restored from device-bound `session_data`.
//   - browser restart: `chrome.storage.session` is cleared, so there is no `jwt_token`,
//     the session is not valid and NOTHING is restored. Reporting "unlocked" here would be
//     a lie.

const bgDir = path.resolve(import.meta.dir, "../../src/background");
const libDir = path.resolve(import.meta.dir, "../../src/lib");

const ACCOUNT_A = "acc-a";
const ACCOUNT_B = "acc-b";

/** Session-bound values (`chrome.storage.session`); cleared by a browser restart. */
let sessionScope: Record<string, string> = {};
/** In-memory master unlock keys; cleared by every service-worker restart. */
let mukCache = new Map<string, Uint8Array>();

mock.module(path.join(libDir, "storage.ts"), () => ({
	storage: {
		getAccountsList: async () => [
			{ accountId: ACCOUNT_A, email: "a@example.com" },
			{ accountId: ACCOUNT_B, email: "b@example.com" },
		],
		// Mirrors `AccountStore`: valid only while the session-bound token is present.
		isSessionValid: async (accountId: string) =>
			sessionScope[`${accountId}:jwt_token`] !== undefined,
		// Mirrors `AccountStore`: decrypts the MUK out of device-bound `session_data`,
		// but only for a session that is still valid.
		tryRestoreSession: async (_skipBiometric: boolean, accountId: string) => {
			if (sessionScope[`${accountId}:jwt_token`] === undefined) {
				return false;
			}
			mukCache.set(accountId, new Uint8Array([1, 2, 3]));
			return true;
		},
		getUnlockedAccounts: async () => [...mukCache.keys()],
		getMasterUnlockKey: async (accountId: string) =>
			mukCache.get(accountId) ?? null,
	},
	itemCache: {
		clearItemCache: async () => {},
	},
}));

mock.module("@bittery/core/services/account-session-manager", () => ({
	peekAccountSessionManager: () => null,
	getAccountSessionManager: ({
		storage,
	}: {
		storage: {
			tryRestoreSession: (
				skipBiometric: boolean,
				accountId: string,
			) => Promise<boolean>;
		};
	}) => ({
		unlockAccount: (accountId: string, skipBiometric = false) =>
			storage.tryRestoreSession(skipBiometric, accountId),
	}),
}));

const { restoreUnlockedSessions } = await import(
	path.join(bgDir, "services/session-restore.ts")
);

beforeEach(() => {
	mukCache = new Map();
});

describe("restoreUnlockedSessions", () => {
	test("service-worker restart: chrome.storage.session survived, so every account is restored", async () => {
		// A service-worker recycle empties `mukCache` but leaves the session scope alone.
		sessionScope = {
			[`${ACCOUNT_A}:jwt_token`]: "token-a",
			[`${ACCOUNT_B}:jwt_token`]: "token-b",
		};

		const restored = await restoreUnlockedSessions();

		expect(restored.accountIds).toEqual([ACCOUNT_A, ACCOUNT_B]);
		expect([...mukCache.keys()]).toEqual([ACCOUNT_A, ACCOUNT_B]);
		// The device-wide key is reported, not installed: bootstrap hands it to the
		// vault session together with the accounts, in one atomic event.
		expect(restored.muk).toEqual(new Uint8Array([1, 2, 3]));
	});

	test("browser restart: chrome.storage.session is gone, so nothing is restored or claimed", async () => {
		sessionScope = {};

		const restored = await restoreUnlockedSessions();

		expect(restored.accountIds).toEqual([]);
		expect([...mukCache.keys()]).toEqual([]);
		expect(restored.muk).toBeNull();
	});

	test("partial restore: only the account whose session survived comes back", async () => {
		sessionScope = { [`${ACCOUNT_B}:jwt_token`]: "token-b" };

		const restored = await restoreUnlockedSessions();

		expect(restored.accountIds).toEqual([ACCOUNT_B]);
		expect(restored.muk).toEqual(new Uint8Array([1, 2, 3]));
	});
});
