import { describe, expect, test } from "bun:test";
import type {
	LifecycleOutcome,
	LifecycleStepFailure,
} from "@bittery/core/services/account-lifecycle";
import type { AccountMetadata } from "@bittery/storage/types";
import { createLifecycleAdapter } from "../../src/background/vault-session/adapters/lifecycle-adapter";
import { createVaultSessionMachine } from "../../src/background/vault-session/machine";
import type {
	InvalidatedSession,
	SessionInvalidationTarget,
	VaultSessionPorts,
} from "../../src/background/vault-session/ports";
import { createInitialState } from "../../src/background/vault-session/transitions";
import type {
	DesktopSnapshot,
	VaultSessionBroadcast,
} from "../../src/background/vault-session/types";

// Every seam is injected, so this suite needs no `mock.module` and no
// `globalThis.chrome` — hand-written recording ports are the whole harness.

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;
const SETTINGS_TIMEOUT = 10 * MINUTE;
const MUK = new Uint8Array(32).fill(7);

interface Recorder {
	calls: string[];
	arms: number[];
	broadcasts: VaultSessionBroadcast[];
	disconnects: Array<{ reason: string; suppressReconnect: boolean }>;
	invalidations: SessionInvalidationTarget[];
	fireAutoLock: () => void;
}

interface HarnessOptions {
	lockAllError?: Error;
	invalidateError?: Error;
	/** Resolves `lockAll` manually so `dispatchNow` can be observed mid-flight. */
	deferLockAll?: boolean;
	desktop?: DesktopSnapshot | null;
}

function createHarness(options: HarnessOptions = {}) {
	let now = NOW;
	let onElapsed: (() => void) | null = null;
	let releaseLockAll: (() => void) | null = null;
	let desktop = options.desktop ?? null;

	const recorder: Recorder = {
		calls: [],
		arms: [],
		broadcasts: [],
		disconnects: [],
		invalidations: [],
		fireAutoLock: () => onElapsed?.(),
	};

	const ports: VaultSessionPorts = {
		chrome: {
			setLockIndicator(locked) {
				recorder.calls.push(`set_lock_indicator:${locked}`);
			},
			armAutoLock(delayMs, handler) {
				recorder.calls.push("arm_auto_lock");
				recorder.arms.push(delayMs);
				onElapsed = handler;
			},
			disarmAutoLock() {
				recorder.calls.push("disarm_auto_lock");
				onElapsed = null;
			},
			startKeepalive() {
				recorder.calls.push("start_keepalive");
			},
			stopKeepalive() {
				recorder.calls.push("stop_keepalive");
			},
			broadcast(message) {
				recorder.calls.push(`broadcast:${message.type}`);
				recorder.broadcasts.push(message);
			},
		},
		desktop: {
			readCached: () => desktop,
			refresh: async () => desktop,
		},
		lifecycle: {
			async lockAll() {
				recorder.calls.push("clear_keys");
				if (options.deferLockAll) {
					await new Promise<void>((resolve) => {
						releaseLockAll = resolve;
					});
				}
				if (options.lockAllError) {
					throw options.lockAllError;
				}
			},
			async invalidateSession(target): Promise<InvalidatedSession> {
				recorder.calls.push("invalidate_session");
				recorder.invalidations.push(target);
				if (options.invalidateError) {
					throw options.invalidateError;
				}
				return { accountId: null, email: null, wasActive: false };
			},
		},
		sync: {
			disconnect(reason, suppressReconnect) {
				recorder.calls.push("disconnect_sync");
				recorder.disconnects.push({ reason, suppressReconnect });
			},
		},
		settings: {
			readAutoLockTimeoutMs: async () => SETTINGS_TIMEOUT,
		},
		clock: { now: () => now },
	};

	const machine = createVaultSessionMachine(ports, {
		initialState: createInitialState(SETTINGS_TIMEOUT),
	});

	return {
		machine,
		recorder,
		setNow: (value: number) => {
			now = value;
		},
		setDesktop: (value: DesktopSnapshot | null) => {
			desktop = value;
		},
		releaseLockAll: () => releaseLockAll?.(),
	};
}

