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
let requireFullRefreshOnCatchUp = false;
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
			remove: async () => {},
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
		onRequiresFullRefresh?: () => Promise<void>;
	}) => {
		if (requireFullRefreshOnCatchUp) {
			await options.onRequiresFullRefresh?.();
		}
		return { cursor: { id: "" }, processedCount: 0 };
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
			email: CONNECTION_EMAIL,
			client: {
				sync: {
					events: (signal?: AbortSignal) => openSyncEvents(signal),
				},
			},
		}),
		getClientForEmail: async () => ({}),
		applyDeltaSyncForEvent: async () => {},
		refreshItemCachesForKnownAccounts: async () => {
			stagedRefreshCount++;
		},
	},
}));

const { connect, disconnect, handleSyncSseFrame } = await import(
	path.join(bgDir, "sync-manager.ts")
);
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
	requireFullRefreshOnCatchUp = false;
	lastSseRequest = null;
	openSyncEvents = async () => new Response(null, { status: 401 });
	invalidateResult = () => [ACCOUNT];
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

	test("without a session id it still locks and invalidates by the connection email", async () => {
		unlockVault();
		stubStream([revocationFrame({ reason: "device_revoked" })]);

		await connect();

		expect(vaultSession.getSnapshot().unlocked).toBe(false);
		expect(lockAllCalls).toBe(1);
		expect(invalidationTargets).toEqual([{ email: CONNECTION_EMAIL }]);
	});

	test("a session id that matches nothing retries by email instead of reporting success", async () => {
		unlockVault();
		// `StoredSessionData.sessionId` is optional, so an unresolved id yields an
		// empty, failure-free outcome — indistinguishable from a successful kill.
		invalidateResult = (target) =>
			typeof target === "object" && "email" in target ? [ACCOUNT] : [];
		stubStream([revocationFrame({ session_id: "unknown" })]);

		await connect();

		expect(invalidationTargets).toEqual([
			{ sessionId: "unknown" },
			{ email: CONNECTION_EMAIL },
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
		await handleSyncSseFrame({ event: "sync", data: {} });

		expect(stagedRefreshCount).toBe(1);
		expect(runtimeMessages).toContainEqual({
			type: "SYNC_FULL_REFRESH_REQUIRED",
		});
		expect(invalidationTargets).toEqual([]);
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
