import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { CryptoPort } from "@bittery/crypto-port";
import type { InMemoryCryptoPort } from "@bittery/crypto-port/testing";
import type { AccountStore, ItemCache } from "@bittery/storage";
import { createItemCache } from "@bittery/storage";
import {
	createInMemoryRecordPort,
	type InMemoryRecordPort,
} from "@bittery/storage/testing";
import type { CachedEncryptedItem } from "@bittery/types";
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
 * both `sync.bootstrapItems` and `vault.list` carry `vaultType`, never `type`.
 */
function createClient(): BootstrapItemsClient {
	return {
		sync: {
			bootstrapItems: {
				query: mock(async () => ({
					items: [
						{
							id: "item_1",
							vaultId: "vault_1",
							category: "login",
							favorite: false,
							encryptedData: "ZGF0YQ==",
							encryptionIv: "aXY=",
							encryptionAlgorithm: "AES-GCM",
							version: 1,
							lastModifiedBy: null,
							createdAt: "2026-08-01T00:00:00.000Z",
							updatedAt: "2026-08-01T00:00:00.000Z",
							deletedAt: null,
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
				})),
			},
		},
		vault: {
			list: {
				query: mock(async () => [
					{
						id: "vault_1",
						name: "Team Vault",
						vaultType: "team",
						icon: "lock",
						imageUrl: null,
						encryptedVaultKey: "ZW5jcnlwdGVk",
						role: "owner",
					},
				]),
			},
		},
	} as unknown as BootstrapItemsClient;
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
	return {
		id,
		vaultId: "vault_1",
		category: "login",
		favorite: false,
		encryptedData: encrypted.ciphertext,
		encryptionIv: encrypted.iv,
		encryptionAlgorithm: encrypted.algorithm,
		version: 1,
		lastModifiedBy: USER_ID,
		createdAt: "2026-08-01T00:00:00.000Z",
		updatedAt: "2026-08-01T00:00:00.000Z",
		deletedAt: null,
	} as CachedEncryptedItem;
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
		expect(client.sync.bootstrapItems.query).not.toHaveBeenCalled();
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
});
