/**
 * Desktop App Storage Module
 * Singleton instance of the TauriStorageAdapter with injected crypto
 */

import { createTauriStorageAdapter } from "@bittery/storage/adapters/tauri";
import { decrypt, encrypt, rsaDecrypt } from "./tauri-crypto";

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
	AccountMetadata,
	StoredSessionData,
	VaultKeyData,
} from "@bittery/storage";

export {
	BIOMETRIC_GRACE_PERIOD_MS,
	DEFAULT_AUTO_LOCK_TIMEOUT_MS,
	DEFAULT_SESSION_EXPIRY_MS,
} from "@bittery/storage";
