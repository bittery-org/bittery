/**
 * Extension Storage Module
 * Singleton instance of the ChromeStorageAdapter with injected crypto
 */

import { createChromeStorageAdapter } from "@bittery/storage/adapters/chrome";
import { encrypt, decrypt, rsaDecrypt } from "./wasm-crypto";

// Create crypto provider from WASM crypto wrapper
const cryptoProvider = { encrypt, decrypt, rsaDecrypt };

// Singleton adapter instance
export const storage = createChromeStorageAdapter(cryptoProvider);

// Re-export types and constants for convenience
export type {
	VaultKeyData,
	AccountMetadata,
	StoredSessionData,
} from "@bittery/storage";

export { DEFAULT_AUTO_LOCK_TIMEOUT_MS } from "@bittery/storage";