function desktopSnapshot(
	overrides: Partial<DesktopSnapshot> = {},
): DesktopSnapshot {
	return {
		connected: true,
		locked: false,
		unlockedAccountIds: ["acc-1"],
		autoLockTimeoutMs: null,
		...overrides,
	};
}

/** Lets the fire-and-forget effect chain settle. */
async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("vault session machine — fail-closed effect runner", () => {
	test("a rejecting lockAll still leaves the vault locked and disarmed", async () => {
		const h = createHarness({ lockAllError: new Error("storage offline") });
		await h.machine.dispatch({ type: "LOCAL_UNLOCKED", muk: MUK, at: NOW });

		await expect(
			h.machine.dispatch({
				type: "LOCK_REQUESTED",
				source: "popup",
				at: NOW,
			}),
		).rejects.toThrow("storage offline");
		const snapshot = h.machine.getSnapshot();

		expect(snapshot.unlocked).toBe(false);
		expect(snapshot.owner).toBe("none");
		expect(snapshot.lockReason).toBe("manual");
		expect(h.recorder.calls).toContain("set_lock_indicator:true");
		expect(h.recorder.calls).toContain("disarm_auto_lock");
		expect(h.recorder.calls).toContain("clear_keys");
	});

	test("service-worker effects are recorded before clear_keys", async () => {
		const h = createHarness();
		await h.machine.dispatch({ type: "LOCAL_UNLOCKED", muk: MUK, at: NOW });
		h.recorder.calls.length = 0;

		await h.machine.dispatch({
			type: "LOCK_REQUESTED",
			source: "popup",
			at: NOW,
		});

		const clearKeysAt = h.recorder.calls.indexOf("clear_keys");
		expect(clearKeysAt).toBeGreaterThan(-1);
		for (const call of [
			"set_lock_indicator:true",
			"disarm_auto_lock",
			"stop_keepalive",
		]) {
			expect(h.recorder.calls.indexOf(call)).toBeGreaterThan(-1);
			expect(h.recorder.calls.indexOf(call)).toBeLessThan(clearKeysAt);
		}
	});

	test("dispatchNow reports locked before clear_keys settles", async () => {
		const h = createHarness({ deferLockAll: true });
		h.machine.dispatchNow({ type: "LOCAL_UNLOCKED", muk: MUK, at: NOW });
		h.releaseLockAll();
		await settle();

		const snapshot = h.machine.dispatchNow({
			type: "LOCK_REQUESTED",
			source: "internal",
			at: NOW,
		});

		// The synchronous `isUnlocked()` contract: locked the instant we return,
		// with the key destruction still pending.
		expect(snapshot.unlocked).toBe(false);
		expect(h.recorder.calls).toContain("set_lock_indicator:true");
		expect(h.machine.getSnapshot().unlocked).toBe(false);

		h.releaseLockAll();
		await settle();
	});

	test("a refused lock never disconnects sync and reports its code", async () => {
		const h = createHarness();
		await h.machine.dispatch({ type: "LOCAL_UNLOCKED", muk: MUK, at: NOW });
		await h.machine.dispatch({
			type: "DESKTOP_OBSERVED",
			status: desktopSnapshot(),
			at: NOW,
		});
		h.recorder.calls.length = 0;

		const snapshot = await h.machine.dispatch({
			type: "LOCK_REQUESTED",
			source: "popup",
			at: NOW,
		});

		expect(snapshot.unlocked).toBe(true);
		expect(h.recorder.calls).not.toContain("clear_keys");
		expect(h.recorder.disconnects).toHaveLength(0);
		expect(h.machine.consumeRefusal()).toBe("desktop_owns_lock");
		expect(h.machine.consumeRefusal()).toBeNull();
	});
});

