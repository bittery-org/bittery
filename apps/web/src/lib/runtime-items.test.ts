import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	LOADING_SESSION,
	type RuntimeSessionSnapshot,
} from "@bittery/client-runtime/client";
import type { ItemsProjection } from "@bittery/client-runtime/protocol";
import {
	deriveRuntimeItemsView,
	mapRuntimeItemsProjection,
} from "./runtime-items";

function session(
	partial: Partial<RuntimeSessionSnapshot>,
): RuntimeSessionSnapshot {
	return { ...LOADING_SESSION, ...partial } as RuntimeSessionSnapshot;
}

const ONE_ITEM: ItemsProjection = {
	accountId: "account-1",
	replicaRevision: "4",
	items: [
		{
			itemId: "item-1",
			accountId: "account-1",
			vaultId: "vault-1",
			title: "Bank",
			status: "authoritative",
			favorite: false,
			createdAt: "2026-08-23T00:00:00Z",
			updatedAt: "2026-08-23T00:00:00Z",
		},
	],
};

const ITEM_LIST_PAGES = [
	"../routes/_app/vaults/index.tsx",
	"../routes/_app/vaults/favorites.tsx",
	"../routes/_app/vaults/tag.$tagName.tsx",
	"../routes/_app/vaults/$vaultId/index.tsx",
	"../routes/_app/vaults/route.tsx",
] as const;

describe("Runtime Items projection mapping", () => {
	test("preserves Runtime order and does not filter or sort", () => {
		const mapped = mapRuntimeItemsProjection({
			accountId: "account-1",
			replicaRevision: "4",
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
					favorite: false,
					createdAt: "2026-08-23T00:00:00Z",
					updatedAt: "2026-08-23T00:00:00Z",
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

	test("carries the whole Login Item, custom fields included", () => {
		const [mapped] = mapRuntimeItemsProjection({
			accountId: "account-1",
			replicaRevision: "4",
			items: [
				{
					itemId: "item-1",
					accountId: "account-1",
					vaultId: "vault-1",
					title: "Bank",
					status: "authoritative",
					favorite: false,
					createdAt: "2026-08-23T00:00:00Z",
					updatedAt: "2026-08-23T00:00:00Z",
					username: "person",
					password: "secret",
					url: "https://bank.test",
					urls: ["https://bank.test"],
					notes: "note",
					tags: ["finance"],
					customFields: [
						{ id: "field-1", label: "PIN", value: "1234", type: "password" },
					],
				},
			],
		});
		expect(mapped?.username).toBe("person");
		expect(mapped?.password).toBe("secret");
		expect(mapped?.url).toBe("https://bank.test");
		expect(mapped?.tags).toEqual(["finance"]);
		expect(mapped?.customFields).toEqual([
			{ id: "field-1", label: "PIN", value: "1234", type: "password" },
		]);
	});

	test("turns an absent optional field into undefined, not null", () => {
		const [mapped] = mapRuntimeItemsProjection({
			accountId: "account-1",
			replicaRevision: "4",
			items: [
				{
					itemId: "item-1",
					accountId: "account-1",
					vaultId: "vault-1",
					title: "Bank",
					status: "pending",
					favorite: false,
					createdAt: "2026-08-23T00:00:00Z",
					updatedAt: "2026-08-23T00:00:00Z",
					url: null,
					username: null,
					password: null,
					notes: null,
					note: null,
				},
			],
		});
		expect(mapped?.url).toBeUndefined();
		expect(mapped?.username).toBeUndefined();
		expect(mapped?.password).toBeUndefined();
		expect(mapped?.notes).toBeUndefined();
		expect(mapped?.note).toBeUndefined();
		expect(mapped?.urls).toEqual([]);
		expect(mapped?.tags).toEqual([]);
		expect(mapped?.customFields).toBeUndefined();
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

	test("the Items hook only maps: the registry owns identity and lifetime", () => {
		const hook = readFileSync(
			new URL("../hooks/use-runtime-items.ts", import.meta.url),
			"utf8",
		);
		expect(hook).toContain("@bittery/client-runtime/react");
		expect(hook).toContain("deriveRuntimeItemsView");
		expect(hook).not.toMatch(/\buseSyncExternalStore\b/);
		expect(hook).not.toMatch(/\buseEffect\b/);
		expect(hook).not.toMatch(/\buseState\b/);
		expect(hook).not.toMatch(/\buseItems\b/);
		expect(hook).not.toContain("useAccountSwitcher");

		for (const relative of ITEM_LIST_PAGES) {
			const source = readFileSync(new URL(relative, import.meta.url), "utf8");
			expect(source).toContain("useRuntimeItems");
			expect(source).not.toMatch(/\buseItems\b/);
			expect(source).not.toMatch(/\buseVaultItems\b/);
		}
	});

	test("the Runtime client is built above React, not inside it", () => {
		const composition = readFileSync(
			new URL("./crypto.ts", import.meta.url),
			"utf8",
		);
		expect(composition).toContain("createRuntimeClient");

		const router = readFileSync(
			new URL("../router.tsx", import.meta.url),
			"utf8",
		);
		expect(router).toContain("<RuntimeProvider client={runtimeClient}>");
		expect(router).not.toContain("createRuntimeClient");
	});
});

describe("what the vault pages render", () => {
	test("a restored but locked Account is a lock, not an empty list", () => {
		const view = deriveRuntimeItemsView(
			session({ state: "locked", accountId: "account-1" }),
			{ state: "idle" },
		);
		expect(view.state).toBe("locked");
		expect(view.items).toEqual([]);
	});

	test("an Account that locks underneath an open observation is a lock", () => {
		const view = deriveRuntimeItemsView(
			session({ state: "unlocked", accountId: "account-1" }),
			{ state: "failed", code: "AUTHENTICATION_REQUIRED" },
		);
		expect(view.state).toBe("locked");
		expect(view.code).toBe("AUTHENTICATION_REQUIRED");
	});

	test("an unlocked Account with no Items is ready and empty, not locked", () => {
		const view = deriveRuntimeItemsView(
			session({ state: "unlocked", accountId: "account-1" }),
			{
				state: "ready",
				value: { ...ONE_ITEM, items: [] },
			},
		);
		expect(view.state).toBe("ready");
		expect(view.items).toEqual([]);
	});

	test("an unlocked Account with Items maps them", () => {
		const view = deriveRuntimeItemsView(
			session({ state: "unlocked", accountId: "account-1" }),
			{ state: "ready", value: ONE_ITEM },
		);
		expect(view.state).toBe("ready");
		expect(view.items.map((item) => item.id)).toEqual(["item-1"]);
	});

	test("still loading is not the same answer as empty", () => {
		expect(
			deriveRuntimeItemsView(session({ state: "loading" }), { state: "idle" })
				.state,
		).toBe("loading");
		expect(
			deriveRuntimeItemsView(
				session({ state: "unlocked", accountId: "account-1" }),
				{ state: "loading" },
			).state,
		).toBe("loading");
	});

	test("a broken observation says so instead of showing an empty vault", () => {
		const view = deriveRuntimeItemsView(
			session({ state: "unlocked", accountId: "account-1" }),
			{ state: "failed", code: "INVARIANT_VIOLATION" },
		);
		expect(view.state).toBe("unavailable");
		expect(view.code).toBe("INVARIANT_VIOLATION");
	});

	test("a signed-out Device is signed out, not empty", () => {
		expect(
			deriveRuntimeItemsView(session({ state: "signedOut" }), { state: "idle" })
				.state,
		).toBe("signedOut");
	});
});
