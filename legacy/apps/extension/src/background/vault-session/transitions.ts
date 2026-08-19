/**
 * Pure vault-session reducer. No chrome, no storage, no desktop client, no clock:
 * every event carries its own `at`, so the transition table is testable without mocks.
 */

import type { KeyRef } from "@bittery/crypto-port";
import type {
	LockReason,
	VaultSessionBroadcast,
	VaultSessionEffect,
	VaultSessionEvent,
	VaultSessionSnapshot,
	VaultSessionState,
} from "./types";

export interface ReduceResult {
	next: VaultSessionState;
	effects: VaultSessionEffect[];
}

/** Mirrors `DEFAULT_AUTO_LOCK_TIMEOUT_MS`; duplicated so this module imports nothing. */
const DEFAULT_SETTINGS_TIMEOUT_MS = 10 * 60 * 1000;

export function createInitialState(
	settingsTimeoutMs: number = DEFAULT_SETTINGS_TIMEOUT_MS,
): VaultSessionState {
	return {
		owner: "none",
		desktopConnected: false,
		desktopLocked: false,
		lastActivityAt: 0,
		lockReason: null,
		revision: 0,
		muk: null,
		settingsTimeoutMs,
		desktopTimeoutMs: null,
		lastRevokedSessionId: null,
	};
}

export const initialVaultSessionState: VaultSessionState = createInitialState();

/**
 * One timeout feeds both arming and reporting: a connected desktop's value wins,
 * which is what makes a standalone session actually auto-lock on the desktop's clock.
 */
function resolveTimeoutMs(state: VaultSessionState): number {
	if (state.desktopConnected && state.desktopTimeoutMs !== null) {
		return state.desktopTimeoutMs;
	}
	return state.settingsTimeoutMs;
}

export function projectSnapshot(
	state: VaultSessionState,
	now: number,
): VaultSessionSnapshot {
	const autoLockTimeoutMs = resolveTimeoutMs(state);
	const unlocked = state.owner !== "none";
	const desktopMode = state.owner === "desktop";
	const countdownRuns = unlocked && !desktopMode && autoLockTimeoutMs !== -1;

	return {
		owner: state.owner,
		unlocked,
		desktopMode,
		desktopConnected: state.desktopConnected,
		desktopLocked: state.desktopLocked,
		canLockLocally: !state.desktopConnected,
		lastActivityAt: state.lastActivityAt,
		autoLockTimeoutMs,
		remainingMs: countdownRuns
			? Math.max(0, autoLockTimeoutMs - (now - state.lastActivityAt))
			: null,
		lockReason: state.lockReason,
		revision: state.revision,
	};
}

function hasChanged(a: VaultSessionState, b: VaultSessionState): boolean {
	return (
		a.owner !== b.owner ||
		a.desktopConnected !== b.desktopConnected ||
		a.desktopLocked !== b.desktopLocked ||
		a.lastActivityAt !== b.lastActivityAt ||
		a.lockReason !== b.lockReason ||
		a.muk !== b.muk ||
		a.settingsTimeoutMs !== b.settingsTimeoutMs ||
		a.desktopTimeoutMs !== b.desktopTimeoutMs ||
		a.lastRevokedSessionId !== b.lastRevokedSessionId
	);
}

/** `revision` is the change signal callers dedupe on, so it moves only on a real change. */
function commit(
	prev: VaultSessionState,
	next: VaultSessionState,
	effects: VaultSessionEffect[],
): ReduceResult {
	if (!hasChanged(prev, next)) {
		return { next: prev, effects };
	}
	return { next: { ...next, revision: prev.revision + 1 }, effects };
}

function ownershipEffects(
	state: VaultSessionState,
	now: number,
): VaultSessionEffect[] {
	if (state.owner === "none") {
		return [];
	}
	// Desktop mode never arms an auto-lock — the desktop app owns its own timeout.
	if (state.owner === "desktop") {
		return [{ kind: "disarm_auto_lock" }, { kind: "start_keepalive" }];
	}

	const timeoutMs = resolveTimeoutMs(state);
	if (timeoutMs === -1) {
		return [{ kind: "disarm_auto_lock" }, { kind: "start_keepalive" }];
	}

	const delayMs = Math.max(0, timeoutMs - (now - state.lastActivityAt));
	return [{ kind: "arm_auto_lock", delayMs }, { kind: "start_keepalive" }];
}

