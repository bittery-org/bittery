import { describe, expect, test } from "bun:test";
import type { DecryptedItemWithContext } from "@bittery/shared/types";
import { filterIdentityItems } from "../../src/lib/item-filter";

function identity(
	partial: Partial<DecryptedItemWithContext> & { id: string },
): DecryptedItemWithContext {
	return {
		vaultId: "vault",
		category: "identity",
		favorite: false,
		createdAt: "2024-01-01T00:00:00.000Z",
		updatedAt: "2024-01-01T00:00:00.000Z",
		title: partial.id,
		...partial,
	} as DecryptedItemWithContext;
}

describe("filterIdentityItems", () => {
	test("does not match missing address parts", () => {
		const withPartialAddress = identity({
			id: "partial",
			firstName: "Ada",
			addresses: [
				{
					id: "addr-1",
					city: "Berlin",
				},
			],
		} as Partial<DecryptedItemWithContext> & { id: string });

		// "und" only appears if a missing field stringifies to "undefined".
		expect(filterIdentityItems([withPartialAddress], "und")).toEqual([]);
		expect(filterIdentityItems([withPartialAddress], "berlin")).toEqual([
			withPartialAddress,
		]);
	});
});
