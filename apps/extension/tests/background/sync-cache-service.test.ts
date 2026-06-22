import { describe, expect, test } from "bun:test";
import type { SyncEvent } from "@bittery/sync";
import {
	createSyncCacheService,
	type SyncCacheDesktopClient,
	type SyncCacheStorage,
	type SyncEventQueryClient,
} from "../../src/background/services/sync-cache-service";

type ActiveAccount =
	| { type: "single"; accountId: string }
	| { type: "all" }
	| null;

type AccountInput =
	| string
	| { accountId: string; email: string; userId?: string };

function resolveAccount(input: AccountInput): {
	accountId: string;
	email: string;
	userId?: string;
} {
	if (typeof input === "string") {
		const email = input;
		return {
			accountId: `acc_${email.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
			email,
		};
	}
	return input;
}

function createClientStub(): SyncEventQueryClient {
	return {
		vault: {
			getItem: {
				query: async () => {
					throw new Error("not implemented in test");
				},
			},
			get: {
				query: async () => {
					throw new Error("not implemented in test");
				},
			},
		},
		sync: {
			getEventsSince: {
				query: async () => ({
					events: [],
					hasMore: false,
					requiresFullRefresh: false,
					cursor: null,
				}),
			},
		},
	} as SyncEventQueryClient;
}

function createStorageStub(input: {
	activeAccount: ActiveAccount;
	accounts: AccountInput[];
	tokensByAccountId: Record<string, string | undefined>;
	serverUrlsByAccountId?: Record<string, string | undefined>;
	vaultIdsByAccountId?: Record<string, string[] | undefined>;
	fallbackToken?: string | null;
}): SyncCacheStorage & { clearedAccountIds: string[] } {
	const resolvedAccounts = input.accounts.map(resolveAccount);
	const tokenMap = new Map<string, string>(
		Object.entries(input.tokensByAccountId)
			.filter(([, token]) => !!token)
			.map(([accountId, token]) => [accountId, token as string]),
	);
	const serverUrlMap = new Map<string, string>(
		Object.entries(input.serverUrlsByAccountId ?? {})
			.filter(([, serverUrl]) => !!serverUrl)
			.map(([accountId, serverUrl]) => [accountId, serverUrl as string]),
	);
	const vaultIdMap = new Map<string, string[]>(
		Object.entries(input.vaultIdsByAccountId ?? {}).map(
			([accountId, vaultIds]) => [accountId, vaultIds ?? []],
		),
	);
	const clearedAccountIds: string[] = [];

	return {
		supportsItemCache: true,
		clearedAccountIds,
		getActiveAccount: async () => input.activeAccount,
		getAccountsList: async () => resolvedAccounts,
		getAuthToken: async (accountId?: string) => {
			if (accountId) {
				return tokenMap.get(accountId) ?? null;
			}

			const active = input.activeAccount;
			if (active && active.type === "single") {
				return tokenMap.get(active.accountId) ?? null;
			}
			return input.fallbackToken ?? null;
		},
		storeAuthToken: async (token: string, accountId?: string) => {
			if (!accountId) {
				return;
			}
			tokenMap.set(accountId, token);
		},
		getServerUrl: async (accountId?: string) => {
			if (!accountId) {
				return null;
			}
			return serverUrlMap.get(accountId) ?? null;
		},
		getVaultKeys: async (accountId?: string) => {
			if (!accountId) {
				return null;
			}
			return (vaultIdMap.get(accountId) ?? []).map((vaultId) => ({
				vaultId,
			}));
		},
		clearItemCache: async (accountId?: string) => {
			if (accountId) {
				clearedAccountIds.push(accountId);
			}
		},
		getAccountMetadata: async (accountId: string) => {
			const account = resolvedAccounts.find(
				(candidate) => candidate.accountId === accountId,
			);
			return account ? { email: account.email } : undefined;
		},
	};
}

function createSyncEvent(partial?: Partial<SyncEvent>): SyncEvent {
	return {
		id: "evt_1",
		type: "item_updated",
		entityId: "item_1",
		entityType: "item",
		vaultId: "vault_1",
		version: 1,
		clientId: null,
		userId: "user_1",
		timestamp: 123456789,
		...partial,
	};
}

describe("sync-cache-service", () => {
	test("desktop-origin item changes apply account-scoped delta and clear desktop decrypt cache", async () => {
		const deltaCalls: Array<{
			eventType: SyncEvent["type"];
			accountEmail: string | undefined;
		}> = [];
		let desktopCacheClearCount = 0;

		const aliceAccountId = "acc_alice_example_com";
		const teamAccountId = "acc_team_example_com";

		const storage = createStorageStub({
			activeAccount: { type: "all" },
			accounts: [
				{ accountId: teamAccountId, email: "team@example.com" },
				{ accountId: aliceAccountId, email: "alice@example.com" },
			],
			tokensByAccountId: {
				[aliceAccountId]: "alice-token",
				[teamAccountId]: "team-token",
			},
			vaultIdsByAccountId: {
				[aliceAccountId]: ["vault_1"],
				[teamAccountId]: ["vault_9"],
			},
		});

		const desktop: SyncCacheDesktopClient = {
			getAuthToken: async () => null,
			clearCache: () => {
				desktopCacheClearCount++;
			},
		};

		const service = createSyncCacheService({
			storage,
			desktopClient: desktop,
			defaultClient: createClientStub(),
			createAccountClient: () => createClientStub(),
			deltaSync: async (_client, _cache, event, accountEmail) => {
				deltaCalls.push({
					eventType: event.type,
					accountEmail,
				});
			},
			logger: console,
		});

		await service.applyDeltaSyncForEvent(
			createSyncEvent({
				type: "item_updated",
				vaultId: "vault_1",
			}),
		);

		expect(deltaCalls).toHaveLength(1);
		expect(deltaCalls[0]).toEqual({
			eventType: "item_updated",
			accountEmail: "alice@example.com",
		});
		expect(desktopCacheClearCount).toBe(1);
	});

	test("non-desktop mode resolves connection context from local token deterministically", async () => {
		const bobAccountId = "acc_bob_example_com";

		const storage = createStorageStub({
			activeAccount: { type: "single", accountId: bobAccountId },
			accounts: [
				{ accountId: "acc_z_example_com", email: "z@example.com" },
				{ accountId: bobAccountId, email: "bob@example.com" },
			],
			tokensByAccountId: {
				[bobAccountId]: "local-token",
			},
			serverUrlsByAccountId: {
				[bobAccountId]: "https://api.example.com",
			},
		});

		const service = createSyncCacheService({
			storage,
			desktopClient: {
				getAuthToken: async () => null,
				clearCache: () => {},
			},
			defaultClient: createClientStub(),
			createAccountClient: () => createClientStub(),
			deltaSync: async () => {},
			logger: console,
		});

		const context = await service.resolveConnectionContext();
		expect(context).toEqual({
			email: "bob@example.com",
			serverUrl: "https://api.example.com",
			token: "local-token",
		});
	});

	test("falls back to global cache update when account-scoped clients are unavailable", async () => {
		const deltaCalls: Array<string | undefined> = [];
		const accountAId = "acc_a_example_com";
		const accountBId = "acc_b_example_com";

		const storage = createStorageStub({
			activeAccount: { type: "all" },
			accounts: [
				{ accountId: accountBId, email: "b@example.com" },
				{ accountId: accountAId, email: "a@example.com" },
			],
			tokensByAccountId: {},
			vaultIdsByAccountId: {
				[accountAId]: ["vault_1"],
				[accountBId]: ["vault_1"],
			},
			fallbackToken: "fallback-token",
		});

		const service = createSyncCacheService({
			storage,
			desktopClient: {
				getAuthToken: async () => null,
				clearCache: () => {},
			},
			defaultClient: createClientStub(),
			createAccountClient: () => createClientStub(),
			deltaSync: async (_client, _cache, _event, accountEmail) => {
				deltaCalls.push(accountEmail);
			},
			logger: console,
		});

		await service.applyDeltaSyncForEvent(createSyncEvent());

		// Both account-scoped attempts fail token resolution, then one global fallback run.
		expect(deltaCalls).toEqual([undefined]);
		expect(storage.clearedAccountIds).toEqual([accountBId, accountAId]);
	});

	test("travel_mode_updated invokes travel mode handler only for matching account", async () => {
		const deltaCalls: string[] = [];
		const travelModeCalls: string[] = [];

		const aliceAccountId = "acc_alice";
		const teamAccountId = "acc_team";

		const storage = createStorageStub({
			activeAccount: { type: "all" },
			accounts: [
				{
					accountId: aliceAccountId,
					email: "alice@example.com",
					userId: "user_alice",
				},
				{
					accountId: teamAccountId,
					email: "team@example.com",
					userId: "user_team",
				},
			],
			tokensByAccountId: {
				[aliceAccountId]: "alice-token",
				[teamAccountId]: "team-token",
			},
		});

		const service = createSyncCacheService({
			storage,
			desktopClient: {
				getAuthToken: async () => null,
				clearCache: () => {},
			},
			defaultClient: createClientStub(),
			createAccountClient: () => createClientStub(),
			deltaSync: async (_client, _cache, event, accountEmail) => {
				deltaCalls.push(`${event.type}:${accountEmail ?? "global"}`);
			},
			handleTravelModeSync: async (_event, accountId) => {
				travelModeCalls.push(accountId);
			},
			logger: console,
		});

		await service.applyDeltaSyncForEvent(
			createSyncEvent({
				type: "travel_mode_updated",
				entityType: "user",
				entityId: "user_alice",
				userId: "user_alice",
				vaultId: null,
				metadata: { enabled: true, hiddenVaultIds: ["vault_hidden"] },
			}),
		);

		expect(travelModeCalls).toEqual([aliceAccountId]);
		expect(deltaCalls).toEqual([]);
	});
});
