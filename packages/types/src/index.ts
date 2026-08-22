/**
 * Local-first application vocabulary: what a device caches, what it still owes a server,
 * and the platform seams the shared hooks talk through.
 *
 * Crypto-seam records — `EncryptedData`, `EncryptionContext`, `KdfProfile`, the SRP and
 * rotation shapes — are NOT here. They are the TypeScript spelling of Rust `uniffi::Record`s
 * and live in `@bittery/crypto-port`, next to the port that marshals them and the drift
 * guard that pins them to the generated bindings.
 *
 * The Item shapes here are the one exception to "hand-written": they derive from the
 * generated API contract, so the server owns the field list and a new server field fails
 * to compile rather than going quietly missing. See {@link CachedEncryptedItem}.
 */

import type {
	Attachment,
	AuthVaultKey,
	CreateItemOperationOutcome,
	ItemCategory,
	ItemPayload,
	VaultType,
} from "@bittery/api-contract";

export type CreateItemRejectionCode = Extract<
	CreateItemOperationOutcome["result"],
	{ status: "rejected" }
>["code"];

export interface OptimisticItemFailure {
	operationId: string;
	code: CreateItemRejectionCode;
}

/**
 * The generated contract is emitted `--immutable`, but a cached record is a local working
 * copy that projections rebuild in place. Only the `readonly` is dropped; the mapping stays
 * homomorphic, so a field added to the contract still shows up here.
 */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

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
		/** A retained semantic rejection; ciphertext stays available for later recovery UI. */
		optimisticFailure?: OptimisticItemFailure;
	};

/**
 * The vault as anything downstream of the wire knows it: the display fields, with the
 * server's `vaultType` under its local name `type` and its nullable strings already
 * decided. The one definition — `@bittery/shared`'s `VaultSummary`, `@bittery/core`'s
 * `VaultView`, the `vault` sub-object of a raw item and {@link CachedVaultMetadata} are
 * all this, and were four hand-written copies of it before ADR 0012.
 *
 * `type` is the generated {@link VaultType}, so a new vault kind server-side fails to
 * compile in the decoder rather than arriving as an unhandled string.
 */
export interface VaultSummary {
	id: string;
	name: string;
	type: VaultType;
	icon: string | null;
	imageUrl: string | null;
}

/**
 * Cached vault metadata for local-first storage: a {@link VaultSummary} plus the account
 * it belongs to, which only a device holding several accounts has to say.
 */
export interface CachedVaultMetadata
	extends VaultSummary,
		CachedItemAccountScope {}

/**
 * A vault key as a device holds it: which vault, how to display it, the wrapped key, and
 * the holder's role.
 *
 * **This is the one definition.** `@bittery/storage`'s `VaultKeyData`, `@bittery/sync`'s
 * `SyncVaultKeyEntry` and `@bittery/shared/vault-mapping`'s `VaultKeyEntry` are all aliases
 * of it. It lives here rather than in any of those because `packages/sync` deliberately does
 * not depend on `packages/storage` (ADR 0012 names that constraint), and this leaf package
 * is the one both already depend on.
 *
 * Derived from the generated `AuthVaultKeyResponse` rather than restated, for the same
 * reason {@link CachedEncryptedItem} derives from `ItemResponseDto`: `vaultType` and `role`
 * are closed sets owned by `apps/server/src/db/enums.rs`, and a field the server renames must
 * fail to compile in the mappers instead of going quietly missing from every device's key
 * store. Only `readonly` is dropped — a stored key entry is a local working copy.
 */
export type VaultKeyEntry = Mutable<AuthVaultKey>;

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
	targetItemId?: string;
	/**
	 * Only a `create` carries one, and it is the value the server will be asked to store —
	 * so it is the generated {@link ItemCategory}, not a free string. `POST /items` rejects
	 * anything else.
	 */
	category?: ItemCategory;
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
	reject?(
		command: ItemSyncCommand,
		code: CreateItemRejectionCode,
	): Promise<void>;
	acknowledge(
		command: ItemSyncCommand,
		acknowledgement: ItemSyncAcknowledgement,
	): Promise<void>;
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
	vault: VaultSummary;
}
