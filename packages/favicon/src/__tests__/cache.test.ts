import { describe, expect, test } from "bun:test";
import { FaviconLruCache } from "../cache";

describe("FaviconLruCache", () => {
	test("evicts least recently used entries", () => {
		const cache = new FaviconLruCache({
			maxEntries: 2,
			maxEntryBytes: 10_000,
			maxTotalBytes: 10_000,
		});

		cache.set("a.com", Buffer.from("a"), "image/png");
		cache.set("b.com", Buffer.from("b"), "image/png");
		expect(cache.get("a.com")?.data.toString()).toBe("a");

		cache.set("c.com", Buffer.from("c"), "image/png");

		expect(cache.get("b.com")).toBeUndefined();
		expect(cache.get("a.com")?.data.toString()).toBe("a");
		expect(cache.get("c.com")?.data.toString()).toBe("c");
	});

	test("skips entries over max entry size", () => {
		const cache = new FaviconLruCache({
			maxEntries: 10,
			maxEntryBytes: 3,
			maxTotalBytes: 30,
		});

		cache.set("big.com", Buffer.from("1234"), "image/png");
		expect(cache.get("big.com")).toBeUndefined();
	});
});
