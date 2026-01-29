/**
 * Session Manager
 * Manages Master Unlock Key in memory, auto-lock timers, and keepalive mechanism
 */

import { DEFAULT_AUTO_LOCK_TIMEOUT_MS, storage } from "../lib/storage";
import { AUTO_LOCK_ALARM_NAME, KEEPALIVE_INTERVAL_MS } from "./constants";

// In-memory state
let masterUnlockKey: Uint8Array | null = null;
let lastActivityTimestamp = 0;
let autoLockTimer: NodeJS.Timeout | null = null;
let keepaliveInterval: NodeJS.Timeout | null = null;
// Cache the timeout value to avoid async lookups in synchronous functions
let cachedAutoLockTimeoutMs = DEFAULT_AUTO_LOCK_TIMEOUT_MS;

/**
 * Refresh the cached auto-lock timeout from storage
 * Should be called when settings change or on startup
 */
export async function refreshAutoLockTimeout(): Promise<void> {
	cachedAutoLockTimeoutMs = await storage.getAutoLockTimeoutOrDefault();
}

/**
 * Get the current auto-lock timeout (cached value)
 */
export function getAutoLockTimeoutCached(): number {
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
		console.log("Auto-locking due to inactivity");
		lock().catch((error) => {
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

	console.log("Starting service worker keepalive");
	keepaliveInterval = setInterval(() => {
		// Simple no-op to keep service worker alive
		console.debug("Keepalive ping");
	}, KEEPALIVE_INTERVAL_MS);
}

/**
 * Stop keepalive mechanism
 */
function stopKeepalive() {
	if (keepaliveInterval) {
		clearInterval(keepaliveInterval);
		keepaliveInterval = null;
		console.log("Stopped service worker keepalive");
	}
}

/**
 * Lock the extension (clear MUK from memory)
 * Clears both the session manager's global MUK and all per-account MUKs in storage
 */
export async function lock(): Promise<void> {
	// Clear session manager's global MUK (sentinel value for "unlocked" state)
	masterUnlockKey = null;
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

	console.log("Extension locked (all accounts)");
}

/**
 * Check if extension is unlocked
 */
export function isUnlocked(): boolean {
	if (!masterUnlockKey) return false;

	// If timeout is -1 (never), always return true if MUK exists
	if (cachedAutoLockTimeoutMs === -1) {
		return true;
	}

	const now = Date.now();
	const timeSinceLastActivity = now - lastActivityTimestamp;

	if (timeSinceLastActivity > cachedAutoLockTimeoutMs) {
		// Auto-lock due to timeout (fire and forget)
		lock().catch((error) => {
			console.error("Failed to auto-lock:", error);
		});
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
		console.log("Auto-lock alarm triggered");

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
				await lock();
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
