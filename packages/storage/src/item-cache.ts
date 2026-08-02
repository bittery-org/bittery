/**
 * `ItemCache` — the deep module above the record seam.
 *
 * Three rules make this reviewable:
 *
 *   1. **Zero optional members.** Every method is total, so callers never need `?.` guards.
 *   2. **`upsertCachedItem` / `removeCachedItem` are O(1)** — exactly one `recordPut` /
 *      `recordDelete` each. That is the whole reason the record seam has per-record
 *      primitives; `vault-repository.ts` upserts one item at a time on delta sync.
 *   3. **All JSON lives here.** The port only ever sees strings, and never parses them.
 *
 * A record whose JSON fails to parse is skipped, never thrown. This store holds disposable
 * encrypted blobs: a corrupt entry costs a re-sync, and must never brick startup.
 */

import type {
	CachedEncryptedItem,
	CachedVaultMetadata,
	ItemCacheMetadata,
} from "@bittery/types";
import { itemsCollection, metaCollection, vaultsCollection } from "./keys";
import type { RecordPort } from "./record-port";

// ============================================================================
// Record layout
// ============================================================================

/**
 * The single record inside `metaCollection(accountId)`. Its id is fixed, so the whole
 * collection is one record.
 */
const META_RECORD_ID = "meta";

/** Schema version of {@link ItemCacheStateDocument}. Bump when the shape changes. */
export const ITEM_CACHE_STATE_VERSION = 1 as const;

/**
 * The published shape of the `meta` record. The Rust native host reads the item and vault
 * collections by the names `AccountStore` publishes in `native_view`, so this document is
 * part of the on-disk contract too.
 *
 * `itemsPrimed` / `vaultsPrimed` are how a **cold** cache is told apart from a genuinely
 * **empty** one. `setCachedItems` / `setCachedVaults` are the only writers: a caller that has
 * synced and received nothing gets `[]`, while a caller that has never synced gets `null`.
 * A single-record upsert deliberately does NOT set these flags — that would cost a second
 * write and break the O(1) guarantee — so a non-empty collection is always treated as
 * primed regardless of the flag.
 */
export interface ItemCacheStateDocument {
	v: typeof ITEM_CACHE_STATE_VERSION;
	itemsPrimed: boolean;
	vaultsPrimed: boolean;
	metadata: ItemCacheMetadata | null;
}

// ============================================================================
// Public surface
// ============================================================================

export interface ItemCacheOptions {
	port: RecordPort;
}

export interface ItemCache {
	initialize(): Promise<void>;

	// --- items ---
	/** Replaces the whole set for the account. Not a merge. */
	setCachedItems(
		items: CachedEncryptedItem[],
		accountId: string,
	): Promise<void>;
	/** `null` means "never synced"; `[]` means "synced, and there is nothing". */
	getCachedItems(accountId: string): Promise<CachedEncryptedItem[] | null>;
	/** Exactly one `recordPut`. */
	upsertCachedItem(item: CachedEncryptedItem, accountId: string): Promise<void>;
	/** Exactly one `recordDelete`. */
	removeCachedItem(itemId: string, accountId: string): Promise<void>;

	// --- vaults ---
	/** Replaces the whole set for the account. Not a merge. */
	setCachedVaults(
		vaults: CachedVaultMetadata[],
		accountId: string,
	): Promise<void>;
	/** `null` means "never synced"; `[]` means "synced, and there is nothing". */
	getCachedVaults(accountId: string): Promise<CachedVaultMetadata[] | null>;
	upsertCachedVault(
		vault: CachedVaultMetadata,
		accountId: string,
	): Promise<void>;
	/** Also removes every cached item belonging to that vault. */
	removeCachedVault(vaultId: string, accountId: string): Promise<void>;

	// --- metadata ---
	getItemCacheMetadata(accountId: string): Promise<ItemCacheMetadata | null>;
	setItemCacheMetadata(
		metadata: ItemCacheMetadata,
		accountId: string,
	): Promise<void>;

	/** Wipes items, vaults and metadata **for this account only**. */
	clearItemCache(accountId: string): Promise<void>;
}

// ============================================================================
// Internal helpers that need no closure state
// ============================================================================

/**
 * Parse one record, or `null` if it is corrupt.
 *
 * Logging happens here so every skip is reported exactly once, with the record id, and the
 * callers stay branch-free.
 */
function parseRecord<T>(
	record: { id: string; value: string },
	kind: string,
): T | null {
	try {
		return JSON.parse(record.value) as T;
	} catch (error) {
		console.error(
			`[item-cache] skipping corrupt ${kind} record "${record.id}":`,
			error,
		);
		return null;
	}
}

function parseRecords<T>(
	records: Array<{ id: string; value: string }>,
	kind: string,
): T[] {
	const parsed: T[] = [];
	for (const record of records) {
		const value = parseRecord<T>(record, kind);
		if (value !== null) {
			parsed.push(value);
		}
	}
	return parsed;
}

function coldState(): ItemCacheStateDocument {
	return {
		v: ITEM_CACHE_STATE_VERSION,
		itemsPrimed: false,
		vaultsPrimed: false,
		metadata: null,
	};
}

// ============================================================================
// Factory
// ============================================================================

