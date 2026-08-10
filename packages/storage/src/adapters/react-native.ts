/**
 * React Native mobile adapter — a pure mapping of the two ports onto `expo-secure-store`,
 * `expo-sqlite` and `expo-local-authentication`.
 *
 * There is no policy in this file. No JSON, no encryption, no accountId, no expiry, no
 * knowledge of the tier table, and — deliberately — no in-memory cache. Every primitive
 * takes a string and returns `string | null`. All of that policy lives in `AccountStore` /
 * `ItemCache`.
 *
 * | primitive              | backing store                                          |
 * |------------------------|--------------------------------------------------------|
 * | `secret*`              | `expo-secure-store`, chunked (see below)               |
 * | `kv*` scope `device`   | sqlite `kv_store`, key as given                        |
 * | `kv*` scope `session`  | sqlite `kv_store`, key under the `session:` namespace  |
 * | records                | sqlite `records(collection, id, value)` — real O(1)    |
 * | biometric              | `expo-local-authentication`                            |
 *
 * `sessionSurvivesRestart` is `true`: killing and relaunching the app does not end the
 * user's session, so `deriveScope` never asks this port for `"session"` in production and
 * every session-bound secret (`jwt_token`, `vault_keys`, `encrypted_private_key`) derives
 * scope `"device"` and lands in the real secure store. The `session:` namespace exists only
 * so the port is **total** — `kvGet(key, "session")` must be answerable, and it must not
 * alias the device scope, or the two scopes would silently share a value.
 *
 * ## Chunking, not demotion
 *
 * Tier decides placement; size never does. `expo-secure-store` genuinely fails above
 * ~2048 bytes on Android, so an oversized secret is split into chunks and reassembled on
 * read — see `secretSet` / `secretGet` / `secretDelete` below — rather than falling back to
 * a weaker store. The chunking is not policy: it is this platform's storage mechanism, and
 * it is completely invisible above the seam.
 *
 * All three Expo modules are optional peer dependencies, so they stay behind dynamic
 * `import()` and their loaded handles are memoised in a closure. Metro resolves a dynamic
 * `import()` at build time and hands back an already-resolved promise on native, so the
 * production path is unchanged; a static top-level import would instead be evaluated by
 * every consumer of this package, including `bun test`, where `expo-modules-core` cannot
 * load. The imports are reachable through a `ReactNativeDeps` seam whose default is exactly
 * those dynamic imports; `react-native.test.ts` passes doubles instead.
 *
 * The only runtime exports are `createReactNativePlatformPort` and
 * `createReactNativeRecordPort`. The rest of this file's exports are types.
 */

import {
	arrayBufferToBase64,
	base64ToArrayBuffer,
} from "@bittery/shared/crypto";
import type {
	BiometricPort,
	BiometricPortResult,
	PlatformPort,
} from "../platform-port";
import type { RecordPort } from "../record-port";
import type { StorageScope } from "../tiers";

/**
 * The security-review answer to "is `vault_keys` hardware-backed on mobile?". Yes — for
 * every value, at every size.
 * Verbatim from the design contract; the four adapters' strings are compared side by side.
 */
const SECRET_BACKING =
	"expo-secure-store (iOS Keychain / Android Keystore-backed EncryptedSharedPreferences), chunked for values over the platform size limit";

/** The one database the mobile app has ever used. */
const DATABASE_NAME = "bittery.db";

/**
 * `kv_store` holds both scopes. Device-scope keys are stored bare; session-scope keys carry
 * this prefix so the two scopes are separate keyspaces rather than one shared one.
 *
 * Every key `AccountStore` writes begins with `bittery_`, so the prefix cannot shadow a real
 * key — but the port never verifies that, because a port must not know the key scheme.
 */
const SESSION_PREFIX = "session:";

// ============================================================================
// The Expo modules, as this adapter uses them
// ============================================================================

/**
 * The slice of `expo-secure-store` this adapter uses.
 *
 * Declared structurally rather than imported so the test doubles have three functions to
 * implement, and so `tsc` in this package does not depend on Expo's type surface. The real
 * module satisfies it — its extra trailing `options` parameters are irrelevant here.
 */
export interface ExpoSecureStore {
	setItemAsync(key: string, value: string): Promise<void>;
	getItemAsync(key: string): Promise<string | null>;
	deleteItemAsync(key: string): Promise<void>;
}

