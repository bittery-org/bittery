import { afterEach, beforeEach, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { IndexedDbReplicaExecutor } from "./indexeddb-executor.ts";
import { createTestIndexedDbReplicaExecutor } from "./testing/index.ts";

const databaseName = "bittery_replica";
const stores = [
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
];
let factory: IDBFactory;
beforeEach(() => {
	factory = new IDBFactory();
	Object.defineProperty(globalThis, "indexedDB", {
		configurable: true,
		value: factory,
	});
});
afterEach(() => {
	Reflect.deleteProperty(globalThis, "indexedDB");
});

function result<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}
function done(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onabort = () => reject(transaction.error);
	});
}
async function legacy(version = 6): Promise<IDBDatabase> {
	const request = factory.open(databaseName, version);
	request.onupgradeneeded = () => {
		for (const name of stores) {
			const store = request.result.createObjectStore(name, {
				keyPath: name === "heads" ? "accountId" : ["accountId", "recordId"],
			});
			if (name !== "heads") store.createIndex("by_account", "accountId");
		}
	};
	const database = await result(request);
	const transaction = database.transaction(stores, "readwrite");
	transaction.objectStore("heads").put({
		accountId: "account-a",
		userId: "user-a",
		incarnation: "incarnation-a",
		replicaRevision: "9",
		lockEpoch: "2",
		failure: null,
	});
	for (const name of stores.filter((name) => name !== "heads")) {
		transaction.objectStore(name).put({
			accountId: "account-a",
			recordId: name,
			payloadJson: `retained-${name}`,
		});
	}
	await done(transaction);
	return database;
}
const load = JSON.stringify({ type: "load", accountId: "account-a" });

test("a blocked upgrade reports storage unavailable and waits for explicit retry", async () => {
	const competing = await legacy();
	const executor = new IndexedDbReplicaExecutor();
	const outcome = await Promise.race([
		executor.invoke(load).catch((error) => error),
		new Promise((resolve) => setTimeout(() => resolve("hung"), 200)),
	]);
	expect(outcome).toMatchObject({
		code: "STORAGE_UNAVAILABLE",
		reason: "blocked",
	});
	competing.close();
	// The abandoned open request must abort, not quietly finish an upgrade after rejection.
	const old = await result(factory.open(databaseName, 6));
	expect(old.version).toBe(6);
	expect([...old.objectStoreNames]).not.toContain("share_capabilities");
	old.close();
	const loaded = JSON.parse(await executor.invoke(load));
	expect(loaded.head.replicaRevision).toBe("9");
	expect(loaded.rows).toHaveLength(9);
});

test("every additive migration write failure preserves the previous version and opaque rows", async () => {
	for (const boundary of [1, 2]) {
		factory = new IDBFactory();
		Object.defineProperty(globalThis, "indexedDB", {
			configurable: true,
			value: factory,
		});
		(await legacy()).close();
		const executor = createTestIndexedDbReplicaExecutor({
			failAfterMigrationWrite: boundary,
		});
		await expect(executor.invoke(load)).rejects.toMatchObject({
			code: "STORAGE_UNAVAILABLE",
			reason: "upgrade_failed",
		});
		const old = await result(factory.open(databaseName, 6));
		expect(old.version).toBe(6);
		expect([...old.objectStoreNames]).not.toContain("share_capabilities");
		old.close();
		const loaded = JSON.parse(
			await new IndexedDbReplicaExecutor().invoke(load),
		);
		expect(loaded.rows).toHaveLength(9);
		expect(
			loaded.rows.find(
				(row: { store: string }) => row.store === "operationReceipts",
			).payloadJson,
		).toBe("retained-operation_receipts");
	}
});

