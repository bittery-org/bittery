import { expect, test } from "bun:test";
import { createApiClient } from "@bittery/api-contract";
import type { CryptoPort } from "@bittery/crypto-port";
import { createStaticWasmCryptoPort } from "@bittery/crypto-port/adapters/wasm-static";
import { cachedItem as buildCachedItem } from "@bittery/shared/testing/item-fixtures";
import {
	type AccountStore,
	createAccountStore,
	createItemCache,
} from "@bittery/storage";
import {
	createInMemoryPlatformPort,
	createInMemoryRecordPort,
	type InMemoryRecordPort,
} from "@bittery/storage/testing";
import type { AccountMetadata } from "@bittery/storage/types";
import {
	buildDefaultSyncSourceId,
	ItemSyncEngine,
	NamespacedSyncStorage,
	SyncManager,
	SyncOrchestrator,
	type SyncStorage,
} from "@bittery/sync";
import type {
	CachedEncryptedItem,
	CachedVaultMetadata,
	ItemSyncCommand,
	ItemSyncReconciler,
} from "@bittery/types";
import {
	accountMetadata,
	createTestAccountStore,
	seedAccountWithSession,
} from "../testing/account-store-harness";
import type { AccountInfo } from "./account-resolver";
import { CrossAccountItemCommandExecutor } from "./cross-account-item-command-executor";
import { ItemCommands } from "./item-commands";
import { getTravelModeEnforcer } from "./travel-mode-enforcer";
import { createVaultCrypto } from "./vault-crypto";
import { type LocalVaultAccount, VaultRepository } from "./vault-repository";

const SOURCE = "acct_legacy_α:7";
const TARGET = "zz_second_account";
const SOURCE_ORIGIN = "https://source.legacy.invalid";
const TARGET_ORIGIN = "https://target.legacy.invalid";
const SOURCE_USER = "source:user";
const TARGET_USER = "target:user";
const SOURCE_VAULT = "source:vault/雪";
const TARGET_VAULT = "target:vault/目标";
const SOURCE_ITEM = "source:item/雪";
const TARGET_ITEM = "target:item/雪";
const SEMANTIC = "original-semantic-move";
const QUEUE_KEY = "bittery_pending_mutation_queues_v3";
const SOURCE_ITEM_PATH = `/api/v1/items/${encodeURIComponent(SOURCE_ITEM)}`;
const TARGET_ITEM_PATH = `/api/v1/items/${encodeURIComponent(TARGET_ITEM)}`;
const TARGET_CREATE_PATH = `/api/v1/vaults/${encodeURIComponent(TARGET_VAULT)}/items/${encodeURIComponent(TARGET_ITEM)}`;

type FrozenCrashArtifact = {
	accounts: AccountMetadata[];
	records: Array<{ collection: string; id: string; value: string }>;
	sync: Record<string, string>;
};

function stableProjectionCutRecords(records: FrozenCrashArtifact["records"]) {
	const generations = new Map<string, string>();
	for (const row of records) {
		if (row.id !== "meta") continue;
		if (!row.collection.endsWith(":meta"))
			throw new Error("Projection-cut metadata used an unexpected collection");
		const accountId = row.collection.slice(0, -":meta".length);
		const meta = JSON.parse(row.value) as {
			activeGeneration?: string;
			metadata?: { lastFullSyncAt?: number };
			nativeView?: { itemsKeyPrefix?: string; vaultsKeyPrefix?: string };
		};
		const generation = meta.activeGeneration;
		if (
			!generation ||
			typeof meta.metadata?.lastFullSyncAt !== "number" ||
			!Number.isFinite(meta.metadata.lastFullSyncAt)
		)
			throw new Error(
				"Projection-cut metadata lost generation or full-sync time",
			);
		const prefix = `record:item-cache-stage:${accountId}:${generation}:`;
		expect(meta.nativeView?.itemsKeyPrefix).toBe(`${prefix}items:`);
		expect(meta.nativeView?.vaultsKeyPrefix).toBe(`${prefix}vaults:`);
		generations.set(accountId, generation);
	}
	return records.map((row) => {
		if (row.id === "meta") {
			const accountId = row.collection.slice(0, -":meta".length);
			const meta = JSON.parse(row.value) as Record<string, unknown> & {
				metadata: Record<string, unknown>;
				nativeView: Record<string, unknown>;
			};
			return {
				...row,
				value: JSON.stringify({
					...meta,
					activeGeneration: "<generation>",
					metadata: { ...meta.metadata, lastFullSyncAt: "<time>" },
					nativeView: {
						...meta.nativeView,
						itemsKeyPrefix: `record:item-cache-stage:${accountId}:<generation>:items:`,
						vaultsKeyPrefix: `record:item-cache-stage:${accountId}:<generation>:vaults:`,
					},
				}),
			};
		}
		let collection = row.collection;
		for (const [accountId, generation] of generations) {
			const prefix = `item-cache-stage:${accountId}:${generation}:`;
			if (collection.startsWith(prefix)) {
				collection =
					`item-cache-stage:${accountId}:<generation>:` +
					collection.slice(prefix.length);
				break;
			}
		}
		return { ...row, collection };
	});
}

type AcquisitionRetryCount = 1 | 2 | 3 | 4;
type ReconciliationReadFailureCount = 1 | 2 | 3 | 4 | 5;

type SourceFreeHistory =
	| "firstAttempt"
	| "stagedBeforeProjection"
	| "applyingBeforeProjection"
	| "retryAfterAcquisitionFailure"
	| "failedAfterExhaustedAcquisitionFailures"
	| "failedAfterSemanticRejection"
	| "failedAfterAcquisitionRetriesAndSemanticRejection"
	| "failedAfterReconciliationReadFailures"
	| "failedAfterAcquisitionRetriesAndApi400"
	| "failedAfterReconciliationReadRetriesAndApi400";

// These three originally space-indented producer captures (retry acknowledgement, failed
// independent deletion, and conflicted independent copy) are byte-frozen source-adapter evidence.
// They are the only producer captures with Biome formatter overrides. Ticket91 records their
// hashes; Biome still parses/lints them but skips formatting only.
const capturedCrashArtifact = (await Bun.file(
	new URL(
		"./fixtures/legacy-cross-account-missing-source-acknowledgement.json",
		import.meta.url,
	),
).json()) as FrozenCrashArtifact;

const capturedRetryCrashArtifact = (await Bun.file(
	new URL(
		"./fixtures/legacy-cross-account-missing-source-retry-acknowledgement.json",
		import.meta.url,
	),
).json()) as FrozenCrashArtifact;

const capturedFailedIndependentDeletionArtifact = (await Bun.file(
	new URL(
		"./fixtures/legacy-cross-account-missing-source-failed-independent-deletion.json",
		import.meta.url,
	),
).json()) as FrozenCrashArtifact;

const FAILED_RETRY_SEMANTIC_REJECTION_ORACLE_PATH = new URL(
	"./fixtures/legacy-cross-account-missing-source-failed-retry-semantic-rejection.json",
	import.meta.url,
);
const FAILED_RECONCILIATION_READ_ORACLE_PATH = new URL(
	"./fixtures/legacy-cross-account-missing-source-failed-reconciliation-read.json",
	import.meta.url,
);
const FAILED_RETAINED_DEADLINE_ACQUISITION_ORACLE_PATH = new URL(
	"./fixtures/legacy-cross-account-missing-source-failed-retained-deadline-acquisition.json",
	import.meta.url,
);
const FAILED_RETAINED_DEADLINE_RECONCILIATION_ORACLE_PATH = new URL(
	"./fixtures/legacy-cross-account-missing-source-failed-retained-deadline-reconciliation-read.json",
	import.meta.url,
);
const STAGED_BEFORE_PROJECTION_ORACLE_PATH = new URL(
	"./fixtures/legacy-cross-account-missing-source-staged-before-projection.json",
	import.meta.url,
);
const APPLYING_BEFORE_PROJECTION_ORACLE_PATH = new URL(
	"./fixtures/legacy-cross-account-missing-source-applying-before-projection.json",
	import.meta.url,
);

class RawSyncStorage implements SyncStorage {
	private readonly values = new Map<string, string>();
	private heldQueueWrite:
		| {
				persisted: () => void;
				release: Promise<void>;
		  }
		| undefined;

	holdNextDurableQueueWrite() {
		if (this.heldQueueWrite) throw new Error("Queue write is already held");
		const persisted = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		this.heldQueueWrite = {
			persisted: () => persisted.resolve(),
			release: release.promise,
		};
		return {
			persisted: persisted.promise,
			release: () => release.resolve(),
		};
	}

	async get<T>(key: string): Promise<T | null> {
		const value = this.values.get(key);
		return value === undefined ? null : JSON.parse(value);
	}

	async set<T>(key: string, value: T): Promise<void> {
		this.values.set(key, JSON.stringify(value));
		if (key === QUEUE_KEY && this.heldQueueWrite) {
			// Tauri's update writes and saves before its promise completes. Hold
			// that completion after the actual raw queue bytes are visible.
			const gate = this.heldQueueWrite;
			this.heldQueueWrite = undefined;
			gate.persisted();
			await gate.release;
		}
	}

	async remove(key: string): Promise<void> {
		this.values.delete(key);
	}

	async update<T>(
		key: string,
		updater: (current: T | null) => T | null,
	): Promise<T | null> {
		const next = updater(await this.get<T>(key));
		if (next === null) await this.remove(key);
		else await this.set(key, next);
		return next === null ? null : structuredClone(next);
	}

	snapshot(): Record<string, string> {
		return Object.fromEntries(this.values.entries());
	}
}

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

async function frozenRecords(recordPort: InMemoryRecordPort) {
	return (
		await Promise.all(
			recordPort.collections().map(async (collection) =>
				(
					await recordPort.recordList(collection)
				).map(({ id, value }) => ({
					collection,
					id,
					value,
				})),
			),
		)
	)
		.flat()
		.sort((left, right) => {
			const byCollection = left.collection.localeCompare(right.collection);
			return byCollection === 0
				? left.id.localeCompare(right.id)
				: byCollection;
		});
}

async function seedVault(input: {
	account: LocalVaultAccount;
	vaultId: string;
	crypto: CryptoPort;
	storage: AccountStore;
	vaultCrypto: ReturnType<typeof createVaultCrypto>;
	vaultKeyBytes?: Uint8Array;
}) {
	const masterUnlockKey = await input.storage.getMasterUnlockKey(
		input.account.accountId,
	);
	if (!masterUnlockKey) throw new Error("Missing test master unlock key");
	const vaultKey = await input.crypto.importKey(
		input.vaultKeyBytes ?? new TextEncoder().encode(`key:${input.vaultId}`),
	);
	const encryptedVaultKey = await input.vaultCrypto.wrapVaultKeyForOwner({
		vaultKey,
		masterUnlockKey,
		vaultId: input.vaultId,
		userId: input.account.userId,
		keyVersion: 1,
	});
	await input.crypto.destroyKey(vaultKey);
	await input.storage.storeVaultKeys(
		[
			{
				vaultId: input.vaultId,
				vaultName: `${input.account.accountId} vault`,
				vaultType: "personal",
				vaultIcon: null,
				vaultImageUrl: null,
				encryptedVaultKey,
				role: "owner",
			},
		],
		input.account.accountId,
	);
	return {
		id: input.vaultId,
		name: `${input.account.accountId} vault`,
		type: "personal" as const,
		icon: null,
		imageUrl: null,
		accountId: input.account.accountId,
		accountEmail: input.account.email,
		serverUrl: input.account.serverUrl,
	} satisfies CachedVaultMetadata;
}

