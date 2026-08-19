/**
 * In-memory fakes for `PlatformPort` and `RecordPort`.
 *
 * These are the test doubles the deep modules (`AccountStore`, `ItemCache`) are exercised
 * against. They are deliberately dumb: they implement the port contract and nothing else,
 * so a test that passes here is a test about policy, not about a platform API.
 *
 * Both fakes expose `simulateRestart()` and call counters so tests can assert on
 * behaviour that is otherwise invisible through the port surface.
 */

import type {
	BiometricPort,
	BiometricPortResult,
	PlatformPort,
} from "../platform-port";
import type { RecordPort } from "../record-port";
import type { StorageScope, StorageTier } from "../tiers";
import type { Platform } from "../types";

/** Call counters on the fake platform port. Reset with `resetCalls()`. */
export interface InMemoryPlatformPortCalls {
	initialize: number;
	secretGet: number;
	secretSet: number;
	secretDelete: number;
	kvGet: number;
	kvSet: number;
	kvDelete: number;
	kvListKeys: number;
	biometricAuthenticate: number;
}

/**
 * Mutable biometric behaviour. Tests drive the fake by assigning to these fields,
 * e.g. `port.biometricState.hasHardware = true`.
 */
export interface InMemoryBiometricState {
	hasHardware: boolean;
	isEnrolled: boolean;
	/** e.g. "face" | "fingerprint" | null */
	type: string | null;
	/** Whether `authenticate()` succeeds. */
	authenticates: boolean;
	/**
	 * The error a failed `authenticate()` reports. Tests drive each value in the closed
	 * set to prove `AccountStore` maps it onto the right `BiometricErrorType` — a bare
	 * boolean here would make `user_cancelled` and `lockout` untestable.
	 */
	authenticateError: NonNullable<BiometricPortResult["error"]>;
	/** Message a failed `authenticate()` reports, or `null` for none. */
	authenticateMessage: string | null;
	/** Reason string passed to the most recent `authenticate()` call. */
	lastReason: string | null;
}

/** Raw view of everything the fake currently holds. Assertions only. */
export interface InMemoryPlatformPortSnapshot {
	secrets: Record<string, string>;
	device: Record<string, string>;
	session: Record<string, string>;
}

export interface InMemoryPlatformPort extends PlatformPort {
	/**
	 * Drop everything written at `session` scope, as a process restart would.
	 *
	 * Note what this does NOT drop: the secret store. `secretGet`/`secretSet` take no
	 * scope — a port has exactly one secret store — so a session-bound value routed to
	 * the secret tier is only as durable as that store. Every real adapter's secret
	 * store survives restart (localStorage, chrome.storage.local, OS keychain,
	 * SecureStore), so the fake models the same thing.
	 */
	simulateRestart(): void;
	readonly calls: InMemoryPlatformPortCalls;
	readonly biometricState: InMemoryBiometricState;
	snapshot(): InMemoryPlatformPortSnapshot;
	resetCalls(): void;
}

export interface InMemoryPlatformPortOptions {
	sessionSurvivesRestart?: boolean;
	tiers?: StorageTier[];
	/**
	 * The prefix a native host would have to prepend to reach a record key. Only the
	 * golden-document tests set it: they reproduce a real desktop `store.json`, where the
	 * published `itemCacheState` ref carries the adapter's `record:` namespace.
	 */
	recordKeyPrefix?: string;
}

function toRecord(map: Map<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of map) {
		out[key] = value;
	}
	return out;
}

