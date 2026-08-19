/**
 * In-process doubles for the browser storage globals, shared by the web and chrome
 * adapter tests.
 *
 * `bun test` provides no `localStorage`, `sessionStorage` or `indexedDB`, and the web and
 * chrome record ports have the *same* IndexedDB shape, so both need the same fake. It lives
 * here rather than in a test file so the two suites cannot drift into testing different
 * IndexedDB semantics.
 *
 * The IndexedDB double implements only the surface the adapters actually use — open with
 * an upgrade callback, one keyPath object store, one non-unique index, `put` / `get` /
 * `delete` / `getAll` / `getAllKeys` — and it models the two behaviours that matter for
 * correctness:
 *
 *   1. Requests settle **asynchronously**, so a handler assigned after the call still runs.
 *      A synchronous fake would hide the ordering bugs this is meant to catch.
 *   2. A transaction fires `oncomplete` only once every request issued against it has
 *      settled, and an empty transaction still completes.
 *
 * The `chrome.storage` double lives here too rather than in a chrome-only file: the chrome
 * adapter needs both halves at once — `chrome.storage` for its `PlatformPort` and the same
 * IndexedDB double web uses for its `RecordPort` — so keeping them together means one
 * import and no chance of the two suites installing different IndexedDB semantics.
 *
 * Nothing here is exported to production code; the file is test scaffolding that happens
 * to live outside a `.test.ts` because two suites share it.
 */

// ============================================================================
// Web Storage
// ============================================================================

/** `localStorage` / `sessionStorage` double. Insertion-ordered, like real browsers. */
export class StorageDouble {
	private readonly entries = new Map<string, string>();

	get length(): number {
		return this.entries.size;
	}

	key(index: number): string | null {
		return [...this.entries.keys()][index] ?? null;
	}

	getItem(key: string): string | null {
		return this.entries.get(key) ?? null;
	}

	setItem(key: string, value: string): void {
		this.entries.set(key, String(value));
	}

	removeItem(key: string): void {
		this.entries.delete(key);
	}

	clear(): void {
		this.entries.clear();
	}
}

// ============================================================================
// IndexedDB
// ============================================================================

type Row = Record<string, unknown>;

/** Handlers are invoked with no arguments; the adapters never read the event. */
type Handler = (() => void) | null;

class RequestDouble<T> {
	result: T | undefined = undefined;
	error: Error | null = null;
	onsuccess: Handler = null;
	onerror: Handler = null;
	onupgradeneeded: Handler = null;
}

class StoreData {
	readonly rows = new Map<string, Row>();
	/** index name -> the field the index is built on. */
	readonly indexes = new Map<string, string>();

	constructor(readonly keyPath: string) {}
}

class DatabaseData {
	readonly stores = new Map<string, StoreData>();
	version = 0;
}

class TransactionDouble {
	oncomplete: Handler = null;
	onerror: Handler = null;
	onabort: Handler = null;
	error: Error | null = null;

	private pending = 0;
	private settled = false;

	constructor(private readonly data: DatabaseData) {
		this.scheduleComplete();
	}

	objectStore(name: string): ObjectStoreDouble {
		const store = this.data.stores.get(name);
		if (store === undefined) {
			throw new Error(`No object store named "${name}"`);
		}
		return new ObjectStoreDouble(store, this);
	}

	/** Queue one request against this transaction, settling it on a microtask. */
	enqueue<T>(work: () => T): RequestDouble<T> {
		const request = new RequestDouble<T>();
		this.pending += 1;
		queueMicrotask(() => {
			this.pending -= 1;
			try {
				request.result = work();
				request.onsuccess?.();
			} catch (cause) {
				request.error =
					cause instanceof Error ? cause : new Error(String(cause));
				this.error = request.error;
				request.onerror?.();
			}
			this.scheduleComplete();
		});
		return request;
	}

	private scheduleComplete(): void {
		queueMicrotask(() => {
			if (this.settled || this.pending > 0) {
				return;
			}
			this.settled = true;
			this.oncomplete?.();
		});
	}
}

