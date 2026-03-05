/**
 * Web App Storage Module
 * Singleton instance of the WebStorageAdapter with injected crypto
 */

import { createWebStorageAdapter } from "@bittery/storage/adapters/web";
import {
	decrypt,
	decryptKeyHandleWithWrappingKey,
	decryptWithKeyHandle,
	destroyKeyHandle,
	encrypt,
	encryptKeyHandleWithWrappingKey,
	encryptWithKeyHandle,
	exportKeyHandle,
	rsaDecrypt,
} from "./wasm-crypto";

// Create crypto provider from WASM crypto wrapper
const cryptoProvider = {
	encrypt,
	decrypt,
	rsaDecrypt,
	encryptWithKeyHandle,
	decryptWithKeyHandle,
	encryptKeyHandleWithWrappingKey,
	decryptKeyHandleWithWrappingKey,
	exportKeyHandle,
	destroyKeyHandle,
};

// Singleton adapter instance
export const storage = createWebStorageAdapter(cryptoProvider);

// Re-export types for convenience
export type {
	AccountMetadata,
	StoredSessionData,
	VaultKeyData,
} from "@bittery/storage";