/** Bind parameters this adapter passes; every column it touches is `TEXT`. */
export type SqlParams = readonly string[];

/** The slice of `expo-sqlite`'s `SQLiteDatabase` this adapter uses. */
export interface ExpoSQLiteDatabase {
	execAsync(source: string): Promise<void>;
	runAsync(source: string, params: SqlParams): Promise<unknown>;
	getFirstAsync<TRow>(source: string, params: SqlParams): Promise<TRow | null>;
	getAllAsync<TRow>(source: string, params: SqlParams): Promise<TRow[]>;
}

/**
 * `LocalAuthenticationResult` from `expo-local-authentication`, widened to what we read.
 * The real type is a discriminated union; `error` is present only on the failure arm.
 */
export interface ExpoAuthenticationResult {
	success: boolean;
	error?: string;
	warning?: string;
}

/**
 * Deliberately no `cancelLabel` / `fallbackLabel`.
 *
 * Hardcoding strings like `"Cancel"` or `"Use Password"` here would produce user-facing
 * copy below the i18n seam, which `CLAUDE.md` forbids. Omitting them makes iOS and Android
 * supply their own already-localised system labels. Plumbing caller-supplied copy down
 * through the port would only move the same violation one layer deeper.
 *
 * `promptMessage` is the one exception, and it is not copy this package authors: it is the
 * caller's already-translated reason string, passed straight through.
 */
export interface ExpoAuthenticateOptions {
	promptMessage: string;
	disableDeviceFallback: boolean;
}

/** The slice of `expo-local-authentication` this adapter uses. */
export interface ExpoLocalAuthentication {
	hasHardwareAsync(): Promise<boolean>;
	isEnrolledAsync(): Promise<boolean>;
	supportedAuthenticationTypesAsync(): Promise<number[]>;
	authenticateAsync(
		options: ExpoAuthenticateOptions,
	): Promise<ExpoAuthenticationResult>;
	/** `AuthenticationType`: FINGERPRINT 1, FACIAL_RECOGNITION 2, IRIS 3. */
	readonly AuthenticationType: {
		readonly FINGERPRINT: number;
		readonly FACIAL_RECOGNITION: number;
	};
}

/**
 * How the three optional Expo modules are obtained.
 *
 * This is a seam, not a test hook: the modules are optional peer dependencies that must stay
 * behind a dynamic `import()` so a web, extension or desktop bundle never pulls them in, and
 * naming the loaders makes that requirement checkable instead of incidental. The default is
 * exactly those dynamic imports, so the production path is unchanged.
 */
export interface ReactNativeDeps {
	loadSecureStore(): Promise<ExpoSecureStore>;
	loadDatabase(name: string): Promise<ExpoSQLiteDatabase>;
	loadLocalAuthentication(): Promise<ExpoLocalAuthentication>;
}

const defaultDeps: ReactNativeDeps = {
	loadSecureStore: async () => {
		const module = await import("expo-secure-store");
		return module as unknown as ExpoSecureStore;
	},
	loadDatabase: async (name) => {
		const module = await import("expo-sqlite");
		return (await module.openDatabaseAsync(
			name,
		)) as unknown as ExpoSQLiteDatabase;
	},
	loadLocalAuthentication: async () => {
		const module = await import("expo-local-authentication");
		return module as unknown as ExpoLocalAuthentication;
	},
};

/** One load per port instance, shared by every call. A rejection is cached too. */
function memoise<T>(load: () => Promise<T>): () => Promise<T> {
	let pending: Promise<T> | null = null;
	return () => {
		pending ??= load();
		return pending;
	};
}

// ============================================================================
// SecureStore chunking — the central fix
// ============================================================================

/**
 * Largest value written to `expo-secure-store` in one piece, measured in **UTF-8 bytes**
 * rather than JS string length, so a multi-byte value cannot overflow the native limit that
 * a `.length` check would have cleared. Comfortably under the ~2048 bytes above which the
 * Android implementation fails.
 */
const CHUNK_THRESHOLD_BYTES = 1800;

/**
 * Bytes of payload per chunk. Each chunk is base64-encoded before it is stored, which costs
 * 4/3, so 1350 payload bytes produce exactly 1800 base64 characters: every single item this
 * adapter ever hands to `expo-secure-store` is at or under the threshold above.
 */
