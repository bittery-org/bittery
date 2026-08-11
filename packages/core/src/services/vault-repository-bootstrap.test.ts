import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { CryptoPort } from "@bittery/crypto-port";
import type { InMemoryCryptoPort } from "@bittery/crypto-port/testing";
import {
	cachedItem as buildCachedItem,
	serverEncryptedItem,
} from "@bittery/shared/testing/item-fixtures";
import type { AccountStore, ItemCache } from "@bittery/storage";
import { createItemCache, metaCollection } from "@bittery/storage";
import {
	createInMemoryRecordPort,
	type InMemoryRecordPort,
} from "@bittery/storage/testing";
import type { CachedEncryptedItem, ItemSyncCommand } from "@bittery/types";
import {
	accountMetadata,
	createTestAccountStore,
} from "../testing/account-store-harness";
import {
	getTravelModeEnforcer,
	resetTravelModeEnforcerForTests,
} from "./travel-mode-enforcer";
import { createVaultCrypto, type VaultCrypto } from "./vault-crypto";
import { type BootstrapItemsClient, VaultRepository } from "./vault-repository";
import { VaultRepositoryCoordinator } from "./vault-repository-coordinator";

const ACCOUNT_ID = "acc-1";
/** `accountMetadata` derives this from the account id. */
const USER_ID = `user-${ACCOUNT_ID}`;

/**
 * Real `AccountStore` and real `ItemCache`, each over its own in-memory port.
 *
 * `recordPort` is handed back deliberately: `calls.recordPut` is the only way to assert
 * the O(1) upsert property from the caller's side.
 */
async function createLayers(): Promise<{
	storage: AccountStore;
	itemCache: ItemCache;
	recordPort: InMemoryRecordPort;
	crypto: InMemoryCryptoPort;
}> {
	const { store, crypto } = await createTestAccountStore();
	const recordPort = createInMemoryRecordPort();
	const itemCache = createItemCache({ port: recordPort });
	await itemCache.initialize();

	await store.addAccount(accountMetadata({ accountId: ACCOUNT_ID }));
	await store.storeServerUrl("https://bittery.test", ACCOUNT_ID);
	const masterUnlockKey = await crypto.importKey(new Uint8Array(32));
	await store.setMasterUnlockKey(masterUnlockKey, ACCOUNT_ID);
	const vaultCrypto = createVaultCrypto({ crypto, storage: store });
	const vaultKey = await crypto.importKey(
		new TextEncoder().encode("vault-key"),
	);
	const encryptedVaultKey = await vaultCrypto.wrapVaultKeyForOwner({
		vaultKey,
		masterUnlockKey,
		vaultId: "vault_1",
		userId: USER_ID,
		keyVersion: 1,
	});
	await crypto.destroyKey(vaultKey);
	await store.storeVaultKeys(
		[
			{
				vaultId: "vault_1",
				vaultName: "Team Vault",
				vaultType: "team",
				vaultIcon: "lock",
				vaultImageUrl: null,
				encryptedVaultKey,
				role: "owner",
			},
		],
		ACCOUNT_ID,
	);

	return { storage: store, itemCache, recordPort, crypto };
}

/**
 * A bootstrap client shaped exactly like the server's camelCased responses:
 * both `sync.bootstrap` and `vaults.list` carry `vaultType`, never `type`.
 */
function createClient(): BootstrapItemsClient {
	return {
		sync: {
			bootstrap: mock(async () => ({
				data: {
					items: [
						{
							...serverEncryptedItem({
								id: "item_1",
								vaultId: "vault_1",
								encryptedData: "ZGF0YQ==",
								encryptionIv: "aXY=",
								encryptionAlgorithm: "AES-GCM",
								lastModifiedBy: USER_ID,
								encryptedByUserId: USER_ID,
								createdAt: "2026-08-01T00:00:00.000Z",
								updatedAt: "2026-08-01T00:00:00.000Z",
							}),
							vault: {
								id: "vault_1",
								name: "Team Vault",
								vaultType: "team",
								icon: "lock",
								imageUrl: null,
							},
						},
					],
					hasMore: false,
				},
			})),
		},
		vaults: {
			list: mock(async () => ({
				data: [
					{
						id: "vault_1",
						name: "Team Vault",
						vaultType: "team",
						icon: "lock",
						imageUrl: null,
						encryptedVaultKey: "ZW5jcnlwdGVk",
						role: "owner",
					},
				],
			})),
		},
	};
}

async function setup() {
	const { storage, itemCache, recordPort, crypto } = await createLayers();
	const vaultCrypto = createVaultCrypto({ crypto, storage });
	await getTravelModeEnforcer(storage, itemCache).applyConfig(ACCOUNT_ID, {
		enabled: false,
		hiddenVaultIds: [],
	});

	const repo = new VaultRepository(
		crypto,
		vaultCrypto,
		storage,
		itemCache,
		ACCOUNT_ID,
		"https://bittery.test",
		"user@bittery.test",
	);

	return { repo, storage, itemCache, recordPort, crypto, vaultCrypto };
}

