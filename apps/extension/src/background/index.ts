/**
 * Background Service Worker Entry Point
 *
 * Responsibilities are intentionally thin here:
 * - bootstrap background dependencies
 * - register runtime message routing
 * - register lifecycle event listeners
 */

import { createBackgroundCore } from "./core-instance";
import { configureDesktopSync, DesktopSyncService } from "./desktop-sync";
import { nativeMessagingClient } from "./native-messaging-client";
import { registerBackgroundMessageRouter } from "./router";
import {
	initializeBackgroundServices,
	registerLifecycleListeners,
} from "./services/service-worker-lifecycle";
import { backgroundClientRuntime } from "./vault-runtime";
import { vaultSessionPorts } from "./vault-session";

const desktopSync = new DesktopSyncService(backgroundClientRuntime.accounts);
configureDesktopSync(desktopSync);
nativeMessagingClient.configureRetirementCleanup(async (event) => {
	try {
		if (event?.event === "lock") {
			await desktopSync.handleLockEvent(event.payload);
		} else {
			await desktopSync.handleDesktopCloseEvent({ timestamp: Date.now() });
		}
	} finally {
		// Direct native hydration need not change the UI session owner. The
		// transport knows whether material crossed its lease; if the reducer did
		// not clear it, use the same C1 lock before acknowledging retirement.
		if (nativeMessagingClient.needsMaterialCleanup()) {
			await vaultSessionPorts.lifecycle.lockAll();
		}
	}
});
const core = createBackgroundCore(backgroundClientRuntime);

void initializeBackgroundServices(backgroundClientRuntime, desktopSync);
registerBackgroundMessageRouter({
	runtime: backgroundClientRuntime,
	desktopSync,
	itemCommands: core.itemCommands,
});
registerLifecycleListeners();