interface LockOptions {
	broadcast?: VaultSessionBroadcast;
	disconnectSync?: { reason: string; suppressReconnect: boolean };
}

/**
 * Effect order is a contract the runner depends on: service-worker lifetime effects
 * first, key destruction last, so a failing `clear_keys` can never leave a timer armed.
 */
function lockTransition(
	prev: VaultSessionState,
	base: VaultSessionState,
	reason: LockReason,
	options: LockOptions = {},
): ReduceResult {
	if (base.owner === "none") {
		return commit(prev, base, []);
	}

	const effects: VaultSessionEffect[] = [
		{ kind: "set_lock_indicator", locked: true },
		{ kind: "disarm_auto_lock" },
		{ kind: "stop_keepalive" },
	];
	if (options.disconnectSync) {
		effects.push({
			kind: "disconnect_sync",
			reason: options.disconnectSync.reason,
			suppressReconnect: options.disconnectSync.suppressReconnect,
		});
	}
	effects.push({
		kind: "broadcast",
		message: options.broadcast ?? { type: "VAULT_LOCKED", reason },
	});
	effects.push({ kind: "clear_keys", reason });

	return commit(
		prev,
		{
			...base,
			owner: "none",
			muk: null,
			lastActivityAt: 0,
			lockReason: reason,
		},
		effects,
	);
}

function unlockLocally(
	state: VaultSessionState,
	muk: KeyRef,
	at: number,
): ReduceResult {
	// A reachable but locked desktop outranks local state in either mode.
	if (state.desktopConnected && state.desktopLocked) {
		return commit(state, state, [
			{ kind: "refuse", code: "desktop_owns_unlock" },
		]);
	}

	const next: VaultSessionState = {
		...state,
		owner: "local",
		muk,
		lastActivityAt: at,
		lockReason: null,
	};
	return commit(state, next, [
		{ kind: "set_lock_indicator", locked: false },
		...ownershipEffects(next, at),
	]);
}

