/**
 * Sync Lifecycle Effects
 *
 * Small wrappers around `sync-manager` used by route definitions so the
 * registry can declare sync side effects (`before`, `syncInitOnSuccess`)
 * without every route re-importing and re-deriving the same logic.
 */

import {
	cleanupSync,
	connect as connectSync,
	disconnect as disconnectSync,
	getClientId as getSyncClientId,
	getStatus as getSyncStatus,
	initializeSync,
} from "../sync-manager";

export {
	cleanupSync,
	connectSync,
	disconnectSync,
	getSyncClientId,
	getSyncStatus,
};

export function ensureSyncInitialized(_reason: string): void {
	const status = getSyncStatus();
	if (status === "connected" || status === "connecting") {
		return;
	}

	initializeSync().catch((error) => {
		console.error("[Background router] Failed to initialize sync:", error);
	});
}
