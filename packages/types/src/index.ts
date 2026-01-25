/**
 * Shared crypto types for Bittery
 *
 * These types are used across all platforms (web, desktop, mobile, extension)
 * for consistent interfaces when working with crypto operations.
 */

// ============================================================================
// Key Derivation Types
// ============================================================================

/**
 * Result from key derivation (PBKDF2 + HKDF)
 */
export interface DerivedKeys {
	authKey: Uint8Array;
	masterUnlockKey: Uint8Array;
}

// ============================================================================
// Encryption Types
// ============================================================================

/**
 * Encrypted data with IV and algorithm
 */
export interface EncryptedData {
	/** Base64-encoded ciphertext */
	ciphertext: string;
	/** Base64-encoded initialization vector */
	iv: string;
	/** Encryption algorithm (always "AES-GCM") */
	algorithm: string;
}

// ============================================================================
// RSA Types
// ============================================================================

/**
 * RSA key pair
 */
export interface RsaKeyPair {
	/** PEM-encoded public key (SPKI format) */
	publicKey: string;
	/** PEM-encoded private key (PKCS8 format) */
	privateKey: string;
}

// ============================================================================
// SRP-6a Types
// ============================================================================

/**
 * SRP registration data (salt + verifier)
 */
export interface SRPRegistration {
	salt: string;
	verifier: string;
}

/**
 * SRP client ephemeral key pair
 */
export interface SRPClientEphemeral {
	publicKey: string;
	secret: string;
}

/**
 * SRP server challenge (sent to client during login)
 */
export interface SRPServerChallenge {
	salt: string;
	serverPublicKey: string;
}

/**
 * SRP client session (key + proof)
 */
export interface SRPClientSession {
	key: string;
	proof: string;
}

// ============================================================================
// Key Rotation Types
// ============================================================================

/**
 * Member key data for key rotation
 */
export interface MemberKeyData {
	userId: string;
	publicKey: string;
}

/**
 * Item data for re-encryption during key rotation
 */
export interface ItemData {
	id: string;
	encryptedData: string;
	encryptionIv: string;
	encryptionAlgorithm: string;
}

/**
 * Re-encrypted item result
 */
export interface ReEncryptedItem {
	itemId: string;
	encryptedData: string;
	encryptionIv: string;
}

/**
 * Member with encrypted vault key
 */
export interface MemberEncryptedKey {
	userId: string;
	encryptedVaultKey: string;
}

/**
 * Key rotation result
 */
export interface KeyRotationResult {
	newVaultKey: Uint8Array;
	newVaultKeyBase64: string;
	memberEncryptedKeys: MemberEncryptedKey[];
	reEncryptedItems: ReEncryptedItem[];
}

/**
 * Validation result for rotation data
 */
export interface ValidationResult {
	valid: boolean;
	errors: string[];
}
