import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { AccountStore, ItemCache } from "@bittery/storage";
import { createItemCache } from "@bittery/storage";
import {
	createInMemoryRecordPort,
	type InMemoryRecordPort,
} from "@bittery/storage/testing";
import type {
	CachedEncryptedItem,
	EncryptionContext,
	ICrypto,
} from "@bittery/types";
import {
	accountMetadata,
	createTestAccountStore,
} from "../testing/account-store-harness";
import {
	getTravelModeEnforcer,
	resetTravelModeEnforcerForTests,
} from "./travel-mode-enforcer";
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
}> {
	const { store } = await createTestAccountStore();
	const recordPort = createInMemoryRecordPort();
	const itemCache = createItemCache({ port: recordPort });
	await itemCache.initialize();

	await store.addAccount(accountMetadata({ accountId: ACCOUNT_ID }));
	await store.storeServerUrl("https://bittery.test", ACCOUNT_ID);
	await store.setMasterUnlockKey(new Uint8Array(32), ACCOUNT_ID);
	await store.storeVaultKeys(
		[
			{
				vaultId: "vault_1",
				vaultName: "Team Vault",
				vaultType: "team",
				vaultIcon: "lock",
				vaultImageUrl: null,
				encryptedVaultKey: JSON.stringify({
					ciphertext: "wrapped",
					iv: "vault-iv",
					algorithm: "aes-256-gcm",
					context: {
						vaultId: "vault_1",
						userId: USER_ID,
						keyVersion: 1,
						purpose: "vault-key-wrap",
					},
				}),
				role: "owner",
			},
		],
		ACCOUNT_ID,
	);

	return { storage: store, itemCache, recordPort };
}

/**
 * Enough crypto to unwrap the seeded vault key and "decrypt" an item. The real
 * algorithms are `packages/shared`'s business; what matters here is that the
 * `VaultRepository` path runs end to end so the record-port call counts are the ones
 * the app would actually make.
 */
const crypto = {
	decrypt: async (
		_data: unknown,
		_key: Uint8Array,
		context?: EncryptionContext,
	) => {
		if (context?.entityType === "vault_key") {
			return Buffer.from("vault-key").toString("base64");
		}
		return JSON.stringify({ title: "Item" });
	},
} as unknown as ICrypto;

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
	const { storage, itemCache, recordPort } = await createLayers();
	await getTravelModeEnforcer(storage, itemCache).applyConfig(ACCOUNT_ID, {
		enabled: false,
		hiddenVaultIds: [],
	});

	const repo = new VaultRepository(
		crypto,
		storage,
		itemCache,
		ACCOUNT_ID,
		"https://bittery.test",
		"user@bittery.test",
	);

	return { repo, storage, itemCache, recordPort };
}

function cachedItem(id: string): CachedEncryptedItem {
	return {
		id,
		vaultId: "vault_1",
		category: "login",
		favorite: false,
		encryptedData: "ZGF0YQ==",
		encryptionIv: "aXY=",
		encryptionAlgorithm: "AES-GCM",
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
		const { repo, itemCache, recordPort } = await setup();

		await itemCache.setCachedItems(
			Array.from({ length: 50 }, (_, i) => cachedItem(`seed_${i}`)),
			ACCOUNT_ID,
		);
		recordPort.resetCalls();

		await repo.upsertCachedItem(cachedItem("item_new"), ACCOUNT_ID);

		expect(recordPort.calls.recordPut).toBe(1);
	});

	it("costs exactly one recordDelete per removed item", async () => {
		const { repo, itemCache, recordPort } = await setup();

		await itemCache.setCachedItems(
			Array.from({ length: 10 }, (_, i) => cachedItem(`seed_${i}`)),
			ACCOUNT_ID,
		);
		recordPort.resetCalls();

		await repo.removeItem("seed_3");

		expect(recordPort.calls.recordDelete).toBe(1);
		expect(recordPort.calls.recordPut).toBe(0);
	});

	it("writes into the account's own collection, never the default one", async () => {
		const { repo, recordPort } = await setup();

		await repo.upsertCachedItem(cachedItem("item_new"), ACCOUNT_ID);

		// `ItemCache` falls back to the literal account segment "default" when the id
		// is omitted, so a `VaultRepository` with an undefined accountId would write
		// another account's collection instead of failing. Hence the required ctor arg.
		expect(recordPort.collections()).toEqual([`${ACCOUNT_ID}:items`]);
	});
});
