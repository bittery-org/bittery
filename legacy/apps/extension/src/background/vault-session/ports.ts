/**
 * The seams between the pure reducer and the platform.
 *
 * Interfaces only — no implementation, no chrome, no storage, no desktop
 * protocol. Every effect the reducer emits is executed through exactly one of
 * these, which is what lets the machine suite run on plain recording objects.
 */

import type { DesktopSnapshot, VaultSessionBroadcast } from "./types";

/** Service-worker lifetime surface: toolbar icon, alarms, timers, push messages. */
export interface ChromeSessionPort {
	setLockIndicator(locked: boolean): void;
	/**
	 * Arms both an in-memory timer and the backing alarm. Re-arming replaces the
	 * previous deadline; `onElapsed` fires at most once per arm.
	 */
	armAutoLock(delayMs: number, onElapsed: () => void): void;
	disarmAutoLock(): void;
	startKeepalive(): void;
	stopKeepalive(): void;
	broadcast(message: VaultSessionBroadcast): void;
}

/** Narrow view of the desktop app. Only the adapter knows `DesktopStatus`. */
export interface DesktopPort {
	/** Last observed status without I/O. `null` means unreachable. */
	readCached(): DesktopSnapshot | null;
	refresh(): Promise<DesktopSnapshot | null>;
}

/** What the vault-session machine may ask the C1 lifecycle service to destroy. */
export type SessionInvalidationTarget =
	| "active"
	| { accountId: string }
	| { sessionId: string };

/** The identity C1 reports back, flattened to what callers actually consume. */
export interface InvalidatedSession {
	accountId: string | null;
	email: string | null;
	wasActive: boolean;
}

export interface VaultLifecyclePort {
	lockAll(): Promise<void>;
	/**
	 * `fallbackAccountId` exists because `StoredSessionData.sessionId` is optional:
	 * an unresolved id yields an empty, failure-free outcome that is
	 * indistinguishable from success, so the adapter retries by accountId.
	 */
	invalidateSession(
		target: SessionInvalidationTarget,
		fallbackAccountId?: string | null,
	): Promise<InvalidatedSession>;
}

export interface SyncPort {
	disconnect(reason: string, suppressReconnect: boolean): void;
}

export interface SettingsPort {
	readAutoLockTimeoutMs(): Promise<number>;
}

export interface Clock {
	now(): number;
}

export interface VaultSessionPorts {
	chrome: ChromeSessionPort;
	desktop: DesktopPort;
	lifecycle: VaultLifecyclePort;
	sync: SyncPort;
	settings: SettingsPort;
	clock: Clock;
}
