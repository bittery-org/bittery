/**
 * Tauri mobile adapter — a pure mapping of the two ports onto two `@tauri-apps/plugin-store`
 * files and a SQLite table.
 *
 * There is no policy in this file. No JSON, no encryption, no accountId, no expiry, no
 * knowledge of the tier table, and — deliberately — no in-memory cache. Every primitive takes
 * a string and returns `string | null`. All of that policy lives in `AccountStore` /
 * `ItemCache`.
 *
 * | primitive              | backing store                                                    |
 * |------------------------|------------------------------------------------------------------|
 * | `secret*`              | `tauri-plugin-bittery-keystore` (Android Keystore) when available, else `@tauri-apps/plugin-store`, `secrets.json`, key under `secret:` |
 * | `kv*` scope `device`   | `@tauri-apps/plugin-store`, `store.json`, key as given           |
 * | `kv*` scope `session`  | `store.json`, key under the `session:` namespace                 |
 * | records                | `@tauri-apps/plugin-sql` — a SQLite table, one row per record    |
 * | biometric              | `checkStatus` from `@choochmeque/tauri-plugin-biometry-api`; `authenticate` prefers `plugin:bittery-credential-provider|authenticate` (MainActivity-hosted `BiometricPrompt`) and falls back to the third-party plugin |
 *
 * The secret tier prefers the Android Keystore, through the first-party
 * `apps/mobile/src-tauri/plugins/keystore` plugin, and falls back to `secrets.json` when
 * that plugin is not there to answer — iOS, an old Android, a build without it. The fallback is
 * a **recorded security downgrade**, not a secure store. See `SECRET_BACKING_FALLBACK` below and
 * `docs/mobile-migration-decisions.md` D4b (the Keystore) and D4a (what the fallback costs).
 *
 * `sessionSurvivesRestart` is `true`, for the same reason as the react-native adapter: killing
 * and relaunching a mobile app does not end the user's session. So `deriveScope` never asks
 * this port for `"session"` in production, and every session-bound secret (`jwt_token`,
 * `vault_keys`, `encrypted_private_key`) derives scope `"device"` and lands in the secret
 * store. The `session:` namespace exists only so the port is **total** — `kvGet(key,
 * "session")` must be answerable, and it must not alias the device scope, or the two scopes
 * would silently share a value.
 *
 * This is a sibling of `tauri.ts`, not a subclass of it. The biometric mapping below is a
 * near-copy of the desktop one and that duplication is deliberate: `tauri.ts` is the desktop
 * adapter, and importing from it would make a desktop-only change break mobile. Roughly sixty
 * lines of a closed, rarely-changing mapping is the cheaper of the two costs.
 *
 * All three Tauri modules are optional peer dependencies, so they stay behind dynamic
 * `import()` and their loaded handles are memoised in a closure. That is not a test
 * convenience: it is what keeps these modules out of the web and extension bundles. The
 * imports are reachable through a `TauriMobileDeps` seam whose default is exactly those
 * dynamic imports; `tauri-mobile.test.ts` passes doubles instead, because a test process has
 * no Tauri IPC to answer them.
 *
 * The only runtime exports are `createTauriMobilePlatformPort` and
 * `createTauriMobileRecordPort`. The rest of this file's exports are types.
 */

import type {
	BiometricPort,
	BiometricPortResult,
	PlatformPort,
} from "../platform-port";
import type { RecordPort } from "../record-port";
import type { StorageScope } from "../tiers";

/**
 * The security-review answer to "is `vault_keys` hardware-backed on mobile?" when the Keystore
 * plugin is **not** there to answer. **No.**
 *
 * The secret tier is then a plugin-store JSON file in the app's private directory. It is a
 * different *file* from the plain tier, and nothing more than that: same directory, same
 * permissions, same encryption at rest, no key material held anywhere the OS protects
 * separately. This string says so in the same register `web.ts` uses for `localStorage`,
 * because an auditor will hold us to it.
 *
 * This is also the answer *before* `initialize()`, because before the probe has run it is the
 * truth: nothing has established that a Keystore exists.
 *
 * `docs/mobile-migration-decisions.md` D4a records what it costs. It is still the live path on
 * iOS and on any Android build whose Keystore probe declines; D4b is the Android answer.
 */
const SECRET_BACKING_FALLBACK =
	"@tauri-apps/plugin-store secrets.json — NO at-rest separation from the plain tier; the app's private directory is the trust boundary";