const CHUNK_PAYLOAD_BYTES = 1350;

/**
 * Marker written in place of an oversized value, followed by the chunk count.
 *
 * Chosen to be implausible as a real value: every value this port stores is produced by
 * `AccountStore` (base64 key material, JSON documents, decimal timestamps), none of which
 * can begin with this string. A value that *did* collide would still be handled safely —
 * `chunkCountOf` only accepts a positive integer suffix, and a mis-parsed manifest whose
 * chunks are absent reads back as `null` rather than as corrupt data.
 */
const CHUNK_MANIFEST_PREFIX = "__bittery_chunked_secret_v1__:";

/** `expo-secure-store` keys allow `.`, `-` and `_`, so this suffix is always valid. */
function chunkKey(key: string, index: number): string {
	return `${key}.c${index}`;
}

function manifestFor(count: number): string {
	return `${CHUNK_MANIFEST_PREFIX}${count}`;
}

/** How many chunks `stored` points at; `0` means "this is an ordinary value". */
function chunkCountOf(stored: string | null): number {
	if (stored === null || !stored.startsWith(CHUNK_MANIFEST_PREFIX)) {
		return 0;
	}
	const count = Number.parseInt(stored.slice(CHUNK_MANIFEST_PREFIX.length), 10);
	return Number.isInteger(count) && count > 0 ? count : 0;
}

/**
 * Split UTF-8 bytes into base64 chunks.
 *
 * Byte safety is structural rather than careful: the split happens on the **encoded byte
 * array**, each slice is base64-encoded (so a chunk is pure ASCII and can never itself be
 * split further), and the pieces are only decoded back to text once the whole byte array has
 * been reassembled. A multi-byte character split across two chunks is therefore impossible
 * by construction, not by a boundary check that could be wrong.
 */
function splitIntoChunks(bytes: Uint8Array): string[] {
	const chunks: string[] = [];
	for (let offset = 0; offset < bytes.length; offset += CHUNK_PAYLOAD_BYTES) {
		chunks.push(
			arrayBufferToBase64(bytes.subarray(offset, offset + CHUNK_PAYLOAD_BYTES)),
		);
	}
	return chunks;
}

function joinChunks(parts: readonly string[]): string {
	const decoded = parts.map((part) => base64ToArrayBuffer(part));
	const total = decoded.reduce((sum, part) => sum + part.length, 0);
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const part of decoded) {
		bytes.set(part, offset);
		offset += part.length;
	}
	return new TextDecoder().decode(bytes);
}

/** A read that answers `null` for anything the store cannot produce, including a throw. */
async function readSecure(
	store: ExpoSecureStore,
	key: string,
): Promise<string | null> {
	try {
		return await store.getItemAsync(key);
	} catch {
		return null;
	}
}

/** Deleting an absent key is a no-op, and so is deleting when the store objects. */
async function deleteSecure(
	store: ExpoSecureStore,
	key: string,
): Promise<void> {
	try {
		await store.deleteItemAsync(key);
	} catch {
		// no-op
	}
}

// ============================================================================
// Biometric
// ============================================================================

/** Native failures the port distinguishes; everything else collapses into `failed`. */
const BIOMETRIC_ERRORS: Readonly<
	Record<string, NonNullable<BiometricPortResult["error"]>>
> = {
	user_cancel: "user_cancelled",
	lockout: "lockout",
	lockout_permanent: "lockout",
	not_enrolled: "not_enrolled",
	not_available: "not_available",
};

function messageOf(cause: unknown): string {
	if (cause instanceof Error) {
		return cause.message;
	}
	return typeof cause === "string" ? cause : String(cause);
}

