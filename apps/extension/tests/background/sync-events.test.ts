import { beforeEach, describe, expect, mock, test } from "bun:test";
import path from "node:path";
import type {
	InvalidationTarget,
	LifecycleOutcome,
} from "@bittery/core/services/account-lifecycle";
import type { AccountMetadata } from "@bittery/storage/types";

// A server-revoked session used to leave the extension unlocked holding a dead JWT:
// `sync-manager` only pushed SYNC_FULL_REFRESH_REQUIRED. These cases drive the real
// vault-session singleton through the real SSE path, so the assertions are about the
// worker's actual lock state rather than about which message was posted.

const bgDir = path.resolve(import.meta.dir, "../../src/background");
const libDir = path.resolve(import.meta.dir, "../../src/lib");

const CONNECTION_EMAIL = "revoked@example.com";
const SYNC_ALARM_NAME = "bittery_sync_reconnect";

const ACCOUNT: AccountMetadata = {
	accountId: "acc-1",
	email: CONNECTION_EMAIL,
} as AccountMetadata;

function outcome(affected: AccountMetadata[]): LifecycleOutcome {
	return {
		affected,
		activeAccountId: undefined,
		activeAccount: null,
		wasActive: false,
		remaining: [],
		failures: [],
	};
}

const invalidationTargets: InvalidationTarget[] = [];
let lockAllCalls = 0;
/** Accounts `invalidateAccountSession` claims to have found, keyed by nothing — set per test. */
let invalidateResult: (target: InvalidationTarget) => AccountMetadata[] =
	() => [ACCOUNT];

const alarmCreates: string[] = [];
const runtimeMessages: Array<{ type: string }> = [];
const storageLocal: Record<string, unknown> = {};
let stagedRefreshCount = 0;
let outboundDrainCount = 0;
let requireFullRefreshOnCatchUp = false;
let catchUpEvent: Record<string, unknown> | null = null;
const catchUpInitialCursors: Array<{ id: string }> = [];
let initialSyncCursor: { id: string } | null = null;
let initialSyncCount = 0;
let deltaSyncError: Error | null = null;
let lastSseRequest: { signal: AbortSignal | undefined } | null = null;
let openSyncEvents: (signal?: AbortSignal) => Promise<Response> = async () =>
	new Response(null, { status: 401 });

globalThis.chrome = {
	storage: {
		local: {
			get: async (keys: string | string[]) => {
				const wanted = Array.isArray(keys) ? keys : [keys];
				const result: Record<string, unknown> = {};
				for (const key of wanted) {
					if (key in storageLocal) {
						result[key] = storageLocal[key];
					}
				}
				return result;
			},
			set: async (items: Record<string, unknown>) => {
				Object.assign(storageLocal, items);
			},
			remove: async (keys: string | string[]) => {
				for (const key of Array.isArray(keys) ? keys : [keys]) {
					delete storageLocal[key];
				}
			},
		},
	},
	alarms: {
		create: (name: string) => {
			alarmCreates.push(name);
		},
		clear: async () => true,
	},
	runtime: {
		sendMessage: async (message: { type: string }) => {
			runtimeMessages.push(message);
		},
		getURL: (resource: string) => resource,
	},
	action: {
		setIcon: () => {},
		setBadgeText: () => {},
	},
} as unknown as typeof chrome;

mock.module("@bittery/sync", () => ({
	runCatchUp: async (options: {
		initialCursor: { id: string };
		onEvent?: (event: Record<string, unknown>) => Promise<void>;
		onRequiresFullRefresh?: () => Promise<void>;
	}) => {
		catchUpInitialCursors.push(options.initialCursor);
		if (catchUpEvent) {
			await options.onEvent?.(catchUpEvent);
		}
		if (requireFullRefreshOnCatchUp) {
			await options.onRequiresFullRefresh?.();
		}
		return {
			cursor: catchUpEvent
				? { id: String(catchUpEvent.id ?? "") }
				: options.initialCursor,
			processedCount: catchUpEvent ? 1 : 0,
		};
	},
}));

