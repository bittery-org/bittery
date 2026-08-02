/**
 * In-process doubles for the three Expo modules the mobile adapter loads.
 *
 * `bun test` has no React Native runtime: `expo-modules-core` cannot even be parsed there,
 * let alone talk to a Keychain. The adapter reaches those modules through its
 * `ReactNativeDeps` seam, so a test supplies these instead and exercises the real port code.
 *
 * They live outside `browser-test-doubles.ts` because nothing is shared: the web and chrome
 * adapters need browser globals, and the mobile adapter needs none of them.
 *
 * Each double models the behaviour the adapter actually depends on, taken from the real
 * implementations rather than from what would be convenient:
 *
 *   - `expo-secure-store` **fails above ~2048 bytes on Android**. `SecureStoreDouble`
 *     enforces that limit, so the conformance suite's 8 KB secret is a real test of the
 *     chunking rather than a formality: remove the chunking and this double throws.
 *   - `expo-sqlite` is SQLite. `SqliteDouble` is therefore backed by `bun:sqlite` rather
 *     than by a hand-written map, so `INSERT OR REPLACE`, the composite primary key, and
 *     `LIKE ... ESCAPE` are exercised as written instead of as imagined. `openDatabaseAsync`
 *     returns the *same* database for the same name, so the platform port and the record
 *     port share one `bittery.db` exactly as they do on device.
 *   - `expo-local-authentication`'s `authenticateAsync` **returns** a result object with a
 *     string `error` code — unlike the Tauri biometry plugin, which throws.
 *
 * Nothing here is exported to production code.
 */

import { Database } from "bun:sqlite";
import type {
	ExpoAuthenticateOptions,
	ExpoAuthenticationResult,
	ExpoLocalAuthentication,
	ExpoSecureStore,
	ExpoSQLiteDatabase,
	ReactNativeDeps,
	SqlParams,
} from "./react-native";

// ============================================================================
// expo-secure-store
// ============================================================================

/** The native `expo-secure-store` limit on Android. */
const ANDROID_SECURE_STORE_LIMIT_BYTES = 2048;

/**
 * `expo-secure-store`, in memory, with the Android size limit enforced.
 *
 * `entries` is deliberately public and raw: the chunking tests assert on what is actually
 * stored — a manifest plus `key.cN` chunks — because "no orphan chunks were left behind"
 * cannot be observed through the port, only through the store underneath it.
 */
export class SecureStoreDouble implements ExpoSecureStore {
	readonly entries = new Map<string, string>();
	/** Every written key, in order. */
	readonly writes: string[] = [];
	/** Every deleted key, in order. */
	readonly deletes: string[] = [];
	/** Reject a value the real store would reject. Raise it to disable the check. */
	maxValueBytes = ANDROID_SECURE_STORE_LIMIT_BYTES;
	/** When set, the next `getItemAsync` rejects with it instead of answering. */
	failNextGet: unknown = null;
	/** When set, every `deleteItemAsync` rejects with it. */
	failDelete: unknown = null;

	async setItemAsync(key: string, value: string): Promise<void> {
		const bytes = new TextEncoder().encode(value).length;
		if (bytes > this.maxValueBytes) {
			throw new Error(
				`Value for key "${key}" is ${bytes} bytes, above the ${this.maxValueBytes}-byte secure store limit`,
			);
		}
		this.writes.push(key);
		this.entries.set(key, value);
	}

	async getItemAsync(key: string): Promise<string | null> {
		if (this.failNextGet !== null) {
			const failure = this.failNextGet;
			this.failNextGet = null;
			throw failure;
		}
		return this.entries.get(key) ?? null;
	}

	async deleteItemAsync(key: string): Promise<void> {
		if (this.failDelete !== null) {
			throw this.failDelete;
		}
		this.deletes.push(key);
		this.entries.delete(key);
	}

	/** Keys currently stored that belong to `key`'s chunk set, in index order. */
	chunkKeysFor(key: string): string[] {
		return [...this.entries.keys()]
			.filter((stored) => stored.startsWith(`${key}.c`))
			.sort();
	}

	/** Forget the recorded calls without touching the stored data. */
	resetCallLog(): void {
		this.writes.length = 0;
		this.deletes.length = 0;
	}
}

// ============================================================================
// expo-sqlite
// ============================================================================

/** `expo-sqlite`'s async surface over a real in-memory SQLite database. */
export class SqliteDouble implements ExpoSQLiteDatabase {
	readonly db = new Database(":memory:");
	/** Every statement executed through `runAsync`, in order. */
	readonly statements: string[] = [];

	async execAsync(source: string): Promise<void> {
		this.db.exec(source);
	}