async function sourceItem(input: {
	crypto: CryptoPort;
	vaultCrypto: ReturnType<typeof createVaultCrypto>;
}) {
	const vaultKey = await input.vaultCrypto.getVaultKey({
		vaultId: SOURCE_VAULT,
		accountId: SOURCE,
		userId: SOURCE_USER,
	});
	if (!vaultKey) throw new Error("Missing source vault key");
	const encrypted = await input.vaultCrypto.encryptItem(
		JSON.stringify({ title: "original source" }),
		vaultKey,
		{
			vaultId: SOURCE_VAULT,
			itemId: SOURCE_ITEM,
			version: 6,
			userId: SOURCE_USER,
		},
	);
	await input.crypto.destroyKey(vaultKey);
	return buildCachedItem({
		id: SOURCE_ITEM,
		vaultId: SOURCE_VAULT,
		accountId: SOURCE,
		accountEmail: "source@legacy.invalid",
		serverUrl: SOURCE_ORIGIN,
		category: "login",
		favorite: false,
		encryptedData: encrypted.ciphertext,
		encryptionIv: encrypted.iv,
		encryptionAlgorithm: encrypted.algorithm,
		version: 6,
		lastModifiedBy: SOURCE_USER,
		encryptionVersion: 6,
		encryptedByUserId: SOURCE_USER,
		createdAt: "2026-09-21T00:00:00.000Z",
		updatedAt: "2026-09-21T00:00:00.000Z",
		deletedAt: null,
	}) satisfies CachedEncryptedItem;
}

function bootstrapRemote(input: {
	vault: CachedVaultMetadata;
	key: Pick<
		import("@bittery/storage/types").VaultKeyData,
		"vaultType" | "vaultIcon" | "vaultImageUrl" | "encryptedVaultKey" | "role"
	>;
	items: CachedEncryptedItem[];
	cursor: string;
}) {
	return {
		sync: {
			bootstrap: async (request: { phase: "vaults" | "items" }) =>
				request.phase === "vaults"
					? {
							data: {
								phase: "vaults" as const,
								vaults: [
									{
										id: input.vault.id,
										name: input.vault.name,
										vaultType: input.key.vaultType,
										icon: input.key.vaultIcon,
										imageUrl: input.key.vaultImageUrl,
										encryptedVaultKey: input.key.encryptedVaultKey,
										role: input.key.role,
									},
								],
								hasMore: false,
								syncCursor: { id: input.cursor },
							},
						}
					: {
							data: {
								phase: "items" as const,
								items: input.items.map((item) => ({
									...item,
									attachments: [],
								})),
								hasMore: false,
								syncCursor: { id: input.cursor },
							},
						},
		},
	};
}

async function driveAcquisitionRetries(input: {
	queue: ItemSyncEngine;
	syncStorage: SyncStorage;
	initialCommand: ItemSyncCommand;
	count: AcquisitionRetryCount;
	setNow: (now: number) => void;
}) {
	const { attemptId: _initialAttemptId, ...initialFields } =
		input.initialCommand;
	const attempts = new Set<string>();
	let retried: ItemSyncCommand | undefined;
	let now = 1;
	for (let retryCount = 1; retryCount <= input.count; retryCount += 1) {
		await input.queue.drain(async () => {
			throw new TypeError("network unavailable while acquiring source client");
		});
		const durable =
			await input.syncStorage.get<Record<string, ItemSyncCommand[]>>(QUEUE_KEY);
		retried = durable?.[SOURCE]?.[0];
		if (!retried) throw new Error("Acquisition failure did not remain durable");
		expect(retried).toMatchObject({
			...initialFields,
			status: "retrying",
			retryCount,
			lastError: "network unavailable while acquiring source client",
			nextAttemptAt: now + 1_000 * 2 ** (retryCount - 1),
		});
		expect(retried.attemptId).toStartWith(`${SEMANTIC}:attempt:`);
		expect(retried.attemptId).not.toBe(SEMANTIC);
		if (!retried.attemptId || attempts.has(retried.attemptId))
			throw new Error("Acquisition retry did not mint a distinct attempt");
		attempts.add(retried.attemptId);
		now = retried.nextAttemptAt ?? 0;
		input.setNow(now);
	}
	if (!retried) throw new Error("No acquisition retry was driven");
	return retried;
}

async function driveReconciliationReadFailures(input: {
	syncStorage: SyncStorage;
	initialCommand: ItemSyncCommand;
	count: ReconciliationReadFailureCount;
	setNow: (now: number) => void;
	drain: () => Promise<void>;
	requests: Array<{
		origin: string;
		method: string;
		path: string;
		operationId: string | null;
		ifMatch: string | null;
		body: string;
	}>;
}) {
	let now = 1;
	let terminal: ItemSyncCommand | undefined;
	for (let retryCount = 1; retryCount <= input.count; retryCount += 1) {
		const requestStart = input.requests.length;
		await input.drain();
		expect(input.requests.slice(requestStart)).toEqual([
			{
				origin: SOURCE_ORIGIN,
				method: "GET",
				path: SOURCE_ITEM_PATH,
				operationId: null,
				ifMatch: null,
				body: "",
			},
			{
				origin: TARGET_ORIGIN,
				method: "GET",
				path: TARGET_ITEM_PATH,
				operationId: null,
				ifMatch: null,
				body: "",
			},
			{
				origin: SOURCE_ORIGIN,
				method: "GET",
				path: SOURCE_ITEM_PATH,
				operationId: null,
				ifMatch: null,
				body: "",
			},
		]);
		const durable =
			await input.syncStorage.get<Record<string, ItemSyncCommand[]>>(QUEUE_KEY);
		terminal = durable?.[SOURCE]?.[0];
		if (!terminal)
			throw new Error("Reconciliation read failure did not remain durable");
		expect(terminal).toMatchObject({
			...input.initialCommand,
			status: retryCount === 5 ? "failed" : "retrying",
			retryCount,
			lastError: "The server could not be reached.",
		});
		expect(terminal.attemptId).toBe(SEMANTIC);
		expect(terminal.baseVersion).toBe(6);
		expect(terminal).not.toHaveProperty("conflictCopyId");
		if (retryCount < 5) {
			expect(terminal.nextAttemptAt).toBe(now + 1_000 * 2 ** (retryCount - 1));
			now = terminal.nextAttemptAt ?? 0;
			input.setNow(now);
		} else {
			expect(terminal).not.toHaveProperty("nextAttemptAt");
		}
	}
	if (!terminal) throw new Error("No reconciliation read failure was driven");
	return terminal;
}

