/**
 * WASM Crypto Module
 *
 * Provides a unified interface to the Rust-based WASM crypto library.
 * This module handles WASM initialization and exports all crypto functions.
 *
 * Usage:
 * ```typescript
 * import { initWasmCrypto, wasmCrypto } from '@bittery/crypto/wasm';
 *
 * // Initialize once at app startup
 * await initWasmCrypto();
 *
 * // Use crypto functions
 * const keys = wasmCrypto.deriveKeys(password, secretKey, email);
 * ```
 */

// Re-export types from WASM package
export type {
  JsDerivedKeys,
  JsEncryptedData,
  JsEphemeral,
  JsRsaKeyPair,
  JsSession,
  JsSrpClient,
  JsSrpServer,
} from "@bittery/crypto-wasm";

// Import WASM module
import init, {
  decrypt,
  deriveKeys,
  encrypt,
  generateEncryptionKey,
  generateRSAKeyPair,
  generateSecretKey,
  getSecretKeyHint,
  rsaDecrypt,
  rsaEncrypt,
  validateSecretKey,
  JsSrpClient,
  JsSrpServer,
  type JsDerivedKeys,
  type JsEncryptedData,
  type JsRsaKeyPair,
} from "@bittery/crypto-wasm";

let initialized = false;
let initPromise: Promise<void> | null = null;

/**
 * Initialize the WASM crypto module.
 * Must be called before using any crypto functions.
 * Safe to call multiple times - will only initialize once.
 */
export async function initWasmCrypto(): Promise<void> {
  if (initialized) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    await init();
    initialized = true;
  })();

  return initPromise;
}

/**
 * Check if WASM crypto is initialized
 */
export function isWasmInitialized(): boolean {
  return initialized;
}

/**
 * Ensure WASM is initialized, throw if not
 */
function ensureInitialized(): void {
  if (!initialized) {
    throw new Error(
      "WASM crypto not initialized. Call initWasmCrypto() first."
    );
  }
}

// ============================================================================
// Crypto Functions Wrapper
// ============================================================================

/**
 * WASM Crypto API - all functions throw if WASM is not initialized
 */
export const wasmCrypto = {
  // Key Derivation
  deriveKeys(
    accountPassword: string,
    secretKey: string,
    email: string
  ): JsDerivedKeys {
    ensureInitialized();
    return deriveKeys(accountPassword, secretKey, email);
  },

  // AES-256-GCM Encryption
  encrypt(plaintext: string, keyBase64: string): JsEncryptedData {
    ensureInitialized();
    return encrypt(plaintext, keyBase64);
  },

  decrypt(encryptedData: JsEncryptedData, keyBase64: string): string {
    ensureInitialized();
    return decrypt(encryptedData, keyBase64);
  },

  generateEncryptionKey(): string {
    ensureInitialized();
    return generateEncryptionKey();
  },

  // RSA-4096
  generateRSAKeyPair(): JsRsaKeyPair {
    ensureInitialized();
    return generateRSAKeyPair();
  },

  rsaEncrypt(plaintext: string, publicKeyPem: string): string {
    ensureInitialized();
    return rsaEncrypt(plaintext, publicKeyPem);
  },

  rsaDecrypt(ciphertext: string, privateKeyPem: string): string {
    ensureInitialized();
    return rsaDecrypt(ciphertext, privateKeyPem);
  },

  // Secret Key
  generateSecretKey(): string {
    ensureInitialized();
    return generateSecretKey();
  },

  validateSecretKey(secretKey: string): boolean {
    ensureInitialized();
    return validateSecretKey(secretKey);
  },

  getSecretKeyHint(secretKey: string): string {
    ensureInitialized();
    return getSecretKeyHint(secretKey);
  },

  // SRP-6a
  createSrpClient(
    hashAlgorithm: "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512",
    primeGroup: 1024 | 1536 | 2048 | 3072 | 4096 | 6144 | 8192
  ): JsSrpClient {
    ensureInitialized();
    return new JsSrpClient(hashAlgorithm, primeGroup);
  },

  createSrpServer(
    hashAlgorithm: "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512",
    primeGroup: 1024 | 1536 | 2048 | 3072 | 4096 | 6144 | 8192
  ): JsSrpServer {
    ensureInitialized();
    return new JsSrpServer(hashAlgorithm, primeGroup);
  },
};

// ============================================================================
// Convenience Types
// ============================================================================

export interface DerivedKeys {
  authKey: string;
  masterUnlockKey: string;
}

export interface EncryptedData {
  ciphertext: string;
  iv: string;
  algorithm: string;
}

export interface RsaKeyPair {
  publicKey: string;
  privateKey: string;
}

/**
 * Convert WASM JsDerivedKeys to plain object
 */
export function toDerivedKeys(wasmKeys: JsDerivedKeys): DerivedKeys {
  return {
    authKey: wasmKeys.auth_key,
    masterUnlockKey: wasmKeys.master_unlock_key,
  };
}

/**
 * Convert WASM JsEncryptedData to plain object
 */
export function toEncryptedData(wasmData: JsEncryptedData): EncryptedData {
  return {
    ciphertext: wasmData.ciphertext,
    iv: wasmData.iv,
    algorithm: wasmData.algorithm,
  };
}

/**
 * Convert WASM JsRsaKeyPair to plain object
 */
export function toRsaKeyPair(wasmKeyPair: JsRsaKeyPair): RsaKeyPair {
  return {
    publicKey: wasmKeyPair.public_key,
    privateKey: wasmKeyPair.private_key,
  };
}
