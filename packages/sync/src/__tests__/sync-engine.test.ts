import { describe, expect, test } from "bun:test";
import { ApiError } from "@bittery/shared/api-client";
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
		...overrides,
	};
}

class MemoryStorage implements SyncStorage {
	protected readonly data = new Map<string, unknown>();

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

class GatedStorage extends MemoryStorage {
	private releaseWrite: (() => void) | undefined;
	readonly writeStarted = new Promise<void>((resolve) => {
		this.releaseWrite = resolve;
	});
	private readonly writeGate = Promise.withResolvers<void>();

	override async set<T>(key: string, value: T): Promise<void> {
		this.releaseWrite?.();
		await this.writeGate.promise;
		await super.set(key, structuredClone(value));
	}

	release(): void {
		this.writeGate.resolve();
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
	changes?: () => Promise<{
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
			changes: async () =>
				apiResult(
					await (options.changes?.() ??
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
						Promise.resolve({
							id: itemId,
							vaultId: "vault_1",
							category: "login",
							favorite: false,
							encryptedData: "ciphertext",
							encryptionIv: "iv",
							encryptionAlgorithm: "AES-GCM-AAD-V1",
							version: 1,
							lastModifiedBy: "user_1",
							createdAt: "2026-03-13T00:00:00.000Z",
							updatedAt: "2026-03-13T00:00:00.000Z",
							deletedAt: null,
							attachments: [],
						})),
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
				getItem: async (id) => ({
					id,
					vaultId: "vault_1",
					category: "login",
					favorite: true,
					encryptedData: "ciphertext",
					encryptionIv: "iv",
					encryptionAlgorithm: "AES-GCM-AAD-V1",
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

	test("keeps an attempt ID across a lost-response retry", async () => {
		const queue = new OutboundQueue(new MemoryStorage(), "self_client");
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
		fail = false;
		await queue.drain(() => client);

		expect(attempts).toHaveLength(2);
		expect(attempts[1]).toBe(attempts[0]);
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
		const queue = new OutboundQueue(new MemoryStorage(), "self_client");
		await queue.enqueue(
			buildDeleteMutation("account_a", "item_a", {
				type: "update",
				encryptedPayload: {
					encryptedData: "cipher",
					encryptionIv: "iv",
					encryptionAlgorithm: "AES-GCM-AAD-V1",
				},
			}),
		);
		let getCalls = 0;
		const client = outboundApiClient() as any;
		client.items.get = async () => {
			getCalls += 1;
			return apiResult({ id: "item_a", version: 2 });
		};
		client.items.update = async () => {
			throw conflictError(412);
		};

		await queue.drain(() => client);

		expect(getCalls).toBe(0);
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