async function captureSourceFreeCommand(
	history: SourceFreeHistory,
	acquisitionRetryCount?: AcquisitionRetryCount,
) {
	const { store: storage, crypto } = await createTestAccountStore();
	const recordPort = createInMemoryRecordPort({ recordKeyPrefix: "record:" });
	const itemCache = createItemCache({ port: recordPort });
	await itemCache.initialize();
	const sourceAccount: LocalVaultAccount = {
		accountId: SOURCE,
		email: "source@legacy.invalid",
		userId: SOURCE_USER,
		name: SOURCE,
		serverUrl: SOURCE_ORIGIN,
	};
	const targetAccount: LocalVaultAccount = {
		accountId: TARGET,
		email: "target@legacy.invalid",
		userId: TARGET_USER,
		name: TARGET,
		serverUrl: TARGET_ORIGIN,
	};
	await seedAccountWithSession(
		{ store: storage, crypto },
		accountMetadata(sourceAccount),
	);
	await seedAccountWithSession(
		{ store: storage, crypto },
		accountMetadata(targetAccount),
	);
	const vaultCrypto = createVaultCrypto({ crypto, storage });
	const [sourceVault, targetVault] = await Promise.all([
		seedVault({
			account: sourceAccount,
			vaultId: SOURCE_VAULT,
			crypto,
			storage,
			vaultCrypto,
		}),
		seedVault({
			account: targetAccount,
			vaultId: TARGET_VAULT,
			crypto,
			storage,
			vaultCrypto,
		}),
	]);
	const original = await sourceItem({ crypto, vaultCrypto });
	for (const accountId of [SOURCE, TARGET]) {
		await getTravelModeEnforcer(storage, itemCache).applyConfig(accountId, {
			enabled: false,
			hiddenVaultIds: [],
		});
	}

	const repository = new VaultRepository(
		crypto,
		vaultCrypto,
		storage,
		itemCache,
	);
	repository.setLocalActiveAccounts([sourceAccount, targetAccount]);
	const [sourceKey, targetKey] = await Promise.all([
		storage.getVaultKeys(SOURCE),
		storage.getVaultKeys(TARGET),
	]);
	const sourceVaultKey = sourceKey?.[0];
	const targetVaultKey = targetKey?.[0];
	if (!sourceVaultKey || !targetVaultKey) {
		throw new Error("Missing producer vault-key fixtures");
	}
	const sourceRemote: AccountInfo = {
		...sourceAccount,
		authToken: "source-token",
		apiClient: bootstrapRemote({
			vault: sourceVault,
			key: sourceVaultKey,
			items: [original],
			cursor: "source-bootstrap",
		}) as never,
	};
	const targetRemote: AccountInfo = {
		...targetAccount,
		authToken: "target-token",
		apiClient: bootstrapRemote({
			vault: targetVault,
			key: targetVaultKey,
			items: [],
			cursor: "target-bootstrap",
		}) as never,
	};
	await repository.hydrateRemoteAccounts([sourceRemote, targetRemote]);
	const syncStorage = new RawSyncStorage();
	const [sourceCursor, targetCursor] = await Promise.all([
		repository.initializeSyncBaseline([sourceRemote], SOURCE),
		repository.initializeSyncBaseline([targetRemote], TARGET),
	]);
	if (!sourceCursor || !targetCursor) {
		throw new Error("Completed producer bootstrap did not retain both cursors");
	}
	const checkpoint = async (
		account: LocalVaultAccount,
		cursor: { id: string },
	) => {
		const scope = `sync_source_${encodeURIComponent(
			buildDefaultSyncSourceId(account.serverUrl, account.accountId),
		)}`;
		const manager = new SyncManager({
			clientId: "legacy-source-cache-ack-crash",
			openSyncEvents: async () => new Response(),
			storage: new NamespacedSyncStorage(syncStorage, scope),
		});
		await manager.setStoredLastSyncCursor(cursor);
		return scope;
	};
	const [sourceSyncScope, targetSyncScope] = await Promise.all([
		checkpoint(sourceAccount, sourceCursor),
		checkpoint(targetAccount, targetCursor),
	]);

	const outcomes = new Map<string, unknown>();
	const requests: Array<{
		origin: string;
		method: string;
		path: string;
		operationId: string | null;
		ifMatch: string | null;
		body: string;
	}> = [];
	let source: "live" | "trashed" | "missing" = "live";
	let sourceVersion = 6;
	const api400AfterReconciliationReads =
		history === "failedAfterReconciliationReadRetriesAndApi400";
	let reconciliationReadFailuresRemaining =
		history === "failedAfterReconciliationReadFailures"
			? 5
			: api400AfterReconciliationReads
				? (acquisitionRetryCount ?? 0)
				: 0;
	let reconciliationSourceReadCount = 0;
	let terminalApi400Armed = false;
	let target:
		| {
				category: string;
				encryptedData: string;
				encryptionIv: string;
				encryptionAlgorithm: string;
		  }
		| undefined;
	let independentDeletionSyncEnabled = false;
	let independentDeletionSyncChanges = 0;
	const independentDeletionApplied = Promise.withResolvers<void>();
	const independentDeletionCursor = "source-independent-deletion";
	const fullRefreshBootstrapRequests: Array<{
		phase: "vaults" | "items";
		cursor?: string;
		limit?: number;
		syncCursor?: string;
		syncCursorCaptured?: boolean;
	}> = [];
	const fetch = async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		const path = url.pathname;
		const body = await request.text();
		const operationId = request.headers.get("Idempotency-Key");
		const ifMatch = request.headers.get("If-Match");
		requests.push({
			origin: url.origin,
			method: request.method,
			path,
			operationId,
			ifMatch,
			body,
		});
		if (
			independentDeletionSyncEnabled &&
			request.method === "GET" &&
			url.origin === SOURCE_ORIGIN &&
			path === "/api/v1/sync/events"
		) {
			return new Response(
				new ReadableStream({
					start(controller) {
						request.signal.addEventListener(
							"abort",
							() => controller.error(new DOMException("Aborted", "AbortError")),
							{ once: true },
						);
					},
				}),
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		}
		if (
			independentDeletionSyncEnabled &&
			request.method === "GET" &&
			url.origin === SOURCE_ORIGIN &&
			path === "/api/v1/sync/changes"
		) {
			independentDeletionSyncChanges += 1;
			expect(url.searchParams.get("sinceId")).toBe("source-bootstrap");
			source = "missing";
			sourceVersion = 8;
			return json({
				cursor: { id: independentDeletionCursor },
				events: [
					{
						id: independentDeletionCursor,
						type: "item_permanently_deleted",
						entityType: "item",
						entityId: SOURCE_ITEM,
						userId: SOURCE_USER,
						vaultId: SOURCE_VAULT,
						clientId: "independent-deletion-client",
						metadata: null,
						timestamp: "1789000002123",
					},
				],
				hasMore: false,
				requiresFullRefresh: false,
			});
		}
		if (
			request.method === "GET" &&
			url.origin === TARGET_ORIGIN &&
			path === TARGET_ITEM_PATH
		) {
			if (terminalApi400Armed)
				return json(
					{
						type: "https://bittery.com/problems/invalid-request",
						title: "Invalid Request",
						status: 400,
						code: "INVALID_REQUEST",
						detail: "Target Item lookup was rejected",
					},
					400,
				);
			return target
				? json({
						vaultId: TARGET_VAULT,
						...target,
					})
				: json({ status: 404, code: "NOT_FOUND" }, 404);
		}
		if (
			request.method === "GET" &&
			url.origin === SOURCE_ORIGIN &&
			path === SOURCE_ITEM_PATH
		) {
			if (
				(history === "failedAfterReconciliationReadFailures" ||
					api400AfterReconciliationReads) &&
				source === "live"
			) {
				reconciliationSourceReadCount += 1;
				if (
					reconciliationSourceReadCount % 2 === 0 &&
					reconciliationReadFailuresRemaining > 0
				) {
					reconciliationReadFailuresRemaining -= 1;
					throw new TypeError(
						"network unavailable while reading current source",
					);
				}
				return json({ version: 7, deletedAt: null });
			}
			return source === "missing"
				? json({ status: 404, code: "NOT_FOUND" }, 404)
				: json({
						version: sourceVersion,
						deletedAt: source === "trashed" ? "2026-09-21T00:00:00.000Z" : null,
					});
		}
		if (
			request.method === "GET" &&
			url.origin === SOURCE_ORIGIN &&
			path === `${SOURCE_ITEM_PATH}/attachments`
		) {
			return json({ items: [], hasMore: false, nextCursor: null });
		}
		if (!operationId)
			throw new Error(`Unexpected producer request ${request.method} ${url}`);
		if (
			request.method === "PUT" &&
			url.origin === TARGET_ORIGIN &&
			path === TARGET_CREATE_PATH &&
			operationId === `${SEMANTIC}:create-target` &&
			ifMatch === null
		) {
			if (
				history === "failedAfterSemanticRejection" ||
				history === "failedAfterAcquisitionRetriesAndSemanticRejection"
			) {
				return json({
					operationId,
					kind: "create_item",
					result: { status: "rejected", code: "vault_read_only" },
				});
			}
			target = JSON.parse(body);
			const outcome = {
				operationId,
				kind: "create_item",
				result: { status: "applied", itemId: TARGET_ITEM, version: 1 },
			};
			outcomes.set(operationId, outcome);
			return json(outcome);
		}
		if (
			request.method === "DELETE" &&
			url.origin === SOURCE_ORIGIN &&
			path === `${SOURCE_ITEM_PATH}/permanent` &&
			operationId === `${SEMANTIC}:delete-source` &&
			ifMatch === '"7"' &&
			body === "" &&
			source === "trashed" &&
			sourceVersion === 7
		) {
			source = "missing";
			sourceVersion = 8;
			const outcome = {
				operationId,
				kind: "permanently_delete_item",
				result: { status: "applied", itemId: SOURCE_ITEM, version: 8 },
			};
			outcomes.set(operationId, outcome);
			return json(outcome);
		}
		if (
			request.method === "DELETE" &&
			url.origin === SOURCE_ORIGIN &&
			path === SOURCE_ITEM_PATH &&
			operationId === `${SEMANTIC}:trash-source` &&
			ifMatch === '"6"' &&
			body === "" &&
			source === "live" &&
			sourceVersion === 6
		) {
			source = "trashed";
			sourceVersion = 7;
			const outcome = {
				operationId,
				kind: "trash_item",
				result: { status: "applied", itemId: SOURCE_ITEM, version: 7 },
			};
			outcomes.set(operationId, outcome);
			return json(outcome);
		}
		throw new Error(`Unexpected producer request ${request.method} ${url}`);
	};
	const client = (serverUrl: string) =>
		createApiClient({
			serverUrl,
			supportedApiMajors: [1],
			getClientMetadata: () => ({
				id: "legacy-source-cache-ack-crash",
				platform: "desktop",
				version: "0.5.2",
			}),
			getAccessToken: () => "test-token",
			fetch,
		});
	const sourceClient = client(SOURCE_ORIGIN);
	const targetClient = client(TARGET_ORIGIN);
	const executor = new CrossAccountItemCommandExecutor({
		crypto,
		vaultCrypto,
		getClientForAccount: async (accountId) => {
			if (accountId === SOURCE) return sourceClient;
			if (accountId === TARGET) return targetClient;
			throw new Error(`Unexpected Account ${accountId}`);
		},
	});
	const crash = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let semanticExecutions = 0;
	let acknowledgements = 0;
	let rejections = 0;
	let artifact: FrozenCrashArtifact | undefined;
	const reconciler: ItemSyncReconciler = {
		apply: (command) => repository.applyItemCommand(command),
		executeSemanticCommand: async (command) => {
			semanticExecutions += 1;
			return await executor.executeSemanticItemCommand(command);
		},
		acknowledge: async (command, acknowledgement) => {
			acknowledgements += 1;
			await repository.acknowledgeItemCommand(command, acknowledgement);
			const queue =
				await syncStorage.get<Record<string, ItemSyncCommand[]>>(QUEUE_KEY);
			if (!queue) throw new Error("Missing real queue document at crash cut");
			artifact = {
				// This is the persisted AccountStore index, rather than the local
				// LocalVaultAccount inputs used to arrange the producer fixture.
				accounts: structuredClone(await storage.getAccountsList()),
				records: structuredClone(await frozenRecords(recordPort)),
				sync: syncStorage.snapshot(),
			};
			crash.resolve();
			await release.promise;
		},
		reject: async (command, code) => {
			rejections += 1;
			await repository.rejectItemCommand(command, code);
		},
	};
	let queueNow = 1;
	const queue = new ItemSyncEngine(
		syncStorage,
		"legacy-source-cache-ack-crash",
		reconciler,
		() => queueNow,
	);
	const atStagedCut = history === "stagedBeforeProjection";
	const atApplyingCut = history === "applyingBeforeProjection";
	const claim = { id: "popup-projection-claim", expiresAt: 30_001 };
	let projectionDelegations = 0;
	const applyingWrite = atApplyingCut
		? syncStorage.holdNextDurableQueueWrite()
		: undefined;
	const ids = [TARGET_ITEM, SEMANTIC];
	const commands = new ItemCommands({
		queue: atStagedCut
			? {
					enqueue: async (command: ItemSyncCommand) => {
						expect(await queue.stage(command, claim)).toBe(true);
					},
				}
			: queue,
		repository,
		resolveUserId: async (accountId) =>
			accountId === TARGET ? TARGET_USER : SOURCE_USER,
		generateId: async () => {
			const id = ids.shift();
			if (!id) throw new Error("Unexpected command identity allocation");
			return id;
		},
		now: () => 1_789_000_000_123,
		...(atApplyingCut
			? {
					// Same actual delegate as production core-context. The storage write,
					// not this callback, owns the applying-before-projection pause.
					project: async (command: ItemSyncCommand) => {
						projectionDelegations += 1;
						await repository.applyItemCommand(command);
					},
				}
			: {}),
	});

	const commandExecution = commands.execute({
		type: "move",
		itemId: SOURCE_ITEM,
		sourceVaultId: SOURCE_VAULT,
		targetVaultId: TARGET_VAULT,
		category: "login",
		decryptedData: { title: "moved target" },
		accountId: SOURCE,
		targetAccountId: TARGET,
	});
	let initialCommand: ItemSyncCommand & {
		encryptedPayload: NonNullable<ItemSyncCommand["encryptedPayload"]>;
	};
	let cutCaptured = false;
	try {
		if (atApplyingCut) {
			await Promise.race([
				applyingWrite?.persisted,
				commandExecution.then(() => {
					throw new Error("Applying command returned before durable queue cut");
				}),
				Bun.sleep(1_000).then(() => {
					throw new Error("Timed out waiting for durable applying write");
				}),
			]);
		} else {
			await commandExecution;
		}
		const queuedAtEnqueue =
			await syncStorage.get<Record<string, ItemSyncCommand[]>>(QUEUE_KEY);
		expect(queuedAtEnqueue?.[SOURCE]).toHaveLength(1);
		const persisted = queuedAtEnqueue?.[SOURCE]?.[0];
		if (!persisted?.encryptedPayload)
			throw new Error("Real Move did not persist its encrypted target payload");
		expect(persisted).toMatchObject({
			id: SEMANTIC,
			operationId: SEMANTIC,
			attemptId: SEMANTIC,
			status: atStagedCut ? "staged" : atApplyingCut ? "applying" : "pending",
			retryCount: 0,
			accountId: SOURCE,
			accountEmail: sourceAccount.email,
			entityId: SOURCE_ITEM,
			vaultId: SOURCE_VAULT,
			targetAccountId: TARGET,
			targetVaultId: TARGET_VAULT,
			targetItemId: TARGET_ITEM,
			baseVersion: 6,
		});
		initialCommand = JSON.parse(
			JSON.stringify(persisted),
		) as typeof initialCommand;
		expect(initialCommand).not.toHaveProperty("lastError");
		expect(initialCommand).not.toHaveProperty("nextAttemptAt");
		expect(initialCommand).not.toHaveProperty("conflictCopyId");
		if (atStagedCut) {
			expect(initialCommand).toMatchObject({
				projectionClaimId: claim.id,
				projectionClaimExpiresAt: claim.expiresAt,
			});
		} else {
			expect(initialCommand).not.toHaveProperty("projectionClaimId");
			expect(initialCommand).not.toHaveProperty("projectionClaimExpiresAt");
		}

		if (atStagedCut || atApplyingCut) {
			const rawAtCut = syncStorage.snapshot()[QUEUE_KEY];
			expect(rawAtCut).toBe(JSON.stringify(queuedAtEnqueue));
			expect(await itemCache.getCachedItems(SOURCE)).toHaveLength(1);
			expect(await itemCache.getCachedItems(TARGET)).toEqual([]);
			expect(requests).toEqual([]);
			expect(semanticExecutions).toBe(0);

			expect(projectionDelegations).toBe(0);
			independentDeletionSyncEnabled = true;
			const deletionOrchestrator = new SyncOrchestrator({
				syncManager: {
					clientId: "legacy-source-cache-independent-deletion",
					storage: new NamespacedSyncStorage(syncStorage, sourceSyncScope),
				},
				apiClient: sourceClient,
				itemCache: repository,
				outboundQueue: queue,
				itemCacheAccountId: SOURCE,
				itemCacheAccountEmail: sourceAccount.email,
				itemCacheServerUrl: SOURCE_ORIGIN,
				drainOutboundQueue: false,
				onEventProcessed: async (event) => {
					expect(event.type).toBe("item_permanently_deleted");
					independentDeletionApplied.resolve();
				},
			});
			let connectingDeletionSync: Promise<void> | undefined;
			try {
				connectingDeletionSync = deletionOrchestrator.connect();
				await Promise.race([
					independentDeletionApplied.promise,
					Bun.sleep(1_000).then(() => {
						throw new Error(
							"Timed out applying independent deletion Delta Sync",
						);
					}),
				]);
				await Promise.resolve();
			} finally {
				deletionOrchestrator.dispose();
				await connectingDeletionSync;
			}
			expect(independentDeletionSyncChanges).toBe(1);
			expect(requests.map(({ method, path }) => ({ method, path }))).toEqual([
				{ method: "GET", path: "/api/v1/sync/events" },
				{ method: "GET", path: "/api/v1/sync/changes" },
			]);
			expect(source as "live" | "trashed" | "missing").toBe("missing");
			expect(sourceVersion).toBe(8);
			expect(await itemCache.getCachedItems(SOURCE)).toEqual([]);
			expect(repository.getById(SOURCE_ITEM, SOURCE)).toBeUndefined();
			expect(syncStorage.snapshot()[QUEUE_KEY]).toBe(rawAtCut);

			const sourceAbsentRemote: AccountInfo = {
				...sourceAccount,
				authToken: "source-token",
				apiClient: {
					sync: {
						bootstrap: async (request: {
							phase: "vaults" | "items";
							cursor?: string;
							limit?: number;
							syncCursor?: string;
							syncCursorCaptured?: boolean;
						}) => {
							fullRefreshBootstrapRequests.push(structuredClone(request));
							return await bootstrapRemote({
								vault: sourceVault,
								key: sourceVaultKey,
								items: [],
								cursor: independentDeletionCursor,
							}).sync.bootstrap(request);
						},
					},
				} as never,
			};
			const targetFullRefreshBootstrapRequests: Array<{
				phase: "vaults" | "items";
			}> = [];
			const targetRefreshRemote: AccountInfo = {
				...targetRemote,
				apiClient: {
					sync: {
						bootstrap: async (request: { phase: "vaults" | "items" }) => {
							targetFullRefreshBootstrapRequests.push(structuredClone(request));
							return await bootstrapRemote({
								vault: targetVault,
								key: targetVaultKey,
								items: [],
								cursor: "target-bootstrap",
							}).sync.bootstrap(request);
						},
					},
				} as never,
			};
			await repository.refreshFromServer([
				sourceAbsentRemote,
				targetRefreshRemote,
			]);
			expect(fullRefreshBootstrapRequests.map(({ phase }) => phase)).toEqual([
				"vaults",
				"items",
			]);
			expect(
				targetFullRefreshBootstrapRequests.map(({ phase }) => phase),
			).toEqual(["vaults", "items"]);
			expect(repository.isHydrating()).toBe(false);
			expect(await itemCache.getCachedItems(SOURCE)).toEqual([]);
			expect(await itemCache.getCachedItems(TARGET)).toEqual([]);
			expect(
				(await itemCache.getItemCacheMetadata(SOURCE))?.syncBaseline,
			).toEqual({
				serverUrl: SOURCE_ORIGIN,
				cursorId: independentDeletionCursor,
			});
			expect(
				(await itemCache.getItemCacheMetadata(TARGET))?.syncBaseline,
			).toEqual({
				serverUrl: TARGET_ORIGIN,
				cursorId: targetCursor.id,
			});
			expect(semanticExecutions).toBe(0);
			expect(acknowledgements).toBe(0);
			expect(rejections).toBe(0);
			expect(outcomes.size).toBe(0);
			expect(target).toBeUndefined();
			expect(syncStorage.snapshot()[QUEUE_KEY]).toBe(rawAtCut);
			const frozen: FrozenCrashArtifact = {
				accounts: structuredClone(await storage.getAccountsList()),
				records: structuredClone(await frozenRecords(recordPort)),
				sync: syncStorage.snapshot(),
			};
			expect(
				frozen.records.filter(
					(row) =>
						row.id.includes(SOURCE_ITEM) || row.value.includes(SOURCE_ITEM),
				),
			).toEqual([]);
			expect(frozen.sync[QUEUE_KEY]).toBe(rawAtCut);
			const captured = (await Bun.file(
				atStagedCut
					? STAGED_BEFORE_PROJECTION_ORACLE_PATH
					: APPLYING_BEFORE_PROJECTION_ORACLE_PATH,
			).json()) as FrozenCrashArtifact;
			const capturedCommand = JSON.parse(captured.sync[QUEUE_KEY] ?? "null")?.[
				SOURCE
			]?.[0] as ItemSyncCommand | undefined;
			if (!capturedCommand?.encryptedPayload)
				throw new Error("Frozen projection-cut oracle lost its target payload");
			const { encryptedPayload: capturedPayload, ...capturedLineage } =
				capturedCommand;
			const { encryptedPayload: freshPayload, ...freshLineage } =
				initialCommand;
			expect(capturedLineage).toEqual(freshLineage);
			expect(Object.keys(capturedPayload)).toEqual(Object.keys(freshPayload));
			expect(capturedPayload.encryptionAlgorithm).toBe(
				freshPayload.encryptionAlgorithm,
			);
			expect(capturedPayload.encryptionVersion).toBe(
				freshPayload.encryptionVersion,
			);
			expect(capturedPayload.encryptedByUserId).toBe(
				freshPayload.encryptedByUserId,
			);
			expect(capturedPayload.encryptedData).not.toBe("");
			expect(capturedPayload.encryptionIv).not.toBe("");
			expect(captured.accounts).toEqual(frozen.accounts);
			expect(Object.keys(captured.sync).sort()).toEqual(
				Object.keys(frozen.sync).sort(),
			);
			for (const [key, value] of Object.entries(frozen.sync)) {
				if (key !== QUEUE_KEY) expect(captured.sync[key]).toBe(value);
			}
			expect(captured.records.map(({ id }) => id).sort()).toEqual(
				frozen.records.map(({ id }) => id).sort(),
			);
			expect(stableProjectionCutRecords(captured.records)).toEqual(
				stableProjectionCutRecords(frozen.records),
			);
			expect(
				captured.records.filter(
					(row) =>
						row.id.includes(SOURCE_ITEM) || row.value.includes(SOURCE_ITEM),
				),
			).toEqual([]);
			cutCaptured = true;
			return;
		}
	} finally {
		if (atApplyingCut) {
			applyingWrite?.release();
			await commandExecution;
			if (cutCaptured) {
				expect(projectionDelegations).toBe(1);
				expect(await itemCache.getCachedItems(SOURCE)).toEqual([]);
				expect(repository.getById(SOURCE_ITEM, SOURCE)).toBeUndefined();
			}
		}
	}

	let retryCommand: ItemSyncCommand | undefined;
	if (history === "retryAfterAcquisitionFailure") {
		await queue.drain(async () => {
			throw new Error("network unavailable while acquiring source client");
		});
		expect(requests).toEqual([]);
		const retryQueue =
			await syncStorage.get<Record<string, ItemSyncCommand[]>>(QUEUE_KEY);
		expect(retryQueue?.[SOURCE]).toHaveLength(1);
		retryCommand = retryQueue?.[SOURCE]?.[0];
		const { attemptId: _initialAttemptId, ...initialRetryFields } =
			initialCommand;
		expect(retryCommand).toMatchObject({
			...initialRetryFields,
			status: "retrying",
			retryCount: 1,
			lastError: "network unavailable while acquiring source client",
			nextAttemptAt: 1_001,
		});
		expect(retryCommand?.attemptId).toStartWith(`${SEMANTIC}:attempt:`);
		expect(retryCommand?.attemptId).not.toBe(SEMANTIC);
		queueNow = retryCommand?.nextAttemptAt ?? 0;
	}
	const semanticRejection =
		history === "failedAfterSemanticRejection" ||
		history === "failedAfterAcquisitionRetriesAndSemanticRejection";
	const reconciliationReadFailures =
		history === "failedAfterReconciliationReadFailures";
	const retainedDeadlineApi400 =
		history === "failedAfterAcquisitionRetriesAndApi400" ||
		api400AfterReconciliationReads;
	let terminalRetryCommand: ItemSyncCommand | undefined;
	if (
		history === "failedAfterAcquisitionRetriesAndSemanticRejection" ||
		history === "failedAfterAcquisitionRetriesAndApi400"
	) {
		if (!acquisitionRetryCount)
			throw new Error("Semantic rejection retry count was not supplied");
		terminalRetryCommand = await driveAcquisitionRetries({
			queue,
			syncStorage,
			initialCommand,
			count: acquisitionRetryCount,
			setNow: (now) => {
				queueNow = now;
			},
		});
		expect(requests).toEqual([]);
	} else if (api400AfterReconciliationReads) {
		if (!acquisitionRetryCount)
			throw new Error("Reconciliation retry count was not supplied");
		terminalRetryCommand = await driveReconciliationReadFailures({
			syncStorage,
			initialCommand,
			count: acquisitionRetryCount,
			setNow: (now) => {
				queueNow = now;
			},
			drain: () => queue.drain(() => sourceClient),
			requests,
		});
		expect(reconciliationReadFailuresRemaining).toBe(0);
	}

	if (
		history === "failedAfterExhaustedAcquisitionFailures" ||
		semanticRejection ||
		reconciliationReadFailures ||
		retainedDeadlineApi400
	) {
		const { attemptId: _initialAttemptId, ...initialFailedFields } =
			initialCommand;
		if (semanticRejection) {
			await queue.drain(() => sourceClient);
			const durable =
				await syncStorage.get<Record<string, ItemSyncCommand[]>>(QUEUE_KEY);
			const rejected = durable?.[SOURCE]?.[0];
			expect(rejected).toEqual({
				...initialFailedFields,
				attemptId: terminalRetryCommand?.attemptId ?? SEMANTIC,
				status: "failed",
				retryCount: acquisitionRetryCount ?? 0,
				lastError: "Create Item Operation was rejected: vault_read_only",
			});
			expect(semanticExecutions).toBe(1);
			expect(acknowledgements).toBe(0);
			expect(rejections).toBe(1);
			expect([...outcomes.keys()]).toEqual([]);
			expect(target).toBeUndefined();
			expect(source).toBe("live");
			expect(sourceVersion).toBe(6);
			expect(requests).toEqual([
				{
					origin: SOURCE_ORIGIN,
					method: "GET",
					path: SOURCE_ITEM_PATH,
					operationId: null,
					ifMatch: null,
					body: "",
				},
				{
					origin: TARGET_ORIGIN,
					method: "GET",
					path: TARGET_ITEM_PATH,
					operationId: null,
					ifMatch: null,
					body: "",
				},
				{
					origin: SOURCE_ORIGIN,
					method: "GET",
					path: `${SOURCE_ITEM_PATH}/attachments`,
					operationId: null,
					ifMatch: null,
					body: "",
				},
				{
					origin: TARGET_ORIGIN,
					method: "PUT",
					path: TARGET_CREATE_PATH,
					operationId: `${SEMANTIC}:create-target`,
					ifMatch: null,
					body: JSON.stringify({
						category: "login",
						encryptedData: initialCommand.encryptedPayload.encryptedData,
						encryptionIv: initialCommand.encryptedPayload.encryptionIv,
						encryptionAlgorithm:
							initialCommand.encryptedPayload.encryptionAlgorithm,
					}),
				},
			]);
		} else if (retainedDeadlineApi400) {
			if (!terminalRetryCommand?.nextAttemptAt)
				throw new Error("Terminal HTTP400 had no prior durable deadline");
			const requestStart = requests.length;
			terminalApi400Armed = true;
			await queue.drain(() => sourceClient);
			expect(requests.slice(requestStart)).toEqual([
				{
					origin: SOURCE_ORIGIN,
					method: "GET",
					path: SOURCE_ITEM_PATH,
					operationId: null,
					ifMatch: null,
					body: "",
				},
				{
					origin: TARGET_ORIGIN,
					method: "GET",
					path: TARGET_ITEM_PATH,
					operationId: null,
					ifMatch: null,
					body: "",
				},
			]);
			const durable =
				await syncStorage.get<Record<string, ItemSyncCommand[]>>(QUEUE_KEY);
			expect(durable?.[SOURCE]?.[0]).toEqual({
				...terminalRetryCommand,
				status: "failed",
				lastError: "Target Item lookup was rejected",
			});
			expect(semanticExecutions).toBe(
				api400AfterReconciliationReads ? (acquisitionRetryCount ?? 0) + 1 : 1,
			);
			expect(acknowledgements).toBe(0);
			expect(rejections).toBe(0);
			expect([...outcomes.keys()]).toEqual([]);
			expect(target).toBeUndefined();
			expect(source).toBe("live");
		} else if (reconciliationReadFailures) {
			const failedAfterReconciliation = await driveReconciliationReadFailures({
				syncStorage,
				initialCommand,
				count: 5,
				setNow: (now) => {
					queueNow = now;
				},
				drain: () => queue.drain(() => sourceClient),
				requests,
			});
			expect(reconciliationReadFailuresRemaining).toBe(0);
			expect(failedAfterReconciliation.attemptId).toBe(SEMANTIC);
			expect(semanticExecutions).toBe(5);
			expect(acknowledgements).toBe(0);
			expect(rejections).toBe(0);
			expect([...outcomes.keys()]).toEqual([]);
			expect(target).toBeUndefined();
			expect(source).toBe("live");
			expect(sourceVersion).toBe(6);
		} else
			for (let retryCount = 1; retryCount <= 5; retryCount += 1) {
				await queue.drain(async () => {
					throw new Error("network unavailable while acquiring source client");
				});
				expect(requests).toEqual([]);
				const durable =
					await syncStorage.get<Record<string, ItemSyncCommand[]>>(QUEUE_KEY);
				const failedOrRetrying = durable?.[SOURCE]?.[0];
				expect(failedOrRetrying).toMatchObject({
					...initialFailedFields,
					status: retryCount === 5 ? "failed" : "retrying",
					retryCount,
					lastError: "network unavailable while acquiring source client",
				});
				expect(failedOrRetrying?.attemptId).toStartWith(`${SEMANTIC}:attempt:`);
				expect(failedOrRetrying?.attemptId).not.toBe(SEMANTIC);
				if (retryCount < 5) {
					expect(failedOrRetrying?.nextAttemptAt).toBe(
						queueNow + 1_000 * 2 ** (retryCount - 1),
					);
					queueNow = failedOrRetrying?.nextAttemptAt ?? 0;
				} else {
					expect(failedOrRetrying).not.toHaveProperty("nextAttemptAt");
				}
			}
		const failedQueue =
			await syncStorage.get<Record<string, ItemSyncCommand[]>>(QUEUE_KEY);
		const failedCommand = failedQueue?.[SOURCE]?.[0];
		if (!failedCommand) throw new Error("Failed queue row was not durable");
		if (!failedCommand.encryptedPayload)
			throw new Error("Failed queue row omitted its encrypted target payload");
		expect(failedCommand).toEqual({
			...initialFailedFields,
			attemptId: failedCommand.attemptId,
			status: "failed",
			retryCount:
				semanticRejection || retainedDeadlineApi400
					? (acquisitionRetryCount ?? 0)
					: 5,
			lastError: semanticRejection
				? "Create Item Operation was rejected: vault_read_only"
				: retainedDeadlineApi400
					? "Target Item lookup was rejected"
					: reconciliationReadFailures
						? "The server could not be reached."
						: "network unavailable while acquiring source client",
			...(retainedDeadlineApi400
				? { nextAttemptAt: terminalRetryCommand?.nextAttemptAt }
				: {}),
		});

		const reopenedRepository = new VaultRepository(
			crypto,
			vaultCrypto,
			storage,
			itemCache,
		);
		reopenedRepository.setLocalActiveAccounts([sourceAccount, targetAccount]);
		await reopenedRepository.hydrateLocalAccounts([
			sourceAccount,
			targetAccount,
		]);
		let restoredProjectionCalls = 0;
		const reopenedQueue = new ItemSyncEngine(
			syncStorage,
			"legacy-source-cache-ack-crash",
			{
				apply: async (command) => {
					restoredProjectionCalls += 1;
					await reopenedRepository.applyItemCommand(command);
				},
				acknowledge: async () => {
					throw new Error("A restored Failed queue row must not acknowledge");
				},
			},
			() => queueNow,
		);
		await reopenedQueue.restore();
		expect(restoredProjectionCalls).toBe(0);
		expect(reopenedQueue.getCommands(SOURCE)).toEqual([failedCommand]);
		expect(await itemCache.getCachedItems(SOURCE)).toHaveLength(1);

		const requestsBeforeIndependentDeletion = structuredClone(requests);
		independentDeletionSyncEnabled = true;
		const deletionOrchestrator = new SyncOrchestrator({
			syncManager: {
				clientId: "legacy-source-cache-independent-deletion",
				storage: new NamespacedSyncStorage(syncStorage, sourceSyncScope),
			},
			apiClient: sourceClient,
			itemCache: reopenedRepository,
			outboundQueue: reopenedQueue,
			itemCacheAccountId: SOURCE,
			itemCacheAccountEmail: sourceAccount.email,
			itemCacheServerUrl: SOURCE_ORIGIN,
			drainOutboundQueue: false,
			onEventProcessed: async (event) => {
				expect(event.type).toBe("item_permanently_deleted");
				independentDeletionApplied.resolve();
			},
		});
		const connectingDeletionSync = deletionOrchestrator.connect();
		await Promise.race([
			independentDeletionApplied.promise,
			Bun.sleep(1_000).then(() => {
				throw new Error("Timed out applying independent deletion Delta Sync");
			}),
		]);
		await Promise.resolve();
		deletionOrchestrator.dispose();
		await connectingDeletionSync;
		expect(independentDeletionSyncChanges).toBe(1);
		expect(requests.slice(requestsBeforeIndependentDeletion.length)).toEqual([
			{
				origin: SOURCE_ORIGIN,
				method: "GET",
				path: "/api/v1/sync/events",
				operationId: null,
				ifMatch: null,
				body: "",
			},
			{
				origin: SOURCE_ORIGIN,
				method: "GET",
				path: "/api/v1/sync/changes",
				operationId: null,
				ifMatch: null,
				body: "",
			},
		]);
		expect(semanticExecutions).toBe(
			semanticRejection
				? 1
				: retainedDeadlineApi400
					? api400AfterReconciliationReads
						? (acquisitionRetryCount ?? 0) + 1
						: 1
					: reconciliationReadFailures
						? 5
						: 0,
		);
		expect(acknowledgements).toBe(0);
		expect(source as "live" | "trashed" | "missing").toBe("missing");
		expect(await itemCache.getCachedItems(SOURCE)).toEqual([]);
		expect(await itemCache.getCachedItems(TARGET)).toEqual([]);
		expect(reopenedQueue.getCommands(SOURCE)).toEqual([failedCommand]);
		expect(
			await syncStorage.get<{ id: string }>(
				`${sourceSyncScope}:lastSyncCursor`,
			),
		).toEqual({ id: independentDeletionCursor });
		const durableQueueBeforeFullRefresh = structuredClone(
			await syncStorage.get<Record<string, ItemSyncCommand[]>>(QUEUE_KEY),
		);
		const sourceAbsentRemote: AccountInfo = {
			...sourceAccount,
			authToken: "source-token",
			apiClient: {
				sync: {
					bootstrap: async (request: {
						phase: "vaults" | "items";
						cursor?: string;
						limit?: number;
						syncCursor?: string;
						syncCursorCaptured?: boolean;
					}) => {
						fullRefreshBootstrapRequests.push(structuredClone(request));
						return await bootstrapRemote({
							vault: sourceVault,
							key: sourceVaultKey,
							items: [],
							cursor: independentDeletionCursor,
						}).sync.bootstrap(request);
					},
				},
			} as never,
		};
		await reopenedRepository.refreshFromServer([sourceAbsentRemote]);
		expect(fullRefreshBootstrapRequests).toEqual([
			{
				phase: "vaults",
				cursor: undefined,
				limit: 500,
				syncCursor: undefined,
				syncCursorCaptured: false,
			},
			{
				phase: "items",
				cursor: undefined,
				limit: 500,
				syncCursor: independentDeletionCursor,
				syncCursorCaptured: true,
			},
		]);
		const refreshedSourceMetadata =
			await itemCache.getItemCacheMetadata(SOURCE);
		expect(refreshedSourceMetadata?.syncBaseline).toEqual({
			serverUrl: SOURCE_ORIGIN,
			cursorId: independentDeletionCursor,
		});
		expect(
			await syncStorage.get<{
				initialized: boolean;
				cursor: { id: string } | null;
			}>(`${sourceSyncScope}:syncBaselineV1`),
		).toEqual({
			initialized: true,
			cursor: { id: independentDeletionCursor },
		});
		expect(
			await syncStorage.get<{ id: string }>(
				`${sourceSyncScope}:lastSyncCursor`,
			),
		).toEqual({ id: independentDeletionCursor });
		expect(await itemCache.getCachedItems(SOURCE)).toEqual([]);
		expect(
			await syncStorage.get<Record<string, ItemSyncCommand[]>>(QUEUE_KEY),
		).toEqual(durableQueueBeforeFullRefresh);
		expect(reopenedQueue.getCommands(SOURCE)).toEqual([failedCommand]);
		const failedArtifact: FrozenCrashArtifact = {
			accounts: structuredClone(await storage.getAccountsList()),
			records: structuredClone(await frozenRecords(recordPort)),
			sync: syncStorage.snapshot(),
		};
		const representativeOraclePath = (() => {
			switch (history) {
				case "failedAfterSemanticRejection":
					return new URL(
						"./fixtures/legacy-cross-account-missing-source-failed-semantic-rejection.json",
						import.meta.url,
					);
				case "failedAfterAcquisitionRetriesAndSemanticRejection":
					return acquisitionRetryCount === 1
						? FAILED_RETRY_SEMANTIC_REJECTION_ORACLE_PATH
						: null;
				case "failedAfterReconciliationReadFailures":
					return FAILED_RECONCILIATION_READ_ORACLE_PATH;
				case "failedAfterAcquisitionRetriesAndApi400":
					return acquisitionRetryCount === 4
						? FAILED_RETAINED_DEADLINE_ACQUISITION_ORACLE_PATH
						: null;
				case "failedAfterReconciliationReadRetriesAndApi400":
					return acquisitionRetryCount === 1
						? FAILED_RETAINED_DEADLINE_RECONCILIATION_ORACLE_PATH
						: null;
				default:
					return null;
			}
		})();
		const frozenFailedArtifact = representativeOraclePath
			? ((await Bun.file(
					representativeOraclePath,
				).json()) as FrozenCrashArtifact)
			: history === "failedAfterExhaustedAcquisitionFailures"
				? capturedFailedIndependentDeletionArtifact
				: failedArtifact;
		const capturedQueue = frozenFailedArtifact.sync[QUEUE_KEY];
		if (!capturedQueue)
			throw new Error(
				"Captured Failed producer artifact omitted its queue document",
			);
		const capturedCommand = JSON.parse(capturedQueue)[SOURCE]?.[0] as
			| Partial<ItemSyncCommand>
			| undefined;
		if (!capturedCommand?.encryptedPayload)
			throw new Error("Captured Failed producer artifact omitted its payload");
		expect(frozenFailedArtifact.accounts).toEqual(
			await storage.getAccountsList(),
		);
		expect(capturedCommand).toMatchObject({
			id: SEMANTIC,
			operationId: SEMANTIC,
			status: "failed",
			retryCount:
				semanticRejection || retainedDeadlineApi400
					? (acquisitionRetryCount ?? 0)
					: 5,
			accountId: SOURCE,
			accountEmail: sourceAccount.email,
			entityId: SOURCE_ITEM,
			vaultId: SOURCE_VAULT,
			targetAccountId: TARGET,
			targetVaultId: TARGET_VAULT,
			targetItemId: TARGET_ITEM,
			baseVersion: 6,
			lastError: semanticRejection
				? "Create Item Operation was rejected: vault_read_only"
				: retainedDeadlineApi400
					? "Target Item lookup was rejected"
					: reconciliationReadFailures
						? "The server could not be reached."
						: "network unavailable while acquiring source client",
			...(retainedDeadlineApi400
				? { nextAttemptAt: terminalRetryCommand?.nextAttemptAt }
				: {}),
		});
		if (
			(semanticRejection && acquisitionRetryCount === undefined) ||
			reconciliationReadFailures ||
			api400AfterReconciliationReads
		) {
			expect(capturedCommand.attemptId).toBe(SEMANTIC);
		} else {
			expect(capturedCommand.attemptId).toStartWith(`${SEMANTIC}:attempt:`);
			expect(capturedCommand.attemptId).not.toBe(SEMANTIC);
		}
		if (retainedDeadlineApi400) {
			expect(capturedCommand.nextAttemptAt).toBe(
				terminalRetryCommand?.nextAttemptAt,
			);
		} else {
			expect(capturedCommand).not.toHaveProperty("nextAttemptAt");
		}
		expect(Object.keys(capturedCommand)).toEqual(Object.keys(failedCommand));
		expect(Object.keys(capturedCommand.encryptedPayload)).toEqual(
			Object.keys(failedCommand.encryptedPayload),
		);
		expect(
			frozenFailedArtifact.records.filter((row) =>
				row.value.includes(SOURCE_ITEM),
			),
		).toEqual([]);
		const capturedSourceMetadata = frozenFailedArtifact.records.find(
			(row) => row.collection === `${SOURCE}:meta` && row.id === "meta",
		);
		expect(
			JSON.parse(capturedSourceMetadata?.value ?? "null")?.metadata,
		).toMatchObject({
			syncBaseline: {
				serverUrl: SOURCE_ORIGIN,
				cursorId: independentDeletionCursor,
			},
			itemCount: 0,
		});
		for (const [scope, cursor] of [
			[sourceSyncScope, { id: independentDeletionCursor }],
			[targetSyncScope, targetCursor],
		] as const) {
			expect(frozenFailedArtifact.sync[`${scope}:syncBaselineV1`]).toBe(
				JSON.stringify({ initialized: true, cursor }),
			);
			expect(frozenFailedArtifact.sync[`${scope}:lastSyncCursor`]).toBe(
				JSON.stringify(cursor),
			);
		}
		expect(JSON.parse(failedArtifact.sync[QUEUE_KEY] ?? "null")).toEqual({
			[SOURCE]: [failedCommand],
		});
		return;
	}

	const queuedBeforeDrain =
		await syncStorage.get<Record<string, ItemSyncCommand[]>>(QUEUE_KEY);
	expect(queuedBeforeDrain?.[SOURCE]).toHaveLength(1);
	const persistedAtCrash = queuedBeforeDrain?.[SOURCE]?.[0];
	const persistedJson = JSON.parse(JSON.stringify(persistedAtCrash));
	if (history === "retryAfterAcquisitionFailure") {
		expect(persistedJson).toEqual(retryCommand);
	} else {
		expect(persistedJson).toEqual(initialCommand);
	}

	const draining = queue.drain(() => sourceClient);
	try {
		await Promise.race([
			crash.promise,
			draining.then(() => {
				throw new Error(
					"Queue drained without reaching the acknowledgement cut",
				);
			}),
			Bun.sleep(1_000).then(() => {
				throw new Error("Timed out waiting for the acknowledgement cut");
			}),
		]);
		if (!artifact)
			throw new Error("Crash cut did not capture a frozen artifact");
		const targetCreateBody = JSON.stringify({
			category: "login",
			encryptedData: persistedJson.encryptedPayload.encryptedData,
			encryptionIv: persistedJson.encryptedPayload.encryptionIv,
			encryptionAlgorithm: persistedJson.encryptedPayload.encryptionAlgorithm,
		});
		expect(source as "live" | "trashed" | "missing").toBe("missing");
		expect(sourceVersion).toBe(8);
		expect(target).toEqual(JSON.parse(targetCreateBody));
		expect(requests).toEqual([
			{
				origin: SOURCE_ORIGIN,
				method: "GET",
				path: SOURCE_ITEM_PATH,
				operationId: null,
				ifMatch: null,
				body: "",
			},
			{
				origin: TARGET_ORIGIN,
				method: "GET",
				path: TARGET_ITEM_PATH,
				operationId: null,
				ifMatch: null,
				body: "",
			},
			{
				origin: SOURCE_ORIGIN,
				method: "GET",
				path: `${SOURCE_ITEM_PATH}/attachments`,
				operationId: null,
				ifMatch: null,
				body: "",
			},
			{
				origin: TARGET_ORIGIN,
				method: "PUT",
				path: TARGET_CREATE_PATH,
				operationId: `${SEMANTIC}:create-target`,
				ifMatch: null,
				body: targetCreateBody,
			},
			{
				origin: SOURCE_ORIGIN,
				method: "DELETE",
				path: SOURCE_ITEM_PATH,
				operationId: `${SEMANTIC}:trash-source`,
				ifMatch: '"6"',
				body: "",
			},
			{
				origin: SOURCE_ORIGIN,
				method: "DELETE",
				path: `${SOURCE_ITEM_PATH}/permanent`,
				operationId: `${SEMANTIC}:delete-source`,
				ifMatch: '"7"',
				body: "",
			},
		]);
		expect([...outcomes.keys()]).toEqual([
			`${SEMANTIC}:create-target`,
			`${SEMANTIC}:trash-source`,
			`${SEMANTIC}:delete-source`,
		]);
		expect(artifact.sync[QUEUE_KEY]).toBe(JSON.stringify(queuedBeforeDrain));
		expect(artifact.sync[`${sourceSyncScope}:syncBaselineV1`]).toBe(
			JSON.stringify({ initialized: true, cursor: sourceCursor }),
		);
		expect(artifact.sync[`${sourceSyncScope}:lastSyncCursor`]).toBe(
			JSON.stringify(sourceCursor),
		);
		expect(artifact.sync[`${targetSyncScope}:syncBaselineV1`]).toBe(
			JSON.stringify({ initialized: true, cursor: targetCursor }),
		);
		expect(artifact.sync[`${targetSyncScope}:lastSyncCursor`]).toBe(
			JSON.stringify(targetCursor),
		);
		const frozenArtifact =
			history === "retryAfterAcquisitionFailure"
				? capturedRetryCrashArtifact
				: capturedCrashArtifact;
		const capturedQueue = frozenArtifact.sync[QUEUE_KEY];
		if (!capturedQueue)
			throw new Error("Captured producer artifact omitted its queue document");
		const capturedCommand = JSON.parse(capturedQueue)[SOURCE]?.[0];
		expect(frozenArtifact.accounts).toEqual(await storage.getAccountsList());
		expect(capturedCommand).toMatchObject({
			id: SEMANTIC,
			operationId: SEMANTIC,
			accountId: SOURCE,
			accountEmail: sourceAccount.email,
			entityId: SOURCE_ITEM,
			vaultId: SOURCE_VAULT,
			targetAccountId: TARGET,
			targetVaultId: TARGET_VAULT,
			targetItemId: TARGET_ITEM,
			baseVersion: 6,
		});
		if (history === "retryAfterAcquisitionFailure") {
			expect(capturedCommand).toMatchObject({
				status: "retrying",
				retryCount: 1,
				lastError: "network unavailable while acquiring source client",
				nextAttemptAt: 1_001,
			});
			expect(capturedCommand.attemptId).toStartWith(`${SEMANTIC}:attempt:`);
			expect(capturedCommand.attemptId).not.toBe(SEMANTIC);
		} else {
			expect(capturedCommand).toMatchObject({
				attemptId: SEMANTIC,
				status: "pending",
				retryCount: 0,
			});
		}
		expect(Object.keys(capturedCommand)).toEqual(Object.keys(persistedJson));
		expect(Object.keys(capturedCommand.encryptedPayload)).toEqual(
			Object.keys(persistedJson.encryptedPayload),
		);
		expect(
			frozenArtifact.records.filter((row) => row.value.includes(SOURCE_ITEM)),
		).toEqual([]);
		for (const [scope, cursor] of [
			[sourceSyncScope, sourceCursor],
			[targetSyncScope, targetCursor],
		] as const) {
			expect(frozenArtifact.sync[`${scope}:syncBaselineV1`]).toBe(
				JSON.stringify({ initialized: true, cursor }),
			);
			expect(frozenArtifact.sync[`${scope}:lastSyncCursor`]).toBe(
				JSON.stringify(cursor),
			);
		}

		const sourceRows = artifact.records.filter((row) =>
			row.value.includes(SOURCE_ITEM),
		);
		expect(sourceRows).toEqual([]);
		expect(await itemCache.getCachedItems(SOURCE)).toEqual([]);
		expect(await itemCache.getCachedItems(TARGET)).toEqual([]);
		expect(await itemCache.getItemCacheMetadata(SOURCE)).not.toBeNull();
		expect(await itemCache.getItemCacheMetadata(TARGET)).not.toBeNull();
	} finally {
		release.resolve();
		await draining;
	}
	expect(await syncStorage.get(QUEUE_KEY)).toBeNull();
	const frozenQueue = artifact.sync[QUEUE_KEY];
	if (!frozenQueue)
		throw new Error("Frozen artifact omitted its queue document");
	expect(JSON.parse(frozenQueue)[SOURCE]).toEqual(queuedBeforeDrain?.[SOURCE]);
}