class ObjectStoreDouble {
	constructor(
		private readonly data: StoreData,
		private readonly transaction: TransactionDouble,
	) {}

	put(value: Row): RequestDouble<string> {
		return this.transaction.enqueue(() => {
			const key = value[this.data.keyPath];
			if (typeof key !== "string") {
				throw new Error(`Row is missing its keyPath "${this.data.keyPath}"`);
			}
			this.data.rows.set(key, { ...value });
			return key;
		});
	}

	get(key: string): RequestDouble<Row | undefined> {
		return this.transaction.enqueue(() => this.data.rows.get(key));
	}

	delete(key: string): RequestDouble<undefined> {
		return this.transaction.enqueue(() => {
			this.data.rows.delete(key);
			return undefined;
		});
	}

	clear(): RequestDouble<undefined> {
		return this.transaction.enqueue(() => {
			this.data.rows.clear();
			return undefined;
		});
	}

	createIndex(name: string, keyPath: string): IndexDouble {
		this.data.indexes.set(name, keyPath);
		return this.index(name);
	}

	index(name: string): IndexDouble {
		const keyPath = this.data.indexes.get(name);
		if (keyPath === undefined) {
			throw new Error(`No index named "${name}"`);
		}
		return new IndexDouble(this.data, keyPath, this.transaction);
	}
}

class IndexDouble {
	constructor(
		private readonly data: StoreData,
		private readonly keyPath: string,
		private readonly transaction: TransactionDouble,
	) {}

	getAll(query?: string): RequestDouble<Row[]> {
		return this.transaction.enqueue(() =>
			this.matches(query).map(([, row]) => row),
		);
	}

	getAllKeys(query?: string): RequestDouble<string[]> {
		return this.transaction.enqueue(() =>
			this.matches(query).map(([key]) => key),
		);
	}

	private matches(query: string | undefined): Array<[string, Row]> {
		return [...this.data.rows.entries()].filter(
			([, row]) => query === undefined || row[this.keyPath] === query,
		);
	}
}

class DatabaseDouble {
	constructor(private readonly data: DatabaseData) {}

	get objectStoreNames(): { contains(name: string): boolean } {
		const stores = this.data.stores;
		return { contains: (name: string) => stores.has(name) };
	}

	createObjectStore(
		name: string,
		options: { keyPath: string },
	): ObjectStoreDouble {
		const store = new StoreData(options.keyPath);
		this.data.stores.set(name, store);
		return new ObjectStoreDouble(store, new TransactionDouble(this.data));
	}

	transaction(_names: string | string[], _mode?: string): TransactionDouble {
		return new TransactionDouble(this.data);
	}

	close(): void {
		// Nothing to release.
	}
}

/** `indexedDB` double. One instance holds every database opened through it. */
export class IndexedDBDouble {
	private readonly databases = new Map<string, DatabaseData>();

	open(name: string, version?: number): RequestDouble<DatabaseDouble> {
		const request = new RequestDouble<DatabaseDouble>();
		queueMicrotask(() => {
			let data = this.databases.get(name);
			const isNew = data === undefined;
			if (data === undefined) {
				data = new DatabaseData();
				this.databases.set(name, data);
			}
			request.result = new DatabaseDouble(data);
			if (isNew || (version !== undefined && version > data.version)) {
				data.version = version ?? 1;
				request.onupgradeneeded?.();
			}
			request.onsuccess?.();
		});
		return request;
	}

	deleteDatabase(name: string): RequestDouble<undefined> {
		const request = new RequestDouble<undefined>();
		this.databases.delete(name);
		queueMicrotask(() => {
			request.result = undefined;
			request.onsuccess?.();
		});
		return request;
	}
}

// ============================================================================
// chrome.storage
// ============================================================================