async function cachedItem(
	id: string,
	crypto: CryptoPort,
	vaultCrypto: VaultCrypto,
): Promise<CachedEncryptedItem> {
	const vaultKey = await vaultCrypto.getVaultKey({
		vaultId: "vault_1",
		accountId: ACCOUNT_ID,
		userId: USER_ID,
	});
	if (!vaultKey) throw new Error("Missing test vault key");
	const encrypted = await vaultCrypto.encryptItem(
		JSON.stringify({ title: "Item" }),
		vaultKey,
		{ vaultId: "vault_1", itemId: id, version: 1, userId: USER_ID },
	);
	await crypto.destroyKey(vaultKey);
	return buildCachedItem({
		id,
		vaultId: "vault_1",
		accountId: ACCOUNT_ID,
		category: "login",
		favorite: false,
		encryptedData: encrypted.ciphertext,
		encryptionIv: encrypted.iv,
		encryptionAlgorithm: encrypted.algorithm,
		version: 1,
		lastModifiedBy: USER_ID,
		encryptionVersion: 1,
		encryptedByUserId: USER_ID,
		createdAt: "2026-08-01T00:00:00.000Z",
		updatedAt: "2026-08-01T00:00:00.000Z",
		deletedAt: null,
	});
}

describe("VaultRepository.hydrateFromServer", () => {
	beforeEach(() => {
		resetTravelModeEnforcerForTests();
	});

	// Regression guard: the server serialises vault payloads as camelCase, so the
	// wire field is `vaultType`. Bootstrap used to read `vault.type`, storing
	// `undefined` for every vault. The vault detail page only offers member
	// management when `vaultType === "team"`, so a fresh login left team vaults
	// with no way to add anyone until some other code path rewrote the cache.
	it("stores the team type from the wire field after a fresh bootstrap", async () => {
		const { repo, storage } = await setup();

		await repo.hydrateFromServer(createClient());

		const keys = (await storage.getVaultKeys(ACCOUNT_ID)) ?? [];
		expect(keys).toHaveLength(1);
		expect(keys[0]?.vaultId).toBe("vault_1");
		expect(keys[0]?.vaultType).toBe("team");
		expect(keys[0]?.role).toBe("owner");
	});

	it("caches vault metadata with a usable type", async () => {
		const { repo, itemCache } = await setup();

		await repo.hydrateFromServer(createClient());

		const cached = ((await itemCache.getCachedVaults(ACCOUNT_ID)) ?? []).find(
			(vault) => vault.id === "vault_1",
		);
		expect(cached?.type).toBe("team");
		expect(cached?.name).toBe("Team Vault");
	});

	it("caches the exact ciphertext context returned by bootstrap", async () => {
		const { repo, itemCache } = await setup();

		await repo.hydrateFromServer(createClient());

		const cached = (await itemCache.getCachedItems(ACCOUNT_ID))?.[0];
		expect(cached?.version).toBe(1);
		expect(cached?.encryptionVersion).toBe(1);
		expect(cached?.encryptedByUserId).toBe(USER_ID);
	});

	it("pins the first bootstrap sync cursor through promotion", async () => {
		const { repo, itemCache } = await setup();
		const client = createClient();
		const firstItem = (await client.sync.bootstrap({ limit: 500 })).data
			.items[0];
		if (!firstItem) throw new Error("Missing bootstrap fixture Item");
		const requests: Array<{
			cursor?: string;
			limit?: number;
			syncCursor?: string;
			syncCursorCaptured?: boolean;
		}> = [];
		client.sync.bootstrap = mock(async (input: any) => {
			requests.push(input);
			return {
				data: input.cursor
					? {
							items: [],
							hasMore: false,
							syncCursor: { id: "evt_bootstrap" },
						}
					: {
							items: [firstItem],
							hasMore: true,
							nextCursor: "page-2",
							syncCursor: { id: "evt_bootstrap" },
						},
			} as any;
		}) as BootstrapItemsClient["sync"]["bootstrap"];

		const baseline = await repo.hydrateFromServer(client);

		expect(requests).toEqual([
			{
				cursor: undefined,
				limit: 500,
				syncCursor: undefined,
				syncCursorCaptured: false,
			},
			{
				cursor: "page-2",
				limit: 500,
				syncCursor: "evt_bootstrap",
				syncCursorCaptured: true,
			},
		]);
		expect(baseline).toEqual({ id: "evt_bootstrap" });
		expect(
			(await itemCache.getItemCacheMetadata(ACCOUNT_ID))?.syncBaseline,
		).toEqual({
			serverUrl: "https://bittery.test",
			cursorId: "evt_bootstrap",
		});
	});

	it("pins an explicit empty sync cursor through every bootstrap page", async () => {
		const { repo, itemCache } = await setup();
		const client = createClient();
		const firstItem = (await client.sync.bootstrap({ limit: 500 })).data
			.items[0];
		if (!firstItem) throw new Error("Missing bootstrap fixture Item");
		const requests: Array<{
			cursor?: string;
			syncCursor?: string;
			syncCursorCaptured?: boolean;
		}> = [];
		client.sync.bootstrap = mock(async (input: any) => {
			requests.push(input);
			return {
				data: input.cursor
					? { items: [], hasMore: false, syncCursor: null }
					: {
							items: [firstItem],
							hasMore: true,
							nextCursor: "page-2",
							syncCursor: null,
						},
			} as any;
		}) as BootstrapItemsClient["sync"]["bootstrap"];

		const baseline = await repo.hydrateFromServer(client);

		expect(requests[1]).toMatchObject({
			cursor: "page-2",
			syncCursor: undefined,
			syncCursorCaptured: true,
		});
		expect(baseline).toBeNull();
		expect(
			(await itemCache.getItemCacheMetadata(ACCOUNT_ID))?.syncBaseline,
		).toEqual({
			serverUrl: "https://bittery.test",
			cursorId: null,
		});
	});

	it("rejects a changed bootstrap sync cursor before promotion", async () => {
		const { repo, itemCache, crypto, vaultCrypto } = await setup();
		await itemCache.setCachedItems(
			[await cachedItem("previous", crypto, vaultCrypto)],
			ACCOUNT_ID,
		);
		const client = createClient();
		const firstItem = (await client.sync.bootstrap({ limit: 500 })).data
			.items[0];
		if (!firstItem) throw new Error("Missing bootstrap fixture Item");
		client.sync.bootstrap = mock(async (input: any) => ({
			data: input.cursor
				? {
						items: [],
						hasMore: false,
						syncCursor: { id: "evt_changed" },
					}
				: {
						items: [firstItem],
						hasMore: true,
						nextCursor: "page-2",
						syncCursor: { id: "evt_bootstrap" },
					},
		})) as BootstrapItemsClient["sync"]["bootstrap"];

		await expect(repo.hydrateFromServer(client)).rejects.toThrow(
			"Bootstrap sync cursor changed",
		);
		expect(
			(await itemCache.getCachedItems(ACCOUNT_ID))?.map(({ id }) => id),
		).toEqual(["previous"]);
		expect(
			(await itemCache.getItemCacheMetadata(ACCOUNT_ID))?.syncBaseline,
		).toBeUndefined();
	});

	it("keeps hidden vaults out of every promoted bootstrap layer", async () => {
		const { repo, storage, itemCache } = await setup();
		const enforcer = getTravelModeEnforcer(storage, itemCache);
		await enforcer.applyConfig(ACCOUNT_ID, {
			enabled: true,
			hiddenVaultIds: ["vault_hidden"],
		});

		const visibleKeys = (await storage.getVaultKeys(ACCOUNT_ID)) ?? [];
		await storage.storeVaultKeys(
			[
				...visibleKeys,
				{
					vaultId: "vault_hidden",
					vaultName: "Hidden Vault",
					vaultType: "personal",
					vaultIcon: null,
					vaultImageUrl: null,
					encryptedVaultKey: "hidden-key",
					role: "owner",
				},
			],
			ACCOUNT_ID,
		);
		await itemCache.setCachedVaults(
			[
				{
					id: "vault_hidden",
					name: "Previously Cached Hidden Vault",
					type: "personal",
					icon: null,
					imageUrl: null,
				},
			],
			ACCOUNT_ID,
		);
		await itemCache.setCachedItems(
			[
				buildCachedItem({
					id: "previous_hidden_item",
					vaultId: "vault_hidden",
					accountId: ACCOUNT_ID,
					encryptedData: "hidden-data",
					encryptionIv: "hidden-iv",
					encryptionAlgorithm: "AES-GCM",
					lastModifiedBy: USER_ID,
					encryptedByUserId: USER_ID,
					createdAt: "2026-08-01T00:00:00.000Z",
					updatedAt: "2026-08-01T00:00:00.000Z",
				}),
			],
			ACCOUNT_ID,
		);

		const client = createClient();
		const visibleItem = (await client.sync.bootstrap({ limit: 500 })).data
			.items[0];
		if (!visibleItem) throw new Error("Missing visible bootstrap item");
		const hiddenItem = {
			...visibleItem,
			id: "hidden_item_1",
			vaultId: "vault_hidden",
			vault: {
				...visibleItem.vault,
				id: "vault_hidden",
				name: "Hidden Vault",
				vaultType: "personal",
			},
		};
		client.sync.bootstrap = mock(async ({ cursor }) => ({
			data:
				cursor === "page-2"
					? {
							items: [{ ...hiddenItem, id: "hidden_item_2" }],
							hasMore: false,
						}
					: {
							items: [visibleItem, hiddenItem],
							hasMore: true,
							nextCursor: "page-2",
						},
		}));
		const visibleVault = (await client.vaults?.list?.())?.data[0];
		if (!client.vaults || !visibleVault) {
			throw new Error("Missing visible vault client fixture");
		}
		client.vaults.list = mock(async () => ({
			data: [
				visibleVault,
				{
					...visibleVault,
					id: "vault_hidden",
					name: "Hidden Vault",
					vaultType: "personal",
					encryptedVaultKey: "hidden-key",
				},
			],
		}));

		await repo.hydrateFromServer(client);

		expect(
			(await itemCache.getCachedItems(ACCOUNT_ID))?.map(({ id }) => id),
		).toEqual(["item_1"]);
		expect(
			(await itemCache.getCachedVaults(ACCOUNT_ID))?.map(({ id }) => id),
		).toEqual(["vault_1"]);
		expect(
			(await storage.getVaultKeys(ACCOUNT_ID))?.map(({ vaultId }) => vaultId),
		).toEqual(["vault_1"]);
	});

	it.each([
		0, 1,
	])("keeps the previous cache when bootstrap fails at page boundary %i", async (failureAt) => {
		const { repo, itemCache, crypto, vaultCrypto } = await setup();
		await itemCache.setCachedItems(
			[await cachedItem("previous", crypto, vaultCrypto)],
			ACCOUNT_ID,
		);
		const client = createClient();
		let request = 0;
		client.sync.bootstrap = mock(async () => {
			if (request++ === failureAt) {
				throw new Error("network interrupted bootstrap");
			}
			return {
				data: {
					items: [],
					hasMore: true,
					nextCursor: "next-page",
				},
			};
		});

		await expect(repo.hydrateFromServer(client)).rejects.toThrow(
			"network interrupted bootstrap",
		);
		expect(
			(await itemCache.getCachedItems(ACCOUNT_ID))?.map(({ id }) => id),
		).toEqual(["previous"]);
	});

	it("does not publish a partial generation when the promotion write fails", async () => {
		const { repo, itemCache, recordPort, crypto, vaultCrypto } = await setup();
		await itemCache.setCachedItems(
			[await cachedItem("previous", crypto, vaultCrypto)],
			ACCOUNT_ID,
		);
		const write = recordPort.recordPut.bind(recordPort);
		recordPort.recordPut = async (collection, id, value) => {
			if (collection === metaCollection(ACCOUNT_ID) && id === "meta") {
				throw new Error("promotion interrupted");
			}
			await write(collection, id, value);
		};

		await expect(repo.hydrateFromServer(createClient())).rejects.toThrow(
			"promotion interrupted",
		);
		expect(
			(await itemCache.getCachedItems(ACCOUNT_ID))?.map(({ id }) => id),
		).toEqual(["previous"]);
		expect(
			(await itemCache.getItemCacheMetadata(ACCOUNT_ID))?.syncBaseline,
		).toBeUndefined();
	});

	it("publishes a complete cache before any failure after promotion", async () => {
		const { repo, itemCache, storage } = await setup();
		const client = createClient();
		const storeVaultKeys = storage.storeVaultKeys.bind(storage);
		storage.storeVaultKeys = async () => {
			throw new Error("vault key persistence interrupted");
		};

		await expect(repo.hydrateFromServer(client)).rejects.toThrow(
			"vault key persistence interrupted",
		);
		expect(
			(await itemCache.getCachedItems(ACCOUNT_ID))?.map(({ id }) => id),
		).toEqual(["item_1"]);

		storage.storeVaultKeys = storeVaultKeys;
	});
});