function createReactNativeBiometricPort(
	loadLocalAuthentication: () => Promise<ExpoLocalAuthentication>,
): BiometricPort {
	/** `null` when the module is absent or the probe itself failed — both mean "no". */
	const probe = async (): Promise<{
		hasHardware: boolean;
		isEnrolled: boolean;
	} | null> => {
		try {
			const local = await loadLocalAuthentication();
			return {
				hasHardware: await local.hasHardwareAsync(),
				isEnrolled: await local.isEnrolledAsync(),
			};
		} catch {
			return null;
		}
	};

	return {
		isAvailable: async () => {
			const details = await probe();
			return details !== null && details.hasHardware && details.isEnrolled;
		},

		getDetails: async () =>
			(await probe()) ?? { hasHardware: false, isEnrolled: false },

		getType: async () => {
			try {
				const local = await loadLocalAuthentication();
				const types = await local.supportedAuthenticationTypesAsync();
				if (types.includes(local.AuthenticationType.FACIAL_RECOGNITION)) {
					return "face";
				}
				if (types.includes(local.AuthenticationType.FINGERPRINT)) {
					return "fingerprint";
				}
				return null;
			} catch {
				return null;
			}
		},

		authenticate: async (reason) => {
			let local: ExpoLocalAuthentication;
			try {
				local = await loadLocalAuthentication();
			} catch (cause) {
				return {
					success: false,
					error: "not_available",
					message: messageOf(cause),
				};
			}
			try {
				const result = await local.authenticateAsync({
					promptMessage: reason,
					disableDeviceFallback: false,
				});
				if (result.success) {
					return { success: true };
				}
				// Translate the native code into the port's closed set and do nothing else
				// with it. The original is carried through untouched so the UI and any bug
				// report keep the fact the platform actually reported.
				const native = result.error ?? "unknown";
				return {
					success: false,
					error: BIOMETRIC_ERRORS[native] ?? "failed",
					message: native,
				};
			} catch (cause) {
				return { success: false, error: "failed", message: messageOf(cause) };
			}
		},
	};
}

// ============================================================================
// sqlite
// ============================================================================

const CREATE_KV_TABLE = `
	CREATE TABLE IF NOT EXISTS kv_store (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL
	);
`;

/**
 * One row per record, keyed by `(collection, id)`.
 *
 * The composite primary key is what makes `recordPut` / `recordDelete` genuinely O(1) and
 * `recordList` an indexed range scan on the key's leading column.
 */
const CREATE_RECORDS_TABLE = `
	CREATE TABLE IF NOT EXISTS records (
		collection TEXT NOT NULL,
		id TEXT NOT NULL,
		value TEXT NOT NULL,
		PRIMARY KEY (collection, id)
	);
`;

/**
 * Open the database and apply one schema statement.
 *
 * Opening can fail transiently on a stale native handle after a Fast Refresh, and a second
 * attempt succeeds. It is not error handling — a second failure propagates.
 */
function openDatabase(
	deps: ReactNativeDeps,
	schema: string,
): () => Promise<ExpoSQLiteDatabase> {
	return memoise(async () => {
		const open = async (): Promise<ExpoSQLiteDatabase> => {
			const database = await deps.loadDatabase(DATABASE_NAME);
			await database.execAsync(schema);
			return database;
		};
		try {
			return await open();
		} catch {
			return await open();
		}
	});
}

