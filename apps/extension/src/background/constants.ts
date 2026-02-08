/**
 * Constants for the background service worker
 */

export const NATIVE_HOST_NAME = "com.bittery.desktop";
// Note: AUTO_LOCK_TIMEOUT_MS is now configurable and stored in chrome.storage.local
// Use storage.getAutoLockTimeoutOrDefault() from @/lib/storage instead
export const AUTOFILL_REAUTH_WINDOW_MS = 5 * 60 * 1000; // 5 minutes (separate for autofill security)
export const KEEPALIVE_INTERVAL_MS = 20 * 1000; // 20 seconds (well before 30s service worker timeout)
export const AUTO_LOCK_ALARM_NAME = "autoLockAlarm";
