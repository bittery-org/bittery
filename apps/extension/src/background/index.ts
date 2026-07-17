/**
 * Background Service Worker Entry Point
 *
 * Responsibilities are intentionally thin here:
 * - bootstrap background dependencies
 * - register runtime message routing
 * - register lifecycle event listeners
 */

import { registerBackgroundMessageRouter } from "./router";
import {
	initializeBackgroundServices,
	registerLifecycleListeners,
} from "./services/service-worker-lifecycle";

initializeBackgroundServices();
registerBackgroundMessageRouter();
registerLifecycleListeners();