describe("vault session machine — lifecycle sequences", () => {
	test("a restart next to a locked desktop ends locked", async () => {
		const h = createHarness();

		await h.machine.dispatch({ type: "BOOT" });
		await h.machine.dispatch({
			type: "STARTUP_RESTORED",
			accountIds: ["acc-1"],
			muk: MUK,
			at: NOW,
		});
		await h.machine.dispatch({
			type: "TIMEOUT_SETTING_CHANGED",
			timeoutMs: 5 * MINUTE,
			at: NOW,
		});
		expect(h.machine.getSnapshot().owner).toBe("local");

		const snapshot = await h.machine.dispatch({
			type: "DESKTOP_OBSERVED",
			status: desktopSnapshot({ locked: true }),
			at: NOW,
		});

		expect(snapshot.owner).toBe("none");
		expect(snapshot.lockReason).toBe("desktop_locked");
		expect(h.recorder.calls).toContain("clear_keys");
		// The desktop is reachable, so the popup may not lock locally either.
		expect(snapshot.canLockLocally).toBe(false);
	});

	test("ownership hands off to the desktop and back with a fresh arm", async () => {
		const h = createHarness();

		await h.machine.dispatch({ type: "LOCAL_UNLOCKED", muk: MUK, at: NOW });
		expect(h.machine.getSnapshot().owner).toBe("local");
		expect(h.recorder.arms).toEqual([SETTINGS_TIMEOUT]);

		await h.machine.dispatch({
			type: "DESKTOP_UNLOCK_PUSHED",
			accountIds: ["acc-1"],
			at: NOW,
		});
		h.setDesktop(desktopSnapshot());
		let snapshot = h.machine.getSnapshot();
		expect(snapshot.owner).toBe("desktop");
		expect(snapshot.desktopMode).toBe(true);
		// Desktop mode has no extension-side countdown by design.
		expect(snapshot.remainingMs).toBeNull();
		expect(h.recorder.arms).toEqual([SETTINGS_TIMEOUT]);
		expect(h.recorder.broadcasts.map((message) => message.type)).toContain(
			"DESKTOP_UNLOCKED",
		);

		h.setDesktop(null);
		snapshot = await h.machine.dispatch({ type: "DESKTOP_CLOSED", at: NOW });
		expect(snapshot.owner).toBe("none");
		expect(snapshot.lockReason).toBe("desktop_disconnected");

		h.setNow(NOW + MINUTE);
		snapshot = await h.machine.dispatch({
			type: "LOCAL_UNLOCKED",
			muk: MUK,
			at: NOW + MINUTE,
		});
		expect(snapshot.owner).toBe("local");
		expect(snapshot.canLockLocally).toBe(true);
		expect(h.recorder.arms).toEqual([SETTINGS_TIMEOUT, SETTINGS_TIMEOUT]);
	});

	test("getSnapshot locks on a deadline that passed while the worker slept", () => {
		const h = createHarness();
		h.machine.dispatchNow({ type: "LOCAL_UNLOCKED", muk: MUK, at: NOW });

		h.setNow(NOW + SETTINGS_TIMEOUT + 1);
		const snapshot = h.machine.getSnapshot();

		expect(snapshot.unlocked).toBe(false);
		expect(snapshot.lockReason).toBe("timeout");
		expect(h.recorder.calls).toContain("clear_keys");
	});

	test("getSnapshot reconciles a desktop that locked behind our back", () => {
		const h = createHarness();
		h.machine.dispatchNow({ type: "LOCAL_UNLOCKED", muk: MUK, at: NOW });

		h.setDesktop(desktopSnapshot({ locked: true }));
		const snapshot = h.machine.getSnapshot();

		expect(snapshot.unlocked).toBe(false);
		expect(snapshot.desktopLocked).toBe(true);
		// Re-reading must not re-run the lock: the state already settled.
		const calls = h.recorder.calls.filter((call) => call === "clear_keys");
		h.machine.getSnapshot();
		expect(
			h.recorder.calls.filter((call) => call === "clear_keys"),
		).toHaveLength(calls.length);
	});

	test("the armed auto-lock callback locks through the machine", async () => {
		const h = createHarness();
		await h.machine.dispatch({ type: "LOCAL_UNLOCKED", muk: MUK, at: NOW });

		h.setNow(NOW + SETTINGS_TIMEOUT);
		h.recorder.fireAutoLock();
		await settle();

		expect(h.machine.getSnapshot().unlocked).toBe(false);
		expect(h.recorder.calls).toContain("clear_keys");
	});

	test("a revoked session locks, disconnects with suppression, and invalidates", async () => {
		const h = createHarness();
		await h.machine.dispatch({ type: "LOCAL_UNLOCKED", muk: MUK, at: NOW });
		h.recorder.calls.length = 0;

		const snapshot = await h.machine.dispatch({
			type: "SESSION_REVOKED",
			sessionId: "s1",
			reason: "device_revoked",
			at: NOW,
		});

		expect(snapshot.unlocked).toBe(false);
		expect(snapshot.lockReason).toBe("session_revoked");
		expect(h.recorder.disconnects).toEqual([
			{ reason: "session_revoked", suppressReconnect: true },
		]);
		expect(h.recorder.invalidations).toEqual([{ sessionId: "s1" }]);
		// Key destruction still precedes the account resolution it does not wait on.
		expect(h.recorder.calls.indexOf("clear_keys")).toBeLessThan(
			h.recorder.calls.indexOf("invalidate_session"),
		);
	});

	test("a rejected session invalidation rejects the settled dispatch", async () => {
		const h = createHarness({ invalidateError: new Error("lock incomplete") });
		await h.machine.dispatch({ type: "LOCAL_UNLOCKED", muk: MUK, at: NOW });

		await expect(
			h.machine.dispatch({
				type: "SESSION_REVOKED",
				sessionId: "s1",
				reason: "device_revoked",
				at: NOW,
			}),
		).rejects.toThrow("lock incomplete");
	});
});

