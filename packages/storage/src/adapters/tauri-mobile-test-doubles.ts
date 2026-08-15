/**
 * In-process doubles for the three Tauri modules the mobile adapter loads.
 *
 * `bun test` has no Tauri runtime: there is no IPC to answer `plugin:sql|execute`, no app
 * sandbox for `store.json`, and no biometric sensor. The adapter reaches those modules through
 * its `TauriMobileDeps` seam, so a test supplies these instead and exercises the real port
 * code.
 *
 * They live beside `tauri-test-doubles.ts` rather than inside it because the two adapters
 * share no backing store: desktop's secrets are `keychain_*` invoke commands and its records
 * are `store.json` keys, where mobile's secrets are a second plugin-store file and its records
 * are SQLite rows.
 *
 * Each double models the behaviour the adapter actually depends on, taken from the plugins'
 * own sources rather than from what would be convenient:
 *
 *   - `SqlDatabaseDouble` **executes** the SQL the adapter issues rather than pattern-matching
 *     it to a canned answer. It applies `ON CONFLICT ... DO UPDATE` row by row in statement
 *     order, binds `?n` positionally, and evaluates `substr(key, 1, length(?1)) = ?2` over
 *     Unicode code points exactly as SQLite does. If the adapter's SQL were wrong, the suite
 *     would fail here rather than passing against a double that agreed with the bug.
 *   - `BiometryDouble` covers only `checkStatus` and `authenticate`, because those are the
 *     only two functions the adapter still uses from that plugin.
 *   - `@tauri-apps/plugin-store`'s `Store.load(path)` returns the *same* store for the same
 *     path, so `loadStore` hands back one instance per path — which is what makes the
 *     `store.json` / `secrets.json` separation observable to a test.
 *
 * Nothing here is exported to production code.
 */

import type {
	TauriBiometryStatus,
	TauriMobileBiometry,
	TauriMobileDeps,
	TauriSqlDatabase,
	TauriSqlQueryResult,
	TauriStore,
} from "./tauri-mobile";

// ============================================================================
// The plugin-store files
// ============================================================================

/**
 * `@tauri-apps/plugin-store`'s `Store`, in memory.
 *
 * Records the calls that cost something: `saves` is the fsync budget a test asserts on, and
 * `sets` is what proves a value reached one store file rather than the other.
 */
export class TauriMobileStoreDouble implements TauriStore {
	readonly contents = new Map<string, unknown>();
	/** Every plugin-store method crosses the Tauri IPC boundary in production. */
	ipcCalls = 0;
	/** Every `set` call, in order, as `[key, value]`. */
	readonly sets: Array<[string, unknown]> = [];
	/** Every deleted key, in order. */
	readonly deletes: string[] = [];
	/** Every single-key read, in order. */
	readonly gets: string[] = [];
	/** How many times `save()` — an fsync in production — has been called. */
	saves = 0;
	/** When set, every `set` rejects with it: a store file that cannot accept a write. */
	setFailure: unknown = null;

	async get<T>(key: string): Promise<T | undefined> {
		this.ipcCalls += 1;
		this.gets.push(key);
		return this.contents.has(key) ? (this.contents.get(key) as T) : undefined;
	}

	async set(key: string, value: unknown): Promise<void> {
		this.ipcCalls += 1;
		this.sets.push([key, value]);
		if (this.setFailure !== null) {
			throw this.setFailure;
		}
		this.contents.set(key, value);
	}

	async delete(key: string): Promise<boolean> {
		this.ipcCalls += 1;
		this.deletes.push(key);
		return this.contents.delete(key);
	}

	async keys(): Promise<string[]> {
		this.ipcCalls += 1;
		return [...this.contents.keys()];
	}

	async save(): Promise<void> {
		this.ipcCalls += 1;
		this.saves += 1;
	}

	/** Forget the recorded calls without touching the stored data. */
	resetCallLog(): void {
		this.ipcCalls = 0;
		this.sets.length = 0;
		this.deletes.length = 0;
		this.gets.length = 0;
		this.saves = 0;
	}
}

// ============================================================================
// tauri-plugin-sql
// ============================================================================

/** One statement the adapter issued, so a test can count round trips and prove O(1). */
export interface SqlCall {
	query: string;
	values: readonly unknown[];
}

/** Collapse the whitespace a template literal leaves in a statement. */
function normalise(query: string): string {
	return query.trim().replace(/\s+/gu, " ");
}

/**
 * Substitute the `?n` placeholders a statement carries.
 *
 * `tauri-plugin-sql` binds positionally through sqlx, and every value this adapter binds is a
 * `TEXT` column, so resolving `?n` to `values[n - 1]` is the whole binding model.
 *
 * The plugin types its bind array as `unknown[]`, so the string check is real rather than
 * ceremonial: it fails a statement that bound something the `records` schema could not hold.
 */
