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
import { registerBackgroundMessageRouter } from "./router";
import {
	initializeBackgroundServices,
	registerLifecycleListeners,
} from "./services/service-worker-lifecycle";
import { backgroundClientRuntime } from "./vault-runtime";

const desktopSync = new DesktopSyncService(backgroundClientRuntime.accounts);
configureDesktopSync(desktopSync);
const core = createBackgroundCore(backgroundClientRuntime);

void initializeBackgroundServices(backgroundClientRuntime, desktopSync);
registerBackgroundMessageRouter({
	runtime: backgroundClientRuntime,
	desktopSync,
	itemCommands: core.itemCommands,
});
registerLifecycleListeners();
