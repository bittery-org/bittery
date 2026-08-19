/// <reference types="bun" />
/**
 * Desktop's first TypeScript tests.
 *
 * `auth-server.ts` is 189 lines of multi-server bookkeeping — a bounded recency
 * list, a localStorage mirror, a listener set, and a four-step resolution order —
 * and it had none, while its 29-line web sibling did. It is also the module that
 * decides which server a sign-in talks to, so getting the resolution order wrong
 * points a credential at the wrong host.
 *
 * `storage` is stubbed rather than faked out of the module: it is the Tauri
 * `AccountStore`, which cannot load outside a Tauri window.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

interface AccountRecord {
	accountId: string;
}

const accounts: AccountRecord[] = [];
const serverUrlByAccount = new Map<string, string>();
let activeAccount: string | null = null;
const storedServerUrlWrites: Array<[string, string]> = [];

mock.module("./storage", () => ({
	storage: {
		getActiveAccount: async () => activeAccount,
		getAccountsList: async () => accounts,
		getServerUrl: async (accountId: string) =>
			serverUrlByAccount.get(accountId) ?? null,
		storeServerUrl: async (serverUrl: string, accountId: string) => {
			storedServerUrlWrites.push([accountId, serverUrl]);
			serverUrlByAccount.set(accountId, serverUrl);
		},
	},
}));

const localStorageBacking = new Map<string, string>();
Object.defineProperty(globalThis, "window", {
	configurable: true,
	value: {
		localStorage: {
			getItem: (key: string) => localStorageBacking.get(key) ?? null,
			setItem: (key: string, value: string) => {
				localStorageBacking.set(key, value);
			},
			removeItem: (key: string) => {
				localStorageBacking.delete(key);
			},
		},
	},
});

const {
	readCurrentAuthServerUrl,
	readKnownServerUrls,
	rememberServerUrl,
	resolveActiveAuthServerUrl,
	setActiveAuthServerUrl,
	subscribeActiveAuthServerUrl,
} = await import("./auth-server");

const KNOWN_KEY = "bittery_known_auth_servers";
const ACTIVE_KEY = "bittery_active_auth_server";

beforeEach(() => {
	localStorageBacking.clear();
	accounts.length = 0;
	serverUrlByAccount.clear();
	storedServerUrlWrites.length = 0;
	activeAccount = null;
});

describe("known server list", () => {
	test("keeps most-recent-first order without duplicating an entry", () => {
		rememberServerUrl("https://one.example");
		rememberServerUrl("https://two.example");
		rememberServerUrl("https://one.example");

		expect(readKnownServerUrls()).toEqual([
			"https://one.example",
			"https://two.example",
		]);
	});

	test("caps the list at ten and drops the oldest", () => {
		for (let index = 0; index < 12; index++) {
			rememberServerUrl(`https://server-${index}.example`);
		}

		const known = readKnownServerUrls();
		expect(known).toHaveLength(10);
		expect(known[0]).toBe("https://server-11.example");
		expect(known).not.toContain("https://server-0.example");
		expect(known).not.toContain("https://server-1.example");
	});

	test("ignores an unusable URL rather than storing it", () => {
		rememberServerUrl("https://good.example");
		rememberServerUrl("ftp://bad.example");

		expect(readKnownServerUrls()).toEqual(["https://good.example"]);
	});

	test("survives a corrupted localStorage value", () => {
		localStorageBacking.set(KNOWN_KEY, "{not json");
		expect(readKnownServerUrls()).toEqual([]);
	});

	test("drops non-string and unusable entries when reading", () => {
		localStorageBacking.set(
			KNOWN_KEY,
			JSON.stringify(["https://good.example", 42, null, "ftp://bad.example"]),
		);
		expect(readKnownServerUrls()).toEqual(["https://good.example"]);
	});
});

describe("setting the active server", () => {
	test("rejects an unusable URL without writing anything", async () => {
		expect(await setActiveAuthServerUrl("ftp://bad.example")).toBeNull();
		expect(localStorageBacking.has(ACTIVE_KEY)).toBe(false);
		expect(storedServerUrlWrites).toEqual([]);
	});

	test("writes through to the active account and remembers the URL", async () => {
		activeAccount = "account-1";

		expect(await setActiveAuthServerUrl("https://one.example")).toBe(
			"https://one.example",
		);
		expect(storedServerUrlWrites).toEqual([
			["account-1", "https://one.example"],
		]);
		expect(readCurrentAuthServerUrl()).toBe("https://one.example");
		expect(readKnownServerUrls()).toContain("https://one.example");
	});

	test("still sets the active URL when no account is signed in", async () => {
		expect(await setActiveAuthServerUrl("https://one.example")).toBe(
			"https://one.example",
		);
		expect(storedServerUrlWrites).toEqual([]);
		expect(readCurrentAuthServerUrl()).toBe("https://one.example");
	});

	test("notifies subscribers, and stops after unsubscribe", async () => {
		const seen: string[] = [];
		const unsubscribe = subscribeActiveAuthServerUrl((url) => seen.push(url));

		await setActiveAuthServerUrl("https://one.example");
		unsubscribe();
		await setActiveAuthServerUrl("https://two.example");

		expect(seen).toEqual(["https://one.example"]);
	});
});

describe("resolving the active server", () => {
	test("prefers the active account's own server over the stored active URL", async () => {
		localStorageBacking.set(ACTIVE_KEY, "https://stale.example");
		activeAccount = "account-1";
		serverUrlByAccount.set("account-1", "https://account.example");

		expect(await resolveActiveAuthServerUrl()).toBe("https://account.example");
		expect(readCurrentAuthServerUrl()).toBe("https://account.example");
	});

	test("falls back to the stored active URL when the account has none", async () => {
		localStorageBacking.set(ACTIVE_KEY, "https://stored.example");
		activeAccount = "account-1";

		expect(await resolveActiveAuthServerUrl()).toBe("https://stored.example");
	});

	/**
	 * The documented reason this branch exists: after a restart or a sign-out
	 * there is no active account and no active URL, and jumping to the build
	 * default would silently point the sign-in at the wrong server for anyone
	 * self-hosting.
	 */
	test("falls back to the first account that has a server, not the build default", async () => {
		accounts.push({ accountId: "no-server" }, { accountId: "has-server" });
		serverUrlByAccount.set("has-server", "https://self-hosted.example");

		expect(await resolveActiveAuthServerUrl()).toBe(
			"https://self-hosted.example",
		);
		expect(readKnownServerUrls()).toContain("https://self-hosted.example");
	});

	test("uses the build default only when nothing else is known", async () => {
		const resolved = await resolveActiveAuthServerUrl();

		expect(resolved).toBe("http://localhost:3000");
		expect(localStorageBacking.get(ACTIVE_KEY)).toBe("http://localhost:3000");
	});

	test("ignores an account whose stored server URL is unusable", async () => {
		accounts.push({ accountId: "bad" }, { accountId: "good" });
		serverUrlByAccount.set("bad", "ftp://bad.example");
		serverUrlByAccount.set("good", "https://good.example");

		expect(await resolveActiveAuthServerUrl()).toBe("https://good.example");
	});
});
