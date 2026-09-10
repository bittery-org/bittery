import { beforeEach, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import {
	assertIndexedDbLayout,
	openIndexedDatabase,
} from "./indexeddb-lifecycle";

beforeEach(() =>
	Object.defineProperty(globalThis, "indexedDB", {
		configurable: true,
		value: new IDBFactory(),
	}),
);
function open(
	version: number,
	upgrade = (db: IDBDatabase) => {
		db.createObjectStore("rows");
	},
) {
	return openIndexedDatabase({ name: "lifecycle", version, upgrade });
}
function raw(version: number) {
	return new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open("lifecycle", version);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}
test("blocked upgrade refuses and aborts its late upgrade instead of silently retrying", async () => {
	const first = await open(1);
	first.close();
	const old = await raw(1);
	await expect(
		open(2, (db) => {
			db.createObjectStore("added");
		}),
	).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE", reason: "blocked" });
	old.close();
	const unchanged = await raw(1);
	expect([...unchanged.objectStoreNames]).toEqual(["rows"]);
	unchanged.close();
	const retry = await open(2, (db) => {
		db.createObjectStore("added");
	});
	expect([...retry.objectStoreNames]).toEqual(["added", "rows"]);
	retry.close();
});
test("failed additive migration preserves old stores and version", async () => {
	const first = await open(1);
	first.close();
	await expect(
		open(2, (db) => {
			db.createObjectStore("added");
			throw new Error("injected");
		}),
	).rejects.toMatchObject({ reason: "upgrade_failed" });
	const old = await raw(1);
	expect([...old.objectStoreNames]).toEqual(["rows"]);
	old.close();
});
test("versionchange closes an owner and retires its cached reference", async () => {
	let retired = false;
	await openIndexedDatabase({
		name: "lifecycle",
		version: 1,
		upgrade: (db) => {
			db.createObjectStore("rows");
		},
		onVersionChange: () => {
			retired = true;
		},
	});
	const next = await open(2, () => {});
	expect(retired).toBe(true);
	next.close();
	await expect(open(1)).rejects.toMatchObject({
		reason: "unsupported_version",
	});
});

test("a malformed current schema retains its diagnosis and original bytes", async () => {
	const original = await open(1);
	const bytes = new Uint8Array([0, 255, 17]);
	await new Promise<void>((resolve, reject) => {
		const transaction = original.transaction("rows", "readwrite");
		transaction.objectStore("rows").put(bytes, "preserved");
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(transaction.error);
	});
	original.close();
	await expect(
		openIndexedDatabase({
			name: "lifecycle",
			version: 1,
			upgrade: () => {
				throw new Error("unexpected upgrade");
			},
			validate: (database, transaction) =>
				assertIndexedDbLayout(database, [["rows", "id", []]], transaction),
		}),
	).rejects.toMatchObject({ reason: "unsupported_version" });
	const reopened = await raw(1);
	const request = reopened
		.transaction("rows", "readonly")
		.objectStore("rows")
		.get("preserved");
	const stored = await new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
	expect(stored).toEqual(bytes);
	expect(reopened.version).toBe(1);
	reopened.close();
});
