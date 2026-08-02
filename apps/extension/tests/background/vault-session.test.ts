import { describe, expect, test } from "bun:test";
import {
	createInitialState,
	projectSnapshot,
	type ReduceResult,
	reduce,
} from "../../src/background/vault-session/transitions";
import type {
	DesktopSnapshot,
	VaultSessionEffect,
	VaultSessionState,
} from "../../src/background/vault-session/types";

// The reducer is pure and every event carries its own `at`, so this suite needs
// no `mock.module` and no `globalThis.chrome` — a fake clock is enough.

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;
const SETTINGS_TIMEOUT = 10 * MINUTE;
const MUK = new Uint8Array(32).fill(7);
const START_REVISION = 5;

function lockedState(
	overrides: Partial<VaultSessionState> = {},
): VaultSessionState {
	return {
		...createInitialState(SETTINGS_TIMEOUT),
		revision: START_REVISION,
		...overrides,
	};
}

function localState(
	overrides: Partial<VaultSessionState> = {},
): VaultSessionState {
	return lockedState({
		owner: "local",
		muk: MUK,
		lastActivityAt: NOW,
		...overrides,
	});
}

function desktopState(
	overrides: Partial<VaultSessionState> = {},
): VaultSessionState {
	return lockedState({
		owner: "desktop",
		muk: null,
		desktopConnected: true,
		desktopLocked: false,
		lastActivityAt: NOW,
		...overrides,
	});
}

function desktop(overrides: Partial<DesktopSnapshot> = {}): DesktopSnapshot {
	return {
		connected: true,
		locked: false,
		unlockedAccountIds: ["acc-1"],
		autoLockTimeoutMs: null,
		...overrides,
	};
}

function kinds(result: ReduceResult): string[] {
	return result.effects.map((effect) => effect.kind);
}

function effect<K extends VaultSessionEffect["kind"]>(
	result: ReduceResult,
	kind: K,
): Extract<VaultSessionEffect, { kind: K }> | undefined {
	return result.effects.find(
		(candidate): candidate is Extract<VaultSessionEffect, { kind: K }> =>
			candidate.kind === kind,
	);
}

describe("startup", () => {
	test("row 1: a startup restore with no key leaves the vault locked and shows the lock indicator", () => {
		const result = reduce(lockedState(), {
			type: "STARTUP_RESTORED",
			accountIds: [],
			muk: null,
			at: NOW,
		});

		expect(result.next.owner).toBe("none");
		expect(result.next.lockReason).toBe("never_unlocked");
		expect(kinds(result)).toEqual(["set_lock_indicator"]);
		expect(effect(result, "set_lock_indicator")?.locked).toBe(true);
	});

	test("row 2: a startup restore carrying a key unlocks locally and arms the auto-lock", () => {
		const result = reduce(lockedState(), {
			type: "STARTUP_RESTORED",
			accountIds: ["acc-1"],
			muk: MUK,
			at: NOW,
		});

		expect(result.next.owner).toBe("local");
		expect(result.next.muk).toBe(MUK);
		expect(kinds(result)).toEqual([
			"set_lock_indicator",
			"arm_auto_lock",
			"start_keepalive",
		]);
		expect(effect(result, "arm_auto_lock")?.delayMs).toBe(SETTINGS_TIMEOUT);
	});

	test("row 3: a repeated startup restore into a live session arms nothing and does not bump the revision", () => {
		const state = localState();
		const result = reduce(state, {
			type: "STARTUP_RESTORED",
			accountIds: ["acc-1"],
			muk: MUK,
			at: NOW + MINUTE,
		});

		expect(result.next.owner).toBe("local");
		expect(result.effects).toEqual([]);
		expect(result.next.revision).toBe(START_REVISION);
	});

	test("row 4: a desktop observed connected-and-locked after restore locks the local session", () => {
		const result = reduce(localState(), {
			type: "DESKTOP_OBSERVED",
			status: desktop({ locked: true }),
			at: NOW,
		});

		expect(result.next.owner).toBe("none");
		expect(effect(result, "clear_keys")?.reason).toBe("desktop_locked");
		expect(result.next.revision).toBe(START_REVISION + 1);
	});
});

describe("local unlock", () => {
	test("row 5: a local unlock stamps activity, clears the indicator and arms the auto-lock", () => {
		const at = NOW + MINUTE;
		const result = reduce(lockedState(), {
			type: "LOCAL_UNLOCKED",
			muk: MUK,
			at,
		});

		expect(result.next.owner).toBe("local");
		expect(result.next.lastActivityAt).toBe(at);
		expect(result.next.lockReason).toBeNull();
		expect(effect(result, "set_lock_indicator")?.locked).toBe(false);
		expect(effect(result, "arm_auto_lock")?.delayMs).toBe(SETTINGS_TIMEOUT);
	});

	test("row 6: a local unlock is refused while a reachable desktop is locked", () => {
		const state = lockedState({ desktopConnected: true, desktopLocked: true });
		const result = reduce(state, { type: "LOCAL_UNLOCKED", muk: MUK, at: NOW });

		expect(result.next.owner).toBe("none");
		expect(kinds(result)).toEqual(["refuse"]);
		expect(effect(result, "refuse")?.code).toBe("desktop_owns_unlock");
		expect(result.next.revision).toBe(START_REVISION);
	});
});

