/**
 * Tauri desktop adapter — a pure mapping of the two ports onto the OS keychain and
 * `store.json`.
 *
 * There is no policy in this file. No JSON, no encryption, no accountId, no expiry, no
 * knowledge of the tier table, and — deliberately — no in-memory cache. Every primitive
 * takes a string and returns `string | null`. All of that policy lives in `AccountStore` /
 * `ItemCache`.
 *
 * | primitive              | backing store                                        |
 * |------------------------|------------------------------------------------------|
 * | `secret*`              | `invoke("keychain_get" / "keychain_set" / ...)`      |
 * | `kv*` scope `device`   | `store.json`, key as given                           |
 * | `kv*` scope `session`  | `store.json`, key under the `session:` namespace     |
 * | records                | `store.json`, keys `record:{collection}:{id}`        |
 * | biometric              | `@choochmeque/tauri-plugin-biometry-api`             |
 *
 * `sessionSurvivesRestart` is `true`: a desktop process restart does not end the user's
 * session, so `deriveScope` never asks this port for `"session"` in production and every
 * session-bound secret (`jwt_token`, `vault_keys`, `encrypted_private_key`) derives scope
 * `"device"` and lands in the real OS keychain. The `session:` namespace exists only so the
 * port is **total** — `kvGet(key, "session")` must be answerable, and it must not alias the
 * device scope, or the two scopes would silently share a value.
 *
 * A port does no IPC beyond its own primitives: `AccountStore` emits `onUnlockStateChanged`
 * and the desktop app performs any broadcast itself, where a failure can be surfaced.
 *
 * `device_key` is secret-tier, so it lives only in the keychain; this port never mirrors it
 * into `store.json`.
 *
 * `recordPut` / `recordDelete` are O(1) — one `store.set` / `store.delete` on one key.
 *
 * All three Tauri modules are optional peer dependencies, so they stay behind dynamic
 * `import()` and their loaded handles are memoised in a closure. The imports are reachable
 * through a `TauriDeps` seam whose default is exactly those dynamic imports; `tauri.test.ts`
 * passes doubles instead, because a test process has no Tauri IPC to answer them.
 *
 * The only runtime exports are `createTauriPlatformPort` and `createTauriRecordPort`. The
 * rest of this file's exports are types.
 */

import type {
	BiometricPort,
	BiometricPortResult,
	PlatformPort,
} from "../platform-port";
import type { RecordPort } from "../record-port";
import type { StorageScope } from "../tiers";

/**
 * The security-review answer to "is `vault_keys` hardware-backed on desktop?". Yes.
 * Verbatim from the design contract; the four adapters' strings are compared side by side.
 */
const SECRET_BACKING =
	"OS keychain (macOS Keychain / Windows Credential Manager / libsecret) via Tauri keychain_* commands";

/** The one store the desktop app has ever used. */
const STORE_PATH = "store.json";

/**
 * `store.json` holds three disjoint namespaces. Device-scope keys are stored **bare** so
 * the Rust side can read a published `NativeKeyRef` straight out of the store; the other
 * two carry a prefix.
 *
 * Every key `AccountStore` writes begins with `bittery_`, so neither prefix can shadow a
 * real key — but the port never verifies that, because a port must not know the key scheme.
 */
const SESSION_PREFIX = "session:";
const RECORD_PREFIX = "record:";

// ============================================================================
// The Tauri modules, as this adapter uses them
// ============================================================================

/**
 * The slice of `@tauri-apps/plugin-store`'s `Store` this adapter uses.
 *
 * Declared structurally rather than imported as the plugin's `Store` class so the test
 * doubles have five methods to implement instead of a class to subclass. The real `Store`
 * satisfies it.
 */
export interface TauriStore {
	get<T>(key: string): Promise<T | undefined>;
	set(key: string, value: unknown): Promise<void>;
	delete(key: string): Promise<boolean>;
	keys(): Promise<string[]>;
	save(): Promise<void>;
}

/**
 * The three keychain commands `apps/desktop/src-tauri/src/keychain.rs` exposes.
 *
 * That implementation keeps every key in one JSON blob under a single OS keychain entry,
 * which is why a missing key answers `Ok(None)` rather than erroring and why the empty
 * string round-trips as a value — it is a map entry, not a zero-length credential.
 */
export interface TauriInvoke {
	(cmd: "keychain_set", args: { key: string; value: string }): Promise<void>;
	(cmd: "keychain_get", args: { key: string }): Promise<string | null>;
	(cmd: "keychain_delete", args: { key: string }): Promise<boolean>;
}

/** `Status` from `@choochmeque/tauri-plugin-biometry-api`, widened to what we read. */
export interface TauriBiometryStatus {
	isAvailable: boolean;
	biometryType: number;
	error?: string;
	errorCode?: string;
}

