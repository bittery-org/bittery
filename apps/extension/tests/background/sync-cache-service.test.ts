import { describe, expect, test } from "bun:test";
import type { SyncEvent } from "@bittery/sync";
import {
	createSyncCacheService,
	type SyncCacheDesktopClient,
	type SyncCacheStorage,
	type SyncEventQueryClient,
} from "../../src/background/services/sync-cache-service";

type ActiveAccount = { type: "single"; email: string } | { type: "all" } | null;

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
				query: async () => ({ events: [] }),
			},
		},
	} as SyncEventQueryClient;
}

function createStorageStub(input: {
	activeAccount: ActiveAccount;
	accounts: string[];
	tokensByEmail: Record<string, string | undefined>;
	serverUrlsByEmail?: Record<string, string | undefined>;
	vaultIdsByEmail?: Record<string, string[] | undefined>;
	fallbackToken?: string | null;
}): SyncCacheStorage & { clearedEmails: string[] } {
	const tokenMap = new Map<string, string>(
		Object.entries(input.tokensByEmail)
			.filter(([, token]) => !!token)
			.map(([email, token]) => [email.toLowerCase(), token as string]),
	);
	const serverUrlMap = new Map<string, string>(
		Object.entries(input.serverUrlsByEmail ?? {})
			.filter(([, serverUrl]) => !!serverUrl)
			.map(([email, serverUrl]) => [email.toLowerCase(), serverUrl as string]),
	);
	const vaultIdMap = new Map<string, string[]>(
		Object.entries(input.vaultIdsByEmail ?? {}).map(([email, vaultIds]) => [
			email.toLowerCase(),
			vaultIds ?? [],
		]),
	);
	const clearedEmails: string[] = [];

	return {
		supportsItemCache: true,
		clearedEmails,
		getActiveAccount: async () => input.activeAccount,
		getAccountsList: async () =>
			input.accounts.map((email) => ({
				email,
			})),
		getAuthToken: async (email?: string) => {
			if (email) {
				return tokenMap.get(email.toLowerCase()) ?? null;
			}

			const active = input.activeAccount;
			if (active && active.type === "single") {
				return tokenMap.get(active.email.toLowerCase()) ?? null;
			}
			return input.fallbackToken ?? null;
		},
		storeAuthToken: async (token: string, email?: string) => {
			if (!email) {
				return;
			}
			tokenMap.set(email.toLowerCase(), token);
		},
		getServerUrl: async (email?: string) => {
			if (!email) {
				return null;
			}
			return serverUrlMap.get(email.toLowerCase()) ?? null;
		},
		getVaultKeys: async (email?: string) => {
			if (!email) {
				return null;
			}
			return (vaultIdMap.get(email.toLowerCase()) ?? []).map((vaultId) => ({
				vaultId,
			}));
		},
		clearItemCache: async (email?: string) => {
			if (email) {
				clearedEmails.push(email.toLowerCase());
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
	test("desktop-origin item changes apply account-scoped delta and clear desktop decrypt cache", async () => {
		const deltaCalls: Array<{
			eventType: SyncEvent["type"];
			accountEmail: string | undefined;
		}> = [];
		let desktopCacheClearCount = 0;

		const storage = createStorageStub({
			activeAccount: { type: "all" },
			accounts: ["team@example.com", "alice@example.com"],
			tokensByEmail: {
				"alice@example.com": "alice-token",
				"team@example.com": "team-token",
			},
			vaultIdsByEmail: {
				"alice@example.com": ["vault_1"],
				"team@example.com": ["vault_9"],
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
		const storage = createStorageStub({
			activeAccount: { type: "single", email: "Bob@example.com" },
			accounts: ["z@example.com", "bob@example.com"],
			tokensByEmail: {
				"bob@example.com": "local-token",
			},
			serverUrlsByEmail: {
				"bob@example.com": "https://api.example.com",
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
		const storage = createStorageStub({
			activeAccount: { type: "all" },
			accounts: ["b@example.com", "a@example.com"],
			tokensByEmail: {},
			vaultIdsByEmail: {
				"a@example.com": ["vault_1"],
				"b@example.com": ["vault_1"],
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
		expect(storage.clearedEmails).toEqual(["b@example.com", "a@example.com"]);
	});
});