mock.module("@bittery/core/services/account-lifecycle", () => ({
	NO_CREDENTIAL_MIRROR: { purge: async () => {} },
	lockAllAccounts: async () => {
		lockAllCalls++;
		return outcome([]);
	},
	invalidateAccountSession: async (target: InvalidationTarget) => {
		invalidationTargets.push(target);
		return outcome(invalidateResult(target));
	},
}));

mock.module(path.join(libDir, "storage.ts"), () => ({
	storage: {
		getAutoLockTimeoutOrDefault: async () => 600_000,
	},
	itemCache: {
		clearItemCache: async () => {},
	},
}));

mock.module(path.join(bgDir, "desktop-sync.ts"), () => ({
	desktopSync: {
		getLastStatus: () => null,
		checkDesktopStatus: async () => null,
	},
}));

mock.module(path.join(bgDir, "services/sync-cache-service.ts"), () => ({
	syncCacheService: {
		resolveConnectionContext: async () => ({
			accountId: ACCOUNT.accountId,
			email: CONNECTION_EMAIL,
			serverUrl: "http://localhost:3000",
			client: {
				sync: {
					events: (signal?: AbortSignal) => openSyncEvents(signal),
				},
			},
		}),
		getClientForAccountId: async () => ({}),
		applyDeltaSyncForEvent: async () => {
			if (deltaSyncError) throw deltaSyncError;
		},
		refreshItemCachesForKnownAccounts: async () => {
			stagedRefreshCount++;
		},
		initializeSyncBaselineForAccount: async () => {
			initialSyncCount++;
			return initialSyncCursor;
		},
	},
}));

mock.module(path.join(bgDir, "outbound-drain.ts"), () => ({
	drainOutboundQueue: async () => {
		outboundDrainCount++;
	},
}));

const {
	cleanupSync,
	connect,
	disconnect,
	getLastSyncCursor,
	handleSyncSseFrame,
	setLastSyncCursor,
} = await import(path.join(bgDir, "sync-manager.ts"));
const { parseSseFrame } = await import(
	path.join(bgDir, "services/sse-frame.ts")
);
const { vaultSession } = await import(
	path.join(bgDir, "vault-session/index.ts")
);

function sseBody(frames: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const frame of frames) {
				controller.enqueue(encoder.encode(`${frame}\n\n`));
			}
			controller.close();
		},
	});
}

/** Streams the given frames, then ends — exactly what the server does after revoking. */
function stubStream(frames: string[]): void {
	openSyncEvents = async (signal) => {
		lastSseRequest = { signal };
		return new Response(sseBody(frames), { status: 200 });
	};
}

function revocationFrame(payload: Record<string, unknown>): string {
	return `event: session_revoked\ndata: ${JSON.stringify(payload)}`;
}

function unlockVault(): void {
	vaultSession.dispatchNow({
		type: "LOCAL_UNLOCKED",
		muk: new Uint8Array(32).fill(3),
		at: Date.now(),
	});
	expect(vaultSession.getSnapshot().unlocked).toBe(true);
}

beforeEach(() => {
	disconnect("test reset");
	invalidationTargets.length = 0;
	alarmCreates.length = 0;
	runtimeMessages.length = 0;
	lockAllCalls = 0;
	stagedRefreshCount = 0;
	outboundDrainCount = 0;
	requireFullRefreshOnCatchUp = false;
	catchUpEvent = null;
	catchUpInitialCursors.length = 0;
	initialSyncCursor = null;
	initialSyncCount = 0;
	deltaSyncError = null;
	lastSseRequest = null;
	openSyncEvents = async () => new Response(null, { status: 401 });
	invalidateResult = () => [ACCOUNT];
	for (const key of Object.keys(storageLocal)) delete storageLocal[key];
});