test.each([
	["staged", "stagedBeforeProjection"],
	["applying", "applyingBeforeProjection"],
] as const)(
	"isolated producer captures source-absent %s before projection",
	async (_label, history) => captureSourceFreeCommand(history),
);

test.each([
	["first attempt", "firstAttempt"],
	[
		"retry after a source-client acquisition failure",
		"retryAfterAcquisitionFailure",
	],
	[
		"failed after exhausted source-client acquisition failures",
		"failedAfterExhaustedAcquisitionFailures",
	],
	[
		"failed after a target Create semantic rejection",
		"failedAfterSemanticRejection",
	],
] as const)(
	"real cross-Account producer preserves a source-free queue row (%s)",
	async (_label, history) => captureSourceFreeCommand(history),
);

test.each([1, 2, 3, 4] as const)(
	"real cross-Account producer preserves Failed after %d acquisition retries and a semantic rejection",
	async (retryCount) =>
		captureSourceFreeCommand(
			"failedAfterAcquisitionRetriesAndSemanticRejection",
			retryCount,
		),
);

test("real cross-Account producer preserves Failed after five reconciliation-read failures", async () =>
	captureSourceFreeCommand("failedAfterReconciliationReadFailures"));

test.each([1, 2, 3, 4] as const)(
	"real cross-Account producer preserves Failed with a retained deadline after %d acquisition retries and HTTP400",
	async (retryCount) =>
		captureSourceFreeCommand(
			"failedAfterAcquisitionRetriesAndApi400",
			retryCount,
		),
);

