import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	LOADING_SESSION,
	type RuntimeSessionSnapshot,
} from "@bittery/client-runtime/client";
import type { ItemsProjection } from "@bittery/client-runtime/protocol";
import type { DecryptedItemData, ItemCategory } from "@bittery/shared/types";
import {
	creatableVaults,
	deriveRuntimeItemsView,
	findRuntimeVault,
	mapRuntimeItemsProjection,
	mapRuntimeVaults,
	toRuntimeItemDraft,
	vaultNavEntries,
} from "./runtime-items";

function session(
	partial: Partial<RuntimeSessionSnapshot>,
): RuntimeSessionSnapshot {
	return { ...LOADING_SESSION, ...partial } as RuntimeSessionSnapshot;
}

const PERSONAL_VAULT = {
	vaultId: "vault-1",
	name: "Personal",
	vaultType: "personal" as const,
	role: "owner" as const,
};

const ONE_ITEM: ItemsProjection = {
	accountId: "account-1",
	replicaRevision: "4",
	vaults: [PERSONAL_VAULT],
	items: [
		{
			itemId: "item-1",
			accountId: "account-1",
			vaultId: "vault-1",
			status: "authoritative",
			favorite: false,
			createdAt: "2026-08-23T00:00:00Z",
			updatedAt: "2026-08-23T00:00:00Z",
			data: {
				category: "login",
				data: {
					title: "Bank",
				},
			},
		},
	],
};

/**
 * Every page that renders a list of Items.
 *
 * These assertions say what each page *does* read. What no page may read is not checked
 * here any more: `scripts/transitional-reachability.test.ts` audits the whole Web entry
 * graph for that, because the file list this used to grep reported the migration complete
 * while three consumers outside it were still on `useItems`.
 */
const ITEM_LIST_PAGES = [
	"../routes/_app/vaults/index.tsx",
	"../routes/_app/vaults/favorites.tsx",
	"../routes/_app/vaults/tag.$tagName.tsx",
	"../routes/_app/vaults/$vaultId/index.tsx",
	"../routes/_app/vaults/route.tsx",
	"../routes/_app/security.lazy.tsx",
	"../components/dashboard/recent-activity-card.tsx",
	"../components/dashboard/security-posture-card.tsx",
] as const;