describe("VaultRepository hydration on a locked account", () => {
	beforeEach(() => {
		resetTravelModeEnforcerForTests();
	});

	/**
	 * A locked account has no key to decrypt with, so hydrating it can only produce one
	 * "Master Unlock Key not available" per cached item. It stays un-hydrated instead,
	 * and the next hydrate after the unlock does the work.
	 */
	it("decrypts nothing and asks the server for nothing", async () => {
		const { repo, storage, itemCache, crypto, vaultCrypto } = await setup();
		await itemCache.setCachedItems(
			[await cachedItem("item_1", crypto, vaultCrypto)],
			ACCOUNT_ID,
		);
		await storage.lockAllAccounts();
		const client = createClient();

		await repo.hydrate();
		await repo.hydrateFromServer(client);

		expect(repo.isHydrated()).toBe(false);
		expect(repo.getAll()).toEqual([]);
		expect(client.sync.bootstrap).not.toHaveBeenCalled();
	});

	/**
	 * Sync does not stop at the lock, so every delta that arrives after it used to be one
	 * more "Master Unlock Key not available" — a couple of hundred of them on a full
	 * catch-up. The ciphertext still has to reach the cache, or the sync cursor would
	 * advance past items nothing ever stored.
	 */
	it("caches a synced delta without decrypting it, and without logging", async () => {
		const { repo, storage, itemCache, crypto, vaultCrypto } = await setup();
		const item = await cachedItem("item_1", crypto, vaultCrypto);
		await storage.lockAllAccounts();
		const logged = spyOn(console, "error").mockImplementation(() => {});
		let loggedCalls = 0;

		try {
			await repo.upsertEncrypted(item, ACCOUNT_ID);
			// Read before restoring: `mockRestore` also drops the recorded calls.
			loggedCalls = logged.mock.calls.length;
		} finally {
			logged.mockRestore();
		}

		expect(loggedCalls).toBe(0);
		expect(repo.getAll()).toEqual([]);
		const cached = (await itemCache.getCachedItems(ACCOUNT_ID)) ?? [];
		expect(cached.map((entry) => entry.id)).toEqual(["item_1"]);
	});
});

