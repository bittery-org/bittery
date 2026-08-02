/**
 * The IndexedDB `RecordPort`, shared verbatim by the web and chrome adapters.
 *
 * A page and an extension service worker both get the same `indexedDB` global, so there is
 * exactly one correct mapping and it lives here. It was lifted out of `web.ts` rather than
 * copied into `chrome.ts`: two copies of a database layout are two things that can drift,
 * and the contract requires the record seam to behave identically in both.
 *
 * There is no policy in this file either. `collection` and `id` are opaque strings; nothing
 * here parses them, and nothing here knows about accounts, tiers or JSON.
 */
/// <reference lib="dom" />

import type { RecordPort } from "../record-port";

/**
 * Record layout. **The web and chrome adapters share this exactly** — they share this
 * function, so there is no second layout to keep in step.
 *
 * One IndexedDB row per record is what makes `recordPut` / `recordDelete` O(1) — the old
 * adapters read the whole item array, mutated it and rewrote every row on a single-item
 * upsert, turning a delta sync into O(n^2) writes.
 */
const DB_NAME = "bittery_records";
const DB_VERSION = 1;
const STORE_NAME = "records";
const COLLECTION_INDEX = "by_collection";

interface RecordRow {
	/** Primary key: `` `${collection} ${id}` ``. Never parsed back apart. */
	key: string;
	collection: string;
	id: string;
	value: string;
}

/** `collection` and `id` are opaque, so the composite key is stored, never re-split. */
function rowKey(collection: string, id: string): string {
	return `${collection} ${id}`;
}

function requestDone<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(transaction.error);
		transaction.onabort = () => reject(transaction.error);
	});
}

function openDatabase(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(STORE_NAME)) {
				const store = db.createObjectStore(STORE_NAME, { keyPath: "key" });
				store.createIndex(COLLECTION_INDEX, "collection", { unique: false });
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

export function createIndexedDbRecordPort(): RecordPort {
	let opening: Promise<IDBDatabase> | null = null;

	const database = (): Promise<IDBDatabase> => {
		opening ??= openDatabase();
		return opening;
	};

	return {
		initialize: async () => {
			await database();
		},

		recordPut: async (collection, id, value) => {
			const transaction = (await database()).transaction(
				STORE_NAME,
				"readwrite",
			);
			transaction.objectStore(STORE_NAME).put({
				key: rowKey(collection, id),
				collection,
				id,
				value,
			} satisfies RecordRow);
			await transactionDone(transaction);
		},

		recordGet: async (collection, id) => {
			const transaction = (await database()).transaction(
				STORE_NAME,
				"readonly",
			);
			const row = await requestDone(
				transaction
					.objectStore(STORE_NAME)
					.get(rowKey(collection, id)) as IDBRequest<RecordRow | undefined>,
			);
			return row?.value ?? null;
		},

		recordDelete: async (collection, id) => {
			const transaction = (await database()).transaction(
				STORE_NAME,
				"readwrite",
			);
			transaction.objectStore(STORE_NAME).delete(rowKey(collection, id));
			await transactionDone(transaction);
		},

		recordList: async (collection) => {
			const transaction = (await database()).transaction(
				STORE_NAME,
				"readonly",
			);
			const rows = await requestDone(
				transaction
					.objectStore(STORE_NAME)
					.index(COLLECTION_INDEX)
					.getAll(collection) as IDBRequest<RecordRow[]>,
			);
			return rows.map((row) => ({ id: row.id, value: row.value }));
		},

		recordClear: async (collection) => {
			const db = await database();
			// Two transactions on purpose: awaiting a request inside a live IndexedDB
			// transaction lets it auto-commit between the read and the writes.
			const keys = await requestDone(
				db
					.transaction(STORE_NAME, "readonly")
					.objectStore(STORE_NAME)
					.index(COLLECTION_INDEX)
					.getAllKeys(collection),
			);
			if (keys.length === 0) {
				return;
			}
			const transaction = db.transaction(STORE_NAME, "readwrite");
			const store = transaction.objectStore(STORE_NAME);
			for (const key of keys) {
				store.delete(key);
			}
			await transactionDone(transaction);
		},
	};
}