function bound(values: readonly unknown[], placeholder: string): string {
	const index = Number.parseInt(placeholder.slice(1), 10) - 1;
	const value = values[index];
	if (typeof value !== "string") {
		throw new Error(`No TEXT bind value for ${placeholder}`);
	}
	return value;
}

/**
 * SQLite's `substr(key, 1, length(prefix)) = compare`, over **code points**.
 *
 * SQLite measures and slices TEXT in characters, not UTF-16 code units, so the double does the
 * same. A double that used `String.prototype.slice` would agree with a buggy adapter above the
 * BMP.
 */
function prefixMatches(key: string, prefix: string, compare: string): boolean {
	const length = [...prefix].length;
	return [...key].slice(0, length).join("") === compare;
}

/**
 * The one table this adapter uses, as an interpreter for the statements it issues.
 *
 * It is not a general SQL engine: it recognises exactly the six statement shapes in
 * `tauri-mobile.ts` and throws on anything else, so a change to the adapter's SQL that this
 * double has not been taught cannot pass silently.
 */
export class SqlDatabaseDouble implements TauriSqlDatabase {
	/** The `records` table: key -> value. Insertion order is the natural row order. */
	readonly rows = new Map<string, string>();
	/** True once `CREATE TABLE IF NOT EXISTS records` has run. */
	created = false;
	/** Every mutating statement, in order. */
	readonly executes: SqlCall[] = [];
	/** Every read statement, in order. */
	readonly selects: SqlCall[] = [];

	async execute(
		query: string,
		bindValues: unknown[] = [],
	): Promise<TauriSqlQueryResult> {
		const statement = normalise(query);
		this.executes.push({ query: statement, values: [...bindValues] });
		this.requireTableFor(statement);

		if (statement.startsWith("CREATE TABLE IF NOT EXISTS records")) {
			this.created = true;
			return { rowsAffected: 0, lastInsertId: 0 };
		}

		const upsert = statement.match(
			/^INSERT INTO records \(key, value\) VALUES (.+) ON CONFLICT\(key\) DO UPDATE SET value = excluded\.value$/u,
		);
		if (upsert?.[1] !== undefined) {
			return this.applyUpsert(upsert[1], bindValues);
		}

		if (statement === "DELETE FROM records WHERE key = ?1") {
			const key = bound(bindValues, "?1");
			return { rowsAffected: this.rows.delete(key) ? 1 : 0, lastInsertId: 0 };
		}

		if (
			statement === "DELETE FROM records WHERE substr(key, 1, length(?1)) = ?2"
		) {
			const prefix = bound(bindValues, "?1");
			const compare = bound(bindValues, "?2");
			let rowsAffected = 0;
			for (const key of [...this.rows.keys()]) {
				if (prefixMatches(key, prefix, compare)) {
					this.rows.delete(key);
					rowsAffected += 1;
				}
			}
			return { rowsAffected, lastInsertId: 0 };
		}

		throw new Error(`SqlDatabaseDouble cannot execute: ${statement}`);
	}

	async select<TRow>(
		query: string,
		bindValues: unknown[] = [],
	): Promise<TRow[]> {
		const statement = normalise(query);
		this.selects.push({ query: statement, values: [...bindValues] });
		this.requireTableFor(statement);

		if (statement === "SELECT value FROM records WHERE key = ?1") {
			const value = this.rows.get(bound(bindValues, "?1"));
			return (value === undefined ? [] : [{ value }]) as TRow[];
		}

		if (
			statement ===
			"SELECT key, value FROM records WHERE substr(key, 1, length(?1)) = ?2"
		) {
			const prefix = bound(bindValues, "?1");
			const compare = bound(bindValues, "?2");
			const matched: Array<{ key: string; value: string }> = [];
			for (const [key, value] of this.rows) {
				if (prefixMatches(key, prefix, compare)) {
					matched.push({ key, value });
				}
			}
			return matched as TRow[];
		}

		throw new Error(`SqlDatabaseDouble cannot select: ${statement}`);
	}

	/** SQLite would answer "no such table" for anything issued before the CREATE. */
	private requireTableFor(statement: string): void {
		if (!this.created && !statement.startsWith("CREATE TABLE")) {
			throw new Error("no such table: records");
		}
	}

	/**
	 * Apply a one- or many-row upsert.
	 *
	 * Row order matters: SQLite processes the tuples in the order written, so a later tuple
	 * updates a row an earlier tuple in the same statement inserted. `recordPutMany`'s
	 * "later records win" contract depends on exactly that, so the double reproduces it
	 * instead of writing the rows into a map all at once.
	 */
	private applyUpsert(
		tuples: string,
		bindValues: readonly unknown[],
	): TauriSqlQueryResult {
		let rowsAffected = 0;
		for (const tuple of tuples.matchAll(/\((\?\d+), (\?\d+)\)/gu)) {
			const keyPlaceholder = tuple[1];
			const valuePlaceholder = tuple[2];
			if (keyPlaceholder === undefined || valuePlaceholder === undefined) {
				throw new Error(`Malformed VALUES tuple: ${tuple[0]}`);
			}
			this.rows.set(
				bound(bindValues, keyPlaceholder),
				bound(bindValues, valuePlaceholder),
			);
			rowsAffected += 1;
		}
		if (rowsAffected === 0) {
			throw new Error(`No VALUES tuples in: ${tuples}`);
		}
		return { rowsAffected, lastInsertId: 0 };
	}

