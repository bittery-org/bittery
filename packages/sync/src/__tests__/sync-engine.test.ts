import { describe, expect, test } from "bun:test";
import {
	OutboundQueue,
	type OutboundQueueClient,
	type PendingMutation,
} from "../outbound-queue";
import { createSyncManager } from "../sync-manager";
import { SyncOrchestrator } from "../sync-orchestrator";
import type { SyncEvent, SyncItemCache, SyncStorage } from "../types";

/**
 * Every `SyncItemCache` method is total, so a test double must implement all of
 * them. Overriding one is how a test says which call it cares about.
 */
function stubItemCache(overrides: Partial<SyncItemCache> = {}): SyncItemCache {
	return {
		upsertCachedItem: async () => undefined,
		removeCachedItem: async () => undefined,
		upsertCachedVault: async () => undefined,
		removeCachedVault: async () => undefined,
		clearItemCache: async () => undefined,
		syncVaultKeys: async () => undefined,
		replaceItemId: () => undefined,
		...overrides,
	};
}

class MemoryStorage implements SyncStorage {
	private readonly data = new Map<string, unknown>();

	async get<T>(key: string): Promise<T | null> {
		return (this.data.get(key) as T | undefined) ?? null;
	}

	async set<T>(key: string, value: T): Promise<void> {
		this.data.set(key, value);
	}