describe("account-scoped sync cursors", () => {
	test("initializes a cold worker from bootstrap before catch-up", async () => {
		initialSyncCursor = { id: "evt-bootstrap" };
		stubStream([]);

		await connect();

		expect(initialSyncCount).toBe(1);
		expect(catchUpInitialCursors).toEqual([{ id: "evt-bootstrap" }]);
		expect(
			await getLastSyncCursor(ACCOUNT.accountId, "http://localhost:3000"),
		).toEqual({ id: "evt-bootstrap" });
	});

	test("replaces a stale cursor with the committed cache baseline", async () => {
		await setLastSyncCursor(ACCOUNT.accountId, "http://localhost:3000", {
			id: "evt-stale",
		});
		initialSyncCursor = { id: "evt-bootstrap" };
		stubStream([]);

		await connect();

		expect(initialSyncCount).toBe(1);
		expect(catchUpInitialCursors).toEqual([{ id: "evt-bootstrap" }]);
		expect(
			await getLastSyncCursor(ACCOUNT.accountId, "http://localhost:3000"),
		).toEqual({ id: "evt-bootstrap" });
	});

	test("persists an initialized bootstrap with no visible events", async () => {
		initialSyncCursor = null;
		stubStream([]);

		await connect();

		expect(initialSyncCount).toBe(1);
		expect(catchUpInitialCursors).toEqual([{ id: "" }]);
		expect(
			await getLastSyncCursor(ACCOUNT.accountId, "http://localhost:3000"),
		).toEqual({ id: "" });
	});

	test("keeps independent durable cursors for two accounts", async () => {
		await setLastSyncCursor("acc-1", "https://one.example", { id: "evt-1" });
		await setLastSyncCursor("acc-2", "https://one.example", { id: "evt-9" });

		expect(await getLastSyncCursor("acc-1", "https://one.example/")).toEqual({
			id: "evt-1",
		});
		expect(await getLastSyncCursor("acc-2", "https://one.example")).toEqual({
			id: "evt-9",
		});
	});

	test("isolates the same accountId across normalized server URLs", async () => {
		await setLastSyncCursor("shared-account", "https://one.example/", {
			id: "evt-one",
		});
		await setLastSyncCursor("shared-account", "https://two.example", {
			id: "evt-two",
		});

		expect(
			await getLastSyncCursor("shared-account", "https://one.example"),
		).toEqual({ id: "evt-one" });
		expect(
			await getLastSyncCursor("shared-account", "https://two.example/"),
		).toEqual({ id: "evt-two" });
	});

	test("cleanup removes only the connected account and server cursor", async () => {
		stubStream([]);
		await connect();
		await setLastSyncCursor(ACCOUNT.accountId, "http://localhost:3000/", {
			id: "connected-event",
		});
		await setLastSyncCursor(ACCOUNT.accountId, "https://other.example", {
			id: "other-event",
		});

		await cleanupSync();

		expect(
			await getLastSyncCursor(ACCOUNT.accountId, "http://localhost:3000"),
		).toBeNull();
		expect(
			await getLastSyncCursor(ACCOUNT.accountId, "https://other.example"),
		).toEqual({ id: "other-event" });
	});

	test("does not advance an account cursor when its catch-up delta fails", async () => {
		await setLastSyncCursor(ACCOUNT.accountId, "http://localhost:3000", {
			id: "evt-1",
		});
		initialSyncCursor = { id: "evt-1" };
		catchUpEvent = {
			id: "evt-2",
			type: "item_updated",
			entityId: "item-1",
			entityType: "item",
			vaultId: "vault-1",
			version: 2,
		};
		deltaSyncError = new Error("candidate cache write failed");
		stubStream([{ event: "sync", data: {} }]);

		await connect();

		expect(
			await getLastSyncCursor(ACCOUNT.accountId, "http://localhost:3000"),
		).toEqual({ id: "evt-1" });
	});
});