	async runAsync(source: string, params: SqlParams): Promise<unknown> {
		this.statements.push(source);
		return this.db.query(source).run(...params);
	}

	async getFirstAsync<TRow>(
		source: string,
		params: SqlParams,
	): Promise<TRow | null> {
		return (this.db.query(source).get(...params) as TRow | null) ?? null;
	}

	async getAllAsync<TRow>(source: string, params: SqlParams): Promise<TRow[]> {
		return this.db.query(source).all(...params) as TRow[];
	}

	/** Every row of a table, for assertions the port cannot express. */
	rows<TRow>(table: string): TRow[] {
		return this.db.query(`SELECT * FROM ${table}`).all() as TRow[];
	}

	resetCallLog(): void {
		this.statements.length = 0;
	}
}

// ============================================================================
// expo-local-authentication
// ============================================================================

/** `AuthenticationType` from `expo-local-authentication`, by value. */
export const AUTHENTICATION_TYPE = {
	FINGERPRINT: 1,
	FACIAL_RECOGNITION: 2,
	IRIS: 3,
} as const;

/** `expo-local-authentication`, in memory. */
export class LocalAuthenticationDouble implements ExpoLocalAuthentication {
	hasHardware = true;
	isEnrolled = true;
	supportedTypes: number[] = [AUTHENTICATION_TYPE.FACIAL_RECOGNITION];
	/** What `authenticateAsync` returns; the real module returns codes, never throws. */
	result: ExpoAuthenticationResult = { success: true };
	/** When set, `hasHardwareAsync` / `isEnrolledAsync` / the type probe reject with it. */
	probeFailure: unknown = null;
	/** When set, `authenticateAsync` rejects with it — the native bridge can still die. */
	authFailure: unknown = null;
	/** Every `authenticateAsync` option bag, in order. */
	readonly prompts: ExpoAuthenticateOptions[] = [];

	readonly AuthenticationType = AUTHENTICATION_TYPE;

	async hasHardwareAsync(): Promise<boolean> {
		if (this.probeFailure !== null) {
			throw this.probeFailure;
		}
		return this.hasHardware;
	}

	async isEnrolledAsync(): Promise<boolean> {
		if (this.probeFailure !== null) {
			throw this.probeFailure;
		}
		return this.isEnrolled;
	}

	async supportedAuthenticationTypesAsync(): Promise<number[]> {
		if (this.probeFailure !== null) {
			throw this.probeFailure;
		}
		return this.supportedTypes;
	}

	async authenticateAsync(
		options: ExpoAuthenticateOptions,
	): Promise<ExpoAuthenticationResult> {
		this.prompts.push(options);
		if (this.authFailure !== null) {
			throw this.authFailure;
		}
		return this.result;
	}
}

// ============================================================================
// Wiring them into ReactNativeDeps
// ============================================================================

export interface ReactNativeDoubles {
	/** Pass this to `createReactNativePlatformPort` / `createReactNativeRecordPort`. */
	deps: ReactNativeDeps;
	secureStore: SecureStoreDouble;
	database: SqliteDouble;
	localAuthentication: LocalAuthenticationDouble;
}

export interface ReactNativeDoublesOptions {
	/** Simulate `expo-local-authentication` not being installed. */
	localAuthenticationModuleMissing?: boolean;
	/** Simulate `expo-secure-store` not being installed. */
	secureStoreModuleMissing?: boolean;
}

/**
 * A fresh, empty set of Expo doubles plus the `ReactNativeDeps` that hand them out.
 *
 * `loadDatabase` keys its instances by name, mirroring `openDatabaseAsync`, so a platform
 * port and a record port built from the same `deps` see one `bittery.db` — which is what
 * makes the two tables inside it worth testing at all.
 */
export function createReactNativeDoubles(
	options: ReactNativeDoublesOptions = {},
): ReactNativeDoubles {
	const databases = new Map<string, SqliteDouble>();
	const database = new SqliteDouble();
	databases.set("bittery.db", database);

	const secureStore = new SecureStoreDouble();
	const localAuthentication = new LocalAuthenticationDouble();

	const deps: ReactNativeDeps = {
		loadSecureStore: async () => {
			if (options.secureStoreModuleMissing === true) {
				throw new Error("Cannot find module 'expo-secure-store'");
			}
			return secureStore;
		},
		loadDatabase: async (name) => {
			let handle = databases.get(name);
			if (handle === undefined) {
				handle = new SqliteDouble();
				databases.set(name, handle);
			}
			return handle;
		},
		loadLocalAuthentication: async () => {
			if (options.localAuthenticationModuleMissing === true) {
				throw new Error("Cannot find module 'expo-local-authentication'");
			}
			return localAuthentication;
		},
	};

	return { deps, secureStore, database, localAuthentication };
}