export function reduce(
	state: VaultSessionState,
	event: VaultSessionEvent,
): ReduceResult {
	switch (event.type) {
		case "BOOT":
			return commit(state, state, [
				{ kind: "set_lock_indicator", locked: state.owner === "none" },
			]);

		case "STARTUP_RESTORED": {
			// Restore only speaks for a cold worker; it must not re-arm a live session.
			if (state.owner !== "none") {
				return commit(state, state, []);
			}
			if (!event.muk) {
				return commit(
					state,
					{ ...state, lockReason: state.lockReason ?? "never_unlocked" },
					[{ kind: "set_lock_indicator", locked: true }],
				);
			}
			return unlockLocally(state, event.muk, event.at);
		}

		case "LOCAL_UNLOCKED":
			return unlockLocally(state, event.muk, event.at);

		case "DESKTOP_OBSERVED": {
			const status = event.status;
			const connected = status?.connected ?? false;
			const desktopLocked = connected && (status?.locked ?? false);
			const desktopTimeoutMs = connected
				? (status?.autoLockTimeoutMs ?? null)
				: null;

			if (
				connected === state.desktopConnected &&
				desktopLocked === state.desktopLocked &&
				desktopTimeoutMs === state.desktopTimeoutMs
			) {
				return commit(state, state, []);
			}

			const base: VaultSessionState = {
				...state,
				desktopConnected: connected,
				desktopLocked,
				desktopTimeoutMs,
			};

			if (desktopLocked) {
				return lockTransition(state, base, "desktop_locked");
			}
			if (!connected && state.owner === "desktop") {
				return lockTransition(state, base, "desktop_disconnected");
			}
			return commit(state, base, ownershipEffects(base, event.at));
		}

		case "DESKTOP_UNLOCK_PUSHED": {
			const next: VaultSessionState = {
				...state,
				owner: "desktop",
				muk: null,
				desktopConnected: true,
				desktopLocked: false,
				lastActivityAt: event.at,
				lockReason: null,
			};
			return commit(state, next, [
				{ kind: "set_lock_indicator", locked: false },
				{ kind: "disarm_auto_lock" },
				{ kind: "start_keepalive" },
				{
					kind: "broadcast",
					message: { type: "DESKTOP_UNLOCKED", accounts: event.accountIds },
				},
			]);
		}

		case "DESKTOP_LOCK_PUSHED": {
			const base: VaultSessionState = {
				...state,
				desktopConnected: true,
				desktopLocked: true,
			};
			return lockTransition(state, base, "desktop_locked", {
				broadcast: { type: "DESKTOP_LOCKED", reason: event.reason },
			});
		}

		case "DESKTOP_CLOSED": {
			const base: VaultSessionState = {
				...state,
				desktopConnected: false,
				desktopLocked: false,
				desktopTimeoutMs: null,
			};
			if (state.owner === "desktop") {
				return lockTransition(state, base, "desktop_disconnected");
			}
			return commit(state, base, ownershipEffects(base, event.at));
		}

		case "ACTIVITY": {
			// Activity must never resurrect a locked vault.
			if (state.owner === "none") {
				return commit(state, state, []);
			}
			const next = { ...state, lastActivityAt: event.at };
			if (state.owner === "desktop") {
				return commit(state, next, []);
			}
			return commit(state, next, ownershipEffects(next, event.at));
		}

		case "TIMEOUT_ELAPSED": {
			if (state.owner !== "local") {
				return commit(state, state, []);
			}
			const timeoutMs = resolveTimeoutMs(state);
			if (timeoutMs !== -1 && event.at - state.lastActivityAt >= timeoutMs) {
				return lockTransition(state, state, "timeout");
			}
			return commit(state, state, ownershipEffects(state, event.at));
		}

		case "TIMEOUT_SETTING_CHANGED": {
			if (event.timeoutMs === state.settingsTimeoutMs) {
				return commit(state, state, []);
			}
			const next = { ...state, settingsTimeoutMs: event.timeoutMs };
			return commit(state, next, ownershipEffects(next, event.at));
		}

		case "LOCK_REQUESTED": {
			// A refused lock must leave sync alone; only a real transition disconnects.
			if (event.source === "popup" && state.desktopConnected) {
				return commit(state, state, [
					{ kind: "refuse", code: "desktop_owns_lock" },
				]);
			}
			const reason: LockReason =
				event.source === "logout" ? "logout" : "manual";
			return lockTransition(state, state, reason, {
				disconnectSync: { reason, suppressReconnect: false },
			});
		}

		case "SESSION_REVOKED": {
			if (
				event.sessionId !== null &&
				event.sessionId === state.lastRevokedSessionId
			) {
				return commit(state, state, []);
			}

			// Fail-closed: revocation outranks desktop ownership and still invalidates
			// the server session when the vault is already locked.
			const wasUnlocked = state.owner !== "none";
			const effects: VaultSessionEffect[] = [];
			if (wasUnlocked) {
				effects.push(
					{ kind: "set_lock_indicator", locked: true },
					{ kind: "disarm_auto_lock" },
					{ kind: "stop_keepalive" },
				);
			}
			effects.push({
				kind: "disconnect_sync",
				reason: "session_revoked",
				suppressReconnect: true,
			});
			effects.push({
				kind: "broadcast",
				message: { type: "SESSION_REVOKED", reason: event.reason },
			});
			if (wasUnlocked) {
				effects.push({ kind: "clear_keys", reason: "session_revoked" });
			}
			effects.push({ kind: "invalidate_session", sessionId: event.sessionId });

			return commit(
				state,
				{
					...state,
					owner: "none",
					muk: null,
					lastActivityAt: 0,
					lockReason: "session_revoked",
					lastRevokedSessionId: event.sessionId,
				},
				effects,
			);
		}

		case "SESSION_INVALIDATED":
			// The session is already gone server-side; lock, but don't re-invalidate it.
			return lockTransition(state, state, "session_revoked", {
				disconnectSync: {
					reason: "session_invalidated",
					suppressReconnect: true,
				},
				broadcast: { type: "SESSION_REVOKED" },
			});
	}
}