/** The slice of `@choochmeque/tauri-plugin-biometry-api` this adapter uses. */
export interface TauriBiometry {
	checkStatus(): Promise<TauriBiometryStatus>;
	/** Resolves on success; **throws** on cancel, lockout, or failure. */
	authenticate(reason: string): Promise<void>;
}

/**
 * How the three optional Tauri modules are obtained.
 *
 * This is a seam, not a test hook: the modules are optional peer dependencies that must
 * stay behind a dynamic `import()` so a web or extension bundle never pulls them in, and
 * naming the loaders makes that requirement checkable instead of incidental. The default is
 * exactly those dynamic imports, so the production path is unchanged.
 */
export interface TauriDeps {
	loadStore(path: string): Promise<TauriStore>;
	loadInvoke(): Promise<TauriInvoke>;
	loadBiometry(): Promise<TauriBiometry>;
}

const defaultDeps: TauriDeps = {
	loadStore: async (path) => {
		const module = await import("@tauri-apps/plugin-store");
		return module.Store.load(path);
	},
	loadInvoke: async () => {
		const module = await import("@tauri-apps/api/core");
		return module.invoke as TauriInvoke;
	},
	loadBiometry: async () =>
		await import("@choochmeque/tauri-plugin-biometry-api"),
};

/** One load per port instance, shared by every call. A rejection is cached too. */
function memoise<T>(load: () => Promise<T>): () => Promise<T> {
	let pending: Promise<T> | null = null;
	return () => {
		pending ??= load();
		return pending;
	};
}

/**
 * The single place this adapter decides durability.
 *
 * `store.save()` is an fsync. The correctness bar is that a `kvSet` which resolves must
 * survive a crash, so every mutating call flushes before it resolves. Multi-key operations
 * (`recordClear`) route all their writes through one `commit` and pay for one fsync, which
 * is the only coalescing possible without weakening that guarantee: anything wider would
 * have to outlive the promise the caller awaited.
 */
async function commit(
	store: TauriStore,
	mutate: () => Promise<unknown>,
): Promise<void> {
	await mutate();
	await store.save();
}

/** `store.json` is JSON, so a value could be anything; the ports only ever write strings. */
async function readString(
	store: TauriStore,
	key: string,
): Promise<string | null> {
	const value = await store.get<unknown>(key);
	return typeof value === "string" ? value : null;
}

// ============================================================================
// Biometric
// ============================================================================

/**
 * `BiometryType` from the plugin, by value: None 0, Auto 1, TouchID 2, FaceID 3, Iris 4.
 *
 * Spelled out rather than imported because the plugin is an optional peer dependency: a
 * value import of its enum would defeat the dynamic-import rule the whole module is behind.
 */
const BIOMETRY_TYPE_NAMES: Readonly<Record<number, string>> = {
	1: "biometric",
	2: "fingerprint",
	3: "face",
	4: "iris",
};

/** Tauri commands reject with plain strings as often as with `Error`s. */
function messageOf(cause: unknown): string {
	if (cause instanceof Error) {
		return cause.message;
	}
	return typeof cause === "string" ? cause : String(cause);
}

/**
 * Translate a native failure into the port's closed set and do nothing else with it.
 *
 * The plugin throws rather than returning a code, so the message is the only signal. Lockout
 * and missing enrolment are distinguished here because the UI wants to say different things
 * about them, and the original message is carried through untouched.
 */
function classifyBiometricFailure(cause: unknown): BiometricPortResult {
	const message = messageOf(cause);
	const probe = message.toLowerCase();
	if (probe.includes("cancel")) {
		return { success: false, error: "user_cancelled", message };
	}
	if (probe.includes("lockout")) {
		return { success: false, error: "lockout", message };
	}
	if (probe.includes("notenrolled") || probe.includes("not enrolled")) {
		return { success: false, error: "not_enrolled", message };
	}
	return { success: false, error: "failed", message };
}

function createTauriBiometricPort(
	loadBiometry: () => Promise<TauriBiometry>,
): BiometricPort {
	/** `null` when the plugin is absent or the probe itself failed — both mean "no". */
	const probe = async (): Promise<TauriBiometryStatus | null> => {
		try {
			return await (await loadBiometry()).checkStatus();
		} catch {
			return null;
		}
	};

	return {
		isAvailable: async () => (await probe())?.isAvailable === true,

		getDetails: async () => {
			const status = await probe();
			if (status === null) {
				return { hasHardware: false, isEnrolled: false };
			}
			if (status.isAvailable) {
				return { hasHardware: true, isEnrolled: true };
			}
			// The plugin folds hardware and enrolment into one flag. Its `errorCode` is
			// the only signal that the sensor exists but nothing is enrolled on it.
			return {
				hasHardware: status.errorCode === "biometryNotEnrolled",
				isEnrolled: false,
			};
		},

		getType: async () => {
			const status = await probe();
			if (status === null || !status.isAvailable) {
				return null;
			}
			return BIOMETRY_TYPE_NAMES[status.biometryType] ?? "biometric";
		},

		authenticate: async (reason) => {
			let biometry: TauriBiometry;
			try {
				biometry = await loadBiometry();
			} catch (cause) {
				return {
					success: false,
					error: "not_available",
					message: messageOf(cause),
				};
			}
			try {
				await biometry.authenticate(reason);
				return { success: true };
			} catch (cause) {
				return classifyBiometricFailure(cause);
			}
		},
	};
}

