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
import {
	itemsCollection,
	metaCollection,
	stagedItemBaselineCollection,
	stagedItemsCollection,
	stagedVaultBaselineCollection,
	stagedVaultsCollection,
	vaultsCollection,
} from "./keys";
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
export const ITEM_CACHE_STATE_VERSION = 2 as const;

/** Schema version of the cache pointer a native host reads from the metadata record. */
export const ITEM_CACHE_NATIVE_VIEW_VERSION = 1 as const;

/**
 * The only cache state a native host consumes. Prefixes are fully resolved here so the
 * host follows the promoted generation without knowing how collections are named.
 */
export interface ItemCacheNativeView {
	v: typeof ITEM_CACHE_NATIVE_VIEW_VERSION;
	itemsKeyPrefix: string;
	vaultsKeyPrefix: string;
}

/**
 * The published shape of the `meta` record. `AccountStore` gives the native host a ref to
 * this record, whose `nativeView` points it at the active item and vault collections.
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
	activeGeneration: string | null;
	nativeView: ItemCacheNativeView;
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
	/** Returns false when the active cache already has a newer version of this item. */
	upsertCachedItem(
		item: CachedEncryptedItem,
		accountId: string,
	): Promise<boolean>;
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

	/** Creates an unreachable write generation for a full bootstrap. */
	beginStagedGeneration(accountId: string): Promise<ItemCacheStagingGeneration>;

	/** Wipes items, vaults and metadata **for this account only**. */
	clearItemCache(accountId: string): Promise<void>;
}

