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
	decrypt(
		encryptedData: EncryptedData,
		key: Uint8Array,
		context?: EncryptionContext,
	): Promise<string>;
	encrypt(
		plaintext: string,
		key: Uint8Array,
		context?: EncryptionContext,
	): Promise<EncryptedData>;
	rsaDecrypt?(ciphertext: string, privateKeyPem: string): Promise<string>;
	generateEncryptionKey(): Promise<Uint8Array>;
	deriveKeys(
		password: string,
		secretKey: string,
		email: string,
	): Promise<DerivedKeys>;
	validateServerKdfParams?(
		serverParams: KdfParams,
		pinnedParams?: KdfParams | null,
	): Promise<void> | void;
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
	generateUuid?(): string | Promise<string>;
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
	/** Encryption algorithm (always "AES-GCM-AAD-V1") */
	algorithm: string;
}

/**
 * Encryption context bound to ciphertext integrity.
 *
 * This schema is deterministic across platforms and used to prevent
 * ciphertext swapping between entities.
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

/**
 * Login KDF params provided by the server and pinned locally.
 */
export interface KdfParams {
	schemaVersion: 1;
	algorithm: "pbkdf2-sha256";
	iterations: number;
	salt: string;
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
	kdfParams: KdfParams;
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
	accountEmail?: string;
	serverUrl?: string;
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
	/** Attachment metadata cached alongside the item */
	attachments?: CachedAttachment[];
}

/**
 * Cached vault metadata for local-first storage
 */
export interface CachedVaultMetadata {
	id: string;
	accountEmail?: string;
	serverUrl?: string;
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

/**
 * Cached attachment metadata for local-first storage.
 * Stores the encrypted form (requires vault key to decrypt name/content-type).
 */
export interface CachedAttachment {
	id: string;
	itemId: string;
	vaultId: string;
	storageKey: string;
	encryptedName: string;
	encryptedContentType: string;
	encryptionIv: string;
	encryptedContentTypeIv: string | null;
	encryptionAlgorithm: string;
	fileSize: number;
	uploadedBy: string | null;
	createdAt: string;
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

export interface IPendingMutationQueue {
	enqueue(mutation: unknown): void;
	getPendingCount?(): number;
	hasPendingForItem?(itemId: string): boolean;
}

/**
 * Sync context - subset of sync state needed by shared hooks.
 */
export interface ISyncContext {
	clientId: string;
	isConnected: boolean;
	isOnline: boolean;
	invalidator: IQueryInvalidator;
	outboundQueue: IPendingMutationQueue;
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
	version?: number;
	lastModifiedBy?: string | null;
	createdAt: string | Date;
	updatedAt: string | Date;
	deletedAt?: string | Date | null;
	/** Attachment metadata loaded alongside the item */
	attachments?: CachedAttachment[];
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