test.each([1, 2, 3, 4] as const)(
	"real cross-Account producer preserves Failed with the original attempt and a retained deadline after %d reconciliation-read retries and HTTP400",
	async (retryCount) =>
		captureSourceFreeCommand(
			"failedAfterReconciliationReadRetriesAndApi400",
			retryCount,
		),
);

const CONFLICT_COPY_OPERATION = `conflict-copy:${SEMANTIC}`;
const CONFLICT_ORACLE_PATH = new URL(
	"./fixtures/legacy-cross-account-missing-source-conflicted-independent-copy.json",
	import.meta.url,
);
const CONFLICT_RETRY_ORACLE_PATH = new URL(
	"./fixtures/legacy-cross-account-missing-source-conflicted-retry-independent-copy.json",
	import.meta.url,
);
const CONFLICT_RECONCILIATION_READ_ORACLE_PATH = new URL(
	"./fixtures/legacy-cross-account-missing-source-conflicted-reconciliation-read-independent-copy.json",
	import.meta.url,
);

async function seedGenuineAccount(input: {
	storage: AccountStore;
	crypto: CryptoPort;
	account: LocalVaultAccount;
	keyByte: number;
}) {
	await input.storage.addAccount(accountMetadata(input.account));
	await input.storage.storeSecretKey(
		`secret-${input.account.accountId}`,
		input.account.accountId,
	);
	await input.storage.storeAuthToken(
		`token-${input.account.accountId}`,
		input.account.accountId,
	);
	const masterUnlockKey = await input.crypto.importKey(
		new Uint8Array(32).fill(input.keyByte),
	);
	try {
		await input.storage.storeSessionData(
			masterUnlockKey,
			input.account.accountId,
			input.account.email,
			input.account.userId,
		);
		await input.storage.setMasterUnlockKey(
			await input.crypto.cloneKey(masterUnlockKey),
			input.account.accountId,
		);
	} finally {
		await input.crypto.destroyKey(masterUnlockKey);
	}
}

