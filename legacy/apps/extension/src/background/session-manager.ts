/**
 * Compatibility facade over `vault-session/`.
 *
 * It holds no state of its own — every export is a one-liner over the
 * `vaultSession` machine. The module path is kept because eight background
 * modules import it and five test files `mock.module` it; routing them all
 * through the machine here is what keeps that surface untouched.
 */

import type { KeyRef } from "@bittery/crypto-port";
import { AUTO_LOCK_ALARM_NAME } from "./constants";
import { vaultSession, vaultSessionPorts } from "./vault-session";
import type { DesktopSnapshot } from "./vault-session/types";

/**
 * Synchronous by contract: autofill, passkey and credential handlers read this
 * on every request. `getSnapshot()` re-evaluates the desktop and the timeout as
 * it reads, which is what makes a stale timer or a desktop that locked behind
 * our back fail closed.
 */
export function isUnlocked(): boolean {
	return vaultSession.getSnapshot().unlocked;
}

export function isDesktopMode(): boolean {
	return vaultSession.getSnapshot().desktopMode;
}

export function getLastActivityTimestamp(): number {
	return vaultSession.getSnapshot().lastActivityAt;
}

/** One number for both arming and reporting; a connected desktop's value wins. */
export function getAutoLockTimeoutCached(): number {
	return vaultSession.getSnapshot().autoLockTimeoutMs;
}

export async function refreshAutoLockTimeout(): Promise<void> {
	const timeoutMs = await vaultSessionPorts.settings.readAutoLockTimeoutMs();
	await vaultSession.dispatch({
		type: "TIMEOUT_SETTING_CHANGED",
		timeoutMs,
		at: Date.now(),
	});
}

export async function updateActivity(): Promise<void> {
	await refreshAutoLockTimeout();
	await vaultSession.dispatch({ type: "ACTIVITY", at: Date.now() });
}

/** Also stamps activity, so callers no longer have to order the two. */
export function setMasterUnlockKey(muk: KeyRef): void {
	vaultSession.dispatchNow({ type: "LOCAL_UNLOCKED", muk, at: Date.now() });
}

/** Desktop ownership is `owner: "desktop"` now; there is no sentinel MUK. */
export function setDesktopModeSentinel(): void {
	vaultSession.dispatchNow({
		type: "DESKTOP_UNLOCK_PUSHED",
		accountIds: [],
		at: Date.now(),
	});
}

function isDesktopUnlocked(status: DesktopSnapshot | null): boolean {
	return Boolean(
		status?.connected && !status.locked && status.unlockedAccountIds.length > 0,
	);
}

/**
 * Ensure lock state can be recovered from desktop mode on demand.
 * Useful for handlers that run before desktop sync initialization settles.
 */
export async function ensureUnlockedOrRecoverFromDesktop(): Promise<boolean> {
	if (isUnlocked()) {
		return true;
	}

	const cached = vaultSessionPorts.desktop.readCached();
	const status = isDesktopUnlocked(cached)
		? cached
		: await vaultSessionPorts.desktop.refresh();

	if (!isDesktopUnlocked(status) || !status) {
		return false;
	}

	vaultSession.dispatchNow({
		type: "DESKTOP_UNLOCK_PUSHED",
		accountIds: status.unlockedAccountIds,
		at: Date.now(),
	});
	return true;
}

/**
 * The alarm is the backup that survives a service-worker recycle; the reducer
 * decides whether the deadline actually passed or needs rescheduling.
 */
export async function handleAutoLockAlarm(
	alarm: chrome.alarms.Alarm,
): Promise<void> {
	if (alarm.name !== AUTO_LOCK_ALARM_NAME) {
		return;
	}

	await refreshAutoLockTimeout();
	await vaultSession.dispatch({ type: "TIMEOUT_ELAPSED", at: Date.now() });
}
