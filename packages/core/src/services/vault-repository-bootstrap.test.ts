import { beforeEach, describe, expect, it, mock } from "bun:test";
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
