/**
 * Session Manager
 * Manages Master Unlock Key in memory, auto-lock timers, and keepalive mechanism
 */

import { DEFAULT_AUTO_LOCK_TIMEOUT_MS, storage } from "../lib/storage";
import { AUTO_LOCK_ALARM_NAME, KEEPALIVE_INTERVAL_MS } from "./constants";
import { desktopSync } from "./desktop-sync";

const LOCKED_ACTION_ICON_PATH = "icons/lock-icon.png";
const DEFAULT_ACTION_ICON_PATHS = {
	16: "icons/icon-16.png",
	32: "icons/icon-32.png",
	48: "icons/icon-48.png",
	128: "icons/icon-128.png",
} as const;

// In-memory state
let masterUnlockKey: Uint8Array | null = null;
let lastActivityTimestamp = 0;
let autoLockTimer: NodeJS.Timeout | null = null;
let keepaliveInterval: NodeJS.Timeout | null = null;
// Cache the timeout value to avoid async lookups in synchronous functions
let cachedAutoLockTimeoutMs = DEFAULT_AUTO_LOCK_TIMEOUT_MS;

// Sentinel MUK for desktop mode (0xDE = "Desktop")
// When this special value is set, it indicates the extension is unlocked via desktop app
const DESKTOP_MODE_SENTINEL = new Uint8Array(32).fill(0xde);

function setLockIndicator(locked: boolean): void {
	if (typeof chrome === "undefined" || !chrome.action?.setIcon) {
		return;
	}

	try {
		const lockedIconPath =
			chrome.runtime?.getURL(LOCKED_ACTION_ICON_PATH) ??
			LOCKED_ACTION_ICON_PATH;

		chrome.action.setIcon({
			path: locked ? lockedIconPath : DEFAULT_ACTION_ICON_PATHS,
		});
		// Ensure old badge-based lock indicators are cleared.
		chrome.action.setBadgeText?.({ text: "" });
	} catch {
		// Ignore icon updates when the action API is unavailable (e.g. tests).
	}
}

/**
 * Initialize toolbar lock indicator for current lock state.
 */
export function initializeLockBadge(): void {
	setLockIndicator(!masterUnlockKey);
}

/**
 * Refresh the cached auto-lock timeout from storage
 * Should be called when settings change or on startup
 */
export async function refreshAutoLockTimeout(): Promise<void> {
	cachedAutoLockTimeoutMs = await storage.getAutoLockTimeoutOrDefault();
}

/**
 * Get the current auto-lock timeout (cached value)
 * If desktop is available, use desktop timeout; otherwise use extension timeout
 */
export function getAutoLockTimeoutCached(): number {
	// Use desktop timeout when available
	const desktopTimeout = desktopSync.getDesktopTimeout();
	if (desktopTimeout !== null) {
		return desktopTimeout;
	}

	// Fallback to extension timeout
	return cachedAutoLockTimeoutMs;
}

/**
 * Update activity timestamp and reset auto-lock timer
 */
export async function updateActivity(): Promise<void> {
	// Refresh the timeout in case settings changed
	await refreshAutoLockTimeout();
	lastActivityTimestamp = Date.now();
	resetAutoLockTimer();
}

/**
 * Reset the auto-lock timer
 */
function resetAutoLockTimer() {
	// Clear existing timeout
	if (autoLockTimer) {
		clearTimeout(autoLockTimer);
	}

	// If timeout is -1 (never), don't set a timer
	if (cachedAutoLockTimeoutMs === -1) {
		// Clear any existing Chrome alarm
		chrome.alarms.clear(AUTO_LOCK_ALARM_NAME);
		// Start keepalive when there's active session
		startKeepalive();
		return;
	}

	// Use setTimeout for in-memory timer
	autoLockTimer = setTimeout(() => {
		_lockInternal().catch((error) => {
			console.error("Failed to lock extension:", error);
		});
	}, cachedAutoLockTimeoutMs);

	// Also set Chrome Alarm as backup (survives service worker restarts)
	chrome.alarms.create(AUTO_LOCK_ALARM_NAME, {
		delayInMinutes: cachedAutoLockTimeoutMs / 60000,
	});

	// Start keepalive when there's active session
	startKeepalive();
}

/**
 * Start keepalive mechanism to prevent service worker from shutting down
 */
function startKeepalive() {
	if (keepaliveInterval) return; // Already running

	keepaliveInterval = setInterval(() => {
		// Simple no-op to keep service worker alive
	}, KEEPALIVE_INTERVAL_MS);
}

/**
 * Stop keepalive mechanism
 */
function stopKeepalive() {
	if (keepaliveInterval) {
		clearInterval(keepaliveInterval);
		keepaliveInterval = null;
	}
}

/**
 * Lock the extension (clear MUK from memory)
 * Clears both the session manager's global MUK and all per-account MUKs in storage
 * Note: This function prevents independent lock when desktop is running
 * Use _lockInternal() for internal/desktop sync lock operations
 */
export async function lock(): Promise<void> {
	// Prevent independent lock when desktop is available
	if (desktopSync.isDesktopAvailable()) {
		throw new Error(
			"Cannot lock independently when desktop app is running. The vault will lock automatically when the desktop app locks.",
		);
	}

	// Perform internal lock
	await _lockInternal();
}

/**
 * Internal lock function - bypasses desktop check
 * Used by desktop sync, autolock, and other internal operations
 */
