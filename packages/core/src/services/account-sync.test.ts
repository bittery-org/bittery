import { describe, expect, test } from "bun:test";
import type { CryptoPort } from "@bittery/crypto-port";
import type { AccountStore, ItemCache } from "@bittery/storage";
import type { AccountMetadata } from "@bittery/storage/types";
import { NO_CREDENTIAL_MIRROR } from "./account-lifecycle";
import type { DefaultApiClient } from "./account-resolver";
import { createAccountSync } from "./account-sync";

const alice: AccountMetadata = {
	accountId: "account_alice",
	email: "alice@example.com",
	userId: "user_alice",
	name: "Alice",
	serverUrl: "https://vault.example",
	secretKeyHint: "hint",
	addedAt: 1,
	lastActiveAt: 1,
	biometricEnabled: false,
	insecureTransportConfirmed: false,
};

function makeDependencies(activeAccount: string | null = alice.accountId) {
	const storage = {
		platform: "web",
		initialize: async () => undefined,
		getActiveAccount: async () => activeAccount,
		getAccountMetadata: async (accountId: string) =>
			accountId === alice.accountId ? alice : null,
		getServerUrl: async (accountId?: string) =>
			accountId === alice.accountId ? "https://vault.example/" : null,
		getAuthToken: async (accountId?: string) =>
			accountId === alice.accountId ? "alice-token" : null,
		onUnlockStateChanged: () => () => undefined,
	} as unknown as AccountStore;
	const itemCache = {
		initialize: async () => undefined,
	} as unknown as ItemCache;
	return { storage, itemCache };
}

describe("account-aware Sync assembly", () => {
	test("disables Sync when no account is active", async () => {
		const { storage, itemCache } = makeDependencies(null);
		const sync = createAccountSync({
			crypto: {} as CryptoPort,
			lifecycle: {
				storage,
				itemCache,
				credentialMirror: NO_CREDENTIAL_MIRROR,
			},
			clientFactory: async () => {
				throw new Error("must not create an unscoped client");
			},
		});

		expect(await sync.assemble({ clientId: "device_1" })).toBeNull();
	});

	test("disables Sync when the active account has no authenticated client", async () => {
		const { storage, itemCache } = makeDependencies();
		const sync = createAccountSync({
			crypto: {} as CryptoPort,
			lifecycle: {
				storage,
				itemCache,
				credentialMirror: NO_CREDENTIAL_MIRROR,
			},
			clientFactory: async () => null,
		});

		expect(await sync.assemble({ clientId: "device_1" })).toBeNull();
	});

	test("assembles one account-scoped source and queue client policy", async () => {
		const { storage, itemCache } = makeDependencies();
		const clientRequests: Array<[string, string]> = [];
		const apiClient = { marker: "alice" } as unknown as DefaultApiClient;
		const sync = createAccountSync({
			crypto: {} as CryptoPort,
			lifecycle: {
				storage,
				itemCache,
				credentialMirror: NO_CREDENTIAL_MIRROR,
			},
			clientFactory: async (accountId, clientId) => {
				clientRequests.push([accountId, clientId]);
				return accountId === alice.accountId ? apiClient : null;
			},
		});

		const assembly = await sync.assemble({ clientId: "device_1" });

		expect(assembly?.serverUrl).toBe("https://vault.example/");
		expect(assembly?.sources).toHaveLength(1);
		expect(assembly?.sources[0]).toMatchObject({
			serverUrl: "https://vault.example/",
			itemCacheAccountId: alice.accountId,
			itemCacheAccountEmail: alice.email,
			itemCacheServerUrl: "https://vault.example/",
		});
		expect(await assembly?.getAuthToken()).toBe("alice-token");
		expect(await assembly?.getClientForAccount(alice.accountId)).toBe(
			apiClient,
		);
		expect(clientRequests).toEqual([
			[alice.accountId, "device_1"],
			[alice.accountId, "device_1"],
		]);
	});

	test("reuses an unchanged assembly so platform polling does not reconnect", async () => {
		const { storage, itemCache } = makeDependencies();
		const sync = createAccountSync({
			crypto: {} as CryptoPort,
			lifecycle: {
				storage,
				itemCache,
				credentialMirror: NO_CREDENTIAL_MIRROR,
			},
			clientFactory: async () => ({}) as DefaultApiClient,
		});

		const first = await sync.assemble({ clientId: "device_1" });
		const second = await sync.assemble({ clientId: "device_1" });

		expect(second).toBe(first);
	});
});