	async remove(key: string): Promise<void> {
		this.data.delete(key);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildEvent(partial: Partial<SyncEvent> = {}): SyncEvent {
	return {
		id: partial.id ?? `evt_${Math.random().toString(36).slice(2, 8)}`,
		type: partial.type ?? "item_updated",
		entityId: partial.entityId ?? "item_1",
		entityType: partial.entityType ?? "item",
		vaultId: partial.vaultId ?? "vault_1",
		version: partial.version ?? 1,
		clientId: partial.clientId ?? "other_client",
		userId: partial.userId ?? "user_1",
		timestamp: partial.timestamp ?? Date.now(),
		metadata: partial.metadata,
	};
}

describe("sync engine regressions", () => {
	test("does not advance cursor when live delta application fails", async () => {
		const storage = new MemoryStorage();
		await storage.set("lastSyncCursor", { id: "evt_10" });
		const outboundQueue = new OutboundQueue(storage, "self_client");

		const orchestrator = new SyncOrchestrator({
			syncManager: {
				serverUrl: "http://localhost:3000",
				getAuthToken: async () => "token",
				clientId: "self_client",
				storage,
			},
			rpcClient: {
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
				vault: {
					getItem: {
						query: async () => {
							throw new Error("delta failed");
						},
					},
					get: {
						query: async () => ({
							id: "vault_1",
							name: "Vault",
							vaultType: "personal",
							icon: null,
							imageUrl: null,
						}),
					},
					listItems: {
						query: async () => [],
					},
					list: {
						query: async () => [],
					},
				},
			},
			itemCache: stubItemCache(),
			outboundQueue,
		});

		// Directly invoke applyEvent to test delta failure behavior
		try {
			await (orchestrator as any).applyEvent(
				buildEvent({
					id: "evt_11",
					clientId: "other_client",
					type: "item_updated",
					entityId: "item_1",
				}),
			);
		} catch {
			// Expected to throw — delta sync fails
		}

		const cursor = await storage.get<{ id: string }>("lastSyncCursor");
		expect(cursor?.id).toBe("evt_10");

		orchestrator.dispose();
	});

	test("clears cache and advances cursor when catch-up requires full refresh", async () => {
		const storage = new MemoryStorage();
		await storage.set("lastSyncCursor", { id: "evt_5" });
		const outboundQueue = new OutboundQueue(storage, "self_client");
		const clearedAccounts: Array<string | undefined> = [];
		const itemCache = stubItemCache({
			clearItemCache: async (accountId?: string) => {
				clearedAccounts.push(accountId);
			},
		});

		const orchestrator = new SyncOrchestrator({
			syncManager: {
				serverUrl: "http://localhost:3000",
				getAuthToken: async () => "token",
				clientId: "self_client",
				storage,
			},
			rpcClient: {
				sync: {
					getEventsSince: {
						query: async () => ({
							events: [],
							hasMore: false,
							requiresFullRefresh: true,
							cursor: { id: "evt_20" },
						}),
					},
				},
				vault: {
					getItem: {
						query: async () => {
							throw new Error("unused");
						},
					},
					get: {
						query: async () => ({
							id: "vault_1",
							name: "Vault",
							vaultType: "personal",
							icon: null,
							imageUrl: null,
						}),
					},
					listItems: {
						query: async () => [],
					},
					list: {
						query: async () => [],
					},
				},
			},
			itemCache,
			itemCacheAccountEmail: "alice@example.com",
			outboundQueue,
		});

		await (orchestrator as any).runCatchUp();

		const cursor = await storage.get<{ id: string }>("lastSyncCursor");
		expect(cursor?.id).toBe("evt_20");
		expect(clearedAccounts).toEqual(["alice@example.com"]);

		orchestrator.dispose();
	});

	test("calls onSyncPing when receiving sync ping event", async () => {
		const storage = new MemoryStorage();
		let pingCount = 0;

		const manager = createSyncManager({
			serverUrl: "http://localhost:3000",
			getAuthToken: async () => "token",
			clientId: "self_client",
			storage,
			onSyncPing: () => {
				pingCount++;
			},
		});

		(manager as any).processEvent(
			`event: sync\ndata: ${JSON.stringify({ timestamp: Date.now() })}\n\n`,
		);
		(manager as any).processEvent(
			`event: sync\ndata: ${JSON.stringify({ timestamp: Date.now() })}\n\n`,
		);

		expect(pingCount).toBe(2);
		expect(manager.getLastEventCursor()).toBeNull();
		manager.disconnect();
	});

	test("routes session_revoked events to onSessionRevoked only", async () => {
		const storage = new MemoryStorage();
		const revokedPayloads: Array<{
			type: string;
			userId: string;
			sessionId: string;
			timestamp: number;
			reason?: string;
		}> = [];

		const manager = createSyncManager({
			serverUrl: "http://localhost:3000",
			getAuthToken: async () => "token",
			clientId: "self_client",
			storage,
			onSessionRevoked: (payload) => {
				revokedPayloads.push(payload);
			},
		});

		// New format: event: session_revoked with session_id (snake_case)
		(manager as any).processEvent(
			`event: session_revoked\ndata: ${JSON.stringify({
				session_id: "session_1",
				reason: "device_revoked",
				timestamp: 123456,
			})}\n\n`,
		);

		expect(revokedPayloads).toEqual([
			{
				type: "session_revoked",
				userId: "",
				sessionId: "session_1",
				timestamp: 123456,
				reason: "device_revoked",
			},
		]);
		expect(manager.getLastEventCursor()).toBeNull();
		manager.disconnect();
	});

	test("keeps update after delete+restore during queue compaction", async () => {
		const storage = new MemoryStorage();
		const queue = new OutboundQueue(storage, "self_client");

		queue.enqueue({
			id: "m_delete",
			type: "delete",
			entityId: "item_1",
			vaultId: "vault_1",
			baseVersion: 1,
			accountEmail: "alice@example.com",
			accountId: "account-alice",
			timestamp: 1,
			retryCount: 0,
		});
		queue.enqueue({
			id: "m_restore",
			type: "restore",
			entityId: "item_1",
			vaultId: "vault_1",
			baseVersion: 2,
			accountEmail: "alice@example.com",
			accountId: "account-alice",
			timestamp: 2,
			retryCount: 0,
		});
		queue.enqueue({
			id: "m_update",
			type: "update",
			entityId: "item_1",
			vaultId: "vault_1",
			encryptedPayload: {
				encryptedData: "cipher",
				encryptionIv: "iv",
				encryptionAlgorithm: "AES-GCM-AAD-V1",
			},
			baseVersion: 3,
			accountEmail: "alice@example.com",
			accountId: "account-alice",
			timestamp: 3,
			retryCount: 0,
		});

		const operations: string[] = [];
		queue.compact();
		await queue.drain(() => ({
			vault: {
				createItem: {
					mutate: async () => ({}),
				},
				updateItem: {
					mutate: async () => {
						operations.push("update");
					},
				},
				deleteItem: {
					mutate: async () => {
						operations.push("delete");
					},
				},
				permanentlyDeleteItem: {
					mutate: async () => {
						operations.push("permanent_delete");
					},
				},
				restoreItem: {
					mutate: async () => {
						operations.push("restore");
					},
				},
				moveItem: {
					mutate: async () => {
						operations.push("move");
					},
				},
				toggleFavorite: {
					mutate: async () => {
						operations.push("toggle_favorite");
					},
				},
			},
		}));

		expect(operations).toEqual(["delete", "restore", "update"]);
		expect(queue.getPendingCount()).toBe(0);
	});

	test("isolates outbound queues for emails that previously collided", async () => {
		const storage = new MemoryStorage();
		const queue = new OutboundQueue(storage, "self_client");
		const firstEmail = "a+b@example.com";
		const secondEmail = "a.b@example.com";

		queue.enqueue({
			id: "m1",
			type: "delete",
			entityId: "item_1",
			vaultId: "vault_1",
			baseVersion: 1,
			accountEmail: firstEmail,
			accountId: "account-first",
			timestamp: 1,
			retryCount: 0,
		});
		queue.enqueue({
			id: "m2",
			type: "delete",
			entityId: "item_2",
			vaultId: "vault_1",
			baseVersion: 1,
			accountEmail: secondEmail,
			accountId: "account-second",
			timestamp: 2,
			retryCount: 0,
		});

		await sleep(0);

		const restored = new OutboundQueue(storage, "self_client");
		await restored.restore();

		const perAccountItemIds = new Map<string, string[]>();
		await restored.drain((accountId) => {
			perAccountItemIds.set(accountId, []);
			return {
				vault: {
					createItem: {
						mutate: async () => ({}),
					},
					updateItem: {
						mutate: async (input) => {
							perAccountItemIds.get(accountId)?.push(input.itemId);
						},
					},
					deleteItem: {
						mutate: async (input) => {
							perAccountItemIds.get(accountId)?.push(input.itemId);
						},
					},
					permanentlyDeleteItem: {
						mutate: async (input) => {
							perAccountItemIds.get(accountId)?.push(input.itemId);
						},
					},
					restoreItem: {
						mutate: async (input) => {
							perAccountItemIds.get(accountId)?.push(input.itemId);
						},
					},
					moveItem: {
						mutate: async (input) => {
							perAccountItemIds.get(accountId)?.push(input.itemId);
						},
					},
					toggleFavorite: {
						mutate: async (input) => {
							perAccountItemIds.get(accountId)?.push(input.itemId);
						},
					},
				},
			};
		});

		expect(perAccountItemIds.get("account-first")).toEqual(["item_1"]);
		expect(perAccountItemIds.get("account-second")).toEqual(["item_2"]);
	});

	test("migrates legacy outbound queue keys to collision-safe keys", async () => {
		const storage = new MemoryStorage();
		const email = "a+b@example.com";
		const normalizedEmail = email.toLowerCase();
		const legacyKey = `bittery_pending_mutations_${normalizedEmail.replace(/[^a-z0-9]/g, "_")}`;
		const nextKey = "bittery_pending_mutations_v2_account-legacy";

		await storage.set("bittery_pending_mutation_accounts", [normalizedEmail]);
		await storage.set(legacyKey, [
			{
				id: "m_legacy",
				type: "delete",
				entityId: "item_legacy",
				vaultId: "vault_1",
				baseVersion: 1,
				accountEmail: normalizedEmail,
				timestamp: 1,
				retryCount: 0,
			},
		]);

		const queue = new OutboundQueue(
			storage,
			"self_client",
			async () => "account-legacy",
		);
		await queue.restore();

		expect(queue.getPendingCount()).toBe(1);
		expect(await storage.get(legacyKey)).toBeNull();
		expect(await storage.get(nextKey)).not.toBeNull();
	});

	test("preserves and refuses to drain an ambiguous legacy queue", async () => {
		const storage = new MemoryStorage();
		const email = "same@example.com";
		const legacyKey = `bittery_pending_mutations_${email.replace(/[^a-z0-9]/g, "_")}`;
		await storage.set("bittery_pending_mutation_accounts", [email]);
		await storage.set(legacyKey, [
			{
				id: "m_legacy",
				type: "delete",
				entityId: "item_legacy",
				vaultId: "vault_1",
				baseVersion: 1,
				accountEmail: email,
				timestamp: 1,
				retryCount: 0,
			},
		]);
		const queue = new OutboundQueue(storage, "self_client", async () => {
			throw new Error("Ambiguous account email");
		});
		await queue.restore();
		expect(await storage.get(legacyKey)).not.toBeNull();
		expect(
			queue.drain(async () => {
				throw new Error("must not resolve a client");
			}),
		).rejects.toThrow("Cannot drain ambiguous legacy queues");
	});
});

function buildDeleteMutation(
	accountId: string,
	entityId: string,
	overrides: Partial<PendingMutation> = {},
): PendingMutation {
	return {
		accountId,
		id: `m_${accountId}_${entityId}`,
		type: "delete",
		entityId,
		vaultId: "vault_1",
		baseVersion: 1,
		timestamp: 1,
		retryCount: 0,
		...overrides,
	};
}

function networkError(): Error {
	const error = new Error("network down") as Error & { status: number };
	error.status = 503;
	return error;
}

describe("outbound queue multi-account drain isolation", () => {
	test("one account's failure does not starve other accounts' queues", async () => {
		const storage = new MemoryStorage();
		const queue = new OutboundQueue(storage, "self_client");

		// account_a sorts before account_b, so it is drained first.
		queue.enqueue(buildDeleteMutation("account_a", "item_a"));
		queue.enqueue(buildDeleteMutation("account_b", "item_b"));

		const deletedByAccount = new Map<string, string[]>();
		const makeClient = (accountId: string, shouldFail: boolean) =>
			({
				vault: {
					deleteItem: {
						mutate: async ({ itemId }: { itemId: string }) => {
							if (shouldFail) {
								throw networkError();
							}
							const done = deletedByAccount.get(accountId) ?? [];
							done.push(itemId);
							deletedByAccount.set(accountId, done);
							return {};
						},
					},
				},
			}) as unknown as OutboundQueueClient;

		await queue.drain((accountId) =>
			makeClient(accountId, accountId === "account_a"),
		);

		// account_a hit a network error and was retained for retry, but the
		// failure must NOT prevent account_b from draining.
		expect(deletedByAccount.get("account_b")).toEqual(["item_b"]);
		expect(queue.hasPendingForItem("item_a")).toBe(true);
		expect(queue.hasPendingForItem("item_b")).toBe(false);
		expect(queue.getPendingCount()).toBe(1);
	});

	test("serializes concurrent drains so mutations are not double-sent", async () => {
		const storage = new MemoryStorage();
		const queue = new OutboundQueue(storage, "self_client");

		queue.enqueue(buildDeleteMutation("account_a", "item_a"));
		queue.enqueue(buildDeleteMutation("account_b", "item_b"));

		const deleteCalls: string[] = [];
		let inFlight = 0;
		let observedConcurrency = 0;
		const client = {
			vault: {
				deleteItem: {
					mutate: async ({ itemId }: { itemId: string }) => {
						inFlight += 1;
						observedConcurrency = Math.max(observedConcurrency, inFlight);
						await new Promise((resolve) => setTimeout(resolve, 5));
						deleteCalls.push(itemId);
						inFlight -= 1;
						return {};
					},
				},
			},
		} as unknown as OutboundQueueClient;

		// Kick off two overlapping drains against the shared queue.
		await Promise.all([queue.drain(() => client), queue.drain(() => client)]);

		// Each mutation is processed exactly once and never concurrently.
		expect(deleteCalls.sort()).toEqual(["item_a", "item_b"]);
		expect(observedConcurrency).toBe(1);
		expect(queue.getPendingCount()).toBe(0);
	});
});
