/**
 * Service Worker Lifecycle Utilities
 *
 * Keeps startup/recovery wiring explicit so background/index.ts can remain
 * a thin bootstrap entrypoint.
 */

import { storage } from "../../lib/storage";
import { initWasmCrypto } from "../../lib/wasm-crypto";
import { desktopSync } from "../desktop-sync";
import {
	handleAutoLockAlarm,
	refreshAutoLockTimeout,
} from "../session-manager";
import { handleSyncReconnectAlarm } from "../sync-manager";

export function initializeBackgroundServices(): void {
	initWasmCrypto().catch((error) => {
		console.error(
			"[Background lifecycle] Failed to initialize WASM crypto:",
			error,
		);
	});

	storage.initialize().catch((error) => {
		console.error(
			"[Background lifecycle] Failed to initialize storage:",
			error,
		);
	});

	// Prime cached timeout early so auto-lock checks remain deterministic
	// across service worker restarts.
	refreshAutoLockTimeout().catch((error) => {
		console.error(
			"[Background lifecycle] Failed to refresh auto-lock timeout:",
			error,
		);
	});

	desktopSync.initialize().catch((error) => {
		console.error(
			"[Background lifecycle] Failed to initialize desktop sync:",
			error,
		);
	});
}

export function registerLifecycleListeners(): void {
	chrome.alarms.onAlarm.addListener((alarm) => {
		void handleAutoLockAlarm(alarm);
		void handleSyncReconnectAlarm(alarm);
	});
}