export function createInMemoryPlatformPort(
	opts?: InMemoryPlatformPortOptions,
): InMemoryPlatformPort {
	const sessionSurvivesRestart = opts?.sessionSurvivesRestart ?? false;
	const tiers: readonly StorageTier[] = opts?.tiers ?? ["secret", "plain"];
	const recordKeyPrefix = opts?.recordKeyPrefix ?? "";

	// Kept consistent with `sessionSurvivesRestart` so the fake never describes a
	// platform that does not exist. `platform` is data only; nothing branches on it.
	const platform: Platform = sessionSurvivesRestart ? "desktop" : "web";

	const secrets = new Map<string, string>();
	const device = new Map<string, string>();
	const session = new Map<string, string>();

	const calls: InMemoryPlatformPortCalls = {
		initialize: 0,
		secretGet: 0,
		secretSet: 0,
		secretDelete: 0,
		kvGet: 0,
		kvSet: 0,
		kvDelete: 0,
		kvListKeys: 0,
		biometricAuthenticate: 0,
	};

	const biometricState: InMemoryBiometricState = {
		hasHardware: false,
		isEnrolled: false,
		type: null,
		authenticates: false,
		authenticateError: "failed",
		authenticateMessage: null,
		lastReason: null,
	};

	const scopeStore = (scope: StorageScope): Map<string, string> =>
		scope === "session" ? session : device;

	const biometric: BiometricPort = {
		isAvailable: async () =>
			biometricState.hasHardware && biometricState.isEnrolled,
		getDetails: async () => ({
			hasHardware: biometricState.hasHardware,
			isEnrolled: biometricState.isEnrolled,
		}),
		getType: async () => biometricState.type,
		authenticate: async (reason: string): Promise<BiometricPortResult> => {
			calls.biometricAuthenticate += 1;
			biometricState.lastReason = reason;
			if (biometricState.authenticates) {
				return { success: true };
			}
			return {
				success: false,
				error: biometricState.authenticateError,
				...(biometricState.authenticateMessage === null
					? {}
					: { message: biometricState.authenticateMessage }),
			};
		},
	};

	return {
		platform,
		sessionSurvivesRestart,
		tiers,
		secretBacking:
			"in-memory test double — NO at-rest protection whatsoever, tests only",
		// Nothing outside the test process reads the fake record port.
		recordKeyPrefix,
		biometric,
		calls,
		biometricState,

		initialize: async () => {
			calls.initialize += 1;
		},

		secretGet: async (key: string) => {
			calls.secretGet += 1;
			return secrets.get(key) ?? null;
		},
		secretSet: async (key: string, value: string) => {
			calls.secretSet += 1;
			secrets.set(key, value);
		},
		secretDelete: async (key: string) => {
			calls.secretDelete += 1;
			secrets.delete(key);
		},

		kvGet: async (key: string, scope: StorageScope) => {
			calls.kvGet += 1;
			return scopeStore(scope).get(key) ?? null;
		},
		kvSet: async (key: string, value: string, scope: StorageScope) => {
			calls.kvSet += 1;
			scopeStore(scope).set(key, value);
		},
		kvDelete: async (key: string, scope: StorageScope) => {
			calls.kvDelete += 1;
			scopeStore(scope).delete(key);
		},
		kvListKeys: async (prefix: string) => {
			calls.kvListKeys += 1;
			const found = new Set<string>();
			for (const key of device.keys()) {
				if (key.startsWith(prefix)) {
					found.add(key);
				}
			}
			for (const key of session.keys()) {
				if (key.startsWith(prefix)) {
					found.add(key);
				}
			}
			return [...found].sort();
		},

		simulateRestart: () => {
			session.clear();
		},
		snapshot: () => ({
			secrets: toRecord(secrets),
			device: toRecord(device),
			session: toRecord(session),
		}),
		resetCalls: () => {
			calls.initialize = 0;
			calls.secretGet = 0;
			calls.secretSet = 0;
			calls.secretDelete = 0;
			calls.kvGet = 0;
			calls.kvSet = 0;
			calls.kvDelete = 0;
			calls.kvListKeys = 0;
			calls.biometricAuthenticate = 0;
		},
	};
}

/** Call counters on the fake record port. Reset with `resetCalls()`. */
export interface InMemoryRecordPortCalls {
	initialize: number;
	recordPut: number;
	recordPutMany: number;
	recordGet: number;
	recordDelete: number;
	recordList: number;
	recordClear: number;
}

export interface InMemoryRecordPort extends RecordPort {
	/**
	 * No-op: records are always durable. Present so a test can restart the whole fake
	 * environment uniformly without knowing which store keeps what.
	 */
	simulateRestart(): void;
	readonly calls: InMemoryRecordPortCalls;
	/** Collection names that currently hold at least one record. Assertions only. */
	collections(): string[];
	resetCalls(): void;
}

export function createInMemoryRecordPort(
	options: { recordKeyPrefix?: string } = {},
): InMemoryRecordPort {
	// collection -> id -> value. A real per-record map, so put/delete are O(1) here too
	// and a test asserting `calls.recordPut === 1` is asserting the real property.
	const store = new Map<string, Map<string, string>>();

	const calls: InMemoryRecordPortCalls = {
		initialize: 0,
		recordPut: 0,
		recordPutMany: 0,
		recordGet: 0,
		recordDelete: 0,
		recordList: 0,
		recordClear: 0,
	};

	const bucketFor = (collection: string): Map<string, string> => {
		let bucket = store.get(collection);
		if (bucket === undefined) {
			bucket = new Map<string, string>();
			store.set(collection, bucket);
		}
		return bucket;
	};

	return {
		recordKeyPrefix: options.recordKeyPrefix ?? "",
		calls,

		initialize: async () => {
			calls.initialize += 1;
		},

		recordPut: async (collection: string, id: string, value: string) => {
			calls.recordPut += 1;
			bucketFor(collection).set(id, value);
		},
		recordPutMany: async (
			collection: string,
			records: ReadonlyArray<{ id: string; value: string }>,
		) => {
			calls.recordPutMany += 1;
			if (records.length === 0) {
				return;
			}
			const bucket = bucketFor(collection);
			for (const record of records) {
				bucket.set(record.id, record.value);
			}
		},
		recordGet: async (collection: string, id: string) => {
			calls.recordGet += 1;
			return store.get(collection)?.get(id) ?? null;
		},
		recordDelete: async (collection: string, id: string) => {
			calls.recordDelete += 1;
			store.get(collection)?.delete(id);
		},
		recordList: async (collection: string) => {
			calls.recordList += 1;
			const bucket = store.get(collection);
			if (bucket === undefined) {
				return [];
			}
			return [...bucket].map(([id, value]) => ({ id, value }));
		},
		recordClear: async (collection: string) => {
			calls.recordClear += 1;
			store.delete(collection);
		},

		simulateRestart: () => {
			// Records are always durable; nothing to drop.
		},
		collections: () =>
			[...store.entries()]
				.filter(([, bucket]) => bucket.size > 0)
				.map(([name]) => name)
				.sort(),
		resetCalls: () => {
			calls.initialize = 0;
			calls.recordPut = 0;
			calls.recordPutMany = 0;
			calls.recordGet = 0;
			calls.recordDelete = 0;
			calls.recordList = 0;
			calls.recordClear = 0;
		},
	};
}