	/** Forget the recorded statements without touching the stored rows. */
	resetCallLog(): void {
		this.executes.length = 0;
		this.selects.length = 0;
	}
}

// ============================================================================
// The biometry plugin
// ============================================================================

/**
 * `@choochmeque/tauri-plugin-biometry-api`, in memory.
 *
 * Two functions, because the adapter uses two. The plugin's secure-data half is deliberately
 * absent: the `secret` tier is `secrets.json` now, and a double that still offered
 * `setData`/`getData` would let a regression back into the plugin go unnoticed rather than
 * failing the suite.
 */
export class BiometryDouble implements TauriMobileBiometry {
	/** BiometryType 3 is FaceID; see `BIOMETRY_TYPE_NAMES` in `tauri-mobile.ts`. */
	status: TauriBiometryStatus = { isAvailable: true, biometryType: 3 };
	/** When set, `checkStatus` rejects with it. */
	statusFailure: unknown = null;
	/** When set, `authenticate` rejects with it — the plugin never returns a code. */
	authFailure: unknown = null;

	/** The reason string of every `authenticate` call, in order. */
	readonly prompts: string[] = [];

	async checkStatus(): Promise<TauriBiometryStatus> {
		if (this.statusFailure !== null) {
			throw this.statusFailure;
		}
		return this.status;
	}

	async authenticate(reason: string): Promise<void> {
		this.prompts.push(reason);
		if (this.authFailure !== null) {
			throw this.authFailure;
		}
	}

	/** Forget the recorded prompts. */
	resetCallLog(): void {
		this.prompts.length = 0;
	}
}

// ============================================================================
// Wiring them into TauriMobileDeps
// ============================================================================

export interface TauriMobileDoubles {
	/** Pass this to `createTauriMobilePlatformPort` / `createTauriMobileRecordPort`. */
	deps: TauriMobileDeps;
	/** `store.json` — the plain tier. */
	store: TauriMobileStoreDouble;
	/** `secrets.json` — the secret tier, a separate file and therefore a separate double. */
	secrets: TauriMobileStoreDouble;
	database: SqlDatabaseDouble;
	biometry: BiometryDouble;
}

export interface TauriMobileDoublesOptions {
	/** Simulate `@choochmeque/tauri-plugin-biometry-api` not being installed. */
	biometryModuleMissing?: boolean;
	/** Simulate `@tauri-apps/plugin-sql` not being installed. */
	sqlModuleMissing?: boolean;
}

/**
 * A fresh, empty set of mobile Tauri doubles plus the `TauriMobileDeps` that hand them out.
 *
 * `loadStore` keys its instances by path and `loadDatabase` by URL, mirroring the real
 * plugins, so a platform port and a record port built from the same `deps` see one
 * `store.json`, one `secrets.json` and one database — and a value written to one file cannot
 * turn up in the other by accident.
 */
export function createTauriMobileDoubles(
	options: TauriMobileDoublesOptions = {},
): TauriMobileDoubles {
	const stores = new Map<string, TauriMobileStoreDouble>();
	const store = new TauriMobileStoreDouble();
	stores.set("store.json", store);
	const secrets = new TauriMobileStoreDouble();
	stores.set("secrets.json", secrets);

	const databases = new Map<string, SqlDatabaseDouble>();
	const database = new SqlDatabaseDouble();
	databases.set("sqlite:bittery-records.db", database);

	const biometry = new BiometryDouble();

	const deps: TauriMobileDeps = {
		loadStore: async (path) => {
			let handle = stores.get(path);
			if (handle === undefined) {
				handle = new TauriMobileStoreDouble();
				stores.set(path, handle);
			}
			return handle;
		},
		loadDatabase: async (url) => {
			if (options.sqlModuleMissing === true) {
				throw new Error("Cannot find module '@tauri-apps/plugin-sql'");
			}
			let handle = databases.get(url);
			if (handle === undefined) {
				handle = new SqlDatabaseDouble();
				databases.set(url, handle);
			}
			return handle;
		},
		loadBiometry: async () => {
			if (options.biometryModuleMissing === true) {
				throw new Error(
					"Cannot find module '@choochmeque/tauri-plugin-biometry-api'",
				);
			}
			return biometry;
		},
	};

	return { deps, store, secrets, database, biometry };
}
