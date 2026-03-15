/**
 * @bittery/storage - Client-side storage adapters
 *
 * This package provides platform-specific storage adapters for:
 * - Web (localStorage/sessionStorage)
 * - Chrome Extension (chrome.storage)
 * - Desktop/Tauri (Tauri Store + OS Keychain)
 * - Mobile/React Native (SecureStore + SQLite)
 *
 * All adapters implement the IStorageAdapter interface for consistent
 * cross-platform storage operations.
 */

// Adapter interface
export type { IStorageAdapter } from "./adapter";
// Crypto provider interface
export type { CryptoProvider } from "./crypto-provider";
export * from "./session";
// Types
export * from "./types";