describe("VaultRepositoryCoordinator follows the store's lock state", () => {
	beforeEach(() => {
		resetTravelModeEnforcerForTests();
	});

	/** The re-hydrate is detached from the lock event, so the state has to be polled. */
	async function until(condition: () => boolean): Promise<void> {
		for (let attempt = 0; attempt < 50; attempt++) {
			if (condition()) return;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		throw new Error("condition never became true");
	}

	it("drops the decrypted items on lock and rebuilds them on unlock", async () => {
		const { storage, itemCache, crypto } = await createLayers();
		const vaultCrypto = createVaultCrypto({ crypto, storage });
		await getTravelModeEnforcer(storage, itemCache).applyConfig(ACCOUNT_ID, {
			enabled: false,
			hiddenVaultIds: [],
		});
		const coordinator = new VaultRepositoryCoordinator(
			crypto,
			vaultCrypto,
			storage,
			itemCache,
		);
		await itemCache.setCachedItems(
			[await cachedItem("item_1", crypto, vaultCrypto)],
			ACCOUNT_ID,
		);
		const repo = coordinator.getRepositoryForAccount(ACCOUNT_ID);
		await repo.hydrate();
		expect(repo.getAll()).toHaveLength(1);

		// No await between the lock and the assertion: plaintext must not outlive it.
		await storage.lockAllAccounts();
		expect(repo.getAll()).toEqual([]);
		expect(repo.isHydrated()).toBe(false);

		await storage.setMasterUnlockKey(
			await crypto.importKey(new Uint8Array(32)),
			ACCOUNT_ID,
		);

		await until(() => repo.isHydrated());
		expect(repo.getAll()).toHaveLength(1);
	});
});

/**
 * `packages/storage` proves `ItemCache` is O(1) in isolation; these prove the property
 * survives the path the app actually takes — through `VaultRepository`, which is what
 * delta sync drives.
 */
describe("VaultRepository per-item persistence is O(1)", () => {
	beforeEach(() => {
		resetTravelModeEnforcerForTests();
	});

	it("costs exactly one recordPut per delta-synced item", async () => {
		const { repo, itemCache, recordPort, crypto, vaultCrypto } = await setup();

		await itemCache.setCachedItems(
			await Promise.all(
				Array.from({ length: 50 }, (_, i) =>
					cachedItem(`seed_${i}`, crypto, vaultCrypto),
				),
			),
			ACCOUNT_ID,
		);
		recordPort.resetCalls();

		await repo.upsertCachedItem(
			await cachedItem("item_new", crypto, vaultCrypto),
			ACCOUNT_ID,
		);

		expect(recordPort.calls.recordPut).toBe(1);
	});

	it("costs exactly one recordDelete per removed item", async () => {
		const { repo, itemCache, recordPort, crypto, vaultCrypto } = await setup();

		await itemCache.setCachedItems(
			await Promise.all(
				Array.from({ length: 10 }, (_, i) =>
					cachedItem(`seed_${i}`, crypto, vaultCrypto),
				),
			),
			ACCOUNT_ID,
		);
		recordPort.resetCalls();

		await repo.removeItem("seed_3");

		expect(recordPort.calls.recordDelete).toBe(1);
		expect(recordPort.calls.recordPut).toBe(0);
	});

	it("writes into its own account's collection and no other", async () => {
		const { repo, recordPort, crypto, vaultCrypto } = await setup();

		await repo.upsertCachedItem(
			await cachedItem("item_new", crypto, vaultCrypto),
			ACCOUNT_ID,
		);

		expect(recordPort.collections()).toEqual([`${ACCOUNT_ID}:items`]);
	});
});

/**
 * Sync applies one event at a time and only stores the cursor once the write returns,
 * so a throw here replayed the same undecryptable item on every reconnect forever.
 */
describe("VaultRepository absorbs an undecryptable sync write", () => {
	const UNOPENABLE = "bm90LWNpcGhlcnRleHQ=";

	beforeEach(() => {
		resetTravelModeEnforcerForTests();
	});

	it("caches the ciphertext and leaves the item unlisted", async () => {
		const { repo, itemCache, crypto, vaultCrypto } = await setup();

		await repo.upsertCachedItem(
			{
				...(await cachedItem("item_poison", crypto, vaultCrypto)),
				encryptedData: UNOPENABLE,
			},
			ACCOUNT_ID,
		);

		const cached = (await itemCache.getCachedItems(ACCOUNT_ID)) ?? [];
		expect(cached.map((item) => item.id)).toEqual(["item_poison"]);
		expect(cached[0]?.encryptedData).toBe(UNOPENABLE);
		expect(repo.getById("item_poison")).toBeUndefined();
	});

	// Stale plaintext carries a superseded `_encrypted` blob that a later favorite or
	// delete write would persist back over the ciphertext sync just delivered.
	it("evicts the previously decrypted copy of the item", async () => {
		const { repo, crypto, vaultCrypto } = await setup();
		const good = await cachedItem("item_1", crypto, vaultCrypto);

		await repo.upsertCachedItem(good, ACCOUNT_ID);
		expect(repo.getById("item_1")).toBeDefined();

		await repo.upsertCachedItem(
			{ ...good, version: 2, encryptedData: UNOPENABLE },
			ACCOUNT_ID,
		);

		expect(repo.getById("item_1")).toBeUndefined();
	});

	it("does not replace a newer cached delta with an older event", async () => {
		const { repo, itemCache, crypto, vaultCrypto } = await setup();
		const older = await cachedItem("item_1", crypto, vaultCrypto);
		const newer = {
			...older,
			version: 2,
			encryptedData: UNOPENABLE,
		};

		await repo.upsertCachedItem(newer, ACCOUNT_ID);
		await repo.upsertCachedItem(older, ACCOUNT_ID);

		const cached = await itemCache.getCachedItems(ACCOUNT_ID);
		expect(cached?.[0]?.version).toBe(2);
		expect(cached?.[0]?.encryptedData).toBe(UNOPENABLE);
	});
});

describe("VaultRepository encryption context migration", () => {
	beforeEach(() => {
		resetTravelModeEnforcerForTests();
	});

	it("stores the exact context used by a new local ciphertext", async () => {
		const { repo, itemCache } = await setup();
		const encrypted = await repo.encryptWithVaultKey(
			"vault_1",
			{ title: "New Item" },
			{ itemId: "new_item", version: 1 },
		);

		await repo.upsertLocal(
			{
				id: "new_item",
				vaultId: "vault_1",
				category: "login",
				favorite: false,
				createdAt: "2026-08-01T00:00:00.000Z",
				updatedAt: "2026-08-01T00:00:00.000Z",
				title: "New Item",
			},
			encrypted,
		);

		const cached = (await itemCache.getCachedItems(ACCOUNT_ID))?.[0];
		expect(cached?.version).toBe(1);
		expect(cached?.encryptionVersion).toBe(1);
		expect(cached?.encryptedByUserId).toBe(USER_ID);
	});

	it("adopts a metadata acknowledgement revision without changing ciphertext context", async () => {
		const { repo, itemCache, crypto, vaultCrypto } = await setup();
		await itemCache.setCachedItems(
			[await cachedItem("acknowledged_item", crypto, vaultCrypto)],
			ACCOUNT_ID,
		);
		await repo.hydrate();
		await (repo as any).acknowledgeItemCommand(
			{
				accountId: ACCOUNT_ID,
				id: "favorite_operation",
				type: "toggle_favorite",
				entityId: "acknowledged_item",
				vaultId: "vault_1",
				favorite: true,
				baseVersion: 1,
				timestamp: 1,
				retryCount: 0,
			},
			{ entityId: "acknowledged_item", etag: '"2"', version: 2 },
		);

		const acknowledged = repo.getById("acknowledged_item");
		expect(acknowledged?.favorite).toBe(true);
		expect(acknowledged?.version).toBe(2);
		expect(acknowledged?.encryptionVersion).toBe(1);
		expect(acknowledged?.encryptedByUserId).toBe(USER_ID);
		const cached = (await itemCache.getCachedItems(ACCOUNT_ID))?.[0];
		expect(cached?.version).toBe(2);
		expect(cached?.encryptionVersion).toBe(1);
	});

	it("keeps the ciphertext author when another member trashes and restores an item", async () => {
		const { repo, itemCache, crypto, vaultCrypto } = await setup();
		const authorId = "user-author";
		const metadataWriterId = "user-trash-writer";
		const key = await vaultCrypto.getVaultKey({
			vaultId: "vault_1",
			accountId: ACCOUNT_ID,
			userId: USER_ID,
		});
		if (!key) throw new Error("Missing test vault key");
		const encrypted = await vaultCrypto.encryptItem(
			JSON.stringify({ title: "Shared Item" }),
			key,
			{
				vaultId: "vault_1",
				itemId: "shared_item",
				version: 1,
				userId: authorId,
			},
		);
		await crypto.destroyKey(key);

		await repo.upsertEncrypted(
			buildCachedItem({
				id: "shared_item",
				vaultId: "vault_1",
				accountId: ACCOUNT_ID,
				encryptedData: encrypted.ciphertext,
				encryptionIv: encrypted.iv,
				encryptionAlgorithm: encrypted.algorithm,
				version: 3,
				lastModifiedBy: metadataWriterId,
				encryptionVersion: 1,
				encryptedByUserId: authorId,
				createdAt: "2026-08-01T00:00:00.000Z",
				updatedAt: "2026-08-01T00:00:00.000Z",
				deletedAt: "2026-08-02T00:00:00.000Z",
			}),
			ACCOUNT_ID,
		);
		expect(repo.getDeleted()[0]?.title).toBe("Shared Item");

		await repo.restore("shared_item");
		await repo.softDelete("shared_item");
		const cached = (await itemCache.getCachedItems(ACCOUNT_ID))?.[0];

		expect(cached?.version).toBe(3);
		expect(cached?.lastModifiedBy).toBe(metadataWriterId);
		expect(cached?.encryptionVersion).toBe(1);
		expect(cached?.encryptedByUserId).toBe(authorId);
	});
});

describe("VaultRepository Item sync projections", () => {
	beforeEach(() => {
		resetTravelModeEnforcerForTests();
	});

	function favoriteCommand(itemId: string): ItemSyncCommand {
		return {
			accountId: ACCOUNT_ID,
			id: `favorite-${itemId}`,
			operationId: `favorite-${itemId}`,
			type: "toggle_favorite",
			entityId: itemId,
			vaultId: "vault_1",
			favorite: true,
			baseVersion: 1,
			timestamp: 1,
			retryCount: 0,
		};
	}

	it("keeps an optimistic metadata command out of the authoritative cache", async () => {
		const { repo, itemCache, crypto, vaultCrypto } = await setup();
		const item = await cachedItem("overlay_item", crypto, vaultCrypto);
		await itemCache.setCachedItems([item], ACCOUNT_ID);
		await repo.hydrate();

		await repo.applyItemCommand(favoriteCommand(item.id));

		expect(repo.getById(item.id)?.favorite).toBe(true);
		const authoritative = (await itemCache.getCachedItems(ACCOUNT_ID))?.[0];
		expect(authoritative?.favorite).toBe(false);
		expect(authoritative?.version).toBe(1);
	});

	it("retains the optimistic overlay when a newer event arrives first", async () => {
		const { repo, itemCache, crypto, vaultCrypto } = await setup();
		const item = await cachedItem("event_first", crypto, vaultCrypto);
		await itemCache.setCachedItems([item], ACCOUNT_ID);
		await repo.hydrate();
		const command = favoriteCommand(item.id);
		await repo.applyItemCommand(command);

		await repo.upsertCachedItem(
			{ ...item, version: 2, favorite: false },
			ACCOUNT_ID,
		);

		expect(repo.getById(item.id)?.favorite).toBe(true);
		expect((await itemCache.getCachedItems(ACCOUNT_ID))?.[0]?.favorite).toBe(
			false,
		);
		await repo.acknowledgeItemCommand(command, {
			entityId: item.id,
			etag: '"2"',
			version: 2,
		});
		expect(repo.getById(item.id)?.version).toBe(2);
	});

	it("adopts the acknowledgement before the matching event arrives", async () => {
		const { repo, itemCache, crypto, vaultCrypto } = await setup();
		const item = await cachedItem("response_first", crypto, vaultCrypto);
		await itemCache.setCachedItems([item], ACCOUNT_ID);
		await repo.hydrate();
		const command = favoriteCommand(item.id);
		await repo.applyItemCommand(command);

		await repo.acknowledgeItemCommand(command, {
			entityId: item.id,
			etag: '"2"',
			version: 2,
		});

		const acknowledged = (await itemCache.getCachedItems(ACCOUNT_ID))?.[0];
		expect(acknowledged?.favorite).toBe(true);
		expect(acknowledged?.version).toBe(2);
		await repo.upsertCachedItem(
			{ ...item, version: 2, favorite: true },
			ACCOUNT_ID,
		);
		expect(repo.getById(item.id)?.favorite).toBe(true);
	});

	it("drops a stale-tab overlay after another tab durably acknowledges it", async () => {
		const { repo, itemCache, crypto, vaultCrypto } = await setup();
		const item = await cachedItem("other_tab_ack", crypto, vaultCrypto);
		await itemCache.setCachedItems([item], ACCOUNT_ID);
		await repo.hydrate();
		const command = favoriteCommand(item.id);
		await repo.applyItemCommand(command);

		await itemCache.upsertCachedItem(
			{ ...item, version: 2, favorite: true },
			ACCOUNT_ID,
		);
		await repo.discardItemCommandAcknowledgedElsewhere(command);

		expect(repo.getById(item.id)?.version).toBe(2);
		expect(repo.getById(item.id)?.favorite).toBe(true);
		await repo.upsertCachedItem(
			{ ...item, version: 3, favorite: false },
			ACCOUNT_ID,
		);
		expect(repo.getById(item.id)?.favorite).toBe(false);
	});

	it("keeps a permanently deleted Item visible until the server acknowledges it", async () => {
		const { repo, itemCache, crypto, vaultCrypto } = await setup();
		const item = await cachedItem("delete_pending", crypto, vaultCrypto);
		await itemCache.setCachedItems([item], ACCOUNT_ID);
		await repo.hydrate();
		const command: ItemSyncCommand = {
			accountId: ACCOUNT_ID,
			id: "delete-pending",
			operationId: "delete-pending",
			type: "permanent_delete",
			entityId: item.id,
			vaultId: item.vaultId,
			baseVersion: 1,
			timestamp: 1,
			retryCount: 0,
		};

		await repo.applyItemCommand(command);
		expect(repo.getById(item.id)).toBeDefined();
		expect((await itemCache.getCachedItems(ACCOUNT_ID))?.[0]?.id).toBe(item.id);

		await repo.acknowledgeItemCommand(command, {
			entityId: item.id,
			etag: '"2"',
			version: 2,
		});
		expect(repo.getById(item.id)).toBeUndefined();
		expect(await itemCache.getCachedItems(ACCOUNT_ID)).toEqual([]);
	});

	it("retains a conflicted encrypted overlay when the server deletes its base", async () => {
		const { repo, itemCache, crypto, vaultCrypto } = await setup();
		const item = await cachedItem(
			"remote_delete_conflict",
			crypto,
			vaultCrypto,
		);
		await itemCache.setCachedItems([item], ACCOUNT_ID);
		await repo.hydrate();
		const encrypted = await repo.encryptWithVaultKey(
			item.vaultId,
			{ title: "Offline edit" },
			{ itemId: item.id, version: 2 },
		);
		await repo.applyItemCommand({
			accountId: ACCOUNT_ID,
			id: "offline-edit",
			operationId: "offline-edit",
			type: "update",
			entityId: item.id,
			vaultId: item.vaultId,
			encryptedPayload: {
				encryptedData: encrypted.ciphertext,
				encryptionIv: encrypted.iv,
				encryptionAlgorithm: encrypted.algorithm,
				encryptionVersion: encrypted.encryptionVersion,
				encryptedByUserId: encrypted.encryptedByUserId,
			},
			baseVersion: 1,
			timestamp: 1,
			retryCount: 0,
		});

		await repo.removeCachedItem(item.id, ACCOUNT_ID);

		expect(repo.getById(item.id)?.title).toBe("Offline edit");
		expect((await itemCache.getCachedItems(ACCOUNT_ID))?.[0]?.version).toBe(1);
	});

	it("preserves both encrypted conflict versions as a durable conflict copy", async () => {
		const { repo, storage, itemCache, crypto, vaultCrypto } = await setup();
		const item = await cachedItem("content_conflict", crypto, vaultCrypto);
		await itemCache.setCachedItems([item], ACCOUNT_ID);
		await repo.hydrate();
		const encrypted = await repo.encryptWithVaultKey(
			item.vaultId,
			{ title: "Local conflicting edit" },
			{ itemId: item.id, version: 2 },
		);
		const command: ItemSyncCommand = {
			accountId: ACCOUNT_ID,
			id: "conflicting-edit",
			operationId: "conflicting-edit",
			type: "update",
			entityId: item.id,
			vaultId: item.vaultId,
			encryptedPayload: {
				encryptedData: encrypted.ciphertext,
				encryptionIv: encrypted.iv,
				encryptionAlgorithm: encrypted.algorithm,
				encryptionVersion: encrypted.encryptionVersion,
				encryptedByUserId: encrypted.encryptedByUserId,
			},
			baseVersion: 1,
			timestamp: 1,
			retryCount: 0,
			status: "conflicted",
			conflictCopyId: "content_conflict_copy",
		};
		await repo.applyItemCommand(command);

		const copyCommand = await repo.preserveItemConflict(command);

		expect(repo.getById(item.id)?.title).toBe("Item");
		expect(copyCommand?.type).toBe("create");
		if (!copyCommand) throw new Error("Missing conflict copy command");
		const restarted = new VaultRepository(
			crypto,
			vaultCrypto,
			storage,
			itemCache,
			ACCOUNT_ID,
			"https://bittery.test",
		);
		await restarted.hydrate();
		await restarted.applyItemCommand(copyCommand);

		expect(restarted.getById("content_conflict_copy")?.title).toBe(
			"Local conflicting edit",
		);
		expect(restarted.getById(item.id)?.title).toBe("Item");
	});

	it("keeps the conflict base through an event-retention full refresh", async () => {
		const { repo, storage, itemCache, crypto, vaultCrypto } = await setup();
		const item = await cachedItem("refresh_conflict", crypto, vaultCrypto);
		await itemCache.setCachedItems([item], ACCOUNT_ID);
		await repo.hydrate();
		const encrypted = await repo.encryptWithVaultKey(
			item.vaultId,
			{ title: "Unsynced content" },
			{ itemId: item.id, version: 2 },
		);
		await repo.applyItemCommand({
			accountId: ACCOUNT_ID,
			id: "refresh-edit",
			operationId: "refresh-edit",
			type: "update",
			entityId: item.id,
			vaultId: item.vaultId,
			encryptedPayload: {
				encryptedData: encrypted.ciphertext,
				encryptionIv: encrypted.iv,
				encryptionAlgorithm: encrypted.algorithm,
				encryptionVersion: encrypted.encryptionVersion,
				encryptedByUserId: encrypted.encryptedByUserId,
			},
			baseVersion: 1,
			timestamp: 1,
			retryCount: 0,
		});
		const client = createClient();
		client.sync.bootstrap = mock(async () => ({
			data: { items: [], hasMore: false },
		}));
		const storedVaultKey = (await storage.getVaultKeys(ACCOUNT_ID))?.[0];
		if (!storedVaultKey || !client.vaults) {
			throw new Error("Missing stored Vault key fixture");
		}
		client.vaults.list = mock(async () => ({
			data: [
				{
					id: storedVaultKey.vaultId,
					name: storedVaultKey.vaultName,
					vaultType: storedVaultKey.vaultType,
					icon: storedVaultKey.vaultIcon,
					imageUrl: storedVaultKey.vaultImageUrl,
					encryptedVaultKey: storedVaultKey.encryptedVaultKey,
					role: storedVaultKey.role,
				},
			],
		}));

		await repo.hydrateFromServer(client);

		expect(repo.getById(item.id)?.title).toBe("Unsynced content");
		expect((await itemCache.getCachedItems(ACCOUNT_ID))?.[0]?.id).toBe(item.id);
	});
});
