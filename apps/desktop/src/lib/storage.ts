/**
 * Desktop App Storage Module
 * Singleton instance of the TauriStorageAdapter with injected crypto
 */

import { createTauriStorageAdapter } from "@bittery/storage/adapters/tauri";
import { encrypt, decrypt, rsaDecrypt } from "./tauri-crypto";

// Create crypto provider from Tauri crypto wrapper
const cryptoProvider = { encrypt, decrypt, rsaDecrypt };

// Singleton adapter instance
export const storage = createTauriStorageAdapter(cryptoProvider);

// Promise that resolves when storage is initialized
let initializePromise: Promise<void> | null = null;

/**
 * Initialize the storage adapter. Must be called before using storage.
 * Safe to call multiple times - subsequent calls return the same promise.
 */
export async function initializeStorage(): Promise<void> {
	if (!initializePromise) {
		initializePromise = storage.initialize();
	}
	return initializePromise;
}

// Re-export types and constants for convenience
export type {
	VaultKeyData,
	AccountMetadata,
	StoredSessionData,
} from "@bittery/storage";

export {
	DEFAULT_AUTO_LOCK_TIMEOUT_MS,
	DEFAULT_SESSION_EXPIRY_MS,
	BIOMETRIC_GRACE_PERIOD_MS,
} from "@bittery/storage";
