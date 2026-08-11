/**
 * The one place an Item crosses between its three shapes.
 *
 * An Item exists as a **wire payload** (what the server returns), a **cached record**
 * (`CachedEncryptedItem`, what a device persists) and a **raw item** (`RawEncryptedItem`,
 * what query layers hand to the decrypt path). Before this module every crossing was a
 * hand-typed 14-field object literal — fifteen of them across `core`, `sync` and the two
 * apps — and they had already drifted: some dropped `deletedAt`, some shared attachment
 * objects with the response they came from, one wrote `attachments` as `[]` where the
 * others left it absent.
 *
 * None of those shapes lists its fields any more. All three bottom out in the generated
 * `ItemPayload`, so the server owns the field list and adding one to it fails to compile
 * here — in the four constructors and the drift guards at the foot of the file — rather
 * than going quietly missing from every cache. Only what the wire does *not* carry is
 * written out by hand: the account scope, and attachments in their cached spelling.
 *
 * Two naming rules are load-bearing and are enforced by keeping the renames here:
 *
 * - A **stored record** spells its ciphertext `encryptedData` / `encryptionIv` /
 *   `encryptionAlgorithm`. An `EncryptedData` fresh out of the crypto port spells the same
 *   three `ciphertext` / `iv` / `algorithm`. That distinction is what tells a reader whether
 *   a value has been through the store, so nothing here collapses it — {@link toEncryptedPayload}
 *   is the single rename.
 * - `encryptionVersion` and `encryptedByUserId` are the **AAD binding**, `version` is
 *   **optimistic concurrency** and `lastModifiedBy` is **audit**. They coincide on a fresh
 *   write and diverge as soon as the server advances a revision without re-sealing (favourite,
 *   trash, restore, key rotation), so no mapper here derives one from another: a caller that
 *   knows they coincide states it.
 */

import type {
	Attachment,
	DeletedVaultItem,
	ItemPayload,
	SyncBootstrapItem,
	VaultItem,
	VaultItemDetails,
} from "@bittery/api-contract";
import type {
	CachedAttachment,
	CachedEncryptedItem,
	CachedItemAccountScope,
	ItemSyncEncryptedPayload,
	RawEncryptedItem,
	RawEncryptedItemWithVault,
} from "@bittery/types";
import type { DecryptedItemData } from "./types";

// ============================================================================
// The shapes this module maps between
// ============================================================================

/** Attachment metadata as any server payload carries it. */
export type ServerItemAttachment = Attachment;

/**
 * The wire shape shared by every server Item payload — `items.get`, `items.listInVault`,
 * `items.listTrashed` and `sync.bootstrap`.
 *
 * The item's own fields are the contract's {@link ItemPayload} verbatim, so a field added
 * server-side arrives here without anyone retyping it. Only `attachments` is widened, and
 * only because the four endpoints genuinely disagree about it: the details and bootstrap
 * payloads always send it, the vault listing sends it optionally and nullably, the trash
 * listing omits it entirely. A mapper reading it has to cope with all four. The assertions
 * at the foot of this file check that in both directions.
 */
export type ServerEncryptedItem = ItemPayload & {
	readonly attachments?: readonly ServerItemAttachment[] | null;
};

/**
 * The half of a cached record that re-sealing an item leaves alone. Split out because a
 * caller that is *replacing* the ciphertext has no business reading the old one — see
 * {@link withEncryptedPayload}.
 */
export type CachedItemMetadata = Omit<
	CachedEncryptedItem,
	| "encryptedData"
	| "encryptionIv"
	| "encryptionAlgorithm"
	| "version"
	| "lastModifiedBy"
	| "encryptionVersion"
	| "encryptedByUserId"
	| "updatedAt"
>;

/**
 * {@link CachedItemMetadata} as a repository item carries it — the same fields, since a
 * repository record is a cached record with the ciphertext swapped for its plaintext.
 */
export type RepositoryItemMetadata = CachedItemMetadata;

/**
 * A decrypted item as a repository holds it: the plaintext fields plus the ciphertext it
 * came from, which it spells `_encrypted`. Structural so `@bittery/core`'s
 * `VaultRepositoryItem` fits without this package depending on it, but derived from the
 * cached record so a new server field has to reach the repository too.
 */
export type RepositoryItemRecord = Omit<
	CachedEncryptedItem,
	"encryptedData" | "encryptionIv" | "encryptionAlgorithm"