async function createGenuineConflictCryptoFixture() {
	const crypto = createStaticWasmCryptoPort();
	await crypto.initialize();
	const storage = createAccountStore({
		port: createInMemoryPlatformPort({ sessionSurvivesRestart: true }),
		crypto,
	});
	await storage.initialize();
	return { crypto, storage };
}

async function captureConflictedIndependentCopy(
	input: {
		acquisitionRetryCount?: AcquisitionRetryCount;
		reconciliationReadFailureCount?: Exclude<ReconciliationReadFailureCount, 5>;
	} = {},
): Promise<FrozenCrashArtifact> {
	const acquisitionRetryCount = input.acquisitionRetryCount ?? 0;
	const reconciliationReadFailureCount =
		input.reconciliationReadFailureCount ?? 0;
	if (acquisitionRetryCount !== 0 && reconciliationReadFailureCount !== 0)
		throw new Error("Conflict fixture supports one retry precursor at a time");
	const originalRetryCount =
		acquisitionRetryCount || reconciliationReadFailureCount;
	const { storage, crypto } = await createGenuineConflictCryptoFixture();
	const recordPort = createInMemoryRecordPort({ recordKeyPrefix: "record:" });
	const itemCache = createItemCache({ port: recordPort });
	await itemCache.initialize();
	const sourceAccount: LocalVaultAccount = {
		accountId: SOURCE,
		email: "source@legacy.invalid",
		userId: SOURCE_USER,
		name: SOURCE,
		serverUrl: SOURCE_ORIGIN,
	};
	const targetAccount: LocalVaultAccount = {
		accountId: TARGET,
		email: "target@legacy.invalid",
		userId: TARGET_USER,
		name: TARGET,
		serverUrl: TARGET_ORIGIN,
	};
	await seedGenuineAccount({
		storage,
		crypto,
		account: sourceAccount,
		keyByte: 0x31,
	});
	await seedGenuineAccount({
		storage,
		crypto,
		account: targetAccount,
		keyByte: 0x32,
	});
	expect(
		(await storage.getAccountsList()).map(({ accountId, email, userId }) => ({
			accountId,
			email,
			userId,
		})),
	).toEqual([
		{ accountId: SOURCE, email: sourceAccount.email, userId: SOURCE_USER },
		{ accountId: TARGET, email: targetAccount.email, userId: TARGET_USER },
	]);
	const vaultCrypto = createVaultCrypto({ crypto, storage });
	const interoperableVaultKey = new Uint8Array(32).fill(0x47);
	const [sourceVault, targetVault] = await Promise.all([
		seedVault({
			account: sourceAccount,
			vaultId: SOURCE_VAULT,
			crypto,
			storage,
			vaultCrypto,
			vaultKeyBytes: interoperableVaultKey,
		}),
		seedVault({
			account: targetAccount,
			vaultId: TARGET_VAULT,
			crypto,
			storage,
			vaultCrypto,
			vaultKeyBytes: interoperableVaultKey,
		}),
	]);
	const original = await sourceItem({ crypto, vaultCrypto });
	for (const accountId of [SOURCE, TARGET]) {
		await getTravelModeEnforcer(storage, itemCache).applyConfig(accountId, {
			enabled: false,
			hiddenVaultIds: [],
		});
	}

	const repository = new VaultRepository(
		crypto,
		vaultCrypto,
		storage,
		itemCache,
	);
	repository.setLocalActiveAccounts([sourceAccount, targetAccount]);
	const [sourceKey, targetKey] = await Promise.all([
		storage.getVaultKeys(SOURCE),
		storage.getVaultKeys(TARGET),
	]);
	const sourceVaultKey = sourceKey?.[0];
	const targetVaultKey = targetKey?.[0];
	if (!sourceVaultKey || !targetVaultKey) {
		throw new Error("Missing genuine producer vault-key fixtures");
	}
	const sourceRemote: AccountInfo = {
		...sourceAccount,
		authToken: "source-token",
		apiClient: bootstrapRemote({
			vault: sourceVault,
			key: sourceVaultKey,
			items: [original],
			cursor: "source-bootstrap",
		}) as never,
	};
	const targetRemote: AccountInfo = {
		...targetAccount,
		authToken: "target-token",
		apiClient: bootstrapRemote({
			vault: targetVault,
			key: targetVaultKey,
			items: [],
			cursor: "target-bootstrap",
		}) as never,
	};
	await repository.hydrateRemoteAccounts([sourceRemote, targetRemote]);
	const syncStorage = new RawSyncStorage();
	const [sourceCursor, targetCursor] = await Promise.all([
		repository.initializeSyncBaseline([sourceRemote], SOURCE),
		repository.initializeSyncBaseline([targetRemote], TARGET),
	]);
	if (!sourceCursor || !targetCursor)
		throw new Error("Missing producer cursors");
	const checkpoint = async (
		account: LocalVaultAccount,
		cursor: { id: string },
	) => {
		const scope = `sync_source_${encodeURIComponent(buildDefaultSyncSourceId(account.serverUrl, account.accountId))}`;
		const manager = new SyncManager({
			clientId: "legacy-source-cache-conflict-copy",
			openSyncEvents: async () => new Response(),
			storage: new NamespacedSyncStorage(syncStorage, scope),
		});
		await manager.setStoredLastSyncCursor(cursor);
		return scope;
	};
	const [sourceSyncScope, targetSyncScope] = await Promise.all([
		checkpoint(sourceAccount, sourceCursor),
		checkpoint(targetAccount, targetCursor),
	]);

	const requests: Array<{
		origin: string;
		method: string;
		path: string;
		operationId: string | null;
		ifMatch: string | null;
		body: string;
	}> = [];
	let copyId: string | undefined;
	let independentDeletionSyncEnabled = false;
	let independentDeletionSyncChanges = 0;
	const independentDeletionApplied = Promise.withResolvers<void>();
	const independentDeletionCursor = "source-independent-deletion";
	const fullRefreshRequests: Array<{
		phase: "vaults" | "items";
		cursor?: string;
		limit?: number;
		syncCursor?: string;
		syncCursorCaptured?: boolean;
	}> = [];
	const advanced = {
		...original,
		version: 7,
		updatedAt: "2026-09-21T00:00:01.000Z",
		// Version changed, while this Server item remains sealed against its original AAD.
		encryptionVersion: 6,
	};
	let reconciliationReadFailuresRemaining = reconciliationReadFailureCount;
	let reconciliationSourceReadCount = 0;
	const fetch = async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		const body = await request.text();
		const entry = {
			origin: url.origin,
			method: request.method,
			path: url.pathname,
			operationId: request.headers.get("Idempotency-Key"),
			ifMatch: request.headers.get("If-Match"),
			body,
		};
		requests.push(entry);
		if (
			independentDeletionSyncEnabled &&
			entry.origin === SOURCE_ORIGIN &&
			entry.method === "GET" &&
			entry.path === "/api/v1/sync/events"
		) {
			return new Response(
				new ReadableStream({
					start(controller) {
						request.signal.addEventListener(
							"abort",
							() => controller.error(new DOMException("Aborted", "AbortError")),
							{ once: true },
						);
					},
				}),
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		}
		if (
			independentDeletionSyncEnabled &&
			entry.origin === SOURCE_ORIGIN &&
			entry.method === "GET" &&
			entry.path === "/api/v1/sync/changes"
		) {
			independentDeletionSyncChanges += 1;
			expect(url.searchParams.get("sinceId")).toBe("source-bootstrap");
			return json({
				cursor: { id: independentDeletionCursor },
				events: [
					{
						id: independentDeletionCursor,
						type: "item_permanently_deleted",
						entityType: "item",
						entityId: SOURCE_ITEM,
						userId: SOURCE_USER,
						vaultId: SOURCE_VAULT,
						clientId: "independent-deletion-client",
						metadata: null,
						timestamp: "1789000002123",
					},
				],
				hasMore: false,
				requiresFullRefresh: false,
			});
		}
		if (
			entry.origin === TARGET_ORIGIN &&
			entry.method === "GET" &&
			entry.path === TARGET_ITEM_PATH
		)
			return json({ status: 404, code: "NOT_FOUND" }, 404);
		if (
			entry.origin === SOURCE_ORIGIN &&
			entry.method === "GET" &&
			entry.path === SOURCE_ITEM_PATH
		) {
			if (reconciliationReadFailureCount !== 0) {
				reconciliationSourceReadCount += 1;
				if (
					reconciliationSourceReadCount % 2 === 0 &&
					reconciliationReadFailuresRemaining > 0
				) {
					reconciliationReadFailuresRemaining -= 1;
					throw new TypeError(
						"network unavailable while reading current source",
					);
				}
			}
			return json({ ...advanced, attachments: [] });
		}
		if (
			entry.origin === SOURCE_ORIGIN &&
			entry.method === "PUT" &&
			entry.path.startsWith(
				`/api/v1/vaults/${encodeURIComponent(SOURCE_VAULT)}/items/`,
			) &&
			entry.operationId === CONFLICT_COPY_OPERATION
		) {
			copyId = decodeURIComponent(
				entry.path.slice(entry.path.lastIndexOf("/") + 1),
			);
			throw new TypeError("network unavailable while creating conflict copy");
		}
		throw new Error(
			`Unexpected conflicted producer request ${entry.method} ${url}`,
		);
	};
	const client = (serverUrl: string) =>
		createApiClient({
			serverUrl,
			supportedApiMajors: [1],
			getClientMetadata: () => ({
				id: "legacy-source-cache-conflict-copy",
				platform: "desktop",
				version: "0.5.2",
			}),
			getAccessToken: () => "test-token",
			fetch,
		});
	const sourceClient = client(SOURCE_ORIGIN);
	const targetClient = client(TARGET_ORIGIN);
	const executor = new CrossAccountItemCommandExecutor({
		crypto,
		vaultCrypto,
		getClientForAccount: async (accountId) =>
			accountId === SOURCE
				? sourceClient
				: accountId === TARGET
					? targetClient
					: Promise.reject(new Error(`Unexpected Account ${accountId}`)),
	});
	let queueNow = 1;
	const reconciler: ItemSyncReconciler = {
		apply: (command) => repository.applyItemCommand(command),
		executeSemanticCommand: (command) =>
			executor.executeSemanticItemCommand(command),
		acknowledge: (command, acknowledgement) =>
			repository.acknowledgeItemCommand(command, acknowledgement),
		reconcileAuthoritative: (command, item) =>
			repository.reconcileAuthoritative(command, item),
		preserveConflict: (command) => repository.preserveItemConflict(command),
	};
	const queue = new ItemSyncEngine(
		syncStorage,
		"legacy-source-cache-conflict-copy",
		reconciler,
		() => queueNow,
	);
	const ids = [TARGET_ITEM, SEMANTIC];
	const commands = new ItemCommands({
		queue,
		repository,
		resolveUserId: async (accountId) =>
			accountId === TARGET ? TARGET_USER : SOURCE_USER,
		generateId: async () => {
			const id = ids.shift();
			if (!id) throw new Error("Unexpected command identity allocation");
			return id;
		},
		now: () => 1_789_000_000_123,
	});
	await commands.execute({
		type: "move",
		itemId: SOURCE_ITEM,
		sourceVaultId: SOURCE_VAULT,
		targetVaultId: TARGET_VAULT,
		category: "login",
		decryptedData: { title: "moved target" },
		accountId: SOURCE,
		targetAccountId: TARGET,
	});
	const initialQueue =
		await syncStorage.get<Record<string, ItemSyncCommand[]>>(QUEUE_KEY);
	const initialCommand = initialQueue?.[SOURCE]?.[0];
	if (!initialCommand)
		throw new Error("Conflicted producer did not persist its initial Move");
	let terminalRetryCommand: ItemSyncCommand | undefined;
	if (acquisitionRetryCount !== 0) {
		terminalRetryCommand = await driveAcquisitionRetries({
			queue,
			syncStorage,
			initialCommand,
			count: acquisitionRetryCount,
			setNow: (now) => {
				queueNow = now;
			},
		});
		expect(requests).toEqual([]);
	} else if (reconciliationReadFailureCount !== 0) {
		await driveReconciliationReadFailures({
			syncStorage,
			initialCommand,
			count: reconciliationReadFailureCount,
			setNow: (now) => {
				queueNow = now;
			},
			drain: () => queue.drain(() => sourceClient),
			requests,
		});
		expect(reconciliationReadFailuresRemaining).toBe(0);
	}
	const requestsBeforeConflict = requests.length;
	await queue.drain(() => sourceClient);
	const conflictedQueue =
		await syncStorage.get<Record<string, ItemSyncCommand[]>>(QUEUE_KEY);
	const rows = conflictedQueue?.[SOURCE];
	if (rows?.length !== 2 || !copyId)
		throw new Error("Real conflict preservation did not retain two rows");
	const originalCommand = rows[0];
	const copyCommand = rows[1];
	if (!originalCommand || !copyCommand)
		throw new Error("Real conflict preservation omitted a queue row");
	expect(originalCommand).toMatchObject({
		id: SEMANTIC,
		operationId: SEMANTIC,
		attemptId: terminalRetryCommand?.attemptId ?? SEMANTIC,
		status: "conflicted",
		retryCount: originalRetryCount,
		lastError: "The Item changed on another device",
		conflictCopyId: copyId,
	});
	expect(originalCommand).not.toHaveProperty("nextAttemptAt");
	expect(copyCommand).toMatchObject({
		id: CONFLICT_COPY_OPERATION,
		operationId: CONFLICT_COPY_OPERATION,
		attemptId: CONFLICT_COPY_OPERATION,
		type: "create",
		entityId: copyId,
		vaultId: SOURCE_VAULT,
		baseVersion: 0,
		status: "retrying",
		retryCount: 1,
		lastError: "The server could not be reached.",
		nextAttemptAt: queueNow + 1_000,
	});
	expect(copyCommand.encryptedPayload).toBeDefined();
	expect(requests.slice(requestsBeforeConflict, -1)).toEqual([
		{
			origin: SOURCE_ORIGIN,
			method: "GET",
			path: SOURCE_ITEM_PATH,
			operationId: null,
			ifMatch: null,
			body: "",
		},
		{
			origin: TARGET_ORIGIN,
			method: "GET",
			path: TARGET_ITEM_PATH,
			operationId: null,
			ifMatch: null,
			body: "",
		},
		{
			origin: SOURCE_ORIGIN,
			method: "GET",
			path: SOURCE_ITEM_PATH,
			operationId: null,
			ifMatch: null,
			body: "",
		},
	]);
	expect(requests.at(-1)).toMatchObject({
		origin: SOURCE_ORIGIN,
		method: "PUT",
		path: `/api/v1/vaults/${encodeURIComponent(SOURCE_VAULT)}/items/${encodeURIComponent(copyId)}`,
		operationId: CONFLICT_COPY_OPERATION,
		ifMatch: null,
	});
	expect(queue.getNextRetryAt()).toBe(queueNow + 1_000);

	const reopenedRepository = new VaultRepository(
		crypto,
		vaultCrypto,
		storage,
		itemCache,
	);
	reopenedRepository.setLocalActiveAccounts([sourceAccount, targetAccount]);
	await reopenedRepository.hydrateLocalAccounts([sourceAccount, targetAccount]);
	const restored: ItemSyncCommand[] = [];
	const reopenedQueue = new ItemSyncEngine(
		syncStorage,
		"legacy-source-cache-conflict-copy",
		{
			apply: async (command) => {
				restored.push(command);
				await reopenedRepository.applyItemCommand(command);
			},
			acknowledge: async () => {
				throw new Error("Restored conflict capture must not acknowledge");
			},
			preserveConflict: (command) =>
				reopenedRepository.preserveItemConflict(command),
			reconcileAuthoritative: (command, item) =>
				reopenedRepository.reconcileAuthoritative(command, item),
		},
		() => queueNow,
	);
	await reopenedQueue.restore();
	expect(restored).toEqual([copyCommand]);
	expect(reopenedQueue.getCommands(SOURCE)).toEqual(rows);
	expect(
		reopenedRepository.getAll(SOURCE).find((item) => item.id === copyId),
	).toMatchObject({ id: copyId, title: "original source" });
	expect(
		(await itemCache.getCachedItems(SOURCE))?.map((item) => item.id),
	).toEqual([SOURCE_ITEM]);

	const requestsBeforeIndependentDeletion = requests.length;
	independentDeletionSyncEnabled = true;
	const deletionOrchestrator = new SyncOrchestrator({
		syncManager: {
			clientId: "legacy-source-cache-independent-deletion",
			storage: new NamespacedSyncStorage(syncStorage, sourceSyncScope),
		},
		apiClient: sourceClient,
		itemCache: reopenedRepository,
		outboundQueue: reopenedQueue,
		itemCacheAccountId: SOURCE,
		itemCacheAccountEmail: sourceAccount.email,
		itemCacheServerUrl: SOURCE_ORIGIN,
		drainOutboundQueue: false,
		onEventProcessed: async (event) => {
			expect(event.type).toBe("item_permanently_deleted");
			independentDeletionApplied.resolve();
		},
	});
	const connecting = deletionOrchestrator.connect();
	await Promise.race([
		independentDeletionApplied.promise,
		Bun.sleep(1_000).then(() => {
			throw new Error("Timed out applying independent deletion Delta Sync");
		}),
	]);
	deletionOrchestrator.dispose();
	await connecting;
	expect(independentDeletionSyncChanges).toBe(1);
	expect(requests.slice(requestsBeforeIndependentDeletion)).toEqual([
		{
			origin: SOURCE_ORIGIN,
			method: "GET",
			path: "/api/v1/sync/events",
			operationId: null,
			ifMatch: null,
			body: "",
		},
		{
			origin: SOURCE_ORIGIN,
			method: "GET",
			path: "/api/v1/sync/changes",
			operationId: null,
			ifMatch: null,
			body: "",
		},
	]);
	expect(await itemCache.getCachedItems(SOURCE)).toEqual([]);
	expect(reopenedQueue.getCommands(SOURCE)).toEqual(rows);
	const durableBeforeRefresh = structuredClone(
		await syncStorage.get<Record<string, ItemSyncCommand[]>>(QUEUE_KEY),
	);
	const sourceAbsentRemote: AccountInfo = {
		...sourceAccount,
		authToken: "source-token",
		apiClient: {
			sync: {
				bootstrap: async (request: {
					phase: "vaults" | "items";
					cursor?: string;
					limit?: number;
					syncCursor?: string;
					syncCursorCaptured?: boolean;
				}) => {
					fullRefreshRequests.push(structuredClone(request));
					return await bootstrapRemote({
						vault: sourceVault,
						key: sourceVaultKey,
						items: [],
						cursor: independentDeletionCursor,
					}).sync.bootstrap(request);
				},
			},
		} as never,
	};
	await reopenedRepository.refreshFromServer([sourceAbsentRemote]);
	expect(fullRefreshRequests).toEqual([
		{
			phase: "vaults",
			cursor: undefined,
			limit: 500,
			syncCursor: undefined,
			syncCursorCaptured: false,
		},
		{
			phase: "items",
			cursor: undefined,
			limit: 500,
			syncCursor: independentDeletionCursor,
			syncCursorCaptured: true,
		},
	]);
	expect(await itemCache.getCachedItems(SOURCE)).toEqual([]);
	expect(await itemCache.getCachedItems(TARGET)).toEqual([]);
	expect(reopenedQueue.getCommands(SOURCE)).toEqual(rows);
	expect(
		await syncStorage.get<Record<string, ItemSyncCommand[]>>(QUEUE_KEY),
	).toEqual(durableBeforeRefresh);
	expect(await itemCache.getItemCacheMetadata(SOURCE)).toMatchObject({
		syncBaseline: {
			serverUrl: SOURCE_ORIGIN,
			cursorId: independentDeletionCursor,
		},
		itemCount: 0,
	});
	expect(
		await syncStorage.get<{
			initialized: boolean;
			cursor: { id: string } | null;
		}>(`${sourceSyncScope}:syncBaselineV1`),
	).toEqual({
		initialized: true,
		cursor: { id: independentDeletionCursor },
	});
	expect(
		await syncStorage.get<{ id: string }>(`${sourceSyncScope}:lastSyncCursor`),
	).toEqual({
		id: independentDeletionCursor,
	});
	expect(
		await syncStorage.get<{
			initialized: boolean;
			cursor: { id: string } | null;
		}>(`${targetSyncScope}:syncBaselineV1`),
	).toEqual({
		initialized: true,
		cursor: targetCursor,
	});
	expect(
		await syncStorage.get<{ id: string }>(`${targetSyncScope}:lastSyncCursor`),
	).toEqual(targetCursor);
	return {
		accounts: structuredClone(await storage.getAccountsList()),
		records: structuredClone(await frozenRecords(recordPort)),
		sync: syncStorage.snapshot(),
	};
}