/** `_` and `%` are LIKE wildcards, and every `bittery_` key is full of the first one. */
function escapeLikePattern(value: string): string {
	return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

// ============================================================================
// PlatformPort
// ============================================================================

function scopedKey(key: string, scope: StorageScope): string {
	return scope === "session" ? `${SESSION_PREFIX}${key}` : key;
}

export function createReactNativePlatformPort(
	deps: ReactNativeDeps = defaultDeps,
): PlatformPort {
	const secureStore = memoise(() => deps.loadSecureStore());
	const database = openDatabase(deps, CREATE_KV_TABLE);

	/** Keys in `kv_store` that start with `pattern`, exactly and case-sensitively. */
	const keysMatching = async (pattern: string): Promise<string[]> => {
		const rows = await (await database()).getAllAsync<{ key: string }>(
			"SELECT key FROM kv_store WHERE key LIKE ? ESCAPE '\\'",
			[`${escapeLikePattern(pattern)}%`],
		);
		// SQLite's LIKE is case-insensitive for ASCII, so the narrowed set is re-filtered
		// exactly here. The query still does the work an index can do.
		return rows.map((row) => row.key).filter((key) => key.startsWith(pattern));
	};

	return {
		platform: "mobile",
		sessionSurvivesRestart: true,
		tiers: ["secret", "plain"],
		secretBacking: SECRET_BACKING,
		// Records live in their own sqlite table, which no native host reads.
		recordKeyPrefix: "",
		biometric: createReactNativeBiometricPort(
			memoise(() => deps.loadLocalAuthentication()),
		),

		initialize: async () => {
			await database();
			await secureStore();
		},

		secretGet: async (key) => {
			try {
				const store = await secureStore();
				const stored = await readSecure(store, key);
				const count = chunkCountOf(stored);
				if (count === 0) {
					return stored;
				}
				const parts: string[] = [];
				for (let index = 0; index < count; index += 1) {
					const part = await readSecure(store, chunkKey(key, index));
					if (part === null) {
						// A torn write. Reporting a truncated secret would be worse than
						// reporting none, so absence is the answer.
						return null;
					}
					parts.push(part);
				}
				return joinChunks(parts);
			} catch {
				return null;
			}
		},

		secretSet: async (key, value) => {
			const store = await secureStore();
			// Read before writing so the chunks of a previous, larger value can be swept
			// afterwards. Nothing else can tell us how many there were.
			const previousCount = chunkCountOf(await readSecure(store, key));

			const bytes = new TextEncoder().encode(value);
			let nextCount = 0;
			if (bytes.length <= CHUNK_THRESHOLD_BYTES) {
				await store.setItemAsync(key, value);
			} else {
				const parts = splitIntoChunks(bytes);
				nextCount = parts.length;
				for (const [index, part] of parts.entries()) {
					await store.setItemAsync(chunkKey(key, index), part);
				}
				// The manifest goes last: until it lands, `key` still holds whatever it held.
				await store.setItemAsync(key, manifestFor(nextCount));
			}

			for (let index = nextCount; index < previousCount; index += 1) {
				await deleteSecure(store, chunkKey(key, index));
			}
		},

		secretDelete: async (key) => {
			try {
				const store = await secureStore();
				const count = chunkCountOf(await readSecure(store, key));
				for (let index = 0; index < count; index += 1) {
					await deleteSecure(store, chunkKey(key, index));
				}
				await deleteSecure(store, key);
			} catch {
				// Deleting an absent key is a no-op, never a throw.
			}
		},

		kvGet: async (key, scope) => {
			const row = await (await database()).getFirstAsync<{ value: string }>(
				"SELECT value FROM kv_store WHERE key = ?",
				[scopedKey(key, scope)],
			);
			// `?? null` and not `|| null`: the empty string is a value, not an absence.
			return row?.value ?? null;
		},

		kvSet: async (key, value, scope) => {
			await (await database()).runAsync(
				"INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)",
				[scopedKey(key, scope), value],
			);
		},

		kvDelete: async (key, scope) => {
			await (await database()).runAsync("DELETE FROM kv_store WHERE key = ?", [
				scopedKey(key, scope),
			]);
		},

		kvListKeys: async (prefix) => {
			const found = new Set<string>();
			for (const key of await keysMatching(prefix)) {
				// An empty prefix matches the session namespace too; those keys are reported
				// by the pass below, under their logical name.
				if (!key.startsWith(SESSION_PREFIX)) {
					found.add(key);
				}
			}
			for (const key of await keysMatching(`${SESSION_PREFIX}${prefix}`)) {
				found.add(key.slice(SESSION_PREFIX.length));
			}
			return [...found].sort();
		},
	};
}

// ============================================================================
// RecordPort — one sqlite row per record
// ============================================================================

export function createReactNativeRecordPort(
	deps: ReactNativeDeps = defaultDeps,
): RecordPort {
	const database = openDatabase(deps, CREATE_RECORDS_TABLE);

	return {
		recordKeyPrefix: "",
		initialize: async () => {
			await database();
		},

		recordPut: async (collection, id, value) => {
			await (await database()).runAsync(
				"INSERT OR REPLACE INTO records (collection, id, value) VALUES (?, ?, ?)",
				[collection, id, value],
			);
		},

		recordGet: async (collection, id) => {
			const row = await (await database()).getFirstAsync<{ value: string }>(
				"SELECT value FROM records WHERE collection = ? AND id = ?",
				[collection, id],
			);
			return row?.value ?? null;
		},

		recordDelete: async (collection, id) => {
			await (await database()).runAsync(
				"DELETE FROM records WHERE collection = ? AND id = ?",
				[collection, id],
			);
		},

		recordList: async (collection) =>
			await (await database()).getAllAsync<{ id: string; value: string }>(
				"SELECT id, value FROM records WHERE collection = ?",
				[collection],
			),

		recordClear: async (collection) => {
			await (await database()).runAsync(
				"DELETE FROM records WHERE collection = ?",
				[collection],
			);
		},
	};
}
