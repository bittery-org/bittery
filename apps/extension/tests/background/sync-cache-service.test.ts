import { describe, expect, test } from "bun:test";
import type { ActiveAccountId } from "@bittery/storage/types";
import type {
	ItemCommandProjection,
	SemanticItemCommandExecutor,
	SyncEvent,
	SyncOrchestratorReplica,
} from "@bittery/sync";

type SyncTestReplica = SyncOrchestratorReplica &
	ItemCommandProjection &
	SemanticItemCommandExecutor;

import {
	createSyncCacheService,
	type SyncCacheDesktopClient,
	type SyncCacheStorage,
	type SyncEventApiClient,
} from "../../src/background/services/sync-cache-service";

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

function createClientStub(): SyncEventApiClient {
	return {} as SyncEventApiClient;
}

function createStorageStub(input: {
	activeAccount: ActiveAccountId;
	accounts: AccountInput[];
	tokensByAccountId: Record<string, string | undefined>;
	serverUrlsByAccountId?: Record<string, string | undefined>;
	vaultIdsByAccountId?: Record<string, string[] | undefined>;
	fallbackToken?: string | null;
}): SyncCacheStorage {
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
	return {
		getActiveAccount: async () => input.activeAccount,
		getAccountsList: async () => resolvedAccounts,
		getAuthToken: async (accountId?: string) => {
			if (accountId) {
				return tokenMap.get(accountId) ?? null;
			}

			const active = input.activeAccount;
			if (active) {
				return tokenMap.get(active) ?? null;
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
		getAccountMetadata: async (accountId: string) => {
			const account = resolvedAccounts.find(
				(candidate) => candidate.accountId === accountId,
			);
			return account ? { email: account.email } : null;
		},
	};
}

/**
 * Stands in for `VaultRepository`. Clearing the cache is `ItemCache`'s job —
 * `AccountStore` cannot reach the record port at all.
 */
function createItemCacheStub(): SyncTestReplica & {
	clearedAccountIds: string[];
} {
	const clearedAccountIds: string[] = [];
	return {
		clearedAccountIds,
		upsertCachedItem: async () => {},
		removeCachedItem: async () => {},
		upsertCachedVault: async () => {},
		removeCachedVault: async () => {},
		syncVaultKeys: async () => {},
		replaceItemId: () => {},
		applyItemCommand: async () => {},
		executeSemanticItemCommand: async () => undefined,
		discardItemCommandAcknowledgedElsewhere: async () => {},
		preserveItemConflict: async () => undefined,
		acknowledgeItemCommand: async () => {},
		setEncryptionContextMigrationPort: async () => {},
		clearItemCache: async (accountId?: string) => {
			if (accountId) {
				clearedAccountIds.push(accountId);
			}
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
	test("delegates full refresh to staged repository promotion", async () => {
		let stagedRefreshCount = 0;
		const service = createSyncCacheService({
			storage: createStorageStub({
				activeAccount: "acc_alice",
				accounts: [{ accountId: "acc_alice", email: "alice@example.com" }],
				tokensByAccountId: { acc_alice: "token" },
			}),
			itemCache: createItemCacheStub(),
			desktopClient: {
				getAuthToken: async () => null,
				clearCache: () => {},
			},
			createAccountClient: () => createClientStub(),
			deltaSync: async () => {},
			refreshFromServer: async () => {
				stagedRefreshCount++;
			},
			logger: console,
		});

		await service.refreshItemCachesForKnownAccounts();

		expect(stagedRefreshCount).toBe(1);
	});

	test("desktop-origin item changes apply account-scoped delta and clear desktop decrypt cache", async () => {
		const deltaCalls: Array<{
			eventType: SyncEvent["type"];
			accountScope: string | undefined;
			accountEmail: string | null | undefined;
		}> = [];
		let desktopCacheClearCount = 0;

		const aliceAccountId = "acc_alice_example_com";
		const teamAccountId = "acc_team_example_com";

		const storage = createStorageStub({
			activeAccount: null,
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
			itemCache: createItemCacheStub(),
			desktopClient: desktop,
			createAccountClient: () => createClientStub(),
			deltaSync: async (
				_client,
				_cache,
				event,
				accountScope,
				_serverUrl,
				accountEmail,
			) => {
				deltaCalls.push({
					eventType: event.type,
					accountScope,
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
		// The cache scope must be the accountId, not the email.
		expect(deltaCalls[0]).toEqual({
			eventType: "item_updated",
			accountScope: aliceAccountId,
			accountEmail: "alice@example.com",
		});
		expect(desktopCacheClearCount).toBe(1);
	});

	test("hands a fetched Operation outcome to the account's durable queue", async () => {
		const reconciled: string[] = [];
		const accountId = "acc_alice";
		const service = createSyncCacheService({
			storage: createStorageStub({
				activeAccount: accountId,
				accounts: [
					{ accountId, email: "alice@example.com", userId: "user_alice" },
				],
				tokensByAccountId: { [accountId]: "token" },
			}),
			itemCache: createItemCacheStub(),
			desktopClient: {
				getAuthToken: async () => null,
				clearCache: () => {},
			},
			createAccountClient: () => createClientStub(),
			deltaSync: async () => ({
				operationId: "operation_rejected",
				kind: "create_item",
				result: { status: "rejected", code: "vault_read_only" },
			}),
			reconcileOperationOutcome: async (resolvedAccountId, outcome) => {
				reconciled.push(`${resolvedAccountId}:${outcome.operationId}`);
			},
			logger: console,
		});

		await service.applyDeltaSyncForEvent(
			createSyncEvent({
				type: "operation_resolved",
				entityType: "operation",
				entityId: "operation_rejected",
				vaultId: null,
				userId: "user_alice",
			}),
		);

		expect(reconciled).toEqual(["acc_alice:operation_rejected"]);
	});

	test("non-desktop mode resolves connection context from local token deterministically", async () => {
		const bobAccountId = "acc_bob_example_com";

		const storage = createStorageStub({
			activeAccount: bobAccountId,
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

		const client = createClientStub();
		const service = createSyncCacheService({
			storage,
			itemCache: createItemCacheStub(),
			desktopClient: {
				getAuthToken: async () => null,
				clearCache: () => {},
			},
			createAccountClient: () => client,
			deltaSync: async () => {},
			logger: console,
		});

		const context = await service.resolveConnectionContext();
		expect(context).toEqual({
			accountId: bobAccountId,
			email: "bob@example.com",
			serverUrl: "https://api.example.com",
			client,
		});
	});

	test("clears candidate caches instead of writing un-scoped when account-scoped clients are unavailable", async () => {
		const deltaCalls: Array<string | undefined> = [];
		const accountAId = "acc_a_example_com";
		const accountBId = "acc_b_example_com";

		const storage = createStorageStub({
			activeAccount: null,
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
		const itemCache = createItemCacheStub();

		const service = createSyncCacheService({
			storage,
			itemCache,
			desktopClient: {
				getAuthToken: async () => null,
				clearCache: () => {},
			},
			createAccountClient: () => createClientStub(),
			deltaSync: async (_client, _cache, _event, accountScope) => {
				deltaCalls.push(accountScope);
			},
			logger: console,
		});

		await service.applyDeltaSyncForEvent(createSyncEvent());

		// Both account-scoped attempts fail token resolution. An un-scoped delta would write
		// into the literal `default` collection, which no account reads back — clearing the
		// candidates is what makes the next read correct.
		expect(deltaCalls).toEqual([]);
		expect(itemCache.clearedAccountIds).toEqual([accountBId, accountAId]);
	});

	test("rejects a candidate delta failure without involving irrelevant accounts", async () => {
		const relevantAccountId = "acc_relevant";
		const irrelevantAccountId = "acc_irrelevant";
		const attemptedAccountIds: string[] = [];
		const service = createSyncCacheService({
			storage: createStorageStub({
				activeAccount: null,
				accounts: [
					{ accountId: relevantAccountId, email: "relevant@example.com" },
					{ accountId: irrelevantAccountId, email: "other@example.com" },
				],
				tokensByAccountId: {
					[relevantAccountId]: "relevant-token",
					[irrelevantAccountId]: "irrelevant-token",
				},
				vaultIdsByAccountId: {
					[relevantAccountId]: ["vault_1"],
					[irrelevantAccountId]: ["vault_9"],
				},
			}),
			itemCache: createItemCacheStub(),
			desktopClient: {
				getAuthToken: async () => null,
				clearCache: () => {},
			},
			createAccountClient: () => createClientStub(),
			deltaSync: async (_client, _cache, _event, accountId) => {
				attemptedAccountIds.push(accountId ?? "global");
				throw new Error("candidate cache write failed");
			},
			logger: console,
		});

		expect(service.applyDeltaSyncForEvent(createSyncEvent())).rejects.toThrow(
			"candidate cache write failed",
		);
		expect(attemptedAccountIds).toEqual([relevantAccountId]);
	});

	test("travel_mode_updated invokes travel mode handler only for matching account", async () => {
		const deltaCalls: string[] = [];
		const travelModeCalls: string[] = [];

		const aliceAccountId = "acc_alice";
		const teamAccountId = "acc_team";

		const storage = createStorageStub({
			activeAccount: null,
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
			itemCache: createItemCacheStub(),
			desktopClient: {
				getAuthToken: async () => null,
				clearCache: () => {},
			},
			createAccountClient: () => createClientStub(),
			deltaSync: async (_client, _cache, event, accountScope) => {
				deltaCalls.push(`${event.type}:${accountScope ?? "global"}`);
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
