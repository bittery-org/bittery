import { describe, expect, test } from "bun:test";
import { ApiError } from "@bittery/shared/api-client";
import { serverEncryptedItem } from "@bittery/shared/testing/item-fixtures";
import {
	OutboundQueue,
	type OutboundQueueApiClient,
	type PendingMutation,
} from "../outbound-queue";
import { createSyncManager } from "../sync-manager";
import { type SyncApiClient, SyncOrchestrator } from "../sync-orchestrator";
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
		applyItemCommand: async () => undefined,
		executeSemanticItemCommand: async () => undefined,
		discardItemCommandAcknowledgedElsewhere: async () => undefined,
		preserveItemConflict: async () => undefined,
		acknowledgeItemCommand: async () => undefined,
		...overrides,
	};
}

class MemoryStorage implements SyncStorage {
	protected readonly data = new Map<string, unknown>();
	private updateTail: Promise<void> = Promise.resolve();

	async get<T>(key: string): Promise<T | null> {
		return (this.data.get(key) as T | undefined) ?? null;
	}

	async set<T>(key: string, value: T): Promise<void> {
		this.data.set(key, value);
	}

	async remove(key: string): Promise<void> {
		this.data.delete(key);
	}

	async update<T>(
		key: string,
		updater: (current: T | null) => T | null,
	): Promise<T | null> {
		let result: T | null = null;
		const update = this.updateTail.then(() => {
			const current = (this.data.get(key) as T | undefined) ?? null;
			result = updater(structuredClone(current));
			if (result === null) {
				this.data.delete(key);
			} else {
				this.data.set(key, structuredClone(result));
			}
		});
		this.updateTail = update.catch(() => undefined);
		await update;
		return structuredClone(result);
	}
}

class GatedStorage extends MemoryStorage {
	private releaseWrite: (() => void) | undefined;
	readonly writeStarted = new Promise<void>((resolve) => {
		this.releaseWrite = resolve;
	});
	private readonly writeGate = Promise.withResolvers<void>();

	override async update<T>(
		key: string,
		updater: (current: T | null) => T | null,
	): Promise<T | null> {
		this.releaseWrite?.();
		await this.writeGate.promise;
		return super.update(key, updater);
	}

	release(): void {
		this.writeGate.resolve();
	}
}

class AtomicMemoryStorage extends MemoryStorage {
	private atomicUpdateTail: Promise<void> = Promise.resolve();

