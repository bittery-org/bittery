import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { IndexedDbReplicaExecutor } from "./indexeddb-executor.ts";

const DB_NAME = "bittery_replica";
const DB_VERSION = 1;

type Head = {
	accountId: string;
	incarnation: string;
	revision: string;
	failure: string | null;
};

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

async function invoke(value: unknown, target = executor()): Promise<unknown> {
	return JSON.parse(await target.invoke(JSON.stringify(value)));
}

async function seedHead(head: Head): Promise<void> {
	await invoke({ type: "load", accountId: head.accountId });
	const database = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION);
		request.onerror = () => reject(request.error);
		request.onsuccess = () => resolve(request.result);
	});
	const transaction = database.transaction("heads", "readwrite");
	transaction.objectStore("heads").put(head);
	await transactionDone(transaction);
	database.close();
}

async function rawDatabaseContents(): Promise<unknown[]> {
	const database = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION);
		request.onerror = () => reject(request.error);
		request.onsuccess = () => resolve(request.result);
	});
	const transaction = database.transaction(
		["heads", "optimistic_items", "operations"],
		"readonly",
	);
	const stores = ["heads", "optimistic_items", "operations"].map((storeName) =>
		transaction.objectStore(storeName).getAll(),
	);
	const values = await Promise.all(
		stores.map(
			(request) =>
				new Promise<unknown[]>((resolve, reject) => {
					request.onsuccess = () => resolve(request.result);
					request.onerror = () => reject(request.error);
				}),
		),
	);
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

const item = {
	accountId: "account-a",
	itemId: "item-a",
	vaultId: "vault-a",
	ciphertext: [1, 2, 255],
	optimistic: true,
};

const operation = {
	operationId: "operation-a",
	itemId: "item-a",
	requestBytes: [4, 5, 6],
};

function commit(mutations: unknown[], overrides: Record<string, unknown> = {}) {
	return {
		type: "commit",
		plan: {
			accountId: "account-a",
			expectedIncarnation: "incarnation-a",
			expectedReplicaRevision: "0",
			mutations,
			...overrides,
		},
	};
}