test("historical v1-v4 schemas are refused unchanged instead of defaulting earlier logical fields", async () => {
	// v1: 7b5de1a7; v2: 593bc69e; v3: 07aec555; v4: 75f75fc8.
	for (const version of [1, 2, 3, 4]) {
		factory = new IDBFactory();
		Object.defineProperty(globalThis, "indexedDB", {
			configurable: true,
			value: factory,
		});
		const names =
			version < 4
				? ["heads", "optimistic_items", "operations"]
				: stores.filter(
						(name) =>
							name !== "operation_receipts" &&
							name !== "attachment_move_preparations",
					);
		const request = factory.open(databaseName, version);
		request.onupgradeneeded = () => {
			request.result.createObjectStore("heads", { keyPath: "accountId" });
			for (const name of names.filter((name) => name !== "heads")) {
				const recordKey =
					version === 1
						? name === "operations"
							? "operationId"
							: "itemId"
						: "recordId";
				const store = request.result.createObjectStore(name, {
					keyPath: ["accountId", recordKey],
				});
				store.createIndex("by_account", "accountId");
			}
		};
		const database = await result(request);
		const seed = database.transaction("heads", "readwrite");
		const oldHead = {
			accountId: "account-a",
			incarnation: "old-generation",
			revision: "17",
			failure: null,
		};
		seed.objectStore("heads").put(oldHead);
		await done(seed);
		database.close();
		await expect(
			new IndexedDbReplicaExecutor().invoke(load),
		).rejects.toMatchObject({
			code: "STORAGE_UNAVAILABLE",
			reason: "unsupported_version",
		});
		const retained = await result(factory.open(databaseName, version));
		expect(retained.version).toBe(version);
		expect([...retained.objectStoreNames]).toEqual([...names].sort());
		const read = retained.transaction("heads", "readonly");
		expect(await result(read.objectStore("heads").get("account-a"))).toEqual(
			oldHead,
		);
		await done(read);
		retained.close();
	}
});

test("every fresh-schema migration failure leaves no partially created database", async () => {
	// One heads store, then ten record stores and their Account indexes.
	for (let boundary = 1; boundary <= 21; boundary += 1) {
		factory = new IDBFactory();
		Object.defineProperty(globalThis, "indexedDB", {
			configurable: true,
			value: factory,
		});
		const executor = createTestIndexedDbReplicaExecutor({
			failAfterMigrationWrite: boundary,
		});
		await expect(executor.invoke(load)).rejects.toMatchObject({
			code: "STORAGE_UNAVAILABLE",
		});
		expect(await factory.databases()).toEqual([]);
		expect(
			JSON.parse(await new IndexedDbReplicaExecutor().invoke(load)),
		).toEqual({ type: "loaded", head: null, rows: [] });
	}
});

test("a future database version is refused without resetting existing stores", async () => {
	const database = await legacy(9);
	database.close();
	await expect(
		new IndexedDbReplicaExecutor().invoke(load),
	).rejects.toMatchObject({
		code: "STORAGE_UNAVAILABLE",
		reason: "unsupported_version",
	});
	const retained = await result(factory.open(databaseName, 9));
	expect(retained.version).toBe(9);
	const transaction = retained.transaction("operations", "readonly");
	expect(
		await result(transaction.objectStore("operations").getAll()),
	).toHaveLength(1);
	await done(transaction);
	retained.close();
});

test("a supported version number cannot disguise an unsupported physical shape", async () => {
	// The v6 Attachment Move store did not exist in v5.
	(await legacy(5)).close();
	await expect(
		new IndexedDbReplicaExecutor().invoke(load),
	).rejects.toMatchObject({
		code: "STORAGE_UNAVAILABLE",
		reason: "unsupported_version",
	});
	const database = await result(factory.open(databaseName, 5));
	expect([...database.objectStoreNames]).toEqual([...stores].sort());
	const read = database.transaction("operations", "readonly");
	expect(await result(read.objectStore("operations").getAll())).toHaveLength(1);
	await done(read);
	database.close();
});

test("an open connection closes on versionchange so another context can upgrade", async () => {
	const open = factory.open.bind(factory);
	let upgrade: Promise<IDBDatabase> | undefined;
	let versionChanges = 0;
	factory.open = (name, version) => {
		const request = open(name, version);
		request.addEventListener(
			"success",
			() => {
				request.result.addEventListener("versionchange", () => {
					versionChanges += 1;
				});
				upgrade = result(open(name, request.result.version + 1));
			},
			{ once: true },
		);
		return request;
	};
	// A transaction already admitted may finish. The connection must stop admitting new work.
	await new IndexedDbReplicaExecutor().invoke(load).catch(() => undefined);
	const upgraded = await upgrade;
	expect(versionChanges).toBe(1);
	expect(upgraded?.version).toBe(9);
	upgraded?.close();
});