	async update<T>(
		key: string,
		updater: (current: T | null) => T | null,
	): Promise<T | null> {
		let result: T | null = null;
		const update = this.atomicUpdateTail.then(() => {
			const current = (this.data.get(key) as T | undefined) ?? null;
			result = updater(structuredClone(current));
			if (result === null) {
				this.data.delete(key);
			} else {
				this.data.set(key, structuredClone(result));
			}
		});
		this.atomicUpdateTail = update.catch(() => undefined);
		await update;
		return structuredClone(result);
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

function apiResult<T>(data: T) {
	return { data, etag: null, requestId: null };
}

interface TestApiClientOptions {
	changes?: (input: { sinceId?: string; limit?: number }) => Promise<{
		events: SyncEvent[];
		hasMore: boolean;
		requiresFullRefresh: boolean;
		cursor: { id: string } | null;
	}>;
	getItem?: (itemId: string) => Promise<Record<string, unknown>>;
	events?: (signal?: AbortSignal) => Promise<Response>;
}

function testApiClient(options: TestApiClientOptions = {}): SyncApiClient {
	return {
		sync: {
			events: (signal?: AbortSignal) =>
				options.events?.(signal) ??
				Promise.resolve(
					new Response(
						new ReadableStream({
							start(controller) {
								controller.close();
							},
						}),
						{ status: 200 },
					),
				),
			changes: async (input: { sinceId?: string; limit?: number }) =>
				apiResult(
					await (options.changes?.(input) ??
						Promise.resolve({
							events: [],
							hasMore: false,
							requiresFullRefresh: false,
							cursor: null,
						})),
				),
		},
		items: {
			get: async (itemId: string) =>
				apiResult(
					await (options.getItem?.(itemId) ??
						Promise.resolve(
							serverEncryptedItem({
								id: itemId,
								vaultId: "vault_1",
								category: "login",
								favorite: false,
								encryptedData: "ciphertext",
								encryptionIv: "iv",
								encryptionAlgorithm: "AES-GCM-AAD-V1",
								encryptionVersion: 1,
								encryptedByUserId: "user_1",
								version: 1,
								lastModifiedBy: "user_1",
								createdAt: "2026-03-13T00:00:00.000Z",
								updatedAt: "2026-03-13T00:00:00.000Z",
								deletedAt: null,
								attachments: [],
							}),
						)),
				),
			listInVault: async () => apiResult([]),
		},
		vaults: {
			get: async () =>
				apiResult({
					id: "vault_1",
					name: "Vault",
					vaultType: "personal",
					icon: null,
					imageUrl: null,
				}),
			list: async () => apiResult([]),
		},
	} as unknown as SyncApiClient;
}

interface TestWriteOptions {
	etag?: string;
	idempotencyKey?: string;
}

interface OutboundClientHandlers {
	create?: (itemId: string, options?: TestWriteOptions) => Promise<void>;
	update?: (itemId: string, options?: TestWriteOptions) => Promise<void>;
	trash?: (itemId: string, options?: TestWriteOptions) => Promise<void>;
	deletePermanently?: (
		itemId: string,
		options?: TestWriteOptions,
	) => Promise<void>;
	restore?: (itemId: string, options?: TestWriteOptions) => Promise<void>;
	move?: (itemId: string, options?: TestWriteOptions) => Promise<void>;
	setFavorite?: (itemId: string, options?: TestWriteOptions) => Promise<void>;
}

function outboundApiClient(
	handlers: OutboundClientHandlers = {},
): OutboundQueueApiClient {
	return {
		items: {
			create: async (
				_vaultId: string,
				itemId: string,
				_input: unknown,
				options?: TestWriteOptions,
			) => {
				await handlers.create?.(itemId, options);
				return apiResult({ itemId, id: itemId });
			},
			update: async (
				itemId: string,
				_input: unknown,
				options?: TestWriteOptions,
			) => {
				await handlers.update?.(itemId, options);
				return apiResult({ success: true, version: 1 });
			},
			trash: async (itemId: string, options?: TestWriteOptions) => {
				await handlers.trash?.(itemId, options);
				return apiResult({});
			},
			deletePermanently: async (itemId: string, options?: TestWriteOptions) => {
				await handlers.deletePermanently?.(itemId, options);
				return apiResult({});
			},
			restore: async (itemId: string, options?: TestWriteOptions) => {
				await handlers.restore?.(itemId, options);
				return apiResult({});
			},
			move: async (
				itemId: string,
				_input: unknown,
				options?: TestWriteOptions,
			) => {
				await handlers.move?.(itemId, options);
				return apiResult({});
			},
			setFavorite: async (
				itemId: string,
				_input: unknown,
				options?: TestWriteOptions,
			) => {
				await handlers.setFavorite?.(itemId, options);
				return apiResult({});
			},
		},
	} as unknown as OutboundQueueApiClient;
}

/** A catch-up page whose first item is the one that will not decrypt locally. */
function poisonItemClient() {
	return testApiClient({
		changes: async () => ({
			events: [
				buildEvent({ id: "evt_11", entityId: "item_poison" }),
				buildEvent({ id: "evt_12", entityId: "item_ok" }),
			],
			hasMore: false,
			requiresFullRefresh: false,
			cursor: { id: "evt_12" },
		}),
	});
}

describe("sync engine regressions", () => {
	test("initializes a cold source from its committed bootstrap cursor before catch-up", async () => {
		const storage = new MemoryStorage();
		const changesSinceIds: Array<string | undefined> = [];
		let itemReads = 0;
		let initializations = 0;
		const orchestrator = new SyncOrchestrator({
			syncManager: { clientId: "self_client", storage },
			apiClient: testApiClient({
				changes: async ({ sinceId }) => {
					changesSinceIds.push(sinceId);
					return {
						events:
							sinceId === "evt_bootstrap"
								? []
								: [buildEvent({ id: "evt_historical" })],
						hasMore: false,
						requiresFullRefresh: false,
						cursor: sinceId ? { id: sinceId } : { id: "evt_historical" },
					};
				},
				getItem: async () => {
					itemReads += 1;
					return {};
				},
			}),
			itemCache: stubItemCache(),
			itemCacheAccountId: "account_a",
			initializeFromServer: async () => {
				initializations += 1;
				return { id: "evt_bootstrap" };
			},
			outboundQueue: new OutboundQueue(storage, "self_client"),
		});

		await (orchestrator as any).runCatchUp();

		expect(initializations).toBe(1);
		expect(changesSinceIds).toEqual(["evt_bootstrap"]);
		expect(itemReads).toBe(0);
		expect((await storage.get<{ id: string }>("lastSyncCursor"))?.id).toBe(
			"evt_bootstrap",
		);
		orchestrator.dispose();
	});

	test("replaces a stale durable cursor with the cache generation baseline", async () => {
		const storage = new MemoryStorage();
		await storage.set("lastSyncCursor", { id: "evt_stale" });
		await storage.set("syncBaselineV1", {
			initialized: true,
			cursor: { id: "evt_stale" },
		});
		const changesSinceIds: Array<string | undefined> = [];
		const orchestrator = new SyncOrchestrator({
			syncManager: { clientId: "self_client", storage },
			apiClient: testApiClient({
				changes: async ({ sinceId }) => {
					changesSinceIds.push(sinceId);
					return {
						events: [],
						hasMore: false,
						requiresFullRefresh: false,
						cursor: sinceId ? { id: sinceId } : null,
					};
				},
			}),
			itemCache: stubItemCache(),
			itemCacheAccountId: "account_a",
			initializeFromServer: async () => ({ id: "evt_bootstrap" }),
			outboundQueue: new OutboundQueue(storage, "self_client"),
		});

		await (orchestrator as any).runCatchUp();

		expect(changesSinceIds).toEqual(["evt_bootstrap"]);
		expect((await storage.get<{ id: string }>("lastSyncCursor"))?.id).toBe(
			"evt_bootstrap",
		);
		orchestrator.dispose();
	});

	test("remembers a committed bootstrap with no event cursor", async () => {
		const storage = new MemoryStorage();
		let initializations = 0;
		const orchestrator = new SyncOrchestrator({
			syncManager: { clientId: "self_client", storage },
			apiClient: testApiClient(),
			itemCache: stubItemCache(),
			itemCacheAccountId: "account_a",
			initializeFromServer: async () => {
				initializations += 1;
				return null;
			},
			outboundQueue: new OutboundQueue(storage, "self_client"),
		});

		await (orchestrator as any).runCatchUp();
		await (orchestrator as any).runCatchUp();

		expect(initializations).toBe(1);
		orchestrator.disconnect();
		await (orchestrator as any).runCatchUp();
		expect(initializations).toBe(2);
		orchestrator.dispose();
	});

	test("does not record an initial baseline when bootstrap fails", async () => {
		const storage = new MemoryStorage();
		const orchestrator = new SyncOrchestrator({
			syncManager: { clientId: "self_client", storage },
			apiClient: testApiClient(),
			itemCache: stubItemCache(),
			itemCacheAccountId: "account_a",
			initializeFromServer: async () => {
				throw new Error("bootstrap failed");
			},
			outboundQueue: new OutboundQueue(storage, "self_client"),
		});

		await expect((orchestrator as any).runCatchUp()).rejects.toThrow(
			"bootstrap failed",
		);
		expect(await storage.get("syncBaselineV1")).toBeNull();
		expect(await storage.get("lastSyncCursor")).toBeNull();
		orchestrator.dispose();
	});

	test("applies an Item event committed after the bootstrap watermark", async () => {
		const storage = new MemoryStorage();
		const changesSinceIds: Array<string | undefined> = [];
		let itemReads = 0;
		const orchestrator = new SyncOrchestrator({
			syncManager: { clientId: "self_client", storage },
			apiClient: testApiClient({
				changes: async ({ sinceId }) => {
					changesSinceIds.push(sinceId);
					return {
						events: [
							buildEvent({
								id: "evt_concurrent",
								entityId: "item_concurrent",
							}),
						],
						hasMore: false,
						requiresFullRefresh: false,
						cursor: { id: "evt_concurrent" },
					};
				},
				getItem: async () => {
					itemReads += 1;
					return {};
				},
			}),
			itemCache: stubItemCache(),
			itemCacheAccountId: "account_a",
			initializeFromServer: async () => ({ id: "evt_bootstrap" }),
			outboundQueue: new OutboundQueue(storage, "self_client"),
		});

		await (orchestrator as any).runCatchUp();

		expect(changesSinceIds).toEqual(["evt_bootstrap"]);
		expect(itemReads).toBe(1);
		expect((await storage.get<{ id: string }>("lastSyncCursor"))?.id).toBe(
			"evt_concurrent",
		);
		orchestrator.dispose();
	});

	test("does not advance cursor when live delta application fails", async () => {
		const storage = new MemoryStorage();
		await storage.set("lastSyncCursor", { id: "evt_10" });
		const outboundQueue = new OutboundQueue(storage, "self_client");

		const orchestrator = new SyncOrchestrator({
			syncManager: {
				clientId: "self_client",
				storage,
			},
			apiClient: testApiClient({
				getItem: async () => {
					throw new Error("delta failed");
				},
			}),
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

	test("advances the cursor only after a staged full refresh succeeds", async () => {
		const storage = new MemoryStorage();
		await storage.set("lastSyncCursor", { id: "evt_5" });
		const outboundQueue = new OutboundQueue(storage, "self_client");
		const refreshAccounts: string[] = [];
		const itemCache = stubItemCache();

		const orchestrator = new SyncOrchestrator({
			syncManager: {
				clientId: "self_client",
				storage,
			},
			apiClient: testApiClient({
				changes: async () => ({
					events: [],
					hasMore: false,
					requiresFullRefresh: true,
					cursor: { id: "evt_20" },
				}),
			}),
			itemCache,
			// Scoped by accountId, never the email: an email is not an identity.
			itemCacheAccountId: "acc_alice",
			itemCacheAccountEmail: "alice@example.com",
			refreshFromServer: async (_client, accountId) => {
				expect((await storage.get<{ id: string }>("lastSyncCursor"))?.id).toBe(
					"evt_5",
				);
				refreshAccounts.push(accountId);
			},
			outboundQueue,
		});

		await (orchestrator as any).runCatchUp();

		const cursor = await storage.get<{ id: string }>("lastSyncCursor");
		expect(cursor?.id).toBe("evt_20");
		expect(refreshAccounts).toEqual(["acc_alice"]);

		orchestrator.dispose();
	});

	test("keeps the previous cursor when a staged full refresh fails", async () => {
		const storage = new MemoryStorage();
		await storage.set("lastSyncCursor", { id: "evt_5" });
		const outboundQueue = new OutboundQueue(storage, "self_client");
		const orchestrator = new SyncOrchestrator({
			syncManager: {
				clientId: "self_client",
				storage,
			},
			apiClient: testApiClient({
				changes: async () => ({
					events: [],
					hasMore: false,
					requiresFullRefresh: true,
					cursor: { id: "evt_20" },
				}),
			}),
			itemCache: stubItemCache(),
			itemCacheAccountId: "acc_alice",
			refreshFromServer: async () => {
				throw new Error("staging failed");
			},
			outboundQueue,
		});

		await expect((orchestrator as any).runCatchUp()).rejects.toThrow(
			"staging failed",
		);
		expect((await storage.get<{ id: string }>("lastSyncCursor"))?.id).toBe(
			"evt_5",
		);

		orchestrator.dispose();
	});

	// An email is not an account identity. Letting one name a cache scope makes
	// `ItemCache` create a collection keyed by an email, and makes
	// `VaultRepositoryCoordinator.getOrCreate` mint a repo under one.
	test("never scopes a cache write by an email", async () => {
		const storage = new MemoryStorage();
		const outboundQueue = new OutboundQueue(storage, "self_client");
		const upsertScopes: Array<string | undefined> = [];
		const itemCache = stubItemCache({
			upsertCachedItem: async (_item, accountId?: string) => {
				upsertScopes.push(accountId);
			},
		});

		const orchestrator = new SyncOrchestrator({
			syncManager: {
				clientId: "self_client",
				storage,
			},
			apiClient: testApiClient(),
			itemCache,
			// Only an email is configured — no accountId to scope by.
			itemCacheAccountEmail: "alice@example.com",
			outboundQueue,
		});

		try {
			await (orchestrator as any).applyEvent(
				buildEvent({ id: "evt_1", type: "item_updated", entityId: "item_1" }),
			);
		} catch {
			// Refusing the write outright is the correct outcome.
		}

		expect(upsertScopes).not.toContain("alice@example.com");

		orchestrator.dispose();
	});

	// One item nobody can decrypt used to wedge sync forever: the throw aborted
	// catch-up before the cursor was stored, so every reconnect replayed it.
	test("advances past an item the cache cannot decrypt", async () => {
		const storage = new MemoryStorage();
		await storage.set("lastSyncCursor", { id: "evt_10" });
		const outboundQueue = new OutboundQueue(storage, "self_client");
		const upsertedIds: string[] = [];

		const orchestrator = new SyncOrchestrator({
			syncManager: {
				clientId: "self_client",
				storage,
			},
			apiClient: poisonItemClient(),
			// `VaultRepository.upsertEncrypted` swallows a decryption failure and still
			// caches the ciphertext, so the sync layer sees a plain successful write.
			itemCache: stubItemCache({
				upsertCachedItem: async (item) => {
					upsertedIds.push(item.id);
				},
			}),
			itemCacheAccountId: "acc_alice",
			outboundQueue,
		});

		await (orchestrator as any).runCatchUp();

		expect(upsertedIds).toEqual(["item_poison", "item_ok"]);
		expect((await storage.get<{ id: string }>("lastSyncCursor"))?.id).toBe(
			"evt_12",
		);

		orchestrator.dispose();
	});

	// Guards the placement of the fix above: tolerating the failure anywhere in the
	// sync layer would also skip events that failed for transient reasons.
	test("keeps the cursor when an item cache write throws", async () => {
		const storage = new MemoryStorage();
		await storage.set("lastSyncCursor", { id: "evt_10" });
		const outboundQueue = new OutboundQueue(storage, "self_client");

		const orchestrator = new SyncOrchestrator({
			syncManager: {
				clientId: "self_client",
				storage,
			},
			apiClient: poisonItemClient(),
			itemCache: stubItemCache({
				upsertCachedItem: async () => {
					throw new Error("cache write failed");
				},
			}),
			itemCacheAccountId: "acc_alice",
			outboundQueue,
		});

		await expect((orchestrator as any).runCatchUp()).rejects.toThrow(
			"cache write failed",
		);

		expect((await storage.get<{ id: string }>("lastSyncCursor"))?.id).toBe(
			"evt_10",
		);

		orchestrator.dispose();
	});

	test("applies and acknowledges an own event even while its command is pending", async () => {
		const storage = new MemoryStorage();
		const outboundQueue = new OutboundQueue(storage, "self_client");
		await outboundQueue.enqueue(
			buildDeleteMutation("account_a", "item_1", {
				type: "toggle_favorite",
				favorite: true,
			}),
		);
		const upsertedVersions: number[] = [];
		const orchestrator = new SyncOrchestrator({
			syncManager: { clientId: "self_client", storage },
			apiClient: testApiClient({
				getItem: async (id) =>
					serverEncryptedItem({
						id,
						vaultId: "vault_1",
						category: "login",
						favorite: true,
						encryptedData: "ciphertext",
						encryptionIv: "iv",
						encryptionAlgorithm: "AES-GCM-AAD-V1",
						encryptionVersion: 1,
						encryptedByUserId: "user_1",
						version: 2,
						lastModifiedBy: "user_1",
						createdAt: "2026-03-13T00:00:00.000Z",
						updatedAt: "2026-03-13T00:00:00.000Z",
						deletedAt: null,
						attachments: [],
					}),
			}),
			itemCache: stubItemCache({
				upsertCachedItem: async (item) => {
					upsertedVersions.push(item.version);
				},
			}),
			itemCacheAccountId: "account_a",
			outboundQueue,
		});
		const event = buildEvent({
			id: "evt_own",
			clientId: "self_client",
			entityId: "item_1",
			version: 2,
		});

		await (orchestrator as any).applyEvent(event);

		expect(upsertedVersions).toEqual([2]);
		expect((await storage.get<{ id: string }>("lastSyncCursor"))?.id).toBe(
			"evt_own",
		);
		orchestrator.dispose();
	});

	test("does not discard earlier events for the same Item before advancing", async () => {
		const storage = new MemoryStorage();
		const processed: string[] = [];
		const orchestrator = new SyncOrchestrator({
			syncManager: { clientId: "self_client", storage },
			apiClient: testApiClient({
				changes: async () => ({
					events: [
						buildEvent({ id: "evt_1", entityId: "item_1" }),
						buildEvent({ id: "evt_2", entityId: "item_1" }),
					],
					hasMore: false,
					requiresFullRefresh: false,
					cursor: { id: "evt_2" },
				}),
			}),
			itemCache: stubItemCache(),
			itemCacheAccountId: "account_a",
			outboundQueue: new OutboundQueue(storage, "self_client"),
			onEventProcessed: async (event) => {
				processed.push(event.id);
			},
		});

		await (orchestrator as any).runCatchUp();

		expect(processed).toEqual(["evt_1", "evt_2"]);
		expect((await storage.get<{ id: string }>("lastSyncCursor"))?.id).toBe(
			"evt_2",
		);
		orchestrator.dispose();
	});

	test("coalesces a ping during catch-up into a follow-up pass", async () => {
		const storage = new MemoryStorage();
		const outboundQueue = new OutboundQueue(storage, "self_client");
		const firstPage = Promise.withResolvers<void>();
		let changesCalls = 0;
		const orchestrator = new SyncOrchestrator({
			syncManager: { clientId: "self_client", storage },
			apiClient: testApiClient({
				changes: async () => {
					changesCalls += 1;
					if (changesCalls === 1) await firstPage.promise;
					return {
						events: [],
						hasMore: false,
						requiresFullRefresh: false,
						cursor: { id: `evt_${changesCalls}` },
					};
				},
			}),
			itemCache: stubItemCache(),
			itemCacheAccountId: "account_a",
			outboundQueue,
		});

		const catchUp = (orchestrator as any).runCatchUp();
		await Promise.resolve();
		await (orchestrator as any).runCatchUp();
		firstPage.resolve();
		await catchUp;

		expect(changesCalls).toBe(2);
		expect((await storage.get<{ id: string }>("lastSyncCursor"))?.id).toBe(
			"evt_2",
		);
		orchestrator.dispose();
	});

	test("calls onSyncPing when receiving sync ping event", async () => {
		const storage = new MemoryStorage();
		let pingCount = 0;

		const manager = createSyncManager({
			clientId: "self_client",
			openSyncEvents: async () => new Response(),
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

	test("opens SSE through the supplied account transport", async () => {
		const storage = new MemoryStorage();
		let receivedSignal: AbortSignal | undefined;
		const manager = createSyncManager({
			clientId: "self_client",
			storage,
			openSyncEvents: async (signal) => {
				receivedSignal = signal;
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.close();
						},
					}),
					{ status: 200 },
				);
			},
		});

		await manager.connect();
		expect(receivedSignal).toBeInstanceOf(AbortSignal);
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
			clientId: "self_client",
			openSyncEvents: async () => new Response(),
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
				encryptionVersion: 1,
				encryptedByUserId: "user_1",
			},
			baseVersion: 3,
			accountEmail: "alice@example.com",
			accountId: "account-alice",
			timestamp: 3,
			retryCount: 0,
		});

		const operations: string[] = [];
		queue.compact();
		await queue.drain(() =>
			outboundApiClient({
				update: async () => {
					operations.push("update");
				},
				trash: async () => {
					operations.push("delete");
				},
				deletePermanently: async () => {
					operations.push("permanent_delete");
				},
				restore: async () => {
					operations.push("restore");
				},
				move: async () => {
					operations.push("move");
				},
				setFavorite: async () => {
					operations.push("toggle_favorite");
				},
			}),
		);

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
			const recordItem = async (itemId: string) => {
				perAccountItemIds.get(accountId)?.push(itemId);
			};
			return outboundApiClient({
				update: recordItem,
				trash: recordItem,
				deletePermanently: recordItem,
				restore: recordItem,
				move: recordItem,
				setFavorite: recordItem,
			});
		});

		expect(perAccountItemIds.get("account-first")).toEqual(["item_1"]);
		expect(perAccountItemIds.get("account-second")).toEqual(["item_2"]);
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

function conflictError(status: 409 | 412): ApiError {
	return new ApiError(
		{
			type: "https://bittery.com/problems/conflict",
			title: "Conflict",
			status,
			code: status === 409 ? "CONFLICT" : "PRECONDITION_FAILED",
		},
		null,
	);
}

describe("outbound queue multi-account drain isolation", () => {
	test("a conflicted encrypted command does not block later Item commands", async () => {
		const queue = new OutboundQueue(new MemoryStorage(), "self_client");
		const encryptedPayload = {
			encryptedData: "local_cipher",
			encryptionIv: "local_iv",
			encryptionAlgorithm: "AES-GCM-AAD-V1",
			encryptionVersion: 1,
			encryptedByUserId: "user_1",
		};
		await queue.enqueue(
			buildDeleteMutation("account_a", "item_a", {
				id: "conflicting-edit",
				type: "update",
				encryptedPayload,
			}),
		);
		await queue.enqueue(
			buildDeleteMutation("account_a", "item_a", {
				id: "later-favorite",
				type: "toggle_favorite",
				favorite: true,
				timestamp: 2,
			}),
		);
		await queue.enqueue(
			buildDeleteMutation("account_a", "item_a", {
				id: "later-edit",
				type: "update",
				encryptedPayload,
				timestamp: 3,
			}),
		);

		const operations: string[] = [];
		let updateAttempts = 0;
		const client = outboundApiClient({
			update: async () => {
				updateAttempts += 1;
				operations.push(`update-${updateAttempts}`);
				if (updateAttempts === 1) throw conflictError(412);
			},
			setFavorite: async () => {
				operations.push("favorite");
			},
		}) as any;
		client.items.get = async (itemId: string) =>
			apiResult(
				serverEncryptedItem({
					id: itemId,
					vaultId: "vault_1",
					category: "login",
					favorite: false,
					encryptedData: "server_cipher",
					encryptionIv: "server_iv",
					encryptionAlgorithm: "AES-GCM-AAD-V1",
					encryptionVersion: 1,
					encryptedByUserId: "user_1",
					version: 2,
					lastModifiedBy: "other_user",
					createdAt: "2026-08-01T00:00:00.000Z",
					updatedAt: "2026-08-02T00:00:00.000Z",
					deletedAt: null,
					attachments: [],
				}),
			);

		await queue.drain(() => client);

		expect(operations).toEqual(["update-1", "favorite", "update-2"]);
		expect(queue.getCommands("account_a")).toMatchObject([
			{ id: "conflicting-edit", status: "conflicted" },
		]);
	});

	test("client creation failure schedules the first runnable command after terminal history", async () => {
		const storage = new AtomicMemoryStorage();
		await storage.set("bittery_pending_mutation_queues_v3", {
			account_a: [
				buildDeleteMutation("account_a", "item_a", {
					id: "conflicted-history",
					status: "conflicted",
					lastError: "content conflict",
				}),
				buildDeleteMutation("account_a", "item_b", {
					id: "failed-history",
					status: "failed",
					lastError: "retry limit reached",
					timestamp: 2,
				}),
				buildDeleteMutation("account_a", "item_b", {
					id: "runnable-command",
					timestamp: 3,
				}),
			],
		});
		const queue = new OutboundQueue(storage, "self_client");
		await queue.restore();

		await queue.drain(async () => {
			throw new Error("client unavailable");
		});

		expect(queue.getCommands("account_a")).toMatchObject([
			{
				id: "conflicted-history",
				status: "conflicted",
				lastError: "content conflict",
				retryCount: 0,
			},
			{
				id: "failed-history",
				status: "failed",
				lastError: "retry limit reached",
				retryCount: 0,
			},
			{
				id: "runnable-command",
				status: "retrying",
				lastError: "client unavailable",
				retryCount: 1,
			},
		]);
	});

	test("restores a durable command from the queue document", async () => {
		const storage = new AtomicMemoryStorage();
		const writer = new OutboundQueue(storage, "tab_a");

		await writer.enqueue(buildDeleteMutation("account_a", "item_a"));

		const restarted = new OutboundQueue(storage, "tab_b");
		await restarted.restore();
		expect(restarted.getCommands("account_a")).toHaveLength(1);
		expect(restarted.getPendingForItem("item_a")?.status).toBe("pending");
	});

	test("removes the queue document after acknowledging its last account command", async () => {
		const storage = new MemoryStorage();
		const queue = new OutboundQueue(storage, "self_client");
		await queue.enqueue(buildDeleteMutation("account_a", "item_a"));

		await queue.drain(() => outboundApiClient());

		expect(await storage.get("bittery_pending_mutation_queues_v3")).toBeNull();
	});

	test("resumes a durable cross-account move through the semantic executor", async () => {
		const storage = new AtomicMemoryStorage();
		const writer = new OutboundQueue(storage, "tab_a");
		await writer.enqueue(
			buildDeleteMutation("account_a", "item_a", {
				id: "transfer_a",
				operationId: "transfer_a",
				type: "cross_account_move",
				targetAccountId: "account_b",
				targetVaultId: "vault_b",
				targetItemId: "item_b",
				category: "login",
				encryptedPayload: {
					encryptedData: "target_ciphertext",
					encryptionIv: "target_iv",
					encryptionAlgorithm: "AES-GCM-AAD-V1",
					encryptionVersion: 1,
					encryptedByUserId: "user_1",
				},
			}),
		);

		const executed: string[] = [];
		const restarted = new OutboundQueue(storage, "tab_b", {
			apply: async () => undefined,
			executeSemanticCommand: async (command) => {
				executed.push(command.operationId ?? command.id);
				return { entityId: command.entityId, etag: '"3"', version: 3 };
			},
			acknowledge: async () => undefined,
		});
		await restarted.restore();
		await restarted.drain(() => outboundApiClient());

		expect(executed).toEqual(["transfer_a"]);
		expect(restarted.getPendingCount()).toBe(0);
	});

	test("enqueue resolves only after the command is durably persisted", async () => {
		const storage = new GatedStorage();
		const queue = new OutboundQueue(storage, "self_client");
		let resolved = false;
		const enqueue = queue
			.enqueue(buildDeleteMutation("account_a", "item_a"))
			.then(() => {
				resolved = true;
			});

		await storage.writeStarted;
		expect(resolved).toBe(false);
		storage.release();
		await enqueue;

		const restored = new OutboundQueue(storage, "self_client");
		await restored.restore();
		expect(restored.hasPendingForItem("item_a")).toBe(true);
	});

	test("marks a cloned durable applying snapshot pending after projection", async () => {
		const storage = new AtomicMemoryStorage();
		const queue = new OutboundQueue(storage, "self_client", {
			apply: async () => undefined,
			acknowledge: async () => undefined,
		});

		await queue.enqueue(buildDeleteMutation("account_a", "item_a"));

		expect(queue.getPendingForItem("item_a")?.status).toBe("pending");
		const restarted = new OutboundQueue(storage, "other_client");
		await restarted.restore();
		expect(restarted.getPendingForItem("item_a")?.status).toBe("pending");
	});

	test("does not drain a command before its optimistic projection finishes", async () => {
		const projection = Promise.withResolvers<void>();
		const storage = new MemoryStorage();
		const queue = new OutboundQueue(storage, "self_client");
		let requests = 0;
		const enqueue = queue.enqueue(
			buildDeleteMutation("account_a", "item_a"),
			async () => projection.promise,
		);
		await queue.whenPersisted();

		await queue.drain(() =>
			outboundApiClient({
				trash: async () => {
					requests += 1;
				},
			}),
		);
		expect(requests).toBe(0);

		projection.resolve();
		await enqueue;
		await queue.drain(() =>
			outboundApiClient({
				trash: async () => {
					requests += 1;
				},
			}),
		);
		expect(requests).toBe(1);
	});

	test("replays a crashed applying command before making it drainable", async () => {
		const storage = new MemoryStorage();
		await storage.set("bittery_pending_mutation_queues_v3", {
			account_a: [
				{
					...buildDeleteMutation("account_a", "item_a"),
					status: "applying",
				},
			],
		});
		const applied: string[] = [];
		const queue = new OutboundQueue(storage, "self_client", {
			apply: async (command) => {
				applied.push(command.entityId);
			},
			acknowledge: async () => undefined,
		});

		await queue.restore();

		expect(applied).toEqual(["item_a"]);
		expect(queue.getCommands("account_a")[0]?.status).toBe("pending");
	});

	test("keeps a staged worker command durable and undrainable across worker restart until popup activation", async () => {
		const storage = new AtomicMemoryStorage();
		let projected = 0;
		const writer = new OutboundQueue(storage, "worker", {
			apply: async () => {
				projected += 1;
			},
			acknowledge: async () => undefined,
		});
		await writer.stage(buildDeleteMutation("account_a", "item_a"));
		const queue = new OutboundQueue(storage, "restarted-worker", {
			apply: async () => {
				projected += 1;
			},
			acknowledge: async () => undefined,
		});
		await queue.restore();
		expect(await queue.claimStaged("popup-a", 30_000)).toHaveLength(1);
		let requests = 0;
		await queue.drain(() => {
			requests += 1;
			return outboundApiClient();
		});

		expect(projected).toBe(0);
		expect(requests).toBe(0);
		expect(queue.getPendingForItem("item_a")?.status).toBe("staged");

		await queue.activate("account_a", "m_account_a_item_a", "popup-a");

		expect(projected).toBe(1);
		expect(queue.getPendingForItem("item_a")?.status).toBe("pending");
	});

	test("cancels a rejected staged projection durably without an HTTP write", async () => {
		const storage = new AtomicMemoryStorage();
		const queue = new OutboundQueue(storage, "worker");
		await queue.stage(buildDeleteMutation("account_a", "item_a"));
		expect(await queue.claimStaged("popup-a", 30_000)).toHaveLength(1);
		await queue.cancel("account_a", "m_account_a_item_a", "popup-a");
		let requests = 0;
		await queue.drain(() => {
			requests += 1;
			return outboundApiClient();
		});
		const restarted = new OutboundQueue(storage, "restarted-worker");
		await restarted.restore();

		expect(requests).toBe(0);
		expect(restarted.getPendingCount()).toBe(0);
	});

	test("a staged command blocks later active commands for the same Item", async () => {
		const queue = new OutboundQueue(new MemoryStorage(), "worker");
		await queue.stage(buildDeleteMutation("account_a", "item_a"));
		await queue.enqueue(
			buildDeleteMutation("account_a", "item_a", {
				id: "later-command",
				timestamp: 2,
			}),
		);
		expect(await queue.claimStaged("popup-a", 30_000)).toHaveLength(1);
		expect(await queue.claimStaged("popup-b", 30_000)).toHaveLength(0);
		let requests = 0;
		const client = outboundApiClient({
			trash: async () => {
				requests += 1;
			},
		});

		await queue.drain(() => client);
		expect(requests).toBe(0);

		await queue.activate("account_a", "m_account_a_item_a", "popup-a");
		await queue.drain(() => client);
		expect(requests).toBe(2);
	});

	test("an expired popup claim can be recovered without duplicate projection", async () => {
		let now = 1_000;
		const queue = new OutboundQueue(
			new MemoryStorage(),
			"worker",
			undefined,
			() => now,
		);
		await queue.stage(buildDeleteMutation("account_a", "item_a"));

		expect(await queue.claimStaged("popup-a", 100)).toHaveLength(1);
		expect(await queue.claimStaged("popup-b", 100)).toHaveLength(0);
		now = 1_101;
		expect(await queue.claimStaged("popup-b", 100)).toHaveLength(1);
		expect(
			await queue.activate("account_a", "m_account_a_item_a", "popup-a"),
		).toBe(false);
		expect(
			await queue.activate("account_a", "m_account_a_item_a", "popup-b"),
		).toBe(true);
	});

	test("does not grant a second initial enqueue ownership of an existing operation", async () => {
		const queue = new OutboundQueue(new MemoryStorage(), "worker");
		const command = buildDeleteMutation("account_a", "item_a");

		expect(
			await queue.stage(command, { id: "popup-a", expiresAt: 30_000 }),
		).toBe(true);
		expect(
			await queue.stage(command, { id: "popup-b", expiresAt: 30_000 }),
		).toBe(false);
		expect(queue.getPendingForItem("item_a")?.projectionClaimId).toBe(
			"popup-a",
		);
	});

	test("merges concurrent tab writes and acknowledgements without losing commands", async () => {
		const storage = new AtomicMemoryStorage();
		const firstTab = new OutboundQueue(storage, "tab_a");
		const secondTab = new OutboundQueue(storage, "tab_b");
		await Promise.all([
			firstTab.enqueue(buildDeleteMutation("account_a", "item_a")),
			secondTab.enqueue(buildDeleteMutation("account_a", "item_b")),
		]);
		const request = Promise.withResolvers<void>();
		const requested = Promise.withResolvers<void>();
		const sent: string[] = [];
		const drain = firstTab.drain(() =>
			outboundApiClient({
				trash: async (itemId) => {
					sent.push(itemId);
					requested.resolve();
					await request.promise;
				},
			}),
		);
		await requested.promise;
		await secondTab.enqueue(
			buildDeleteMutation("account_a", "item_c", { timestamp: 2 }),
		);
		request.resolve();
		await drain;

		const restarted = new OutboundQueue(storage, "tab_c");
		await restarted.restore();
		const durable = restarted
			.getCommands("account_a")
			.map((command) => command.entityId);
		expect([...sent, ...durable].sort()).toEqual([
			"item_a",
			"item_b",
			"item_c",
		]);
		expect(new Set([...sent, ...durable]).size).toBe(3);
	});

	test("does not resurrect an acknowledged command from a stale tab snapshot", async () => {
		const storage = new AtomicMemoryStorage();
		const seed = new OutboundQueue(storage, "seed");
		await seed.enqueue(buildDeleteMutation("account_a", "acknowledged_item"));

		const drainingTab = new OutboundQueue(storage, "tab_a");
		const discarded: string[] = [];
		const staleTab = new OutboundQueue(storage, "tab_b", {
			apply: async () => undefined,
			discardAcknowledgedElsewhere: async (command) => {
				discarded.push(command.entityId);
			},
			acknowledge: async () => undefined,
		});
		await Promise.all([drainingTab.restore(), staleTab.restore()]);

		await drainingTab.drain(() => outboundApiClient());
		await staleTab.enqueue(
			buildDeleteMutation("account_a", "new_item", {
				id: "new-operation",
				operationId: "new-operation",
				timestamp: 2,
			}),
		);

		const restarted = new OutboundQueue(storage, "tab_c");
		await restarted.restore();

		expect(
			restarted.getCommands("account_a").map((command) => command.entityId),
		).toEqual(["new_item"]);
		expect(discarded).toEqual(["acknowledged_item"]);
	});

	test("does not overwrite another tab's newer retry attempt with a stale snapshot", async () => {
		const storage = new AtomicMemoryStorage();
		const writer = new OutboundQueue(storage, "tab_a");
		await writer.enqueue(buildDeleteMutation("account_a", "shared_item"));
		const staleTab = new OutboundQueue(storage, "tab_b");
		await staleTab.restore();

		await storage.update<Record<string, PendingMutation[]>>(
			"bittery_pending_mutation_queues_v3",
			(current) => {
				const command = current?.account_a?.[0];
				if (!current || !command) throw new Error("missing durable command");
				command.baseVersion = 2;
				command.attemptId = "newer-attempt";
				command.retryCount = 1;
				command.status = "retrying";
				return current;
			},
		);
		await staleTab.enqueue(
			buildDeleteMutation("account_a", "new_item", {
				id: "new-operation",
				operationId: "new-operation",
				timestamp: 2,
			}),
		);

		const restarted = new OutboundQueue(storage, "tab_c");
		await restarted.restore();
		const shared = restarted.getPendingForItem("shared_item");
		expect(shared?.baseVersion).toBe(2);
		expect(shared?.attemptId).toBe("newer-attempt");
		expect(shared?.status).toBe("retrying");
	});

	test("compaction preserves semantic command order", async () => {
		const queue = new OutboundQueue(new MemoryStorage(), "self_client");
		const commands: PendingMutation[] = [
			buildDeleteMutation("account_a", "item_a", {
				id: "edit_1",
				type: "update",
				encryptedPayload: {
					encryptedData: "cipher_1",
					encryptionIv: "iv_1",
					encryptionAlgorithm: "AES-GCM-AAD-V1",
					encryptionVersion: 1,
					encryptedByUserId: "user_1",
				},
			}),
			buildDeleteMutation("account_a", "item_a", {
				id: "trash",
				type: "delete",
				timestamp: 2,
			}),
			buildDeleteMutation("account_a", "item_a", {
				id: "forever",
				type: "permanent_delete",
				timestamp: 3,
			}),
			buildDeleteMutation("account_a", "item_b", {
				id: "trash_b",
				type: "delete",
				timestamp: 4,
			}),
			buildDeleteMutation("account_a", "item_b", {
				id: "restore_b",
				type: "restore",
				timestamp: 5,
			}),
		];
		for (const command of commands) await queue.enqueue(command);
		queue.compact();

		const sent: string[] = [];
		await queue.drain(() =>
			outboundApiClient({
				update: async () => {
					sent.push("edit_1");
				},
				trash: async (itemId) => {
					sent.push(`trash:${itemId}`);
				},
				deletePermanently: async () => {
					sent.push("forever");
				},
				restore: async () => {
					sent.push("restore_b");
				},
			}),
		);

		expect(sent).toEqual([
			"edit_1",
			"trash:item_a",
			"forever",
			"trash:item_b",
			"restore_b",
		]);
	});

	test("compaction retains repeated encrypted edits and moves", async () => {
		const queue = new OutboundQueue(new MemoryStorage(), "self_client");
		for (const [index, type] of [
			"update",
			"update",
			"move",
			"move",
		].entries()) {
			await queue.enqueue(
				buildDeleteMutation("account_a", "item_a", {
					id: `${type}_${index}`,
					type: type as "update" | "move",
					targetVaultId: type === "move" ? `vault_${index}` : undefined,
					encryptedPayload: {
						encryptedData: `cipher_${index}`,
						encryptionIv: `iv_${index}`,
						encryptionAlgorithm: "AES-GCM-AAD-V1",
						encryptionVersion: 1,
						encryptedByUserId: "user_1",
					},
					timestamp: index,
				}),
			);
		}
		queue.compact();
		const sent: string[] = [];

		await queue.drain(() =>
			outboundApiClient({
				update: async () => {
					sent.push("update");
				},
				move: async () => {
					sent.push("move");
				},
			}),
		);

		expect(sent).toEqual(["update", "update", "move", "move"]);
	});

	test("adopts an acknowledgement ETag for the next Item command", async () => {
		const queue = new OutboundQueue(new MemoryStorage(), "self_client");
		await queue.enqueue(
			buildDeleteMutation("account_a", "item_a", { id: "trash" }),
		);
		await queue.enqueue(
			buildDeleteMutation("account_a", "item_a", {
				id: "forever",
				type: "permanent_delete",
				timestamp: 2,
			}),
		);
		const requests: TestWriteOptions[] = [];
		const client = outboundApiClient() as any;
		client.items.trash = async (_id: string, options: TestWriteOptions) => {
			requests.push(options);
			return { ...apiResult({}), etag: '"2"' };
		};
		client.items.deletePermanently = async (
			_id: string,
			options: TestWriteOptions,
		) => {
			requests.push(options);
			return { ...apiResult({}), etag: '"3"' };
		};

		await queue.drain(() => client);

		expect(requests[0]).toEqual({ etag: '"1"', idempotencyKey: "trash" });
		expect(requests[1]?.etag).toBe('"2"');
		expect(requests[1]?.idempotencyKey).not.toBe("forever");
	});

	for (const [storageKind, createStorage] of [
		["atomic update", () => new AtomicMemoryStorage()],
		["memory update", () => new MemoryStorage()],
	] as const) {
		for (const terminalStatus of ["conflicted", "failed"] as const) {
			test(`ACK chaining with ${storageKind} preserves later ${terminalStatus} history`, async () => {
				const queue = new OutboundQueue(createStorage(), "self_client");
				await queue.enqueue(
					buildDeleteMutation("account_a", "item_a", {
						id: "acknowledged-command",
					}),
				);
				await queue.enqueue(
					buildDeleteMutation("account_a", "item_a", {
						id: "terminal-history",
						baseVersion: 7,
						attemptId: "terminal-attempt",
						status: terminalStatus,
						lastError: "terminal reason",
						timestamp: 2,
					}),
				);
				const client = outboundApiClient() as any;
				client.items.trash = async () => ({
					...apiResult({}),
					etag: '"2"',
				});

				await queue.drain(() => client);

				expect(queue.getCommands("account_a")).toMatchObject([
					{
						id: "terminal-history",
						baseVersion: 7,
						attemptId: "terminal-attempt",
						status: terminalStatus,
						lastError: "terminal reason",
					},
				]);
			});
		}
	}

	/**
	 * Favourite/trash/restore advance the server's `version` without resealing ciphertext, so the
	 * local projection lags. Rebasing a chained edit onto the acknowledged version makes the
	 * server stamp an `encryption_version` the ciphertext was never sealed under: the GCM AAD no
	 * longer verifies and the Item is permanently undecryptable.
	 */
	for (const [storageKind, createStorage] of [
		["atomic update", () => new AtomicMemoryStorage()],
		["memory update", () => new MemoryStorage()],
	] as const) {
		test(`does not rebase a chained ciphertext command onto a metadata ACK (${storageKind})`, async () => {
			const queue = new OutboundQueue(createStorage(), "self_client", {
				apply: async () => undefined,
				acknowledge: async () => undefined,
				preserveConflict: async () => undefined,
			});
			await queue.enqueue(
				buildDeleteMutation("account_a", "item_a", {
					id: "favorite",
					type: "toggle_favorite",
					favorite: true,
					baseVersion: 1,
				}),
			);
			await queue.enqueue(
				buildDeleteMutation("account_a", "item_a", {
					id: "edit",
					type: "update",
					baseVersion: 1,
					timestamp: 2,
					encryptedPayload: {
						encryptedData: "offline_cipher",
						encryptionIv: "offline_iv",
						encryptionAlgorithm: "AES-GCM-AAD-V1",
						// Sealed against the version the CAS-guarded write would land on.
						encryptionVersion: 2,
						encryptedByUserId: "user_1",
					},
				}),
			);

			// Stands in for the server: CAS on `version`, and `encryption_version` follows it only
			// for writes that carry ciphertext.
			let version = 1;
			let encryptionVersion = 1;
			const stampedEncryptionVersions: number[] = [];
			const requireCas = (options: TestWriteOptions) => {
				if (options.etag !== `"${version}"`) throw conflictError(412);
			};
			const client = outboundApiClient() as any;
			client.items.get = async () => ({
				...apiResult(
					serverEncryptedItem({
						id: "item_a",
						vaultId: "vault_1",
						category: "login",
						favorite: true,
						encryptedData: "server_cipher",
						encryptionIv: "server_iv",
						encryptionAlgorithm: "AES-GCM-AAD-V1",
						version,
						encryptionVersion,
						encryptedByUserId: "user_1",
						lastModifiedBy: "user_1",
						createdAt: "2026-08-01T00:00:00.000Z",
						updatedAt: "2026-08-02T00:00:00.000Z",
						deletedAt: null,
						attachments: [],
					}),
				),
				etag: `"${version}"`,
			});
			client.items.setFavorite = async (
				_itemId: string,
				_input: unknown,
				options: TestWriteOptions,
			) => {
				requireCas(options);
				version += 1;
				return { ...apiResult({}), etag: `"${version}"` };
			};
			client.items.update = async (
				_itemId: string,
				_input: unknown,
				options: TestWriteOptions,
			) => {
				requireCas(options);
				version += 1;
				encryptionVersion = version;
				stampedEncryptionVersions.push(encryptionVersion);
				return {
					...apiResult({ success: true, version }),
					etag: `"${version}"`,
				};
			};

			await queue.drain(() => client);
			await queue.drain(() => client);

			expect(
				stampedEncryptionVersions.filter((stamped) => stamped !== 2),
			).toEqual([]);
			expect(queue.getCommands("account_a")).toMatchObject([
				{ id: "edit", baseVersion: 1, status: "conflicted" },
			]);
		});
	}

	test("reconciles an acknowledgement before removing its durable command", async () => {
		let pendingDuringAcknowledgement = -1;
		const acknowledgements: Array<{
			operationId: string;
			entityId: string;
			version: number | undefined;
		}> = [];
		const queue = new OutboundQueue(new MemoryStorage(), "self_client", {
			apply: async () => undefined,
			acknowledge: async (command, acknowledgement) => {
				pendingDuringAcknowledgement = queue.getPendingCount();
				acknowledgements.push({
					operationId: command.operationId ?? command.id,
					entityId: acknowledgement.entityId,
					version: acknowledgement.version,
				});
			},
		});
		await queue.enqueue(
			buildDeleteMutation("account_a", "item_a", { id: "trash" }),
		);
		const client = outboundApiClient() as any;
		client.items.trash = async () => ({ ...apiResult({}), etag: '"2"' });

		await queue.drain(() => client);

		expect(pendingDuringAcknowledgement).toBe(1);
		expect(acknowledgements).toEqual([
			{ operationId: "trash", entityId: "item_a", version: 2 },
		]);
		expect(queue.getPendingCount()).toBe(0);
	});

	test("omits server-derived encryption context from ciphertext update and move HTTP requests", async () => {
		const acknowledgements: Array<{
			type: string;
			baseVersion: number;
			aadVersion: number | undefined;
			serverVersion: number | undefined;
		}> = [];
		const queue = new OutboundQueue(new MemoryStorage(), "self_client", {
			apply: async () => undefined,
			acknowledge: async (command, acknowledgement) => {
				acknowledgements.push({
					type: command.type,
					baseVersion: command.baseVersion,
					aadVersion: command.encryptedPayload?.encryptionVersion,
					serverVersion: acknowledgement.version,
				});
			},
		});
		const encryptedPayload = {
			encryptedData: "new_ciphertext",
			encryptionIv: "new_iv",
			encryptionAlgorithm: "AES-GCM-AAD-V1",
			encryptionVersion: 7,
			encryptedByUserId: "local_author",
		};
		await queue.enqueue(
			buildDeleteMutation("account_a", "updated_item", {
				type: "update",
				baseVersion: 6,
				encryptedPayload,
			}),
		);
		await queue.enqueue(
			buildDeleteMutation("account_a", "moved_item", {
				type: "move",
				baseVersion: 6,
				targetVaultId: "vault_2",
				encryptedPayload,
			}),
		);
		const requests = new Map<
			string,
			{ input: Record<string, unknown>; options: TestWriteOptions }
		>();
		const client = outboundApiClient() as any;
		client.items.update = async (
			itemId: string,
			input: Record<string, unknown>,
			options: TestWriteOptions,
		) => {
			requests.set(itemId, { input, options });
			return { ...apiResult({ success: true, version: 7 }), etag: '"7"' };
		};
		client.items.move = async (
			itemId: string,
			input: Record<string, unknown>,
			options: TestWriteOptions,
		) => {
			requests.set(itemId, { input, options });
			return { ...apiResult({ success: true, version: 7 }), etag: '"7"' };
		};

		await queue.drain(() => client);

		expect(requests.get("updated_item")?.input).toEqual({
			encryptedData: "new_ciphertext",
			encryptionIv: "new_iv",
			encryptionAlgorithm: "AES-GCM-AAD-V1",
		});
		expect(requests.get("moved_item")?.input).toEqual({
			sourceVaultId: "vault_1",
			targetVaultId: "vault_2",
			encryptedData: "new_ciphertext",
			encryptionIv: "new_iv",
			encryptionAlgorithm: "AES-GCM-AAD-V1",
		});
		expect(requests.get("updated_item")?.options.etag).toBe('"6"');
		expect(requests.get("moved_item")?.options.etag).toBe('"6"');
		expect(acknowledgements).toEqual([
			{ type: "update", baseVersion: 6, aadVersion: 7, serverVersion: 7 },
			{ type: "move", baseVersion: 6, aadVersion: 7, serverVersion: 7 },
		]);
	});

	test("keeps an attempt ID across a lost-response retry", async () => {
		let now = 10_000;
		const queue = new OutboundQueue(
			new MemoryStorage(),
			"self_client",
			undefined,
			() => now,
		);
		await queue.enqueue(buildDeleteMutation("account_a", "item_a"));
		const attempts: string[] = [];
		let fail = true;
		const client = outboundApiClient({
			trash: async (_id, options) => {
				attempts.push(options?.idempotencyKey ?? "");
				if (fail) throw networkError();
			},
		});

		await queue.drain(() => client);
		expect(queue.getNextRetryAt()).toBe(11_000);
		await queue.drain(() => client);
		expect(attempts).toHaveLength(1);
		now = 11_000;
		fail = false;
		await queue.drain(() => client);

		expect(attempts).toHaveLength(2);
		expect(attempts[1]).toBe(attempts[0]);
	});

	test("rotates a cross-account move attachment attempt after a network failure", async () => {
		let now = 10_000;
		const attempts: string[] = [];
		let fail = true;
		const queue = new OutboundQueue(
			new MemoryStorage(),
			"self_client",
			{
				apply: async () => undefined,
				executeSemanticCommand: async (command) => {
					attempts.push(command.attemptId ?? command.id);
					if (fail) throw networkError();
					return { entityId: command.entityId, etag: '"3"', version: 3 };
				},
				acknowledge: async () => undefined,
			},
			() => now,
		);
		await queue.enqueue(
			buildDeleteMutation("account_a", "item_a", {
				id: "move_1",
				operationId: "move_1",
				attemptId: "move_1:first-attempt",
				type: "cross_account_move",
				targetAccountId: "account_b",
				targetVaultId: "vault_b",
				targetItemId: "item_b",
			}),
		);

		await queue.drain(() => outboundApiClient());
		now = 11_000;
		fail = false;
		await queue.drain(() => outboundApiClient());

		expect(attempts).toHaveLength(2);
		expect(attempts[0]).toBe("move_1:first-attempt");
		expect(attempts[1]).not.toBe(attempts[0]);
	});

	test("rebases a metadata command after 412 with a fresh attempt ID", async () => {
		const queue = new OutboundQueue(new MemoryStorage(), "self_client");
		await queue.enqueue(buildDeleteMutation("account_a", "item_a"));
		const requests: TestWriteOptions[] = [];
		let first = true;
		const client = outboundApiClient() as any;
		client.items.get = async () => ({
			...apiResult({ id: "item_a", version: 2 }),
			etag: '"2"',
		});
		client.items.trash = async (_id: string, options: TestWriteOptions) => {
			requests.push(options);
			if (first) {
				first = false;
				throw conflictError(412);
			}
			return { ...apiResult({}), etag: '"3"' };
		};

		await queue.drain(() => client);

		expect(requests.map((request) => request.etag)).toEqual(['"1"', '"2"']);
		expect(requests[1]?.idempotencyKey).not.toBe(requests[0]?.idempotencyKey);
		expect(queue.getPendingCount()).toBe(0);
	});

	test("marks encrypted updates conflicted instead of silently rebasing", async () => {
		const authoritativeSnapshots: Array<{
			version: number;
			encryptedData: string;
		}> = [];
		const preservedCopyIds: string[] = [];
		const queue = new OutboundQueue(new MemoryStorage(), "self_client", {
			apply: async () => undefined,
			acknowledge: async () => undefined,
			preserveConflict: async (command) => {
				if (!command.conflictCopyId) return undefined;
				preservedCopyIds.push(command.conflictCopyId);
				return buildDeleteMutation("account_a", command.conflictCopyId, {
					id: `copy:${command.operationId ?? command.id}`,
					operationId: `copy:${command.operationId ?? command.id}`,
					type: "create",
					category: "login",
					baseVersion: 0,
					encryptedPayload: {
						encryptedData: "conflict_cipher",
						encryptionIv: "conflict_iv",
						encryptionAlgorithm: "AES-GCM-AAD-V1",
						encryptionVersion: 1,
						encryptedByUserId: "user_1",
					},
				});
			},
			reconcileAuthoritative: async (_command, item) => {
				authoritativeSnapshots.push({
					version: item.version,
					encryptedData: item.encryptedData,
				});
			},
		});
		await queue.enqueue(
			buildDeleteMutation("account_a", "item_a", {
				type: "update",
				encryptedPayload: {
					encryptedData: "cipher",
					encryptionIv: "iv",
					encryptionAlgorithm: "AES-GCM-AAD-V1",
					encryptionVersion: 1,
					encryptedByUserId: "user_1",
				},
			}),
		);
		let getCalls = 0;
		const client = outboundApiClient() as any;
		client.items.get = async () => {
			getCalls += 1;
			return apiResult(
				serverEncryptedItem({
					id: "item_a",
					vaultId: "vault_1",
					category: "login",
					favorite: false,
					encryptedData: "server_cipher",
					encryptionIv: "server_iv",
					encryptionAlgorithm: "AES-GCM-AAD-V1",
					version: 2,
					lastModifiedBy: "other_user",
					encryptionVersion: 2,
					encryptedByUserId: "other_user",
					createdAt: "2026-08-01T00:00:00.000Z",
					updatedAt: "2026-08-02T00:00:00.000Z",
					deletedAt: null,
					attachments: [],
				}),
			);
		};
		client.items.update = async () => {
			throw conflictError(412);
		};
		client.items.create = async (_vaultId: string, itemId: string) => ({
			...apiResult({ itemId }),
			etag: '"1"',
		});

		await queue.drain(() => client);

		expect(getCalls).toBe(1);
		expect(authoritativeSnapshots).toEqual([
			{ version: 2, encryptedData: "server_cipher" },
		]);
		expect(queue.getCommands("account_a")[0]?.status).toBe("conflicted");
		expect(preservedCopyIds).toHaveLength(1);
		expect(preservedCopyIds[0]).toBeString();
		expect(preservedCopyIds[0]).toBe(
			queue.getCommands("account_a")[0]?.conflictCopyId,
		);
	});

	test("treats a remotely deleted encrypted base as a content conflict", async () => {
		const queue = new OutboundQueue(new MemoryStorage(), "self_client");
		await queue.enqueue(
			buildDeleteMutation("account_a", "item_a", {
				type: "update",
				encryptedPayload: {
					encryptedData: "offline_cipher",
					encryptionIv: "offline_iv",
					encryptionAlgorithm: "AES-GCM-AAD-V1",
					encryptionVersion: 1,
					encryptedByUserId: "user_1",
				},
			}),
		);
		const client = outboundApiClient() as any;
		client.items.update = async () => {
			throw new ApiError(
				{
					type: "https://bittery.com/problems/not-found",
					title: "Not found",
					status: 404,
					code: "NOT_FOUND",
				},
				null,
			);
		};

		await queue.drain(() => client);

		expect(queue.getCommands("account_a")[0]?.status).toBe("conflicted");
	});

	test("sends stable idempotency keys and version ETags", async () => {
		const storage = new MemoryStorage();
		const queue = new OutboundQueue(storage, "self_client");
		queue.enqueue({
			accountId: "account_a",
			id: "mutation_create",
			type: "create",
			entityId: "item_new",
			vaultId: "vault_1",
			category: "login",
			encryptedPayload: {
				encryptedData: "cipher",
				encryptionIv: "iv",
				encryptionAlgorithm: "AES-GCM-AAD-V1",
				encryptionVersion: 1,
				encryptedByUserId: "user_1",
			},
			baseVersion: 0,
			timestamp: 1,
			retryCount: 0,
		});
		queue.enqueue({
			accountId: "account_a",
			id: "mutation_update",
			type: "update",
			entityId: "item_existing",
			vaultId: "vault_1",
			encryptedPayload: {
				encryptedData: "cipher",
				encryptionIv: "iv",
				encryptionAlgorithm: "AES-GCM-AAD-V1",
				encryptionVersion: 1,
				encryptedByUserId: "user_1",
			},
			baseVersion: 7,
			timestamp: 2,
			retryCount: 0,
		});
		const sentOptions = new Map<string, TestWriteOptions | undefined>();

		await queue.drain(() =>
			outboundApiClient({
				create: async (_itemId, options) => {
					sentOptions.set("create", options);
				},
				update: async (_itemId, options) => {
					sentOptions.set("update", options);
				},
			}),
		);

		expect(sentOptions.get("create")).toEqual({
			idempotencyKey: "mutation_create",
		});
		expect(sentOptions.get("update")).toEqual({
			etag: '"7"',
			idempotencyKey: "mutation_update",
		});
	});

	test("one account's failure does not starve other accounts' queues", async () => {
		const storage = new MemoryStorage();
		const queue = new OutboundQueue(storage, "self_client");

		// account_a sorts before account_b, so it is drained first.
		queue.enqueue(buildDeleteMutation("account_a", "item_a"));
		queue.enqueue(buildDeleteMutation("account_b", "item_b"));

		const deletedByAccount = new Map<string, string[]>();
		const makeClient = (accountId: string, shouldFail: boolean) =>
			outboundApiClient({
				trash: async (itemId) => {
					if (shouldFail) {
						throw networkError();
					}
					const done = deletedByAccount.get(accountId) ?? [];
					done.push(itemId);
					deletedByAccount.set(accountId, done);
				},
			});

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

	test("one account's client creation failure does not starve another account", async () => {
		const queue = new OutboundQueue(new MemoryStorage(), "self_client");
		await queue.enqueue(buildDeleteMutation("account_a", "item_a"));
		await queue.enqueue(buildDeleteMutation("account_b", "item_b"));
		const sent: string[] = [];

		await queue.drain((accountId) => {
			if (accountId === "account_a") throw new Error("locked account");
			return outboundApiClient({
				trash: async (id) => {
					sent.push(id);
				},
			});
		});

		expect(sent).toEqual(["item_b"]);
		expect(queue.hasPendingForItem("item_a")).toBe(true);
	});

	test("serializes concurrent drains so mutations are not double-sent", async () => {
		const storage = new MemoryStorage();
		const queue = new OutboundQueue(storage, "self_client");

		queue.enqueue(buildDeleteMutation("account_a", "item_a"));
		queue.enqueue(buildDeleteMutation("account_b", "item_b"));

		const deleteCalls: string[] = [];
		let inFlight = 0;
		let observedConcurrency = 0;
		const client = outboundApiClient({
			trash: async (itemId) => {
				inFlight += 1;
				observedConcurrency = Math.max(observedConcurrency, inFlight);
				await new Promise((resolve) => setTimeout(resolve, 5));
				deleteCalls.push(itemId);
				inFlight -= 1;
			},
		});

		// Kick off two overlapping drains against the shared queue.
		await Promise.all([queue.drain(() => client), queue.drain(() => client)]);

		// Each mutation is processed exactly once and never concurrently.
		expect(deleteCalls.sort()).toEqual(["item_a", "item_b"]);
		expect(observedConcurrency).toBe(1);
		expect(queue.getPendingCount()).toBe(0);
	});
});

describe("outbound push independence from the event stream", () => {
	function orchestratorWithQueue(
		queue: OutboundQueue,
		client: OutboundQueueApiClient,
	): SyncOrchestrator {
		return new SyncOrchestrator({
			syncManager: {
				clientId: "self_client",
				storage: new MemoryStorage(),
			},
			apiClient: testApiClient(),
			itemCache: stubItemCache(),
			itemCacheAccountId: "account_a",
			outboundQueue: queue,
			getClientForAccount: () => client,
		});
	}

	// The SSE stream is a read-path hint. Gating writes on it stranded every
	// mutation whenever the stream was down, connecting, or never opened.
	test("pushes a queued mutation while the event stream is disconnected", async () => {
		const storage = new MemoryStorage();
		const queue = new OutboundQueue(storage, "self_client");
		const trashed: string[] = [];
		const orchestrator = orchestratorWithQueue(
			queue,
			outboundApiClient({
				trash: async (itemId) => {
					trashed.push(itemId);
				},
			}),
		);

		expect(orchestrator.getStatus().connectionStatus).toBe("disconnected");
		queue.enqueue(buildDeleteMutation("account_a", "item_a"));
		await sleep(10);

		expect(trashed).toEqual(["item_a"]);
		expect(queue.getPendingCount()).toBe(0);

		orchestrator.dispose();
	});

	test("pushes a mutation enqueued while a drain is already in flight", async () => {
		const storage = new MemoryStorage();
		const queue = new OutboundQueue(storage, "self_client");
		const trashed: string[] = [];
		const orchestrator = orchestratorWithQueue(
			queue,
			outboundApiClient({
				trash: async (itemId) => {
					await sleep(10);
					trashed.push(itemId);
				},
			}),
		);

		queue.enqueue(buildDeleteMutation("account_a", "item_a"));
		await sleep(1);
		// Arrives while the first drain is still awaiting its response.
		queue.enqueue(buildDeleteMutation("account_b", "item_b"));
		await sleep(60);

		expect(trashed.sort()).toEqual(["item_a", "item_b"]);
		expect(queue.getPendingCount()).toBe(0);

		orchestrator.dispose();
	});

	// Retry bookkeeping emits a queue change, and draining on that emit re-runs
	// the same failing mutation in a tight loop (seen on WebKit, where every
	// upload failed with "ReadableStream uploading is not supported").
	test("a persistently failing mutation does not re-trigger an endless drain loop", async () => {
		const storage = new MemoryStorage();
		const queue = new OutboundQueue(storage, "self_client");
		let attempts = 0;
		const orchestrator = orchestratorWithQueue(
			queue,
			outboundApiClient({
				trash: async () => {
					attempts += 1;
					throw new Error(
						"NotSupportedError: ReadableStream uploading is not supported",
					);
				},
			}),
		);

		queue.enqueue(buildDeleteMutation("account_a", "item_a"));
		await sleep(50);

		expect(attempts).toBe(1);
		expect(queue.getPendingCount()).toBe(1);

		orchestrator.dispose();
	});

	// The extension enqueues in the popup and drains in the background worker,
	// which restores from storage. Signalling the drain before the write lands
	// makes the worker read a queue that does not contain the mutation yet.
	test("persists an enqueued mutation before whenPersisted resolves", async () => {
		const storage = new MemoryStorage();
		const queue = new OutboundQueue(storage, "self_client");

		queue.enqueue(buildDeleteMutation("account_a", "item_a"));
		await queue.whenPersisted();

		const reader = new OutboundQueue(storage, "other_client");
		await reader.restore();

		expect(reader.getPendingCount()).toBe(1);
		expect(reader.getPendingForItem("item_a")?.type).toBe("delete");
	});
});
