import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import type {
	PreparedReplicaCommit,
	PreparedReplicaWrite,
	ReplicaHead,
	ReplicaStore,
} from "../generated/persistence/contract.ts";
import {
	validateReplicaPersistenceRequest,
	validateReplicaPersistenceResponse,
} from "../generated/persistence/validator.js";
import { IndexedDbReplicaExecutor } from "./indexeddb-executor.ts";

const DB_NAME = "bittery_replica";
const DB_VERSION = 7;
const PRIOR_DB_VERSION = 6;
const PRIOR_STORE_NAMES = [
	"heads",
	"optimistic_items",
	"operations",
	"attachment_move_preparations",
	"operation_receipts",
	"replica_metadata",
	"bootstrap_generations",
	"bootstrap_pages",
	"authority_vaults",
	"authority_items",
] as const;
let indexedDB: IDBFactory;

beforeEach(() => {
	indexedDB = new IDBFactory();
	Object.defineProperty(globalThis, "indexedDB", {
		configurable: true,
		value: indexedDB,
	});
});

afterEach(() => {
	Reflect.deleteProperty(globalThis, "indexedDB");
});

function executor(): IndexedDbReplicaExecutor {
	return new IndexedDbReplicaExecutor();
}

async function invoke(value: unknown, target = executor()): Promise<any> {
	return JSON.parse(await target.invoke(JSON.stringify(value)));
}

async function openRawDatabase(): Promise<IDBDatabase> {
	await invoke({ type: "load", accountId: "schema-bootstrap" });
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION);
		request.onerror = () => reject(request.error);
		request.onsuccess = () => resolve(request.result);
	});
}

async function seedHead(head: ReplicaHead): Promise<void> {
	const database = await openRawDatabase();
	const transaction = database.transaction("heads", "readwrite");
	transaction.objectStore("heads").put(head);
	await transactionDone(transaction);
	database.close();
}

async function rawDatabaseContents(): Promise<unknown[]> {
	const database = await openRawDatabase();
	const storeNames = [
		"heads",
		"optimistic_items",
		"operations",
		"attachment_move_preparations",
		"share_capabilities",
		"operation_receipts",
		"replica_metadata",
		"bootstrap_generations",
		"bootstrap_pages",
		"authority_vaults",
		"authority_items",
	];
	const transaction = database.transaction(storeNames, "readonly");
	const requests = storeNames.map((storeName) =>
		transaction.objectStore(storeName).getAll(),
	);
	const values = await Promise.all(requests.map(requestResult));
	await transactionDone(transaction);
	database.close();
	return values.flat();
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onabort = () => reject(transaction.error);
		transaction.onerror = () => reject(transaction.error);
	});
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

function put(
	store: ReplicaStore,
	recordId: string,
	payloadJson: string,
	accountId = "account-a",
): PreparedReplicaWrite {
	return {
		type: "put",
		row: { store, key: { accountId, recordId }, payloadJson },
	};
}

function prepared(
	writes: PreparedReplicaWrite[],
	expectedRevision = "0",
	nextRevision = (BigInt(expectedRevision) + 1n).toString(),
): PreparedReplicaCommit {
	return {
		expected: {
			accountId: "account-a",
			userId: "user-a",
			incarnation: "incarnation-a",
			replicaRevision: expectedRevision,
			lockEpoch: "0",
		},
		nextHead: {
			accountId: "account-a",
			userId: "user-a",
			incarnation: "incarnation-a",
			replicaRevision: nextRevision,
			lockEpoch: "0",
			failure: null,
		},
		writes,
	};
}

function commit(value: PreparedReplicaCommit) {
	return { type: "commit", prepared: value } as const;
}

function advanceLockEpoch(replicaRevision = "0", lockEpoch = "0") {
	return {
		type: "advanceLockEpoch",
		prepared: {
			expected: {
				accountId: "account-a",
				userId: "user-a",
				incarnation: "incarnation-a",
				replicaRevision,
				lockEpoch,
			},
			nextHead: {
				accountId: "account-a",
				userId: "user-a",
				incarnation: "incarnation-a",
				replicaRevision,
				lockEpoch: (BigInt(lockEpoch) + 1n).toString(),
				failure: null,
			},
		},
	} as const;
}

