/**
 * Mobile Storage Service
 * Singleton instance of the ReactNativeStorageAdapter with injected crypto
 */

import { createReactNativeStorageAdapter } from "@bittery/storage/adapters/react-native";
import { encrypt, decrypt, rsaDecrypt } from "../lib/crypto/native-crypto";

// Create crypto provider from native crypto wrapper
const cryptoProvider = { encrypt, decrypt, rsaDecrypt };

// Singleton adapter instance
export const storage = createReactNativeStorageAdapter(cryptoProvider);

// Re-export types and constants for convenience
export type {
	VaultKeyData,
	AccountMetadata,
	StoredSessionData,
	BiometricAuthResult,
	BiometricErrorType,
} from "@bittery/storage";

export {
	DEFAULT_AUTO_LOCK_TIMEOUT_MS,
	DEFAULT_SESSION_EXPIRY_MS,
	BIOMETRIC_GRACE_PERIOD_MS,
} from "@bittery/storage";
