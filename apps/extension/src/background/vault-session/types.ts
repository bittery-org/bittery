/**
 * Vault session vocabulary.
 *
 * This file has no platform imports — no chrome types, storage or desktop protocol.
 * Its type-only KeyRef import preserves the opaque token without making the reducer depend on
 * an adapter or a platform module.
 */

import type { KeyRef } from "@bittery/crypto-port";

export type VaultOwner = "none" | "local" | "desktop";

export type LockReason =
	| "manual"
	| "logout"
	| "timeout"
	| "desktop_locked"
	| "desktop_disconnected"
	| "session_revoked"
	| "never_unlocked";

export type RefusalCode = "desktop_owns_lock" | "desktop_owns_unlock";

/** Everything a caller may know. No MUK, no sentinel, no DesktopStatus, no chrome types. */
export interface VaultSessionSnapshot {
	readonly owner: VaultOwner;
	readonly unlocked: boolean;
	readonly desktopMode: boolean;
	readonly desktopConnected: boolean;
	readonly desktopLocked: boolean;
	/** `!desktopConnected` — replaces the old `lock()` throw with a checkable field. */
	readonly canLockLocally: boolean;
	readonly lastActivityAt: number;
	/** -1 = never. The desktop's value wins while a desktop is connected. */
	readonly autoLockTimeoutMs: number;
	/** `null` in desktop mode, while locked, and when the timeout is -1. */
	readonly remainingMs: number | null;
	readonly lockReason: LockReason | null;
	/** Monotonic; unchanged when an event leaves the state untouched. */
	readonly revision: number;
}

/** Narrow projection of the desktop app's status. `null` == unreachable. */
export interface DesktopSnapshot {
	readonly connected: boolean;
	readonly locked: boolean;
	readonly unlockedAccountIds: string[];
	readonly autoLockTimeoutMs: number | null;
}

export type VaultSessionEvent =
	| { type: "BOOT" }
	| {
			type: "STARTUP_RESTORED";
			accountIds: string[];
			muk: KeyRef | null;
			at: number;
	  }
	| { type: "LOCAL_UNLOCKED"; muk: KeyRef; at: number }
	| { type: "DESKTOP_OBSERVED"; status: DesktopSnapshot | null; at: number }
	| { type: "DESKTOP_UNLOCK_PUSHED"; accountIds: string[]; at: number }
	| { type: "DESKTOP_LOCK_PUSHED"; reason: string; at: number }
	| { type: "DESKTOP_CLOSED"; at: number }
	| { type: "ACTIVITY"; at: number }
	| { type: "TIMEOUT_ELAPSED"; at: number }
	| { type: "TIMEOUT_SETTING_CHANGED"; timeoutMs: number; at: number }
	| {
			type: "LOCK_REQUESTED";
			source: "popup" | "logout" | "internal";
			at: number;
	  }
	| {
			type: "SESSION_REVOKED";
			sessionId: string | null;
			reason?: string;
			at: number;
	  }
	| {
			type: "SESSION_INVALIDATED";
			accountId: string | null;
			email: string | null;
			at: number;
	  };

export type VaultSessionBroadcast =
	| { type: "DESKTOP_LOCKED"; reason: string }
	| { type: "DESKTOP_UNLOCKED"; accounts: string[] }
	| { type: "VAULT_LOCKED"; reason: LockReason }
	| { type: "SESSION_REVOKED"; reason?: string };

export type VaultSessionEffect =
	| { kind: "set_lock_indicator"; locked: boolean }
	| { kind: "arm_auto_lock"; delayMs: number }
	| { kind: "disarm_auto_lock" }
	| { kind: "start_keepalive" }
	| { kind: "stop_keepalive" }
	| { kind: "clear_keys"; reason: LockReason }
	| { kind: "invalidate_session"; sessionId: string | null }
	| { kind: "disconnect_sync"; reason: string; suppressReconnect: boolean }
	| { kind: "broadcast"; message: VaultSessionBroadcast }
	| { kind: "refuse"; code: RefusalCode };

/**
 * Reducer state: the snapshot's non-derived fields plus what callers may never see.
 * `owner: "desktop"` with `muk: null` is the explicit encoding of desktop mode —
 * it replaces the old 0xDE sentinel MUK.
 */
export interface VaultSessionState {
	readonly owner: VaultOwner;
	readonly desktopConnected: boolean;
	readonly desktopLocked: boolean;
	readonly lastActivityAt: number;
	readonly lockReason: LockReason | null;
	readonly revision: number;
	readonly muk: KeyRef | null;
	readonly settingsTimeoutMs: number;
	readonly desktopTimeoutMs: number | null;
	/** Suppresses a repeated revocation of the same server session. */
	readonly lastRevokedSessionId: string | null;
}