/**
 * The Keystore plugin's own words, prefixed with who is speaking.
 *
 * The suffix is `secret_available`'s `backing` field, built in `KeystorePlugin.kt` from what it
 * actually observed — including whether `KeyInfo` reported the key as hardware-backed. It is
 * **not** rewritten here, because the only value of this string is that it is not aspirational.
 */
function keystoreBacking(reported: string): string {
	return `tauri-plugin-bittery-keystore — ${reported}`;
}

/** The same store file the desktop adapter uses; mobile has its own app sandbox for it. */
const STORE_PATH = "store.json";

/**
 * The secret tier's own file, separate from `STORE_PATH` and deliberately so.
 *
 * One file per tier costs nothing and buys three things: the secret tier is visible as such in
 * a filesystem listing, it can be wiped on its own, and the eventual move to a real keychain
 * has exactly one file to drain.
 */
const SECRETS_STORE_PATH = "secrets.json";

/** `tauri-plugin-sql`'s SQLite URL. One database, one table (see `CREATE_RECORDS_TABLE`). */
const DATABASE_URL = "sqlite:bittery-records.db";

/**
 * `store.json` holds two disjoint namespaces. Device-scope keys are stored bare; session-scope
 * keys carry this prefix so the two scopes are separate keyspaces rather than one shared one.
 *
 * Every key `AccountStore` writes begins with `bittery_`, so the prefix cannot shadow a real
 * key — but the port never verifies that, because a port must not know the key scheme.
 */
const SESSION_PREFIX = "session:";

/**
 * Secrets carry this prefix inside `secrets.json`, even though nothing else lives in that file.
 *
 * It costs nothing and it removes a whole class of future accident: if the two files are ever
 * merged into one — for a migration, or to cut a file open — a secret cannot silently alias a
 * kv key that happens to have the same name.
 */
const SECRET_PREFIX = "secret:";

// ============================================================================
// The Tauri modules, as this adapter uses them
// ============================================================================

/**
 * The slice of `@tauri-apps/plugin-store`'s `Store` this adapter uses.
 *
 * Declared structurally rather than imported as the plugin's `Store` class so the test doubles
 * have a handful of methods to implement instead of a class to subclass. The real `Store`
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
 * Bind parameters, typed as the plugin types them.
 *
 * `unknown[]` and not `readonly string[]`, even though every column this adapter touches is
 * `TEXT`: the plugin's own `execute`/`select` take a mutable `unknown[]`, and a `readonly`
 * parameter type is not assignable to it, so narrowing here would make the real `Database`
 * stop satisfying `TauriSqlDatabase`.
 */
export type SqlBindValues = unknown[];

/** What `tauri-plugin-sql` answers a mutating statement with. */
export interface TauriSqlQueryResult {
	rowsAffected: number;
	/** Optional because the plugin leaves it unset on Postgres. This port reads neither field. */
	lastInsertId?: number;
}

/**
 * The slice of `@tauri-apps/plugin-sql`'s `Database` this adapter uses.
 *
 * Declared structurally rather than imported as the plugin's `Database` class, for the same
 * reason as `TauriStore` above and because the plugin is an optional peer dependency: a value
 * import of its class would defeat the dynamic-import rule this whole module is behind.
 *
 * The real `Database` satisfies this, and `tauri-mobile.test.ts` asserts that at compile time
 * rather than leaving it to a comment. One deliberate difference in wording: the plugin
 * declares `select<T>(...): Promise<T>`, where `T` is the *whole* result rather than a row.
 * `Promise<TRow[]>` is that signature at `T = TRow[]`, which is the only instantiation a
 * `SELECT` ever produces, and it saves every call site from writing the `[]`.
 */
export interface TauriSqlDatabase {
	execute(
		query: string,
		bindValues?: SqlBindValues,
	): Promise<TauriSqlQueryResult>;
	select<TRow>(query: string, bindValues?: SqlBindValues): Promise<TRow[]>;
}

/** `Status` from `@choochmeque/tauri-plugin-biometry-api`, widened to what we read. */
export interface TauriBiometryStatus {
	isAvailable: boolean;
	biometryType: number;
	error?: string;
	errorCode?: string;
}

