/**
 * In-process doubles for the three Tauri modules the desktop adapter loads.
 *
 * `bun test` has no Tauri runtime: `invoke` has no backend to answer it and the store
 * plugin has no `app_data_dir` to write into. The adapter reaches those modules through its
 * `TauriDeps` seam, so a test supplies these instead and exercises the real port code.
 *
 * They live outside `browser-test-doubles.ts` because nothing is shared: the web and chrome
 * adapters need browser globals, and the desktop adapter needs none of them.
 *
 * Each double models the behaviour the adapter actually depends on, taken from the real
 * implementations rather than from what would be convenient:
 *
 *   - `apps/desktop/src-tauri/src/keychain.rs` keeps every key in one JSON map under a
 *     single OS keychain entry. A missing key therefore answers `Ok(None)` — it does not
 *     error — and the empty string round-trips as a value, because it is a map entry rather
 *     than a zero-length credential. `KeychainDouble` reproduces both.
 *   - `@tauri-apps/plugin-store`'s `Store.load(path)` returns the *same* store for the same
 *     path, so the platform port and the record port share one `store.json`. The double's
 *     `loadStore` hands back one instance per path for exactly that reason.
 *   - `@choochmeque/tauri-plugin-biometry-api`'s `authenticate` resolves on success and
 *     throws on cancel, lockout or failure; it never returns a code.
 *
 * Nothing here is exported to production code.
 */

import type {
	TauriBiometry,
	TauriBiometryStatus,
	TauriDeps,
	TauriInvoke,
	TauriRecordStoreApplyArgs,
	TauriRecordStoreEntry,
	TauriStore,
} from "./tauri";

// ============================================================================
// store.json
// ============================================================================

/**
 * `@tauri-apps/plugin-store`'s `Store`, in memory.
 *
 * Records the calls that cost something: `saves` is the fsync budget a test asserts on, and
 * `sets` is what proves `recordPut` writes one key rather than rewriting a collection.
 */
export class TauriStoreDouble implements TauriStore {
	readonly contents = new Map<string, unknown>();
	/** Every plugin-store method crosses the Tauri IPC boundary in production. */
	ipcCalls = 0;
	/** Every `set` call, in order, as `[key, value]`. */
	readonly sets: Array<[string, unknown]> = [];
	/** Every deleted key, in order. */
	readonly deletes: string[] = [];
	/** Every single-key read, in order. Each one is an IPC round trip. */
	readonly gets: string[] = [];
	/** How many times `save()` — an fsync in production — has been called. */
	saves = 0;

	async get<T>(key: string): Promise<T | undefined> {
		this.ipcCalls += 1;
		this.gets.push(key);
		return this.contents.has(key) ? (this.contents.get(key) as T) : undefined;
	}

