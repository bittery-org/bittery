import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { IStorageAdapter } from "@bittery/storage/adapter";
import type { VaultKeyData } from "@bittery/storage/types";
import type { CachedVaultMetadata, ICrypto } from "@bittery/types";
import {
	getTravelModeEnforcer,
	resetTravelModeEnforcerForTests,
} from "./travel-mode-enforcer";
import { type BootstrapItemsClient, VaultRepository } from "./vault-repository";

const ACCOUNT_ID = "acc-1";

function createStorage() {
	const storedVaultKeys: VaultKeyData[][] = [];
	const storedVaults: CachedVaultMetadata[][] = [];

	const storage = {
		platform: "web",
		supportsMultiAccount: true,
		supportsBiometric: false,
		supportsItemCache: true,
		getServerUrl: mock(async () => "https://bittery.test"),
		getVaultKeys: mock(async () => []),
		storeVaultKeys: mock(async (keys: VaultKeyData[]) => {
			storedVaultKeys.push(keys);
		}),
		getCachedItems: mock(async () => []),
		setCachedItems: mock(async () => {}),
		getCachedVaults: mock(async () => []),
		setCachedVaults: mock(async (vaults: CachedVaultMetadata[]) => {
			storedVaults.push(vaults);
		}),
		getItemCacheMetadata: mock(async () => null),
		setItemCacheMetadata: mock(async () => {}),
		storeTravelModeCache: mock(async () => {}),
		getTravelModeCache: mock(async () => null),
	} as unknown as IStorageAdapter;

	return { storage, storedVaultKeys, storedVaults };
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
	const { storage, storedVaultKeys, storedVaults } = createStorage();
	await getTravelModeEnforcer(storage).applyConfig(ACCOUNT_ID, {
		enabled: false,
		hiddenVaultIds: [],
	});

	const repo = new VaultRepository(
		{} as ICrypto,
		storage,
		ACCOUNT_ID,
		"https://bittery.test",
		"user@bittery.test",
	);

	return { repo, storedVaultKeys, storedVaults };
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
		const { repo, storedVaultKeys } = await setup();

		await repo.hydrateFromServer(createClient());

		const keys = storedVaultKeys.at(-1) ?? [];
		expect(keys).toHaveLength(1);
		expect(keys[0]?.vaultId).toBe("vault_1");
		expect(keys[0]?.vaultType).toBe("team");
		expect(keys[0]?.role).toBe("owner");
	});

	it("caches vault metadata with a usable type", async () => {
		const { repo, storedVaults } = await setup();

		await repo.hydrateFromServer(createClient());

		const cached = (storedVaults.at(-1) ?? []).find(
			(vault) => vault.id === "vault_1",
		);
		expect(cached?.type).toBe("team");
		expect(cached?.name).toBe("Team Vault");
	});
});
