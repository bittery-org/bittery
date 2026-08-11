/**
 * Shared crypto types for Bittery
 *
 * These types are used across all platforms (web, desktop, mobile, extension)
 * for consistent interfaces when working with crypto operations.
 *
 * The Item shapes here are the one exception to "hand-written": they derive from the
 * generated API contract, so the server owns the field list and a new server field fails
 * to compile rather than going quietly missing. See {@link CachedEncryptedItem}.
 */

import type { Attachment, ItemPayload } from "@bittery/api-contract";

/**
 * The generated contract is emitted `--immutable`, but a cached record is a local working
 * copy that projections rebuild in place. Only the `readonly` is dropped; the mapping stays
 * homomorphic, so a field added to the contract still shows up here.
 */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

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
 * Login KDF profile provided by the server and pinned locally.
 */
export type KdfAlgorithm = "pbkdf2-sha256";

export interface KdfProfile {
	schemaVersion: 1;
	algorithm: KdfAlgorithm;
	iterations: number;
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
	kdfParams: KdfProfile;
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

// ============================================================================
// Item Cache Types
// ============================================================================

/**
 * Which account a locally stored record belongs to. Not on the wire — a server answers for
 * one account at a time, so only a device holding several has to say which. Every key is
 * optional because the call sites genuinely differ: a bootstrap knows all three, an
 * outbound acknowledgement knows the account but not its server.
 */
export interface CachedItemAccountScope {
	accountId?: string;
	accountEmail?: string;
	serverUrl?: string;
}

/**
 * Cached encrypted item for local-first storage.
 * Stores the encrypted form (safe at rest, requires vault key to decrypt).
 *
 * The item's own fields are **the server's**, not this package's: {@link ItemPayload} is
 * the generated `ItemResponseDto`. Adding a field to the Rust item shape therefore
 * regenerates the contract and fails to compile in `@bittery/shared/item-mapping` — the
 * only place a record of this shape is built — instead of being silently dropped by every
 * cache on every device. Everything added on top of {@link ItemPayload} here is local:
 * the account scope, and attachments in their cached (mutable, non-null) spelling.
 */
export type CachedEncryptedItem = Mutable<ItemPayload> &
	CachedItemAccountScope & {
		/** Attachment metadata cached alongside the item */
		attachments?: CachedAttachment[];
	};

/**
 * Cached vault metadata for local-first storage
 */
export interface CachedVaultMetadata {
	id: string;
	accountId?: string;
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
	/** Cache promotion and its catch-up baseline must become durable together. */
	syncBaseline?: {
		serverUrl: string;
		cursorId: string | null;
	};
}

/**
 * Cached attachment metadata for local-first storage.
 * Stores the encrypted form (requires vault key to decrypt name/content-type).
 *
 * Server-owned for the same reason {@link CachedEncryptedItem} is: `Attachment` is the
 * generated `VaultAttachmentResponse`.
 */
export type CachedAttachment = Mutable<Attachment>;

export type ItemSyncCommandType =
	| "create"
	| "update"
	| "delete"
	| "permanent_delete"
	| "restore"
	| "move"
	| "cross_account_move"
	| "toggle_favorite";

export type ItemSyncCommandStatus =
	| "staged"
	| "applying"
	| "pending"
	| "retrying"
	| "conflicted"
	| "failed";

export interface ItemSyncEncryptedPayload {
	encryptedData: string;
	encryptionIv: string;
	encryptionAlgorithm: string;
	encryptionVersion: number;
	encryptedByUserId: string;
}

/** A durable semantic Item operation. HTTP attempts are replaceable; this identity is not. */
export interface ItemSyncCommand {
	accountId: string;
	accountEmail?: string;
	id: string;
	operationId?: string;
	attemptId?: string;
	type: ItemSyncCommandType;
	entityId: string;
	vaultId: string;
	targetVaultId?: string;
	targetAccountId?: string;
	targetAccountEmail?: string;
	targetItemId?: string;
	category?: string;
	encryptedPayload?: ItemSyncEncryptedPayload;
	favorite?: boolean;
	baseVersion: number;
	timestamp: number;
	retryCount: number;
	status?: ItemSyncCommandStatus;
	lastError?: string;
	nextAttemptAt?: number;
	conflictCopyId?: string;
	projectionClaimId?: string;
	projectionClaimExpiresAt?: number;
}

export interface ItemSyncAcknowledgement {
	entityId: string;
	etag: string | null;
	version: number | undefined;
}

export interface ItemSyncReconciler {
	apply(command: ItemSyncCommand): Promise<void>;
	executeSemanticCommand?(
		command: ItemSyncCommand,
	): Promise<ItemSyncAcknowledgement | undefined>;
	discardAcknowledgedElsewhere?(command: ItemSyncCommand): Promise<void>;
	preserveConflict?(
		command: ItemSyncCommand,
	): Promise<ItemSyncCommand | undefined>;
	reconcileAuthoritative?(
		command: ItemSyncCommand,
		item: CachedEncryptedItem,
	): Promise<void>;
	acknowledge(
		command: ItemSyncCommand,
		acknowledgement: ItemSyncAcknowledgement,
	): Promise<void>;
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
	invalidateShare(itemId: string): Promise<void>;
	invalidateVaultMembers(vaultId: string): Promise<void>;
}

export interface IPendingMutationQueue {
	enqueue(
		mutation: ItemSyncCommand,
		applyOptimistic?: () => Promise<void>,
	): Promise<void>;
	getPendingCount?(): number;
	hasPendingForItem?(itemId: string): boolean;
	getCommands?(accountId?: string): ItemSyncCommand[];
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
 * Raw encrypted item returned by API/query layers: a cached record minus the account scope,
 * which only a stored record carries. Stated as a subtraction rather than restated field by
 * field so the two cannot drift — both bottom out in the generated contract.
 */
export type RawEncryptedItem = Omit<
	CachedEncryptedItem,
	keyof CachedItemAccountScope
>;

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
