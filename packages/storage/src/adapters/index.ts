/**
 * Platform-specific storage adapters
 */

export { WebStorageAdapter, createWebStorageAdapter } from "./web";
export { ChromeStorageAdapter, createChromeStorageAdapter } from "./chrome";
export { TauriStorageAdapter, createTauriStorageAdapter } from "./tauri";
export { ReactNativeStorageAdapter, createReactNativeStorageAdapter } from "./react-native";
