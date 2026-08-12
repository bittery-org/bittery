/**
 * The only file in `vault-session/` allowed to touch `chrome.action`,
 * `chrome.alarms`, `setTimeout`/`setInterval` or the push protocol.
 *
 * Behavior is ported verbatim from the old `session-manager` module globals,
 * including the dual timer + alarm arming (the alarm is what survives a service
 * worker recycle) and the keepalive interval.
 */

import { AUTO_LOCK_ALARM_NAME, KEEPALIVE_INTERVAL_MS } from "../../constants";
import { emitBackgroundEvent } from "../../events";
import type { ChromeSessionPort } from "../ports";

const LOCKED_ACTION_ICON_PATH = "icons/lock-icon.png";
const DEFAULT_ACTION_ICON_PATHS = {
	16: "icons/icon-16.png",
	32: "icons/icon-32.png",
	48: "icons/icon-48.png",
	128: "icons/icon-128.png",
} as const;

export function createChromeSessionAdapter(): ChromeSessionPort {
	let autoLockTimer: ReturnType<typeof setTimeout> | null = null;
	let keepaliveInterval: ReturnType<typeof setInterval> | null = null;

	function clearAlarm(): void {
		if (typeof chrome === "undefined" || !chrome.alarms?.clear) {
			return;
		}
		void chrome.alarms.clear(AUTO_LOCK_ALARM_NAME);
	}

	return {
		setLockIndicator(locked: boolean): void {
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
		},

		armAutoLock(delayMs: number, onElapsed: () => void): void {
			if (autoLockTimer) {
				clearTimeout(autoLockTimer);
			}
			autoLockTimer = setTimeout(onElapsed, delayMs);

			// The alarm is the backup that outlives a service worker recycle.
			if (typeof chrome !== "undefined" && chrome.alarms?.create) {
				chrome.alarms.create(AUTO_LOCK_ALARM_NAME, {
					delayInMinutes: delayMs / 60000,
				});
			}
		},

		disarmAutoLock(): void {
			if (autoLockTimer) {
				clearTimeout(autoLockTimer);
				autoLockTimer = null;
			}
			clearAlarm();
		},

		startKeepalive(): void {
			if (keepaliveInterval) {
				return;
			}
			keepaliveInterval = setInterval(() => {
				// Simple no-op to keep service worker alive
			}, KEEPALIVE_INTERVAL_MS);
		},

		stopKeepalive(): void {
			if (keepaliveInterval) {
				clearInterval(keepaliveInterval);
				keepaliveInterval = null;
			}
		},

		// The reducer's broadcast vocabulary is a subset of the push contract;
		// this call is what makes a member it grows without a contract entry a
		// compile error rather than a message nothing can receive.
		broadcast(message): void {
			void emitBackgroundEvent(message);
		},
	};
}