> & {
	_encrypted: { data: string; iv: string; algorithm: string };
};

/** Which account a cached record belongs to — see {@link CachedItemAccountScope}. */
export type CachedItemScope = CachedItemAccountScope;

/** The ciphertext triple as the crypto port returns it, before the store's naming. */
export interface EncryptedItemPayload {
	ciphertext: string;
	iv: string;
	algorithm: string;
	encryptionVersion: number;
	encryptedByUserId: string;
}

/** The vault sub-object a raw item carries. */
export type ItemVaultSummary = RawEncryptedItemWithVault["vault"];

/** Shown when an item names a vault this device has no metadata for. */
const UNKNOWN_VAULT_NAME = "Unknown Vault";

// ============================================================================
// Wire → cache
// ============================================================================

/**
 * A fresh, mutable attachment record. Wire payloads hand back readonly arrays of objects
 * the response still owns, so every attachment is copied rather than aliased.
 */
export function toCachedAttachment(
	attachment: ServerItemAttachment,
): CachedAttachment {
	return { ...attachment };
}

/** Decode any server Item payload into the record a device persists. */
export function toCachedItem(
	item: ServerEncryptedItem,
	scope: CachedItemScope,
): CachedEncryptedItem {
	return {
		id: item.id,
		vaultId: item.vaultId,
		...scope,
		category: item.category,
		favorite: item.favorite,
		encryptedData: item.encryptedData,
		encryptionIv: item.encryptionIv,
		encryptionAlgorithm: item.encryptionAlgorithm,
		version: item.version,
		lastModifiedBy: item.lastModifiedBy,
		encryptionVersion: item.encryptionVersion,
		encryptedByUserId: item.encryptedByUserId,
		createdAt: item.createdAt,
		updatedAt: item.updatedAt,
		// Only `deletedAt` is normalised: three of the four endpoints leave it off a live
		// item, and the cache stores one answer for "not trashed".
		deletedAt: item.deletedAt ?? null,
		attachments: item.attachments?.map(toCachedAttachment),
	};
}

/**
 * Project the untouched half of a repository item onto its cached record. `scope` supplies
 * the account only where the item does not already name one.
 */
export function toCachedItemMetadata(
	item: RepositoryItemMetadata,
	scope: CachedItemScope,
): CachedItemMetadata {
	return {
		id: item.id,
		vaultId: item.vaultId,
		accountId: item.accountId ?? scope.accountId,
		accountEmail: item.accountEmail ?? scope.accountEmail,
		serverUrl: item.serverUrl ?? scope.serverUrl,
		category: item.category,
		favorite: item.favorite,
		createdAt: item.createdAt,
		deletedAt: item.deletedAt,
		attachments: item.attachments,
	};
}

/** Project a decrypted repository item, ciphertext and all, back onto its cached record. */
export function toCachedItemFromRepositoryItem(
	item: RepositoryItemRecord,
	scope: CachedItemScope,
): CachedEncryptedItem {
	return {
		...toCachedItemMetadata(item, scope),
		encryptedData: item._encrypted.data,
		encryptionIv: item._encrypted.iv,
		encryptionAlgorithm: item._encrypted.algorithm,
		version: item.version,
		lastModifiedBy: item.lastModifiedBy,
		encryptionVersion: item.encryptionVersion,
		encryptedByUserId: item.encryptedByUserId,
		updatedAt: item.updatedAt,
	};
}

/** An Item this device just minted, before any server has seen it. */
export interface NewCachedItemInput {
	id: string;
	vaultId: string;
	category: string;
	/** Written to both `createdAt` and `updatedAt`: a fresh record has no history. */
	timestamp: string;
	/**
	 * The optimistic-concurrency revision this record projects to. Stated rather than read
	 * off `payload.encryptionVersion`, which is the AAD binding and only coincides by
	 * construction — see the module note.
	 */
	version: number;
	/** Defaults to `false`; nothing can favourite an item before it exists. */
	favorite?: boolean;
	payload: ItemSyncEncryptedPayload;
}