describe("Runtime Items projection mapping", () => {
	test("preserves Runtime order and does not filter or sort", () => {
		const mapped = mapRuntimeItemsProjection({
			accountId: "account-1",
			replicaRevision: "4",
			vaults: [],
			items: [
				{
					itemId: "item-b",
					accountId: "account-1",
					vaultId: "vault-1",
					status: "authoritative",
					favorite: true,
					createdAt: "2026-08-23T00:00:00Z",
					updatedAt: "2026-08-23T01:00:00Z",
					data: {
						category: "login",
						data: {
							title: "Beta",
						},
					},
				},
				{
					itemId: "item-a",
					accountId: "account-1",
					vaultId: "vault-1",
					status: "authoritative",
					favorite: false,
					createdAt: "2026-08-23T00:00:00Z",
					updatedAt: "2026-08-23T00:00:00Z",
					data: {
						category: "login",
						data: {
							title: "Alpha",
						},
					},
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
			vaults: [],
			items: [
				{
					itemId: "item-1",
					accountId: "account-1",
					vaultId: "vault-1",
					status: "authoritative",
					favorite: false,
					createdAt: "2026-08-23T00:00:00Z",
					updatedAt: "2026-08-23T00:00:00Z",
					data: {
						category: "login",
						data: {
							title: "Bank",
							username: "person",
							password: "secret",
							url: "https://bank.test",
							urls: ["https://bank.test"],
							notes: "note",
							tags: ["finance"],
							customFields: [
								{
									id: "field-1",
									label: "PIN",
									value: "1234",
									type: "password",
								},
							],
						},
					},
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
			vaults: [],
			items: [
				{
					itemId: "item-1",
					accountId: "account-1",
					vaultId: "vault-1",
					status: "pending",
					favorite: false,
					createdAt: "2026-08-23T00:00:00Z",
					updatedAt: "2026-08-23T00:00:00Z",
					data: {
						category: "login",
						data: {
							title: "Bank",
							url: null,
							username: null,
							password: null,
							notes: null,
							note: null,
						},
					},
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

	test("keeps deleted and Attachment authority in the Runtime-backed host shape", () => {
		const [mapped] = mapRuntimeItemsProjection({
			...ONE_ITEM,
			items: [
				{
					...ONE_ITEM.items[0]!,
					deletedAt: "2026-08-30T12:00:00Z",
					attachments: [
						{
							accountId: "account-1",
							attachmentId: "attachment-1",
							itemId: "item-1",
							vaultId: "vault-1",
							name: "report.txt",
							contentType: "text/plain",
							fileSize: 42,
							uploadedBy: "user-1",
							createdAt: "2026-08-30T11:00:00Z",
						},
					],
				},
			],
		});

		expect(mapped?.deletedAt).toBe("2026-08-30T12:00:00Z");
		expect(mapped?.attachments).toEqual([
			{
				id: "attachment-1",
				accountId: "account-1",
				itemId: "item-1",
				vaultId: "vault-1",
				name: "report.txt",
				contentType: "text/plain",
				fileSize: 42,
				uploadedBy: "user-1",
				createdAt: "2026-08-30T11:00:00Z",
			},
		]);
	});

	test("an Item carries its Vault, so no page needs a second source", () => {
		const [mapped] = mapRuntimeItemsProjection({
			...ONE_ITEM,
			vaults: [
				{
					vaultId: "vault-1",
					name: "Personal",
					vaultType: "personal",
					icon: "lock",
					imageUrl: "https://images.test/vault.png",
					role: "owner",
				},
			],
		});
		expect(mapped?.vault).toEqual({
			id: "vault-1",
			name: "Personal",
			type: "personal",
			icon: "lock",
			imageUrl: "https://images.test/vault.png",
		});
	});

	test("an Item whose Vault the projection omits is named, not invented", () => {
		const [mapped] = mapRuntimeItemsProjection({ ...ONE_ITEM, vaults: [] });
		expect(mapped?.vault.id).toBe("vault-1");
		expect(mapped?.vault.name).toBe("");
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
	});

	test("every page that lists Items reads the Runtime observation", () => {
		for (const relative of ITEM_LIST_PAGES) {
			const source = readFileSync(new URL(relative, import.meta.url), "utf8");
			expect(source).toContain("useRuntimeItems");
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
	test("trash leaves ordinary lists, counts and tags while remaining available for restore", () => {
		const trashed = {
			...ONE_ITEM.items[0]!,
			deletedAt: "2026-08-30T12:00:00Z",
			favorite: true,
			data: {
				category: "login" as const,
				data: { title: "Trashed", tags: ["only-trash"] },
			},
		};
		const view = deriveRuntimeItemsView(
			session({ state: "unlocked", accountId: "account-1" }),
			{
				state: "ready",
				value: {
					...ONE_ITEM,
					items: [trashed, { ...ONE_ITEM.items[0]!, itemId: "active" }],
				},
			},
		);
		expect(view.items.map((item) => item.id)).toEqual(["active"]);
		expect(view.items.filter((item) => item.favorite)).toEqual([]);
		expect(view.items.flatMap((item) => item.tags ?? [])).toEqual([]);
		expect(view.trashedItems.map((item) => item.id)).toEqual(["item-1"]);
		const restored = deriveRuntimeItemsView(
			session({ state: "unlocked", accountId: "account-1" }),
			{ state: "ready", value: ONE_ITEM },
		);
		expect(restored.items.map((item) => item.id)).toEqual(["item-1"]);
		expect(restored.trashedItems).toEqual([]);
	});
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

describe("what an unfinished write looks like to the list", () => {
	function projection(
		status: "pending" | "authoritative" | "failed",
	): ItemsProjection {
		return {
			accountId: "account-1",
			replicaRevision: "4",
			vaults: [],
			items: [
				{
					itemId: "item-1",
					accountId: "account-1",
					vaultId: "vault-1",
					status,
					favorite: false,
					createdAt: "2026-08-23T00:00:00Z",
					updatedAt: "2026-08-23T00:00:00Z",
					data: {
						category: "login",
						data: {
							title: "Bank",
						},
					},
				},
			],
		};
	}

	test("an offline create arrives as pending, not as a saved Item", () => {
		const [mapped] = mapRuntimeItemsProjection(projection("pending"));
		expect(mapped?.runtimeStatus).toBe("pending");
	});

	test("a rejected Operation arrives as failed, not as a saved Item", () => {
		const [mapped] = mapRuntimeItemsProjection(projection("failed"));
		expect(mapped?.runtimeStatus).toBe("failed");
	});

	test("an authoritative Item says so", () => {
		const [mapped] = mapRuntimeItemsProjection(projection("authoritative"));
		expect(mapped?.runtimeStatus).toBe("authoritative");
	});

	test("the list and the detail pane both read the status", () => {
		for (const relative of [
			"../components/vault/item-list.tsx",
			"../components/vault/item-detail-pane.tsx",
		]) {
			const source = readFileSync(new URL(relative, import.meta.url), "utf8");
			expect(source).toContain("runtimeStatus");
		}
	});
});

describe("the Vaults a create can use", () => {
	const VAULTS = [
		{
			vaultId: "personal-1",
			name: "Personal",
			vaultType: "personal" as const,
			role: "owner" as const,
		},
		{
			vaultId: "readonly-1",
			name: "Shared with me",
			vaultType: "personal" as const,
			role: "read-only" as const,
		},
		{
			vaultId: "team-1",
			name: "Team",
			vaultType: "team" as const,
			role: "member" as const,
		},
	];

	test("the Runtime names them, so no transitional reader has to", () => {
		const view = deriveRuntimeItemsView(
			session({ state: "unlocked", accountId: "account-1" }),
			{
				state: "ready",
				value: { ...ONE_ITEM, vaults: VAULTS },
			},
		);
		expect(view.vaults.map((vault) => vault.id)).toEqual([
			"personal-1",
			"readonly-1",
			"team-1",
		]);
		expect(view.vaults[0]?.name).toBe("Personal");
		expect(view.vaults[0]?.role).toBe("owner");
		expect(view.vaults[0]?.writable).toBe(true);
		expect(view.vaults[1]?.role).toBe("read-only");
		expect(view.vaults[1]?.writable).toBe(false);
	});

	test("a Vault carries the Account it belongs to, as the Runtime names it", () => {
		const vaults = mapRuntimeVaults({ ...ONE_ITEM, vaults: VAULTS });
		expect(vaults.every((vault) => vault.accountId === "account-1")).toBe(true);
	});

	test("every writable Vault is offered as a create target", () => {
		expect(
			creatableVaults(mapRuntimeVaults({ ...ONE_ITEM, vaults: VAULTS })).map(
				(v) => v.id,
			),
		).toEqual(["personal-1", "team-1"]);
	});

	test("an Account with no Vaults offers none instead of guessing", () => {
		expect(
			creatableVaults(mapRuntimeVaults({ ...ONE_ITEM, vaults: [] })),
		).toEqual([]);
	});

	test("a page that needs one Vault finds it, and says so when it cannot", () => {
		const vaults = mapRuntimeVaults({ ...ONE_ITEM, vaults: VAULTS });
		expect(findRuntimeVault(vaults, "team-1")?.name).toBe("Team");
		expect(findRuntimeVault(vaults, "missing-1")).toBeNull();
	});

	test("the nav sidebar reads the Runtime's Vaults, keys and all", () => {
		expect(
			vaultNavEntries(mapRuntimeVaults({ ...ONE_ITEM, vaults: VAULTS })),
		).toEqual([
			{
				vaultId: "personal-1",
				vaultName: "Personal",
				vaultType: "personal",
				vaultIcon: null,
				vaultImageUrl: null,
				role: "owner",
				accountId: "account-1",
			},
			{
				vaultId: "readonly-1",
				vaultName: "Shared with me",
				vaultType: "personal",
				vaultIcon: null,
				vaultImageUrl: null,
				role: "read-only",
				accountId: "account-1",
			},
			{
				vaultId: "team-1",
				vaultName: "Team",
				vaultType: "team",
				vaultIcon: null,
				vaultImageUrl: null,
				role: "member",
				accountId: "account-1",
			},
		]);
	});
});

describe("the draft the Runtime is asked to seal", () => {
	test("preserves all categories and extended fields at creation", () => {
		const drafts: Array<{ category: ItemCategory; data: DecryptedItemData }> = [
			{
				category: "login",
				data: {
					title: "Login",
					passwordHistory: [{ password: "old", changedAt: "2026-09-01" }],
					totpSecret: "JBSWY3DPEHPK3PXP",
				},
			},
			{ category: "secure-note", data: { title: "Note", note: "body" } },
			{
				category: "credit-card",
				data: { title: "Card", cardNumber: "4111111111111111" },
			},
			{
				category: "identity",
				data: {
					title: "Identity",
					firstName: "Person",
					passportNumber: "1234",
				},
			},
			{
				category: "totp",
				data: {
					title: "Authenticator",
					totpSecret: "JBSWY3DPEHPK3PXP",
					linkedItemId: "login-1",
				},
			},
		];
		for (const item of drafts) {
			expect<unknown>(
				toRuntimeItemDraft(item.category, { ...item.data }),
			).toEqual({
				category: item.category === "totp" ? "authenticator" : item.category,
				data: item.data,
			});
		}
	});
});

describe("where a create goes", () => {
	const CREATE_PAGES = [
		"../routes/_app/vaults/index.tsx",
		"../routes/_app/vaults/favorites.tsx",
		"../routes/_app/vaults/tag.$tagName.tsx",
		"../routes/_app/vaults/$vaultId/index.tsx",
	] as const;
	/** The three pages that offer a create across every Vault the Account holds. */
	const ALL_VAULT_PAGES = CREATE_PAGES.slice(0, 3);

	test("every vault page hands its create to the Runtime", () => {
		for (const relative of CREATE_PAGES) {
			const source = readFileSync(new URL(relative, import.meta.url), "utf8");
			expect(source).toContain("useAcceptItem");
			expect(source).toContain("creatableVaults");
		}
		const hook = readFileSync(
			new URL("../hooks/use-accept-item.ts", import.meta.url),
			"utf8",
		);
		expect(hook).toContain("@bittery/client-runtime/react");
		expect(hook).toContain("runtime.createItem");
		expect(hook).toContain("toRuntimeItemDraft");
		expect(hook).not.toContain("@bittery/core/hooks");
		expect(hook).not.toContain("@bittery/storage");
		expect(hook).not.toContain("@bittery/sync");
	});

	test("the writable Vault comes from the Runtime, so an Item is not read-only", () => {
		for (const relative of ALL_VAULT_PAGES) {
			const source = readFileSync(new URL(relative, import.meta.url), "utf8");
			expect(source).toContain("canWriteVault");
		}
		// The single-Vault page asks the same question of the one Vault it renders.
		const vaultPage = readFileSync(
			new URL("../routes/_app/vaults/$vaultId/index.tsx", import.meta.url),
			"utf8",
		);
		expect(vaultPage).toContain("findRuntimeVault");
		expect(vaultPage).toContain("vault?.writable === true");
	});

	test("the vault sidebar and its counts read the Runtime projection", () => {
		const layout = readFileSync(
			new URL("../routes/_app/vaults/route.tsx", import.meta.url),
			"utf8",
		);
		expect(layout).toContain("vaultNavEntries");
		expect(layout).toContain(
			'useItemCounts(itemsState === "ready" ? items : undefined)',
		);
	});
});

test("Import projections retain each category and every category-specific field", () => {
	const drafts: ItemsProjection["items"][number]["data"][] = [
		{
			category: "login",
			data: {
				title: "Login",
				passwordHistory: [{ password: "old", changedAt: "2026-09-01" }],
				totpSecret: "secret",
			},
		},
		{ category: "secure-note", data: { title: "Note", note: "body" } },
		{
			category: "credit-card",
			data: { title: "Card", cardNumber: "1234", cvv: "567" },
		},
		{
			category: "identity",
			data: { title: "Identity", firstName: "Pat", email: "pat@example.test" },
		},
		{
			category: "authenticator",
			data: { title: "Authenticator", totpSecret: "secret", totpDigits: 8 },
		},
	];
	const item = ONE_ITEM.items[0];
	if (!item) throw new Error("Item fixture is missing");
	const mapped = mapRuntimeItemsProjection({
		...ONE_ITEM,
		items: drafts.map((data, index) => ({
			...item,
			itemId: `import-${index}`,
			data,
			favorite: true,
		})),
	});
	expect(mapped.map((item) => item.category)).toEqual([
		"login",
		"secure-note",
		"credit-card",
		"identity",
		"totp",
	]);
	for (const [index, draft] of drafts.entries())
		expect(mapped[index]).toMatchObject({ ...draft.data, favorite: true });
});
