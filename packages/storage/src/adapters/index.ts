/**
 * Platform-specific storage adapters
 */

export { ChromeStorageAdapter, createChromeStorageAdapter } from "./chrome";
export {
	createReactNativeStorageAdapter,
	ReactNativeStorageAdapter,
} from "./react-native";
export { createTauriStorageAdapter, TauriStorageAdapter } from "./tauri";
export { createWebStorageAdapter, WebStorageAdapter } from "./web";
