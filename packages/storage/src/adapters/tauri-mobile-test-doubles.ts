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
 * own sources rather than from what would be convenient — with one honest exception, stated
 * first because it is the one a reader could be misled by:
 *
 *   - **`KeystoreDouble` models the adapter's contract, not `KeystorePlugin.kt`.** It sits at
 *     the invoke boundary and answers the four commands; it does not encrypt, so the envelope
 *     (`v1:<b64 iv>:<b64 ct>`, `Base64.NO_WRAP`, a 128-bit tag, UTF-8, a fresh IV per seal, the
 *     `:` split) is exercised by nothing in this process. Neither is the key-rotation branch in
 *     `getOrCreateKey`, which is the most dangerous code in that plugin. Its failure modes are
 *     *mirrors* of the Kotlin's, written by hand to match it — they constrain this file and the
 *     adapter above it, and they constrain the Kotlin not at all. There are no Kotlin tests. A
 *     test here that reads like a statement about the plugin says so in a comment.
 *
 *   - There are **two** databases here, and the distinction matters. `RealSqliteDatabase` is
 *     `bun:sqlite` — the same engine `tauri-plugin-sql` runs — and it is what says whether the
 *     adapter's SQL is *correct*. `SqlDatabaseDouble` is a hand-written interpreter of the six
 *     statements this adapter issues; it cannot tell right SQL from wrong, because it
 *     whitelists the exact statement strings and was written by the same hand as the adapter.
 *     Its one job is the call log — `executes` and `selects` — which is what proves `recordPut`
 *     and `recordDelete` are O(1). Every *behavioural* record test, including the shared
 *     conformance suite, runs on real SQLite.
 *   - `BiometryDouble` covers only `checkStatus` and `authenticate`, because those are the
 *     only two functions the adapter still uses from that plugin.
 *   - `@tauri-apps/plugin-store`'s `Store.load(path)` returns the *same* store for the same
 *     path, so `loadStore` hands back one instance per path — which is what makes the
 *     `store.json` / `secrets.json` separation observable to a test.
 *   - Each of the three loaders can be made to reject, because "the optional peer dependency
 *     is not installed" is a real deployment and the port must stay total under it.
 *
 * Nothing here is exported to production code.
 */