describe("desktop ownership", () => {
	test("row 7: a desktop unlock push takes ownership, drops the key and disarms the auto-lock", () => {
		const result = reduce(localState(), {
			type: "DESKTOP_UNLOCK_PUSHED",
			accountIds: ["acc-1"],
			at: NOW,
		});

		expect(result.next.owner).toBe("desktop");
		expect(result.next.muk).toBeNull();
		expect(kinds(result)).toContain("disarm_auto_lock");
		expect(kinds(result)).toContain("start_keepalive");
		expect(kinds(result)).not.toContain("arm_auto_lock");
		expect(effect(result, "broadcast")?.message).toEqual({
			type: "DESKTOP_UNLOCKED",
			accounts: ["acc-1"],
		});
	});

	test("row 8: re-observing an unchanged connected desktop emits nothing and does not bump the revision", () => {
		const result = reduce(desktopState(), {
			type: "DESKTOP_OBSERVED",
			status: desktop(),
			at: NOW + MINUTE,
		});

		expect(result.next.owner).toBe("desktop");
		expect(result.effects).toEqual([]);
		expect(result.next.revision).toBe(START_REVISION);
	});

	test("row 9: a desktop lock push locks a desktop-owned session and broadcasts DESKTOP_LOCKED", () => {
		const result = reduce(desktopState(), {
			type: "DESKTOP_LOCK_PUSHED",
			reason: "user_locked",
			at: NOW,
		});

		expect(result.next.owner).toBe("none");
		expect(effect(result, "clear_keys")?.reason).toBe("desktop_locked");
		expect(effect(result, "broadcast")?.message).toEqual({
			type: "DESKTOP_LOCKED",
			reason: "user_locked",
		});
	});

	test("row 10: a desktop lock push also locks a locally unlocked session", () => {
		const result = reduce(localState(), {
			type: "DESKTOP_LOCK_PUSHED",
			reason: "user_locked",
			at: NOW,
		});

		expect(result.next.owner).toBe("none");
		expect(result.next.muk).toBeNull();
		expect(effect(result, "clear_keys")?.reason).toBe("desktop_locked");
	});

	test("row 11: closing the desktop locks a desktop-owned session", () => {
		const result = reduce(desktopState(), { type: "DESKTOP_CLOSED", at: NOW });

		expect(result.next.owner).toBe("none");
		expect(result.next.desktopConnected).toBe(false);
		expect(effect(result, "clear_keys")?.reason).toBe("desktop_disconnected");
	});

	test("row 12: observing an unreachable desktop locks a desktop-owned session", () => {
		const result = reduce(desktopState(), {
			type: "DESKTOP_OBSERVED",
			status: null,
			at: NOW,
		});

		expect(result.next.owner).toBe("none");
		expect(result.next.desktopConnected).toBe(false);
		expect(effect(result, "clear_keys")?.reason).toBe("desktop_disconnected");
	});

	test("row 13: observing an unreachable desktop keeps a local session and reverts to the settings timeout", () => {
		const state = localState({
			desktopConnected: true,
			desktopTimeoutMs: MINUTE,
		});
		const result = reduce(state, {
			type: "DESKTOP_OBSERVED",
			status: null,
			at: NOW,
		});

		expect(result.next.owner).toBe("local");
		expect(effect(result, "arm_auto_lock")?.delayMs).toBe(SETTINGS_TIMEOUT);
		expect(projectSnapshot(result.next, NOW).autoLockTimeoutMs).toBe(
			SETTINGS_TIMEOUT,
		);
	});

	test("row 14: closing the desktop on an already locked vault emits no second clear_keys", () => {
		const result = reduce(lockedState(), { type: "DESKTOP_CLOSED", at: NOW });

		expect(result.next.owner).toBe("none");
		expect(result.effects).toEqual([]);
		expect(result.next.revision).toBe(START_REVISION);
	});
});