/** Build the cached record for a locally-created Item. */
export function toNewCachedItem(
	input: NewCachedItemInput,
	scope: CachedItemScope,
): CachedEncryptedItem {
	return {
		id: input.id,
		vaultId: input.vaultId,
		...scope,
		category: input.category,
		favorite: input.favorite ?? false,
		encryptedData: input.payload.encryptedData,
		encryptionIv: input.payload.encryptionIv,
		encryptionAlgorithm: input.payload.encryptionAlgorithm,
		version: input.version,
		lastModifiedBy: input.payload.encryptedByUserId,
		encryptionVersion: input.payload.encryptionVersion,
		encryptedByUserId: input.payload.encryptedByUserId,
		createdAt: input.timestamp,
		updatedAt: input.timestamp,
		deletedAt: null,
	};
}

export interface ResealedItemChanges {
	updatedAt: string;
	/** See {@link NewCachedItemInput.version} — stated, never derived. */
	version: number;
	/** Only a move changes it. */
	vaultId?: string;
}

/**
 * Replace a cached record's ciphertext with a newly sealed one, carrying the binding and
 * the audit field the new seal establishes. Everything else — favourite, trash state,
 * attachments, `createdAt` — is the record's and is left alone.
 *
 * `base` is only the {@link CachedItemMetadata} half on purpose: a caller re-sealing an
 * item must not have to produce the ciphertext it is about to overwrite.
 */
export function withEncryptedPayload(
	base: CachedItemMetadata,
	payload: ItemSyncEncryptedPayload,
	changes: ResealedItemChanges,
): CachedEncryptedItem {
	return {
		...base,
		vaultId: changes.vaultId ?? base.vaultId,
		encryptedData: payload.encryptedData,
		encryptionIv: payload.encryptionIv,
		encryptionAlgorithm: payload.encryptionAlgorithm,
		version: changes.version,
		lastModifiedBy: payload.encryptedByUserId,
		encryptionVersion: payload.encryptionVersion,
		encryptedByUserId: payload.encryptedByUserId,
		updatedAt: changes.updatedAt,
	};
}

// ============================================================================
// Cache → raw
// ============================================================================

/** The vault sub-object, with the placeholder used when this device has no metadata for it. */
export function toItemVaultSummary(
	vault: Partial<ItemVaultSummary> | null | undefined,
	vaultId: string,
): ItemVaultSummary {
	return {
		id: vault?.id ?? vaultId,
		name: vault?.name ?? UNKNOWN_VAULT_NAME,
		type: vault?.type ?? "personal",
		icon: vault?.icon ?? null,
		imageUrl: vault?.imageUrl ?? null,
	};
}

/**
 * A cached record read back as a raw item. The one field the wire leaves optional is always
 * present, because the cache has already decided it.
 */
export type RawItemFromCache = RawEncryptedItem & {
	deletedAt: string | null;
};

/** Read a cached record back as the raw item the decrypt path consumes. */
export function toRawItem(cached: CachedEncryptedItem): RawItemFromCache;
export function toRawItem(
	cached: CachedEncryptedItem,
	vault: Partial<ItemVaultSummary> | null | undefined,
): RawItemFromCache & RawEncryptedItemWithVault;
export function toRawItem(
	cached: CachedEncryptedItem,
	...vault: [Partial<ItemVaultSummary> | null | undefined] | []
): RawItemFromCache | (RawItemFromCache & RawEncryptedItemWithVault) {
	const raw: RawItemFromCache = {
		id: cached.id,
		vaultId: cached.vaultId,
		category: cached.category,
		favorite: cached.favorite,
		encryptedData: cached.encryptedData,
		encryptionIv: cached.encryptionIv,
		encryptionAlgorithm: cached.encryptionAlgorithm,
		version: cached.version,
		lastModifiedBy: cached.lastModifiedBy,
		encryptionVersion: cached.encryptionVersion,
		encryptedByUserId: cached.encryptedByUserId,
		createdAt: cached.createdAt,
		updatedAt: cached.updatedAt,
		deletedAt: cached.deletedAt ?? null,
		attachments: cached.attachments,
	};
	if (vault.length === 0) {
		return raw;
	}
	return { ...raw, vault: toItemVaultSummary(vault[0], cached.vaultId) };
}

// ============================================================================
// Payload and plaintext
// ============================================================================

/**
 * Rename a freshly sealed `EncryptedData` into the stored spelling. The only place that
 * rename happens, so a sync command and a cache record can never disagree about it.
 */
