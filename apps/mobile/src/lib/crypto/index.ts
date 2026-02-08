/**
 * Native crypto exports for React Native
 *
 * This module provides the unified crypto interface using native Rust
 * implementations via the @bittery/crypto-nitro Expo module.
 */

export {
	// Utility functions
	arrayBufferToBase64,
	base64ToArrayBuffer,
	// SRP-6a client/server factories
	createBitterySRPClient,
	createBitterySRPServer,
	createSRPClient,
	createSRPServer,
	// Types
	type DerivedKeys,
	// AES-256-GCM (compatible with @bittery/crypto/encryption interface)
	decrypt,
	decryptData,
	decryptRaw,
	// SRP-6a helper functions (matching @bittery/crypto/srp-client interface)
	deriveClientSession,
	// Key derivation
	deriveKeys,
	type EncryptedData,
	encrypt,
	encryptWithBase64Key,
	generateClientEphemeral,
	generateEncryptionKey,
	// RSA-4096
	generateRsaKeyPair,
	// Secret key
	generateSecretKey,
	generateSRPRegistration,
	getSecretKeyHint,
	type HashAlgorithm,
	type PrimeGroup,
	type RsaKeyPair,
	rsaDecrypt,
	rsaEncrypt,
	type SRPClientEphemeral,
	type SRPClientSession,
	type SRPRegistration,
	type SRPServerChallenge,
	validateSecretKey,
	verifyServerSession,
} from "./native-crypto";
