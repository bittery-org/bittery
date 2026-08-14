/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { getTagColorFromName } from "./tag-color";

/**
 * `tag-color.ts` is a deliberate duplicate of `getTagColorFromName` in
 * `packages/ui/src/components/tag-badge.tsx` — React Native cannot load a React
 * DOM package, so mobile cannot import it. That duplication is sanctioned; the
 * *drift* is not, and nothing checked for it.
 *
 * `packages/ui/src/__tests__/tag-badge.test.ts` asserts this identical table.
 * Change one and the other fails, which is the whole point: a tag that is amber
 * on the web and cyan on the phone is a bug nobody would file.
 */
const SHARED_EXPECTATIONS: ReadonlyArray<readonly [string, string]> = [
	["", "#3b82f6"],
	["work", "#10b981"],
	["personal", "#3b82f6"],
	["finance", "#06b6d4"],
	["tag-with-dashes", "#8b5cf6"],
	// Case matters: "Work" and "work" are different tags and may differ in colour.
	["Work", "#10b981"],
	// Non-ASCII goes through charCodeAt, so the two implementations have to agree
	// on UTF-16 code units, not code points.
	["travail", "#f97316"],
	["社内", "#f97316"],
	["🔐", "#ef4444"],
	// Long input: the hash overflows into negative territory, which is why the
	// implementations take Math.abs before the modulo.
	["a".repeat(64), "#3b82f6"],
];

describe("getTagColorFromName", () => {
	for (const [name, expected] of SHARED_EXPECTATIONS) {
		test(`${JSON.stringify(name)} -> ${expected}`, () => {
			expect(getTagColorFromName(name)).toBe(expected);
		});
	}

	test("is deterministic", () => {
		expect(getTagColorFromName("finance")).toBe(getTagColorFromName("finance"));
	});

	test("always returns a colour from the palette", () => {
		const palette = new Set(SHARED_EXPECTATIONS.map(([, colour]) => colour));
		for (let index = 0; index < 200; index++) {
			palette.add(getTagColorFromName(`tag-${index}`));
		}
		// Eight palette entries; 200 names cover all of them.
		expect(palette.size).toBe(8);
		for (const colour of palette) {
			expect(colour).toMatch(/^#[0-9a-f]{6}$/);
		}
	});
});