export function toEncryptedPayload(
	payload: EncryptedItemPayload,
): ItemSyncEncryptedPayload {
	return {
		encryptedData: payload.ciphertext,
		encryptionIv: payload.iv,
		encryptionAlgorithm: payload.algorithm,
		encryptionVersion: payload.encryptionVersion,
		encryptedByUserId: payload.encryptedByUserId,
	};
}

/**
 * Every key that is item *metadata* rather than item *content*. Anything not on this list
 * is sealed into the ciphertext, so an addition here is a privacy decision: a field left
 * off leaks into the encrypted payload of every conflict copy and every re-encrypt.
 */
const ITEM_METADATA_KEYS = [
	"id",
	"vaultId",
	"category",
	"favorite",
	"createdAt",
	"updatedAt",
	"deletedAt",
	"version",
	"lastModifiedBy",
	"encryptionVersion",
	"encryptedByUserId",
	"attachments",
	"accountEmail",
	"accountId",
	"serverUrl",
	"_encrypted",
	"vault",
	"account",
] as const;

/** Strip an item down to the payload that gets encrypted. */
export function stripToDecryptedData(item: unknown): DecryptedItemData {
	const data = { ...(item as Record<string, unknown>) };
	for (const key of ITEM_METADATA_KEYS) {
		delete data[key];
	}
	return data as unknown as DecryptedItemData;
}

// ============================================================================
// Drift guards
// ============================================================================
//
// Schema drift fails type checks here rather than silently corrupting a cache write.
// The item fields themselves cannot drift any more — every shape above bottoms out in
// `ItemPayload` — so these guards cover what derivation alone does not:
//
//   1. that each of the four endpoint payloads still carries the whole canonical set, and
//   2. that neither an endpoint nor `ItemPayload` has grown a field nothing here handles.
//
// (2) is the one that matters. A *required* new field breaks the four constructors above
// on its own, because each writes a full object literal; an *optional* one would not, and
// would instead be sealed into the ciphertext by `stripToDecryptedData` as if it were
// user content.

/** Errors as "Type 'x' does not satisfy the constraint 'never'", naming the stray field. */
type NoUnhandledField<T extends never> = T;

/** Endpoint-specific keys `ServerEncryptedItem` deliberately drops. */
type EndpointOnlyItemKey = "vault";

/**
 * The ciphertext triple is item *content*, not metadata, so it is absent from
 * {@link ITEM_METADATA_KEYS}: that list is applied to decrypted records, which spell the
 * same three `_encrypted`.
 */
type ItemCiphertextKey =
	| "encryptedData"
	| "encryptionIv"
	| "encryptionAlgorithm";

/** (1) Every endpoint payload still carries the whole canonical set, attachments included. */
const _detailsMatchServer = (item: VaultItemDetails): ServerEncryptedItem =>
	item;
const _listEntryMatchesServer = (item: VaultItem): ServerEncryptedItem => item;
const _trashedMatchesServer = (item: DeletedVaultItem): ServerEncryptedItem =>
	item;
const _bootstrapMatchesServer = (
	item: SyncBootstrapItem,
): ServerEncryptedItem => item;

void _detailsMatchServer;
void _listEntryMatchesServer;
void _trashedMatchesServer;
void _bootstrapMatchesServer;

/** (2) Nothing has grown a field this module fails to place. Parameters are `never`. */
const _noUnhandledField = (
	vaultItemDetails: NoUnhandledField<
		Exclude<keyof VaultItemDetails, keyof ServerEncryptedItem>
	>,
	vaultItem: NoUnhandledField<
		Exclude<keyof VaultItem, keyof ServerEncryptedItem | EndpointOnlyItemKey>
	>,
	deletedVaultItem: NoUnhandledField<
		Exclude<
			keyof DeletedVaultItem,
			keyof ServerEncryptedItem | EndpointOnlyItemKey
		>
	>,
	syncBootstrapItem: NoUnhandledField<
		Exclude<
			keyof SyncBootstrapItem,
			keyof ServerEncryptedItem | EndpointOnlyItemKey
		>
	>,
	itemPayloadClassification: NoUnhandledField<
		Exclude<
			keyof ItemPayload,
			ItemCiphertextKey | (typeof ITEM_METADATA_KEYS)[number]
		>
	>,
) => [
	vaultItemDetails,
	vaultItem,
	deletedVaultItem,
	syncBootstrapItem,
	itemPayloadClassification,
];

void _noUnhandledField;
