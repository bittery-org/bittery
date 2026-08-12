/**
 * The value vocabulary of the crypto seam.
 *
 * Every shape here is the TypeScript spelling of a `uniffi::Record` in the Rust core, so it
 * is owned by this package rather than by the applications above it: a field is here because
 * the core reads or writes it, not because a screen wants it. `KeyRef` and the port contract
 * itself live in `./crypto-port`.
 *
 * These are hand-written rather than re-exported from the generated bindings on purpose —
 * the port must not import a platform module (`./uniffi-bindings` explains why) and two
 * generators emit two copies of the same records. `./types.drift-guard` closes that gap at
 * compile time: it `import type`s the WASM bindings and fails the build when a hand-written
 * shape and the generated one disagree, including the places where they deliberately differ.
 */

// ============================================================================
// Encryption
// ============================================================================

/**
 * Encrypted data with IV and algorithm
 */
export interface EncryptedData {
	/** Base64-encoded ciphertext */
	ciphertext: string;
	/** Base64-encoded initialization vector */
	iv: string;
	/** Encryption algorithm (always "AES-GCM-AAD-V1") */
	algorithm: string;
}

/**
 * Encryption context bound to ciphertext integrity.
 *
 * This schema is deterministic across platforms and used to prevent
 * ciphertext swapping between entities.
 *
 * Two fields are narrower than the core's: `entityType` is a closed union where the record
 * says `string`, and `version` is a `number` where the FFI says `bigint`. The widening back
 * to the generated shape is `UniffiEncryptionContext` in `./uniffi-bindings`, which derives
 * from this type so the two cannot drift apart.
 */
export interface EncryptionContext {
	vaultId: string;
	entityId: string;
	entityType:
		| "item"
		| "attachment_name"
		| "attachment_content_type"
		| "attachment_blob"
		| "vault_key";
	version: number;
	userId: string;
}

// ============================================================================
// Key derivation
// ============================================================================

/**
 * Login KDF profile provided by the server and pinned locally.
 */
export type KdfAlgorithm = "pbkdf2-sha256";

/**
 * The core takes `schemaVersion: number` and `algorithm: string`; both are pinned to a
 * single literal here because choosing a profile is policy, and policy sits above the seam.
 */
export interface KdfProfile {
	schemaVersion: 1;
	algorithm: KdfAlgorithm;
	iterations: number;
}

// ============================================================================
// RSA
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
// SRP-6a
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
 *
 * The login KDF profile is deliberately absent. SRP derives `x` from the challenge salt and
 * the SRP password with the protocol's own fixed iteration count, so the account KDF profile
 * reaches this ceremony only through the SRP password it produced. A `kdfParams` field here
 * would look like a binding while being dropped by the FFI converter, which reads `salt` and
 * `serverPublicKey` and nothing else.
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
// One-time codes
// ============================================================================

/**
 * One generated TOTP code and where it sits in its window.
 *
 * The core counts seconds in `u64`; both counters are `number` above the seam for the same
 * reason `EncryptionContext.version` is — a period and a countdown are small integers no
 * caller should have to spell `30n`. `./types.drift-guard` pins that conversion at both ends.
 */
export interface TotpResult {
	/** The code, zero-padded to the requested number of digits. */
	code: string;
	/** Seconds left before the current window ends. */
	remainingSeconds: number;
	/** The window length the code was generated for, echoed back. */
	period: number;
	/** Percentage (0-100) of the current window already elapsed. */
	progress: number;
}

// ============================================================================
// Key rotation
// ============================================================================

/**
 * Member key data for key rotation
 */
export interface MemberKeyData {
	userId: string;
	publicKey: string;
}

/**
 * Item data for re-encryption during key rotation.
 *
 * `context` is the AAD the stored ciphertext is bound to. Rotation re-binds the replacement
 * to the same context, so an item that was bound stays bound and one written before AAD
 * binding existed stays unbound.
 */
export interface ItemData {
	id: string;
	encryptedData: string;
	encryptionIv: string;
	encryptionAlgorithm: string;
	context: EncryptionContext;
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