// ============================================================================
// PlatformPort
// ============================================================================

function scopedKey(key: string, scope: StorageScope): string {
	return scope === "session" ? `${SESSION_PREFIX}${key}` : key;
}

export function createTauriPlatformPort(
	deps: TauriDeps = defaultDeps,
): PlatformPort {
	const store = memoise(() => deps.loadStore(STORE_PATH));
	const invoke = memoise(() => deps.loadInvoke());

	return {
		platform: "desktop",
		sessionSurvivesRestart: true,
		tiers: ["secret", "plain"],
		secretBacking: SECRET_BACKING,
		// The Rust host reads `store.json` directly, so it must be told where records sit.
		recordKeyPrefix: RECORD_PREFIX,
		biometric: createTauriBiometricPort(memoise(() => deps.loadBiometry())),

		initialize: async () => {
			await store();
			await invoke();
		},

		secretGet: async (key) => {
			try {
				return (await (await invoke())("keychain_get", { key })) ?? null;
			} catch {
				// The current Rust command answers `Ok(None)` for a missing key, but a
				// keychain backend is entitled to raise instead, and "absent" must never
				// reach the caller as a throw.
				return null;
			}
		},
		secretSet: async (key, value) => {
			await (await invoke())("keychain_set", { key, value });
		},
		secretDelete: async (key) => {
			try {
				await (await invoke())("keychain_delete", { key });
			} catch {
				// Deleting an absent key is a no-op, never a throw.
			}
		},

		kvGet: async (key, scope) =>
			readString(await store(), scopedKey(key, scope)),
		kvSet: async (key, value, scope) => {
			const handle = await store();
			await commit(handle, () => handle.set(scopedKey(key, scope), value));
		},
		kvDelete: async (key, scope) => {
			const handle = await store();
			await commit(handle, () => handle.delete(scopedKey(key, scope)));
		},
		kvListKeys: async (prefix) => {
			const found = new Set<string>();
			for (const stored of await (await store()).keys()) {
				if (stored.startsWith(RECORD_PREFIX)) {
					// The record port's namespace. Records are not kv keys.
					continue;
				}
				const key = stored.startsWith(SESSION_PREFIX)
					? stored.slice(SESSION_PREFIX.length)
					: stored;
				if (key.startsWith(prefix)) {
					found.add(key);
				}
			}
			return [...found].sort();
		},
	};
}

// ============================================================================
// RecordPort — one store.json key per record
// ============================================================================

/**
 * `collection` and `id` are opaque strings the port must never parse, so the id is
 * recovered by slicing off a prefix of known length rather than by splitting on `:`.
 */
function collectionPrefix(collection: string): string {
	return `${RECORD_PREFIX}${collection}:`;
}

function recordKey(collection: string, id: string): string {
	return `${collectionPrefix(collection)}${id}`;
}

export function createTauriRecordPort(
	deps: TauriDeps = defaultDeps,
): RecordPort {
	const store = memoise(() => deps.loadStore(STORE_PATH));

	/** Keys currently in the store that belong to `collection`. */
	const keysIn = async (
		handle: TauriStore,
		collection: string,
	): Promise<string[]> => {
		const prefix = collectionPrefix(collection);
		return (await handle.keys()).filter((key) => key.startsWith(prefix));
	};

	return {
		recordKeyPrefix: RECORD_PREFIX,
		initialize: async () => {
			await store();
		},

		recordPut: async (collection, id, value) => {
			const handle = await store();
			await commit(handle, () => handle.set(recordKey(collection, id), value));
		},

		recordGet: async (collection, id) =>
			readString(await store(), recordKey(collection, id)),

		recordDelete: async (collection, id) => {
			const handle = await store();
			await commit(handle, () => handle.delete(recordKey(collection, id)));
		},

		recordList: async (collection) => {
			const handle = await store();
			const prefix = collectionPrefix(collection);
			const records: Array<{ id: string; value: string }> = [];
			for (const key of await keysIn(handle, collection)) {
				const value = await readString(handle, key);
				if (value !== null) {
					records.push({ id: key.slice(prefix.length), value });
				}
			}
			return records;
		},

		recordClear: async (collection) => {
			const handle = await store();
			const keys = await keysIn(handle, collection);
			if (keys.length === 0) {
				return;
			}
			// N deletes, one fsync — the widest coalescing that still flushes before the
			// call the caller awaited resolves.
			await commit(handle, async () => {
				for (const key of keys) {
					await handle.delete(key);
				}
			});
		},
	};
}