function install(
	incarnation = "incarnation-a",
	userId = "user-a",
	expected:
		| { type: "missing"; accountId: string }
		| {
				type: "present";
				accountId: string;
				userId: string;
				incarnation: string;
				replicaRevision: string;
				lockEpoch: string;
		  } = { type: "missing", accountId: "account-a" },
	replicaRevision = "0",
) {
	return {
		type: "install",
		prepared: {
			expected,
			nextHead: {
				accountId: "account-a",
				userId,
				incarnation,
				replicaRevision,
				lockEpoch: "0",
				failure: null,
			},
			writes: [],
		},
	} as const;
}

describe("IndexedDbReplicaExecutor", () => {
	test("upgrades v6 additively without destroying durable Replica rows or indexes", async () => {
		const priorRequest = indexedDB.open(DB_NAME, PRIOR_DB_VERSION);
		priorRequest.onupgradeneeded = () => {
			const database = priorRequest.result;
			database.createObjectStore("heads", { keyPath: "accountId" });
			for (const storeName of PRIOR_STORE_NAMES.filter(
				(name) => name !== "heads",
			)) {
				const store = database.createObjectStore(storeName, {
					keyPath: ["accountId", "recordId"],
				});
				store.createIndex("by_account", "accountId");
			}
		};
		const prior = await requestResult(priorRequest);
		const seed = prior.transaction(PRIOR_STORE_NAMES, "readwrite");
		seed.objectStore("heads").put({
			accountId: "account-a",
			userId: "user-a",
			incarnation: "incarnation-a",
			replicaRevision: "6",
			lockEpoch: "2",
			failure: null,
		});
		for (const storeName of PRIOR_STORE_NAMES.filter(
			(name) => name !== "heads",
		)) {
			seed.objectStore(storeName).put({
				accountId: "account-a",
				recordId: `${storeName}-record`,
				payloadJson: `${storeName}-opaque`,
			});
		}
		await transactionDone(seed);
		prior.close();

		const loaded = await invoke({ type: "load", accountId: "account-a" });
		expect(loaded.head).toMatchObject({
			replicaRevision: "6",
			lockEpoch: "2",
		});
		expect(loaded.rows).toHaveLength(PRIOR_STORE_NAMES.length - 1);
		expect(loaded.rows).toContainEqual({
			store: "operations",
			key: { accountId: "account-a", recordId: "operations-record" },
			payloadJson: "operations-opaque",
		});
		expect(loaded.rows).toContainEqual({
			store: "operationReceipts",
			key: {
				accountId: "account-a",
				recordId: "operation_receipts-record",
			},
			payloadJson: "operation_receipts-opaque",
		});

		const upgraded = await openRawDatabase();
		expect(upgraded.version).toBe(DB_VERSION);
		expect([...upgraded.objectStoreNames]).toContain("share_capabilities");
		const verify = upgraded.transaction(
			[...PRIOR_STORE_NAMES, "share_capabilities"],
			"readonly",
		);
		for (const storeName of PRIOR_STORE_NAMES.filter(
			(name) => name !== "heads",
		)) {
			expect([...verify.objectStore(storeName).indexNames]).toContain(
				"by_account",
			);
		}
		expect([...verify.objectStore("share_capabilities").indexNames]).toEqual([
			"by_account",
		]);
		expect(
			await requestResult(verify.objectStore("share_capabilities").getAll()),
		).toEqual([]);
		await transactionDone(verify);
		upgraded.close();
	});

	test("advances only the durable lock epoch and makes an old commit stale", async () => {
		await invoke(install());
		await invoke(commit(prepared([put("operations", "kept", "opaque")])));
		expect(await invoke(advanceLockEpoch("1"))).toEqual({
			type: "lockEpochAdvanced",
			result: { type: "applied", lockEpoch: "1" },
		});
		const loaded = await invoke({ type: "load", accountId: "account-a" });
		expect(loaded.head).toMatchObject({
			replicaRevision: "1",
			lockEpoch: "1",
		});
		expect(loaded.rows).toHaveLength(1);
		expect(await invoke(commit(prepared([], "1", "2")))).toEqual({
			type: "committed",
			result: { type: "stale", actualRevision: "1" },
		});
	});
	test("atomically replaces only the head and preserves previous rows", async () => {
		expect(await invoke(install())).toEqual({
			type: "installed",
			result: { type: "applied" },
		});
		expect(
			await invoke(
				commit(prepared([put("operations", "old-operation", "opaque")])),
			),
		).toMatchObject({ result: { type: "applied" } });

		expect(
			await invoke(
				install(
					"incarnation-b",
					"user-a",
					{
						type: "present",
						accountId: "account-a",
						userId: "user-a",
						incarnation: "incarnation-a",
						replicaRevision: "1",
						lockEpoch: "0",
					},
					"2",
				),
			),
		).toEqual({
			type: "installed",
			result: { type: "applied" },
		});
		expect(await invoke({ type: "load", accountId: "account-a" })).toEqual({
			type: "loaded",
			head: {
				accountId: "account-a",
				userId: "user-a",
				incarnation: "incarnation-b",
				replicaRevision: "2",
				lockEpoch: "0",
				failure: null,
			},
			rows: [
				{
					store: "operations",
					key: { accountId: "account-a", recordId: "old-operation" },
					payloadJson: "opaque",
				},
			],
		});
	});

	test("returns stale when the exact expected head no longer matches", async () => {
		await invoke(install());
		expect(await invoke(install("incarnation-b"))).toEqual({
			type: "installed",
			result: { type: "stale" },
		});
		expect(
			await invoke({ type: "load", accountId: "account-a" }),
		).toMatchObject({
			head: { userId: "user-a", incarnation: "incarnation-a" },
			rows: [],
		});
	});

	test("refuses a prepared commit that changes the installed User", async () => {
		await invoke(install());
		const invalid = prepared([put("operations", "forbidden", "opaque")]);
		invalid.nextHead.userId = "user-b";
		await expect(invoke(commit(invalid))).rejects.toThrow("cannot change User");
		expect(
			await invoke({ type: "load", accountId: "account-a" }),
		).toMatchObject({
			head: { userId: "user-a", replicaRevision: "0" },
			rows: [],
		});
	});

	test("loads and commits a missing account without creating it", async () => {
		expect(await invoke({ type: "load", accountId: "missing" })).toEqual({
			type: "loaded",
			head: null,
			rows: [],
		});
		expect(await invoke(commit(prepared([])))).toEqual({
			type: "committed",
			result: { type: "missing" },
		});
	});

	test("returns missing before validating unreachable Commit and lock transitions", async () => {
		const invalidCommit = prepared([
			put("operations", "", "opaque", "account-b"),
		]);
		invalidCommit.expected.accountId = "missing";
		invalidCommit.nextHead.accountId = "another-account";
		invalidCommit.nextHead.replicaRevision = "7";
		expect(await invoke(commit(invalidCommit))).toEqual({
			type: "committed",
			result: { type: "missing" },
		});

		const validLock = advanceLockEpoch();
		const invalidLock = {
			...validLock,
			prepared: {
				...validLock.prepared,
				expected: { ...validLock.prepared.expected, accountId: "missing" },
				nextHead: {
					...validLock.prepared.nextHead,
					accountId: "another-account",
					lockEpoch: "7",
				},
			},
		};
		expect(await invoke(invalidLock)).toEqual({
			type: "lockEpochAdvanced",
			result: { type: "missing" },
		});
	});

	test("returns stale before validating unreachable Install, Commit, and lock transitions", async () => {
		await invoke(install());

		const staleInstall = install("incarnation-b");
		const invalidInstall = {
			...staleInstall,
			prepared: {
				...staleInstall.prepared,
				nextHead: { ...staleInstall.prepared.nextHead, userId: "" },
				writes: [put("operations", "", "opaque", "account-b")],
			},
		};
		expect(await invoke(invalidInstall)).toEqual({
			type: "installed",
			result: { type: "stale" },
		});

		const invalidCommit = prepared([
			put("operations", "", "opaque", "account-b"),
		]);
		invalidCommit.expected.replicaRevision = "9";
		invalidCommit.nextHead.userId = "wrong-user";
		invalidCommit.nextHead.replicaRevision = "12";
		expect(await invoke(commit(invalidCommit))).toEqual({
			type: "committed",
			result: { type: "stale", actualRevision: "0" },
		});

		const staleLock = advanceLockEpoch("9");
		const invalidLock = {
			...staleLock,
			prepared: {
				...staleLock.prepared,
				nextHead: {
					...staleLock.prepared.nextHead,
					userId: "wrong-user",
					lockEpoch: "7",
				},
			},
		};
		expect(await invoke(invalidLock)).toEqual({
			type: "lockEpochAdvanced",
			result: { type: "stale" },
		});
	});

	test("validates matching Install and Commit transitions before writing", async () => {
		await invoke(install());
		const before = await invoke({ type: "load", accountId: "account-a" });

		const invalidInstall = install(
			"incarnation-b",
			"user-a",
			{
				type: "present",
				accountId: "account-a",
				userId: "user-a",
				incarnation: "incarnation-a",
				replicaRevision: "0",
				lockEpoch: "0",
			},
			"4",
		);
		await expect(invoke(invalidInstall)).rejects.toThrow(
			"install transition is invalid",
		);

		const validInstall = install(
			"incarnation-b",
			"user-a",
			{
				type: "present",
				accountId: "account-a",
				userId: "user-a",
				incarnation: "incarnation-a",
				replicaRevision: "0",
				lockEpoch: "0",
			},
			"1",
		);
		const emptyInstallKey = {
			...validInstall,
			prepared: {
				...validInstall.prepared,
				writes: [put("operations", "", "opaque")],
			},
		};
		await expect(invoke(emptyInstallKey)).rejects.toThrow(
			"prepared row key must not be empty",
		);

		await expect(
			invoke(commit(prepared([put("operations", "", "opaque")]))),
		).rejects.toThrow("prepared row key must not be empty");
		expect(await invoke({ type: "load", accountId: "account-a" })).toEqual(
			before,
		);
	});

	test("rejects a stored head with an empty User identity", async () => {
		await seedHead({
			accountId: "account-a",
			userId: "",
			incarnation: "incarnation-a",
			replicaRevision: "0",
			lockEpoch: "0",
			failure: null,
		});
		await expect(
			invoke({ type: "load", accountId: "account-a" }),
		).rejects.toThrow("stored head User must not be empty");
	});

	test("rejects malformed stored lock epochs", async () => {
		await seedHead({
			accountId: "account-a",
			userId: "user-a",
			incarnation: "incarnation-a",
			replicaRevision: "0",
			lockEpoch: "01",
			failure: null,
		});
		await expect(
			invoke({ type: "load", accountId: "account-a" }),
		).rejects.toThrow("stored head does not match the generated contract");
	});

	test("returns missing before validating unreachable lock guard identities", async () => {
		for (const field of ["accountId", "userId", "incarnation"] as const) {
			const valid = advanceLockEpoch();
			const request = {
				...valid,
				prepared: {
					...valid.prepared,
					expected: { ...valid.prepared.expected, [field]: "" },
				},
			};
			expect(await invoke(request)).toEqual({
				type: "lockEpochAdvanced",
				result: { type: "missing" },
			});
		}
	});

	test("rejects the former domain plan and unknown wire fields", async () => {
		await expect(
			invoke({ type: "commit", plan: { mutations: [] } }),
		).rejects.toThrow(
			"persistence request does not match the generated contract",
		);
		await expect(
			invoke({ type: "load", accountId: "account-a", extra: true }),
		).rejects.toThrow(
			"persistence request does not match the generated contract",
		);
	});

	test("generated response validation requires explicit nullable fields", () => {
		expect(
			validateReplicaPersistenceResponse({ type: "loaded", rows: [] }),
		).toBeFalse();
		expect(
			validateReplicaPersistenceResponse({
				type: "loaded",
				head: {
					accountId: "account-a",
					userId: "user-a",
					incarnation: "incarnation-a",
					replicaRevision: "0",
				},
				rows: [],
			}),
		).toBeFalse();
	});

	test("generated validation keeps failure codes closed", () => {
		const response = {
			type: "loaded",
			head: {
				accountId: "account-a",
				userId: "user-a",
				incarnation: "incarnation-a",
				replicaRevision: "0",
				lockEpoch: "0",
				failure: "INVARIANT_VIOLATION",
			},
			rows: [],
		};
		expect(validateReplicaPersistenceResponse(response)).toBeTrue();
		expect(
			validateReplicaPersistenceResponse({
				...response,
				head: { ...response.head, failure: "ARBITRARY_FAILURE" },
			}),
		).toBeFalse();
	});

	test("generated validation accepts exactly canonical uint64 decimal strings", () => {
		const response = (replicaRevision: unknown) => ({
			type: "loaded",
			head: {
				accountId: "account-a",
				userId: "user-a",
				incarnation: "incarnation-a",
				replicaRevision,
				lockEpoch: "0",
				failure: null,
			},
			rows: [],
		});

		expect(
			validateReplicaPersistenceResponse(response("18446744073709551615")),
		).toBeTrue();
		for (const invalid of ["18446744073709551616", "01", "-1", 1]) {
			expect(validateReplicaPersistenceResponse(response(invalid))).toBeFalse();
		}

		const request = commit(prepared([]));
		expect(validateReplicaPersistenceRequest(request)).toBeTrue();
		expect(
			validateReplicaPersistenceRequest({
				...request,
				prepared: {
					...request.prepared,
					expected: {
						...request.prepared.expected,
						replicaRevision: "01",
					},
				},
			}),
		).toBeFalse();
		expect(
			validateReplicaPersistenceRequest({
				...advanceLockEpoch(),
				prepared: {
					...advanceLockEpoch().prepared,
					expected: {
						...advanceLockEpoch().prepared.expected,
						replicaRevision: "01",
					},
				},
			}),
		).toBeFalse();
	});

	test("returns stale without applying prepared writes", async () => {
		await seedHead({
			accountId: "account-a",
			userId: "user-a",
			incarnation: "incarnation-a",
			replicaRevision: "4",
			lockEpoch: "0",
			failure: null,
		});
		expect(
			await invoke(commit(prepared([put("operations", "loser", "opaque")]))),
		).toEqual({
			type: "committed",
			result: { type: "stale", actualRevision: "4" },
		});
		expect(await rawDatabaseContents()).not.toContainEqual(
			expect.objectContaining({ recordId: "loser" }),
		);
	});

	test("stores and loads opaque rows without parsing their payload", async () => {
		await seedHead({
			accountId: "account-a",
			userId: "user-a",
			incarnation: "incarnation-a",
			replicaRevision: "0",
			lockEpoch: "0",
			failure: null,
		});
		const writes = [
			put("optimisticItems", "item-a", "not-json"),
			put("operations", "operation-a", '{"sealed":[4,5,6]}'),
			put(
				"shareCapabilities",
				"operation-a",
				'{"ciphertext":"opaque-account-protected-capability"}',
			),
		];
		expect(await invoke(commit(prepared(writes)))).toEqual({
			type: "committed",
			result: { type: "applied", replicaRevision: "1" },
		});
		expect(await invoke({ type: "load", accountId: "account-a" })).toEqual({
			type: "loaded",
			head: {
				accountId: "account-a",
				userId: "user-a",
				incarnation: "incarnation-a",
				replicaRevision: "1",
				lockEpoch: "0",
				failure: null,
			},
			rows: writes.map((write) => (write.type === "put" ? write.row : write)),
		});
		expect(
			await invoke(
				commit(
					prepared(
						[
							{
								type: "delete",
								store: "operations",
								key: { accountId: "account-a", recordId: "operation-a" },
							},
						],
						"1",
					),
				),
			),
		).toMatchObject({ result: { type: "applied", replicaRevision: "2" } });
		expect(
			(await invoke({ type: "load", accountId: "account-a" })).rows,
		).toEqual(
			[writes[0], writes[2]].map((write) =>
				write?.type === "put" ? write.row : write,
			),
		);
	});

	test("rejects an unsafe primitive batch before writing any row", async () => {
		await seedHead({
			accountId: "account-a",
			userId: "user-a",
			incarnation: "incarnation-a",
			replicaRevision: "0",
			lockEpoch: "0",
			failure: null,
		});
		await expect(
			invoke(
				commit(
					prepared([
						put("operations", "first", "opaque"),
						put("operations", "cross-account", "opaque", "account-b"),
					]),
				),
			),
		).rejects.toThrow("Account scope");
		expect(await rawDatabaseContents()).not.toContainEqual(
			expect.objectContaining({ recordId: expect.any(String) }),
		);
	});

	test("two executors race through CAS without mixing loser writes", async () => {
		await seedHead({
			accountId: "account-a",
			userId: "user-a",
			incarnation: "incarnation-a",
			replicaRevision: "0",
			lockEpoch: "0",
			failure: null,
		});
		const results = await Promise.all([
			invoke(
				commit(prepared([put("operations", "left", "left-payload")])),
				executor(),
			),
			invoke(
				commit(prepared([put("operations", "right", "right-payload")])),
				executor(),
			),
		]);
		expect(results.map((result) => result.result.type).sort()).toEqual([
			"applied",
			"stale",
		]);
		const loaded = await invoke({ type: "load", accountId: "account-a" });
		expect(loaded.head.replicaRevision).toBe("1");
		expect(loaded.rows).toHaveLength(1);
		expect(["left", "right"]).toContain(loaded.rows[0].key.recordId);
		expect(loaded.rows[0].payloadJson).toBe(
			`${loaded.rows[0].key.recordId}-payload`,
		);
	});

	test("preserves uint64 precision and rejects a non-successor head", async () => {
		await seedHead({
			accountId: "account-a",
			userId: "user-a",
			incarnation: "incarnation-a",
			replicaRevision: "9007199254740993",
			lockEpoch: "0",
			failure: null,
		});
		expect(
			await invoke(commit(prepared([], "9007199254740993"))),
		).toMatchObject({
			result: { replicaRevision: "9007199254740994" },
		});
		await expect(
			invoke(commit(prepared([], "9007199254740994", "9007199254740996"))),
		).rejects.toThrow("successor");
	});

	test("stages Bootstrap authority without publishing plaintext or mixing generations", async () => {
		await invoke(install());
		const metadata = JSON.stringify({
			state: "bootstrapping",
			activeGeneration: null,
			activeCursor: { type: "cold" },
			stagingGeneration: "generation-1",
		});
		const generation = JSON.stringify({
			generationId: "generation-1",
			fallbackState: "cold",
			pinnedWatermark: { type: "capturedEmpty" },
			nextPageIdentity: "1",
			nextPageCursor: { type: "initial" },
			finalPageStaged: true,
		});
		const item = JSON.stringify({
			id: "item-1",
			vaultId: "vault-1",
			category: "login",
			favorite: false,
			encryptedData: "ciphertext-not-plaintext",
			encryptionIv: "iv",
			encryptionAlgorithm: "AES-GCM-AAD-V1",
			version: 1,
			encryptionVersion: 1,
			encryptedByUserId: "user-a",
			lastModifiedBy: "user-a",
			createdAt: "2026-08-23T00:00:00Z",
			updatedAt: "2026-08-23T00:00:00Z",
			deletedAt: null,
			attachments: [],
		});
		expect(
			await invoke(
				commit(
					prepared([
						put("replicaMetadata", "bootstrap", metadata),
						put("bootstrapGenerations", "generation-1", generation),
						put("authorityItems", "generation-1/item-1", item),
					]),
				),
			),
		).toMatchObject({ result: { type: "applied" } });
		const staged = await invoke({ type: "load", accountId: "account-a" });
		expect(staged.rows).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					store: "replicaMetadata",
					key: { accountId: "account-a", recordId: "bootstrap" },
				}),
				expect.objectContaining({
					store: "authorityItems",
					key: { accountId: "account-a", recordId: "generation-1/item-1" },
				}),
			]),
		);
		expect(JSON.stringify(staged)).not.toContain("master-password");
		expect(JSON.stringify(staged)).not.toContain("plaintext-login");

		const promoteMetadata = JSON.stringify({
			state: "ready",
			activeGeneration: "generation-1",
			activeCursor: { type: "capturedEmpty" },
			stagingGeneration: null,
		});
		expect(
			await invoke(
				commit(
					prepared(
						[put("replicaMetadata", "bootstrap", promoteMetadata)],
						"1",
						"2",
					),
				),
			),
		).toMatchObject({ result: { replicaRevision: "2" } });
		const promoted = await invoke({ type: "load", accountId: "account-a" });
		expect(promoted.head.replicaRevision).toBe("2");
		expect(
			promoted.rows.some(
				(row: { store: string; payloadJson: string }) =>
					row.store === "replicaMetadata" &&
					row.payloadJson.includes('"state":"ready"'),
			),
		).toBe(true);
	});

	test("same-revision Bootstrap page writes stay atomic and isolated from the Cursor", async () => {
		await invoke(install());
		await invoke(
			commit(
				prepared([
					put("replicaMetadata", "bootstrap", '{"state":"bootstrapping"}'),
				]),
			),
		);
		const sameRevision = prepared(
			[put("authorityItems", "generation-1/item-1", '{"id":"item-1"}')],
			"1",
			"1",
		);
		expect(await invoke(commit(sameRevision))).toMatchObject({
			result: { type: "applied", replicaRevision: "1" },
		});
		const loaded = await invoke({ type: "load", accountId: "account-a" });
		expect(loaded.head.replicaRevision).toBe("1");
		expect(loaded.rows).toHaveLength(2);
	});
});