	async set(key: string, value: unknown): Promise<void> {
		this.ipcCalls += 1;
		this.sets.push([key, value]);
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

	async entries<T>(): Promise<Array<[string, T]>> {
		this.ipcCalls += 1;
		return [...this.contents] as Array<[string, T]>;
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
// keychain_* commands
// ============================================================================

/** One recorded `invoke` call, so a test can prove the port issues no other IPC. */
export interface InvokeCall {
	cmd: string;
	args: Record<string, unknown>;
}

/**
 * The `keychain_get` / `keychain_set` / `keychain_delete` commands, in memory.
 *
 * `failNextGet` exists because a keychain backend is entitled to raise for a missing entry
 * even though the current Rust one does not, and the port must turn that into `null`.
 */
export class KeychainDouble {
	readonly entries = new Map<string, string>();
	readonly calls: InvokeCall[] = [];
	readonly recordCalls: InvokeCall[] = [];
	/** When set, the next `keychain_get` rejects with it instead of answering. */
	failNextGet: unknown = null;
	/** When set, every `keychain_delete` rejects with it. */
	failDelete: unknown = null;

	constructor(private readonly store: TauriStoreDouble) {}

	/** Typed exactly as the adapter consumes it. */
	readonly invoke: TauriInvoke = ((
		cmd: string,
		args: Record<string, unknown>,
	): Promise<unknown> => {
		switch (cmd) {
			case "keychain_get": {
				this.calls.push({ cmd, args });
				if (this.failNextGet !== null) {
					const failure = this.failNextGet;
					this.failNextGet = null;
					return Promise.reject(failure);
				}
				const key = String(args.key);
				return Promise.resolve(
					this.entries.has(key) ? this.entries.get(key) : null,
				);
			}
			case "keychain_set": {
				this.calls.push({ cmd, args });
				this.entries.set(String(args.key), String(args.value));
				return Promise.resolve(undefined);
			}
			case "keychain_delete": {
				this.calls.push({ cmd, args });
				if (this.failDelete !== null) {
					return Promise.reject(this.failDelete);
				}
				return Promise.resolve(this.entries.delete(String(args.key)));
			}
			case "record_store_apply": {
				this.recordCalls.push({ cmd, args });
				this.store.ipcCalls += 1;
				const mutation = args as unknown as TauriRecordStoreApplyArgs;
				let changed = mutation.puts.length > 0;
				for (const prefix of mutation.clearPrefixes) {
					for (const key of [...this.store.contents.keys()]) {
						if (key.startsWith(prefix)) {
							this.store.deletes.push(key);
							changed = this.store.contents.delete(key) || changed;
						}
					}
				}
				for (const key of mutation.deletes) {
					this.store.deletes.push(key);
					changed = this.store.contents.delete(key) || changed;
				}
				for (const { key, value } of mutation.puts) {
					this.store.sets.push([key, value]);
					this.store.contents.set(key, value);
				}
				if (changed) {
					this.store.saves += 1;
				}
				return Promise.resolve(undefined);
			}
			case "record_store_get": {
				this.recordCalls.push({ cmd, args });
				this.store.ipcCalls += 1;
				const value = this.store.contents.get(String(args.key));
				return Promise.resolve(typeof value === "string" ? value : null);
			}
			case "record_store_list": {
				this.recordCalls.push({ cmd, args });
				this.store.ipcCalls += 1;
				const prefix = String(args.prefix);
				const records: TauriRecordStoreEntry[] = [];
				for (const [key, value] of this.store.contents) {
					if (key.startsWith(prefix) && typeof value === "string") {
						records.push({ key, value });
					}
				}
				return Promise.resolve(records);
			}
			default:
				return Promise.reject(
					new Error(`Unexpected Tauri command "${cmd}" from a storage port`),
				);
		}
	}) as unknown as TauriInvoke;
}

// ============================================================================
// Biometry plugin
// ============================================================================

/** `@choochmeque/tauri-plugin-biometry-api`, in memory. */
export class BiometryDouble implements TauriBiometry {
	/** BiometryType 3 is FaceID; see `BIOMETRY_TYPE_NAMES` in `tauri.ts`. */
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
}

// ============================================================================
// Wiring them into TauriDeps
// ============================================================================

export interface TauriDoubles {
	/** Pass this to `createTauriPlatformPort` / `createTauriRecordPort`. */
	deps: TauriDeps;
	store: TauriStoreDouble;
	keychain: KeychainDouble;
	biometry: BiometryDouble;
}

export interface TauriDoublesOptions {
	/** Simulate `@choochmeque/tauri-plugin-biometry-api` not being installed. */
	biometryModuleMissing?: boolean;
}

/**
 * A fresh, empty set of Tauri doubles plus the `TauriDeps` that hand them out.
 *
 * `loadStore` keys its instances by path, mirroring the real plugin, so a platform port and
 * a record port built from the same `deps` see one `store.json` — which is what makes the
 * `record:` / `session:` namespacing inside it worth testing at all.
 */
export function createTauriDoubles(
	options: TauriDoublesOptions = {},
): TauriDoubles {
	const stores = new Map<string, TauriStoreDouble>();
	const store = new TauriStoreDouble();
	stores.set("store.json", store);

	const keychain = new KeychainDouble(store);
	const biometry = new BiometryDouble();

	const deps: TauriDeps = {
		loadStore: async (path) => {
			let handle = stores.get(path);
			if (handle === undefined) {
				handle = new TauriStoreDouble();
				stores.set(path, handle);
			}
			return handle;
		},
		loadInvoke: async () => keychain.invoke,
		loadBiometry: async () => {
			if (options.biometryModuleMissing === true) {
				throw new Error(
					"Cannot find module '@choochmeque/tauri-plugin-biometry-api'",
				);
			}
			return biometry;
		},
	};

	return { deps, store, keychain, biometry };
}
