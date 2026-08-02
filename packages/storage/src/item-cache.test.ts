import { describe, expect, it } from "bun:test";
import type {
	CachedEncryptedItem,
	CachedVaultMetadata,
	ItemCacheMetadata,
} from "@bittery/types";
import { createItemCache, type ItemCache } from "./item-cache";
import { itemsCollection, metaCollection, vaultsCollection } from "./keys";
import {
	createInMemoryRecordPort,
	type InMemoryRecordPort,
} from "./testing/in-memory-port";

// ============================================================================
// Harness
// ============================================================================

interface Harness {
	cache: ItemCache;
	port: InMemoryRecordPort;
}

function makeCache(): Harness {
	const port = createInMemoryRecordPort();
	return { cache: createItemCache({ port }), port };
}

function item(
	id: string,
	vaultId: string,
	overrides?: Partial<CachedEncryptedItem>,
): CachedEncryptedItem {
	return {
		id,
		vaultId,
		category: "login",
		favorite: false,
		encryptedData: `data-${id}`,
		encryptionIv: `iv-${id}`,
		encryptionAlgorithm: "AES-GCM",
		version: 1,
		lastModifiedBy: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

function vault(id: string, name = `vault-${id}`): CachedVaultMetadata {
	return { id, name, type: "personal", icon: null, imageUrl: null };
}

function metadata(overrides?: Partial<ItemCacheMetadata>): ItemCacheMetadata {
	return {
		lastFullSyncAt: 1_700_000_000_000,
		itemCount: 2,
		cacheVersion: 1,
		...overrides,
	};
}

function ids(values: { id: string }[] | null): string[] {
	return (values ?? []).map((value) => value.id).sort();
}

// ============================================================================
// initialize
// ============================================================================

describe("ItemCache.initialize", () => {
	it("initializes the underlying record port", async () => {
		const { cache, port } = makeCache();
		await cache.initialize();
		expect(port.calls.initialize).toBe(1);
	});
});

// ============================================================================
// Cold cache vs empty cache
// ============================================================================

describe("ItemCache cold vs empty", () => {
	it("returns null for items and vaults that were never cached", async () => {
		const { cache } = makeCache();
		expect(await cache.getCachedItems("a")).toBeNull();
		expect(await cache.getCachedVaults("a")).toBeNull();
		expect(await cache.getItemCacheMetadata("a")).toBeNull();
	});

	it("returns [] once an empty set has been written", async () => {
		const { cache } = makeCache();
		await cache.setCachedItems([], "a");
		await cache.setCachedVaults([], "a");
		expect(await cache.getCachedItems("a")).toEqual([]);
		expect(await cache.getCachedVaults("a")).toEqual([]);
	});

	it("primes items and vaults independently", async () => {
		const { cache } = makeCache();
		await cache.setCachedItems([], "a");
		expect(await cache.getCachedItems("a")).toEqual([]);
		expect(await cache.getCachedVaults("a")).toBeNull();
	});

	it("stays empty rather than cold after the set is emptied again", async () => {
		const { cache } = makeCache();
		await cache.setCachedItems([item("i1", "v1")], "a");
		await cache.setCachedItems([], "a");
		expect(await cache.getCachedItems("a")).toEqual([]);
	});

	it("returns records written by upsert even while the cache is cold", async () => {
		const { cache } = makeCache();
		await cache.upsertCachedItem(item("i1", "v1"), "a");
		expect(ids(await cache.getCachedItems("a"))).toEqual(["i1"]);
		// ...and removing the only record puts it back to cold, not empty.
		await cache.removeCachedItem("i1", "a");
		expect(await cache.getCachedItems("a")).toBeNull();
	});

	it("returns to cold after clearItemCache", async () => {
		const { cache } = makeCache();
		await cache.setCachedItems([], "a");
		await cache.clearItemCache("a");
		expect(await cache.getCachedItems("a")).toBeNull();
	});
});

// ============================================================================
// Per-account isolation
// ============================================================================

describe("ItemCache per-account isolation", () => {
	it("keeps two accounts' items, vaults and metadata apart", async () => {
		const { cache } = makeCache();

		await cache.setCachedItems([item("i1", "v1")], "a");
		await cache.setCachedVaults([vault("v1")], "a");
		await cache.setItemCacheMetadata(metadata({ itemCount: 1 }), "a");

		await cache.setCachedItems([item("i2", "v2")], "b");
		await cache.setCachedVaults([vault("v2")], "b");
		await cache.setItemCacheMetadata(metadata({ itemCount: 99 }), "b");

		expect(ids(await cache.getCachedItems("a"))).toEqual(["i1"]);
		expect(ids(await cache.getCachedVaults("a"))).toEqual(["v1"]);
		expect((await cache.getItemCacheMetadata("a"))?.itemCount).toBe(1);

		expect(ids(await cache.getCachedItems("b"))).toEqual(["i2"]);
		expect(ids(await cache.getCachedVaults("b"))).toEqual(["v2"]);
		expect((await cache.getItemCacheMetadata("b"))?.itemCount).toBe(99);
	});

	it("leaves one account cold while the other is populated", async () => {
		const { cache } = makeCache();
		await cache.setCachedItems([item("i1", "v1")], "a");
		expect(await cache.getCachedItems("b")).toBeNull();
	});

	it("writes into the canonical per-account collections", async () => {
		const { cache, port } = makeCache();
		await cache.setCachedItems([item("i1", "v1")], "a");
		await cache.setCachedVaults([vault("v1")], "a");

		expect(port.collections()).toEqual(
			[itemsCollection("a"), metaCollection("a"), vaultsCollection("a")].sort(),
		);
		expect(await port.recordGet(itemsCollection("a"), "i1")).toBe(
			JSON.stringify(item("i1", "v1")),
		);
	});

	it("never leaks one account's items into another's collection", async () => {
		const { cache, port } = makeCache();
		await cache.setCachedItems([item("i1", "v1")], "a");
		expect(port.collections()).toContain(itemsCollection("a"));
		expect(port.collections()).not.toContain(itemsCollection("b"));
		expect(await cache.getCachedItems("b")).toBeNull();
	});
});

// ============================================================================
// O(1) single-record writes
// ============================================================================

describe("ItemCache O(1) single-record writes", () => {
	it("upsertCachedItem costs exactly one recordPut and no reads", async () => {
		const { cache, port } = makeCache();
		await cache.setCachedItems(
			[item("i1", "v1"), item("i2", "v1"), item("i3", "v1")],
			"a",
		);

		port.resetCalls();
		await cache.upsertCachedItem(item("i4", "v1"), "a");

		expect(port.calls.recordPut).toBe(1);
		expect(port.calls.recordList).toBe(0);
		expect(port.calls.recordGet).toBe(0);
		expect(port.calls.recordClear).toBe(0);
		expect(ids(await cache.getCachedItems("a"))).toEqual([
			"i1",
			"i2",
			"i3",
			"i4",
		]);
	});

	it("upsertCachedItem replaces an existing record in place", async () => {
		const { cache, port } = makeCache();
		await cache.setCachedItems([item("i1", "v1")], "a");

		port.resetCalls();
		await cache.upsertCachedItem(item("i1", "v1", { version: 7 }), "a");

		expect(port.calls.recordPut).toBe(1);
		const items = await cache.getCachedItems("a");
		expect(items).toHaveLength(1);
		expect(items?.[0]?.version).toBe(7);
	});

	it("removeCachedItem costs exactly one recordDelete", async () => {
		const { cache, port } = makeCache();
		await cache.setCachedItems([item("i1", "v1"), item("i2", "v1")], "a");

		port.resetCalls();
		await cache.removeCachedItem("i1", "a");

		expect(port.calls.recordDelete).toBe(1);
		expect(port.calls.recordList).toBe(0);
		expect(port.calls.recordPut).toBe(0);
		expect(ids(await cache.getCachedItems("a"))).toEqual(["i2"]);
	});

	it("removeCachedItem is a one-call no-op for an absent id", async () => {
		const { cache, port } = makeCache();
		await cache.setCachedItems([item("i1", "v1")], "a");

		port.resetCalls();
		await cache.removeCachedItem("nope", "a");

		expect(port.calls.recordDelete).toBe(1);
		expect(ids(await cache.getCachedItems("a"))).toEqual(["i1"]);
	});

	it("upsertCachedVault costs exactly one recordPut", async () => {
		const { cache, port } = makeCache();
		await cache.setCachedVaults([vault("v1")], "a");

		port.resetCalls();
		await cache.upsertCachedVault(vault("v2"), "a");

		expect(port.calls.recordPut).toBe(1);
		expect(ids(await cache.getCachedVaults("a"))).toEqual(["v1", "v2"]);
	});
});

// ============================================================================
// Replace, not merge
// ============================================================================

describe("ItemCache set* replaces", () => {
	it("setCachedItems replaces the whole set rather than merging", async () => {
		const { cache } = makeCache();
		await cache.setCachedItems([item("i1", "v1"), item("i2", "v1")], "a");
		await cache.setCachedItems([item("i3", "v1")], "a");
		expect(ids(await cache.getCachedItems("a"))).toEqual(["i3"]);
	});

	it("setCachedVaults replaces the whole set rather than merging", async () => {
		const { cache } = makeCache();
		await cache.setCachedVaults([vault("v1"), vault("v2")], "a");
		await cache.setCachedVaults([vault("v3")], "a");
		expect(ids(await cache.getCachedVaults("a"))).toEqual(["v3"]);
	});

	it("setCachedItems does not touch another account's collection", async () => {
		const { cache } = makeCache();
		await cache.setCachedItems([item("i1", "v1")], "a");
		await cache.setCachedItems([], "b");
		expect(ids(await cache.getCachedItems("a"))).toEqual(["i1"]);
	});

	it("setCachedItems preserves stored metadata", async () => {
		const { cache } = makeCache();
		await cache.setItemCacheMetadata(metadata({ itemCount: 5 }), "a");
		await cache.setCachedItems([item("i1", "v1")], "a");
		expect((await cache.getItemCacheMetadata("a"))?.itemCount).toBe(5);
	});
});

// ============================================================================
// removeCachedVault cascade
// ============================================================================

describe("ItemCache.removeCachedVault", () => {
	it("removes the vault and only its own items", async () => {
		const { cache } = makeCache();
		await cache.setCachedVaults([vault("v1"), vault("v2")], "a");
		await cache.setCachedItems(
			[item("i1", "v1"), item("i2", "v1"), item("i3", "v2")],
			"a",
		);

		await cache.removeCachedVault("v1", "a");

		expect(ids(await cache.getCachedVaults("a"))).toEqual(["v2"]);
		expect(ids(await cache.getCachedItems("a"))).toEqual(["i3"]);
	});

	it("leaves another account's identically-named vault alone", async () => {
		const { cache } = makeCache();
		await cache.setCachedVaults([vault("v1")], "a");
		await cache.setCachedItems([item("i1", "v1")], "a");
		await cache.setCachedVaults([vault("v1")], "b");
		await cache.setCachedItems([item("i9", "v1")], "b");

		await cache.removeCachedVault("v1", "a");

		expect(ids(await cache.getCachedVaults("b"))).toEqual(["v1"]);
		expect(ids(await cache.getCachedItems("b"))).toEqual(["i9"]);
	});

	it("is a no-op for an unknown vault id", async () => {
		const { cache } = makeCache();
		await cache.setCachedVaults([vault("v1")], "a");
		await cache.setCachedItems([item("i1", "v1")], "a");

		await cache.removeCachedVault("nope", "a");

		expect(ids(await cache.getCachedVaults("a"))).toEqual(["v1"]);
		expect(ids(await cache.getCachedItems("a"))).toEqual(["i1"]);
	});
});

// ============================================================================
// clearItemCache
// ============================================================================

describe("ItemCache.clearItemCache", () => {
	it("clears only the target account", async () => {
		const { cache, port } = makeCache();
		await cache.setCachedItems([item("i1", "v1")], "a");
		await cache.setCachedVaults([vault("v1")], "a");
		await cache.setItemCacheMetadata(metadata(), "a");
		await cache.setCachedItems([item("i2", "v2")], "b");
		await cache.setCachedVaults([vault("v2")], "b");
		await cache.setItemCacheMetadata(metadata(), "b");

		await cache.clearItemCache("a");

		expect(await cache.getCachedItems("a")).toBeNull();
		expect(await cache.getCachedVaults("a")).toBeNull();
		expect(await cache.getItemCacheMetadata("a")).toBeNull();

		expect(ids(await cache.getCachedItems("b"))).toEqual(["i2"]);
		expect(ids(await cache.getCachedVaults("b"))).toEqual(["v2"]);
		expect(await cache.getItemCacheMetadata("b")).not.toBeNull();

		expect(port.collections()).toEqual(
			[itemsCollection("b"), metaCollection("b"), vaultsCollection("b")].sort(),
		);
	});

	it("is a no-op on an account that was never cached", async () => {
		const { cache } = makeCache();
		await cache.clearItemCache("a");
		expect(await cache.getCachedItems("a")).toBeNull();
	});
});

// ============================================================================
// Metadata round-trip
// ============================================================================

describe("ItemCache metadata", () => {
	it("round-trips a metadata document", async () => {
		const { cache } = makeCache();
		const meta = metadata({
			lastFullSyncAt: 42,
			itemCount: 3,
			cacheVersion: 2,
		});
		await cache.setItemCacheMetadata(meta, "a");
		expect(await cache.getItemCacheMetadata("a")).toEqual(meta);
	});

	it("overwrites a previous metadata document", async () => {
		const { cache } = makeCache();
		await cache.setItemCacheMetadata(metadata({ itemCount: 1 }), "a");
		await cache.setItemCacheMetadata(metadata({ itemCount: 2 }), "a");
		expect((await cache.getItemCacheMetadata("a"))?.itemCount).toBe(2);
	});

	it("stores metadata in one record of the meta collection", async () => {
		const { cache, port } = makeCache();
		await cache.setItemCacheMetadata(metadata(), "a");
		const records = await port.recordList(metaCollection("a"));
		expect(records).toHaveLength(1);
		expect(records[0]?.id).toBe("meta");
	});

	it("does not lose the primed flags when metadata is written", async () => {
		const { cache } = makeCache();
		await cache.setCachedItems([], "a");
		await cache.setItemCacheMetadata(metadata(), "a");
		expect(await cache.getCachedItems("a")).toEqual([]);
	});
});

// ============================================================================
// Corrupt records
// ============================================================================

describe("ItemCache corrupt records", () => {
	it("skips a corrupt item record and still loads the rest", async () => {
		const { cache, port } = makeCache();
		await cache.setCachedItems([item("i1", "v1"), item("i2", "v1")], "a");
		await port.recordPut(itemsCollection("a"), "i2", "{not json");

		expect(ids(await cache.getCachedItems("a"))).toEqual(["i1"]);
	});

	it("skips a corrupt vault record and still loads the rest", async () => {
		const { cache, port } = makeCache();
		await cache.setCachedVaults([vault("v1"), vault("v2")], "a");
		await port.recordPut(vaultsCollection("a"), "v2", "<<broken>>");

		expect(ids(await cache.getCachedVaults("a"))).toEqual(["v1"]);
	});

	it("treats a corrupt meta record as a cold cache instead of throwing", async () => {
		const { cache, port } = makeCache();
		await cache.setCachedItems([], "a");
		await port.recordPut(metaCollection("a"), "meta", "}}}");

		expect(await cache.getCachedItems("a")).toBeNull();
		expect(await cache.getItemCacheMetadata("a")).toBeNull();
	});

	it("does not let a corrupt item block a vault cascade", async () => {
		const { cache, port } = makeCache();
		await cache.setCachedVaults([vault("v1")], "a");
		await cache.setCachedItems([item("i1", "v1"), item("i2", "v1")], "a");
		await port.recordPut(itemsCollection("a"), "i2", "nope");

		await cache.removeCachedVault("v1", "a");

		expect(await port.recordGet(itemsCollection("a"), "i1")).toBeNull();
		expect(await cache.getCachedVaults("a")).toEqual([]);
	});
});
