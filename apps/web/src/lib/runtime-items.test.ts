import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	mapRuntimeItemsProjection,
	parseRuntimeItemsObservation,
	runtimeItemsObservationJson,
} from "./runtime-items";

const ITEM_LIST_PAGES = [
	"../routes/_app/vaults/index.tsx",
	"../routes/_app/vaults/favorites.tsx",
	"../routes/_app/vaults/tag.$tagName.tsx",
	"../routes/_app/vaults/$vaultId/index.tsx",
	"../routes/_app/vaults/route.tsx",
] as const;

describe("Runtime Items observation mapping", () => {
	test("preserves Runtime order and does not filter or sort", () => {
		const mapped = mapRuntimeItemsProjection({
			accountId: "account-1",
			replicaRevision: 4,
			items: [
				{
					itemId: "item-b",
					accountId: "account-1",
					vaultId: "vault-1",
					title: "Beta",
					status: "authoritative",
					favorite: true,
					createdAt: "2026-08-23T00:00:00Z",
					updatedAt: "2026-08-23T01:00:00Z",
				},
				{
					itemId: "item-a",
					accountId: "account-1",
					vaultId: "vault-1",
					title: "Alpha",
					status: "authoritative",
				},
			],
		});
		expect(mapped.map((item) => item.id)).toEqual(["item-b", "item-a"]);
		expect(mapped.map((item) => item.title)).toEqual(["Beta", "Alpha"]);
		expect(mapped[0]?.favorite).toBe(true);
		expect(mapped[1]?.favorite).toBe(false);
		expect(mapped[0]?.createdAt).toBe("2026-08-23T00:00:00Z");
		expect(mapped[0]?.updatedAt).toBe("2026-08-23T01:00:00Z");
	});

	test("parses the tagged observe(Items) envelope", () => {
		const items = parseRuntimeItemsObservation(
			JSON.stringify({
				type: "items",
				value: {
					accountId: "account-1",
					replicaRevision: 4,
					items: [
						{
							itemId: "item-1",
							accountId: "account-1",
							vaultId: "vault-1",
							title: "Bank",
							status: "authoritative",
						},
					],
				},
			}),
		);
		expect(items).toEqual([
			{
				id: "item-1",
				accountId: "account-1",
				vaultId: "vault-1",
				title: "Bank",
				url: undefined,
				urls: [],
				username: undefined,
				password: undefined,
				notes: undefined,
				note: undefined,
				tags: [],
				category: "login",
				favorite: false,
				createdAt: "",
				updatedAt: "",
				deletedAt: null,
				version: 1,
				lastModifiedBy: "",
				encryptionVersion: 1,
				encryptedByUserId: "",
				_encrypted: {
					data: "",
					iv: "",
					algorithm: "",
				},
				vault: {
					id: "vault-1",
					name: "",
					type: "personal",
					icon: null,
					imageUrl: null,
				},
			},
		]);
		expect(parseRuntimeItemsObservation("{")).toEqual([]);
		expect(parseRuntimeItemsObservation('{"type":"runtimeStatus"}')).toEqual(
			[],
		);
		expect(runtimeItemsObservationJson("account-1")).toBe(
			JSON.stringify({ type: "items", accountId: "account-1" }),
		);
	});

	test("existing ItemList still owns filter and sort", () => {
		const source = readFileSync(
			new URL("../components/vault/item-list.tsx", import.meta.url),
			"utf8",
		);
		expect(source).toContain("useItemListFilters");
		expect(source).toContain("filteredItems");
		expect(source).toContain("sortField");
	});

	test("vault ItemList pages consume Runtime observe(Items)", () => {
		const hook = readFileSync(
			new URL("../hooks/use-runtime-items.ts", import.meta.url),
			"utf8",
		);
		expect(hook).toContain("bindRuntimeItemsObservation");
		expect(hook).toContain("getRuntimeAccountId");
		expect(hook).not.toMatch(/\buseItems\b/);
		expect(hook).not.toContain("useAccountSwitcher");

		for (const relative of ITEM_LIST_PAGES) {
			const source = readFileSync(new URL(relative, import.meta.url), "utf8");
			expect(source).toContain("useRuntimeItems");
			expect(source).not.toMatch(/\buseItems\b/);
			expect(source).not.toMatch(/\buseVaultItems\b/);
		}
	});
});