describe("IndexedDbReplicaExecutor", () => {
	test("loads and commits a missing account without creating it", async () => {
		expect(await invoke({ type: "load", accountId: "missing" })).toEqual({
			type: "loaded",
			snapshot: null,
		});
		expect(await invoke(commit([]))).toEqual({
			type: "committed",
			result: { type: "missing" },
		});
	});

	test("returns stale without applying mutations", async () => {
		await seedHead({
			accountId: "account-a",
			incarnation: "incarnation-a",
			revision: "4",
			failure: null,
		});

		expect(
			await invoke(commit([{ type: "putOptimisticItem", ...item }])),
		).toEqual({
			type: "committed",
			result: { type: "stale", actualRevision: "4" },
		});
		expect(await invoke({ type: "load", accountId: "account-a" })).toEqual({
			type: "loaded",
			snapshot: {
				accountId: "account-a",
				incarnation: "incarnation-a",
				revision: "4",
				items: [],
				operations: [],
				failure: null,
			},
		});
	});

	test("atomically applies the current tagged mutations and advances exactly once", async () => {
		await seedHead({
			accountId: "account-a",
			incarnation: "incarnation-a",
			revision: "0",
			failure: null,
		});

		expect(
			await invoke(
				commit([
					{ type: "putOptimisticItem", ...item },
					{ type: "acceptOperation", ...operation },
				]),
			),
		).toEqual({
			type: "committed",
			result: { type: "applied", replicaRevision: "1" },
		});
		expect(await invoke({ type: "load", accountId: "account-a" })).toEqual({
			type: "loaded",
			snapshot: {
				accountId: "account-a",
				incarnation: "incarnation-a",
				revision: "1",
				items: [item],
				operations: [operation],
				failure: null,
			},
		});
	});

	test("rolls back a valid first mutation when the second is invalid", async () => {
		await seedHead({
			accountId: "account-a",
			incarnation: "incarnation-a",
			revision: "0",
			failure: null,
		});

		await expect(
			invoke(
				commit([
					{ type: "putOptimisticItem", ...item },
					{ type: "putOptimisticItem", ...item, accountId: "account-b" },
				]),
			),
		).rejects.toThrow("account scope");
		expect(await invoke({ type: "load", accountId: "account-a" })).toEqual({
			type: "loaded",
			snapshot: {
				accountId: "account-a",
				incarnation: "incarnation-a",
				revision: "0",
				items: [],
				operations: [],
				failure: null,
			},
		});
	});

	test("keeps records scoped to their account", async () => {
		await seedHead({
			accountId: "account-a",
			incarnation: "incarnation-a",
			revision: "0",
			failure: null,
		});
		await seedHead({
			accountId: "account-b",
			incarnation: "incarnation-b",
			revision: "0",
			failure: null,
		});
		await invoke(commit([{ type: "putOptimisticItem", ...item }]));

		expect(await invoke({ type: "load", accountId: "account-b" })).toEqual({
			type: "loaded",
			snapshot: {
				accountId: "account-b",
				incarnation: "incarnation-b",
				revision: "0",
				items: [],
				operations: [],
				failure: null,
			},
		});
	});

	test("rejects duplicate operations without changing the replica", async () => {
		await seedHead({
			accountId: "account-a",
			incarnation: "incarnation-a",
			revision: "0",
			failure: null,
		});
		await invoke(commit([{ type: "acceptOperation", ...operation }]));

		await expect(
			invoke(
				commit([{ type: "acceptOperation", ...operation }], {
					expectedReplicaRevision: "1",
				}),
			),
		).rejects.toThrow("operation identity was reused");
		expect(
			(await invoke({ type: "load", accountId: "account-a" })) as object,
		).toMatchObject({
			snapshot: { revision: "1", operations: [operation] },
		});
	});

	test("rejects removing an unknown operation without changing the replica", async () => {
		await seedHead({
			accountId: "account-a",
			incarnation: "incarnation-a",
			revision: "0",
			failure: null,
		});

		await expect(
			invoke(commit([{ type: "removeOperation", operationId: "unknown" }])),
		).rejects.toThrow("cannot remove an unknown operation");
		expect(
			(await invoke({ type: "load", accountId: "account-a" })) as object,
		).toMatchObject({ snapshot: { revision: "0", operations: [] } });
	});

	test("persists records when a new executor reopens the database", async () => {
		await seedHead({
			accountId: "account-a",
			incarnation: "incarnation-a",
			revision: "0",
			failure: null,
		});
		await invoke(commit([{ type: "putOptimisticItem", ...item }]));

		expect(
			await invoke({ type: "load", accountId: "account-a" }, executor()),
		).toMatchObject({ snapshot: { revision: "1", items: [item] } });
	});

	test("preserves uint64 decimal precision", async () => {
		await seedHead({
			accountId: "account-a",
			incarnation: "incarnation-a",
			revision: "9007199254740993",
			failure: null,
		});

		expect(
			await invoke(commit([], { expectedReplicaRevision: "9007199254740993" })),
		).toEqual({
			type: "committed",
			result: { type: "applied", replicaRevision: "9007199254740994" },
		});
	});

	test("rejects non-contract plaintext fields without persisting their marker", async () => {
		const marker = "PLAINTEXT_MUST_NOT_REACH_INDEXEDDB";
		await seedHead({
			accountId: "account-a",
			incarnation: "incarnation-a",
			revision: "0",
			failure: null,
		});

		await expect(
			invoke(
				commit([{ type: "putOptimisticItem", ...item, plaintext: marker }]),
			),
		).rejects.toThrow("unexpected field");
		expect(
			JSON.stringify(await invoke({ type: "load", accountId: "account-a" })),
		).not.toContain(marker);
		expect(JSON.stringify(await rawDatabaseContents())).not.toContain(marker);
	});
});