async function assertConflictedCapture(input: {
	captured: FrozenCrashArtifact;
	artifact: FrozenCrashArtifact;
	retryCount: 0 | AcquisitionRetryCount;
	remintedAttempt: boolean;
	copyRetryAt: number;
}) {
	const rows = JSON.parse(input.captured.sync[QUEUE_KEY] ?? "null")?.[SOURCE] as
		| ItemSyncCommand[]
		| undefined;
	if (rows?.length !== 2)
		throw new Error("Frozen conflict artifact omitted its two rows");
	const original = rows[0];
	const copy = rows[1];
	if (!original || !copy)
		throw new Error("Frozen conflict artifact omitted a queue row");
	expect(original).toMatchObject({
		id: SEMANTIC,
		operationId: SEMANTIC,
		status: "conflicted",
		retryCount: input.retryCount,
		lastError: "The Item changed on another device",
	});
	if (input.remintedAttempt) {
		expect(original.attemptId).toStartWith(`${SEMANTIC}:attempt:`);
		expect(original.attemptId).not.toBe(SEMANTIC);
	} else {
		expect(original.attemptId).toBe(SEMANTIC);
	}
	expect(original.conflictCopyId).toBe(copy.entityId);
	expect(original).not.toHaveProperty("nextAttemptAt");
	expect(copy).toMatchObject({
		id: CONFLICT_COPY_OPERATION,
		operationId: CONFLICT_COPY_OPERATION,
		attemptId: CONFLICT_COPY_OPERATION,
		type: "create",
		status: "retrying",
		retryCount: 1,
		nextAttemptAt: input.copyRetryAt,
		lastError: "The server could not be reached.",
	});
	expect(copy.encryptedPayload).toBeDefined();
	expect(
		input.captured.records.filter(
			(row) =>
				row.value.includes(SOURCE_ITEM) || row.value.includes(copy.entityId),
		),
	).toEqual([]);
	expect(
		input.captured.accounts.map(({ accountId, email, userId }) => ({
			accountId,
			email,
			userId,
		})),
	).toEqual([
		{ accountId: SOURCE, email: "source@legacy.invalid", userId: SOURCE_USER },
		{ accountId: TARGET, email: "target@legacy.invalid", userId: TARGET_USER },
	]);
	expect(input.captured.accounts).toEqual(input.artifact.accounts);
	expect(Object.keys(input.captured.sync).sort()).toEqual(
		Object.keys(input.artifact.sync).sort(),
	);
}

