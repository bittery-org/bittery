import { describe, expect, test } from "bun:test";
import { getTagColorFromName } from "../components/tag-badge";

/**
 * The web/desktop/extension half of the tag-colour parity check.
 *
 * `apps/mobile/src/lib/tag-color.ts` restates this function because React Native
 * cannot load a React DOM package. That duplication is documented and correct;
 * silent drift between the two is not. `apps/mobile/src/lib/tag-color.test.ts`
 * asserts this identical table, so a change here without a change there fails.
 */
const SHARED_EXPECTATIONS: ReadonlyArray<readonly [string, string]> = [
	["", "#3b82f6"],
	["work", "#10b981"],
	["personal", "#3b82f6"],
	["finance", "#06b6d4"],
	["tag-with-dashes", "#8b5cf6"],
	["Work", "#10b981"],
	["travail", "#f97316"],
	["社内", "#f97316"],
	["🔐", "#ef4444"],
	["a".repeat(64), "#3b82f6"],
];

describe("getTagColorFromName", () => {
	for (const [name, expected] of SHARED_EXPECTATIONS) {
		test(`${JSON.stringify(name)} -> ${expected}`, () => {
			expect(getTagColorFromName(name)).toBe(expected);
		});
	}
});