describe("lifecycle adapter — session invalidation", () => {
	const ACCOUNT: AccountMetadata = {
		accountId: "acc-1",
		email: "user@example.com",
	} as AccountMetadata;

	function outcome(
		affected: AccountMetadata[],
		failures: LifecycleStepFailure[] = [],
	): LifecycleOutcome {
		return {
			affected,
			activeAccountId: "acc-1",
			activeAccount: ACCOUNT,
			wasActive: affected.length > 0,
			remaining: [ACCOUNT],
			failures,
		};
	}

	test("retries by account id when the sessionId resolves nothing", async () => {
		const targets: unknown[] = [];
		const adapter = createLifecycleAdapter({
			deps: {} as never,
			invalidate: async (target) => {
				targets.push(target);
				// An unresolved sessionId is reported exactly like a clean success.
				return "sessionId" in (target as object)
					? outcome([])
					: outcome([ACCOUNT]);
			},
			resolveFallbackAccountId: () => "acc-1",
		});

		const result = await adapter.invalidateSession({ sessionId: "s1" });

		expect(targets).toEqual([{ sessionId: "s1" }, { accountId: "acc-1" }]);
		expect(result).toEqual({
			accountId: "acc-1",
			email: "user@example.com",
			wasActive: true,
		});
	});

	test("does not retry when the sessionId resolved an account", async () => {
		const targets: unknown[] = [];
		const adapter = createLifecycleAdapter({
			deps: {} as never,
			invalidate: async (target) => {
				targets.push(target);
				return outcome([ACCOUNT]);
			},
			resolveFallbackAccountId: () => "acc-1",
		});

		await adapter.invalidateSession({ sessionId: "s1" });

		expect(targets).toEqual([{ sessionId: "s1" }]);
	});

	test("an explicit fallback account id outranks the resolver and replaces 'active'", async () => {
		const targets: unknown[] = [];
		const adapter = createLifecycleAdapter({
			deps: {} as never,
			invalidate: async (target) => {
				targets.push(target);
				return outcome([ACCOUNT]);
			},
			resolveFallbackAccountId: () => "stale-account",
		});

		await adapter.invalidateSession("active", "fresh-account");

		expect(targets).toEqual([{ accountId: "fresh-account" }]);
	});

	test("lockAll rejects when C1 reports step failures", async () => {
		const adapter = createLifecycleAdapter({
			deps: {} as never,
			lockAll: async () =>
				outcome(
					[ACCOUNT],
					[{ accountId: "acc-1", step: "lock_all_accounts", cause: "boom" }],
				),
		});

		await expect(adapter.lockAll()).rejects.toThrow(
			"lockAllAccounts incomplete",
		);
	});

	test("session invalidation rejects instead of projecting step failures", async () => {
		const adapter = createLifecycleAdapter({
			deps: {} as never,
			invalidate: async () =>
				outcome(
					[ACCOUNT],
					[{ accountId: "acc-1", step: "clear_session", cause: "boom" }],
				),
		});

		await expect(adapter.invalidateSession("active")).rejects.toThrow(
			"lockInvalidSession incomplete",
		);
	});
});