describe("activity", () => {
	test("row 15: activity on a local session stamps the timestamp and re-arms", () => {
		const at = NOW + 5 * MINUTE;
		const result = reduce(localState(), { type: "ACTIVITY", at });

		expect(result.next.lastActivityAt).toBe(at);
		expect(effect(result, "arm_auto_lock")?.delayMs).toBe(SETTINGS_TIMEOUT);
	});

	test("row 16: activity on a locked vault emits nothing and never resurrects it", () => {
		const result = reduce(lockedState(), { type: "ACTIVITY", at: NOW });

		expect(result.next.owner).toBe("none");
		expect(result.next.lastActivityAt).toBe(0);
		expect(result.effects).toEqual([]);
		expect(result.next.revision).toBe(START_REVISION);
	});

	test("row 17: activity in desktop mode stamps the timestamp but arms nothing", () => {
		const at = NOW + 5 * MINUTE;
		const result = reduce(desktopState(), { type: "ACTIVITY", at });

		expect(result.next.owner).toBe("desktop");
		expect(result.next.lastActivityAt).toBe(at);
		expect(result.effects).toEqual([]);
	});
});

describe("auto-lock timeout", () => {
	test("row 18: an elapsed timeout past the idle window locks the vault", () => {
		const result = reduce(localState(), {
			type: "TIMEOUT_ELAPSED",
			at: NOW + SETTINGS_TIMEOUT + 1,
		});

		expect(result.next.owner).toBe("none");
		expect(effect(result, "clear_keys")?.reason).toBe("timeout");
	});

	test("row 19: an elapsed timeout with recent activity reschedules for the remainder", () => {
		const result = reduce(localState(), {
			type: "TIMEOUT_ELAPSED",
			at: NOW + 2 * MINUTE,
		});

		expect(result.next.owner).toBe("local");
		expect(effect(result, "arm_auto_lock")?.delayMs).toBe(
			SETTINGS_TIMEOUT - 2 * MINUTE,
		);
	});

	test("row 20: an elapsed timeout with the never setting disarms instead of locking", () => {
		const state = localState({ settingsTimeoutMs: -1 });
		const result = reduce(state, {
			type: "TIMEOUT_ELAPSED",
			at: NOW + 24 * 60 * MINUTE,
		});

		expect(result.next.owner).toBe("local");
		expect(kinds(result)).toContain("disarm_auto_lock");
		expect(kinds(result)).not.toContain("clear_keys");
		expect(kinds(result)).not.toContain("arm_auto_lock");
	});

	test("row 21: a changed timeout setting re-arms with the new value", () => {
		const result = reduce(localState(), {
			type: "TIMEOUT_SETTING_CHANGED",
			timeoutMs: 15 * MINUTE,
			at: NOW,
		});

		expect(result.next.settingsTimeoutMs).toBe(15 * MINUTE);
		expect(effect(result, "arm_auto_lock")?.delayMs).toBe(15 * MINUTE);
	});

	test("row 22: a connected desktop's timeout wins over the settings value for both arming and reporting", () => {
		const state = localState({
			settingsTimeoutMs: 5 * MINUTE,
			desktopConnected: true,
			desktopTimeoutMs: MINUTE,
		});
		const result = reduce(state, {
			type: "TIMEOUT_SETTING_CHANGED",
			timeoutMs: 10 * MINUTE,
			at: NOW,
		});

		expect(effect(result, "arm_auto_lock")?.delayMs).toBe(MINUTE);
		expect(projectSnapshot(result.next, NOW).autoLockTimeoutMs).toBe(MINUTE);
	});
});

describe("lock request", () => {
	test("row 23: a popup lock locks the vault with lifetime effects before key destruction", () => {
		const result = reduce(localState(), {
			type: "LOCK_REQUESTED",
			source: "popup",
			at: NOW,
		});

		expect(result.next.owner).toBe("none");
		expect(kinds(result)).toEqual([
			"set_lock_indicator",
			"disarm_auto_lock",
			"stop_keepalive",
			"disconnect_sync",
			"broadcast",
			"clear_keys",
		]);
		expect(effect(result, "clear_keys")?.reason).toBe("manual");
		expect(effect(result, "disconnect_sync")?.suppressReconnect).toBe(false);
		expect(effect(result, "broadcast")?.message).toEqual({
			type: "VAULT_LOCKED",
			reason: "manual",
		});
	});

	test("row 24: a popup lock in desktop mode is refused without touching keys or sync", () => {
		const state = desktopState();
		const result = reduce(state, {
			type: "LOCK_REQUESTED",
			source: "popup",
			at: NOW,
		});

		expect(result.next.owner).toBe("desktop");
		expect(kinds(result)).toEqual(["refuse"]);
		expect(effect(result, "refuse")?.code).toBe("desktop_owns_lock");
		expect(result.next.revision).toBe(START_REVISION);
	});

	test("row 25: a popup lock is refused whenever a desktop is connected, even in local mode", () => {
		const state = localState({ desktopConnected: true });
		const result = reduce(state, {
			type: "LOCK_REQUESTED",
			source: "popup",
			at: NOW,
		});

		expect(result.next.owner).toBe("local");
		expect(kinds(result)).toEqual(["refuse"]);
		expect(effect(result, "refuse")?.code).toBe("desktop_owns_lock");
	});

	test("row 26: a logout lock is never refused", () => {
		const result = reduce(desktopState(), {
			type: "LOCK_REQUESTED",
			source: "logout",
			at: NOW,
		});

		expect(result.next.owner).toBe("none");
		expect(effect(result, "clear_keys")?.reason).toBe("logout");
	});

	test("row 27: a lock request on an already locked vault emits no second clear_keys", () => {
		const result = reduce(lockedState(), {
			type: "LOCK_REQUESTED",
			source: "internal",
			at: NOW,
		});

		expect(result.effects).toEqual([]);
		expect(result.next.revision).toBe(START_REVISION);
	});
});

