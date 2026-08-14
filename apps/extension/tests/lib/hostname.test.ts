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

	// The Android SQL path matches by intersecting the item's indexed keys with
	// the target's query keys. That is only equivalent to `hostnameMatches` if
	// every matching pair shares a key, so assert the two agree on the vectors.
	for (const { left, right, expected } of vectors.matches) {
		test(`agrees with hostnameMatches for ${JSON.stringify(left)} / ${JSON.stringify(right)}`, () => {
			const indexed = new Set(domainLookupKeys(left));
			const queried = domainLookupKeys(right);
			expect(queried.some((key) => indexed.has(key))).toBe(expected);
		});
	}
});