export interface ItemCacheStagingGeneration {
	upsertCachedItem(item: CachedEncryptedItem): Promise<boolean>;
	upsertCachedVault(vault: CachedVaultMetadata): Promise<void>;
	/** Atomically makes this complete generation visible to cache readers. */
	promote(metadata: Omit<ItemCacheMetadata, "itemCount">): Promise<void>;
	/** Discards an unpublished generation after a failed bootstrap. */
	discard(): Promise<void>;
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

// ============================================================================
// Factory
// ============================================================================

export function createItemCache(options: ItemCacheOptions): ItemCache {
	const { port } = options;
	const accountLocks = new Map<string, Promise<void>>();
	let nextGeneration = 0;

	async function withAccountLock<T>(
		accountId: string,
		operation: () => Promise<T>,
	): Promise<T> {
		const previous = accountLocks.get(accountId) ?? Promise.resolve();
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const pending = previous.then(() => gate);
		accountLocks.set(accountId, pending);
		await previous;

		try {
			return await operation();
		} finally {
			release?.();
			if (accountLocks.get(accountId) === pending) {
				accountLocks.delete(accountId);
			}
		}
	}

	function createGenerationId(): string {
		nextGeneration += 1;
		return `${Date.now().toString(36)}-${nextGeneration.toString(36)}-${Math.random()
			.toString(36)
			.slice(2)}`;
	}

	function itemCollectionFor(
		accountId: string,
		generation: string | null,
	): string {
		return generation
			? stagedItemsCollection(accountId, generation)
			: itemsCollection(accountId);
	}

	function vaultCollectionFor(
		accountId: string,
		generation: string | null,
	): string {
		return generation
			? stagedVaultsCollection(accountId, generation)
			: vaultsCollection(accountId);
	}

	function nativeViewFor(
		accountId: string,
		generation: string | null,
	): ItemCacheNativeView {
		return {
			v: ITEM_CACHE_NATIVE_VIEW_VERSION,
			itemsKeyPrefix: `${port.recordKeyPrefix}${itemCollectionFor(accountId, generation)}:`,
			vaultsKeyPrefix: `${port.recordKeyPrefix}${vaultCollectionFor(accountId, generation)}:`,
		};
	}

	function coldState(accountId: string): ItemCacheStateDocument {
		return {
			v: ITEM_CACHE_STATE_VERSION,
			itemsPrimed: false,
			vaultsPrimed: false,
			metadata: null,
			activeGeneration: null,
			nativeView: nativeViewFor(accountId, null),
		};
	}

	// ------------------------------------------------------------------
	// The meta record — the one place cold-vs-empty and metadata are tracked
	// ------------------------------------------------------------------

	async function readState(accountId: string): Promise<ItemCacheStateDocument> {
		const raw = await port.recordGet(metaCollection(accountId), META_RECORD_ID);
		if (raw === null) {
			return coldState(accountId);
		}

		const parsed = parseRecord<Partial<ItemCacheStateDocument>>(
			{ id: META_RECORD_ID, value: raw },
			"metadata",
		);
		if (parsed === null) {
			// A corrupt state record demotes the account to cold: the caller re-syncs.
			return coldState(accountId);
		}

		const activeGeneration =
			typeof parsed.activeGeneration === "string"
				? parsed.activeGeneration
				: null;

		return {
			v: ITEM_CACHE_STATE_VERSION,
			itemsPrimed: parsed.itemsPrimed === true,
			vaultsPrimed: parsed.vaultsPrimed === true,
			metadata: parsed.metadata ?? null,
			activeGeneration,
			nativeView: nativeViewFor(accountId, activeGeneration),
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
		collection: string,
		values: T[],
	): Promise<void> {
		await port.recordClear(collection);
		for (const value of values) {
			await port.recordPut(collection, value.id, JSON.stringify(value));
		}
	}

	async function writeNewerItem(
		collection: string,
		item: CachedEncryptedItem,
	): Promise<boolean> {
		const existing = await port.recordGet(collection, item.id);
		if (existing !== null) {
			const parsed = parseRecord<CachedEncryptedItem>(
				{ id: item.id, value: existing },
				"item",
			);
			if (parsed !== null && parsed.version > item.version) {
				return false;
			}
		}

		await port.recordPut(collection, item.id, JSON.stringify(item));
		return true;
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
			await withAccountLock(accountId, async () => {
				const state = await readState(accountId);
				await replaceCollection(
					itemCollectionFor(accountId, state.activeGeneration),
					items,
				);
				await prime(accountId, "items");
			});
		},

		async getCachedItems(
			accountId: string,
		): Promise<CachedEncryptedItem[] | null> {
			return withAccountLock(accountId, async () => {
				const state = await readState(accountId);
				return readCollection<CachedEncryptedItem>(
					itemCollectionFor(accountId, state.activeGeneration),
					"item",
					async () => state.itemsPrimed,
				);
			});
		},

		/** One `recordPut`. Never reads the collection. */
		async upsertCachedItem(
			item: CachedEncryptedItem,
			accountId: string,
		): Promise<boolean> {
			return withAccountLock(accountId, async () => {
				const state = await readState(accountId);
				return writeNewerItem(
					itemCollectionFor(accountId, state.activeGeneration),
					item,
				);
			});
		},

		/** One `recordDelete`. Deleting an absent item is a no-op at the port. */
		async removeCachedItem(itemId: string, accountId: string): Promise<void> {
			await withAccountLock(accountId, async () => {
				const state = await readState(accountId);
				await port.recordDelete(
					itemCollectionFor(accountId, state.activeGeneration),
					itemId,
				);
			});
		},

		// --- vaults ---

		async setCachedVaults(
			vaults: CachedVaultMetadata[],
			accountId: string,
		): Promise<void> {
			await withAccountLock(accountId, async () => {
				const state = await readState(accountId);
				await replaceCollection(
					vaultCollectionFor(accountId, state.activeGeneration),
					vaults,
				);
				await prime(accountId, "vaults");
			});
		},

		async getCachedVaults(
			accountId: string,
		): Promise<CachedVaultMetadata[] | null> {
			return withAccountLock(accountId, async () => {
				const state = await readState(accountId);
				return readCollection<CachedVaultMetadata>(
					vaultCollectionFor(accountId, state.activeGeneration),
					"vault",
					async () => state.vaultsPrimed,
				);
			});
		},

		async upsertCachedVault(
			vault: CachedVaultMetadata,
			accountId: string,
		): Promise<void> {
			await withAccountLock(accountId, async () => {
				const state = await readState(accountId);
				await port.recordPut(
					vaultCollectionFor(accountId, state.activeGeneration),
					vault.id,
					JSON.stringify(vault),
				);
			});
		},

		/**
		 * Removing a vault cascades to its items. Leaving them behind would strand items
		 * whose vault key is gone, and they would still be counted by every list read.
		 */
		async removeCachedVault(vaultId: string, accountId: string): Promise<void> {
			await withAccountLock(accountId, async () => {
				const state = await readState(accountId);
				await port.recordDelete(
					vaultCollectionFor(accountId, state.activeGeneration),
					vaultId,
				);

				const collection = itemCollectionFor(accountId, state.activeGeneration);
				for (const record of await port.recordList(collection)) {
					const item = parseRecord<CachedEncryptedItem>(record, "item");
					if (item !== null && item.vaultId === vaultId) {
						await port.recordDelete(collection, record.id);
					}
				}
			});
		},

		// --- metadata ---

		async getItemCacheMetadata(
			accountId: string,
		): Promise<ItemCacheMetadata | null> {
			return withAccountLock(
				accountId,
				async () => (await readState(accountId)).metadata,
			);
		},

		async setItemCacheMetadata(
			metadata: ItemCacheMetadata,
			accountId: string,
		): Promise<void> {
			await withAccountLock(accountId, async () => {
				const state = await readState(accountId);
				await writeState(accountId, { ...state, metadata });
			});
		},

		async beginStagedGeneration(
			accountId: string,
		): Promise<ItemCacheStagingGeneration> {
			const generation = createGenerationId();
			const items = stagedItemsCollection(accountId, generation);
			const vaults = stagedVaultsCollection(accountId, generation);
			const itemBaseline = stagedItemBaselineCollection(accountId, generation);
			const vaultBaseline = stagedVaultBaselineCollection(
				accountId,
				generation,
			);
			let settled = false;

			await withAccountLock(accountId, async () => {
				const state = await readState(accountId);
				const activeItems = await port.recordList(
					itemCollectionFor(accountId, state.activeGeneration),
				);
				const activeVaults = await port.recordList(
					vaultCollectionFor(accountId, state.activeGeneration),
				);
				await Promise.all([
					port.recordClear(items),
					port.recordClear(vaults),
					port.recordClear(itemBaseline),
					port.recordClear(vaultBaseline),
				]);
				for (const record of activeItems) {
					await port.recordPut(itemBaseline, record.id, record.value);
				}
				for (const record of activeVaults) {
					await port.recordPut(vaultBaseline, record.id, record.value);
				}
			});

			function assertPending(): void {
				if (settled) {
					throw new Error(
						"Item cache staging generation is no longer writable.",
					);
				}
			}

			return {
				async upsertCachedItem(item: CachedEncryptedItem): Promise<boolean> {
					assertPending();
					return writeNewerItem(items, item);
				},
				async upsertCachedVault(vault: CachedVaultMetadata): Promise<void> {
					assertPending();
					await port.recordPut(vaults, vault.id, JSON.stringify(vault));
				},
				async promote(
					metadata: Omit<ItemCacheMetadata, "itemCount">,
				): Promise<void> {
					assertPending();
					await withAccountLock(accountId, async () => {
						const previous = await readState(accountId);
						const previousItems = itemCollectionFor(
							accountId,
							previous.activeGeneration,
						);
						const previousVaults = vaultCollectionFor(
							accountId,
							previous.activeGeneration,
						);

						for (const record of await port.recordList(itemBaseline)) {
							if ((await port.recordGet(previousItems, record.id)) === null) {
								await port.recordDelete(items, record.id);
							}
						}

						for (const record of await port.recordList(previousItems)) {
							const baseline = await port.recordGet(itemBaseline, record.id);
							const staged = await port.recordGet(items, record.id);
							const activeItem = parseRecord<CachedEncryptedItem>(
								record,
								"item",
							);
							const stagedItem =
								staged === null
									? null
									: parseRecord<CachedEncryptedItem>(
											{ id: record.id, value: staged },
											"item",
										);
							if (
								activeItem !== null &&
								(baseline !== record.value ||
									(stagedItem !== null &&
										activeItem.version > stagedItem.version))
							) {
								await port.recordPut(items, record.id, record.value);
							}
						}

						const deletedVaultIds = new Set<string>();
						for (const record of await port.recordList(vaultBaseline)) {
							if ((await port.recordGet(previousVaults, record.id)) === null) {
								deletedVaultIds.add(record.id);
								await port.recordDelete(vaults, record.id);
							}
						}
						if (deletedVaultIds.size > 0) {
							for (const record of await port.recordList(items)) {
								const stagedItem = parseRecord<CachedEncryptedItem>(
									record,
									"item",
								);
								if (
									stagedItem !== null &&
									deletedVaultIds.has(stagedItem.vaultId)
								) {
									await port.recordDelete(items, record.id);
								}
							}
						}

						for (const record of await port.recordList(previousVaults)) {
							const baseline = await port.recordGet(vaultBaseline, record.id);
							if (baseline !== record.value) {
								await port.recordPut(vaults, record.id, record.value);
							}
						}

						const itemCount = (await port.recordList(items)).length;
						await writeState(accountId, {
							v: ITEM_CACHE_STATE_VERSION,
							itemsPrimed: true,
							vaultsPrimed: true,
							metadata: { ...metadata, itemCount },
							activeGeneration: generation,
							nativeView: nativeViewFor(accountId, generation),
						});
						settled = true;

						if (previous.activeGeneration !== null) {
							await Promise.all([
								port.recordClear(previousItems),
								port.recordClear(previousVaults),
							]);
						}
						await Promise.all([
							port.recordClear(itemBaseline),
							port.recordClear(vaultBaseline),
						]);
					});
				},
				async discard(): Promise<void> {
					if (settled) {
						return;
					}
					settled = true;
					await Promise.all([
						port.recordClear(items),
						port.recordClear(vaults),
						port.recordClear(itemBaseline),
						port.recordClear(vaultBaseline),
					]);
				},
			};
		},

		/**
		 * Dropping the meta record returns the account to cold, which is correct: nothing is
		 * cached, so the next read must say "never synced" rather than "empty".
		 */
		async clearItemCache(accountId: string): Promise<void> {
			await withAccountLock(accountId, async () => {
				const state = await readState(accountId);
				await Promise.all([
					port.recordClear(itemsCollection(accountId)),
					port.recordClear(vaultsCollection(accountId)),
					port.recordClear(
						itemCollectionFor(accountId, state.activeGeneration),
					),
					port.recordClear(
						vaultCollectionFor(accountId, state.activeGeneration),
					),
					port.recordClear(metaCollection(accountId)),
				]);
			});
		},
	};

	return cache;
}
