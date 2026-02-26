import { describe, expect, test } from "bun:test";
import { OutboundQueue } from "../outbound-queue";
import { createSyncManager } from "../sync-manager";
import { SyncOrchestrator } from "../sync-orchestrator";
import type { SyncEvent, SyncStorage } from "../types";

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

function toSseEvent(event: SyncEvent): string {
	return `data: ${JSON.stringify(event)}\n\n`;
}

function buildEvent(partial: Partial<SyncEvent> = {}): SyncEvent {
	return {
		id: partial.id ?? `evt_${Math.random().toString(36).slice(2, 8)}`,
		seq: partial.seq ?? 1,
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
		await storage.set("lastSyncCursor", { seq: 10 });
		const outboundQueue = new OutboundQueue(storage, "self_client");

		const orchestrator = new SyncOrchestrator({
			syncManager: {
				serverUrl: "http://localhost:3000",
				getAuthToken: async () => "token",
				clientId: "self_client",
				storage,
			},
			trpcClient: {
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
							type: "personal",
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
			itemCache: {
				supportsItemCache: true,
				clearItemCache: async () => undefined,
			},
			outboundQueue,
		});

		(orchestrator as any).syncManager.processEvent(
			toSseEvent(
				buildEvent({
					seq: 11,
					clientId: "other_client",
					type: "item_updated",
					entityId: "item_1",
				}),
			),
		);

		await sleep(650);
		const cursor = await storage.get<{ seq: number }>("lastSyncCursor");
		expect(cursor?.seq).toBe(10);

		orchestrator.dispose();
	});

	test("clears cache and advances cursor when catch-up requires full refresh", async () => {
		const storage = new MemoryStorage();
		await storage.set("lastSyncCursor", { seq: 5 });
		const outboundQueue = new OutboundQueue(storage, "self_client");
		const clearedEmails: Array<string | undefined> = [];

		const orchestrator = new SyncOrchestrator({
			syncManager: {
				serverUrl: "http://localhost:3000",
				getAuthToken: async () => "token",
				clientId: "self_client",
				storage,
			},
			trpcClient: {
				sync: {
					getEventsSince: {
						query: async () => ({
							events: [],
							hasMore: false,
							requiresFullRefresh: true,
							cursor: { seq: 20 },
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
							type: "personal",
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
			itemCache: {
				supportsItemCache: true,
				clearItemCache: async (email?: string) => {
					clearedEmails.push(email);
				},
			},
			itemCacheAccountEmail: "alice@example.com",
			outboundQueue,
		});

		await (orchestrator as any).runCatchUp();

		const cursor = await storage.get<{ seq: number }>("lastSyncCursor");
		expect(cursor?.seq).toBe(20);
		expect(clearedEmails).toEqual(["alice@example.com"]);

		orchestrator.dispose();
	});

	test("does not advance cursor when full refresh cannot be performed", async () => {
		const storage = new MemoryStorage();
		await storage.set("lastSyncCursor", { seq: 5 });
		const outboundQueue = new OutboundQueue(storage, "self_client");

		const orchestrator = new SyncOrchestrator({
			syncManager: {
				serverUrl: "http://localhost:3000",
				getAuthToken: async () => "token",
				clientId: "self_client",
				storage,
			},
			trpcClient: {
				sync: {
					getEventsSince: {
						query: async () => ({
							events: [],
							hasMore: false,
							requiresFullRefresh: true,
							cursor: { seq: 21 },
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
							type: "personal",
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
			itemCache: {
				supportsItemCache: true,
			},
			outboundQueue,
		});

		await expect((orchestrator as any).runCatchUp()).rejects.toThrow(
			"full refresh",
		);
		const cursor = await storage.get<{ seq: number }>("lastSyncCursor");
		expect(cursor?.seq).toBe(5);

		orchestrator.dispose();
	});

	test("preserves bulk_import metadata when deduplicating vault_updated events", async () => {
		const storage = new MemoryStorage();
		const received: SyncEvent[] = [];
		const manager = createSyncManager({
			serverUrl: "http://localhost:3000",
			getAuthToken: async () => "token",
			clientId: "self_client",
			storage,
			onEvent: (event) => {
				received.push(event);
			},
		});

		(manager as any).processEvent(
			toSseEvent(
				buildEvent({
					seq: 1,
					type: "vault_updated",
					entityId: "vault_1",
					entityType: "vault",
					metadata: { reason: "bulk_import" },
				}),
			),
		);
		(manager as any).processEvent(
			toSseEvent(
				buildEvent({
					seq: 2,
					type: "vault_updated",
					entityId: "vault_1",
					entityType: "vault",
					metadata: {},
				}),
			),
		);

		await sleep(650);

		expect(received.length).toBe(1);
		expect(received[0]?.seq).toBe(2);
		expect(received[0]?.metadata?.reason).toBe("bulk_import");

		const storedCursor = await storage.get<{ seq: number }>("lastSyncCursor");
		expect(storedCursor).toBeNull();
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
				encryptionAlgorithm: "AES-GCM",
			},
			baseVersion: 3,
			accountEmail: "alice@example.com",
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
			timestamp: 2,
			retryCount: 0,
		});

		await sleep(0);

		const restored = new OutboundQueue(storage, "self_client");
		await restored.restore();

		const perEmailItemIds = new Map<string, string[]>();
		await restored.drain((email) => {
			perEmailItemIds.set(email, []);
			return {
				vault: {
					createItem: {
						mutate: async () => ({}),
					},
					updateItem: {
						mutate: async (input) => {
							perEmailItemIds.get(email)?.push(input.itemId);
						},
					},
					deleteItem: {
						mutate: async (input) => {
							perEmailItemIds.get(email)?.push(input.itemId);
						},
					},
					permanentlyDeleteItem: {
						mutate: async (input) => {
							perEmailItemIds.get(email)?.push(input.itemId);
						},
					},
					restoreItem: {
						mutate: async (input) => {
							perEmailItemIds.get(email)?.push(input.itemId);
						},
					},
					moveItem: {
						mutate: async (input) => {
							perEmailItemIds.get(email)?.push(input.itemId);
						},
					},
					toggleFavorite: {
						mutate: async (input) => {
							perEmailItemIds.get(email)?.push(input.itemId);
						},
					},
				},
			};
		});

		expect(perEmailItemIds.get(firstEmail.toLowerCase())).toEqual(["item_1"]);
		expect(perEmailItemIds.get(secondEmail.toLowerCase())).toEqual(["item_2"]);
	});

	test("migrates legacy outbound queue keys to collision-safe keys", async () => {
		const storage = new MemoryStorage();
		const email = "a+b@example.com";
		const normalizedEmail = email.toLowerCase();
		const legacyKey = `bittery_pending_mutations_${normalizedEmail.replace(/[^a-z0-9]/g, "_")}`;
		const nextKey = `bittery_pending_mutations_${encodeURIComponent(normalizedEmail)}`;

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

		const queue = new OutboundQueue(storage, "self_client");
		await queue.restore();

		expect(queue.getPendingCount()).toBe(1);
		expect(await storage.get(legacyKey)).toBeNull();
		expect(await storage.get(nextKey)).not.toBeNull();
	});
});