describe("session_revoked over SSE", () => {
	test("locks the vault, invalidates the named session and suppresses the reconnect", async () => {
		unlockVault();
		stubStream([
			revocationFrame({ session_id: "s1", reason: "device_revoked" }),
		]);

		await connect();
		expect(lastSseRequest?.signal).toBeInstanceOf(AbortSignal);

		expect(vaultSession.getSnapshot().unlocked).toBe(false);
		expect(vaultSession.getSnapshot().lockReason).toBe("session_revoked");
		expect(lockAllCalls).toBe(1);
		expect(invalidationTargets).toEqual([{ sessionId: "s1" }]);

		// The stream ends right after the revocation; reconnecting would loop the dead JWT.
		expect(alarmCreates).not.toContain(SYNC_ALARM_NAME);

		expect(runtimeMessages).toContainEqual({
			type: "SESSION_REVOKED",
			reason: "device_revoked",
		});
		expect(
			runtimeMessages.some((m) => m.type === "SYNC_FULL_REFRESH_REQUIRED"),
		).toBe(false);
	});

	test("without a session id it still locks and invalidates by the connection account id", async () => {
		unlockVault();
		stubStream([revocationFrame({ reason: "device_revoked" })]);

		await connect();

		expect(vaultSession.getSnapshot().unlocked).toBe(false);
		expect(lockAllCalls).toBe(1);
		expect(invalidationTargets).toEqual([{ accountId: ACCOUNT.accountId }]);
	});

	test("a session id that matches nothing retries by account id instead of reporting success", async () => {
		unlockVault();
		// `StoredSessionData.sessionId` is optional, so an unresolved id yields an
		// empty, failure-free outcome — indistinguishable from a successful kill.
		invalidateResult = (target) =>
			typeof target === "object" && "accountId" in target ? [ACCOUNT] : [];
		stubStream([revocationFrame({ session_id: "unknown" })]);

		await connect();

		expect(invalidationTargets).toEqual([
			{ sessionId: "unknown" },
			{ accountId: ACCOUNT.accountId },
		]);
	});

	test("accepts the camelCase sessionId spelling", async () => {
		unlockVault();

		await handleSyncSseFrame({
			event: "session_revoked",
			data: { sessionId: "camel-1" },
		});

		expect(vaultSession.getSnapshot().unlocked).toBe(false);
		expect(invalidationTargets).toEqual([{ sessionId: "camel-1" }]);
	});

	test("a repeated revocation of the same session invalidates once", async () => {
		unlockVault();
		const frame = { event: "session_revoked", data: { session_id: "dup-1" } };

		await handleSyncSseFrame(frame);
		await handleSyncSseFrame(frame);

		expect(vaultSession.getSnapshot().unlocked).toBe(false);
		expect(invalidationTargets).toEqual([{ sessionId: "dup-1" }]);
		expect(lockAllCalls).toBe(1);
	});

	test("a sync ping still triggers a full refresh", async () => {
		requireFullRefreshOnCatchUp = true;
		stubStream([{ event: "sync", data: {} }]);
		await connect();

		expect(stagedRefreshCount).toBe(1);
		expect(runtimeMessages).toContainEqual({
			type: "SYNC_FULL_REFRESH_REQUIRED",
		});
		expect(invalidationTargets).toEqual([]);
	});

	// The popup queues writes it cannot push itself, so a worker that opens a
	// stream without draining leaves them stranded until the next popup visit.
	test("pushes the outbound queue once the stream opens", async () => {
		stubStream([]);
		await connect();

		expect(outboundDrainCount).toBe(1);
	});
});

describe("parseSseFrame", () => {
	test("reads the event name and JSON payload", () => {
		expect(
			parseSseFrame('event: session_revoked\ndata: {"session_id":"s1"}'),
		).toEqual({ event: "session_revoked", data: { session_id: "s1" } });
	});

	test("accepts data without the space separator", () => {
		expect(parseSseFrame('data:{"type":"connected"}')).toEqual({
			event: "",
			data: { type: "connected" },
		});
	});

	test("ignores comment heartbeats and empty frames", () => {
		expect(parseSseFrame(": heartbeat")).toBeNull();
		expect(parseSseFrame("")).toBeNull();
		expect(parseSseFrame("event: sync")).toBeNull();
	});

	test("returns null for malformed JSON and for scalars", () => {
		expect(parseSseFrame("event: sync\ndata: {oops")).toBeNull();
		expect(parseSseFrame("event: sync\ndata: 42")).toBeNull();
	});

	test("an unknown event type parses without crashing the handler", async () => {
		const frame = parseSseFrame('event: limit_exceeded\ndata: {"a":1}');
		expect(frame).toEqual({ event: "limit_exceeded", data: { a: 1 } });
		if (frame) {
			await handleSyncSseFrame(frame);
		}
		expect(invalidationTargets).toEqual([]);
	});
});
