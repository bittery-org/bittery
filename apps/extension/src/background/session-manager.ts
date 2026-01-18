/**
 * Session Manager
 * Manages Master Unlock Key in memory, auto-lock timers, and keepalive mechanism
 */

import { AUTO_LOCK_ALARM_NAME, AUTO_LOCK_TIMEOUT_MS, KEEPALIVE_INTERVAL_MS } from "./constants";

// In-memory state
let masterUnlockKey: Uint8Array | null = null;
let lastActivityTimestamp = 0;
let autoLockTimer: NodeJS.Timeout | null = null;
let keepaliveInterval: NodeJS.Timeout | null = null;

/**
 * Update activity timestamp and reset auto-lock timer
 */
export function updateActivity() {
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

	// Use setTimeout for in-memory timer
	autoLockTimer = setTimeout(() => {
		console.log("Auto-locking due to inactivity");
		lock();
	}, AUTO_LOCK_TIMEOUT_MS);

	// Also set Chrome Alarm as backup (survives service worker restarts)
	chrome.alarms.create(AUTO_LOCK_ALARM_NAME, {
		delayInMinutes: AUTO_LOCK_TIMEOUT_MS / 60000,
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
 */
export function lock() {
	masterUnlockKey = null;
	lastActivityTimestamp = 0;
	if (autoLockTimer) {
		clearTimeout(autoLockTimer);
		autoLockTimer = null;
	}
	// Clear the Chrome alarm
	chrome.alarms.clear(AUTO_LOCK_ALARM_NAME);
	stopKeepalive();
	console.log("Extension locked");
}

/**
 * Check if extension is unlocked
 */
export function isUnlocked(): boolean {
	if (!masterUnlockKey) return false;

	const now = Date.now();
	const timeSinceLastActivity = now - lastActivityTimestamp;

	if (timeSinceLastActivity > AUTO_LOCK_TIMEOUT_MS) {
		lock();
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
export function handleAutoLockAlarm(alarm: chrome.alarms.Alarm) {
	if (alarm.name === AUTO_LOCK_ALARM_NAME) {
		console.log("Auto-lock alarm triggered");
		// Check if we should still lock (in case service worker was restarted)
		if (isUnlocked()) {
			const now = Date.now();
			const timeSinceLastActivity = now - lastActivityTimestamp;

			if (timeSinceLastActivity >= AUTO_LOCK_TIMEOUT_MS) {
				lock();
			} else {
				// Reschedule if there was recent activity
				const remainingTime = AUTO_LOCK_TIMEOUT_MS - timeSinceLastActivity;
				chrome.alarms.create(AUTO_LOCK_ALARM_NAME, {
					delayInMinutes: remainingTime / 60000,
				});
			}
		}
	}
}