test("real WASM producer preserves a source-free Conflicted0 Move and its retrying conflict copy", async () => {
	const artifact = await captureConflictedIndependentCopy();
	const captured = (await Bun.file(
		CONFLICT_ORACLE_PATH,
	).json()) as FrozenCrashArtifact;
	await assertConflictedCapture({
		captured,
		artifact,
		retryCount: 0,
		remintedAttempt: false,
		copyRetryAt: 1_001,
	});
});

const COPY_RETRY_AT: Record<AcquisitionRetryCount, number> = {
	1: 2_001,
	2: 4_001,
	3: 8_001,
	4: 16_001,
};

test.each([1, 2, 3, 4] as const)(
	"real WASM producer preserves Conflicted after %d acquisition retries and its retrying conflict copy",
	async (acquisitionRetryCount) => {
		const artifact = await captureConflictedIndependentCopy({
			acquisitionRetryCount,
		});
		const captured =
			acquisitionRetryCount === 4
				? ((await Bun.file(
						CONFLICT_RETRY_ORACLE_PATH,
					).json()) as FrozenCrashArtifact)
				: artifact;
		await assertConflictedCapture({
			captured,
			artifact,
			retryCount: acquisitionRetryCount,
			remintedAttempt: true,
			copyRetryAt: COPY_RETRY_AT[acquisitionRetryCount],
		});
	},
);

test.each([1, 2, 3, 4] as const)(
	"real WASM producer preserves Conflicted after %d reconciliation-read failures and its retrying conflict copy",
	async (reconciliationReadFailureCount) => {
		const artifact = await captureConflictedIndependentCopy({
			reconciliationReadFailureCount,
		});
		const captured =
			reconciliationReadFailureCount === 1
				? ((await Bun.file(
						CONFLICT_RECONCILIATION_READ_ORACLE_PATH,
					).json()) as FrozenCrashArtifact)
				: artifact;
		await assertConflictedCapture({
			captured,
			artifact,
			retryCount: reconciliationReadFailureCount,
			remintedAttempt: false,
			copyRetryAt: COPY_RETRY_AT[reconciliationReadFailureCount],
		});
	},
);
