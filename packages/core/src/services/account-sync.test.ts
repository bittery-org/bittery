import { describe, expect, test } from "bun:test";
import type { AccountStore, ItemCache } from "@bittery/storage";
import type { AccountMetadata } from "@bittery/storage/types";
import { NO_CREDENTIAL_MIRROR } from "./account-lifecycle";
import type { DefaultApiClient } from "./account-resolver";
import { createAccountSync } from "./account-sync";
import type { VaultRepository } from "./vault-repository";

const semanticDeps = { crypto: {} as never, vaultCrypto: {} as never };

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
		getUnlockedAccounts: async () => (activeAccount ? [activeAccount] : []),
		onUnlockStateChanged: () => () => undefined,
	} as unknown as AccountStore;
	const itemCache = {
		initialize: async () => undefined,
	} as unknown as ItemCache;
	const vaultRepository = {
		openAccounts: async () => undefined,
	} as unknown as VaultRepository;
	return { storage, itemCache, vaultRepository };
}

describe("account-aware Sync assembly", () => {
	test("disables Sync when no account is active", async () => {
		const { storage, itemCache, vaultRepository } = makeDependencies(null);
		const sync = createAccountSync({
			...semanticDeps,
			vaultRepository,
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
		const { storage, itemCache, vaultRepository } = makeDependencies();
		const sync = createAccountSync({
			...semanticDeps,
			vaultRepository,
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
		const { storage, itemCache, vaultRepository } = makeDependencies();
		const clientRequests: Array<[string, string]> = [];
		const apiClient = { marker: "alice" } as unknown as DefaultApiClient;
		const sync = createAccountSync({
			...semanticDeps,
			vaultRepository,
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

		expect(assembly?.sources).toHaveLength(1);
		expect(assembly?.sources[0]).toMatchObject({
			serverUrl: "https://vault.example/",
			itemCacheAccountId: alice.accountId,
			itemCacheAccountEmail: alice.email,
			itemCacheServerUrl: "https://vault.example/",
		});
		expect(await assembly?.sources[0]?.getAuthToken()).toBe("alice-token");
		expect(await assembly?.getClientForAccount(alice.accountId)).toBe(
			apiClient,
		);
		expect(clientRequests.every((request) => request[1] === "device_1")).toBe(
			true,
		);
	});

	test("reuses an unchanged assembly so platform polling does not reconnect", async () => {
		const { storage, itemCache, vaultRepository } = makeDependencies();
		const sync = createAccountSync({
			...semanticDeps,
			vaultRepository,
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

	test("initializes its platform stores only once", async () => {
		const { storage, itemCache, vaultRepository } = makeDependencies();
		let storageInitializations = 0;
		let cacheInitializations = 0;
		storage.initialize = async () => {
			storageInitializations++;
		};
		itemCache.initialize = async () => {
			cacheInitializations++;
		};
		const sync = createAccountSync({
			...semanticDeps,
			vaultRepository,
			lifecycle: {
				storage,
				itemCache,
				credentialMirror: NO_CREDENTIAL_MIRROR,
			},
			clientFactory: async () => ({}) as DefaultApiClient,
		});

		await sync.assemble({ clientId: "device_1" });
		await sync.assemble({ clientId: "device_1" });

		expect(storageInitializations).toBe(1);
		expect(cacheInitializations).toBe(1);
	});
});