describe("session revoked", () => {
	test("row 28: a revocation locks, invalidates the session and suppresses the sync reconnect", () => {
		const result = reduce(localState(), {
			type: "SESSION_REVOKED",
			sessionId: "s1",
			reason: "device_revoked",
			at: NOW,
		});

		expect(result.next.owner).toBe("none");
		expect(effect(result, "clear_keys")?.reason).toBe("session_revoked");
		expect(effect(result, "invalidate_session")?.sessionId).toBe("s1");
		expect(effect(result, "disconnect_sync")?.suppressReconnect).toBe(true);
		expect(effect(result, "broadcast")?.message).toEqual({
			type: "SESSION_REVOKED",
			reason: "device_revoked",
		});
		// Key destruction stays last so a failing port cannot leave timers armed.
		expect(kinds(result).at(-1)).toBe("invalidate_session");
	});

	test("row 29: a revocation without a session id still locks and lets the adapter fall back to the email", () => {
		const result = reduce(localState(), {
			type: "SESSION_REVOKED",
			sessionId: null,
			at: NOW,
		});

		expect(result.next.owner).toBe("none");
		expect(kinds(result)).toContain("clear_keys");
		expect(effect(result, "invalidate_session")?.sessionId).toBeNull();
	});

	test("row 30: a repeated revocation of the same session invalidates once and emits no second clear_keys", () => {
		const first = reduce(lockedState(), {
			type: "SESSION_REVOKED",
			sessionId: "s1",
			at: NOW,
		});

		expect(kinds(first)).not.toContain("clear_keys");
		expect(effect(first, "invalidate_session")?.sessionId).toBe("s1");

		const second = reduce(first.next, {
			type: "SESSION_REVOKED",
			sessionId: "s1",
			at: NOW + MINUTE,
		});

		expect(second.effects).toEqual([]);
		expect(second.next.revision).toBe(first.next.revision);
	});

	test("row 31: a revocation outranks desktop ownership and still locks", () => {
		const result = reduce(desktopState(), {
			type: "SESSION_REVOKED",
			sessionId: "s1",
			at: NOW,
		});

		expect(result.next.owner).toBe("none");
		expect(effect(result, "clear_keys")?.reason).toBe("session_revoked");
		expect(effect(result, "invalidate_session")?.sessionId).toBe("s1");
	});

	test("an already invalidated session locks without re-invalidating it", () => {
		const result = reduce(localState(), {
			type: "SESSION_INVALIDATED",
			accountId: "acc-1",
			email: "a@example.com",
			at: NOW,
		});

		expect(result.next.owner).toBe("none");
		expect(kinds(result)).toContain("clear_keys");
		expect(kinds(result)).not.toContain("invalidate_session");
		expect(effect(result, "disconnect_sync")?.suppressReconnect).toBe(true);
	});
});

describe("snapshot projection", () => {
	test("hides the master unlock key", () => {
		const snapshot = projectSnapshot(localState(), NOW);

		expect(Object.hasOwn(snapshot, "muk")).toBe(false);
		expect(snapshot.unlocked).toBe(true);
	});

	test("counts down from the last activity in local mode", () => {
		const snapshot = projectSnapshot(localState(), NOW + 2 * MINUTE);

		expect(snapshot.remainingMs).toBe(SETTINGS_TIMEOUT - 2 * MINUTE);
		expect(snapshot.canLockLocally).toBe(true);
	});

	test("reports no countdown in desktop mode and blocks local locking", () => {
		const snapshot = projectSnapshot(desktopState(), NOW + MINUTE);

		expect(snapshot.desktopMode).toBe(true);
		expect(snapshot.remainingMs).toBeNull();
		expect(snapshot.canLockLocally).toBe(false);
	});

	test("reports no countdown when the timeout is never", () => {
		const snapshot = projectSnapshot(
			localState({ settingsTimeoutMs: -1 }),
			NOW,
		);

		expect(snapshot.autoLockTimeoutMs).toBe(-1);
		expect(snapshot.remainingMs).toBeNull();
	});
});
