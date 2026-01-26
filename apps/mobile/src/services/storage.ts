/**
 * Mobile Storage Service
 * Singleton instance of the ReactNativeStorageAdapter with injected crypto
 */

import { createReactNativeStorageAdapter } from "@bittery/storage/adapters/react-native";
import { decrypt, encrypt, rsaDecrypt } from "../lib/crypto/native-crypto";

// Create crypto provider from native crypto wrapper
const cryptoProvider = { encrypt, decrypt, rsaDecrypt };

// Singleton adapter instance
export const storage = createReactNativeStorageAdapter(cryptoProvider);

// Re-export types and constants for convenience
export type {
	AccountMetadata,
	BiometricAuthResult,
	BiometricErrorType,
	StoredSessionData,
	VaultKeyData,
} from "@bittery/storage";

export {
	BIOMETRIC_GRACE_PERIOD_MS,
	DEFAULT_AUTO_LOCK_TIMEOUT_MS,
	DEFAULT_SESSION_EXPIRY_MS,
	getBiometricErrorMessage,
} from "@bittery/storage";