export function createItemCache(options: ItemCacheOptions): ItemCache {
	const { port } = options;

	// ------------------------------------------------------------------
	// The meta record — the one place cold-vs-empty and metadata are tracked
	// ------------------------------------------------------------------

	async function readState(accountId: string): Promise<ItemCacheStateDocument> {
		const raw = await port.recordGet(metaCollection(accountId), META_RECORD_ID);
		if (raw === null) {
			return coldState();
		}

		const parsed = parseRecord<Partial<ItemCacheStateDocument>>(
			{ id: META_RECORD_ID, value: raw },
			"metadata",
		);
		if (parsed === null) {
			// A corrupt state record demotes the account to cold: the caller re-syncs.
			return coldState();
		}

		return {
			v: ITEM_CACHE_STATE_VERSION,
			itemsPrimed: parsed.itemsPrimed === true,
			vaultsPrimed: parsed.vaultsPrimed === true,
			metadata: parsed.metadata ?? null,
		};
	}

	async function writeState(
		accountId: string,
		state: ItemCacheStateDocument,
	): Promise<void> {
		await port.recordPut(
			metaCollection(accountId),
			META_RECORD_ID,
			JSON.stringify(state),
		);
	}

	/** Record that a full set has been written, so a later empty read reports `[]`. */
	async function prime(
		accountId: string,
		which: "items" | "vaults",
	): Promise<void> {
		const state = await readState(accountId);
		if (which === "items" ? state.itemsPrimed : state.vaultsPrimed) {
			return;
		}
		await writeState(
			accountId,
			which === "items"
				? { ...state, itemsPrimed: true }
				: { ...state, vaultsPrimed: true },
		);
	}

	/**
	 * The shared read: records win when there are any, otherwise the primed flag decides
	 * between "synced but empty" (`[]`) and "never synced" (`null`).
	 *
	 * Reading records first also means a single-record `upsertCachedItem` into a cold cache
	 * is visible immediately without that upsert having to write the meta record.
	 */
	async function readCollection<T>(
		collection: string,
		kind: string,
		primed: () => Promise<boolean>,
	): Promise<T[] | null> {
		const records = await port.recordList(collection);
		if (records.length > 0) {
			return parseRecords<T>(records, kind);
		}
		return (await primed()) ? [] : null;
	}

	/** Replace the whole contents of a collection. Clear, then write, then prime. */
	async function replaceCollection<T extends { id: string }>(
		accountId: string,
		collection: string,
		values: T[],
		which: "items" | "vaults",
	): Promise<void> {
		await port.recordClear(collection);
		for (const value of values) {
			await port.recordPut(collection, value.id, JSON.stringify(value));
		}
		await prime(accountId, which);
	}

	// ==================================================================
	// The cache
	// ==================================================================

	const cache: ItemCache = {
		async initialize(): Promise<void> {
			await port.initialize();
		},

		// --- items ---

		async setCachedItems(
			items: CachedEncryptedItem[],
			accountId: string,
		): Promise<void> {
			await replaceCollection(
				accountId,
				itemsCollection(accountId),
				items,
				"items",
			);
		},

		async getCachedItems(
			accountId: string,
		): Promise<CachedEncryptedItem[] | null> {
			return readCollection<CachedEncryptedItem>(
				itemsCollection(accountId),
				"item",
				async () => (await readState(accountId)).itemsPrimed,
			);
		},

		/** One `recordPut`. Never reads the collection. */
		async upsertCachedItem(
			item: CachedEncryptedItem,
			accountId: string,
		): Promise<void> {
			await port.recordPut(
				itemsCollection(accountId),
				item.id,
				JSON.stringify(item),
			);
		},

		/** One `recordDelete`. Deleting an absent item is a no-op at the port. */
		async removeCachedItem(itemId: string, accountId: string): Promise<void> {
			await port.recordDelete(itemsCollection(accountId), itemId);
		},

		// --- vaults ---

		async setCachedVaults(
			vaults: CachedVaultMetadata[],
			accountId: string,
		): Promise<void> {
			await replaceCollection(
				accountId,
				vaultsCollection(accountId),
				vaults,
				"vaults",
			);
		},

		async getCachedVaults(
			accountId: string,
		): Promise<CachedVaultMetadata[] | null> {
			return readCollection<CachedVaultMetadata>(
				vaultsCollection(accountId),
				"vault",
				async () => (await readState(accountId)).vaultsPrimed,
			);
		},

		async upsertCachedVault(
			vault: CachedVaultMetadata,
			accountId: string,
		): Promise<void> {
			await port.recordPut(
				vaultsCollection(accountId),
				vault.id,
				JSON.stringify(vault),
			);
		},

		/**
		 * Removing a vault cascades to its items. Leaving them behind would strand items
		 * whose vault key is gone, and they would still be counted by every list read.
		 */
		async removeCachedVault(vaultId: string, accountId: string): Promise<void> {
			await port.recordDelete(vaultsCollection(accountId), vaultId);

			const collection = itemsCollection(accountId);
			for (const record of await port.recordList(collection)) {
				const item = parseRecord<CachedEncryptedItem>(record, "item");
				if (item !== null && item.vaultId === vaultId) {
					await port.recordDelete(collection, record.id);
				}
			}
		},

		// --- metadata ---

		async getItemCacheMetadata(
			accountId: string,
		): Promise<ItemCacheMetadata | null> {
			return (await readState(accountId)).metadata;
		},

		async setItemCacheMetadata(
			metadata: ItemCacheMetadata,
			accountId: string,
		): Promise<void> {
			const state = await readState(accountId);
			await writeState(accountId, { ...state, metadata });
		},

		/**
		 * Dropping the meta record returns the account to cold, which is correct: nothing is
		 * cached, so the next read must say "never synced" rather than "empty".
		 */
		async clearItemCache(accountId: string): Promise<void> {
			await port.recordClear(itemsCollection(accountId));
			await port.recordClear(vaultsCollection(accountId));
			await port.recordClear(metaCollection(accountId));
		},
	};

	return cache;
}