/**
 * The slice of `@choochmeque/tauri-plugin-biometry-api` this adapter uses, from
 * `dist-js/index.d.ts` of version 0.2.8.
 *
 * Only the two prompting functions. The plugin's secure-data functions
 * (`setData`/`getData`/`removeData`/`hasData`) are **not** listed, because this adapter no
 * longer uses them — see the block comment above `secret*` below.
 */
export interface TauriMobileBiometry {
	checkStatus(): Promise<TauriBiometryStatus>;
	/** Resolves on success; **throws** on cancel, lockout, or failure. */
	authenticate(reason: string): Promise<void>;
}

// ============================================================================
// tauri-plugin-bittery-keystore
// ============================================================================

/** `secret_available`'s answer. See `SecretAvailability` in the plugin's `models.rs`. */
export interface TauriKeystoreAvailability {
	available: boolean;
	/** Surfaced verbatim through `secretBacking`; built from what the Kotlin observed. */
	backing: string;
}

/** `secret_get`'s answer. `null` for both "never written" and "no longer decryptable". */
export interface TauriKeystoreSecretValue {
	value: string | null;
}

/**
 * The four commands of `apps/mobile/src-tauri/plugins/keystore`, as invoke calls.
 *
 * Declared structurally, exactly as `tauri.ts` declares `TauriInvoke`, and reached through
 * `@tauri-apps/api/core`'s `invoke`. There is deliberately **no guest-JS npm package**: the
 * plugin lives in this repo and this app is its only consumer, so a published binding would add
 * a build step and a version to keep in sync without adding a guarantee. The command strings
 * below are the contract, and they must match `build.rs`'s `COMMANDS` and `lib.rs`'s
 * `Builder::new("bittery-keystore")`.
 */
export interface TauriKeystoreInvoke {
	(
		cmd: "plugin:bittery-keystore|secret_available",
	): Promise<TauriKeystoreAvailability>;
	(
		cmd: "plugin:bittery-keystore|secret_get",
		args: { key: string },
	): Promise<TauriKeystoreSecretValue>;
	(
		cmd: "plugin:bittery-keystore|secret_set",
		args: { key: string; value: string },
	): Promise<void>;
	(
		cmd: "plugin:bittery-keystore|secret_delete",
		args: { key: string },
	): Promise<void>;
}

/**
 * How the four optional Tauri modules are obtained.
 *
 * This is a seam, not a test hook: the modules are optional peer dependencies that must stay
 * behind a dynamic `import()` so a web, extension or desktop bundle never pulls them in, and
 * naming the loaders makes that requirement checkable instead of incidental. The default is
 * exactly those dynamic imports, so the production path is unchanged.
 */
export interface TauriMobileDeps {
	loadStore(path: string): Promise<TauriStore>;
	loadDatabase(url: string): Promise<TauriSqlDatabase>;
	loadBiometry(): Promise<TauriMobileBiometry>;
	/**
	 * `@tauri-apps/api/core`'s `invoke`, narrowed to this plugin's commands.
	 *
	 * Loading it cannot fail on a Tauri build — `@tauri-apps/api` is not optional — but
	 * *calling* it will reject when the plugin is not registered, and that rejection is the
	 * probe's "unavailable" answer. Both paths are handled.
	 */
	loadKeystore(): Promise<TauriKeystoreInvoke>;
	/**
	 * First-party biometric prompt hosted on `MainActivity`.
	 *
	 * Returns `null` when that host is not registered (iOS, or an APK built without
	 * `bittery-credential-provider`). The adapter then falls back to the third-party
	 * plugin. Must not *call* authenticate as the probe: that would raise a prompt.
	 */
	loadFirstPartyAuthenticate(): Promise<
		((reason: string) => Promise<void>) | null
	>;
}