import { Database, type SQLQueryBindings } from "bun:sqlite";
import type {
	TauriBiometryStatus,
	TauriKeystoreAvailability,
	TauriKeystoreInvoke,
	TauriKeystoreSecretValue,
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
	/**
	 * When set, every `save` rejects with it.
	 *
	 * `save()` is the fsync, so this is the full-disk case: the in-memory mutation lands and
	 * the flush behind it fails.
	 */
	saveFailure: unknown = null;

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
		if (this.saveFailure !== null) {
			throw this.saveFailure;
		}
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
 * **This cannot tell you whether the SQL is correct.** It recognises exactly the six statement
 * shapes in `tauri-mobile.ts` by their literal text and throws on anything else, so any change
 * to the adapter's SQL turns the suite red whether the change was right or wrong; and where it
 * does interpret — `prefixMatches`, `applyUpsert` — it was written from the same understanding
 * as the adapter, so it would happily agree with a shared misunderstanding.
 *
 * What it is for is the **call log**: `executes` and `selects` record every round trip in
 * order, which is how a test proves `recordPut` issues one statement and never reads first.
 * `RealSqliteDatabase` below answers the correctness half.
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

/**
 * `tauri-plugin-sql`'s surface over a **real** in-memory SQLite database.
 *
 * `tauri-plugin-sql` is sqlx over SQLite and `bun:sqlite` is SQLite, so the answers here are
 * SQLite's own: `substr`/`length` count characters, `=` on TEXT is exact and case-sensitive,
 * `ON CONFLICT DO UPDATE` applies row by row in statement order. That is what makes a
 * behavioural test worth running — nothing in this class was written from the adapter's
 * assumptions, so it can disagree with them.
 *
 * The plugin binds `?n` positionally through sqlx; `bun:sqlite` binds positional arguments to
 * parameter indices 1..n, which is the same thing for the statements this adapter issues.
 *
 * Only the two methods `TauriSqlDatabase` declares, plus two read helpers for assertions the
 * port itself cannot express.
 */
export class RealSqliteDatabase implements TauriSqlDatabase {
	private readonly db = new Database(":memory:");

	async execute(
		query: string,
		bindValues: unknown[] = [],
	): Promise<TauriSqlQueryResult> {
		const result = this.db
			.query(query)
			.run(...(bindValues as SQLQueryBindings[]));
		return {
			rowsAffected: result.changes,
			lastInsertId: Number(result.lastInsertRowid),
		};
	}

	async select<TRow>(
		query: string,
		bindValues: unknown[] = [],
	): Promise<TRow[]> {
		return this.db
			.query(query)
			.all(...(bindValues as SQLQueryBindings[])) as TRow[];
	}

	/** Every key in `records`, or `[]` before the table exists. */
	keys(): string[] {
		if (!this.hasTable()) {
			return [];
		}
		return this.db
			.query("SELECT key FROM records")
			.all()
			.map((row) => (row as { key: string }).key);
	}

	/** One row's value, or `null` — read straight from SQLite, not through the port. */
	value(key: string): string | null {
		if (!this.hasTable()) {
			return null;
		}
		const row = this.db
			.query("SELECT value FROM records WHERE key = ?1")
			.get(key) as { value: string } | null;
		// `?? null` and not `|| null`, for the same reason the adapter uses it.
		return row?.value ?? null;
	}

	private hasTable(): boolean {
		return (
			this.db
				.query(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1",
				)
				.all("records").length > 0
		);
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
// tauri-plugin-bittery-keystore
// ============================================================================

/**
 * `apps/mobile/src-tauri/plugins/keystore`, in memory, at the invoke boundary.
 *
 * The double sits where the real seam is — `@tauri-apps/api/core`'s `invoke` — rather than at a
 * hand-shaped facade, because every failure the adapter must survive is an invoke *rejection*:
 * an unregistered plugin rejects, and so does a Keystore that broke mid-call. Modelling them as
 * anything else would let the adapter's `catch` blocks go untested.
 *
 * Its stored values are plaintext. Encryption is `KeystorePlugin.kt`'s business and no test in
 * this process can observe it; what a test can observe is *which* backend a value reached, and
 * that is what `contents` answers. See this file's header for what that leaves unconstrained.
 */
export class KeystoreDouble {
	/** Key -> value, keyed exactly as the adapter sends it (so `secret:`-prefixed). */
	readonly contents = new Map<string, string>();
	/** What `secret_available` answers. */
	available = true;
	/**
	 * The `backing` the probe reports — the Kotlin's own words, as the adapter surfaces them.
	 *
	 * The default is the *pessimistic* one, and deliberately: the only device this has run on is
	 * a Pixel_9 AVD with a software keymaster, where `KeyInfo.getSecurityLevel()` answers
	 * `SECURITY_LEVEL_SOFTWARE`. A security double whose default overstates its protection is
	 * the wrong way round. A test that wants the TEE string sets it.
	 */
	backing =
		"Android Keystore AES-256-GCM, alias bittery_secret_v1, no user-auth required — NOT hardware-backed (software, KeyInfo.securityLevel)";
	/** When set, the probe rejects: the shape of "this build has no such plugin". */
	probeFailure: unknown = null;
	/**
	 * When set, every `secret_get` rejects.
	 *
	 * This is an *IPC-level* rejection — a dead plugin, a broken bridge. A Keystore error inside
	 * the plugin never reaches the adapter as a rejection, because `KeystorePlugin.secretGet`
	 * catches everything and resolves `null`; those two cases are `unreadable` and
	 * `undecryptable` below.
	 */
	getFailure: unknown = null;
	/** When set, every `secret_set` rejects. */
	setFailure: unknown = null;
	/** When set, every `secret_delete` rejects. */
	deleteFailure: unknown = null;
	/**
	 * Reject the `secret_set` after this many have succeeded.
	 *
	 * This is the interrupted-migration case: some keys are in the Keystore, the rest are not,
	 * and the adapter must not have deleted anything from `secrets.json` yet.
	 */
	setFailAfter: number | null = null;
	/**
	 * Keys whose `secret_get` answers a *different* value than was written.
	 *
	 * A write that silently did not land is the reason the migration reads back at all.
	 */
	readonly corruptReadBack = new Set<string>();
	/**
	 * Keys whose read fails **transiently** — `BackendBusyException`, a keystore2 restart.
	 *
	 * The plugin answers `null` and leaves the ciphertext alone, so the value is still here for
	 * the next read. Mirrors `KeystorePlugin.isPermanentlyUnreadable` returning `false`.
	 */
	readonly unreadable = new Set<string>();
	/**
	 * Keys whose ciphertext is **provably** dead — a GCM tag mismatch, a corrupt envelope.
	 *
	 * The plugin answers `null` *and* removes the entry, which is the only case in which it
	 * deletes anything on a read. Mirrors `isPermanentlyUnreadable` returning `true`.
	 */
	readonly undecryptable = new Set<string>();
	/** Every command, in order, with the key it named. */
	readonly calls: Array<{ cmd: string; key?: string }> = [];

	private sets = 0;

	/**
	 * The one cast in this file.
	 *
	 * `TauriKeystoreInvoke` is four overloads with four different return types; a single
	 * implementation cannot be checked against it, in this double or in `defaultDeps`, which
	 * casts `invoke` the same way for the same reason.
	 */
	readonly invoke = ((cmd: string, args?: { key?: string; value?: string }) =>
		this.dispatch(cmd, args)) as unknown as TauriKeystoreInvoke;

	/**
	 * `undefined` rather than `void` in the return union: `secret_set` and `secret_delete`
	 * resolve with nothing, and a `void` sitting beside two real types reads as "returns
	 * nothing at all", which is what biome's `noConfusingVoidType` objects to.
	 */
	private async dispatch(
		cmd: string,
		args?: { key?: string; value?: string },
	): Promise<TauriKeystoreAvailability | TauriKeystoreSecretValue | undefined> {
		this.calls.push({ cmd, key: args?.key });
		switch (cmd) {
			case "plugin:bittery-keystore|secret_available": {
				if (this.probeFailure !== null) {
					throw this.probeFailure;
				}
				return { available: this.available, backing: this.backing };
			}
			case "plugin:bittery-keystore|secret_get": {
				if (this.getFailure !== null) {
					throw this.getFailure;
				}
				const key = requireKey(args);
				if (this.corruptReadBack.has(key)) {
					return { value: "not-what-was-written" };
				}
				if (this.undecryptable.has(key)) {
					// Provably dead: `null`, and the plugin drops the stale ciphertext.
					this.contents.delete(key);
					return { value: null };
				}
				if (this.unreadable.has(key)) {
					// Could not be read *this time*. `null`, and nothing is written: the value
					// must survive for the retry.
					return { value: null };
				}
				// The plugin answers `null` for a key it never held, for one it could not read
				// and for one it can no longer decrypt. All three are `null`, none is a throw,
				// and only the third costs the stored bytes.
				return { value: this.contents.get(key) ?? null };
			}
			case "plugin:bittery-keystore|secret_set": {
				if (this.setFailure !== null) {
					throw this.setFailure;
				}
				if (this.setFailAfter !== null && this.sets >= this.setFailAfter) {
					throw new Error("keystore write interrupted");
				}
				const key = requireKey(args);
				if (args?.value === undefined) {
					throw new Error(`secret_set without a value for ${key}`);
				}
				this.sets += 1;
				this.contents.set(key, args.value);
				return;
			}
			case "plugin:bittery-keystore|secret_delete": {
				if (this.deleteFailure !== null) {
					throw this.deleteFailure;
				}
				this.contents.delete(requireKey(args));
				return;
			}
			default:
				throw new Error(`KeystoreDouble cannot handle: ${cmd}`);
		}
	}

	/** Forget the recorded calls without touching the stored data. */
	resetCallLog(): void {
		this.calls.length = 0;
	}
}

function requireKey(args?: { key?: string }): string {
	if (args?.key === undefined) {
		throw new Error("keystore command called without a key");
	}
	return args.key;
}

// ============================================================================
// Wiring them into TauriMobileDeps
// ============================================================================

/** The shape both factories share; only the database differs. */
interface TauriMobileDoublesOf<TDatabase extends TauriSqlDatabase> {
	/** Pass this to `createTauriMobilePlatformPort` / `createTauriMobileRecordPort`. */
	deps: TauriMobileDeps;
	/** `store.json` — the plain tier. */
	store: TauriMobileStoreDouble;
	/** `secrets.json` — the secret tier, a separate file and therefore a separate double. */
	secrets: TauriMobileStoreDouble;
	database: TDatabase;
	biometry: BiometryDouble;
	/** `tauri-plugin-bittery-keystore` — the secret tier when the probe says yes. */
	keystore: KeystoreDouble;
}

/** Records on real SQLite. The default, and what every behavioural test uses. */
export type TauriMobileDoubles = TauriMobileDoublesOf<RealSqliteDatabase>;

/** Records on the recording interpreter, for the O(1) round-trip assertions only. */
export type TauriMobileCountingDoubles =
	TauriMobileDoublesOf<SqlDatabaseDouble>;

export interface TauriMobileDoublesOptions {
	/** Simulate `@choochmeque/tauri-plugin-biometry-api` not being installed. */
	biometryModuleMissing?: boolean;
	/** Simulate `@tauri-apps/plugin-sql` not being installed. */
	sqlModuleMissing?: boolean;
	/**
	 * Simulate `@tauri-apps/plugin-store` not being installed — or, identically as far as this
	 * port can tell, a `store.json` that will not open at all.
	 */
	storeModuleMissing?: boolean;
	/**
	 * Simulate a build with no Keystore plugin registered at all — iOS, or an APK built before
	 * M1-C9. `loadKeystore` itself rejects, which is the harshest version of "unavailable".
	 */
	keystoreModuleMissing?: boolean;
	/**
	 * Simulate the plugin being present but answering `available: false` — the probe ran and
	 * said no. Distinct from `keystoreModuleMissing`, and the adapter must fall back on both.
	 */
	keystoreUnavailable?: boolean;
}

/**
 * A fresh, empty set of mobile Tauri doubles plus the `TauriMobileDeps` that hand them out.
 *
 * `loadStore` keys its instances by path and `loadDatabase` by URL, mirroring the real
 * plugins, so a platform port and a record port built from the same `deps` see one
 * `store.json`, one `secrets.json` and one database — and a value written to one file cannot
 * turn up in the other by accident.
 */
function buildDoubles<TDatabase extends TauriSqlDatabase>(
	makeDatabase: () => TDatabase,
	options: TauriMobileDoublesOptions,
): TauriMobileDoublesOf<TDatabase> {
	const stores = new Map<string, TauriMobileStoreDouble>();
	const store = new TauriMobileStoreDouble();
	stores.set("store.json", store);
	const secrets = new TauriMobileStoreDouble();
	stores.set("secrets.json", secrets);

	const databases = new Map<string, TDatabase>();
	const database = makeDatabase();
	databases.set("sqlite:bittery-records.db", database);

	const biometry = new BiometryDouble();

	const keystore = new KeystoreDouble();
	if (options.keystoreUnavailable === true) {
		keystore.available = false;
		keystore.backing = "Android Keystore unavailable — probe declined";
	}

	const deps: TauriMobileDeps = {
		loadStore: async (path) => {
			if (options.storeModuleMissing === true) {
				throw new Error("Cannot find module '@tauri-apps/plugin-store'");
			}
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
				handle = makeDatabase();
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
		loadKeystore: async () => {
			if (options.keystoreModuleMissing === true) {
				throw new Error("Cannot find module '@tauri-apps/api/core'");
			}
			return keystore.invoke;
		},
	};

	return { deps, store, secrets, database, biometry, keystore };
}

/**
 * The default doubles: records on a real in-memory SQLite database.
 *
 * Use this unless the test is counting SQL round trips, in which case use
 * `createTauriMobileCountingDoubles` below and say so in the test name.
 */
export function createTauriMobileDoubles(
	options: TauriMobileDoublesOptions = {},
): TauriMobileDoubles {
	return buildDoubles(() => new RealSqliteDatabase(), options);
}

/**
 * Doubles whose database records every statement instead of executing real SQL.
 *
 * The only reason to reach for this is `executes` / `selects` — the O(1) proof. It cannot
 * tell right SQL from wrong; see `SqlDatabaseDouble`.
 */
export function createTauriMobileCountingDoubles(
	options: TauriMobileDoublesOptions = {},
): TauriMobileCountingDoubles {
	return buildDoubles(() => new SqlDatabaseDouble(), options);
}
