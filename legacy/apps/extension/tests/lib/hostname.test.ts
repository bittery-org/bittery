/**
 * Drives `src/lib/hostname.ts` against `src/lib/domain-matching.vectors.json`.
 *
 * The vectors are a cross-language contract: the Android credential provider
 * asserts the same file from `DomainMatchVectorsTest.kt`. If a vector changes
 * here and not there, the two platforms start offering different credentials
 * for the same site — which is the bug this suite exists to prevent.
 */

import { describe, expect, test } from "bun:test";
import vectors from "../../src/lib/domain-matching.vectors.json";
import {
	domainLookupKeys,
	hostnameMatches,
	normalizeHost,
	registrableDomain,
} from "../../src/lib/hostname";

describe("normalizeHost", () => {
	for (const { input, expected } of vectors.normalizeHost) {
		test(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
			expect(normalizeHost(input)).toBe(expected);
		});
	}
});

describe("registrableDomain", () => {
	for (const { input, expected } of vectors.registrableDomain) {
		test(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
			expect(registrableDomain(input)).toBe(expected);
		});
	}
});

describe("hostnameMatches", () => {
	for (const { left, right, expected } of vectors.matches) {
		test(`${JSON.stringify(left)} vs ${JSON.stringify(right)} -> ${expected}`, () => {
			expect(hostnameMatches(left, right)).toBe(expected);
			// Matching has to be symmetric, or "offer this credential here" would
			// depend on which side the caller happened to pass first.
			expect(hostnameMatches(right, left)).toBe(expected);
		});
	}
});

describe("domainLookupKeys", () => {
	for (const { input, expected } of vectors.lookupKeys) {
		test(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
			expect(domainLookupKeys(input)).toEqual(expected);
		});
	}

	/**
	 * The Android SQL path matches by intersecting an item's indexed keys with
	 * the target's query keys, and three comments in the Kotlin claim that is
	 * exactly `hostnameMatches`. Asserting that only over the `matches` vectors
	 * proves nothing — the vectors are chosen by the same person as the code, so
	 * the guard is shaped to pass. This runs the full cross product of a corpus
	 * picked to include the shapes that broke it: public suffixes as hosts,
	 * sibling subdomains, deep subdomains, multi-label suffixes, and both
	 * spellings of an IDN.
	 */
	const CORPUS = [
		"example.com",
		"www.example.com",
		"login.example.com",
		"a.b.example.com",
		"other.com",
		"com",
		"co.uk",
		"bbc.co.uk",
		"www.bbc.co.uk",
		"news.bbc.co.uk",
		"itv.co.uk",
		"example.com.au",
		"shop.example.com.au",
		"com.au",
		"localhost",
		"192.168.0.1",
		"bücher.de",
		"xn--bcher-kva.de",
		"shop.bücher.de",
		"com.android.chrome",
	];

	test("key intersection agrees with hostnameMatches over the whole corpus", () => {
		const disagreements: string[] = [];
		for (const left of CORPUS) {
			for (const right of CORPUS) {
				const indexed = new Set(domainLookupKeys(left));
				const intersects = domainLookupKeys(right).some((key) =>
					indexed.has(key),
				);
				if (intersects !== hostnameMatches(left, right)) {
					disagreements.push(
						`${left} / ${right}: matches=${hostnameMatches(left, right)} keys=${intersects}`,
					);
				}
			}
		}
		expect(disagreements).toEqual([]);
	});

	test("hostnameMatches is symmetric over the whole corpus", () => {
		const asymmetric: string[] = [];
		for (const left of CORPUS) {
			for (const right of CORPUS) {
				if (hostnameMatches(left, right) !== hostnameMatches(right, left)) {
					asymmetric.push(`${left} / ${right}`);
				}
			}
		}
		expect(asymmetric).toEqual([]);
	});

	test("a public suffix is never the same site as a domain under it", () => {
		for (const [suffix, host] of [
			["com", "example.com"],
			["co.uk", "bbc.co.uk"],
			["com.au", "example.com.au"],
		]) {
			expect(hostnameMatches(suffix, host)).toBe(false);
			expect(hostnameMatches(host, suffix)).toBe(false);
		}
	});
});
