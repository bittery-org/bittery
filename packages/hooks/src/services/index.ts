/**
 * Autolock Service Exports
 *
 * Platform-specific autolock service implementations.
 * Each platform should use the appropriate service:
 * - Web/Extension: createWebAutolockService
 * - Mobile: createMobileAutolockService
 * - Desktop: Custom implementation using Tauri-specific APIs
 */

export { createWebAutolockService } from "./autolock-web";
export {
	createMobileAutolockService,
	type MobileAutolockOptions,
} from "./autolock-mobile";
