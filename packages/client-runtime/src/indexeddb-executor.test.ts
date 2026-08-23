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
const DB_VERSION = 3;
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
	const transaction = database.transaction(
		["heads", "optimistic_items", "operations"],
		"readonly",
	);
	const requests = ["heads", "optimistic_items", "operations"].map(
		(storeName) => transaction.objectStore(storeName).getAll(),
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
			incarnation: "incarnation-a",
			replicaRevision: expectedRevision,
		},
		nextHead: {
			accountId: "account-a",
			userId: "user-a",
			incarnation: "incarnation-a",
			replicaRevision: nextRevision,
			failure: null,
		},
		writes,
	};
}

function commit(value: PreparedReplicaCommit) {
	return { type: "commit", prepared: value } as const;
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
				failure: null,
			},
		},
	} as const;
}

describe("IndexedDbReplicaExecutor", () => {
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

	test("rejects a stored head with an empty User identity", async () => {
		await seedHead({
			accountId: "account-a",
			userId: "",
			incarnation: "incarnation-a",
			replicaRevision: "0",
			failure: null,
		});
		await expect(
			invoke({ type: "load", accountId: "account-a" }),
		).rejects.toThrow("stored head User must not be empty");
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
	});

	test("returns stale without applying prepared writes", async () => {
		await seedHead({
			accountId: "account-a",
			userId: "user-a",
			incarnation: "incarnation-a",
			replicaRevision: "4",
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
			failure: null,
		});
		const writes = [
			put("optimisticItems", "item-a", "not-json"),
			put("operations", "operation-a", '{"sealed":[4,5,6]}'),
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
		).toEqual([writes[0]?.type === "put" ? writes[0].row : writes[0]]);
	});

	test("rejects an unsafe primitive batch before writing any row", async () => {
		await seedHead({
			accountId: "account-a",
			userId: "user-a",
			incarnation: "incarnation-a",
			replicaRevision: "0",
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
});
