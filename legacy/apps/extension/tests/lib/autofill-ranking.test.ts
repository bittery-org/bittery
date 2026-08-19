import { describe, expect, test } from "bun:test";
import type { DecryptedItemWithContext } from "@bittery/shared/types";
import {
	rankByQuery,
	rankItemsForHostname,
	scoreItemForHostname,
	scoreUrlMatch,
	UrlMatchScore,
} from "../../src/lib/autofill-ranking";

function item(
	partial: Partial<DecryptedItemWithContext> & { id: string },
): DecryptedItemWithContext {
	return {
		vaultId: "vault",
		category: "login",
		favorite: false,
		createdAt: "2024-01-01T00:00:00.000Z",
		updatedAt: "2024-01-01T00:00:00.000Z",
		title: partial.id,
		...partial,
	} as DecryptedItemWithContext;
}

describe("scoreUrlMatch", () => {
	test("ranks an exact hostname highest", () => {
		expect(scoreUrlMatch("https://login.df.eu/path", "login.df.eu")).toBe(
			UrlMatchScore.EXACT,
		);
	});

	test("ranks the parent domain above a child domain", () => {
		const parent = scoreUrlMatch("https://df.eu", "login.df.eu");
		const child = scoreUrlMatch("https://login.df.eu", "df.eu");

		expect(parent).toBe(UrlMatchScore.PARENT_DOMAIN);
		expect(child).toBe(UrlMatchScore.SUBDOMAIN);
		expect(parent).toBeGreaterThan(child);
	});

	test("ranks a sibling subdomain lowest of the matches", () => {
		expect(scoreUrlMatch("https://mail.df.eu", "shop.df.eu")).toBe(
			UrlMatchScore.SIBLING_DOMAIN,
		);
	});

	test("does not match an unrelated domain", () => {
		expect(scoreUrlMatch("https://example.com", "df.eu")).toBe(
			UrlMatchScore.NONE,
		);
	});

	test("handles bare hostnames without a scheme", () => {
		expect(scoreUrlMatch("df.eu", "df.eu")).toBe(UrlMatchScore.EXACT);
	});

	test("is not fooled by a domain that merely ends with the target", () => {
		expect(scoreUrlMatch("https://notdf.eu", "df.eu")).toBe(UrlMatchScore.NONE);
	});
});

describe("scoreItemForHostname", () => {
	test("uses the best of the item's secondary urls", () => {
		const subject = item({
			id: "a",
			url: "https://other.example.com",
			urls: ["https://df.eu"],
		});

		expect(scoreItemForHostname(subject, "df.eu")).toBe(UrlMatchScore.EXACT);
	});

	test("scores an item without any url as no match", () => {
		expect(scoreItemForHostname(item({ id: "a" }), "df.eu")).toBe(
			UrlMatchScore.NONE,
		);
	});
});

describe("rankItemsForHostname", () => {
	test("puts the exact host first and drops unrelated items", () => {
		const ranked = rankItemsForHostname(
			[
				item({ id: "sibling", url: "https://mail.df.eu" }),
				item({ id: "unrelated", url: "https://example.com" }),
				item({ id: "exact", url: "https://login.df.eu" }),
				item({ id: "parent", url: "https://df.eu" }),
			],
			"login.df.eu",
		);

		expect(ranked.map((entry) => entry.id)).toEqual([
			"exact",
			"parent",
			"sibling",
		]);
	});

	test("breaks ties on favourite, then recency", () => {
		const ranked = rankItemsForHostname(
			[
				item({
					id: "old",
					url: "https://df.eu",
					updatedAt: "2024-01-01T00:00:00.000Z",
				}),
				item({
					id: "new",
					url: "https://df.eu",
					updatedAt: "2025-06-01T00:00:00.000Z",
				}),
				item({ id: "starred", url: "https://df.eu", favorite: true }),
			],
			"df.eu",
		);

		expect(ranked.map((entry) => entry.id)).toEqual(["starred", "new", "old"]);
	});
});

describe("rankByQuery", () => {
	const fields = (entry: DecryptedItemWithContext) => [
		{ value: entry.username, weight: 60 },
		{ value: entry.title, weight: 50 },
	];

	test("ranks a prefix match above a substring match", () => {
		const ranked = rankByQuery(
			[
				item({ id: "substring", username: "not-pixelmund@gmail.com" }),
				item({ id: "prefix", username: "pixelmund@gmail.com" }),
			],
			"pixel",
			fields,
		);

		expect(ranked.map((entry) => entry.id)).toEqual(["prefix", "substring"]);
	});

	test("preserves the incoming hostname order for equally good matches", () => {
		const ranked = rankByQuery(
			[
				item({ id: "first", username: "team@df.eu" }),
				item({ id: "second", username: "team@df.eu" }),
			],
			"team",
			fields,
		);

		expect(ranked.map((entry) => entry.id)).toEqual(["first", "second"]);
	});

	test("returns the list untouched for an empty query", () => {
		const items = [item({ id: "a" }), item({ id: "b" })];
		expect(rankByQuery(items, "  ", fields)).toBe(items);
	});

	test("drops items that do not match at all", () => {
		const ranked = rankByQuery(
			[
				item({ id: "a", username: "alice" }),
				item({ id: "b", username: "bob" }),
			],
			"ali",
			fields,
		);

		expect(ranked.map((entry) => entry.id)).toEqual(["a"]);
	});
});