const defaultDeps: TauriMobileDeps = {
	loadStore: async (path) => {
		const module = await import("@tauri-apps/plugin-store");
		return module.Store.load(path);
	},
	loadDatabase: async (url) => {
		// No cast: the plugin's real `Database` satisfies `TauriSqlDatabase` structurally, and
		// letting the compiler check that is the whole point of declaring the slice.
		const { default: Database } = await import("@tauri-apps/plugin-sql");
		return Database.load(url);
	},
	// No cast, for the same reason as `loadDatabase`: the plugin's module shape satisfies
	// `TauriMobileBiometry` structurally, and letting the compiler check that is what makes
	// the slice a drift guard rather than a comment.
	loadBiometry: async () =>
		await import("@choochmeque/tauri-plugin-biometry-api"),
	loadKeystore: async () => {
		const module = await import("@tauri-apps/api/core");
		return module.invoke as unknown as TauriKeystoreInvoke;
	},
	loadFirstPartyAuthenticate: async () => {
		try {
			const { invoke } = await import("@tauri-apps/api/core");
			// `is_supported` resolves on Android (plugin present) and rejects on the
			// iOS/desktop stub. It does not raise a prompt.
			await invoke("plugin:bittery-credential-provider|is_supported");
			return async (reason: string) => {
				await invoke("plugin:bittery-credential-provider|authenticate", {
					reason,
				});
			};
		} catch {
			return null;
		}
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

/**
 * The single place this adapter decides durability, for both store-backed tiers.
 *
 * `store.save()` is an fsync. The correctness bar is that a `kvSet` or a `secretSet` which
 * resolves must survive a crash, so every mutating call flushes before it resolves.
 */
async function commit(
	store: TauriStore,
	mutate: () => Promise<unknown>,
): Promise<void> {
	await mutate();
	await store.save();
}

/** A store file is JSON, so a value could be anything; the ports only ever write strings. */
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
 * Spelled out rather than imported because the plugin is an optional peer dependency: a value
 * import of its enum would defeat the dynamic-import rule the whole module is behind.
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

function createTauriMobileBiometricPort(
	loadBiometry: () => Promise<TauriMobileBiometry>,
	loadFirstPartyAuthenticate: () => Promise<
		((reason: string) => Promise<void>) | null
	>,
): BiometricPort {
	/** `null` when the plugin is absent or the probe itself failed — both mean "no". */
	const probe = async (): Promise<TauriBiometryStatus | null> => {
		try {
			return await (await loadBiometry()).checkStatus();
		} catch {
			return null;
		}
	};

	/**
	 * Prefer the first-party host. The third-party plugin's Android path starts a
	 * translucent `BiometryActivity` through `startActivityForResult`; on Tauri 2.11
	 * that either never initialises the launcher or the floating activity is cancelled
	 * before a sheet appears. `CredentialProviderPlugin` already hosts `BiometricPrompt`
	 * on the live `MainActivity`.
	 */
	const firstPartyAuthenticate = memoise(loadFirstPartyAuthenticate);

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
			// The plugin folds hardware and enrolment into one flag. Its `errorCode` is the
			// only signal that the sensor exists but nothing is enrolled on it.
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
			let firstParty: ((prompt: string) => Promise<void>) | null = null;
			try {
				firstParty = await firstPartyAuthenticate();
			} catch {
				firstParty = null;
			}
			if (firstParty !== null) {
				try {
					await firstParty(reason);
					return { success: true };
				} catch (cause) {
					return classifyBiometricFailure(cause);
				}
			}

			let biometry: TauriMobileBiometry;
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

/** One secret key -> one entry in `secrets.json`. See `SECRET_PREFIX`. */
function secretKey(key: string): string {
	return `${SECRET_PREFIX}${key}`;
}

export function createTauriMobilePlatformPort(
	deps: TauriMobileDeps = defaultDeps,
): PlatformPort {
	const store = memoise(() => deps.loadStore(STORE_PATH));
	const secrets = memoise(() => deps.loadStore(SECRETS_STORE_PATH));
	const biometry = memoise(() => deps.loadBiometry());
	const firstPartyAuthenticate = memoise(() =>
		deps.loadFirstPartyAuthenticate(),
	);

	/**
	 * The live secret backend, decided once by `initialize()`.
	 *
	 * `null` means `secrets.json` — before the probe has run, and forever after on any build
	 * where the Keystore plugin did not answer. That is the M1 behaviour, unchanged.
	 */
	let keystore: TauriKeystoreInvoke | null = null;
	let backing = SECRET_BACKING_FALLBACK;

	/**
	 * Drain `secrets.json` into the Keystore, in two phases, so no instant of it loses data.
	 *
	 * Phase 1 writes every secret into the Keystore and **reads it back**; phase 2 deletes the
	 * originals, and only runs if phase 1 verified all of them. So:
	 *
	 *   - a failure or crash inside phase 1 deletes nothing — every value is still in
	 *     `secrets.json`, the caller does not adopt the Keystore, and the next launch retries;
	 *   - a failure or crash inside phase 2 leaves a value in *both* stores, which is harmless
	 *     because they hold the same bytes, and the next launch re-copies and re-deletes.
	 *
	 * Idempotent by construction: a second run over an already-drained store finds no
	 * `secret:`-prefixed keys and does nothing.
	 *
	 * Returns whether the Keystore may now be adopted.
	 */
	const drainSecretsIntoKeystore = async (
		invoke: TauriKeystoreInvoke,
	): Promise<boolean> => {
		const handle = await secrets();
		const stored = (await handle.keys()).filter((key) =>
			key.startsWith(SECRET_PREFIX),
		);
		const verified: string[] = [];
		for (const key of stored) {
			const value = await readString(handle, key);
			if (value === null) {
				// Not a string, so `secretGet` would already answer `null` for it. Nothing to
				// carry over, and nothing to delete either.
				continue;
			}
			await invoke("plugin:bittery-keystore|secret_set", { key, value });
			const readBack = await invoke("plugin:bittery-keystore|secret_get", {
				key,
			});
			if (readBack.value !== value) {
				// Unverified. Phase 2 never runs, so the store keeps every original. The values
				// already written into the Keystore stay there, unowned until the next attempt
				// overwrites them under the same keys — they are copies of data the app still
				// holds, so orphaning them costs nothing and deleting them would add a failure
				// mode to the abort path.
				return false;
			}
			verified.push(key);
		}
		for (const key of verified) {
			await commit(handle, () => handle.delete(key));
		}
		return true;
	};

	/**
	 * The probe, run exactly once. Every failure mode lands on the fallback.
	 *
	 * A rejection from `invoke` is the normal shape of "this build has no such plugin" — an
	 * unregistered command rejects rather than returning — so it is a `false`, not an error.
	 */
	const adoptKeystore = async (): Promise<void> => {
		try {
			const invoke = await deps.loadKeystore();
			const probe = await invoke("plugin:bittery-keystore|secret_available");
			if (probe.available !== true) {
				return;
			}
			if (!(await drainSecretsIntoKeystore(invoke))) {
				return;
			}
			keystore = invoke;
			backing = keystoreBacking(probe.backing);
		} catch {
			// Stay on `secrets.json`. A failure of the new path must degrade to the status
			// quo, never to a broken app.
		}
	};

	return {
		platform: "mobile",
		sessionSurvivesRestart: true,
		tiers: ["secret", "plain"],
		// A getter, because the answer is only known after `initialize()` has probed. Before
		// then it reports the fallback, which is the truth at that moment: nothing has yet
		// established that a Keystore exists. `readonly` on the port is satisfied by a getter.
		get secretBacking() {
			return backing;
		},
		// Records live in their own SQLite table, which no native host reads. The empty
		// string is the honest answer, and `AccountStore` concatenates it unconditionally.
		recordKeyPrefix: "",
		biometric: createTauriMobileBiometricPort(biometry, firstPartyAuthenticate),

		/**
		 * Both store files are opened eagerly. The biometry plugin is loaded lazily on
		 * purpose: a build without it must still expose a *total* biometric port that
		 * answers "no" rather than throwing at boot.
		 */
		initialize: async () => {
			await Promise.all([store(), secrets()]);
			await adoptKeystore();
		},

		/*
		 * The `secret` tier is the Android Keystore when the first-party plugin answers, and
		 * `secrets.json` when it does not.
		 *
		 * A keychain backing was built first, on `@choochmeque/tauri-plugin-biometry-api`'s
		 * secure data, and rejected: its `getData` raises a system biometric prompt on every
		 * read, and `AccountStore` reads `jwt_token` on every API request. A fingerprint
		 * prompt per HTTP call is not a rough edge — the app would be unusable. The other
		 * candidate, `impierce/tauri-plugin-keystore`, is a single 18-month-stale alpha with
		 * no companion package on npm, which is worse supply chain rather than better.
		 *
		 * So `apps/mobile/src-tauri/plugins/keystore` is first-party: one AES-256-GCM
		 * key in the `AndroidKeyStore` provider *without* `setUserAuthenticationRequired`, so
		 * a read costs nothing. `docs/mobile-migration-decisions.md` D4b holds the long form,
		 * including what it does and does not guarantee; D4a holds what the fallback costs when
		 * the plugin is absent.
		 *
		 * The two backends obey the same three rules — missing key answers `null`, deleting
		 * an absent key is a no-op, `secretSet` overwrites — and `secretSet` is the one call
		 * left unwrapped on both, because a store that cannot accept key material is fatal
		 * and there is no second copy to fall back on (CONTEXT.md §4.4).
		 */

		secretGet: async (key) => {
			if (keystore !== null) {
				try {
					const result = await keystore("plugin:bittery-keystore|secret_get", {
						key: secretKey(key),
					});
					return result.value ?? null;
				} catch {
					// Same rule as the store path below: "absent" must never reach the caller
					// as a throw.
					return null;
				}
			}
			try {
				return await readString(await secrets(), secretKey(key));
			} catch {
				// "Absent" must never reach the caller as a throw. The store file can fail to
				// open at all — an uninstalled plugin, a corrupt `secrets.json` — and that is
				// indistinguishable from an empty one to everything above this port.
				return null;
			}
		},

		secretSet: async (key, value) => {
			if (keystore !== null) {
				// Not wrapped, for the same reason as the store path.
				await keystore("plugin:bittery-keystore|secret_set", {
					key: secretKey(key),
					value,
				});
				return;
			}
			// Not wrapped: a store that cannot accept key material is fatal, and there is no
			// second copy to fall back on (CONTEXT.md §4.4).
			const handle = await secrets();
			await commit(handle, () => handle.set(secretKey(key), value));
		},

		secretDelete: async (key) => {
			if (keystore !== null) {
				try {
					await keystore("plugin:bittery-keystore|secret_delete", {
						key: secretKey(key),
					});
				} catch {
					// A throw here would abort `AccountStore.clearSession` mid-way and leave
					// the vault unlocked with `vault_keys` still on disk. That was a real
					// review finding on the store path; the Keystore path must not
					// reintroduce it.
				}
				return;
			}
			try {
				const handle = await secrets();
				// `delete` of an absent key answers `false` rather than throwing, but the
				// `save()` behind it is an fsync and a full disk raises there. A throw here
				// would abort `AccountStore.clearSession` mid-way and leave the vault
				// unlocked with `vault_keys` still on disk, so deleting is a no-op, never a
				// throw — even when the store itself is unusable.
				await commit(handle, () => handle.delete(secretKey(key)));
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
// RecordPort — one SQLite row per record
// ============================================================================

/**
 * One table, created here rather than by a Rust-side plugin migration.
 *
 * `CREATE TABLE IF NOT EXISTS` in `initialize()` means this port does not depend on a
 * migration having run, which matters because the app wiring that registers the migration is
 * a separate change from this one.
 *
 * `RecordPort` is a string key/value contract and `ItemCache` above the port owns all the
 * structure, so a single `key`/`value` pair is the whole schema. The primary key is what makes
 * `recordPut` and `recordDelete` genuinely O(1).
 */
const CREATE_RECORDS_TABLE = `
	CREATE TABLE IF NOT EXISTS records (
		key TEXT PRIMARY KEY NOT NULL,
		value TEXT NOT NULL
	)
`;

/**
 * The prefix every row of one collection shares.
 *
 * `collection` and `id` are opaque strings the port must never parse, so the id is recovered
 * by slicing off a prefix of known length rather than by splitting on `:`.
 *
 * One flat `key TEXT PRIMARY KEY` instead of a `(collection, id)` composite buys the O(1)
 * upsert and costs two assumptions about collection names, both held by `keys.ts`, which
 * mints every one of them:
 *
 *   1. **No collection name may be a prefix of another.** `recordList("a")` would otherwise
 *      return collection `a:b`'s rows as ids like `b:y`, and `recordClear("a")` would delete
 *      them. Today every name is `${accountId}:items`-shaped, and no such name is a prefix of
 *      another.
 *   2. **No collection name may contain a NUL.** SQLite's `length()` stops at the first one,
 *      so `PREFIX_PREDICATE` would compare a truncated prefix: `recordPut` and `recordGet`
 *      would still work while `recordList` returned nothing and `recordClear` deleted
 *      nothing — data invisible and un-clearable rather than loudly broken.
 *
 * Neither is reachable today. Breaking either means moving to a composite primary key, not
 * sanitising the input here: a port must not parse the strings it is given.
 */
function collectionPrefix(collection: string): string {
	return `${collection}:`;
}

function recordKey(collection: string, id: string): string {
	return `${collectionPrefix(collection)}${id}`;
}

/**
 * The prefix predicate, and the one piece of SQL here worth arguing about.
 *
 * The obvious `key LIKE ?` is wrong twice over: `%` and `_` are wildcards, so a collection
 * named `acct_1:items` would match `acct-1:items`; and SQLite's `LIKE` is case-insensitive for
 * ASCII, so `recordClear` would delete another collection's rows outright. An `ESCAPE` clause
 * fixes only the first of those.
 *
 * `substr` with `=` has neither problem: `=` on TEXT is an exact, case-sensitive comparison,
 * and no character in the prefix means anything special. `length(?1)` rather than a
 * JavaScript-computed length because SQLite counts characters where JavaScript's `.length`
 * counts UTF-16 code units, and the two disagree above the BMP; letting SQLite measure the
 * same string it compares removes the disagreement. The cost is a table scan instead of an
 * index range scan, which is the right trade for a store whose largest read (`recordList`) is
 * most of the table anyway.
 */
const PREFIX_PREDICATE = "substr(key, 1, length(?1)) = ?2";

/**
 * Rows per `recordPutMany` statement.
 *
 * Two bound variables each, so 300 rows is 600 variables — under SQLite's `SQLITE_MAX_VARIABLE_NUMBER`,
 * which is 999 on older builds and 32766 on modern ones. A 2 000-item vault bootstrap comes
 * through here, so the batch must be chunked rather than assumed to fit.
 */
const RECORD_PUT_MANY_CHUNK = 300;

interface RecordRow {
	key: string;
	value: string;
}

export function createTauriMobileRecordPort(
	deps: TauriMobileDeps = defaultDeps,
): RecordPort {
	const database = memoise(async () => {
		const handle = await deps.loadDatabase(DATABASE_URL);
		await handle.execute(CREATE_RECORDS_TABLE);
		return handle;
	});

	return {
		recordKeyPrefix: "",

		initialize: async () => {
			await database();
		},

		recordPut: async (collection, id, value) => {
			// One statement, no read first. A read-modify-write here would turn delta sync,
			// which upserts one item at a time, into O(n^2).
			await (await database()).execute(
				"INSERT INTO records (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
				[recordKey(collection, id), value],
			);
		},

		recordPutMany: async (collection, records) => {
			if (records.length === 0) {
				return;
			}
			const handle = await database();
			// One multi-row statement is one implicit transaction, so N rows cost one commit.
			// Explicit BEGIN/COMMIT would be worse, not better: `tauri-plugin-sql` runs each
			// call through a connection *pool*, so the BEGIN and the inserts could land on
			// different connections and the transaction would never contain them.
			//
			// SQLite applies the upsert row by row in the order given, so a later record wins
			// over an earlier one with the same id — exactly as sequential puts would.
			for (
				let offset = 0;
				offset < records.length;
				offset += RECORD_PUT_MANY_CHUNK
			) {
				const chunk = records.slice(offset, offset + RECORD_PUT_MANY_CHUNK);
				const values = chunk
					.map((_unused, index) => `(?${index * 2 + 1}, ?${index * 2 + 2})`)
					.join(", ");
				await handle.execute(
					`INSERT INTO records (key, value) VALUES ${values} ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
					chunk.flatMap((record) => [
						recordKey(collection, record.id),
						record.value,
					]),
				);
			}
		},

		recordGet: async (collection, id) => {
			const rows = await (await database()).select<{ value: string }>(
				"SELECT value FROM records WHERE key = ?1",
				[recordKey(collection, id)],
			);
			// `?? null` and not `|| null`: the empty string is a value, not an absence.
			return rows[0]?.value ?? null;
		},

		recordDelete: async (collection, id) => {
			await (await database()).execute("DELETE FROM records WHERE key = ?1", [
				recordKey(collection, id),
			]);
		},

		recordList: async (collection) => {
			const prefix = collectionPrefix(collection);
			const rows = await (await database()).select<RecordRow>(
				`SELECT key, value FROM records WHERE ${PREFIX_PREDICATE}`,
				[prefix, prefix],
			);
			return rows.map((row) => ({
				id: row.key.slice(prefix.length),
				value: row.value,
			}));
		},

		recordClear: async (collection) => {
			const prefix = collectionPrefix(collection);
			await (await database()).execute(
				`DELETE FROM records WHERE ${PREFIX_PREDICATE}`,
				[prefix, prefix],
			);
		},
	};
}