export async function _lockInternal(): Promise<void> {
	// Clear session manager's global MUK (sentinel value for "unlocked" state)
	masterUnlockKey = null;
	setLockIndicator(true);
	lastActivityTimestamp = 0;
	if (autoLockTimer) {
		clearTimeout(autoLockTimer);
		autoLockTimer = null;
	}
	// Clear the Chrome alarm
	chrome.alarms.clear(AUTO_LOCK_ALARM_NAME);
	stopKeepalive();

	// Clear all per-account MUKs from storage adapter's in-memory cache
	if (storage.lockAllAccounts) {
		await storage.lockAllAccounts();
	}
}

/**
 * Check if we're in desktop mode (sentinel MUK is set)
 */
export function isDesktopMode(): boolean {
	if (!masterUnlockKey) return false;

	// Check if MUK is the sentinel value
	if (masterUnlockKey.length !== DESKTOP_MODE_SENTINEL.length) return false;

	for (let i = 0; i < DESKTOP_MODE_SENTINEL.length; i++) {
		if (masterUnlockKey[i] !== DESKTOP_MODE_SENTINEL[i]) {
			return false;
		}
	}

	return true;
}

/**
 * Set sentinel MUK to mark as "unlocked via desktop"
 */
export function setDesktopModeSentinel(): void {
	masterUnlockKey = DESKTOP_MODE_SENTINEL;
	setLockIndicator(false);
	lastActivityTimestamp = Date.now();
}

/**
 * `isUnlocked` is a synchronous read on a hot path, so the locks it decides on
 * are fired and forgotten. The MUK is dropped from memory synchronously inside
 * `_lockInternal`, so the caller's `false` is already accurate.
 */
function autoLock(reason: string): void {
	_lockInternal().catch((error) => {
		console.error(`Failed to auto-lock (${reason}):`, error);
	});
}

/**
 * Check if extension is unlocked
 */
export function isUnlocked(): boolean {
	if (!masterUnlockKey) return false;

	const desktopAvailable = desktopSync.isDesktopAvailable();
	const desktopLocked = desktopSync.getLastStatus()?.locked ?? true;

	// A reachable but locked desktop app outranks whatever this side thinks,
	// in either mode. Checking it only in desktop mode used to let a locally
	// derived MUK (password unlock, biometric fallback) sit unlocked next to a
	// locked desktop indefinitely, because a real MUK takes the standalone path.
	if (desktopAvailable && desktopLocked) {
		autoLock("desktop app is locked");
		return false;
	}

	// In desktop mode the sentinel is only meaningful while the desktop answers.
	if (isDesktopMode()) {
		if (!desktopAvailable) {
			// Desktop disconnected, lock extension
			autoLock("desktop app disconnected");
			return false;
		}

		return true;
	}

	// Standalone mode: check auto-lock timeout
	// If timeout is -1 (never), always return true if MUK exists
	if (cachedAutoLockTimeoutMs === -1) {
		return true;
	}

	const now = Date.now();
	const timeSinceLastActivity = now - lastActivityTimestamp;

	if (timeSinceLastActivity > cachedAutoLockTimeoutMs) {
		autoLock("auto-lock timeout elapsed");
		return false;
	}

	return true;
}

/**
 * Get the Master Unlock Key from memory
 */
export function getMasterUnlockKey(): Uint8Array | null {
	return masterUnlockKey;
}

/**
 * Set the Master Unlock Key in memory
 */
export function setMasterUnlockKey(muk: Uint8Array) {
	masterUnlockKey = muk;
	setLockIndicator(false);
}

/**
 * Ensure lock state can be recovered from desktop mode on demand.
 * Useful for handlers that run before desktop sync initialization settles.
 */
export async function ensureUnlockedOrRecoverFromDesktop(): Promise<boolean> {
	if (isUnlocked()) {
		return true;
	}

	const cachedStatus = desktopSync.getLastStatus();
	const cachedUnlocked = !!(
		cachedStatus?.available &&
		!cachedStatus.locked &&
		(cachedStatus.unlockedAccounts?.length ?? 0) > 0
	);

	let desktopUnlocked = cachedUnlocked;
	if (!desktopUnlocked) {
		const refreshedStatus = await desktopSync.checkDesktopStatus();
		desktopUnlocked = !!(
			refreshedStatus?.available &&
			!refreshedStatus.locked &&
			(refreshedStatus.unlockedAccounts?.length ?? 0) > 0
		);
	}

	if (desktopUnlocked) {
		setDesktopModeSentinel();
		return true;
	}

	return false;
}

/**
 * Get the last activity timestamp
 */
export function getLastActivityTimestamp(): number {
	return lastActivityTimestamp;
}

/**
 * Handle Chrome Alarms for auto-lock
 */
export async function handleAutoLockAlarm(
	alarm: chrome.alarms.Alarm,
): Promise<void> {
	if (alarm.name === AUTO_LOCK_ALARM_NAME) {
		// Refresh the timeout value from storage
		await refreshAutoLockTimeout();

		// If timeout is -1 (never), clear the alarm and don't lock
		if (cachedAutoLockTimeoutMs === -1) {
			chrome.alarms.clear(AUTO_LOCK_ALARM_NAME);
			return;
		}

		// Check if we should still lock (in case service worker was restarted)
		if (isUnlocked()) {
			const now = Date.now();
			const timeSinceLastActivity = now - lastActivityTimestamp;

			if (timeSinceLastActivity >= cachedAutoLockTimeoutMs) {
				await _lockInternal();
			} else {
				// Reschedule if there was recent activity
				const remainingTime = cachedAutoLockTimeoutMs - timeSinceLastActivity;
				chrome.alarms.create(AUTO_LOCK_ALARM_NAME, {
					delayInMinutes: remainingTime / 60000,
				});
			}
		}
	}
}
