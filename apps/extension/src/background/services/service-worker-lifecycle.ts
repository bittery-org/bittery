/**
 * Service Worker Lifecycle Utilities
 *
 * Keeps startup/recovery wiring explicit so background/index.ts can remain
 * a thin bootstrap entrypoint.
 */

import { initializeStorage } from "../../lib/storage";
import { initWasmCrypto } from "../../lib/wasm-crypto";
import { desktopSync } from "../desktop-sync";
import {
	handleAutoLockAlarm,
	initializeLockBadge,
	refreshAutoLockTimeout,
} from "../session-manager";
import { handleSyncReconnectAlarm } from "../sync-manager";
import { restoreUnlockedSessions } from "./session-restore";

let bootstrapPromise: Promise<void> | null = null;

async function bootstrap(): Promise<void> {
	initializeLockBadge();

	await initWasmCrypto().catch((error) => {
		console.error(
			"[Background lifecycle] Failed to initialize WASM crypto:",
			error,
		);
	});

	await initializeStorage().catch((error) => {
		console.error("[Background lifecycle] Failed to initialize storage:", error);
	});

	// The explicit unlock restore. `AccountStore.getUnlockedAccounts()` reports only what
	// is in memory, and MV3 empties that on every service-worker recycle, so this has to
	// run before anything reads it. See `session-restore.ts` for the full rationale and
	// which restart cases it covers.
	await restoreUnlockedSessions();

	// Prime cached timeout early so auto-lock checks remain deterministic
	// across service worker restarts.
	await refreshAutoLockTimeout().catch((error) => {
		console.error(
			"[Background lifecycle] Failed to refresh auto-lock timeout:",
			error,
		);
	});

	// Last: a reachable-but-locked desktop app outranks a locally restored session and
	// will lock this side back down, so it must observe the restored state.
	await desktopSync.initialize().catch((error) => {
		console.error(
			"[Background lifecycle] Failed to initialize desktop sync:",
			error,
		);
	});
}

/**
 * Run the startup routine exactly once per service-worker instantiation.
 *
 * MV3 tears down module state on every recycle, so this legitimately re-runs on each wake.
 */
export function initializeBackgroundServices(): Promise<void> {
	bootstrapPromise ??= bootstrap();
	return bootstrapPromise;
}

/**
 * Awaited by the runtime message listener so no handler observes a half-restored world
 * after a service-worker wake.
 */
export function ensureBackgroundServicesReady(): Promise<void> {
	return initializeBackgroundServices();
}

export function registerLifecycleListeners(): void {
	chrome.alarms.onAlarm.addListener((alarm) => {
		void handleAutoLockAlarm(alarm);
		void handleSyncReconnectAlarm(alarm);
	});
}