/**
 * One `chrome.storage` area (`local` or `session`).
 *
 * Models the three behaviours the chrome adapter depends on:
 *
 *   1. **A missing key is an absent property**, not `undefined` — `get("nope")` answers
 *      `{}`. This is what makes `""` distinguishable from "never written", the sharp edge
 *      the conformance suite pins.
 *   2. `remove` of a key that was never written **resolves**, it does not reject.
 *   3. `get(null)` returns the entire area, which is how `kvListKeys` enumerates.
 *
 * Values are typed `unknown` because real `chrome.storage` accepts any structured-cloneable
 * value; the adapter only ever writes strings, and reading back a non-string must yield
 * `null` rather than a cast.
 */
export class ChromeStorageAreaDouble {
	private readonly entries = new Map<string, unknown>();

	async get(keys: string | string[] | null): Promise<Record<string, unknown>> {
		const wanted =
			keys === null
				? [...this.entries.keys()]
				: Array.isArray(keys)
					? keys
					: [keys];
		const result: Record<string, unknown> = {};
		for (const key of wanted) {
			if (this.entries.has(key)) {
				result[key] = this.entries.get(key);
			}
		}
		return result;
	}

	async set(items: Record<string, unknown>): Promise<void> {
		for (const [key, value] of Object.entries(items)) {
			this.entries.set(key, value);
		}
	}

	async remove(keys: string | string[]): Promise<void> {
		for (const key of Array.isArray(keys) ? keys : [keys]) {
			this.entries.delete(key);
		}
	}

	/** Real `chrome.storage` has this, and it is how a test simulates a restart. */
	async clear(): Promise<void> {
		this.entries.clear();
	}
}

export interface InstalledChromeStorage {
	local: ChromeStorageAreaDouble;
	session: ChromeStorageAreaDouble;
	/** Put back whatever was on `globalThis.chrome` before `installChromeStorage` ran. */
	restore(): void;
}

/**
 * Replace `globalThis.chrome` with an object exposing two empty, independent storage areas.
 *
 * Pair it with `installBrowserGlobals()` — the chrome adapter's `RecordPort` is the same
 * IndexedDB one web uses, so a chrome test needs both installers.
 */
export function installChromeStorage(): InstalledChromeStorage {
	const target = globalThis as unknown as { chrome?: unknown };
	const previous = target.chrome;

	const areas = {
		local: new ChromeStorageAreaDouble(),
		session: new ChromeStorageAreaDouble(),
	};

	target.chrome = { storage: areas };

	return {
		...areas,
		restore: () => {
			target.chrome = previous;
		},
	};
}

// ============================================================================
// Installing them as globals
// ============================================================================

interface BrowserGlobals {
	localStorage?: unknown;
	sessionStorage?: unknown;
	indexedDB?: unknown;
}

export interface InstalledBrowserGlobals {
	localStorage: StorageDouble;
	sessionStorage: StorageDouble;
	indexedDB: IndexedDBDouble;
	/** Put back whatever was on `globalThis` before `installBrowserGlobals` ran. */
	restore(): void;
}

/**
 * Replace `globalThis.localStorage` / `sessionStorage` / `indexedDB` with empty doubles.
 *
 * Call it once per test (the conformance suite's `make()` does exactly that) so each test
 * starts from a clean store, and `restore()` afterwards so the globals do not leak into
 * other test files sharing the process.
 */
export function installBrowserGlobals(): InstalledBrowserGlobals {
	const target = globalThis as unknown as BrowserGlobals;
	const previous: BrowserGlobals = {
		localStorage: target.localStorage,
		sessionStorage: target.sessionStorage,
		indexedDB: target.indexedDB,
	};

	const doubles = {
		localStorage: new StorageDouble(),
		sessionStorage: new StorageDouble(),
		indexedDB: new IndexedDBDouble(),
	};

	target.localStorage = doubles.localStorage;
	target.sessionStorage = doubles.sessionStorage;
	target.indexedDB = doubles.indexedDB;

	return {
		...doubles,
		restore: () => {
			target.localStorage = previous.localStorage;
			target.sessionStorage = previous.sessionStorage;
			target.indexedDB = previous.indexedDB;
		},
	};
}
