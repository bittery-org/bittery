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

/**
 * Crypto interface for platform-specific encryption operations.
 * All platforms (WASM, Tauri, FFI) implement this shape.
 */
export interface ICrypto {
	decrypt(encryptedData: EncryptedData, key: Uint8Array): Promise<string>;
	encrypt(plaintext: string, key: Uint8Array): Promise<EncryptedData>;
	generateEncryptionKey(): Promise<Uint8Array>;
	deriveKeys(
		password: string,
		secretKey: string,
		email: string,
	): Promise<DerivedKeys>;
	generateClientEphemeral(): SRPClientEphemeral | Promise<SRPClientEphemeral>;
	deriveClientSession(
		secret: string,
		challenge: SRPServerChallenge,
		password: string,
	): Promise<SRPClientSession>;
	verifyServerSession(
		publicKey: string,
		session: SRPClientSession,
		proof: string,
	): Promise<void>;
	validateSecretKey(secretKey: string): boolean | Promise<boolean>;
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

// ============================================================================
// Item Cache Types
// ============================================================================

/**
 * Cached encrypted item for local-first storage
 * Stores the encrypted form (safe at rest, requires vault key to decrypt)
 */
export interface CachedEncryptedItem {
	id: string;
	vaultId: string;
	category: string;
	favorite: boolean;
	encryptedData: string;
	encryptionIv: string;
	encryptionAlgorithm: string;
	version: number;
	lastModifiedBy: string | null;
	createdAt: string;
	updatedAt: string;
	deletedAt?: string | null;
}

/**
 * Cached vault metadata for local-first storage
 */
export interface CachedVaultMetadata {
	id: string;
	name: string;
	type: string;
	icon: string | null;
	imageUrl: string | null;
}

/**
 * Metadata about the item cache state
 */
export interface ItemCacheMetadata {
	lastFullSyncAt: number;
	itemCount: number;
	cacheVersion: number;
}

// ============================================================================
// Hook/Platform Integration Types
// ============================================================================

/**
 * Query invalidator interface for cache invalidation after mutations.
 * Matches the return type of createQueryInvalidator() from @bittery/sync.
 */
export interface IQueryInvalidator {
	invalidateItem(itemId: string, vaultId: string): Promise<void>;
	invalidateVaultList(vaultId: string): Promise<void>;
	invalidateVaultKeys(): Promise<void>;
	invalidateDeletedItems(vaultId: string): Promise<void>;
	invalidateTeam(): Promise<void>;
	invalidateTeamInvitations(): Promise<void>;
	invalidateShare(itemId?: string): Promise<void>;
	invalidateVaultMembers(vaultId: string): Promise<void>;
}

/**
 * Sync context - subset of sync state needed by shared hooks.
 */
export interface ISyncContext {
	clientId: string;
	isConnected: boolean;
	isOnline: boolean;
	invalidator: IQueryInvalidator;
}

/**
 * Item decryption interface.
 * @deprecated Use ICrypto from @bittery/types instead.
 */
export interface IItemDecrypt {
	decrypt(encryptedData: EncryptedData, vaultKey: Uint8Array): Promise<string>;
}

/**
 * Autolock service interface used by platform providers.
 */
export interface IAutolockService {
	initialize(): Promise<void>;
	recordActivity(): void;
	shouldLock(): Promise<boolean>;
	lock(): Promise<void>;
	onLock(callback: () => void): () => void;
	getTimeout(): Promise<number>;
	setTimeout(ms: number): Promise<void>;
	dispose(): void;
}

// ============================================================================
// Raw Item Payload Types
// ============================================================================

/**
 * Raw encrypted item returned by API/query layers.
 */
export interface RawEncryptedItem {
	id: string;
	vaultId: string;
	category: string;
	favorite: boolean;
	encryptedData: string;
	encryptionIv: string;
	encryptionAlgorithm: string;
	createdAt: string | Date;
	updatedAt: string | Date;
	deletedAt?: string | Date | null;
}

/**
 * Raw encrypted item with vault metadata.
 */
export interface RawEncryptedItemWithVault extends RawEncryptedItem {
	vault: {
		id: string;
		name: string;
		type: string;
		icon: string | null;
		imageUrl: string | null;
	};
}
